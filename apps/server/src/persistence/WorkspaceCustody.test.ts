import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";

import * as Sqlite from "./Sqlite.ts";
import * as WorkspaceCustody from "./WorkspaceCustody.ts";

const testLayer = WorkspaceCustody.layer.pipe(
  Layer.provide(Sqlite.layerMemory),
  Layer.provide(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);
const producer = {
  entry: "/producer/workspace.ts",
  activationId: "activation-one",
  controller: null,
};

it.effect("closes admission before releasing only an acknowledged obligation set", () =>
  Effect.gen(function* () {
    const custody = yield* WorkspaceCustody.WorkspaceCustody;
    const credential = Redacted.make("private-claim-credential");
    const request = {
      id: "epoch-one",
      ownerRef: "run-one-attempt-one",
      projectRoot: "/source",
      credential,
      producer,
    };
    yield* custody.reserve(request);
    yield* custody.acquired(request.id, {
      path: "/source/worktree",
      generation: "allocation-one",
      claimId: "claim-one",
    });
    yield* custody.register(request.id, { id: "turn-one", kind: "provider-turn" });
    yield* custody.register(request.id, { id: "checkpoint-one", kind: "checkpoint" });
    yield* custody.acknowledge(request.id, "turn-one", "provider-terminal-event-one");
    yield* custody.close(request.id);
    const late = yield* custody
      .register(request.id, { id: "child-late", kind: "child" })
      .pipe(Effect.result);
    assert.isTrue(late._tag === "Failure");
    const unsettled = yield* custody.requireSettled(request.id).pipe(Effect.result);
    assert.isTrue(unsettled._tag === "Failure");
    yield* custody.acknowledge(request.id, "checkpoint-one", "checkpoint-persisted-one");
    const closed = yield* custody.requireSettled(request.id);
    assert.equal(closed.obligations.length, 2);
    yield* custody.released(request.id, "settlement-one");
    yield* custody.released(request.id, "settlement-one");
    const stored = yield* custody.get(request.id);
    assert.equal(stored.phase, "released");
    assert.equal(stored.settlementRef, "settlement-one");
    assert.isFalse(JSON.stringify(stored).includes("private-claim-credential"));
    const reopened = yield* custody.reserve(request).pipe(Effect.result);
    assert.isTrue(reopened._tag === "Failure");
  }).pipe(Effect.provide(testLayer)),
);

it.effect("preserves unknown custody and rejects changed identity on replay", () =>
  Effect.gen(function* () {
    const custody = yield* WorkspaceCustody.WorkspaceCustody;
    const request = {
      id: "epoch-unknown",
      ownerRef: "run-unknown",
      projectRoot: "/source",
      credential: Redacted.make("private-request"),
      producer,
    };
    const reserved = yield* custody.reserve(request);
    assert.equal((yield* custody.reserve(request)).id, reserved.id);
    const changed = yield* custody
      .reserve({ ...request, credential: Redacted.make("different") })
      .pipe(Effect.result);
    assert.isTrue(changed._tag === "Failure");
    yield* custody.acquired(request.id, {
      path: "/source/recovery",
      generation: "recovery-allocation",
      claimId: "recovery-claim",
    });
    yield* custody.register(request.id, { id: "provider-survivor", kind: "provider-turn" });
    yield* custody.recover(request.id, "adapter-unavailable");
    const stored = yield* custody.get(request.id);
    assert.equal(stored.phase, "recovery-required");
    assert.equal(stored.recoveryReason, "adapter-unavailable");
    assert.equal(stored.obligations[0]?.acknowledgement, null);
    const release = yield* custody
      .released(request.id, "logical-cancellation-only")
      .pipe(Effect.result);
    assert.isTrue(release._tag === "Failure");
    assert.equal((yield* custody.list).length, 1);
    assert.equal((yield* custody.get(request.id)).phase, "recovery-required");
    const prematureClosure = yield* custody.close(request.id).pipe(Effect.result);
    assert.isTrue(prematureClosure._tag === "Failure");
    yield* custody.acknowledge(request.id, "provider-survivor", "provider-stop-acknowledgement");
    yield* custody.close(request.id);
    yield* custody.released(request.id, "closed-recovery-proof");
    assert.equal((yield* custody.get(request.id)).phase, "released");
  }).pipe(Effect.provide(testLayer)),
);
