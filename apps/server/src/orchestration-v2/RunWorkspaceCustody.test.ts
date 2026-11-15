import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as Journal from "../persistence/WorkspaceCustody.ts";
import * as Workspaces from "../project/WorkspaceProvider.ts";
import { fixture } from "../workspace/workspaceCustody.testkit.ts";
import * as WorkspaceCustody from "../workspace/WorkspaceCustody.ts";
import * as RunCustody from "./RunWorkspaceCustody.ts";

it.effect("keeps independent canonical claims through provider and checkpoint settlement", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
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
      const temp = yield* fs.makeTempDirectoryScoped();
      const source = yield* fs.realPath(temp);
      yield* fs.makeDirectory(`${source}/checkout`);
      yield* fs.symlink(`${source}/checkout`, `${source}/alias`);
      yield* custody.admit({
        runId: "first",
        projectRoot: source,
        workspacePath: `${source}/checkout`,
      });
      yield* custody.admit({
        runId: "first",
        projectRoot: source,
        workspacePath: `${source}/alias`,
      });
      yield* custody.admit({
        runId: "second",
        projectRoot: source,
        workspacePath: `${source}/alias`,
      });
      assert.equal((yield* journal.list).length, 2);
      yield* custody.register("first", { id: "provider", kind: "provider-turn" });
      yield* custody.register("first", { id: "checkpoint", kind: "checkpoint" });
      yield* custody.acknowledge("first", "admission", "provider-start-ack");
      yield* custody.acknowledge("first", "provider", "provider-terminal-and-owned-work-drained");
      assert.equal((yield* custody.settle("first").pipe(Effect.result))._tag, "Failure");
      assert.equal(yield* Ref.get(f.releases), 0);
      yield* custody.acknowledge("first", "checkpoint", "checkpoint-durable");
      yield* custody.settle("first");
      yield* custody.settle("first");
      assert.equal(
        (yield* custody.register("first", { id: "late-child", kind: "child" }).pipe(Effect.result))
          ._tag,
        "Failure",
      );
      assert.equal(
        (yield* custody
          .admit({ runId: "first", projectRoot: source, workspacePath: source })
          .pipe(Effect.result))._tag,
        "Failure",
      );
      assert.equal(yield* Ref.get(f.releases), 1);
      const remaining = (yield* journal.list).filter((epoch) => epoch.phase !== "released");
      assert.equal(remaining.length, 1);
      assert.isTrue(remaining[0]!.ownerRef.startsWith("run:second:"));
      yield* custody.recover("second", "missing-adapter-stop-proof");
      assert.equal((yield* journal.get(remaining[0]!.id)).phase, "recovery-required");
      assert.equal((yield* custody.settle("second").pipe(Effect.result))._tag, "Failure");
      assert.equal(yield* Ref.get(f.releases), 1);
      const queued = { runId: "queued", projectRoot: source, workspacePath: `${source}/alias` };
      yield* custody.admit({ ...queued, admissionId: "queue-first" });
      yield* custody.endAdmission("queued", "queue-held-before-start");
      assert.equal(yield* Ref.get(f.releases), 2);
      assert.equal((yield* custody.admit(queued).pipe(Effect.result))._tag, "Failure");
      yield* custody.admit({ ...queued, admissionId: "queue-resumed" });
      yield* custody.register("queued", { id: "execution", kind: "provider-turn" });
      yield* custody.endAdmission("queued", "logical-cancel-request");
      assert.equal(yield* Ref.get(f.releases), 2);
      yield* custody.acknowledge("queued", "admission", "provider-accepted");
      yield* custody.acknowledge("queued", "execution", "provider-terminal-ack");
      yield* custody.settle("queued");
      assert.equal(yield* Ref.get(f.releases), 3);
    }).pipe(Effect.provide(layer));
  }),
);

