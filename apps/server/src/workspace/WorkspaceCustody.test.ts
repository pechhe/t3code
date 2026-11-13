import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Redacted from "effect/Redacted";
import * as Ref from "effect/Ref";
import * as Journal from "../persistence/WorkspaceCustody.ts";
import * as WorkspaceCustody from "./WorkspaceCustody.ts";
import { fixture } from "./workspaceCustody.testkit.ts";

it.effect("reconciles the durable acquisition request and releases only a settled epoch", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Effect.gen(function* () {
      const custody = yield* WorkspaceCustody.WorkspaceCustody;
      const first = yield* custody.prepare({
        ownerRef: "run-one:path-one",
        projectRoot: "/source",
      });
      const planned = yield* custody.allocationInput(first.id);
      const again = yield* custody.prepare({
        ownerRef: "run-one:path-one",
        projectRoot: "/source",
      });
      assert.equal(again.id, first.id);
      assert.isTrue(
        Redacted.value(planned.stdin) ===
          Redacted.value((yield* custody.allocationInput(again.id)).stdin),
      );
      yield* custody.register(first.id, { id: "provider-one", kind: "provider-turn" });
      yield* custody.acquireExisting(first.id, "/source/worktree");
      yield* custody.close(first.id);
      const refused = yield* custody.releaseSettled(first.id).pipe(Effect.result);
      assert.isTrue(refused._tag === "Failure");
      assert.equal(yield* Ref.get(f.releases), 0);
      yield* custody.acknowledge(first.id, "provider-one", "provider-terminal-one");
      yield* custody.releaseSettled(first.id);
      yield* custody.releaseSettled(first.id);
      assert.equal(yield* Ref.get(f.releases), 1);
      assert.isFalse(
        (yield* Ref.get(f.argumentsUsed)).some((arg) =>
          arg.includes(Redacted.value(first.credential)),
        ),
      );
    }).pipe(Effect.provide(f.layer));
  }),
);

it.effect("does not resume previous-controller custody from logical run identity alone", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Effect.gen(function* () {
      const custody = yield* WorkspaceCustody.WorkspaceCustody;
      const journal = yield* Journal.WorkspaceCustody;
      const epoch = yield* custody.prepare({ ownerRef: "surviving-run", projectRoot: "/source" });
      yield* custody.register(epoch.id, { id: "survivor", kind: "provider-turn" });
      yield* custody.acquireExisting(epoch.id, "/source/worktree");
      yield* Ref.set(f.controllerStart, "restarted-controller");
      const resumed = yield* custody
        .prepare({ ownerRef: "surviving-run", projectRoot: "/source" })
        .pipe(Effect.result);
      assert.isTrue(resumed._tag === "Failure");
      assert.equal((yield* journal.get(epoch.id)).phase, "recovery-required");
      assert.equal(yield* Ref.get(f.releases), 0);
      yield* custody.recover(epoch.id, "missing-adapter-stop-proof");
      assert.equal((yield* custody.close(epoch.id).pipe(Effect.result))._tag, "Failure");
      assert.equal(yield* Ref.get(f.releases), 0);
      yield* custody.acknowledge(epoch.id, "survivor", "provider-stop-acknowledged-after-restart");
      yield* custody.close(epoch.id);
      yield* custody.releaseSettled(epoch.id);
      assert.equal(yield* Ref.get(f.releases), 1);
    }).pipe(Effect.provide(f.layer));
  }),
);

it.effect.each([0, 2])(
  "refuses producer protocol %s before activation or acquisition",
  (protocol) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Ref.set(f.producerProtocol, protocol);
      yield* Effect.gen(function* () {
        const custody = yield* WorkspaceCustody.WorkspaceCustody;
        const result = yield* custody
          .prepare({ ownerRef: "unsupported", projectRoot: "/source" })
          .pipe(Effect.result);
        assert.equal(result._tag, "Failure");
        assert.deepEqual(yield* Ref.get(f.argumentsUsed), ["slipjay", "claims", "capability"]);
        assert.equal((yield* (yield* Journal.WorkspaceCustody).list).length, 0);
      }).pipe(Effect.provide(f.layer));
    }),
);

it.effect.each(["alias", "different-checkout", "missing-requested", "missing-receipt"] as const)(
  "validates existing custody by filesystem identity: %s",
  (scenario) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
      const checkout = `${root}/checkout`;
      const alias = `${root}/alias`;
      const other = `${root}/other`;
      yield* fs.makeDirectory(checkout);
      yield* fs.makeDirectory(other);
      yield* fs.symlink(checkout, alias);
      const requested = scenario === "missing-requested" ? `${root}/missing` : alias;
      const claimed =
        scenario === "different-checkout"
          ? other
          : scenario === "missing-receipt"
            ? `${root}/missing`
            : checkout;
      const f = yield* fixture;
      yield* Ref.set(f.acquisitionPath, claimed);
      yield* Effect.gen(function* () {
        const custody = yield* WorkspaceCustody.WorkspaceCustody;
        const journal = yield* Journal.WorkspaceCustody;
        const epoch = yield* custody.prepare({
          ownerRef: `identity:${scenario}`,
          projectRoot: root,
        });
        const result = yield* custody.acquireExisting(epoch.id, requested).pipe(Effect.result);
        if (scenario === "alias") {
          assert.equal(result._tag, "Success");
          assert.equal((yield* journal.get(epoch.id)).receipt?.path, checkout);
        } else {
          assert.equal(result._tag, "Failure");
          assert.equal((yield* journal.get(epoch.id)).receipt, null);
        }
      }).pipe(Effect.provide(f.layer));
    }).pipe(Effect.provide(NodeServices.layer)),
);
