import * as NodeCryptoLayer from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Schema from "effect/Schema";
import { HttpClient, HttpClientError, HttpClientResponse } from "effect/http";
import * as TestClock from "effect/testing/TestClock";
import * as Crypto from "effect/Crypto";
import * as NodeUtil from "node:util";

import * as HqAgentConnections from "./HqAgentConnections.ts";
import * as HqSignIn from "./HqSignIn.ts";

const hqOrigin = "https://hq.example.test";
const handbackOrigin = "https://t3.example.test";
const delegation = `yshqd_${"d".repeat(43)}`;
const parseJson = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const stringifyJson = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

/** Weave's `/connect/t3` and `/api/connect/t3/token` as the contract documents them. */
const makeHarness = Effect.gen(function* () {
  const requests = new Map<string, { challenge: string; handback: string }>();
  const codes = new Map<string, { challenge: string; state: string }>();
  const connected: Array<{ origin: string; delegation: string }> = [];
  const logs: string[] = [];
  const hq = { unreachable: false, accessRevoked: false };
  let minted = 0;
  const effectCrypto = yield* Crypto.Crypto.pipe(Effect.provide(NodeCryptoLayer.layer));

  const client = HttpClient.make((request) =>
    Effect.gen(function* () {
      if (hq.unreachable)
        return yield* new HttpClientError.HttpClientError({
          reason: new HttpClientError.TransportError({ request, description: "unreachable" }),
        });
      const respond = (status: number, body: unknown) =>
        HttpClientResponse.fromWeb(
          request,
          new Response(stringifyJson(body), {
            status,
            headers: { "content-type": "application/json" },
          }),
        );
      assert.strictEqual(new URL(request.url).pathname, "/api/connect/t3/token");
      const raw =
        request.body._tag === "Uint8Array" ? new TextDecoder().decode(request.body.body) : "";
      const body = parseJson(raw) as { code: string; code_verifier: string };
      const issued = codes.get(body.code);
      // The code is consumed before the verifier is checked.
      codes.delete(body.code);
      const challenge = Buffer.from(
        yield* effectCrypto
          .digest("SHA-256", new TextEncoder().encode(body.code_verifier))
          .pipe(Effect.orDie),
      ).toString("base64url");
      if (issued === undefined || issued.challenge !== challenge)
        return respond(400, { error: "invalid_grant" });
      if (hq.accessRevoked) return respond(403, { error: "access_denied" });
      return respond(200, {
        delegation,
        delegation_id: "id",
        expires_at: "2026-11-21T00:00:00.000Z",
        exchange_endpoint: `${hqOrigin}/api/mcp/agents`,
      });
    }),
  );

  const connections = Layer.mock(HqAgentConnections.HqAgentConnections)({
    connect: (input) =>
      Effect.sync(() => {
        connected.push(input);
        return { origin: input.origin };
      }),
    disconnect: Effect.void,
  });
  const logger = Logger.make(
    ({ message }) => void logs.push(NodeUtil.inspect(message, { depth: 10 })),
  );
  const layer = HqSignIn.layer.pipe(
    Layer.provide(connections),
    Layer.provide(NodeCryptoLayer.layer),
    Layer.provide(Layer.succeed(HttpClient.HttpClient, client)),
  );
  const logLayer = Logger.layer([logger], { mergeWithExisting: false });
  const signIn = yield* HqSignIn.HqSignIn.pipe(Effect.provide(layer));

  /** The person approves Weave's consent page: Weave records the request and mints a code. */
  const startAndConsent = Effect.gen(function* () {
    const { url } = yield* signIn.begin({ handbackOrigin, hqOrigin });
    const params = new URL(url).searchParams;
    const state = params.get("state")!;
    requests.set(state, {
      challenge: params.get("code_challenge")!,
      handback: params.get("handback_url")!,
    });
    const code = `code-${(minted += 1)}`;
    codes.set(code, { challenge: params.get("code_challenge")!, state });
    return { url, params, state, code };
  });

  const assertNoSecrets = (...secrets: ReadonlyArray<string>) => {
    const everything = logs.join("\n");
    for (const secret of [delegation, ...secrets])
      assert.isFalse(everything.includes(secret), "a secret reached the logs");
  };
  return { signIn, hq, connected, startAndConsent, assertNoSecrets, requests, logs, logLayer };
});

