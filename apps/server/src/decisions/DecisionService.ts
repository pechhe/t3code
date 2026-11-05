import * as Digest from "effect/crypto/Digest";
import {
  DECISION_LIMITS,
  DecisionError,
  DecisionRequest,
  type DecisionResult,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { HttpClient, HttpClientRequest } from "effect/http";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import {
  ADAPTER_VERSION,
  decodeResponse,
  encodeRequest,
  engines,
  parseProviderJson,
} from "./adapters.ts";

export class DecisionService extends Context.Service<
  DecisionService,
  {
    readonly decide: (
      input: unknown,
      options?: { readonly signal?: AbortSignal },
    ) => Effect.Effect<DecisionResult, DecisionError>;
  }
>()("t3/decisions/DecisionService") {}

const isDecisionError = Schema.is(DecisionError);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeRequest = Schema.decodeUnknownSync(DecisionRequest, { onExcessProperty: "error" });

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${encodeJson(k)}:${canonical(v)}`)
      .join(",")}}`;
  return encodeJson(value);
}
const validate = (raw: unknown) =>
  Effect.try({
    try: () => {
      const text = encodeJson(raw);
      if (Buffer.byteLength(text, "utf8") > DECISION_LIMITS.inputBytes) throw new Error();
      const input = decodeRequest(raw);
      const ids = input.questions.map((q) => q.id);
      if (new Set(ids).size !== ids.length) throw new Error();
      for (const q of input.questions) {
        const labels =
          q.type === "predicate"
            ? []
            : (q.type === "choice" ? q.choices : q.levels).map((c) => c.label);
        if (new Set(labels).size !== labels.length) throw new Error();
      }
      return input;
    },
    catch: () => new DecisionError({ code: "invalid-input" }),
  });

const make = Effect.gen(function* () {
  const digestService = yield* Digest.Digest;
  const http = HttpClient.withScope(yield* HttpClient.HttpClient);
  const secrets = yield* ServerSecretStore.ServerSecretStore;
  let active = 0;
  let admitted: number[] = [];
  const credentials = Effect.fn("DecisionService.credentials")(function* (
    engine: DecisionRequest["engine"],
  ) {
    const stored = yield* secrets
      .get(`decision-api-key-${engine}`)
      .pipe(Effect.mapError(() => new DecisionError({ code: "unavailable" })));
    if (Option.isSome(stored)) {
      const key = new TextDecoder().decode(stored.value).trim();
      if (key) return key;
    }
    const configured = yield* Config.option(
      Config.Redacted(engine === "jev" ? "TYPESAFE_API_KEY" : "OPENAI_API_KEY"),
    ).pipe(Effect.mapError(() => new DecisionError({ code: "unavailable" })));
    if (Option.isNone(configured) || !Redacted.value(configured.value).trim())
      return yield* new DecisionError({ code: "unavailable" });
    return Redacted.value(configured.value).trim();
  });
  const call = Effect.fn("DecisionService.call")(function* (input: DecisionRequest) {
    const key = yield* credentials(input.engine);
    const response = yield* http
      .execute(
        HttpClientRequest.post(engines[input.engine].url).pipe(
          HttpClientRequest.setHeader("Authorization", `Bearer ${key}`),
          HttpClientRequest.bodyJsonUnsafe(encodeRequest(input)),
        ),
      )
      .pipe(Effect.mapError(() => new DecisionError({ code: "transport-error" })));
    if (response.status !== 200)
      return yield* new DecisionError({
        code:
          response.status === 401 || response.status === 403 || response.status === 503
            ? "unavailable"
            : "transport-error",
      });
    let size = 0;
    const chunks = yield* response.stream.pipe(
      Stream.mapEffect((chunk) => {
        size += chunk.byteLength;
        return size > DECISION_LIMITS.responseBytes
          ? Effect.fail(new DecisionError({ code: "invalid-provider-response" }))
          : Effect.succeed(chunk);
      }),
      Stream.runCollect,
      Effect.mapError((error) =>
        isDecisionError(error) ? error : new DecisionError({ code: "transport-error" }),
      ),
    );
    return yield* Effect.try({
      try: () => decodeResponse(input, parseProviderJson(Buffer.concat(chunks).toString("utf8"))),
      catch: () => new DecisionError({ code: "invalid-provider-response" }),
    });
  }, Effect.scoped);
  const decide = Effect.fn("DecisionService.decide")(function* (
    raw: unknown,
    options?: { readonly signal?: AbortSignal },
  ) {
    const started = yield* Clock.currentTimeMillis;
    const input = yield* validate(raw);
    const digestBytes = yield* digestService
      .digest(
        Digest.sha256,
        new TextEncoder().encode(
          canonical({
            input,
            model: engines[input.engine].model,
            adapterVersion: ADAPTER_VERSION,
            options: { promptCache: "disabled" },
          }),
        ),
      )
      .pipe(Effect.mapError(() => new DecisionError({ code: "unavailable" })));
    const digest = Buffer.from(digestBytes).toString("hex");
    // Admission and release are synchronous; no semaphore waiters or unbounded queue.
    const admission = Effect.sync(() => {
      admitted = admitted.filter((t) => started - t < 60_000);
      if (active >= DECISION_LIMITS.concurrent) return "busy" as const;
      if (admitted.length >= DECISION_LIMITS.perMinute) return "rate-limited" as const;
      active++;
      admitted.push(started);
      return undefined;
    }).pipe(
      Effect.flatMap((code) =>
        code === undefined ? Effect.void : Effect.fail(new DecisionError({ code })),
      ),
    );
    const signal = options?.signal;
    if (signal?.aborted) return yield* new DecisionError({ code: "cancelled" });
    const operation =
      signal === undefined
        ? call(input)
        : Effect.raceFirst(
            call(input),
            Effect.callback<never, DecisionError>((resume) => {
              const abort = () => resume(Effect.fail(new DecisionError({ code: "cancelled" })));
              signal.addEventListener("abort", abort, { once: true });
              if (signal.aborted) abort();
              return Effect.sync(() => signal.removeEventListener("abort", abort));
            }),
          );
    const remaining = Math.max(
      0,
      DECISION_LIMITS.deadlineMs - ((yield* Clock.currentTimeMillis) - started),
    );
    const result = yield* Effect.acquireUseRelease(
      admission,
      () =>
        operation.pipe(
          Effect.timeoutOrElse({
            duration: remaining,
            orElse: () => Effect.fail(new DecisionError({ code: "timeout" })),
          }),
        ),
      () =>
        Effect.sync(() => {
          active--;
        }),
    );
    return {
      ...result,
      engine: input.engine,
      requestedModel: engines[input.engine].model,
      adapterVersion: ADAPTER_VERSION,
      rule: input.rule,
      digest,
      digestVersion: "sha256-canonical-json-v1" as const,
      latencyMs: (yield* Clock.currentTimeMillis) - started,
    };
  });
  return DecisionService.of({ decide });
});
export const layer = Layer.effect(DecisionService, make);
