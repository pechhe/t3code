/**
 * Connect to HQ by signing in (pechhe/yardsmith YS-309). T3 sends the person's browser to HQ's
 * `/connect/t3` with a PKCE challenge and a single-use state, HQ hands the browser back to this
 * environment's own callback, and T3 redeems the one-time code for the same delegation the person
 * used to paste. The verifier, state and delegation stay in this process and the secret store; none
 * is logged, and the callback answers with a redirect so the code and state leave the address bar.
 */
import type { HqSignInState } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";

import * as HqAgentConnections from "./HqAgentConnections.ts";
import { SIGN_IN_CALLBACK_PATH } from "./signInPath.ts";

export const DEFAULT_HQ_ORIGIN = "https://hq.yardsmith.co.uk";

/** HQ keeps a request for ten minutes and at most ten per person. */
const REQUEST_LIFETIME_MS = 10 * 60 * 1_000;
const MAX_OPEN_REQUESTS = 10;
const HQ_REQUEST_TIMEOUT = "30 seconds";

export class HqSignInError extends Schema.TaggedError<HqSignInError>()("HqSignInError", {
  reason: Schema.Literals(["invalid_handback", "invalid_hq_origin"]),
}) {
  override get message(): string {
    return this.reason === "invalid_handback"
      ? "HQ can hand the sign-in back only to an https address, or an http one on this computer. Open T3 from such an address to connect."
      : "The HQ origin must be an https URL (http only for localhost).";
  }
}

export type SignInOutcome =
  | { readonly status: "connected" }
  | { readonly status: "cancelled" }
  | { readonly status: "failed"; readonly reason: NonNullable<HqSignInState["reason"]> };

const Redeemed = Schema.Struct({ delegation: Schema.String });
const decodeRedeemed = Schema.decodeUnknownOption(Redeemed);
const HqError = Schema.Struct({ error: Schema.String });
const decodeHqError = Schema.decodeUnknownOption(HqError);

interface OpenRequest {
  readonly verifier: string;
  readonly hqOrigin: string;
  readonly startedAt: number;
}

export class HqSignIn extends Context.Service<
  HqSignIn,
  {
    /** The HQ page the person's browser opens. */
    readonly begin: (input: {
      readonly handbackOrigin: string;
      readonly hqOrigin?: string | undefined;
    }) => Effect.Effect<{ readonly url: string }, HqSignInError>;
    /**
     * Finishes whatever HQ handed back. A state this environment did not issue, or already used,
     * fails without touching any open sign-in or the connection.
     */
    readonly complete: (params: {
      readonly code?: string | undefined;
      readonly state?: string | undefined;
      readonly error?: string | undefined;
    }) => Effect.Effect<SignInOutcome>;
    /** Where the newest sign-in stands; null once connected or when none was started. */
    readonly status: Effect.Effect<HqSignInState | null>;
    /** Disconnects T3 from HQ and forgets any sign-in still open. */
    readonly disconnect: Effect.Effect<void, HqAgentConnections.HqConnectionError>;
  }
>()("t3/hq/HqSignIn") {}