describe("Connect to HQ sign-in", () => {
  it.effect("sends HQ a PKCE S256 challenge and this environment's callback, then connects", () =>
    Effect.gen(function* () {
      const { signIn, connected, startAndConsent, assertNoSecrets, logs, logLayer } =
        yield* makeHarness;
      const { url, params, state, code } = yield* startAndConsent;
      assert.strictEqual(new URL(url).origin, hqOrigin);
      assert.strictEqual(new URL(url).pathname, "/connect/t3");
      assert.strictEqual(params.get("code_challenge_method"), "S256");
      assert.match(params.get("code_challenge")!, /^[A-Za-z0-9_-]{43}$/);
      assert.strictEqual(params.get("handback_url"), `${handbackOrigin}/oauth/hq/callback`);
      assert.deepStrictEqual(yield* signIn.status, { status: "pending" });

      const outcome = yield* signIn.complete({ code, state }).pipe(Effect.provide(logLayer));
      assert.deepStrictEqual(outcome, { status: "connected" });
      assert.deepStrictEqual(connected, [{ origin: hqOrigin, delegation }]);
      assert.strictEqual(yield* signIn.status, null);
      assertNoSecrets(code, state, params.get("code_challenge")!);
      assert.deepStrictEqual(logs, []);
    }),
  );

  it.effect("signs in to Weave's current address unless another Weave is named", () =>
    Effect.gen(function* () {
      const { signIn } = yield* makeHarness;
      const { url } = yield* signIn.begin({ handbackOrigin });
      assert.strictEqual(new URL(url).origin, "https://weave.yardsmith.co.uk");
    }),
  );

  it.effect("refuses a forged or unknown state without touching an open sign-in", () =>
    Effect.gen(function* () {
      const { signIn, connected, startAndConsent } = yield* makeHarness;
      const { code } = yield* startAndConsent;
      const forged = yield* signIn.complete({
        code,
        state: "not-the-state-we-issued-0000000000000000",
      });
      assert.strictEqual(forged.status, "failed");
      assert.deepStrictEqual(yield* signIn.status, { status: "pending" });
      assert.deepStrictEqual(connected, []);
    }),
  );

  it.effect("accepts a callback once: a replayed state connects nothing more", () =>
    Effect.gen(function* () {
      const { signIn, connected, startAndConsent } = yield* makeHarness;
      const { state, code } = yield* startAndConsent;
      assert.strictEqual((yield* signIn.complete({ code, state })).status, "connected");
      assert.strictEqual((yield* signIn.complete({ code, state })).status, "failed");
      assert.strictEqual(connected.length, 1);
    }),
  );

  it.effect("fails when HQ rejects the verifier, and leaves the connection alone", () =>
    Effect.gen(function* () {
      const { signIn, connected, startAndConsent, requests } = yield* makeHarness;
      const first = yield* startAndConsent;
      const second = yield* startAndConsent;
      // A code minted for the other request cannot be redeemed with this request's verifier.
      const crossed = yield* signIn.complete({ code: second.code, state: first.state });
      assert.deepStrictEqual(crossed, { status: "failed", reason: "rejected" });
      assert.deepStrictEqual(connected, []);
      assert.isTrue(requests.has(second.state));
    }),
  );

  it.effect("reports a declined consent as cancelled and connects nothing", () =>
    Effect.gen(function* () {
      const { signIn, connected, startAndConsent } = yield* makeHarness;
      const { state } = yield* startAndConsent;
      const outcome = yield* signIn.complete({ error: "access_denied", state });
      assert.deepStrictEqual(outcome, { status: "cancelled" });
      assert.deepStrictEqual(yield* signIn.status, { status: "cancelled" });
      assert.deepStrictEqual(connected, []);
    }),
  );

  it.effect("names why redemption failed: lost access, unreachable HQ", () =>
    Effect.gen(function* () {
      const { signIn, hq, startAndConsent } = yield* makeHarness;
      hq.accessRevoked = true;
      const noAccess = yield* startAndConsent;
      assert.deepStrictEqual(
        yield* signIn.complete({ code: noAccess.code, state: noAccess.state }),
        {
          status: "failed",
          reason: "no_access",
        },
      );
      hq.unreachable = true;
      const down = yield* startAndConsent;
      assert.deepStrictEqual(yield* signIn.complete({ code: down.code, state: down.state }), {
        status: "failed",
        reason: "unavailable",
      });
    }),
  );

  it.effect("expires an unanswered request after ten minutes", () =>
    Effect.gen(function* () {
      const { signIn, connected, startAndConsent } = yield* makeHarness;
      const { state, code } = yield* startAndConsent;
      yield* TestClock.adjust("11 minutes");
      assert.deepStrictEqual(yield* signIn.status, { status: "failed", reason: "expired" });
      assert.strictEqual((yield* signIn.complete({ code, state })).status, "failed");
      assert.deepStrictEqual(connected, []);
    }),
  );

  it.effect("starts only toward a handback HQ accepts", () =>
    Effect.gen(function* () {
      const { signIn } = yield* makeHarness;
      for (const bad of [
        "http://t3.example.test",
        hqOrigin,
        "not a url",
        "ftp://t3.example.test",
      ]) {
        const error = yield* signIn.begin({ handbackOrigin: bad, hqOrigin }).pipe(Effect.flip);
        assert.strictEqual(error.reason, "invalid_handback");
      }
      const local = yield* signIn.begin({ handbackOrigin: "http://127.0.0.1:3773", hqOrigin });
      assert.strictEqual(
        new URL(local.url).searchParams.get("handback_url"),
        "http://127.0.0.1:3773/oauth/hq/callback",
      );
    }),
  );

  it.effect("keeps no more than HQ's ten open requests", () =>
    Effect.gen(function* () {
      const { signIn, startAndConsent } = yield* makeHarness;
      const first = yield* startAndConsent;
      for (let index = 0; index < 10; index += 1) yield* startAndConsent;
      assert.strictEqual(
        (yield* signIn.complete({ code: first.code, state: first.state })).status,
        "failed",
      );
    }),
  );

  it.effect("disconnect forgets open sign-ins", () =>
    Effect.gen(function* () {
      const { signIn, startAndConsent } = yield* makeHarness;
      const { state, code } = yield* startAndConsent;
      yield* signIn.disconnect;
      assert.strictEqual(yield* signIn.status, null);
      assert.strictEqual((yield* signIn.complete({ code, state })).status, "failed");
    }),
  );
});
