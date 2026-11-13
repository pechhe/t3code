import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Redacted from "effect/Redacted";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { PersistenceSqlError, toPersistenceSqlError } from "./Errors.ts";

const Receipt = Schema.Struct({
  path: Schema.String,
  generation: Schema.String,
  claimId: Schema.String,
});
const Producer = Schema.Struct({
  entry: Schema.String,
  activationId: Schema.String,
  controller: Schema.NullOr(
    Schema.Struct({
      platform: Schema.String,
      pid: Schema.Number,
      boot: Schema.String,
      start: Schema.String,
    }),
  ),
});
const Obligation = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals([
    "allocation",
    "provider-turn",
    "background",
    "child",
    "checkpoint",
    "delivery",
  ]),
  acknowledgement: Schema.NullOr(Schema.String),
});
const Document = Schema.Struct({
  id: Schema.String,
  ownerRef: Schema.String,
  projectRoot: Schema.String,
  credential: Schema.String,
  producer: Producer,
  phase: Schema.Literals(["open", "closing", "recovery-required", "released"]),
  receipt: Schema.NullOr(Receipt),
  obligations: Schema.Array(Obligation),
  settlementRef: Schema.NullOr(Schema.String),
  recoveryReason: Schema.NullOr(Schema.String),
});
const decode = Schema.decodeUnknownEffect(Schema.fromJsonString(Document));
const encode = Schema.encodeEffect(Schema.fromJsonString(Document));

export type CustodyReceipt = typeof Receipt.Type;
export type CustodyProducer = typeof Producer.Type;
export type CustodyObligation = typeof Obligation.Type;
export type CustodyEpoch = Omit<typeof Document.Type, "credential"> & {
  readonly credential: Redacted.Redacted<string>;
};

export class WorkspaceCustodyConflict extends Schema.TaggedError<WorkspaceCustodyConflict>()(
  "WorkspaceCustodyConflict",
  {
    epochId: Schema.String,
    reason: Schema.Literals(["missing", "identity", "closed", "unsettled", "recovery-required"]),
  },
) {
  override get message(): string {
    return `Workspace custody cannot advance (${this.reason}).`;
  }
}

type Failure = PersistenceSqlError | WorkspaceCustodyConflict;
const isCustodyConflict = Schema.is(WorkspaceCustodyConflict);
const isPersistenceSqlError = Schema.is(PersistenceSqlError);
const changeFailure = (error: unknown): Failure =>
  isCustodyConflict(error) || isPersistenceSqlError(error)
    ? error
    : toPersistenceSqlError("changeWorkspaceCustody")(error);

export class WorkspaceCustody extends Context.Service<
  WorkspaceCustody,
  {
    readonly reserve: (
      input: Pick<CustodyEpoch, "id" | "ownerRef" | "projectRoot" | "credential" | "producer">,
    ) => Effect.Effect<CustodyEpoch, Failure>;
    readonly get: (id: string) => Effect.Effect<CustodyEpoch, Failure>;
    readonly forOwner: (
      ownerRef: string,
    ) => Effect.Effect<CustodyEpoch | null, PersistenceSqlError>;
    readonly list: Effect.Effect<ReadonlyArray<CustodyEpoch>, PersistenceSqlError>;
    readonly forScope: (
      prefix: string,
    ) => Effect.Effect<ReadonlyArray<CustodyEpoch>, PersistenceSqlError>;
    readonly acquired: (id: string, receipt: CustodyReceipt) => Effect.Effect<void, Failure>;
    readonly register: (
      id: string,
      obligation: Pick<CustodyObligation, "id" | "kind">,
    ) => Effect.Effect<void, Failure>;
    readonly acknowledge: (
      id: string,
      obligationId: string,
      evidenceRef: string,
    ) => Effect.Effect<void, Failure>;
    readonly close: (id: string) => Effect.Effect<void, Failure>;
    readonly requireSettled: (id: string) => Effect.Effect<CustodyEpoch, Failure>;
    readonly recover: (id: string, reason: string) => Effect.Effect<void, Failure>;
    readonly released: (id: string, settlementRef: string) => Effect.Effect<void, Failure>;
  }
