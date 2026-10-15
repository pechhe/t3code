import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import {
  EnvironmentId,
  MessageId,
  RunId,
  type ExperimentAssignment,
  type OrchestrationV2Run,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { McpSchema, McpServer } from "effect/ai";

import * as ExperimentService from "../../../experiments/ExperimentService.ts";
import {
  ContextRolloverNotes,
  makeRolloverNotes,
} from "../../../orchestration-v2/ContextRollover.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ServerSettings from "../../../serverSettings.ts";
import * as McpHttpServer from "../../McpHttpServer.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import { idleThreadProjection, liveThreadShell } from "../../McpToolAccess.testkit.ts";
import { ThreadId } from "@t3tools/contracts";
import * as Handlers from "./handlers.ts";
import { RolloverToolkit } from "./tools.ts";

const threadId = ThreadId.make("thread:rollover-handler");
const shell = liveThreadShell(threadId);
const run: OrchestrationV2Run = {
  id: RunId.make("run:rollover-handler"),
  threadId,
  ordinal: 1,
  providerInstanceId: shell.providerInstanceId,
  modelSelection: shell.modelSelection,
  providerThreadId: null,
  userMessageId: MessageId.make("message:rollover-handler"),
  rootNodeId: null,
  activeAttemptId: null,
  status: "running",
  requestedAt: shell.createdAt,
  startedAt: shell.createdAt,
  completedAt: null,
  checkpointId: null,
  contextHandoffId: null,
};
const live: ExperimentAssignment = {
  id: "assignment:live",
  experimentId: "experiment:rollover",
  revision: 1,
  lever: "rollover",
  unitKind: "thread",
  unitId: threadId,
  threadId,
  projectId: shell.projectId,
  taskCategory: null,
  boundaryRunId: null,
  variant: { id: "variant", label: "Variant", rollover: { softLimit: 1_000, hardLimit: 2_000 } },
  assignedModelSelection: shell.modelSelection,
  enrollment: "new",
  assignmentMethod: "randomized",
  assignedAt: "2026-01-01T00:00:00.000Z",
  codeRevision: null,
  briefRevision: null,
  provenance: null,
};
const historical: ExperimentAssignment = {
  ...live,
  id: "assignment:historical",
  enrollment: "historical",
  assignmentMethod: "observational",
};
const caller: McpInvocationContext.McpInvocationScope = {
  environmentId: EnvironmentId.make("environment:test"),
  requestNamespace: "provider:test",
  thread: {
    threadId,
    providerSessionId: "provider:test",
    providerInstanceId: shell.providerInstanceId,
  },
  client: undefined,
  capabilities: new Set(["orchestration"]),
  issuedAt: 0,
};
const client = McpSchema.McpServerClient.of({
  clientId: 1,
  protocolVersion: "2025-06-18",
  clientCapabilities: {},
  clientInfo: { name: "rollover-test", version: "1" },
  initializePayload: {
    protocolVersion: "2025-06-18",
    capabilities: {},
    clientInfo: { name: "rollover-test", version: "1" },
  },
  getClient: Effect.die("unused"),
});
const decode = Schema.decodeUnknownEffect(
  Schema.fromJsonString(
    Schema.Union([
      Schema.Struct({ code: Schema.String }),
      Schema.Struct({ message: Schema.String }),
    ]),
  ),
);

it.effect.each([false, true])(
  "accepts an experiment note only with a live randomized assignment: %s",
  (active) =>
    Effect.scoped(
      Effect.gen(function* () {
        const notes = makeRolloverNotes();
        const projection = { ...idleThreadProjection(shell), runs: [run] };
        const dependencies = Layer.mergeAll(
          NodeCrypto.layer,
          Layer.mock(ThreadManagement.ThreadManagementService)({
            getThreadProjection: () => Effect.succeed(projection),
            getThreadShell: () => Effect.succeed(shell),
          }),
          Layer.mock(ExperimentService.ExperimentService)({
            // Imported history exists in both cases and must never enable live rollover.
            assignments: () => Effect.succeed([historical, ...(active ? [live] : [])]),
            getRolloverAssignment: () => Effect.succeed(active ? live : null),
            recordEvidence: (input) =>
              Effect.succeed({ ...input, capturedAt: "2026-10-15T00:00:00Z" }),
          }),
          ServerSettings.layerTest({ contextRollover: { enabled: false } }).pipe(
            Layer.orDie,
            Layer.provide(NodeServices.layer),
          ),
        );
        const server = McpHttpServer.toolkitRegistration(RolloverToolkit, Handlers.layer).pipe(
          Layer.provideMerge(McpServer.McpServer.layer),
          Layer.provideMerge(dependencies),
        );
        const result = yield* McpServer.McpServer.pipe(
          Effect.flatMap((mcp) =>
            mcp.callTool({
              name: "t3_write_rollover_note",
              arguments: { note: "## Goal\nContinue." },
            }),
          ),
          Effect.flatMap(({ content }) =>
            decode(content.map((part) => (part.type === "text" ? part.text : "")).join("")),
          ),
          Effect.provideService(McpInvocationContext.McpInvocationContext, caller),
          Effect.provideService(McpSchema.McpServerClient, client),
          Effect.provideService(ContextRolloverNotes, notes),
          Effect.provide(server),
        );
        if (active) {
          assert.isTrue("message" in result);
          assert.equal(notes.get(threadId)?.runId, run.id);
        } else {
          assert.deepEqual(result, { code: "capability_denied" });
          assert.isUndefined(notes.get(threadId));
        }
      }),
    ),
);
