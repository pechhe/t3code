import {
  DECISION_LIMITS,
  DECISION_PROVIDER_LABELS,
  DecisionRequest,
  DecisionRoutingError,
  DecisionRoutingRequest,
  isSecretReference,
  type DecisionKeyStatus,
  type DecisionProvider,
  type DecisionRoutedResult,
  type DecisionRoutingFailureCode,
  type DecisionStatus,
  type DecisionTestResult,
  type ServerSettingsError,
} from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";
import * as Clock from "effect/Clock";
import * as Config from "effect/Config";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { FetchHttpClient, HttpClient, HttpClientRequest } from "effect/http";

import * as ServerSettings from "../serverSettings.ts";
import {
  ADAPTER_VERSION,
  decodeResponse,
  encodeRequest,
  engines,
  parseProviderJson,
} from "../decisions/adapters.ts";
import * as BitwardenSecrets from "../secrets/BitwardenSecrets.ts";
import { requireSettingsSecret } from "../secrets/settingsSecretValue.ts";

const OPENROUTER_DECISIONS_URL = "https://openrouter.ai/api/alpha/decisions";
const ENVIRONMENT_KEY = {
  jev: "TYPESAFE_API_KEY",
  openai: "OPENAI_API_KEY",
  openrouter: "OPENROUTER_API_KEY",
} as const;
const ADMISSION_POLL_MS = 25;

const isRoutingError = Schema.is(DecisionRoutingError);
const encodeJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));
const decodeRequest = Schema.decodeUnknownSync(DecisionRoutingRequest, {
  onExcessProperty: "error",
});

const decodeEngineRequest = Schema.decodeSync(DecisionRequest);

function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  if (value !== null && typeof value === "object")
    return `{${Object.entries(value)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([k, v]) => `${encodeJson(k)}:${canonical(v)}`)
      .join(",")}}`;
  return encodeJson(value);
}

const modelFor = (provider: DecisionProvider, openRouterModel: string) =>
  provider === "jev"
    ? engines.jev.model
    : provider === "openai"
      ? engines.luna.model
      : openRouterModel;

function parseRequest(provider: DecisionProvider, raw: unknown) {
  if (Buffer.byteLength(encodeJson(raw), "utf8") > DECISION_LIMITS.inputBytes) throw new Error();
  const { rule, evidence, questions } = decodeRequest(raw);
  const input = decodeEngineRequest({
    engine: provider === "openai" ? ("luna" as const) : ("jev" as const),
    rule,
    evidence,
    questions,
  });
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
}

const validate = (provider: DecisionProvider, raw: unknown) =>
  Effect.try({
    try: () => parseRequest(provider, raw),
    catch: () =>
      new DecisionRoutingError({
        provider,
        code:
          typeof raw === "object" && raw !== null && "engine" in raw
            ? "engine-not-accepted"
            : "invalid-input",
      }),
  });

type ResolvedKey = {
  readonly key: string | null;
  readonly status: DecisionKeyStatus;
  readonly unreadable: boolean;
};

export class DecisionRouter extends Context.Service<
  DecisionRouter,
  {
    readonly decide: (
      input: unknown,
      options?: { readonly signal?: AbortSignal },
    ) => Effect.Effect<DecisionRoutedResult, DecisionRoutingError | ServerSettingsError>;
    readonly status: Effect.Effect<DecisionStatus, ServerSettingsError>;
    readonly test: Effect.Effect<DecisionTestResult, ServerSettingsError>;
  }
>()("t3/decisionRouting/DecisionRouter") {}

