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

it.effect.each([
  "alias",
  "monorepo-subdirectory",
  "ancestor-mismatch",
  "different-checkout",
  "missing-requested",
  "missing-receipt",
] as const)("validates existing custody by filesystem identity: %s", (scenario) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
    const checkout = `${root}/checkout`;
    const alias = `${root}/alias`;
    const other = `${root}/other`;
    yield* fs.makeDirectory(checkout);
    yield* fs.makeDirectory(`${checkout}/apps/weave`, { recursive: true });
    yield* fs.makeDirectory(other);
    yield* fs.symlink(checkout, alias);
    const requested =
      scenario === "missing-requested"
        ? `${root}/missing`
        : scenario === "monorepo-subdirectory" || scenario === "ancestor-mismatch"
          ? `${checkout}/apps/weave`
          : alias;
    const claimed =
      scenario === "ancestor-mismatch"
        ? root
        : scenario === "different-checkout"
          ? other
          : scenario === "missing-receipt"
            ? `${root}/missing`
            : checkout;
    const f = yield* fixture;
    yield* Ref.set(f.workspaceRoot, checkout);
    yield* Ref.set(f.acquisitionPath, claimed);
    yield* Effect.gen(function* () {
      const custody = yield* WorkspaceCustody.WorkspaceCustody;
      const journal = yield* Journal.WorkspaceCustody;
      const epoch = yield* custody.prepare({
        ownerRef: `identity:${scenario}`,
        projectRoot: root,
      });
      const result = yield* custody.acquireExisting(epoch.id, requested).pipe(Effect.result);
      if (scenario === "alias" || scenario === "monorepo-subdirectory") {
        assert.equal(result._tag, "Success");
        assert.equal((yield* journal.get(epoch.id)).receipt?.path, checkout);
      } else {
        assert.equal(result._tag, "Failure");
        assert.equal((yield* journal.get(epoch.id)).receipt, null);
      }
    }).pipe(Effect.provide(f.layer));
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect("retries proved release publication across refusal, lost reply and restart", () =>
  Effect.gen(function* () {
    const f = yield* fixture;
    yield* Effect.gen(function* () {
      const journal = yield* Journal.WorkspaceCustody;
      const epochs = yield* Effect.gen(function* () {
        const custody = yield* WorkspaceCustody.WorkspaceCustody;
        const ids = new Map<string, string>();
        for (const state of [
          "a-retry",
          "b-independent",
          "open",
          "unacknowledged",
          "recovery",
          "missing-receipt",
        ]) {
          const epoch = yield* custody.prepare({ ownerRef: state, projectRoot: "/source" });
          ids.set(state, epoch.id);
          yield* custody.register(epoch.id, { id: "provider", kind: "provider-turn" });
          if (state !== "missing-receipt")
            yield* custody.acquireExisting(epoch.id, "/source/" + state);
          if (state !== "unacknowledged")
            yield* custody.acknowledge(epoch.id, "provider", "observed-provider-stop");
          if (state !== "open") yield* custody.close(epoch.id);
          if (state === "recovery") yield* custody.recover(epoch.id, "unknown-original-worker");
        }
        yield* Ref.set(f.releaseRefusalClaim, `custody:${ids.get("a-retry")!}`);
        yield* Ref.set(f.releaseFailures, 2);
        assert.equal(
          (yield* custody.releaseSettled(ids.get("a-retry")!).pipe(Effect.result))._tag,
          "Failure",
        );
        yield* custody.reconcile;
        assert.equal((yield* journal.get(ids.get("a-retry")!)).phase, "closing");
        assert.equal((yield* journal.get(ids.get("b-independent")!)).phase, "released");
        yield* Ref.set(f.releaseLostReplies, 1);
        assert.equal(
          (yield* custody.releaseSettled(ids.get("a-retry")!).pipe(Effect.result))._tag,
          "Failure",
        );
        assert.equal((yield* journal.get(ids.get("a-retry")!)).phase, "closing");
        return ids;
      }).pipe(Effect.provide(WorkspaceCustody.layer));
      yield* Ref.set(f.controllerStart, "after-restart");
      yield* Effect.gen(function* () {
        const custody = yield* WorkspaceCustody.WorkspaceCustody;
        yield* custody.reconcile;
        assert.equal((yield* journal.get(epochs.get("a-retry")!)).phase, "released");
        assert.equal(yield* Ref.get(f.releases), 4);
        const requests = (yield* Ref.get(f.releaseRequests)).filter(
          (request) => request.claimId === `custody:${epochs.get("a-retry")!}`,
        );
        assert.equal(requests.length, 4);
        assert.isTrue(
          requests.every((request) => JSON.stringify(request) === JSON.stringify(requests[0])),
        );
        for (const [state, phase] of [
          ["open", "released"],
          ["unacknowledged", "recovery-required"],
          ["recovery", "released"],
          ["missing-receipt", "closing"],
        ] as const)
          assert.equal((yield* journal.get(epochs.get(state)!)).phase, phase);
      }).pipe(Effect.provide(WorkspaceCustody.layer));
    }).pipe(Effect.provide(f.dependencies));
  }),
);

it.effect(
  "a failed probe of this server's own identity leaves a live epoch open for registration",
  () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Effect.gen(function* () {
        const custody = yield* WorkspaceCustody.WorkspaceCustody;
        const journal = yield* Journal.WorkspaceCustody;
        const epoch = yield* custody.prepare({ ownerRef: "live", projectRoot: "/source" });
        yield* custody.acquireExisting(epoch.id, "/source/worktree");
        yield* custody.register(epoch.id, {
          id: "execution",
          kind: "provider-turn",
          processIds: [{ pid: 456 }],
        });
        yield* Ref.set(f.processStarts, new Map([[123, null]]));
        yield* custody.reconcile;
        assert.equal((yield* journal.get(epoch.id)).phase, "open");
        yield* Ref.set(f.processStarts, new Map());
        yield* custody.register(epoch.id, {
          id: "execution",
          kind: "provider-turn",
          processIds: [{ pid: 789 }],
        });
        assert.equal((yield* journal.get(epoch.id)).phase, "open");
        assert.equal(yield* Ref.get(f.releases), 0);
      }).pipe(Effect.provide(f.layer));
    }),
);

