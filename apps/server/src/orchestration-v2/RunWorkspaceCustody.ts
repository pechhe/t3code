import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

import { isOrchestrationV2DeliverySettled, NodeId } from "@t3tools/contracts";
import * as ProjectionStore from "./ProjectionStore.ts";
import * as Journal from "../persistence/WorkspaceCustody.ts";
import * as WorkspaceProvider from "../project/WorkspaceProvider.ts";
import * as Custody from "../workspace/WorkspaceCustody.ts";

export class RunWorkspaceCustodyError extends Schema.TaggedError<RunWorkspaceCustodyError>()(
  "RunWorkspaceCustodyError",
  {
    runId: Schema.String,
    operation: Schema.Literals(["admit", "register", "acknowledge", "settle", "recover"]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Run workspace custody could not ${this.operation}; protection is retained until settlement.`;
  }
}

export class RunWorkspaceCustody extends Context.Service<
  RunWorkspaceCustody,
  {
    readonly admit: (input: {
      readonly runId: string;
      readonly projectRoot: string;
      readonly workspacePath: string;
      readonly admissionId?: string;
    }) => Effect.Effect<void, RunWorkspaceCustodyError>;
    readonly register: (
      runId: string,
      obligation: Parameters<Custody.WorkspaceCustody["Service"]["register"]>[1],
    ) => Effect.Effect<void, RunWorkspaceCustodyError>;
    readonly acknowledge: (
      runId: string,
      obligationId: string,
      evidenceRef: string,
    ) => Effect.Effect<void, RunWorkspaceCustodyError>;
    readonly settle: (runId: string) => Effect.Effect<void, RunWorkspaceCustodyError>;
    readonly endAdmission: (
      runId: string,
      evidenceRef: string,
    ) => Effect.Effect<void, RunWorkspaceCustodyError>;
    readonly reconcileDeliveries: Effect.Effect<void, RunWorkspaceCustodyError>;
    readonly recover: (
      runId: string,
      reason: string,
    ) => Effect.Effect<void, RunWorkspaceCustodyError>;
  }
>()("t3/orchestration-v2/RunWorkspaceCustody") {}

const make = Effect.gen(function* () {
  const custody = yield* Custody.WorkspaceCustody;
  const journal = yield* Journal.WorkspaceCustody;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const workspaces = yield* WorkspaceProvider.WorkspaceProvider;
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const locks = yield* KeyedLock.make<string>();
  const validated = new Set<string>();
  const prefix = (runId: string) => `run:${runId}:workspace:`;
  const epochs = Effect.fn("RunWorkspaceCustody.epochs")((runId: string) =>
    journal.forScope(prefix(runId)),
  );
  const mapError = (runId: string, operation: RunWorkspaceCustodyError["operation"]) =>
    Effect.mapError((cause: unknown) => new RunWorkspaceCustodyError({ runId, operation, cause }));
  const closeSettled = Effect.fn("RunWorkspaceCustody.closeSettled")(function* (runId: string) {
    const claims = (yield* epochs(runId)).filter((epoch) => epoch.phase !== "released");
    if (claims.some((epoch) => epoch.obligations.some((item) => item.acknowledgement === null)))
      return yield* new RunWorkspaceCustodyError({
        runId,
        operation: "settle",
        cause: "Registered workspace obligations still require acknowledgement.",
      });
    yield* Effect.forEach(claims, (epoch) => custody.close(epoch.id), { discard: true });
    return claims;
  });
  const finish = Effect.fn("RunWorkspaceCustody.finish")(function* (runId: string) {
    const claims = yield* closeSettled(runId);
    yield* Effect.forEach(claims, (epoch) => custody.releaseSettled(epoch.id), { discard: true });
  });
  return RunWorkspaceCustody.of({
    admit: Effect.fn("RunWorkspaceCustody.admit")(
      function* (input) {
        if ((yield* workspaces.resolve(input.projectRoot)) !== "slipjay") return;
        const canonical = yield* fs.realPath(path.resolve(input.workspacePath));
        const closed = new RunWorkspaceCustodyError({
          runId: input.runId,
          operation: "admit",
          cause: "Run custody admission is closed.",
        });
        const previous = yield* epochs(input.runId);
        let siblings = previous.filter((epoch) => epoch.phase !== "released");
        if (siblings.some((epoch) => epoch.phase === "closing")) return yield* closed;
        // Only a new admitted command can start another epoch after held-queue settlement.
        if (previous.length > 0 && siblings.length === 0 && input.admissionId === undefined)
          return yield* closed;
        const pathKey = `${prefix(input.runId)}${encodeURIComponent(canonical)}:epoch:`;
        const validatedMatch = siblings.find(
          (epoch) =>
            epoch.phase === "open" &&
            epoch.ownerRef.startsWith(pathKey) &&
            epoch.receipt !== null &&
            validated.has(epoch.id),
        );
        if (validatedMatch !== undefined) return;
        // prepare moves an epoch whose server process has gone to recovery-required; any other failure stands.
        for (const sibling of siblings)
          if (sibling.phase === "open")
            yield* custody
              .prepare({ ownerRef: sibling.ownerRef, projectRoot: sibling.projectRoot })
              .pipe(
                Effect.catch((error) =>
                  journal
                    .get(sibling.id)
                    .pipe(
                      Effect.flatMap((epoch) =>
                        epoch.phase === "recovery-required" ? Effect.void : Effect.fail(error),
                      ),
                    ),
                ),
              );
        siblings = (yield* epochs(input.runId)).filter((epoch) => epoch.phase !== "released");
        const retained = siblings.filter((epoch) => epoch.phase !== "open");
        // Work a lost server left unproved blocks the owner. An undelivered result does not, as this
        // server delivers it, and neither does an admission no work ever started under.
        if (
          retained.length > 0 &&
          (input.admissionId === undefined ||
            retained.some((epoch) =>
              epoch.obligations.some(
                (item) =>
                  item.acknowledgement === null &&
                  item.kind !== "delivery" &&
                  item.kind !== "allocation",
              ),
            ))
        )
          return yield* closed;
        const matching = siblings.find(
          (epoch) => epoch.phase === "open" && epoch.ownerRef.startsWith(pathKey),
        );
        const fresh = `${pathKey}${input.admissionId ?? "initial"}`;
        const taken = new Set(retained.map((epoch) => epoch.ownerRef));
        let ownerRef = matching?.ownerRef ?? fresh;
        // A retried command can find its own epoch already retained.
        for (let retry = 2; matching === undefined && taken.has(ownerRef); retry++)
          ownerRef = `${fresh}:${retry}`;
        const epoch = yield* custody.prepare({
          ownerRef,
          projectRoot: matching?.projectRoot ?? input.projectRoot,
        });
        const known = new Map(
          siblings.flatMap((sibling) =>
            sibling.obligations.map((obligation) => [obligation.id, obligation] as const),
          ),
        );
        if (known.size === 0)
          known.set("admission", { id: "admission", kind: "allocation", acknowledgement: null });
        for (const obligation of known.values()) {
          yield* custody.register(epoch.id, obligation);
          if (obligation.acknowledgement !== null)
            yield* custody.acknowledge(epoch.id, obligation.id, obligation.acknowledgement);
        }
        yield* custody.acquireExisting(epoch.id, canonical);
        validated.add(epoch.id);
      },
      (effect, input) => locks.withLock(input.runId, effect).pipe(mapError(input.runId, "admit")),
    ),
    register: Effect.fn("RunWorkspaceCustody.register")(
      function* (runId, obligation) {
        const previous = yield* epochs(runId);
        if (previous.length > 0 && previous.every((epoch) => epoch.phase === "released"))
          return yield* new RunWorkspaceCustodyError({
            runId,
            operation: "register",
            cause: "Run custody admission is closed.",
          });
        // A retained epoch takes no new obligations; an open epoch beside it carries the owner's.
        const targets = previous.filter(
          (epoch) => epoch.phase !== "released" && epoch.phase !== "recovery-required",
        );
        if (targets.length === 0 && previous.some((epoch) => epoch.phase === "recovery-required"))
          return yield* new RunWorkspaceCustodyError({
            runId,
            operation: "register",
            cause: "Run custody admission is closed.",
          });
        yield* Effect.forEach(targets, (epoch) => custody.register(epoch.id, obligation), {
          discard: true,
        });
      },
      (effect, runId) => locks.withLock(runId, effect).pipe(mapError(runId, "register")),
    ),
    acknowledge: Effect.fn("RunWorkspaceCustody.acknowledge")(
      function* (runId, obligationId, evidenceRef) {
        yield* Effect.forEach(
          (yield* epochs(runId)).filter(
            (epoch) =>
              epoch.phase !== "released" &&
              epoch.obligations.some((item) => item.id === obligationId),
          ),
          (epoch) => custody.acknowledge(epoch.id, obligationId, evidenceRef),
          { discard: true },
        );
      },
      (effect, runId) => locks.withLock(runId, effect).pipe(mapError(runId, "acknowledge")),
    ),
    settle: Effect.fn("RunWorkspaceCustody.settle")(
      (runId) => finish(runId),
      (effect, runId) => locks.withLock(runId, effect).pipe(mapError(runId, "settle")),
    ),
    endAdmission: Effect.fn("RunWorkspaceCustody.endAdmission")(
      function* (runId, evidenceRef) {
        const claims = (yield* epochs(runId)).filter((epoch) => epoch.phase !== "released");
        if (
          claims.some((epoch) =>
            epoch.obligations.some(
              (item) => item.kind !== "allocation" && item.kind !== "delivery",
            ),
          )
        )
          return;
        yield* Effect.forEach(
          claims,
          (epoch) =>
            Effect.gen(function* () {
              yield* custody.acknowledge(epoch.id, "admission", evidenceRef);
              for (const obligation of epoch.obligations)
                if (obligation.kind === "delivery" && obligation.acknowledgement === null)
                  yield* custody.acknowledge(epoch.id, obligation.id, evidenceRef);
            }),
          { discard: true },
        );
        yield* finish(runId);
      },
      (effect, runId) => locks.withLock(runId, effect).pipe(mapError(runId, "settle")),
    ),
    reconcileDeliveries: Effect.gen(function* () {
      const pending = yield* journal.forScope("run:delivery:");
      const taskIds = new Set<string>();
      for (const epoch of pending) {
        if (epoch.phase === "released") continue;
        const admission = epoch.obligations.find((item) => item.id === "admission");
        const acknowledgement = admission?.acknowledgement;
        if (!acknowledgement?.startsWith("delivery-registered:")) continue;
        const taskId = acknowledgement.slice("delivery-registered:".length);
        if (
          epoch.ownerRef.startsWith(prefix(`delivery:${taskId}`)) &&
          epoch.obligations.some((item) => item.id === "delivery" && item.kind === "delivery")
        )
          taskIds.add(taskId);
      }
      for (const taskId of taskIds) {
        const owner = `delivery:${taskId}`;
        yield* locks
          .withLock(
            owner,
            Effect.gen(function* () {
              const task = yield* projections.getSubagent(NodeId.make(taskId));
              if (task?.origin !== "app_owned" || !isOrchestrationV2DeliverySettled(task)) return;
              for (const epoch of yield* epochs(owner))
                for (const obligation of epoch.obligations)
                  if (
                    epoch.phase !== "released" &&
                    obligation.id === "delivery" &&
                    obligation.kind === "delivery" &&
                    obligation.acknowledgement === null
                  )
                    yield* custody.acknowledge(
                      epoch.id,
                      obligation.id,
                      `delivery-settled:${taskId}`,
                    );
              // The existing background reconciler publishes releases without delaying command readiness.
              yield* closeSettled(owner);
            }),
          )
          .pipe(
            mapError(owner, "settle"),
            Effect.catch((error) =>
              Effect.logWarning("Delegated delivery custody settlement remains pending", {
                runId: owner,
                operation: error.operation,
              }),
            ),
          );
      }
    }).pipe(
      mapError("delivery-recovery", "settle"),
      Effect.withSpan("RunWorkspaceCustody.reconcileDeliveries"),
    ),
    recover: Effect.fn("RunWorkspaceCustody.recover")(
      function* (runId, reason) {
        yield* Effect.forEach(
          (yield* epochs(runId)).filter((epoch) => epoch.phase !== "released"),
          (epoch) => custody.recover(epoch.id, reason),
          { discard: true },
        );
      },
      (effect, runId) => locks.withLock(runId, effect).pipe(mapError(runId, "recover")),
    ),
  });
});

export const layer = Layer.effect(RunWorkspaceCustody, make).pipe(
  Layer.provide(ProjectionStore.layer),
);
