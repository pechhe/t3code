// Answers stay in the secret store behind one-use refs; orchestration records only request status.
// Consuming tools keep values out of transcripts, projections, clients and model context.
// A `file` request instead moves its value to an owner-only file for the agent's own shell.
// A secret the user pasted in chat goes straight to such a file, with no card.
import {
  CommandId,
  SecretRef,
  SecretRequestError,
  type ProjectId,
  type SecretReference,
  type SecretRequestAnswerInput,
  type ThreadId,
  TemporarySecretMetadata,
} from "@t3tools/contracts";
import * as SecretResolver from "@t3tools/secret-provider-core/server/SecretResolver";

import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Mac from "effect/crypto/Mac";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schedule from "effect/Schedule";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";

import * as SavedSecrets from "./SavedSecrets.ts";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as Metrics from "../observability/Metrics.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";

const SECRET_REF_PREFIX = "secret-ref:";
const storeName = (ref: SecretRef) => `secret-request-${ref.slice(SECRET_REF_PREFIX.length)}`;
const REF_PATTERN = /^secret-ref:[0-9a-f]{32}$/;
const SECRET_REF_TTL_MS = 24 * 60 * 60 * 1000;
const STORE_NAME_PATTERN = /^(secret-request-[0-9a-f]{32})\.bin$/;
const FILE_NAME_PATTERN = /^[0-9a-f]{32}(\.partial)?$/;

const StoredSecret = Schema.fromJsonString(
  Schema.Struct({ projectId: Schema.String, value: Schema.String, savedAt: Schema.Number }),
);
const encodeStored = Schema.encodeEffect(StoredSecret);
const decodeStored = Schema.decodeUnknownOption(StoredSecret);

export class SecretRequests extends Context.Service<
  SecretRequests,
  {
    readonly answer: (input: SecretRequestAnswerInput) => Effect.Effect<void, SecretRequestError>;
    readonly answerSaved: (
      input: SecretRequestAnswerInput,
    ) => Effect.Effect<void, SecretRequestError>;
    readonly listTemporary: Effect.Effect<
      ReadonlyArray<TemporarySecretMetadata>,
      SecretRequestError
    >;
    readonly removeTemporary: (id: string) => Effect.Effect<void, SecretRequestError>;
    readonly deliverSaved: (input: {
      readonly id: string;
      readonly threadId: ThreadId;
      readonly requestNamespace: string;
      readonly requestKey: string;
      readonly delivery?: "secretRef" | "file";
      readonly label: string;
    }) => Effect.Effect<
      { readonly secretRef: SecretRef } | { readonly file: string },
      SecretRequestError
    >;
    readonly savedRef: (input: {
      readonly threadId: ThreadId;
      readonly turnItemId: string;
    }) => Effect.Effect<Option.Option<SecretRef>>;
    readonly consume: (input: {
      readonly ref: SecretRef;
      readonly projectId: ProjectId;
    }) => Effect.Effect<string, SecretRequestError>;
    /** Moves a saved `file` request's value to an owner-only file and returns its path. */
    readonly saveToFile: (input: {
      readonly threadId: ThreadId;
      readonly turnItemId: string;
    }) => Effect.Effect<string, SecretRequestError>;
    /** Writes a secret the user pasted in chat to an owner-only file and returns its path. */
    readonly savePasted: (input: {
      readonly threadId: ThreadId;
      /** The provider session's namespace, so two sessions' keys never share a file. */
      readonly requestNamespace: string;
      readonly requestKey: string;
      readonly value: string;
      readonly label?: string;
    }) => Effect.Effect<string, SecretRequestError>;
  }
>()("t3/secrets/SecretRequests") {}