// Each scenario probes identities without signalling the provider, including shared runtimes.
it.effect.each([
  "absent",
  "replaced",
  "live",
  "unknown",
  "shared",
  "replacement",
  "capture-failed",
  "partial",
] as const)(
  "recovers controller-lost custody only with complete process-stop proof: %s",
  (scenario) =>
    Effect.gen(function* () {
      const f = yield* fixture;
      yield* Effect.gen(function* () {
        const custody = yield* WorkspaceCustody.WorkspaceCustody;
        const journal = yield* Journal.WorkspaceCustody;
        const epoch = yield* custody.prepare({ ownerRef: scenario, projectRoot: "/source" });
        yield* custody.acquireExisting(epoch.id, "/source/worktree");
        if (scenario === "capture-failed" || scenario === "partial")
          yield* Ref.set(f.processStarts, new Map([[456, null]]));
        yield* custody.register(epoch.id, {
          id: "execution",
          kind: "provider-turn",
          ...(scenario === "unknown"
            ? {}
            : { processIds: [{ pid: 456, shared: scenario === "shared" }] }),
        });
        if (scenario === "replacement" || scenario === "partial")
          yield* custody.register(epoch.id, {
            id: "execution",
            kind: "provider-turn",
            processIds: [{ pid: 789 }],
          });
        yield* Ref.set(f.controllerStart, "new-controller");
        yield* Ref.set(
          f.processStarts,
          new Map([
            [
              456,
              scenario === "live" || scenario === "shared"
                ? "first-start"
                : scenario === "replaced"
                  ? "reused-pid"
                  : null,
            ],
            [789, "first-start"],
          ]),
        );
        yield* custody.reconcile;
        const released = scenario === "absent" || scenario === "replaced";
        assert.equal(
          (yield* journal.get(epoch.id)).phase,
          released ? "released" : "recovery-required",
        );
        assert.equal(yield* Ref.get(f.releases), released ? 1 : 0);
        if (scenario === "replacement" || scenario === "shared") {
          yield* Ref.set(
            f.processStarts,
            new Map([
              [456, null],
              [789, null],
            ]),
          );
          yield* custody.reconcile;
          assert.equal((yield* journal.get(epoch.id)).phase, "released");
        }
        assert.isFalse((yield* Ref.get(f.argumentsUsed)).some((arg) => /kill|terminate/.test(arg)));
      }).pipe(Effect.provide(f.layer));
    }),
);