const make = Effect.gen(function* () {
  const connections = yield* HqAgentConnections.HqAgentConnections;
  const crypto = yield* Crypto.Crypto;
  const httpClient = yield* HttpClient.HttpClient;
  const open = new Map<string, OpenRequest>();
  let latest: HqSignInState | null = null;

  const random = crypto.randomBytes(32).pipe(
    Effect.map((bytes) => Buffer.from(bytes).toString("base64url")),
    Effect.orDie,
  );

  const prune = Effect.gen(function* () {
    const now = yield* Clock.currentTimeMillis;
    for (const [state, request] of open)
      if (now - request.startedAt >= REQUEST_LIFETIME_MS) open.delete(state);
    if (latest?.status === "pending" && open.size === 0)
      latest = { status: "failed", reason: "expired" };
  });

  const redeem = (request: OpenRequest, code: string) =>
    // An HTTP client error carries the request, and so the code and verifier: never pass it on.
    HttpClientRequest.post(`${request.hqOrigin}/api/connect/t3/token`).pipe(
      HttpClientRequest.bodyJsonUnsafe({ code, code_verifier: request.verifier }),
      httpClient.execute,
      Effect.flatMap((response) =>
        response.json.pipe(Effect.map((json) => ({ status: response.status, json }))),
      ),
      Effect.timeout(HQ_REQUEST_TIMEOUT),
      Effect.mapError(() => "unavailable" as const),
    );

  const settle = (outcome: SignInOutcome): SignInOutcome => {
    latest =
      outcome.status === "connected"
        ? null
        : outcome.status === "cancelled"
          ? { status: "cancelled" }
          : { status: "failed", reason: outcome.reason };
    return outcome;
  };

  const begin: HqSignIn["Service"]["begin"] = Effect.fn("HqSignIn.begin")(function* (input) {
    const hqOrigin = HqAgentConnections.normalizeHqOrigin(input.hqOrigin ?? DEFAULT_HQ_ORIGIN);
    if (hqOrigin === null) return yield* new HqSignInError({ reason: "invalid_hq_origin" });
    const handbackOrigin = HqAgentConnections.normalizeHqOrigin(input.handbackOrigin);
    if (handbackOrigin === null || handbackOrigin === hqOrigin)
      return yield* new HqSignInError({ reason: "invalid_handback" });
    yield* prune;
    const state = yield* random;
    const verifier = yield* random;
    const challenge = yield* crypto.digest("SHA-256", new TextEncoder().encode(verifier)).pipe(
      Effect.map((bytes) => Buffer.from(bytes).toString("base64url")),
      Effect.orDie,
    );
    const now = yield* Clock.currentTimeMillis;
    // HQ refuses an eleventh open request, so forget the oldest rather than start one that fails.
    while (open.size >= MAX_OPEN_REQUESTS) {
      const oldest = open.keys().next();
      if (oldest.done) break;
      open.delete(oldest.value);
    }
    open.set(state, { verifier, hqOrigin, startedAt: now });
    latest = { status: "pending" };
    const url = new URL("/connect/t3", hqOrigin);
    url.search = new URLSearchParams({
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      handback_url: `${handbackOrigin}${SIGN_IN_CALLBACK_PATH}`,
    }).toString();
    return { url: url.toString() };
  });

  const complete: HqSignIn["Service"]["complete"] = Effect.fn("HqSignIn.complete")(
    function* (params) {
      yield* prune;
      const request = params.state === undefined ? undefined : open.get(params.state);
      if (params.state === undefined || request === undefined)
        return { status: "failed", reason: "rejected" } as const;
      // Single use: a replayed callback finds nothing.
      open.delete(params.state);
      if (params.error === "access_denied") return settle({ status: "cancelled" });
      if (params.error !== undefined || params.code === undefined || params.code === "")
        return settle({ status: "failed", reason: "rejected" });
      const response = yield* redeem(request, params.code).pipe(Effect.option);
      if (Option.isNone(response)) return settle({ status: "failed", reason: "unavailable" });
      const { status, json } = response.value;
      if (status !== 200) {
        const code = Option.getOrUndefined(decodeHqError(json))?.error;
        return settle({
          status: "failed",
          reason:
            status === 403 && code === "access_denied"
              ? "no_access"
              : status === 400
                ? "rejected"
                : "unavailable",
        });
      }
      const redeemed = decodeRedeemed(json);
      if (Option.isNone(redeemed)) return settle({ status: "failed", reason: "invalid_response" });
      const connected = yield* connections
        .connect({ origin: request.hqOrigin, delegation: redeemed.value.delegation })
        .pipe(Effect.option);
      return settle(
        Option.isSome(connected)
          ? { status: "connected" }
          : { status: "failed", reason: "invalid_response" },
      );
    },
  );

  return HqSignIn.of({
    begin,
    complete,
    status: prune.pipe(Effect.map(() => latest)),
    disconnect: connections.disconnect.pipe(
      Effect.tap(() =>
        Effect.sync(() => {
          open.clear();
          latest = null;
        }),
      ),
    ),
  });
});

export const layer = Layer.effect(HqSignIn, make);
