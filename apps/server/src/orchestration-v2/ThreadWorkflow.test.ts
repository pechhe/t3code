import { assert, it } from "@effect/vitest";
import {
  CommandId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as ProviderAdapterRegistry from "./ProviderAdapterRegistry.ts";
import * as ProviderReplayHarness from "./testkit/ProviderReplayHarness.ts";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

const instanceId = ProviderInstanceId.make("codex");
const adapter = {
  instanceId,
  driver: ProviderDriverKind.make("codex"),
  getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
  planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
  openSession: () => Effect.die("No provider process needed for metadata commands"),
} as ProviderAdapter.ProviderAdapterV2["Service"];
const layerDatabase = SqlitePersistence.layerMemory;
const layerTest = Layer.mergeAll(
  layerDatabase,
  ProjectionStore.layer.pipe(Layer.provide(layerDatabase)),
  ProviderReplayHarness.layerWithRegistry(
    { name: "thread-workflow" },
    ProviderAdapterRegistry.layerFromAdapters([adapter]),
    { databaseLayer: layerDatabase, runEffectWorker: false },
  ),
);

it.layer(layerTest)("thread workflow", (it) => {
  it.effect("the owner's metadata command sets, keeps, changes and clears it", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = ThreadId.make("thread:workflow");
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create"),
        threadId,
        projectId: ProjectId.make("project:workflow"),
        title: "Workflow",
        modelSelection: { instanceId, model: "gpt-5" },
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      assert.equal((yield* projections.getThreadShell(threadId))?.workflow, null);

      const set = yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("set"),
        threadId,
        workflow: { kind: "lead", unattended: false },
      });
      // The event payload is what reaches every connected client.
      const event = set.storedEvents.find(
        (stored) => stored.event.type === "thread.metadata-updated",
      )?.event;
      assert.ok(event?.type === "thread.metadata-updated");
      assert.deepEqual(event.payload.workflow, { kind: "lead", unattended: false });

      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("rename"),
        threadId,
        title: "Renamed",
      });
      assert.deepEqual((yield* projections.getThreadShell(threadId))?.workflow, {
        kind: "lead",
        unattended: false,
      });

      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("change"),
        threadId,
        workflow: { kind: "solo", unattended: true },
      });
      assert.deepEqual((yield* orchestrator.getThreadProjection(threadId)).thread.workflow, {
        kind: "solo",
        unattended: true,
      });

      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("clear"),
        threadId,
        workflow: null,
      });
      assert.equal((yield* projections.getThreadShell(threadId))?.workflow, null);
      assert.equal((yield* orchestrator.getThreadProjection(threadId)).thread.workflow, null);
    }),
  );

  it.effect("the Build item link is set, replaced, kept and cleared like the workflow", () =>
    Effect.gen(function* () {
      const orchestrator = yield* Orchestrator.OrchestratorV2;
      const projections = yield* ProjectionStore.ProjectionStoreV2;
      const threadId = ThreadId.make("thread:work-item");
      const spec = { itemId: "item-spec", number: 1_000_078, origin: "https://hq.example.test" };
      const ticket = { itemId: "item-ticket", number: 1_000_079, origin: spec.origin };
      yield* orchestrator.dispatch({
        type: "thread.create",
        commandId: CommandId.make("create-work-item"),
        threadId,
        projectId: ProjectId.make("project:work-item"),
        title: "Work item",
        modelSelection: { instanceId, model: "gpt-5" },
        runtimeMode: "approval-required",
        interactionMode: "default",
        branch: null,
        worktreePath: null,
        createdBy: "user",
        creationSource: "web",
      });
      assert.equal((yield* projections.getThreadShell(threadId))?.workItem, null);

      const set = yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("link-spec"),
        threadId,
        workItem: spec,
      });
      const event = set.storedEvents.find(
        (stored) => stored.event.type === "thread.metadata-updated",
      )?.event;
      assert.ok(event?.type === "thread.metadata-updated");
      assert.deepEqual(event.payload.workItem, spec);

      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("link-ticket"),
        threadId,
        workItem: ticket,
      });
      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("rename-work-item"),
        threadId,
        title: "Renamed",
      });
      assert.deepEqual((yield* projections.getThreadShell(threadId))?.workItem, ticket);
      assert.deepEqual((yield* orchestrator.getThreadProjection(threadId)).thread.workItem, ticket);

      yield* orchestrator.dispatch({
        type: "thread.metadata.update",
        commandId: CommandId.make("unlink"),
        threadId,
        workItem: null,
      });
      assert.equal((yield* projections.getThreadShell(threadId))?.workItem, null);
    }),
  );
});
