import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as Journal from "../persistence/WorkspaceCustody.ts";
import * as Workspaces from "../project/WorkspaceProvider.ts";
import { fixture } from "../workspace/workspaceCustody.testkit.ts";
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
