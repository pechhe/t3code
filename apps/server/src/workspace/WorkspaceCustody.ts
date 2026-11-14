import * as FileSystem from "effect/FileSystem";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as Journal from "../persistence/WorkspaceCustody.ts";
import * as ProcessRunner from "../processRunner.ts";

const Capability = Schema.Struct({
  ok: Schema.Boolean,
  capability: Schema.Literals(["generation-bound-custody"]),
  protocol: Schema.Literals([1]),
  supported: Schema.Boolean,
  producerEntry: Schema.String,
});
const Activation = Schema.Struct({
  ok: Schema.Boolean,
  version: Schema.Literals([1]),
  activationId: Schema.String,
});
const Controller = Schema.Struct({
  ok: Schema.Boolean,
  controller: Schema.NullOr(
    Schema.Struct({
      platform: Schema.String,
      pid: Schema.Number,
      boot: Schema.String,
      start: Schema.String,
    }),
  ),
});
const Acquisition = Schema.Struct({
  ok: Schema.Boolean,
  version: Schema.Literals([1]),
  path: Schema.String,
  generation: Schema.String,
  claimId: Schema.String,
  ownerId: Schema.String,
});
const Release = Schema.Struct({
  ok: Schema.Boolean,
  version: Schema.Literals([1]),
  released: Schema.Boolean,
  generation: Schema.String,
  claimId: Schema.String,
});
const decodeAcquisition = Schema.decodeUnknownEffect(Acquisition);
const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown));
const encodeJson = Schema.encodeEffect(Schema.fromJsonString(Schema.Unknown));

