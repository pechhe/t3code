import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { makeAcpMcpOverAcpBridge } from "./mcpOverAcpBridge.ts";

describe("AcpMcpOverAcpBridge", () => {
  it.effect("sends each server's requests to its own endpoint with its own credential", () =>
    Effect.gen(function* () {
      const requests: Array<{ readonly url: string; readonly authorization: string | null }> = [];
      let nextConnection = 0;
      const bridge = yield* makeAcpMcpOverAcpBridge({
        servers: [
          {
            serverId: "t3-code",
            endpoint: "http://127.0.0.1:1/mcp",
            authorization: "Bearer t3-credential",
          },
          {
            serverId: "weave",
            endpoint: "http://127.0.0.1:1/mcp/weave",
            authorization: "Bearer weave-credential",
          },
        ],
        allocateConnectionId: Effect.sync(() => `connection-${++nextConnection}`),
        fetchImplementation: async (url, init) => {
          requests.push({ url, authorization: new Headers(init?.headers).get("authorization") });
          const request = JSON.parse(String(init?.body)) as { readonly id: unknown };
          return new Response(JSON.stringify({ jsonrpc: "2.0", id: request.id, result: {} }), {
            headers: { "content-type": "application/json" },
          });
        },
      });
      const weave = yield* bridge.connect({ serverId: "weave" });
      const t3 = yield* bridge.connect({ serverId: "t3-code" });
      yield* bridge.message({ connectionId: weave.connectionId, method: "tools/list" });
      yield* bridge.message({ connectionId: t3.connectionId, method: "tools/list" });
      expect(requests).toEqual([
        { url: "http://127.0.0.1:1/mcp/weave", authorization: "Bearer weave-credential" },
        { url: "http://127.0.0.1:1/mcp", authorization: "Bearer t3-credential" },
      ]);
    }),
  );
});
