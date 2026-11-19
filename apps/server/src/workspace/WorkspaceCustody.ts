import * as FileSystem from "effect/FileSystem";
import * as Context from "effect/Context";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
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
  ok: Schema.Literals([true]),
  version: Schema.Literals([1]),
  released: Schema.Boolean,
  generation: Schema.String,
  claimId: Schema.String,
});
const ReleaseRefusal = Schema.Struct({
  ok: Schema.Literals([false]),
  code: Schema.Literals(["CLAIM_NOT_FOUND", "CLAIM_GENERATION_MISMATCH", "CLAIM_ENDED"]),
});
const Refusal = Schema.Struct({
  ok: Schema.Literals([false]),
  code: Schema.String,
  reason: Schema.optional(Schema.String),
});
const ClaimStatus = Schema.Struct({
  ok: Schema.Literals([true]),
  version: Schema.Literals([1]),
  path: Schema.String,
  generation: Schema.NullOr(Schema.String),
  claims: Schema.Array(
    Schema.Struct({
      claimId: Schema.String,
      ownerId: Schema.String,
      obligationRef: Schema.String,
      generation: Schema.String,
      state: Schema.Literals(["active", "recovery-required", "released", "transferred"]),
    }),
  ),
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
      obligation: Pick<
        Journal.CustodyObligation,
        "id" | "kind" | "stopProcesses" | "stopIdentityUnknown"
      > & {
        readonly processIds?: ReadonlyArray<{ readonly pid: number; readonly shared?: boolean }>;
      },
    ) => Effect.Effect<void, WorkspaceCustodyError>;
    readonly acknowledge: (
      id: string,
      obligationId: string,
      evidenceRef: string,
    ) => Effect.Effect<void, WorkspaceCustodyError>;
    readonly close: (id: string) => Effect.Effect<void, WorkspaceCustodyError>;
    readonly releaseSettled: (id: string) => Effect.Effect<void, WorkspaceCustodyError>;
    readonly reconcile: Effect.Effect<void, WorkspaceCustodyError>;
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
  let installedEntry: string | null = null;

  const failure = Effect.fn("WorkspaceCustody.failure")(function* (
    output: ProcessRunner.ProcessRunOutput,
  ) {
    if (output.stdoutTruncated || output.stderrTruncated || output.stdoutInvalidUtf8)
      return "SlipJay custody call returned incomplete output.";
    // SlipJay never echoes request content or credentials in a refusal.
    const refusal = yield* decodeJson(output.stdout.trim()).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Refusal)),
      Effect.option,
    );
    if (Option.isSome(refusal))
      return `SlipJay refused workspace custody (${refusal.value.code})${refusal.value.reason ? `: ${refusal.value.reason}` : "."}`;
    const detail = output.stderr.trim().split("\n").at(-1)?.slice(0, 300);
    return `SlipJay custody call exited with code ${output.code}${detail ? `: ${detail}` : "."}`;
  });

  const call = Effect.fn("WorkspaceCustody.call")(function* (input: {
    readonly projectRoot: string;
    readonly entry?: string;
    readonly args: ReadonlyArray<string>;
    readonly payload?: unknown;
    readonly acceptReleaseRefusal?: boolean;
    readonly maxOutputBytes?: number;
  }) {
    const stdin =
      input.payload === undefined
        ? undefined
        : yield* encodeJson(input.payload).pipe(
            Effect.mapError((cause) => new WorkspaceCustodyError({ stage: "transport", cause })),
          );
    const entry =
      input.entry === undefined ? undefined : yield* producerEntry(input.projectRoot, input.entry);
    const output = yield* processes
      .run({
        command: entry === undefined ? "slipjay" : "bun",
        args: entry === undefined ? input.args : [entry, ...input.args],
        cwd: input.projectRoot,
        ...(stdin === undefined ? {} : { stdin }),
        timeout: "30 seconds",
        maxOutputBytes: input.maxOutputBytes ?? 64 * 1024,
      })
      .pipe(Effect.mapError((cause) => new WorkspaceCustodyError({ stage: "transport", cause })));
    if (
      input.acceptReleaseRefusal &&
      output.code === 1 &&
      !output.timedOut &&
      !output.stdoutTruncated &&
      !output.stderrTruncated &&
      !output.stdoutInvalidUtf8
    ) {
      const refusal = yield* decodeJson(output.stdout.trim()).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(ReleaseRefusal)),
        Effect.result,
      );
      if (refusal._tag === "Success") return refusal.success;
    }
    if (
      output.code !== 0 ||
      output.timedOut ||
      output.stdoutTruncated ||
      output.stderrTruncated ||
      output.stdoutInvalidUtf8
    ) {
      return yield* new WorkspaceCustodyError({
        stage: "transport",
        cause: yield* failure(output),
      });
    }
    return yield* decodeJson(output.stdout.trim()).pipe(
      Effect.mapError((cause) => new WorkspaceCustodyError({ stage: "reply", cause })),
    );
  });
  // SlipJay prunes old installs, but every install speaking this protocol shares the activation and
  // custody records, so an epoch recorded against a pruned one is served by the current install.
  const producerEntry = Effect.fn("WorkspaceCustody.producerEntry")(function* (
    projectRoot: string,
    recorded: string,
  ): Effect.fn.Return<string, WorkspaceCustodyError> {
    const present = (entry: string) => fs.exists(entry).pipe(Effect.orElseSucceed(() => false));
    if (yield* present(recorded)) return recorded;
    if (installedEntry !== null && (yield* present(installedEntry))) return installedEntry;
    const capability = yield* call({ projectRoot, args: ["claims", "capability"] }).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Capability)),
      Effect.mapError((cause) => new WorkspaceCustodyError({ stage: "capability", cause })),
    );
    if (!capability.ok || !capability.supported || !capability.producerEntry) return recorded;
    installedEntry = capability.producerEntry;
    return installedEntry;
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
      acceptReleaseRefusal: true,
      payload: {
        activationId: epoch.producer.activationId,
        requestId: `release:${id}`,
        generation: receipt.generation,
        claimId: receipt.claimId,
        credential: Redacted.value(epoch.credential),
        settlementRef,
      },
    }).pipe(
      Effect.flatMap(Schema.decodeUnknownEffect(Schema.Union([Release, ReleaseRefusal]))),
      Effect.mapError((cause) => new WorkspaceCustodyError({ stage: "reply", cause })),
    );
    if (!reply.ok) {
      const status = yield* call({
        projectRoot: epoch.projectRoot,
        entry: epoch.producer.entry,
        args: ["claims", "status", receipt.path],
        // Status includes every historical claim on a pooled checkout.
        maxOutputBytes: 4 * 1024 * 1024,
      }).pipe(
        Effect.flatMap(Schema.decodeUnknownEffect(ClaimStatus)),
        Effect.mapError((cause) => new WorkspaceCustodyError({ stage: "reply", cause })),
      );
      const former = status.claims.filter(
        (claim) => claim.generation === receipt.generation && claim.claimId === receipt.claimId,
      );
      const ended =
        former.length === 1 &&
        former.every(
          (claim) =>
            claim.ownerId === `custody:${id}` &&
            claim.obligationRef === `t3-custody:${id}` &&
            (claim.state === "released" || claim.state === "transferred"),
        );
      const generationGone =
        status.generation !== receipt.generation &&
        !status.claims.some((claim) => claim.generation === receipt.generation);
      if (status.path !== receipt.path || (!ended && !generationGone))
        return yield* new WorkspaceCustodyError({
          stage: "reply",
          cause: "Former custody claim has not been proved ended.",
        });
    } else if (
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
      return {
        producerEntry: yield* producerEntry(epoch.projectRoot, epoch.producer.entry),
        stdin: Redacted.make(stdin),
      };
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
    register: Effect.fn("WorkspaceCustody.register")(function* (id, obligation) {
      const epoch = yield* get(id);
      const identities = yield* Effect.forEach(obligation.processIds ?? [], (process) =>
        call({
          projectRoot: epoch.projectRoot,
          entry: epoch.producer.entry,
          args: ["claims", "controller", String(process.pid)],
        }).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Controller)),
          Effect.map((reply) =>
            reply.ok && reply.controller !== null && reply.controller.pid === process.pid
              ? { ...reply.controller, shared: process.shared }
              : null,
          ),
          Effect.orElseSucceed(() => null),
        ),
      );
      yield* journal
        .register(id, {
          id: obligation.id,
          kind: obligation.kind,
          stopProcesses: [
            ...(obligation.stopProcesses ?? []),
            ...identities.filter((identity) => identity !== null),
          ],
          stopIdentityUnknown:
            obligation.stopIdentityUnknown === true ||
            (obligation.processIds !== undefined &&
              (identities.length === 0 || identities.some((identity) => identity === null))),
        })
        .pipe(Effect.mapError((cause) => new WorkspaceCustodyError({ stage: "journal", cause })));
    }),
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
    reconcile: Effect.gen(function* () {
      const epochs = yield* journal.list.pipe(
        Effect.mapError((cause) => new WorkspaceCustodyError({ stage: "journal", cause })),
      );
      const identities = new Map<string, typeof Controller.Type>();
      const observe = Effect.fn("WorkspaceCustody.observeController")(function* (
        epoch: Journal.CustodyEpoch,
        processPid: number,
      ) {
        const key = `${epoch.producer.entry}:${processPid}`;
        const cached = identities.get(key);
        if (cached !== undefined) return cached;
        const observed = yield* call({
          projectRoot: epoch.projectRoot,
          entry: epoch.producer.entry,
          args: ["claims", "controller", String(processPid)],
        }).pipe(
          Effect.flatMap(Schema.decodeUnknownEffect(Controller)),
          Effect.mapError((cause) => new WorkspaceCustodyError({ stage: "controller", cause })),
        );
        identities.set(key, observed);
        return observed;
      });
      const same = (a: typeof Controller.Type.controller, b: typeof Controller.Type.controller) =>
        a !== null &&
        b !== null &&
        a.pid === b.pid &&
        a.platform === b.platform &&
        a.boot === b.boot &&
        a.start === b.start;
      for (const epoch of epochs) {
        if (epoch.phase === "released" || epoch.receipt === null) continue;
        yield* Effect.gen(function* () {
          const current = yield* observe(epoch, pid);
          // Without this server's own identity nothing is proved either way; never demote an epoch,
          // which could be this server's live run, on a failed probe. SlipJay's claim keeps it retained.
          if (!current.ok || current.controller === null) return;
          if (epoch.producer.controller === null) {
            yield* journal
              .recover(epoch.id, "controller-identity-unrecorded")
              .pipe(
                Effect.mapError((cause) => new WorkspaceCustodyError({ stage: "journal", cause })),
              );
            return;
          }
          if (!same(current.controller, epoch.producer.controller)) {
            if (epoch.producer.controller !== null) {
              const original = yield* observe(epoch, epoch.producer.controller.pid);
              if (!original.ok || same(original.controller, epoch.producer.controller)) return;
            }
            let reason: string | null = null;
            for (const obligation of epoch.obligations) {
              if (obligation.acknowledgement !== null) continue;
              // Admission records no process at all, because nothing is ever launched under it: it
              // holds only the claim that admission needed. Requiring a stop identity would retain
              // such an epoch for ever once its controller is gone. Every other kind can outlive the
              // server, so it still needs proof that its processes stopped.
              if (obligation.kind === "allocation") {
                yield* journal
                  .acknowledge(
                    epoch.id,
                    obligation.id,
                    `controller-gone-allocation:${epoch.producer.controller.pid}`,
                  )
                  .pipe(
                    Effect.mapError(
                      (cause) => new WorkspaceCustodyError({ stage: "journal", cause }),
                    ),
                  );
                continue;
              }
              if (obligation.stopIdentityUnknown || (obligation.stopProcesses ?? []).length === 0) {
                reason = `stop-identity-unrecorded:${obligation.id}`;
                continue;
              }
              let stopped = true;
              for (const identity of obligation.stopProcesses ?? []) {
                const observed = yield* observe(epoch, identity.pid);
                if (!observed.ok || same(observed.controller, identity)) {
                  stopped = false;
                  reason = `process-stop-unproved:${obligation.id}:${identity.pid}`;
                }
              }
              if (stopped)
                yield* journal
                  .acknowledge(
                    epoch.id,
                    obligation.id,
                    `process-stop-proved:${(obligation.stopProcesses ?? []).map((identity) => `${identity.platform}:${identity.boot}:${identity.pid}:${identity.start}`).join(",")}`,
                  )
                  .pipe(
                    Effect.mapError(
                      (cause) => new WorkspaceCustodyError({ stage: "journal", cause }),
                    ),
                  );
            }
            if (reason !== null) {
              // Every pass re-derives the reason; write only when it changes.
              if (epoch.phase !== "recovery-required" || epoch.recoveryReason !== reason)
                yield* journal
                  .recover(epoch.id, reason)
                  .pipe(
                    Effect.mapError(
                      (cause) => new WorkspaceCustodyError({ stage: "journal", cause }),
                    ),
                  );
              return;
            }
            yield* journal
              .close(epoch.id)
              .pipe(
                Effect.mapError((cause) => new WorkspaceCustodyError({ stage: "journal", cause })),
              );
          }
          const settled = yield* get(epoch.id);
          if (
            settled.phase === "closing" &&
            settled.obligations.every((item) => item.acknowledgement !== null)
          )
            yield* releaseSettled(epoch.id).pipe(
              Effect.catch((error) =>
                Effect.logWarning("Workspace custody release publication remains pending", {
                  epochId: epoch.id,
                  stage: error.stage,
                }),
              ),
            );
        }).pipe(
          // A failed probe or publication proves nothing and changes nothing: live epochs must stay
          // open for registration, and lost ones stay retained by their SlipJay claim until a later pass.
          Effect.catch((error) =>
            Effect.logWarning("Workspace custody recovery remains pending", {
              epochId: epoch.id,
              stage: error.stage,
            }),
          ),
        );
      }
    }).pipe(Effect.withSpan("WorkspaceCustody.reconcile")),
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
