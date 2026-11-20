import { assert, describe, it } from "@effect/vitest";

import { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";

import { cursorMcpServers } from "./adapter.ts";

describe("CursorAdapterV2", () => {
  it("attaches the thread's agent servers with or without a T3 session", () => {
    const weave = {
      name: "weave",
      url: "http://127.0.0.1:43123/mcp/weave",
      authorizationHeader: "Bearer thread-weave-credential",
    };
    const server = {
      type: "http" as const,
      url: weave.url,
      headers: { Authorization: weave.authorizationHeader },
    };
    assert.deepEqual(cursorMcpServers(undefined, [weave]), { weave: server });
    assert.deepInclude(
      cursorMcpServers(
        {
          environmentId: EnvironmentId.make("environment-cursor-mcp"),
          threadId: ThreadId.make("thread-cursor-mcp"),
          providerSessionId: "mcp-session-cursor",
          providerInstanceId: ProviderInstanceId.make("cursor"),
          endpoint: "http://127.0.0.1:43123/mcp",
          authorizationHeader: "Bearer secret-cursor-mcp-token",
          browserToolsAvailable: true,
        },
        [weave],
      ),
      { weave: server },
    );
    assert.isUndefined(cursorMcpServers(undefined, []));
  });
});
