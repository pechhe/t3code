import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter } from "effect/http";

import * as HqSignIn from "./HqSignIn.ts";
import * as HqSignInRoute from "./HqSignInRoute.ts";

const makeHandler = (completed: Array<Parameters<HqSignIn.HqSignIn["Service"]["complete"]>[0]>) =>
  HttpRouter.toWebHandler(
    Layer.mergeAll(
      HqSignInRoute.layer,
      Layer.mock(HqSignIn.HqSignIn)({
        complete: (params) =>
          Effect.sync(() => {
            completed.push(params);
            return params.error === undefined
              ? ({ status: "connected" } as const)
              : ({ status: "cancelled" } as const);
          }),
      }),
    ),
    { disableLogger: true },
  );

it.effect("completes the handback and redirects so the code and state leave the address bar", () =>
  Effect.gen(function* () {
    const completed: Array<Parameters<HqSignIn.HqSignIn["Service"]["complete"]>[0]> = [];
    const { handler, dispose } = makeHandler(completed);
    const response = yield* Effect.promise(() =>
      handler(
        new Request("http://127.0.0.1:3773/oauth/hq/callback?code=secret-code&state=the-state"),
      ),
    );
    assert.strictEqual(response.status, 303, yield* Effect.promise(() => response.clone().text()));
    assert.strictEqual(response.headers.get("location"), "/oauth/hq/callback?result=connected");
    assert.strictEqual(response.headers.get("referrer-policy"), "no-referrer");
    assert.strictEqual(completed.length, 1);
    assert.strictEqual(completed[0]?.code, "secret-code");
    assert.strictEqual(completed[0]?.state, "the-state");
    yield* Effect.promise(dispose);
  }),
);

it.effect("reports a declined consent without a code", () =>
  Effect.gen(function* () {
    const completed: Array<Parameters<HqSignIn.HqSignIn["Service"]["complete"]>[0]> = [];
    const { handler, dispose } = makeHandler(completed);
    const response = yield* Effect.promise(() =>
      handler(new Request("http://t3.test/oauth/hq/callback?error=access_denied&state=s")),
    );
    assert.strictEqual(response.headers.get("location"), "/oauth/hq/callback?result=cancelled");
    yield* Effect.promise(dispose);
  }),
);

it.effect("shows the result page without completing anything", () =>
  Effect.gen(function* () {
    const completed: Array<Parameters<HqSignIn.HqSignIn["Service"]["complete"]>[0]> = [];
    const { handler, dispose } = makeHandler(completed);
    const response = yield* Effect.promise(() =>
      handler(new Request("http://t3.test/oauth/hq/callback?result=connected")),
    );
    assert.strictEqual(response.status, 200);
    assert.include(yield* Effect.promise(() => response.text()), "T3 is connected to HQ");
    assert.deepStrictEqual(completed, []);
    yield* Effect.promise(dispose);
  }),
);