export const layer = Layer.effect(
  DecisionRouter,
  Effect.gen(function* () {
    const settings = yield* ServerSettings.ServerSettingsService;
    const resolver = yield* SecretResolver.SecretResolver;
    const bitwarden = yield* BitwardenSecrets.BitwardenSecrets;
    const digests = yield* Digest.Digest;
    const http = HttpClient.withScope(yield* HttpClient.HttpClient);
    const readEnvironment = (name: string) =>
      Config.option(Config.Redacted(name)).pipe(
        Effect.map((value) => (Option.isSome(value) ? Redacted.value(value.value).trim() : "")),
        Effect.orElseSucceed(() => ""),
      );
    const environmentKeys = {
      jev: yield* readEnvironment(ENVIRONMENT_KEY.jev),
      openai: yield* readEnvironment(ENVIRONMENT_KEY.openai),
      openrouter: yield* readEnvironment(ENVIRONMENT_KEY.openrouter),
    };
    let active = 0;
    let admitted: number[] = [];

    const last4 = (key: string) => (key.length >= 8 ? key.slice(-4) : null);
    const none: ResolvedKey = {
      key: null,
      status: { source: "none", last4: null },
      unreadable: false,
    };

    // A reference that cannot be read fails; it never falls through to another source.
    const resolveKey = Effect.fn("DecisionRouter.resolveKey")(function* (
      provider: DecisionProvider,
      configured: string | Parameters<typeof isSecretReference>[0],
    ) {
      if (isSecretReference(configured)) {
        yield* resolver.invalidate([configured]);
        const key = yield* requireSettingsSecret(resolver, configured).pipe(
          Effect.map((value) => value.trim()),
          Effect.orElseSucceed(() => ""),
        );
        return key
          ? ({
              key,
              status: { source: "reference", last4: last4(key) },
              unreadable: false,
            } as const)
          : ({ ...none, status: { source: "reference", last4: null }, unreadable: true } as const);
      }
      const literal = typeof configured === "string" ? configured.trim() : "";
      if (literal)
        return {
          key: literal,
          status: { source: "setting", last4: last4(literal) },
          unreadable: false,
        } satisfies ResolvedKey;
      const fromEnvironment = environmentKeys[provider];
      if (fromEnvironment)
        return {
          key: fromEnvironment,
          status: { source: "server-environment", last4: last4(fromEnvironment) },
          unreadable: false,
        } satisfies ResolvedKey;
      if (provider === "jev") {
        const read = yield* bitwarden
          .read(ENVIRONMENT_KEY.jev)
          .pipe(Effect.orElseSucceed(() => Option.none<string>()));
        const value = Option.isSome(read) ? read.value.trim() : "";
        if (value)
          return {
            key: value,
            status: { source: "bitwarden", last4: last4(value) },
            unreadable: false,
          } satisfies ResolvedKey;
      }
      return none;
    });

    const configuration = Effect.fn("DecisionRouter.configuration")(function* () {
      const current = yield* settings.getSettings;
      const provider = current.decisionProvider;
      return {
        provider,
        model: modelFor(provider, current.decisionOpenRouterModel),
        credentials: current.decisionCredentials,
      };
    });

    const call = Effect.fn("DecisionRouter.call")(function* (
      provider: DecisionProvider,
      model: string,
      key: string,
      input: DecisionRequest,
    ) {
      const fail = (code: DecisionRoutingFailureCode) =>
        new DecisionRoutingError({ provider, code });
      const body = encodeRequest(input);
      const url =
        provider === "jev"
          ? engines.jev.url
          : provider === "openai"
            ? engines.luna.url
            : OPENROUTER_DECISIONS_URL;
      const response = yield* http
        .execute(
          HttpClientRequest.post(url).pipe(
            HttpClientRequest.setHeader("Authorization", `Bearer ${key}`),
            HttpClientRequest.bodyJsonUnsafe(provider === "openrouter" ? { ...body, model } : body),
          ),
        )
        .pipe(
          Effect.provideService(FetchHttpClient.RequestInit, { redirect: "error" }),
          Effect.provideService(HttpClient.TracerPropagationEnabled, false),
          Effect.mapError(() => fail("unreachable")),
        );
      let size = 0;
      const chunks = yield* response.stream.pipe(
        Stream.mapEffect((chunk) => {
          size += chunk.byteLength;
          return size > DECISION_LIMITS.responseBytes
            ? Effect.fail(fail("invalid-provider-response"))
            : Effect.succeed(chunk);
        }),
        Stream.runCollect,
        Effect.mapError((error) => (isRoutingError(error) ? error : fail("unreachable"))),
      );
      const text = Buffer.concat(chunks).toString("utf8");
      if (response.status < 200 || response.status >= 300)
        return yield* fail(
          response.status === 401 || response.status === 403
            ? "key-rejected"
            : response.status === 402 || /insufficient_quota|insufficient credits/i.test(text)
              ? "credits-exhausted"
              : response.status === 429
                ? "rate-limited"
                : "unreachable",
        );
      return yield* Effect.try({
        try: () => {
          const raw = parseProviderJson(text);
          return { decoded: decodeResponse(input, raw), raw };
        },
        catch: () => fail("invalid-provider-response"),
      });
    }, Effect.scoped);

    const decide = Effect.fn("DecisionRouter.decide")(function* (
      raw: unknown,
      options?: { readonly signal?: AbortSignal },
    ) {
      const started = yield* Clock.currentTimeMillis;
      const { provider, model, credentials } = yield* configuration();
      const fail = (code: DecisionRoutingFailureCode) =>
        new DecisionRoutingError({ provider, code });
      const input = yield* validate(provider, raw);
      const resolved = yield* resolveKey(provider, credentials[provider]);
      if (resolved.key === null)
        return yield* fail(resolved.unreadable ? "key-unreadable" : "key-missing");
      const key = resolved.key;
      const digest = Buffer.from(
        yield* digests
          .digest(
            Digest.sha256,
            new TextEncoder().encode(
              canonical({
                input: { rule: input.rule, evidence: input.evidence, questions: input.questions },
                provider,
                model,
                adapterVersion: ADAPTER_VERSION,
                options: { promptCache: "disabled" },
              }),
            ),
          )
          .pipe(Effect.mapError(() => fail("unreachable"))),
      ).toString("hex");
      const tryAdmission = (at: number) =>
        Effect.sync(() => {
          admitted = admitted.filter((t) => at - t < 60_000);
          if (active >= DECISION_LIMITS.concurrent) return "busy" as const;
          if (admitted.length >= DECISION_LIMITS.perMinute) return "rate-limited" as const;
          active++;
          admitted.push(at);
          return undefined;
        });
      const admission = Effect.gen(function* () {
        const waitUntil = started + DECISION_LIMITS.admissionWaitMs;
        while (true) {
          const at = yield* Clock.currentTimeMillis;
          const code = yield* tryAdmission(at);
          if (code === undefined) return;
          if (at >= waitUntil) return yield* fail(code);
          yield* Effect.sleep(Duration.millis(Math.min(ADMISSION_POLL_MS, waitUntil - at)));
        }
      });
      const signal = options?.signal;
      if (signal?.aborted) return yield* fail("cancelled");
      const operation =
        signal === undefined
          ? call(provider, model, key, input)
          : Effect.raceFirst(
              call(provider, model, key, input),
              Effect.callback<never, DecisionRoutingError>((resume) => {
                const abort = () => resume(Effect.fail(fail("cancelled")));
                signal.addEventListener("abort", abort, { once: true });
                if (signal.aborted) abort();
                return Effect.sync(() => signal.removeEventListener("abort", abort));
              }),
            );
      const remaining = Math.max(
        0,
        DECISION_LIMITS.deadlineMs - ((yield* Clock.currentTimeMillis) - started),
      );
      const { decoded, raw: body } = yield* Effect.acquireUseRelease(
        admission,
        () =>
          operation.pipe(
            Effect.timeoutOrElse({
              duration: remaining,
              orElse: () => Effect.fail(fail("timeout")),
            }),
          ),
        () =>
          Effect.sync(() => {
            active--;
          }),
      );
      const reported =
        provider === "openrouter" &&
        typeof (body as { usage?: { cost?: unknown } })?.usage?.cost === "number" &&
        Number.isFinite((body as { usage: { cost: number } }).usage.cost)
          ? (body as { usage: { cost: number } }).usage.cost
          : null;
      const price = provider === "openai" ? engines.luna.price : engines.jev.price;
      const cost =
        provider === "openrouter"
          ? reported === null
            ? { ...decoded.cost, usd: null, status: "unknown" as const, inputUsdPerMillion: null }
            : {
                ...decoded.cost,
                usd: reported,
                status: "reported" as const,
                pricingSource: "https://openrouter.ai/docs",
                inputUsdPerMillion: null,
              }
          : { ...decoded.cost, inputUsdPerMillion: price };
      return {
        ...decoded,
        cost,
        provider,
        requestedModel: model,
        adapterVersion: ADAPTER_VERSION,
        rule: input.rule,
        digest,
        digestVersion: "sha256-canonical-json-v1" as const,
        latencyMs: (yield* Clock.currentTimeMillis) - started,
      } satisfies DecisionRoutedResult;
    });

    const status = Effect.gen(function* () {
      const { provider, model, credentials } = yield* configuration();
      const [jev, openai, openrouter] = yield* Effect.all([
        resolveKey("jev", credentials.jev),
        resolveKey("openai", credentials.openai),
        resolveKey("openrouter", credentials.openrouter),
      ]);
      return {
        provider,
        model,
        keys: { jev: jev.status, openai: openai.status, openrouter: openrouter.status },
      } satisfies DecisionStatus;
    }).pipe(Effect.withSpan("DecisionRouter.status"));

    const test = Effect.gen(function* () {
      const { provider, model } = yield* configuration();
      const result = yield* decide({
        rule: { id: "t3-decision-settings-test", version: "1" },
        evidence: { text: "The settings page asked whether the API key works." },
        questions: [
          {
            id: "works",
            type: "predicate",
            instructions: `Is this sentence a statement about a settings page for ${DECISION_PROVIDER_LABELS[provider]}?`,
          },
        ],
      }).pipe(Effect.result);
      if (result._tag === "Failure") {
        if (isRoutingError(result.failure))
          return {
            provider,
            model,
            ok: false,
            failure: result.failure.code,
            latencyMs: null,
            costUsd: null,
            inputTokens: null,
          } satisfies DecisionTestResult;
        return yield* result.failure;
      }
      return {
        provider,
        model,
        ok: true,
        latencyMs: result.success.latencyMs,
        costUsd: result.success.cost.usd,
        inputTokens: result.success.usage.inputTokens,
      } satisfies DecisionTestResult;
    }).pipe(Effect.withSpan("DecisionRouter.test"));

    return DecisionRouter.of({ decide, status, test });
  }),
);