const make = Effect.gen(function* () {
  const store = yield* ServerSecretStore.ServerSecretStore;
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const threadManagement = yield* ThreadManagementService.ThreadManagementService;
  const resolver = yield* SecretResolver.SecretResolver;
  const savedSecrets = yield* Effect.serviceOption(SavedSecrets.SavedSecrets);
  // Beside the store's own files so the same owner-only directory and cleanup rules apply.
  const filesDir = store.directory === undefined ? undefined : path.join(store.directory, "files");

  const mac = yield* Mac.Mac;
  // Keyed by the salt's hex text, as refs saved by earlier versions were.
  const refKey = yield* Mac.key(
    Mac.hmacSha256,
    new TextEncoder().encode(
      Hex.encode(yield* store.getOrCreateRandom("secret-request-salt", 32).pipe(Effect.orDie)),
    ),
  ).pipe(Effect.orDie);
  const refFor = (threadId: ThreadId, turnItemId: string) =>
    mac.sign(refKey, new TextEncoder().encode(`${threadId}\u0000${turnItemId}`)).pipe(
      Effect.orDie,
      Effect.map((tag) => SecretRef.make(`${SECRET_REF_PREFIX}${Hex.encode(tag).slice(0, 32)}`)),
    );

  const readReference = Effect.fn("SecretRequests.readReference")(function* (
    reference: SecretReference,
  ) {
    // The resolver keeps failed reads for the server's life; a retry after unlocking must re-read.
    yield* resolver.invalidate([reference]);
    const [value] = yield* resolver.read([reference]);
    if (value === undefined || value.length === 0) {
      return yield* new SecretRequestError({
        reason: "reference_unreadable",
        provider: yield* resolver.label(reference.provider),
      });
    }
    return value;
  });

  const metadataName = (id: string) => `secret-handoff-${id}`;
  const encodeMetadata = Schema.encodeEffect(Schema.fromJsonString(TemporarySecretMetadata));
  const decodeMetadata = Schema.decodeUnknownOption(Schema.fromJsonString(TemporarySecretMetadata));
  const remember = Effect.fn("SecretRequests.remember")(function* (entry: TemporarySecretMetadata) {
    yield* store
      .set(
        metadataName(entry.id),
        new TextEncoder().encode(yield* encodeMetadata(entry).pipe(Effect.orDie)),
      )
      .pipe(Effect.mapError(() => new SecretRequestError({ reason: "store_failed" })));
  });

  const answerRequest = Effect.fn("SecretRequests.answer")(function* (
    input: SecretRequestAnswerInput,
    allowDurable: boolean,
  ) {
    yield* Effect.annotateCurrentSpan({
      "orchestration_v2.thread_id": input.threadId,
      "secret_request.answer": input.answer.type,
    });
    const records = yield* threadManagement
      .getThreadRecords(input.threadId, ["runs", "turnItems"], {
        turnItemTypes: ["secret_request"],
        messageRoles: [],
      })
      .pipe(Effect.mapError((cause) => new SecretRequestError({ reason: "load_failed", cause })));
    const item = records.turnItems.find((candidate) => candidate.id === input.turnItemId);
    if (item?.type !== "secret_request" || item.runId === null || item.nodeId === null) {
      return yield* new SecretRequestError({ reason: "not_found" });
    }
    if (item.secretStatus !== "pending") {
      return yield* new SecretRequestError({ reason: "already_answered" });
    }
    const run = records.runs.find((candidate) => candidate.id === item.runId);
    if (run === undefined || ThreadManagementService.isTerminalRunStatus(run.status)) {
      return yield* new SecretRequestError({ reason: "agent_stopped" });
    }
    if (item.storage === "bws" && input.answer.type !== "decline") {
      if (
        !allowDurable ||
        input.answer.type !== "save" ||
        !item.secretKey ||
        !item.secretProjectId
      ) {
        return yield* new SecretRequestError({ reason: "storage_unsupported" });
      }
      if (Option.isNone(savedSecrets))
        return yield* new SecretRequestError({ reason: "vault_failed" });
      yield* savedSecrets.value
        .save({
          projectId: item.secretProjectId,
          ...(item.savedSecretId === undefined ? {} : { id: item.savedSecretId }),
          key: item.secretKey,
          secret: input.answer.secret,
          clientRequestId: `card:${input.threadId}:${item.id}`,
        })
        .pipe(
          Effect.mapError(
            (error) =>
              new SecretRequestError({
                reason:
                  error.reason === "uncertain"
                    ? "vault_uncertain"
                    : error.reason === "destination_changed"
                      ? "vault_destination_changed"
                      : "vault_failed",
              }),
          ),
        );
    }
    const secret =
      input.answer.type === "save"
        ? input.answer.secret
        : input.answer.type === "reference"
          ? yield* readReference(input.answer.reference)
          : undefined;
    // Create before recording so racing answers cannot overwrite values or show saved before storage.
    // Existing values on pending cards finish earlier saves whose recording failed.
    if (secret !== undefined) {
      const encoded = yield* encodeStored({
        projectId: records.thread.projectId,
        value: secret,
        savedAt: yield* Clock.currentTimeMillis,
      }).pipe(Effect.orDie);
      yield* store
        .create(
          storeName(yield* refFor(input.threadId, item.id)),
          new TextEncoder().encode(encoded),
        )
        .pipe(
          Effect.catchIf(ServerSecretStore.isSecretAlreadyExistsError, () => Effect.void),
          Effect.mapError(
            (error) => new SecretRequestError({ reason: "store_failed", cause: error }),
          ),
        );
    }
    if (secret !== undefined)
      yield* remember({
        id: (yield* refFor(input.threadId, item.id)).slice(SECRET_REF_PREFIX.length),
        label: item.label,
        threadId: input.threadId,
        delivery: "secretRef",
        expiresAt: (yield* Clock.currentTimeMillis) + SECRET_REF_TTL_MS,
      });
    const secretStatus = secret === undefined ? "declined" : "saved";
    yield* threadManagement
      .dispatch({
        type: "secret_request.record",
        commandId: CommandId.make(`secret-request:${item.id}:${secretStatus}`),
        threadId: input.threadId,
        runId: item.runId,
        nodeId: item.nodeId,
        turnItemId: item.id,
        label: item.label,
        reason: item.reason,
        ...(item.url === undefined ? {} : { url: item.url }),
        ...(item.placeholder === undefined ? {} : { placeholder: item.placeholder }),
        ...(item.delivery === undefined ? {} : { delivery: item.delivery }),
        ...(item.storage === undefined ? {} : { storage: item.storage }),
        ...(item.secretKey === undefined ? {} : { secretKey: item.secretKey }),
        ...(item.savedSecretId === undefined ? {} : { savedSecretId: item.savedSecretId }),
        ...(item.secretProjectId === undefined ? {} : { secretProjectId: item.secretProjectId }),
        secretStatus,
      })
      .pipe(
        Effect.mapError((cause) => new SecretRequestError({ reason: "record_failed", cause })),
        // Clear failed saves so the pending card can be answered again.
        Effect.tapError(() =>
          secret !== undefined
            ? refFor(input.threadId, item.id).pipe(
                Effect.flatMap((ref) => removeLogged(storeName(ref))),
              )
            : Effect.void,
        ),
      );
    if (secret === undefined) return;
    // The wait may have closed the card; delete unrecorded answers because no one receives their refs.
    const recorded = yield* threadManagement
      .getThreadRecords(input.threadId, ["turnItems"], {
        turnItemTypes: ["secret_request"],
        messageRoles: [],
      })
      .pipe(Effect.mapError((cause) => new SecretRequestError({ reason: "record_failed", cause })));
    const card = recorded.turnItems.find((candidate) => candidate.id === item.id);
    if (card?.type === "secret_request" && card.secretStatus !== "saved") {
      yield* removeLogged(storeName(yield* refFor(input.threadId, item.id)));
      return yield* new SecretRequestError({ reason: "agent_stopped" });
    }
  });

  const savedRef: SecretRequests["Service"]["savedRef"] = Effect.fn("SecretRequests.savedRef")(
    function* (input) {
      const ref = yield* refFor(input.threadId, input.turnItemId);
      const stored = yield* store.get(storeName(ref)).pipe(Effect.orElseSucceed(Option.none));
      return Option.map(stored, () => ref);
    },
  );

  const removeLogged = (name: string) =>
    store.remove(name).pipe(
      Effect.as(true),
      Effect.catch((error) =>
        Effect.logWarning("Could not delete a secret request value", {
          errorTag: error._tag,
        }).pipe(Effect.as(false)),
      ),
    );

  // Serialize get/remove so concurrent consumers cannot read the same one-use ref.
  const consumeLock = yield* Semaphore.make(1);
  const consume: SecretRequests["Service"]["consume"] = (input) =>
    consumeRef(input).pipe(
      consumeLock.withPermits(1),
      Effect.tap(() => Metrics.increment(Metrics.secretRefsConsumedTotal, { result: "used" })),
      Effect.tapError(() =>
        Metrics.increment(Metrics.secretRefsConsumedTotal, { result: "rejected" }),
      ),
      Effect.withSpan("SecretRequests.consume"),
    );

  /** A live ref's value, left in the store. */
  const readRef = Effect.fn("SecretRequests.readRef")(function* (input: {
    readonly ref: SecretRef;
    readonly projectId: ProjectId;
  }) {
    if (!REF_PATTERN.test(input.ref))
      return yield* new SecretRequestError({ reason: "invalid_ref" });
    const stored = yield* store
      .get(storeName(input.ref))
      .pipe(Effect.mapError((cause) => new SecretRequestError({ reason: "read_failed", cause })));
    const decoded = Option.flatMap(stored, (bytes) =>
      decodeStored(new TextDecoder().decode(bytes)),
    );
    if (Option.isNone(decoded) || decoded.value.projectId !== input.projectId) {
      return yield* new SecretRequestError({ reason: "ref_unavailable" });
    }
    if ((yield* Clock.currentTimeMillis) - decoded.value.savedAt > SECRET_REF_TTL_MS) {
      yield* removeLogged(storeName(input.ref));
      return yield* new SecretRequestError({ reason: "ref_expired" });
    }
    return decoded.value.value;
  });

  const consumeRef = Effect.fn("SecretRequests.consumeRef")(function* (input: {
    readonly ref: SecretRef;
    readonly projectId: ProjectId;
  }) {
    const value = yield* readRef(input);
    // One use: the value moves into whatever consumed it. If it cannot be
    // deleted, it is not handed out, so a ref is never used twice.
    if (!(yield* removeLogged(storeName(input.ref)))) {
      return yield* new SecretRequestError({ reason: "consume_failed" });
    }
    yield* removeLogged(metadataName(input.ref.slice(SECRET_REF_PREFIX.length)));
    return value;
  });

  const writeSecretFile = (dir: string, file: string, value: string) => {
    const partial = `${file}.partial`;
    return fileSystem.makeDirectory(dir, { recursive: true, mode: 0o700 }).pipe(
      Effect.andThen(fileSystem.chmod(dir, 0o700)),
      Effect.andThen(fileSystem.remove(partial, { force: true })),
      // `wx` never follows or replaces an existing path.
      Effect.andThen(
        fileSystem.writeFile(partial, new TextEncoder().encode(value), {
          flag: "wx",
          mode: 0o600,
        }),
      ),
      Effect.andThen(fileSystem.rename(partial, file)),
      Effect.mapError((cause) => new SecretRequestError({ reason: "store_failed", cause })),
    );
  };

  const saveToFile: SecretRequests["Service"]["saveToFile"] = Effect.fn(
    "SecretRequests.saveToFile",
  )(function* (input) {
    const records = yield* threadManagement
      .getThreadRecords(input.threadId, ["turnItems"], {
        turnItemTypes: ["secret_request"],
        messageRoles: [],
      })
      .pipe(Effect.mapError((cause) => new SecretRequestError({ reason: "load_failed", cause })));
    const item = records.turnItems.find((candidate) => candidate.id === input.turnItemId);
    // Only a card that told the user the agent's commands can read the value may write it out.
    if (
      item?.type !== "secret_request" ||
      item.secretStatus !== "saved" ||
      item.delivery !== "file"
    ) {
      return yield* new SecretRequestError({ reason: "not_a_file_request" });
    }
    if (filesDir === undefined) return yield* new SecretRequestError({ reason: "store_failed" });
    const ref = yield* refFor(input.threadId, item.id);
    const file = path.join(filesDir, ref.slice(SECRET_REF_PREFIX.length));
    return yield* Effect.gen(function* () {
      // One use: the file counts as delivered only once the stored copy is gone. A retry with the
      // same clientRequestId gets the file the first call wrote and finishes that removal.
      const removeStored = removeLogged(storeName(ref)).pipe(
        Effect.flatMap((removed) =>
          removed ? Effect.succeed(file) : new SecretRequestError({ reason: "consume_failed" }),
        ),
      );
      if (yield* fileSystem.exists(file).pipe(Effect.orElseSucceed(() => false))) {
        return yield* removeStored;
      }
      // The stored value goes only after the file is complete, so a failed write can retry.
      const value = yield* readRef({ ref, projectId: records.thread.projectId });
      yield* writeSecretFile(filesDir, file, value);
      yield* remember({
        id: ref.slice(SECRET_REF_PREFIX.length),
        label: item.label,
        threadId: input.threadId,
        delivery: "file",
        expiresAt: (yield* Clock.currentTimeMillis) + SECRET_REF_TTL_MS,
      });
      return yield* removeStored;
    }).pipe(consumeLock.withPermits(1));
  });

  const savePasted: SecretRequests["Service"]["savePasted"] = Effect.fn(
    "SecretRequests.savePasted",
  )(function* (input) {
    if (filesDir === undefined) return yield* new SecretRequestError({ reason: "store_failed" });
    const ref = yield* refFor(
      input.threadId,
      `pasted\u0000${input.requestNamespace}\u0000${input.requestKey}`,
    );
    const file = path.join(filesDir, ref.slice(SECRET_REF_PREFIX.length));
    // A retry with the same clientRequestId gets the file the first call wrote, unchanged, so a
    // command already holding that path never reads another value.
    return yield* Effect.gen(function* () {
      if (yield* fileSystem.exists(file).pipe(Effect.orElseSucceed(() => false))) return file;
      yield* writeSecretFile(filesDir, file, input.value);
      yield* remember({
        id: ref.slice(SECRET_REF_PREFIX.length),
        label: input.label ?? "Secret supplied in this thread",
        threadId: input.threadId,
        delivery: "file",
        expiresAt: (yield* Clock.currentTimeMillis) + SECRET_REF_TTL_MS,
      });
      return file;
    }).pipe(consumeLock.withPermits(1));
  });

  const reuseLock = yield* Semaphore.make(1);
  const reuseReceiptSchema = Schema.fromJsonString(
    Schema.Struct({ id: Schema.String, ready: Schema.Boolean }),
  );
  const decodeReuseReceipt = Schema.decodeUnknownOption(reuseReceiptSchema);
  const encodeReuseReceipt = Schema.encodeEffect(reuseReceiptSchema);
  const deliverSaved = Effect.fn("SecretRequests.deliverSaved")(function* (
    input: Parameters<SecretRequests["Service"]["deliverSaved"]>[0],
  ) {
    if (Option.isNone(savedSecrets))
      return yield* new SecretRequestError({ reason: "vault_failed" });
    const readSaved = savedSecrets.value.read(input.id).pipe(
      Effect.mapError(
        (error) =>
          new SecretRequestError({
            reason: error.reason === "protected" ? "vault_protected" : "vault_failed",
          }),
      ),
    );
    if (input.delivery === "file")
      return { file: yield* savePasted({ ...input, value: yield* readSaved }) };
    const ref = yield* refFor(
      input.threadId,
      `reuse\u0000${input.requestNamespace}\u0000${input.requestKey}`,
    );
    const receiptName = `secret-reuse-${ref.slice(SECRET_REF_PREFIX.length)}`;
    const persisted = yield* store
      .get(receiptName)
      .pipe(Effect.mapError(() => new SecretRequestError({ reason: "read_failed" })));
    let ready = false;
    if (Option.isSome(persisted)) {
      const text = new TextDecoder().decode(persisted.value);
      const receipt =
        text === input.id ? Option.some({ id: input.id, ready: true }) : decodeReuseReceipt(text);
      if (Option.isNone(receipt) || receipt.value.id !== input.id)
        return yield* new SecretRequestError({ reason: "invalid_ref" });
      ready = receipt.value.ready;
    }
    let existing = yield* store
      .get(storeName(ref))
      .pipe(Effect.mapError(() => new SecretRequestError({ reason: "read_failed" })));
    if (ready) {
      if (Option.isNone(existing))
        return yield* new SecretRequestError({ reason: "ref_unavailable" });
      return { secretRef: ref };
    }
    const records = yield* threadManagement
      .getThreadRecords(input.threadId, [], {})
      .pipe(Effect.mapError(() => new SecretRequestError({ reason: "load_failed" })));
    if (Option.isNone(persisted)) {
      const pending = yield* encodeReuseReceipt({ id: input.id, ready: false }).pipe(Effect.orDie);
      yield* store
        .create(receiptName, new TextEncoder().encode(pending))
        .pipe(Effect.mapError(() => new SecretRequestError({ reason: "store_failed" })));
    }
    if (Option.isNone(existing)) {
      const encoded = yield* encodeStored({
        projectId: records.thread.projectId,
        value: yield* readSaved,
        savedAt: yield* Clock.currentTimeMillis,
      }).pipe(Effect.orDie);
      const bytes = new TextEncoder().encode(encoded);
      yield* store
        .create(storeName(ref), bytes)
        .pipe(Effect.mapError(() => new SecretRequestError({ reason: "store_failed" })));
      existing = Option.some(bytes);
    }
    const stored = decodeStored(new TextDecoder().decode(Option.getOrThrow(existing)));
    if (Option.isNone(stored) || stored.value.projectId !== records.thread.projectId)
      return yield* new SecretRequestError({ reason: "invalid_ref" });
    yield* remember({
      id: ref.slice(SECRET_REF_PREFIX.length),
      label: input.label,
      threadId: input.threadId,
      delivery: "secretRef",
      expiresAt: stored.value.savedAt + SECRET_REF_TTL_MS,
    });
    const completed = yield* encodeReuseReceipt({ id: input.id, ready: true }).pipe(Effect.orDie);
    // Only a ready receipt may have published its reference; pending writes can safely recover.
    yield* store
      .set(receiptName, new TextEncoder().encode(completed))
      .pipe(Effect.mapError(() => new SecretRequestError({ reason: "store_failed" })));
    return { secretRef: ref };
  }, reuseLock.withPermits(1));

  const listTemporary = Effect.gen(function* () {
    if (store.directory === undefined) return [];
    const ids = new Map<string, { delivery: "secretRef" | "file"; file: string }>();
    for (const name of yield* fileSystem.readDirectory(store.directory)) {
      const match = /^secret-request-([0-9a-f]{32})\.bin$/.exec(name);
      if (match?.[1])
        ids.set(match[1], { delivery: "secretRef", file: path.join(store.directory, name) });
    }
    if (filesDir !== undefined && (yield* fileSystem.exists(filesDir))) {
      for (const name of yield* fileSystem.readDirectory(filesDir)) {
        if (/^[0-9a-f]{32}$/.test(name))
          ids.set(name, { delivery: "file", file: path.join(filesDir, name) });
      }
    }
    const now = yield* Clock.currentTimeMillis;
    const entries: Array<TemporarySecretMetadata> = [];
    for (const [id, source] of ids) {
      const bytes = yield* store.get(metadataName(id));
      const metadata = Option.flatMap(bytes, (data) =>
        decodeMetadata(new TextDecoder().decode(data)),
      );
      const stat = yield* fileSystem.stat(source.file);
      const expiresAt = Option.isSome(metadata)
        ? metadata.value.expiresAt
        : Option.match(stat.mtime, {
            onNone: () => 0,
            onSome: (time) => time.getTime() + SECRET_REF_TTL_MS,
          });
      if (expiresAt > now)
        entries.push({
          ...(Option.isSome(metadata)
            ? metadata.value
            : { id, label: "Unknown request", expiresAt }),
          delivery: source.delivery,
        });
    }
    return entries.sort((a, b) => a.expiresAt - b.expiresAt);
  }).pipe(Effect.mapError(() => new SecretRequestError({ reason: "read_failed" })));
  const removeTemporary = Effect.fn("SecretRequests.removeTemporary")(function* (id: string) {
    if (!/^[0-9a-f]{32}$/.test(id)) return yield* new SecretRequestError({ reason: "invalid_ref" });
    yield* store
      .remove(`secret-request-${id}`)
      .pipe(Effect.mapError(() => new SecretRequestError({ reason: "consume_failed" })));
    if (filesDir !== undefined)
      yield* fileSystem
        .remove(path.join(filesDir, id), { force: true })
        .pipe(Effect.mapError(() => new SecretRequestError({ reason: "consume_failed" })));
    yield* store
      .remove(metadataName(id))
      .pipe(Effect.mapError(() => new SecretRequestError({ reason: "consume_failed" })));
  }, consumeLock.withPermits(1));

  const sweepExpired = Effect.gen(function* () {
    if (store.directory === undefined) return;
    const now = yield* Clock.currentTimeMillis;
    const names = (yield* fileSystem.readDirectory(store.directory)).flatMap((file) => {
      const match = STORE_NAME_PATTERN.exec(file);
      return match?.[1] === undefined ? [] : [match[1]];
    });
    let removed = 0;
    for (const name of names) {
      const stored = yield* store.get(name).pipe(Effect.orElseSucceed(Option.none));
      const decoded = Option.flatMap(stored, (bytes) =>
        decodeStored(new TextDecoder().decode(bytes)),
      );
      if (Option.isSome(decoded) && now - decoded.value.savedAt <= SECRET_REF_TTL_MS) continue;
      if (yield* removeLogged(name)) removed += 1;
    }
    for (const file of yield* fileSystem.readDirectory(store.directory)) {
      const match = /^(secret-handoff-([0-9a-f]{32}))\.bin$/.exec(file);
      if (!match?.[1] || !match[2]) continue;
      const bytes = yield* store.get(match[1]);
      const meta = Option.flatMap(bytes, (data) => decodeMetadata(new TextDecoder().decode(data)));
      const refExists = yield* fileSystem.exists(
        path.join(store.directory, `secret-request-${match[2]}.bin`),
      );
      const fileExists =
        filesDir === undefined ? false : yield* fileSystem.exists(path.join(filesDir, match[2]));
      if (Option.isNone(meta) || meta.value.expiresAt <= now || (!refExists && !fileExists))
        yield* removeLogged(match[1]);
    }
    yield* Effect.annotateCurrentSpan({ "secret_request.expired_removed": removed });
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("Could not sweep expired secret refs", cause)),
    Effect.withSpan("SecretRequests.sweepExpired"),
  );
  const sweepExpiredFiles = Effect.gen(function* () {
    if (filesDir === undefined || !(yield* fileSystem.exists(filesDir))) return;
    const now = yield* Clock.currentTimeMillis;
    let removed = 0;
    for (const name of yield* fileSystem.readDirectory(filesDir)) {
      if (!FILE_NAME_PATTERN.test(name)) continue;
      const file = path.join(filesDir, name);
      const { mtime } = yield* fileSystem.stat(file);
      if (Option.exists(mtime, (time) => now - time.getTime() <= SECRET_REF_TTL_MS)) continue;
      yield* fileSystem.remove(file);
      removed += 1;
    }
    yield* Effect.annotateCurrentSpan({ "secret_request.expired_files_removed": removed });
  }).pipe(
    Effect.catchCause((cause) => Effect.logWarning("Could not sweep expired secret files", cause)),
    Effect.withSpan("SecretRequests.sweepExpiredFiles"),
  );
  const sweep = Effect.andThen(sweepExpired, sweepExpiredFiles);
  yield* sweep;
  yield* sweep.pipe(
    Effect.delay("1 hour"),
    Effect.repeat(Schedule.spaced("1 hour")),
    Effect.forkScoped,
  );

  return SecretRequests.of({
    answer: Effect.fn("SecretRequests.answerTemporary")((input) => answerRequest(input, false)),
    answerSaved: Effect.fn("SecretRequests.answerSaved")((input) => answerRequest(input, true)),
    savedRef,
    consume,
    saveToFile,
    savePasted,
    deliverSaved,
    listTemporary,
    removeTemporary,
  });
});

export const layer = Layer.effect(SecretRequests, make);
