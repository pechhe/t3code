import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  OrchestratorMcpFailure,
  ProviderInstanceId,
  ScheduledTaskId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { McpSchema, McpServer } from "effect/ai";

import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as PeerForwarding from "../../../peer/PeerForwarding.ts";
import * as PeerLinkRequests from "../../../peer/PeerLinkRequests.ts";
import * as PeerLinks from "../../../peer/PeerLinks.ts";
import * as ThreadHandoff from "../../../peer/handoff/ThreadHandoff.ts";
import * as ThreadDirectory from "../../../peers/ThreadDirectory.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as OrchestratorMcpService from "../../OrchestratorMcpService.ts";
import * as ThreadMetadataMcpService from "../../ThreadMetadataMcpService.ts";
import * as OrchestratorHandlers from "./handlers.ts";
import { OrchestratorToolkit } from "./tools.ts";

const threadId = ThreadId.make("thread:caller");
const scope: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("env:test"),
  requestNamespace: `provider:${threadId}`,
  thread: {
    threadId,
    providerSessionId: `provider:${threadId}`,
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
};

const mcpClient = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "mcp-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "mcp-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});

const schedule = { type: "interval", everyMs: 3_600_000 };

it.effect("schedule_task needs a label to create a task and leaves it alone on an update", () =>
  Effect.gen(function* () {
    const created: Array<unknown> = [];
    const updated: Array<unknown> = [];
    const stop = new OrchestratorMcpFailure({ code: "invalid_request", message: "recorded" });
    const layer = McpHttpServer.toolkitRegistration(
      OrchestratorToolkit,
      OrchestratorHandlers.layer,
    ).pipe(
      Layer.provideMerge(McpHttpServer.layerInProcessMcpServer),
      Layer.provideMerge(
        Layer.mock(ThreadManagement.ThreadManagementService)({
          getThreadShell: () => Effect.succeed(liveThreadShell(threadId)),
        }),
      ),
      Layer.provideMerge(
        Layer.mock(OrchestratorMcpService.OrchestratorMcpService)({
          scheduleTask: (_scope, input) =>
            Effect.suspend(() => {
              created.push(input);
              return Effect.fail(stop);
            }),
          updateScheduledTask: (_scope, input) =>
            Effect.suspend(() => {
              updated.push(input);
              return Effect.fail(stop);
            }),
        }),
      ),
      Layer.provideMerge(Layer.mock(ThreadDirectory.ThreadDirectory)({})),
      Layer.provideMerge(Layer.mock(ThreadMetadataMcpService.ThreadMetadataMcpService)({})),
      Layer.provideMerge(Layer.mock(PeerForwarding.PeerForwarding)({})),
      Layer.provideMerge(Layer.mock(PeerLinkRequests.PeerLinkRequests)({})),
      Layer.provideMerge(Layer.mock(PeerLinks.PeerLinks)({})),
      Layer.provideMerge(Layer.mock(ThreadHandoff.ThreadHandoff)({})),
    );
    const call = (args: Record<string, unknown>) =>
      McpServer.McpServer.pipe(
        Effect.flatMap((server) => server.callTool({ name: "schedule_task", arguments: args })),
        Effect.map((result) =>
          result.content.map((part) => (part.type === "text" ? part.text : "")).join(""),
        ),
        Effect.provideService(McpInvocationContext.McpInvocationContext, scope),
        Effect.provideService(McpSchema.McpServerClient, mcpClient),
      );

    yield* Effect.gen(function* () {
      expect(yield* call({ prompt: "Look again", schedule })).toContain("`purpose`");
      expect(created).toEqual([]);

      yield* call({ prompt: "Look again", schedule, purpose: "check_back" });
      expect(created).toMatchObject([{ purpose: "check_back" }]);

      const scheduledTaskId = ScheduledTaskId.make("task:1");
      yield* call({ scheduledTaskId, enabled: false });
      yield* call({ scheduledTaskId, purpose: "long_running" });
      expect(updated).toEqual([
        { scheduledTaskId, enabled: false },
        { scheduledTaskId, purpose: "long_running" },
      ]);
    }).pipe(Effect.provide(layer));
  }),
);
