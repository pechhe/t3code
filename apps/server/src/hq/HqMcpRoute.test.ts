import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { HttpRouter } from "effect/http";

import * as HqAgentConnections from "./HqAgentConnections.ts";
import * as HqMcpRoute from "./HqMcpRoute.ts";

it.effect("current and legacy MCP paths forward the same credential and body", () =>
  Effect.gen(function* () {
    const calls: Array<Parameters<HqAgentConnections.HqAgentConnections["Service"]["forward"]>[0]> =
      [];
    const { handler, dispose } = HttpRouter.toWebHandler(
      Layer.mergeAll(
        HqMcpRoute.layer,
        Layer.mock(HqAgentConnections.HqAgentConnections)({
          forward: (input) =>
            Effect.sync(() => {
              calls.push(input);
              return { status: 200, body: input.body, contentType: "application/json" };
            }),
        }),
      ),
      { disableLogger: true },
    );
    yield* Effect.acquireUseRelease(
      Effect.void,
      () =>
        Effect.gen(function* () {
          for (const name of ["weave", "yardsmith-hq"]) {
            const response = yield* Effect.promise(() =>
              handler(
                new Request(`http://t3.test/mcp/${name}`, {
                  method: "POST",
                  headers: {
                    authorization: "Bearer thread-credential",
                    "content-type": "application/json",
                  },
                  body: '{"jsonrpc":"2.0","method":"tools/list","id":1}',
                }),
              ),
            );
            assert.strictEqual(response.status, 200);
            assert.strictEqual(
              yield* Effect.promise(() => response.text()),
              '{"jsonrpc":"2.0","method":"tools/list","id":1}',
            );
            const refused = yield* Effect.promise(() =>
              handler(new Request(`http://t3.test/mcp/${name}`)),
            );
            assert.strictEqual(refused.status, 405);
          }
          assert.strictEqual(calls.length, 2);
          assert.deepStrictEqual(calls[0], calls[1]);
          assert.strictEqual(calls[0]?.authorization, "Bearer thread-credential");
        }),
      () => Effect.promise(dispose),
    );
  }),
);