>()("t3/persistence/WorkspaceCustody") {}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const readDocument = Effect.fn("WorkspaceCustody.readDocument")(function* (json: string) {
    const document = yield* decode(json).pipe(
      Effect.mapError(toPersistenceSqlError("decodeWorkspaceCustody")),
    );
    return { ...document, credential: Redacted.make(document.credential) } satisfies CustodyEpoch;
  });
  const get = Effect.fn("WorkspaceCustody.get")(function* (id: string) {
    const rows = yield* sql<{
      readonly document_json: string;
    }>`SELECT document_json FROM workspace_custody WHERE id = ${id}`.pipe(
      Effect.mapError(toPersistenceSqlError("readWorkspaceCustody")),
    );
    if (!rows[0]) return yield* new WorkspaceCustodyConflict({ epochId: id, reason: "missing" });
    return yield* readDocument(rows[0].document_json);
  });
  const write = Effect.fn("WorkspaceCustody.write")(function* (epoch: CustodyEpoch) {
    const document = yield* encode({ ...epoch, credential: Redacted.value(epoch.credential) }).pipe(
      Effect.mapError(toPersistenceSqlError("encodeWorkspaceCustody")),
    );
    yield* sql`UPDATE workspace_custody SET document_json = ${document} WHERE id = ${epoch.id}`.pipe(
      Effect.mapError(toPersistenceSqlError("writeWorkspaceCustody")),
    );
  });
  const change = (
    id: string,
    update: (epoch: CustodyEpoch) => Effect.Effect<CustodyEpoch, WorkspaceCustodyConflict>,
  ) =>
    sql
      .withTransaction(
        Effect.gen(function* () {
          yield* write(yield* update(yield* get(id)));
        }),
      )
      .pipe(Effect.mapError(changeFailure));
  const requireSettled = Effect.fn("WorkspaceCustody.requireSettled")(function* (id: string) {
    const epoch = yield* get(id);
    if (epoch.phase === "recovery-required")
      return yield* new WorkspaceCustodyConflict({ epochId: id, reason: "recovery-required" });
    if (
      epoch.phase !== "closing" ||
      epoch.receipt === null ||
      epoch.obligations.some((item) => item.acknowledgement === null)
    ) {
      return yield* new WorkspaceCustodyConflict({ epochId: id, reason: "unsettled" });
    }
    return epoch;
  });
  return WorkspaceCustody.of({
    get,
    forOwner: Effect.fn("WorkspaceCustody.forOwner")(function* (ownerRef) {
      const rows = yield* sql<{
        readonly document_json: string;
      }>`SELECT document_json FROM workspace_custody WHERE owner_ref = ${ownerRef}`.pipe(
        Effect.mapError(toPersistenceSqlError("readWorkspaceCustodyOwner")),
      );
      return rows[0] ? yield* readDocument(rows[0].document_json) : null;
    }),
    forScope: Effect.fn("WorkspaceCustody.forScope")((prefix) =>
      sql<{
        readonly document_json: string;
      }>`SELECT document_json FROM workspace_custody WHERE owner_ref >= ${prefix} AND owner_ref < ${prefix + "\uffff"} ORDER BY owner_ref`.pipe(
        Effect.mapError(toPersistenceSqlError("listWorkspaceCustodyScope")),
        Effect.flatMap((rows) => Effect.forEach(rows, (row) => readDocument(row.document_json))),
      ),
    ),
    list: sql<{
      readonly document_json: string;
    }>`SELECT document_json FROM workspace_custody ORDER BY id`.pipe(
      Effect.mapError(toPersistenceSqlError("listWorkspaceCustody")),
      Effect.flatMap((rows) => Effect.forEach(rows, (row) => readDocument(row.document_json))),
    ),
    reserve: Effect.fn("WorkspaceCustody.reserve")(function* (input) {
      return yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const document: CustodyEpoch = {
              ...input,
              phase: "open",
              receipt: null,
              obligations: [],
              settlementRef: null,
              recoveryReason: null,
            };
            const encoded = yield* encode({
              ...document,
              credential: Redacted.value(input.credential),
            });
            yield* sql`INSERT OR IGNORE INTO workspace_custody (id, owner_ref, document_json) VALUES (${input.id}, ${input.ownerRef}, ${encoded})`;
            const stored = yield* get(input.id);
            if (
              stored.ownerRef !== input.ownerRef ||
              stored.projectRoot !== input.projectRoot ||
              Redacted.value(stored.credential) !== Redacted.value(input.credential)
            ) {
              return yield* new WorkspaceCustodyConflict({ epochId: input.id, reason: "identity" });
            }
            if (stored.phase !== "open")
              return yield* new WorkspaceCustodyConflict({ epochId: input.id, reason: "closed" });
            return stored;
          }),
        )
        .pipe(Effect.mapError(changeFailure));
    }),
    acquired: Effect.fn("WorkspaceCustody.acquired")((id, receipt) =>
      change(id, (epoch) => {
        if (epoch.phase !== "open")
          return Effect.fail(new WorkspaceCustodyConflict({ epochId: id, reason: "closed" }));
        if (
          epoch.receipt !== null &&
          (epoch.receipt.path !== receipt.path ||
            epoch.receipt.generation !== receipt.generation ||
            epoch.receipt.claimId !== receipt.claimId)
        ) {
          return Effect.fail(new WorkspaceCustodyConflict({ epochId: id, reason: "identity" }));
        }
        return Effect.succeed({ ...epoch, receipt });
      }),
    ),
    register: Effect.fn("WorkspaceCustody.register")((id, obligation) =>
      change(id, (epoch) => {
        if (epoch.phase !== "open")
          return Effect.fail(new WorkspaceCustodyConflict({ epochId: id, reason: "closed" }));
        const prior = epoch.obligations.find((item) => item.id === obligation.id);
        if (prior && prior.kind !== obligation.kind)
          return Effect.fail(new WorkspaceCustodyConflict({ epochId: id, reason: "identity" }));
        return Effect.succeed(
          prior
            ? epoch
            : {
                ...epoch,
                obligations: [...epoch.obligations, { ...obligation, acknowledgement: null }],
              },
        );
      }),
    ),
    acknowledge: Effect.fn("WorkspaceCustody.acknowledge")((id, obligationId, evidenceRef) =>
      change(id, (epoch) => {
        const obligation = epoch.obligations.find((item) => item.id === obligationId);
        if (
          !evidenceRef ||
          !obligation ||
          (obligation.acknowledgement !== null && obligation.acknowledgement !== evidenceRef)
        ) {
          return Effect.fail(new WorkspaceCustodyConflict({ epochId: id, reason: "identity" }));
        }
        return Effect.succeed({
          ...epoch,
          obligations: epoch.obligations.map((item) =>
            item.id === obligationId ? { ...item, acknowledgement: evidenceRef } : item,
          ),
        });
      }),
    ),
    close: Effect.fn("WorkspaceCustody.close")((id) =>
      change(id, (epoch) =>
        epoch.phase === "open" ||
        epoch.phase === "closing" ||
        (epoch.phase === "recovery-required" &&
          epoch.receipt !== null &&
          epoch.obligations.every((item) => item.acknowledgement !== null))
          ? Effect.succeed({ ...epoch, phase: "closing", recoveryReason: null })
          : Effect.fail(new WorkspaceCustodyConflict({ epochId: id, reason: "closed" })),
      ),
    ),
    requireSettled,
    recover: Effect.fn("WorkspaceCustody.recover")((id, reason) =>
      change(id, (epoch) =>
        epoch.phase === "released"
          ? Effect.fail(new WorkspaceCustodyConflict({ epochId: id, reason: "closed" }))
          : Effect.succeed({ ...epoch, phase: "recovery-required", recoveryReason: reason }),
      ),
    ),
    released: Effect.fn("WorkspaceCustody.released")(function* (id, settlementRef) {
      yield* sql
        .withTransaction(
          Effect.gen(function* () {
            const epoch = yield* get(id);
            if (epoch.phase === "released" && epoch.settlementRef === settlementRef) return;
            yield* requireSettled(id);
            if (!settlementRef)
              return yield* new WorkspaceCustodyConflict({ epochId: id, reason: "identity" });
            yield* write({ ...epoch, phase: "released", settlementRef });
          }),
        )
        .pipe(Effect.mapError(changeFailure));
    }),
  });
});

export const layer = Layer.effect(WorkspaceCustody, make);
