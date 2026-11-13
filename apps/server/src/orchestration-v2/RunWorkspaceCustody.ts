import * as KeyedLock from "@t3tools/shared/KeyedLock";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

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
      obligation: Pick<Journal.CustodyObligation, "id" | "kind">,
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
    readonly recover: (
      runId: string,
      reason: string,
    ) => Effect.Effect<void, RunWorkspaceCustodyError>;
  }
>()("t3/orchestration-v2/RunWorkspaceCustody") {}

const make = Effect.gen(function* () {
  const custody = yield* Custody.WorkspaceCustody;
  const journal = yield* Journal.WorkspaceCustody;
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
  const finish = Effect.fn("RunWorkspaceCustody.finish")(function* (runId: string) {
    const claims = (yield* epochs(runId)).filter((epoch) => epoch.phase !== "released");
    if (claims.some((epoch) => epoch.obligations.some((item) => item.acknowledgement === null)))
      return yield* new RunWorkspaceCustodyError({
        runId,
        operation: "settle",
        cause: "Registered workspace obligations still require acknowledgement.",
      });
    yield* Effect.forEach(claims, (epoch) => custody.close(epoch.id), { discard: true });
    yield* Effect.forEach(claims, (epoch) => custody.releaseSettled(epoch.id), { discard: true });
  });
  return RunWorkspaceCustody.of({
    admit: Effect.fn("RunWorkspaceCustody.admit")(
      function* (input) {
        if ((yield* workspaces.resolve(input.projectRoot)) !== "slipjay") return;
        const canonical = yield* fs.realPath(path.resolve(input.workspacePath));
        const previous = yield* epochs(input.runId);
        const siblings = previous.filter((epoch) => epoch.phase !== "released");
        // Only a new admitted command can start another epoch after held-queue settlement.
        if (
          siblings.some((epoch) => epoch.phase !== "open") ||
          (previous.length > 0 && siblings.length === 0 && input.admissionId === undefined)
        )
          return yield* new RunWorkspaceCustodyError({
            runId: input.runId,
            operation: "admit",
            cause: "Run custody admission is closed.",
          });
        const pathKey = `${prefix(input.runId)}${encodeURIComponent(canonical)}:epoch:`;
        const matching = siblings.find((epoch) => epoch.ownerRef.startsWith(pathKey));
        if (matching?.receipt !== null && matching !== undefined && validated.has(matching.id))
          return;
        if (siblings[0] !== undefined)
          yield* custody.prepare({
            ownerRef: siblings[0].ownerRef,
            projectRoot: siblings[0].projectRoot,
          });
        const epoch = yield* custody.prepare({
          ownerRef: matching?.ownerRef ?? `${pathKey}${input.admissionId ?? "initial"}`,
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
        yield* Effect.forEach(
          previous.filter((epoch) => epoch.phase !== "released"),
          (epoch) => custody.register(epoch.id, obligation),
          { discard: true },
        );
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

export const layer = Layer.effect(RunWorkspaceCustody, make);
