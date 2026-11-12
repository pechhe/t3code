// @effect-diagnostics-next-line nodeBuiltinImport:off -- HMAC keeps password-derived receipt fingerprints private.
import * as NodeCrypto from "node:crypto";
import {
  SecretManagementError,
  type SavedSecretMetadata,
  type SecretsListInput,
  type SecretsListResult,
  type SecretsSaveInput,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Semaphore from "effect/Semaphore";
import * as ServerSecretStore from "../auth/ServerSecretStore.ts";
import * as BwsClient from "./BwsClient.ts";

const encodeJson = (value: unknown) => JSON.stringify(value);
const parseReceipt = (
  value: Uint8Array,
): { fingerprint?: string; result?: SavedSecretMetadata } | undefined => {
  try {
    const parsed: unknown = JSON.parse(new TextDecoder().decode(value));
    if (
      !parsed ||
      typeof parsed !== "object" ||
      !("fingerprint" in parsed) ||
      typeof parsed.fingerprint !== "string"
    )
      return undefined;
    if (!("result" in parsed)) return { fingerprint: parsed.fingerprint };
    const result = parsed.result;
    if (
      !result ||
      typeof result !== "object" ||
      !("id" in result) ||
      typeof result.id !== "string" ||
      !("key" in result) ||
      typeof result.key !== "string" ||
      !("projectId" in result) ||
      typeof result.projectId !== "string" ||
      !("browserLogin" in result) ||
      typeof result.browserLogin !== "boolean"
    )
      return undefined;
    return {
      fingerprint: parsed.fingerprint,
      result: {
        id: result.id,
        key: result.key,
        projectId: result.projectId,
        browserLogin: result.browserLogin,
      },
    };
  } catch {
    return undefined;
  }
};
const prefix = "BROWSER_LOGIN_";
const error = (reason: SecretManagementError["reason"]) => new SecretManagementError({ reason });
const metadata = (entry: {
  readonly id: string;
  readonly key: string;
  readonly projectId: string;
}): SavedSecretMetadata => ({ ...entry, browserLogin: entry.key.startsWith(prefix) });

export class SavedSecrets extends Context.Service<
  SavedSecrets,
  {
    readonly list: (
      input: SecretsListInput,
    ) => Effect.Effect<SecretsListResult, SecretManagementError>;
    readonly save: (
      input: SecretsSaveInput,
    ) => Effect.Effect<SavedSecretMetadata, SecretManagementError>;
    readonly remove: (id: string) => Effect.Effect<void, SecretManagementError>;
    readonly read: (id: string) => Effect.Effect<string, SecretManagementError>;
    readonly reveal: (id: string) => Effect.Effect<string, SecretManagementError>;
  }
>()("t3/secrets/SavedSecrets") {}

const make = Effect.gen(function* () {
  const client = yield* BwsClient.BwsClient;
  const store = yield* ServerSecretStore.ServerSecretStore;
  const lock = yield* Semaphore.make(1);
  const encoder = new TextEncoder();
  const storeFailure = () => error("unavailable");
  const scoped = Effect.fn("SavedSecrets.scoped")(function* (id: string, allowBrowser = true) {
    const projectId = yield* client.projectId;
    const entries = yield* client.list();
    const entry = entries.find((item) => item.id === id && item.projectId === projectId);
    if (!entry) return yield* error("not_found");
    if (!allowBrowser && entry.key.startsWith(prefix)) return yield* error("protected");
    const secret = yield* client.get(id);
    if (secret.projectId !== projectId) return yield* error("not_found");
    if (!allowBrowser && secret.key.startsWith(prefix)) return yield* error("protected");
    return secret;
  });
  const list = Effect.fn("SavedSecrets.list")(function* (input: SecretsListInput) {
    const projectId = yield* client.projectId;
    const entries = (yield* client.list())
      .filter(
        (x) =>
          x.projectId === projectId &&
          (!input.query || x.key.toLowerCase().includes(input.query.toLowerCase())),
      )
      .sort((a, b) => a.id.localeCompare(b.id));
    const offset = input.cursor ? entries.findIndex((entry) => entry.id === input.cursor) + 1 : 0;
    if (input.cursor && offset === 0) return yield* error("invalid");
    const page = entries.slice(offset, offset + (input.limit ?? 50));
    return {
      projectId: projectId,
      entries: page.map(metadata),
      nextCursor: offset + page.length < entries.length ? (page.at(-1)?.id ?? null) : null,
    };
  });
  const save = Effect.fn("SavedSecrets.save")(
    function* (input: SecretsSaveInput) {
      const projectId = yield* client.projectId;
      if (input.projectId !== projectId) return yield* error("destination_changed");
      const key = yield* store
        .getOrCreateRandom("saved-secret-receipt-key", 32)
        .pipe(Effect.mapError(storeFailure));
      const receiptName = `saved-secret-receipt-${NodeCrypto.createHash("sha256").update(input.clientRequestId).digest("hex")}`;
      const fingerprint = NodeCrypto.createHmac("sha256", key)
        .update(encodeJson([projectId, input.id ?? null, input.key, input.secret ?? null]))
        .digest("hex");
      const saved = yield* store.get(receiptName).pipe(Effect.mapError(storeFailure));
      if (Option.isSome(saved)) {
        const receipt = parseReceipt(saved.value);
        if (!receipt) return yield* error("uncertain");
        if (receipt.fingerprint !== fingerprint) return yield* error("invalid");
        if (!receipt.result) return yield* error("uncertain");
        return receipt.result;
      }
      const entries = (yield* client.list()).filter((x) => x.projectId === projectId);
      if (entries.some((entry) => entry.key === input.key && entry.id !== input.id))
        return yield* error("exists");
      let existing: BwsClient.BwsSecret | undefined;
      if (input.id) {
        existing = yield* scoped(input.id);
        if (existing.key.startsWith(prefix) !== input.key.startsWith(prefix))
          return yield* error("protected");
      } else {
        if (input.key.startsWith(prefix)) return yield* error("protected");
        if (input.secret === undefined) return yield* error("invalid");
      }
      if (!input.key.trim() || input.secret === "") return yield* error("invalid");
      yield* store
        .set(receiptName, encoder.encode(encodeJson({ fingerprint })))
        .pipe(Effect.mapError(storeFailure));
      const result = yield* (
        existing
          ? client.update(existing, input.key, input.secret ?? existing.value)
          : client.create(input.key, input.secret!)
      ).pipe(Effect.mapError(() => error("uncertain")));
      if (result.projectId !== projectId) return yield* error("uncertain");
      const resultMetadata = metadata({
        id: result.id,
        key: result.key,
        projectId: result.projectId,
      });
      yield* store
        .set(receiptName, encoder.encode(encodeJson({ fingerprint, result: resultMetadata })))
        .pipe(Effect.mapError(() => error("uncertain")));
      return resultMetadata;
    },
    (effect) => effect.pipe(Effect.uninterruptible, lock.withPermits(1)),
  );
  const remove = Effect.fn("SavedSecrets.remove")(
    function* (id: string) {
      yield* scoped(id);
      yield* client.remove(id).pipe(Effect.mapError(() => error("uncertain")));
    },
    (effect) => effect.pipe(Effect.uninterruptible, lock.withPermits(1)),
  );
  const reveal = Effect.fn("SavedSecrets.reveal")(function* (id: string) {
    return (yield* scoped(id)).value;
  });
  const read = Effect.fn("SavedSecrets.read")(function* (id: string) {
    return (yield* scoped(id, false)).value;
  });
  return SavedSecrets.of({ list, save, remove, read, reveal });
});

export const layer = Layer.effect(SavedSecrets, make);
