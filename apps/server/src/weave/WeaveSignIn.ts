/**
 * Weave sign-in uses PKCE, single-use state and this environment's callback.
 * Keep verifier, state and delegation in-process or in the secret store; never log them.
 * Redirect after redemption to remove the one-time code and state from the address bar.
 */
import type { WeaveSignInState } from "@t3tools/contracts";
import { DEFAULT_WEAVE_ORIGIN } from "@t3tools/shared/weaveOrigins";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Digest from "effect/crypto/Digest";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientRequest } from "effect/http";

import * as WeaveAgentConnections from "./WeaveAgentConnections.ts";
import { SIGN_IN_CALLBACK_PATH } from "./signInPath.ts";

/** Weave keeps a request for ten minutes and at most ten per person. */
const REQUEST_LIFETIME_MS = 10 * 60 * 1_000;
const MAX_OPEN_REQUESTS = 10;
const WEAVE_REQUEST_TIMEOUT = "30 seconds";

export class WeaveSignInError extends Schema.TaggedError<WeaveSignInError>()("WeaveSignInError", {
  reason: Schema.Literals(["invalid_handback", "invalid_hq_origin"]),
}) {
  override get message(): string {
    return this.reason === "invalid_handback"
      ? "Weave can hand the sign-in back only to an https address, or an http one on this computer. Open T3 from such an address to connect."
      : "The Weave origin must be an https URL (http only for localhost).";
  }
}

export type SignInOutcome =
  | { readonly status: "connected" }
  | { readonly status: "cancelled" }
  | { readonly status: "failed"; readonly reason: NonNullable<WeaveSignInState["reason"]> };

const Redeemed = Schema.Struct({ delegation: Schema.String });
const decodeRedeemed = Schema.decodeUnknownOption(Redeemed);
const WeaveError = Schema.Struct({ error: Schema.String });
const decodeWeaveError = Schema.decodeUnknownOption(WeaveError);

interface OpenRequest {
  readonly verifier: string;
  readonly weaveOrigin: string;
  readonly startedAt: number;
}

export class WeaveSignIn extends Context.Service<
  WeaveSignIn,
  {
    /** The Weave page the person's browser opens. */
    readonly begin: (input: {
      readonly handbackOrigin: string;
      readonly weaveOrigin?: string | undefined;
    }) => Effect.Effect<{ readonly url: string }, WeaveSignInError>;
    /**
     * Finishes whatever Weave handed back. A state this environment did not issue, or already used,
     * fails without touching any open sign-in or the connection.
     */
    readonly complete: (params: {
      readonly code?: string | undefined;
      readonly state?: string | undefined;
      readonly error?: string | undefined;
    }) => Effect.Effect<SignInOutcome>;
    /** Where the newest sign-in stands; null once connected or when none was started. */
    readonly status: Effect.Effect<WeaveSignInState | null>;
    /** Disconnects T3 from Weave and forgets any sign-in still open. */
    readonly disconnect: Effect.Effect<void, WeaveAgentConnections.WeaveConnectionError>;
  }
>()("t3/weave/WeaveSignIn") {}

const make = Effect.gen(function* () {
  const connections = yield* WeaveAgentConnections.WeaveAgentConnections;
  const crypto = yield* Digest.Digest;
  const secureRandom = yield* SecureRandom.SecureRandom;
  const httpClient = yield* HttpClient.HttpClient;
  const open = new Map<string, OpenRequest>();
  let latest: WeaveSignInState | null = null;

  const random = secureRandom.randomBytes(32).pipe(
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
    HttpClientRequest.post(`${request.weaveOrigin}/api/connect/t3/token`).pipe(
      HttpClientRequest.bodyJsonUnsafe({ code, code_verifier: request.verifier }),
      httpClient.execute,
      Effect.flatMap((response) =>
        response.json.pipe(Effect.map((json) => ({ status: response.status, json }))),
      ),
      Effect.timeout(WEAVE_REQUEST_TIMEOUT),
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

  const begin: WeaveSignIn["Service"]["begin"] = Effect.fn("WeaveSignIn.begin")(function* (input) {
    const weaveOrigin = WeaveAgentConnections.normalizeWeaveOrigin(
      input.weaveOrigin ?? DEFAULT_WEAVE_ORIGIN,
    );
    if (weaveOrigin === null) return yield* new WeaveSignInError({ reason: "invalid_hq_origin" });
    const handbackOrigin = WeaveAgentConnections.normalizeWeaveOrigin(input.handbackOrigin);
    if (handbackOrigin === null || handbackOrigin === weaveOrigin)
      return yield* new WeaveSignInError({ reason: "invalid_handback" });
    yield* prune;
    const state = yield* random;
    const verifier = yield* random;
    const challenge = yield* crypto.digest(Digest.sha256, new TextEncoder().encode(verifier)).pipe(
      Effect.map((bytes) => Buffer.from(bytes).toString("base64url")),
      Effect.orDie,
    );
    const now = yield* Clock.currentTimeMillis;
    // Weave refuses an eleventh open request, so forget the oldest rather than start one that fails.
    while (open.size >= MAX_OPEN_REQUESTS) {
      const oldest = open.keys().next();
      if (oldest.done) break;
      open.delete(oldest.value);
    }
    open.set(state, { verifier, weaveOrigin, startedAt: now });
    latest = { status: "pending" };
    const url = new URL("/connect/t3", weaveOrigin);
    url.search = new URLSearchParams({
      state,
      code_challenge: challenge,
      code_challenge_method: "S256",
      handback_url: `${handbackOrigin}${SIGN_IN_CALLBACK_PATH}`,
    }).toString();
    return { url: url.toString() };
  });

  const complete: WeaveSignIn["Service"]["complete"] = Effect.fn("WeaveSignIn.complete")(
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
        const code = Option.getOrUndefined(decodeWeaveError(json))?.error;
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
        .connect({ origin: request.weaveOrigin, delegation: redeemed.value.delegation })
        .pipe(Effect.option);
      return settle(
        Option.isSome(connected)
          ? { status: "connected" }
          : { status: "failed", reason: "invalid_response" },
      );
    },
  );

  return WeaveSignIn.of({
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

export const layer = Layer.effect(WeaveSignIn, make);