it.effect(
  "failed re-admission with a fresh command cannot leave a new active epoch after restart",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
        const input = { runId: "restarted", projectRoot: root, workspacePath: root };
        yield* Effect.gen(function* () {
          const custody = yield* RunCustody.RunWorkspaceCustody;
          yield* custody.admit({ ...input, admissionId: "initial-command" });
          yield* custody.register(input.runId, {
            id: "execution",
            kind: "provider-turn",
            processIds: [{ pid: 456 }],
          });
          yield* custody.acknowledge(input.runId, "admission", "execution-started");
          yield* fs.makeDirectory(`${root}/attached`);
          yield* custody.admit({ ...input, workspacePath: `${root}/attached` });
        }).pipe(Effect.provide(RunCustody.layer));
        yield* Ref.set(f.controllerStart, "after-restart");
        yield* Ref.set(f.processStarts, new Map([[456, "first-start"]]));
        const journal = yield* Journal.WorkspaceCustody;
        yield* Effect.gen(function* () {
          const custody = yield* RunCustody.RunWorkspaceCustody;
          const result = yield* custody
            .admit({ ...input, admissionId: "restart-command" })
            .pipe(Effect.result);
          assert.equal(result._tag, "Failure");
          assert.equal((yield* journal.list).length, 2);
          assert.isTrue((yield* journal.list).some((epoch) => epoch.phase === "recovery-required"));
        }).pipe(Effect.provide(RunCustody.layer));
        yield* Ref.set(f.processStarts, new Map([[456, null]]));
        yield* (yield* WorkspaceCustody.WorkspaceCustody).reconcile;
        assert.isTrue((yield* journal.list).every((epoch) => epoch.phase === "released"));
      }).pipe(
        Effect.provide(
          Layer.mergeAll(
            f.layer,
            NodeServices.layer,
            Layer.mock(Workspaces.WorkspaceProvider)({ resolve: () => Effect.succeed("slipjay") }),
          ),
        ),
      );
    }),
);

it.effect("a fresh command still retains an undelivered result after restart", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
      yield* fs.makeDirectory(`${root}/attached`);
      const owner = "delivery:task";
      const retainDelivery = (admissionId: string) =>
        Effect.gen(function* () {
          const custody = yield* RunCustody.RunWorkspaceCustody;
          for (const workspacePath of [root, `${root}/attached`])
            yield* custody.admit({ runId: owner, projectRoot: root, workspacePath, admissionId });
          yield* custody.register(owner, { id: "delivery", kind: "delivery" });
          yield* custody.acknowledge(owner, "admission", "delivery-registered");
        });
      yield* retainDelivery("dispatch").pipe(Effect.provide(RunCustody.layer));
      yield* Ref.set(f.controllerStart, "after-restart");
      const journal = yield* Journal.WorkspaceCustody;
      yield* Effect.gen(function* () {
        const custody = yield* RunCustody.RunWorkspaceCustody;
        const unadmitted = yield* custody
          .admit({ runId: owner, projectRoot: root, workspacePath: root })
          .pipe(Effect.result);
        assert.equal(unadmitted._tag, "Failure");
        yield* retainDelivery("dispatch");
        yield* retainDelivery("restart-continuation");
        const phases = (yield* journal.list).map((epoch) => epoch.phase).toSorted();
        assert.deepEqual(phases, ["open", "open", "recovery-required", "recovery-required"]);
        yield* (yield* WorkspaceCustody.WorkspaceCustody).reconcile;
        assert.equal(yield* Ref.get(f.releases), 0);
        yield* custody.acknowledge(owner, "delivery", "parent-consumed");
        yield* custody.settle(owner);
        assert.isTrue((yield* journal.list).every((epoch) => epoch.phase === "released"));
      }).pipe(Effect.provide(RunCustody.layer));
    }).pipe(
      Effect.provide(
        Layer.mergeAll(
          f.layer,
          NodeServices.layer,
          Layer.mock(Workspaces.WorkspaceProvider)({ resolve: () => Effect.succeed("slipjay") }),
        ),
      ),
    );
  }),
);