export class WorkspaceCustodyError extends Schema.TaggedError<WorkspaceCustodyError>()(
  "WorkspaceCustodyError",
  {
    stage: Schema.Literals([
      "capability",
      "activation",
      "controller",
      "transport",
      "reply",
      "journal",
      "settlement",
    ]),
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Workspace custody could not be established or settled (${this.stage}); source protection requires recovery.`;
  }
}

export class ControllerPid extends Context.Reference<number>(
  "t3/workspace/WorkspaceCustody/ControllerPid",
  {
    defaultValue: () => process.pid,
  },
) {}

export class WorkspaceCustody extends Context.Service<
  WorkspaceCustody,
  {
    readonly prepare: (input: {
      readonly ownerRef: string;
      readonly projectRoot: string;
    }) => Effect.Effect<Journal.CustodyEpoch, WorkspaceCustodyError>;
    readonly allocationInput: (
      id: string,
    ) => Effect.Effect<
      { readonly producerEntry: string; readonly stdin: Redacted.Redacted<string> },
      WorkspaceCustodyError
    >;
    readonly acquired: (
      id: string,
      receipt: unknown,
      expectedPath: string,
    ) => Effect.Effect<string, WorkspaceCustodyError>;
    readonly acquireExisting: (
      id: string,
      path: string,
    ) => Effect.Effect<string, WorkspaceCustodyError>;
    readonly register: (
      id: string,
      obligation: Pick<Journal.CustodyObligation, "id" | "kind">,
    ) => Effect.Effect<void, WorkspaceCustodyError>;
    readonly acknowledge: (
      id: string,
      obligationId: string,
      evidenceRef: string,
    ) => Effect.Effect<void, WorkspaceCustodyError>;
    readonly close: (id: string) => Effect.Effect<void, WorkspaceCustodyError>;
    readonly releaseSettled: (id: string) => Effect.Effect<void, WorkspaceCustodyError>;
    readonly recover: (id: string, reason: string) => Effect.Effect<void, WorkspaceCustodyError>;
    readonly finishAllocation: (attemptId: string) => Effect.Effect<void, WorkspaceCustodyError>;
  }
>()("t3/workspace/WorkspaceCustody") {}

const make = Effect.gen(function* () {
  const journal = yield* Journal.WorkspaceCustody;
  const fs = yield* FileSystem.FileSystem;
  const processes = yield* ProcessRunner.ProcessRunner;
  const crypto = yield* SecureRandom.SecureRandom;
  const pid = yield* ControllerPid;
  const preparation = yield* Semaphore.make(1);

  const call = Effect.fn("WorkspaceCustody.call")(function* (input: {
    readonly projectRoot: string;
    readonly entry?: string;
    readonly args: ReadonlyArray<string>;
    readonly payload?: unknown;
  }) {
    const stdin =
      input.payload === undefined
        ? undefined
        : yield* encodeJson(input.payload).pipe(
            Effect.mapError((cause) => new WorkspaceCustodyError({ stage: "transport", cause })),
          );
    const output = yield* processes
      .run({
        command: input.entry === undefined ? "slipjay" : "bun",
        args: input.entry === undefined ? input.args : [input.entry, ...input.args],
        cwd: input.projectRoot,
        ...(stdin === undefined ? {} : { stdin }),
        timeout: "30 seconds",
        maxOutputBytes: 64 * 1024,
      })
      .pipe(Effect.mapError((cause) => new WorkspaceCustodyError({ stage: "transport", cause })));
    if (output.code !== 0 || output.stdoutTruncated || output.stderrTruncated) {
      return yield* new WorkspaceCustodyError({
        stage: "transport",
        cause: "Custody producer refused or returned incomplete output.",
      });
    }
    return yield* decodeJson(output.stdout.trim()).pipe(
      Effect.mapError((cause) => new WorkspaceCustodyError({ stage: "reply", cause })),
    );
  });
  const get = Effect.fn("WorkspaceCustody.get")((id: string) =>
    journal
      .get(id)
      .pipe(Effect.mapError((cause) => new WorkspaceCustodyError({ stage: "journal", cause }))),
  );
  const claimPayload = (epoch: Journal.CustodyEpoch) => ({
    activationId: epoch.producer.activationId,
    requestId: `acquire:${epoch.id}`,
    ownerId: `custody:${epoch.id}`,
    credential: Redacted.value(epoch.credential),
    controller: epoch.producer.controller,
    obligationRef: `t3-custody:${epoch.id}`,
  });
  const acquired = Effect.fn("WorkspaceCustody.acquired")(function* (
    id: string,
    raw: unknown,
    expectedPath: string,
  ) {
    const receipt = yield* decodeAcquisition(raw).pipe(
      Effect.mapError((cause) => new WorkspaceCustodyError({ stage: "reply", cause })),
    );
    if (!receipt.ok || receipt.ownerId !== `custody:${id}`) {
      return yield* new WorkspaceCustodyError({
        stage: "reply",
        cause: "Custody acquisition identity mismatch.",
      });
    }
    let canonicalPath = receipt.path;
    if (receipt.path !== expectedPath) {
      const paths = yield* Effect.all({
        claimed: fs.realPath(receipt.path),
        expected: fs.realPath(expectedPath),
      }).pipe(Effect.mapError((cause) => new WorkspaceCustodyError({ stage: "reply", cause })));
      if (paths.claimed !== paths.expected) {
        const workspace = yield* processes
          .run({
            command: "jj",
            args: ["root"],
            cwd: expectedPath,
            timeout: "30 seconds",
            maxOutputBytes: 4096,
          })
          .pipe(Effect.mapError((cause) => new WorkspaceCustodyError({ stage: "reply", cause })));
        if (workspace.code !== 0 || workspace.stdoutTruncated || workspace.stdout.trim() === "")
          return yield* new WorkspaceCustodyError({
            stage: "reply",
            cause: "Canonical checkout root could not be established.",
          });
        const canonicalWorkspaceRoot = yield* fs
          .realPath(workspace.stdout.trim())
          .pipe(Effect.mapError((cause) => new WorkspaceCustodyError({ stage: "reply", cause })));
        if (paths.claimed !== canonicalWorkspaceRoot)
          return yield* new WorkspaceCustodyError({
            stage: "reply",
            cause: "Custody acquisition path mismatch.",
          });
      }
      canonicalPath = paths.claimed;
    }
    yield* journal
      .acquired(id, {
        path: canonicalPath,
        generation: receipt.generation,
        claimId: receipt.claimId,
      })
      .pipe(Effect.mapError((cause) => new WorkspaceCustodyError({ stage: "journal", cause })));
    return canonicalPath;
  });
  const releaseSettled = Effect.fn("WorkspaceCustody.releaseSettled")(function* (id: string) {
    const previous = yield* get(id);
    if (previous.phase === "released" && previous.settlementRef === `t3-settlement:${id}`) return;
    const epoch = yield* journal
      .requireSettled(id)
      .pipe(Effect.mapError((cause) => new WorkspaceCustodyError({ stage: "settlement", cause })));
    const receipt = epoch.receipt!;
    const settlementRef = `t3-settlement:${id}`;
    const reply = yield* call({
      projectRoot: epoch.projectRoot,
      entry: epoch.producer.entry,
      args: ["claims", "release", receipt.path],
      payload: {
        activationId: epoch.producer.activationId,
        requestId: `release:${id}`,
        generation: receipt.generation,
        claimId: receipt.claimId,
        credential: Redacted.value(epoch.credential),
        settlementRef,
      },
    }).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Release)),
      Effect.mapError((cause) => new WorkspaceCustodyError({ stage: "reply", cause })),
    );
    if (
      !reply.ok ||
      !reply.released ||
      reply.generation !== receipt.generation ||
      reply.claimId !== receipt.claimId
    )
      return yield* new WorkspaceCustodyError({
        stage: "reply",
        cause: "Custody release identity mismatch.",
      });
    yield* journal
      .released(id, settlementRef)
      .pipe(Effect.mapError((cause) => new WorkspaceCustodyError({ stage: "journal", cause })));
  });
  return WorkspaceCustody.of({
    prepare: Effect.fn("WorkspaceCustody.prepare")((input) =>
      Effect.gen(function* () {
        const existing = yield* journal
          .forOwner(input.ownerRef)
          .pipe(Effect.mapError((cause) => new WorkspaceCustodyError({ stage: "journal", cause })));
        if (existing !== null) {
          if (existing.projectRoot !== input.projectRoot || existing.phase !== "open") {
            return yield* new WorkspaceCustodyError({
              stage: "journal",
              cause: "Custody epoch is closed or belongs to a different project.",
            });
          }
          const current = yield* call({
            projectRoot: input.projectRoot,
            entry: existing.producer.entry,
            args: ["claims", "controller", String(pid)],
          }).pipe(
            Effect.flatMap(Schema.decodeUnknownEffect(Controller)),
            Effect.mapError((cause) => new WorkspaceCustodyError({ stage: "controller", cause })),
          );
          const previous = existing.producer.controller;
          if (
            !current.ok ||
            current.controller === null ||
            previous === null ||
            current.controller.pid !== previous.pid ||
            current.controller.platform !== previous.platform ||
            current.controller.boot !== previous.boot ||
            current.controller.start !== previous.start
          ) {
            yield* journal
              .recover(existing.id, "controller-changed")
              .pipe(
                Effect.mapError((cause) => new WorkspaceCustodyError({ stage: "journal", cause })),
              );
            return yield* new WorkspaceCustodyError({
              stage: "controller",
              cause: "Previous custody requires acknowledged transfer or settlement.",
            });
          }
          return existing;
        }
        const capability = yield* call({
          projectRoot: input.projectRoot,
          args: ["claims", "capability"],
        }).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Capability)),
          Effect.mapError((cause) => new WorkspaceCustodyError({ stage: "capability", cause })),
        );
        if (!capability.ok || !capability.supported || !capability.producerEntry) {
          return yield* new WorkspaceCustodyError({
            stage: "capability",
            cause: "Compatible custody producer is required.",
          });
        }
        const activation = yield* call({
          projectRoot: input.projectRoot,
          entry: capability.producerEntry,
          args: ["claims", "activate"],
        }).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Activation)),
          Effect.mapError((cause) => new WorkspaceCustodyError({ stage: "activation", cause })),
        );
        const identity = yield* call({
          projectRoot: input.projectRoot,
          entry: capability.producerEntry,
          args: ["claims", "controller", String(pid)],
        }).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Controller)),
          Effect.mapError((cause) => new WorkspaceCustodyError({ stage: "controller", cause })),
        );
        if (!activation.ok || !identity.ok || identity.controller === null) {
          return yield* new WorkspaceCustodyError({
            stage: "activation",
            cause: "Custody activation or controller identity unavailable.",
          });
        }
        const id = yield* crypto
          .uuidV4()
          .pipe(Effect.mapError((cause) => new WorkspaceCustodyError({ stage: "journal", cause })));
        const secret = yield* crypto
          .uuidV4()
          .pipe(Effect.mapError((cause) => new WorkspaceCustodyError({ stage: "journal", cause })));
        return yield* journal
          .reserve({
            ...input,
            id,
            credential: Redacted.make(`${id}:${secret}`),
            producer: {
              entry: capability.producerEntry,
              activationId: activation.activationId,
              controller: identity.controller,
            },
          })
          .pipe(Effect.mapError((cause) => new WorkspaceCustodyError({ stage: "journal", cause })));
      }).pipe(preparation.withPermits(1)),
    ),
    allocationInput: Effect.fn("WorkspaceCustody.allocationInput")(function* (id) {
      const epoch = yield* get(id);
      if (epoch.phase !== "open")
        return yield* new WorkspaceCustodyError({
          stage: "journal",
          cause: "Custody admission is closed.",
        });
      const stdin = yield* encodeJson(claimPayload(epoch)).pipe(
        Effect.mapError((cause) => new WorkspaceCustodyError({ stage: "journal", cause })),
      );
      return { producerEntry: epoch.producer.entry, stdin: Redacted.make(stdin) };
    }),
    acquired,
    acquireExisting: Effect.fn("WorkspaceCustody.acquireExisting")(function* (id, path) {
      const epoch = yield* get(id);
      if (epoch.phase !== "open")
        return yield* new WorkspaceCustodyError({
          stage: "journal",
          cause: "Custody admission is closed.",
        });
      const receipt = yield* call({
        projectRoot: epoch.projectRoot,
        entry: epoch.producer.entry,
        args: ["claims", "acquire", path],
        payload: claimPayload(epoch),
      });
      return yield* acquired(id, receipt, path);
    }),
    register: Effect.fn("WorkspaceCustody.register")((id, obligation) =>
      journal
        .register(id, obligation)
        .pipe(Effect.mapError((cause) => new WorkspaceCustodyError({ stage: "journal", cause }))),
    ),
    acknowledge: Effect.fn("WorkspaceCustody.acknowledge")((id, obligationId, evidenceRef) =>
      journal
        .acknowledge(id, obligationId, evidenceRef)
        .pipe(Effect.mapError((cause) => new WorkspaceCustodyError({ stage: "journal", cause }))),
    ),
    close: Effect.fn("WorkspaceCustody.close")((id) =>
      journal
        .close(id)
        .pipe(Effect.mapError((cause) => new WorkspaceCustodyError({ stage: "journal", cause }))),
    ),
    releaseSettled,
    finishAllocation: Effect.fn("WorkspaceCustody.finishAllocation")(function* (attemptId) {
      const epoch = yield* journal
        .forOwner(`allocation:${attemptId}`)
        .pipe(Effect.mapError((cause) => new WorkspaceCustodyError({ stage: "journal", cause })));
      if (epoch === null || epoch.phase === "released") return;
      if (epoch.receipt === null) {
        yield* journal
          .recover(epoch.id, "allocation-receipt-unavailable")
          .pipe(Effect.mapError((cause) => new WorkspaceCustodyError({ stage: "journal", cause })));
        return;
      }
      const current = yield* call({
        projectRoot: epoch.projectRoot,
        entry: epoch.producer.entry,
        args: ["claims", "controller", String(pid)],
      }).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(Controller)),
        Effect.mapError((cause) => new WorkspaceCustodyError({ stage: "controller", cause })),
      );
      const previous = epoch.producer.controller;
      if (
        !current.ok ||
        current.controller === null ||
        previous === null ||
        current.controller.pid !== previous.pid ||
        current.controller.boot !== previous.boot ||
        current.controller.start !== previous.start ||
        current.controller.platform !== previous.platform
      ) {
        yield* journal
          .recover(epoch.id, "allocation-controller-changed")
          .pipe(Effect.mapError((cause) => new WorkspaceCustodyError({ stage: "journal", cause })));
        return yield* new WorkspaceCustodyError({
          stage: "controller",
          cause: "Allocation needs evidence-backed recovery.",
        });
      }
      yield* journal
        .acknowledge(
          epoch.id,
          `allocation:${attemptId}`,
          `allocation-bound-or-returned:${attemptId}`,
        )
        .pipe(Effect.mapError((cause) => new WorkspaceCustodyError({ stage: "journal", cause })));
      yield* journal
        .close(epoch.id)
        .pipe(Effect.mapError((cause) => new WorkspaceCustodyError({ stage: "journal", cause })));
      yield* releaseSettled(epoch.id);
    }),
    recover: Effect.fn("WorkspaceCustody.recover")(function* (id, reason) {
      yield* journal
        .recover(id, reason)
        .pipe(Effect.mapError((cause) => new WorkspaceCustodyError({ stage: "journal", cause })));
      const epoch = yield* get(id);
      if (epoch.receipt === null) return;
      yield* call({
        projectRoot: epoch.projectRoot,
        entry: epoch.producer.entry,
        args: ["claims", "recover", epoch.receipt.path],
        payload: {
          activationId: epoch.producer.activationId,
          requestId: `recover:${id}:${reason}`,
          generation: epoch.receipt.generation,
          claimId: epoch.receipt.claimId,
          credential: Redacted.value(epoch.credential),
          reason,
        },
      }).pipe(Effect.asVoid);
    }),
  });
});

export const layer = Layer.effect(WorkspaceCustody, make).pipe(Layer.provide(Journal.layer));
