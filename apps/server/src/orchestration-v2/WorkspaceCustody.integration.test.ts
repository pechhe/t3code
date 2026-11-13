import * as CustodyPeer from "../workspace/custodyPeerProtocol.ts";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  CommandId,
  EventId,
  EnvironmentId,
  MessageId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import type * as ProviderAdapter from "@t3tools/provider-core/server/ProviderAdapter";

import * as Journal from "../persistence/WorkspaceCustody.ts";
import * as Workspaces from "../project/WorkspaceProvider.ts";
import { fixture } from "../workspace/workspaceCustody.testkit.ts";
import { CodexProviderCapabilitiesV2 } from "./Adapters/CodexAdapterV2.ts";
import * as Orchestrator from "./Orchestrator.ts";
import * as ProjectStore from "./ProjectStore.ts";
import * as Registry from "./ProviderAdapterRegistry.ts";
import * as RunCustody from "./RunWorkspaceCustody.ts";
import * as Harness from "./testkit/ProviderReplayHarness.ts";

it.effect.each([false, true])(
  "publishes acquired sources and releases only settled custody (remote: %s)",
  (remote) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const instanceId = ProviderInstanceId.make("codex");
      const modelSelection = { instanceId, model: "gpt-5.1-codex" };
      const adapter = {
        instanceId,
        driver: ProviderDriverKind.make("codex"),
        getCapabilities: () => Effect.succeed(CodexProviderCapabilitiesV2),
        planSelectionTransition: () => Effect.succeed({ type: "apply_on_next_turn" as const }),
        openSession: () => Effect.die("No provider is launched by an admission fixture"),
      } as ProviderAdapter.ProviderAdapterV2["Service"];
      const layer = RunCustody.layer.pipe(
        Layer.provideMerge(
          Layer.mergeAll(
            f.layer,
            NodeServices.layer,
            Layer.mock(Workspaces.WorkspaceProvider)({ resolve: () => Effect.succeed("slipjay") }),
          ),
        ),
      );
      yield* Effect.gen(function* () {
        const custody = yield* RunCustody.RunWorkspaceCustody;
        const journal = yield* Journal.WorkspaceCustody;
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
        yield* fs.makeDirectory(`${root}/attached`);
        const harness = Harness.layerWithRegistry(
          { name: "workspace-custody" },
          Registry.layerFromAdapters([adapter]),
          {
            runEffectWorker: false,
            custodyLayer: Layer.succeed(RunCustody.RunWorkspaceCustody, custody),
          },
        );
        yield* Effect.gen(function* () {
          const orchestrator = yield* Orchestrator.OrchestratorV2;
          const projects = yield* ProjectStore.ProjectStoreV2;
          const projectId = ProjectId.make("custody-project");
          const threadId = ThreadId.make("custody-thread");
          const attachedProjectId = ProjectId.make("custody-attached-project");
          const at = "2026-11-13T17:00:00.000Z";
          yield* projects.apply({
            sequence: 1,
            eventId: EventId.make("custody-project-created"),
            aggregateKind: "project",
            aggregateId: projectId,
            occurredAt: at,
            commandId: null,
            causationEventId: null,
            correlationId: null,
            metadata: {},
            type: "project.created",
            payload: {
              projectId,
              title: "Custody",
              workspaceRoot: root,
              defaultModelSelection: modelSelection,
              scripts: [],
              createdAt: at,
              updatedAt: at,
            },
          });
          yield* projects.apply({
            sequence: 2,
            eventId: EventId.make("custody-attached-project-created"),
            aggregateKind: "project",
            aggregateId: attachedProjectId,
            occurredAt: at,
            commandId: null,
            causationEventId: null,
            correlationId: null,
            metadata: {},
            type: "project.created",
            payload: {
              projectId: attachedProjectId,
              title: "Attached custody",
              workspaceRoot: `${root}/attached`,
              defaultModelSelection: modelSelection,
              scripts: [],
              createdAt: at,
              updatedAt: at,
            },
          });
          yield* orchestrator.dispatch({
            type: "thread.create",
            commandId: CommandId.make("custody-create-thread"),
            threadId,
            projectId,
            title: "Audit",
            modelSelection,
            runtimeMode: "full-access",
            interactionMode: "default",
            branch: null,
            worktreePath: root,
            createdBy: "user",
            creationSource: "web",
            ...(remote
              ? {
                  linkOrigin: { sessionId: "owning-peer", label: "Parent" },
                  delegatedFrom: {
                    environmentId: EnvironmentId.make("parent-host"),
                    threadId: ThreadId.make("parent-thread"),
                    title: "Parent",
                  },
                }
              : {}),
          });
          const entered = yield* Deferred.make<void>();
          const acquired = yield* Deferred.make<void>();
          yield* Ref.set(
            f.acquisitionGate,
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(acquired))),
          );
          const queued = yield* orchestrator
            .dispatch({
              type: "message.dispatch",
              commandId: CommandId.make("custody-queue"),
              threadId,
              messageId: MessageId.make("custody-message"),
              text: "Audit",
              attachments: [],
              dispatchMode: { type: "defer_start" },
              createdBy: "user",
              creationSource: "web",
            })
            .pipe(Effect.forkChild);
          yield* Deferred.await(entered);
          assert.equal((yield* orchestrator.getThreadProjection(threadId)).runs.length, 0);
          yield* Deferred.succeed(acquired, undefined);
          yield* Fiber.join(queued);
          const run = (yield* orchestrator.getThreadProjection(threadId)).runs.at(-1)!;
          assert.equal(run.status, "preparing");
          assert.equal((yield* journal.list).filter((epoch) => epoch.phase === "open").length, 1);
          yield* orchestrator.dispatch({
            type: "thread.workspace-attachment.update",
            commandId: CommandId.make("custody-attach"),
            threadId,
            change: {
              action: "attach",
              attachment: {
                projectId: attachedProjectId,
                workspacePath: `${root}/attached`,
                branch: null,
                origin: "adopted",
              },
            },
          });
          assert.equal((yield* journal.list).filter((epoch) => epoch.phase === "open").length, 2);
          if (remote) {
            yield* custody.register(run.id, { id: "provider", kind: "provider-turn" });
            yield* custody.acknowledge(run.id, "admission", "provider-started");
          }
          yield* orchestrator.dispatch({
            type: "run.interrupt",
            commandId: CommandId.make("custody-cancel"),
            threadId,
            runId: run.id,
          });
          if (remote) {
            assert.equal(
              (yield* journal.list).filter((epoch) => epoch.phase !== "released").length,
              2,
            );
            const input = {
              threadId,
              sourceRunId: run.id,
              runId: run.id,
              receiptRef: CustodyPeer.receiptRef(threadId, run.id, run.id),
            };
            const peer = {
              sessionId: "owning-peer",
              environmentId: "parent-host",
              parentThreadId: ThreadId.make("parent-thread"),
            };
            for (const identity of [
              { ...peer, sessionId: "other-peer" },
              { ...peer, parentThreadId: ThreadId.make("other-parent") },
              { ...peer, environmentId: "other-host" },
            ]) {
              assert.equal(
                (yield* orchestrator.acknowledgeRemoteCustody(input, identity).pipe(Effect.exit))
                  ._tag,
                "Failure",
              );
              assert.equal(yield* Ref.get(f.releases), 0);
            }
            yield* orchestrator.acknowledgeRemoteCustody(input, peer);
            assert.equal(yield* Ref.get(f.releases), 0);
            yield* custody.acknowledge(run.id, "provider", "provider-stop-acknowledged");
            yield* orchestrator.acknowledgeRemoteCustody(input, peer);
          }
          assert.equal(
            (yield* journal.list).filter((epoch) => epoch.phase !== "released").length,
            0,
          );
          assert.equal(yield* Ref.get(f.releases), 2);
        }).pipe(Effect.provide(harness));
      }).pipe(Effect.provide(layer));
    }),
);
