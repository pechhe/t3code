// @effect-diagnostics nodeBuiltinImport:off preferSchemaOverJson:off
/**
 * Pi credentials of Settings → Accounts (fork/differences.md `pi-accounts`). Secrets live only
 * in auth.json, written under Pi's own lock; `t3-accounts.json` beside it lists the providers T3
 * added, for the Pi extensions that register them.
 */
import type { PiAccount, PiAccountFamily, PiAccountsSharedLogins } from "@t3tools/contracts";
import * as Clock from "effect/Clock";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as NodePath from "node:path";

import {
  decodeJsonOption,
  readText,
  serializeSettings,
  withPiFileLock,
  writeFile,
} from "./compaction.ts";
import {
  allocatePiProviderId,
  inferPiAccountFamily,
  PI_OAUTH_FAMILIES,
} from "@t3tools/shared/piAccounts";

import { PI_ACCOUNTS_EXTENSION_SOURCE } from "./accountsExtensionSource.ts";

const PI_ACCOUNTS_REGISTRY_FILENAME = "t3-accounts.json";
const PI_ACCOUNTS_EXTENSION_FILENAME = "t3-accounts.ts";
const AUTH_FILENAME = "auth.json";
const MODELS_FILENAME = "models.json";
const ANTIGRAVITY_SIDECAR_FILENAME = "antigravity-accounts.json";
const COMMANDCODE_KEYS_FILENAME = "commandcode-keys.json";
/** Pi holds auth.json's lock through a token refresh and renews it every 15 seconds. */
const AUTH_LOCK_STALE_MS = 30_000;
const PRIVATE_FILE_MODE = 0o600;
/** T3's own writers here hold a lock for milliseconds, as Pi's settings writers do. */
const T3_LOCK_STALE_MS = 15_000;
/** Command Code's own sign-in stores a pasted key this way; aliases store theirs the same. */
const COMMANDCODE_KEY_EXPIRES = 4_102_444_800_000;

export interface PiRegisteredAccount {
  readonly providerId: string;
  readonly providerFamily: PiAccountFamily;
  readonly label: string;
  readonly createdAt: string;
}

export interface PiAccountsRegistry {
  readonly version: 1;
  readonly accounts: ReadonlyArray<PiRegisteredAccount>;
  /** A retired provider ID and the account that took over its references. */
  readonly replacedProviderIds?: Readonly<Record<string, string>>;
}

const FAMILY_NAME: Record<PiAccountFamily, string> = {
  "claude-subscription": "Claude subscription",
  "anthropic-api": "Anthropic API",
  "openai-codex": "OpenAI Codex",
  "openai-api": "OpenAI API",
  antigravity: "Antigravity",
  commandcode: "Command Code",
  "opencode-go": "OpenCode Go",
  other: "Other",
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const FAMILIES = new Set<string>(Object.keys(FAMILY_NAME));
const isFamily = (value: unknown): value is PiAccountFamily =>
  typeof value === "string" && FAMILIES.has(value);

const PROVIDER_ID = /^[a-z0-9][a-z0-9._-]*$/;

function parsePiAccountsRegistry(text: string | undefined): PiAccountsRegistry {
  const parsed = text === undefined ? Option.none() : decodeJsonOption(text);
  const root = Option.isSome(parsed) && isRecord(parsed.value) ? parsed.value : {};
  const accounts = Array.isArray(root["accounts"]) ? root["accounts"] : [];
  const seen = new Set<string>();
  const valid = accounts.flatMap((entry): ReadonlyArray<PiRegisteredAccount> => {
    if (!isRecord(entry)) return [];
    const { providerId, providerFamily, label, createdAt } = entry;
    if (typeof providerId !== "string" || !PROVIDER_ID.test(providerId) || seen.has(providerId))
      return [];
    if (!isFamily(providerFamily)) return [];
    seen.add(providerId);
    return [
      {
        providerId,
        providerFamily,
        label: typeof label === "string" && label.trim() ? label.trim() : providerId,
        createdAt: typeof createdAt === "string" ? createdAt : "",
      },
    ];
  });
  const replaced = isRecord(root["replacedProviderIds"])
    ? Object.fromEntries(
        Object.entries(root["replacedProviderIds"]).filter(
          (entry): entry is [string, string] => typeof entry[1] === "string",
        ),
      )
    : undefined;
  return {
    version: 1,
    accounts: valid,
    ...(replaced && Object.keys(replaced).length > 0 ? { replacedProviderIds: replaced } : {}),
  };
}

const serialize = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/** A refusal whose `detail` is safe to show: never a key, token or file contents. */
export class PiAccountsFileError extends Schema.TaggedError<PiAccountsFileError>()(
  "PiAccountsFileError",
  { detail: Schema.String },
) {}

const failFile = (detail: string) => Effect.fail(new PiAccountsFileError({ detail }));

const writePrivate = Effect.fn("PiAccounts.writePrivate")(function* (
  file: string,
  contents: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  yield* fileSystem.makeDirectory(NodePath.dirname(file), { recursive: true, mode: 0o700 });
  yield* fileSystem.writeFileString(file, contents, { mode: PRIVATE_FILE_MODE });
});

export const readPiAccountsRegistry = Effect.fn("PiAccounts.readRegistry")(function* (
  agentDir: string,
) {
  return parsePiAccountsRegistry(
    yield* readText(NodePath.join(agentDir, PI_ACCOUNTS_REGISTRY_FILENAME)),
  );
});

/** Serializes T3's edits to the registry; Pi only reads it. */
const modifyPiAccountsRegistry = Effect.fn("PiAccounts.modifyRegistry")(function* (
  agentDir: string,
  change: (registry: PiAccountsRegistry) => PiAccountsRegistry,
) {
  const file = NodePath.join(agentDir, PI_ACCOUNTS_REGISTRY_FILENAME);
  const result = yield* withPiFileLock(
    NodePath.join(agentDir, ".t3-accounts.lock"),
    T3_LOCK_STALE_MS,
    Effect.gen(function* () {
      const next = change(parsePiAccountsRegistry(yield* readText(file)));
      yield* writePrivate(file, serialize(next));
      return next;
    }),
  );
  if (result === undefined) return yield* failFile("Another change to Pi's accounts is running.");
  return result;
});

/**
 * Pi's own read-modify-write discipline for auth.json: lock the resolved file the way its
 * `proper-lockfile` does (a `<file>.lock` directory), re-read under the lock, and write in
 * place so the file's mode is kept (0600 when T3 creates it).
 */
export const modifyPiAuth = Effect.fn("PiAccounts.modifyAuth")(function* (
  agentDir: string,
  /** The next contents, or undefined to leave the file as it is. */
  change: (auth: Record<string, unknown>) => Record<string, unknown> | undefined,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const authPath = NodePath.join(agentDir, AUTH_FILENAME);
  if (!(yield* fileSystem.exists(authPath).pipe(Effect.orElseSucceed(() => false)))) {
    yield* writePrivate(authPath, "{}");
  }
  const resolved = yield* fileSystem.realPath(authPath).pipe(Effect.orElseSucceed(() => authPath));
  const outcome = yield* withPiFileLock(
    `${resolved}.lock`,
    AUTH_LOCK_STALE_MS,
    Effect.gen(function* () {
      const text = yield* readText(resolved);
      const parsed = text === undefined ? Option.some({}) : decodeJsonOption(text);
      if (Option.isNone(parsed) || !isRecord(parsed.value)) {
        return yield* failFile("Pi's auth.json is not valid JSON, so T3 left it unchanged.");
      }
      const next = change({ ...parsed.value });
      if (next !== undefined) yield* fileSystem.writeFileString(resolved, serialize(next));
      return true;
    }),
  );
  if (outcome === undefined) {
    return yield* failFile("Pi is still writing its credentials. Try again in a moment.");
  }
});

const readJsonRecord = Effect.fn("PiAccounts.readJsonRecord")(function* (file: string) {
  const text = yield* readText(file);
  if (text === undefined) return undefined;
  const parsed = decodeJsonOption(text);
  return Option.isSome(parsed) && isRecord(parsed.value) ? parsed.value : undefined;
});

interface ModelsJsonAccount {
  readonly providerId: string;
  readonly providerFamily: PiAccountFamily;
  readonly label: string;
}

/** Providers models.json gives a key of their own (as `sync-pi-keys` keeps for Anthropic). */
export const listPiModelsJsonAccounts = Effect.fn("PiAccounts.readModelsJson")(function* (
  agentDir: string,
) {
  const root = yield* readJsonRecord(NodePath.join(agentDir, MODELS_FILENAME));
  const providers = root !== undefined && isRecord(root["providers"]) ? root["providers"] : {};
  return Object.entries(providers).flatMap(
    ([providerId, entry]): ReadonlyArray<ModelsJsonAccount> => {
      if (!isRecord(entry) || typeof entry["apiKey"] !== "string" || !entry["apiKey"].trim())
        return [];
      const api = typeof entry["api"] === "string" ? entry["api"] : "";
      const providerFamily: PiAccountFamily = api.startsWith("anthropic")
        ? "anthropic-api"
        : api.startsWith("openai")
          ? "openai-api"
          : "other";
      const name =
        typeof entry["name"] === "string" && entry["name"].trim()
          ? entry["name"].trim()
          : providerId;
      return [{ providerId, providerFamily, label: name }];
    },
  );
});

/** The family that decides how a slot's allowance is read: T3's record first, else the ID. */
export function piAccountFamily(
  registry: PiAccountsRegistry,
  providerId: string,
  credentialType: "oauth" | "api_key" | undefined,
): PiAccountFamily {
  return (
    registry.accounts.find((account) => account.providerId === providerId)?.providerFamily ??
    inferPiAccountFamily(providerId, credentialType)
  );
}

function credentialType(value: unknown): "oauth" | "api_key" | undefined {
  if (!isRecord(value)) return undefined;
  return value["type"] === "oauth" ? "oauth" : value["type"] === "api_key" ? "api_key" : undefined;
}

function credentialEmail(value: unknown): string | undefined {
  if (!isRecord(value) || typeof value["email"] !== "string") return undefined;
  const email = value["email"].trim();
  return email.length > 0 ? email : undefined;
}

function credentialStatus(value: unknown, nowMs: number): PiAccount["status"] {
  if (!isRecord(value)) return "missing";
  if (value["type"] === "api_key") {
    return typeof value["key"] === "string" && value["key"].length > 0 ? "signedIn" : "missing";
  }
  if (value["type"] !== "oauth") return "missing";
  const refresh = typeof value["refresh"] === "string" && value["refresh"].length > 0;
  const access = typeof value["access"] === "string" && value["access"].length > 0;
  const expires = typeof value["expires"] === "number" ? value["expires"] : undefined;
  if (refresh) return "signedIn";
  return access && (expires === undefined || expires > nowMs) ? "signedIn" : "expired";
}

const defaultLabel = (providerId: string, family: PiAccountFamily, email: string | undefined) =>
  email ?? (family === "other" ? providerId : `${FAMILY_NAME[family]} · ${providerId}`);

/** Keys auth.json holds that are not provider credentials. */
const NON_PROVIDER_KEYS = new Set(["agent"]);

export interface PiAccountsListing {
  readonly accounts: ReadonlyArray<PiAccount>;
  readonly sharedLogins: ReadonlyArray<PiAccountsSharedLogins>;
}

const antigravitySidecarAccounts = Effect.fn("PiAccounts.antigravitySidecar")(function* (
  agentDir: string,
) {
  const root = yield* readJsonRecord(NodePath.join(agentDir, ANTIGRAVITY_SIDECAR_FILENAME));
  const accounts = root !== undefined && isRecord(root["accounts"]) ? root["accounts"] : {};
  return Object.values(accounts).filter(
    (account): account is Record<string, unknown> =>
      isRecord(account) && typeof account["refresh"] === "string" && account["refresh"].length > 0,
  );
});

const commandCodeExtraKeys = Effect.fn("PiAccounts.commandCodeKeys")(function* (agentDir: string) {
  const text = yield* readText(NodePath.join(agentDir, COMMANDCODE_KEYS_FILENAME));
  const parsed = text === undefined ? Option.none() : decodeJsonOption(text);
  const value = Option.isSome(parsed) ? parsed.value : undefined;
  const list = Array.isArray(value) ? value : isRecord(value) ? value["keys"] : undefined;
  return Array.isArray(list)
    ? list
        .filter((key): key is string => typeof key === "string" && key.trim().length > 0)
        .map((key) => key.trim())
    : [];
});

export const listPiAccounts = Effect.fn("PiAccounts.list")(function* (agentDir: string) {
  const nowMs = yield* Clock.currentTimeMillis;
  const registry = yield* readPiAccountsRegistry(agentDir);
  const auth = (yield* readJsonRecord(NodePath.join(agentDir, AUTH_FILENAME))) ?? {};
  const fromModels = yield* listPiModelsJsonAccounts(agentDir);
  const registered = new Map(registry.accounts.map((account) => [account.providerId, account]));
  const accounts: Array<PiAccount> = [];
  const listed = new Set<string>();
  for (const [providerId, credential] of Object.entries(auth)) {
    if (NON_PROVIDER_KEYS.has(providerId) || !PROVIDER_ID.test(providerId)) continue;
    const type = credentialType(credential);
    if (type === undefined) continue;
    const record = registered.get(providerId);
    const family = record?.providerFamily ?? inferPiAccountFamily(providerId, type);
    const email = credentialEmail(credential);
    const modelsLabel = fromModels.find((entry) => entry.providerId === providerId)?.label;
    listed.add(providerId);
    accounts.push({
      providerId,
      providerFamily: family,
      label: record?.label ?? modelsLabel ?? defaultLabel(providerId, family, email),
      authType: type,
      status: credentialStatus(credential, nowMs),
      ...(email === undefined ? {} : { email }),
      source: "auth",
      managed: record !== undefined,
    });
  }
  for (const entry of fromModels) {
    if (listed.has(entry.providerId)) continue;
    const record = registered.get(entry.providerId);
    listed.add(entry.providerId);
    accounts.push({
      providerId: entry.providerId,
      providerFamily: record?.providerFamily ?? entry.providerFamily,
      label: record?.label ?? entry.label,
      authType: "api_key",
      status: "signedIn",
      source: "models",
      managed: record !== undefined,
    });
  }
  for (const record of registry.accounts) {
    if (listed.has(record.providerId)) continue;
    accounts.push({
      providerId: record.providerId,
      providerFamily: record.providerFamily,
      label: record.label,
      authType: null,
      status: "missing",
      source: "auth",
      managed: true,
    });
  }
  const sharedLogins: Array<PiAccountsSharedLogins> = [];
  const sidecar = yield* antigravitySidecarAccounts(agentDir);
  if (credentialType(auth["antigravity"]) === "oauth" || sidecar.length > 0) {
    sharedLogins.push({
      providerFamily: "antigravity",
      count: Math.max(1, antigravityLogins(auth["antigravity"], sidecar).length),
    });
  }
  const extraKeys = yield* commandCodeExtraKeys(agentDir);
  const commandCodeManaged = registry.accounts.some(
    (account) => account.providerFamily === "commandcode",
  );
  if (!commandCodeManaged && extraKeys.length > 0) {
    const own = commandCodeKey(auth["commandcode"]);
    sharedLogins.push({
      providerFamily: "commandcode",
      count: new Set([...(own === undefined ? [] : [own]), ...extraKeys]).size,
    });
  }
  return { accounts, sharedLogins } satisfies PiAccountsListing;
});

const takenProviderIds = Effect.fn("PiAccounts.takenIds")(function* (agentDir: string) {
  const registry = yield* readPiAccountsRegistry(agentDir);
  const auth = (yield* readJsonRecord(NodePath.join(agentDir, AUTH_FILENAME))) ?? {};
  const fromModels = yield* listPiModelsJsonAccounts(agentDir);
  return new Set([
    ...registry.accounts.map((account) => account.providerId),
    ...Object.keys(auth),
    ...fromModels.map((entry) => entry.providerId),
  ]);
});

const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

/**
 * The provider an account change targets: the existing one, or a new ID listed in the
 * registry so the extension for its family registers it before any credential exists.
 */
export const preparePiAccount = Effect.fn("PiAccounts.prepare")(function* (
  agentDir: string,
  input: {
    readonly providerId?: string | undefined;
    readonly providerFamily: PiAccountFamily;
    readonly label: string;
  },
) {
  if (input.providerId !== undefined) {
    const providerId = input.providerId;
    const known = (yield* listPiAccounts(agentDir)).accounts.find(
      (account) => account.providerId === providerId,
    );
    // Only a key for another Pi provider names a new ID; an existing one keeps its family.
    if (known ? known.providerFamily !== input.providerFamily : input.providerFamily !== "other") {
      return yield* failFile(`${providerId} is not a ${input.providerFamily} account.`);
    }
    const registry = yield* readPiAccountsRegistry(agentDir);
    const current = registry.accounts.find((account) => account.providerId === providerId);
    if (current !== undefined && current.label !== input.label) {
      yield* modifyPiAccountsRegistry(agentDir, (value) => ({
        ...value,
        accounts: value.accounts.map((account) =>
          account.providerId === providerId ? { ...account, label: input.label } : account,
        ),
      }));
    }
    return { providerId, created: false };
  }
  if (input.providerFamily === "other") {
    return yield* failFile("Choose the Pi provider this key is for.");
  }
  const family = input.providerFamily;
  const taken = yield* takenProviderIds(agentDir);
  const providerId = allocatePiProviderId(family, input.label, taken);
  const createdAt = yield* nowIso;
  yield* modifyPiAccountsRegistry(agentDir, (registry) => ({
    ...registry,
    accounts: [
      ...registry.accounts,
      { providerId, providerFamily: family, label: input.label, createdAt },
    ],
  }));
  return { providerId, created: true };
});

/** Takes a just-listed provider back out when its first sign-in did not finish. */
export const abandonPiAccount = Effect.fn("PiAccounts.abandon")(function* (
  agentDir: string,
  providerId: string,
) {
  const auth = (yield* readJsonRecord(NodePath.join(agentDir, AUTH_FILENAME))) ?? {};
  if (Object.hasOwn(auth, providerId)) return;
  yield* modifyPiAccountsRegistry(agentDir, (registry) => ({
    ...registry,
    accounts: registry.accounts.filter((account) => account.providerId !== providerId),
  }));
});

function apiKeyCredential(family: PiAccountFamily, key: string): Record<string, unknown> {
  return family === "commandcode"
    ? { type: "oauth", access: key, refresh: "", expires: COMMANDCODE_KEY_EXPIRES }
    : { type: "api_key", key };
}

function commandCodeKey(value: unknown): string | undefined {
  if (!isRecord(value)) return undefined;
  const key = value["type"] === "oauth" ? value["access"] : value["key"];
  return typeof key === "string" && key.trim().length > 0 ? key.trim() : undefined;
}

export const savePiAccountKey = Effect.fn("PiAccounts.saveKey")(function* (
  agentDir: string,
  input: {
    readonly providerId?: string | undefined;
    readonly providerFamily: PiAccountFamily;
    readonly label: string;
    readonly key: string;
  },
) {
  if (PI_OAUTH_FAMILIES.has(input.providerFamily)) {
    return yield* failFile(
      `${FAMILY_NAME[input.providerFamily]} accounts sign in; they take no key.`,
    );
  }
  if (input.providerFamily === "commandcode")
    yield* separatePiSharedLogins(agentDir, "commandcode");
  const { providerId, created } = yield* preparePiAccount(agentDir, input);
  yield* modifyPiAuth(agentDir, (auth) => ({
    ...auth,
    [providerId]: apiKeyCredential(input.providerFamily, input.key),
  })).pipe(Effect.tapError(() => (created ? abandonPiAccount(agentDir, providerId) : Effect.void)));
  // A key now in auth.json wins over a models.json command; drop the command so nothing
  // (`sync-pi-keys` included) keeps a second copy of this account's key.
  yield* removeModelsJsonKey(agentDir, providerId);
  return providerId;
});

const removeModelsJsonKey = Effect.fn("PiAccounts.removeModelsJsonKey")(function* (
  agentDir: string,
  providerId: string,
) {
  const file = NodePath.join(agentDir, MODELS_FILENAME);
  yield* withPiFileLock(
    NodePath.join(agentDir, ".t3-accounts.lock"),
    T3_LOCK_STALE_MS,
    Effect.gen(function* () {
      const text = yield* readText(file);
      const parsed = text === undefined ? Option.none() : decodeJsonOption(text);
      if (Option.isNone(parsed) || !isRecord(parsed.value)) return;
      const providers = parsed.value["providers"];
      if (!isRecord(providers)) return;
      const entry = providers[providerId];
      if (!isRecord(entry) || !("apiKey" in entry)) return;
      const { apiKey: _removed, ...rest } = entry;
      yield* writePrivate(
        file,
        serialize({ ...parsed.value, providers: { ...providers, [providerId]: rest } }),
      );
    }),
  );
});

/** Deletes the credential and T3's record of the provider; Pi stops offering it. */
export const removePiAccount = Effect.fn("PiAccounts.remove")(function* (
  agentDir: string,
  providerId: string,
) {
  yield* modifyPiAuth(agentDir, (auth) => {
    if (!Object.hasOwn(auth, providerId)) return undefined;
    const { [providerId]: _removed, ...rest } = auth;
    return rest;
  });
  yield* removeModelsJsonKey(agentDir, providerId);
  yield* modifyPiAccountsRegistry(agentDir, (registry) => ({
    ...registry,
    accounts: registry.accounts.filter((account) => account.providerId !== providerId),
  }));
});

const fresher = (a: Record<string, unknown>, b: Record<string, unknown>) =>
  Number(b["expires"] ?? 0) > Number(a["expires"] ?? 0) ? b : a;

function antigravityLogins(
  bare: unknown,
  sidecar: ReadonlyArray<Record<string, unknown>>,
): ReadonlyArray<Record<string, unknown>> {
  const logins: Array<Record<string, unknown>> = [];
  const sameLogin = (a: Record<string, unknown>, b: Record<string, unknown>) =>
    a["refresh"] === b["refresh"] ||
    (typeof a["email"] === "string" &&
      typeof b["email"] === "string" &&
      a["email"].trim().toLowerCase() === b["email"].trim().toLowerCase());
  for (const login of [
    ...(credentialType(bare) === "oauth" && isRecord(bare) ? [bare] : []),
    ...sidecar,
  ]) {
    if (typeof login["refresh"] !== "string" || !login["refresh"]) continue;
    const index = logins.findIndex((existing) => sameLogin(existing, login));
    if (index === -1) logins.push(login);
    else logins[index] = fresher(logins[index]!, login);
  }
  return logins;
}

/**
 * Gives each login one provider rotates its own provider ID. Safe to rerun after an interruption:
 * registry first, then one locked auth.json write adding every login and retiring the shared
 * entry, then the sidecar. Returns the retired ID and the account its references move to.
 */
export const separatePiSharedLogins = Effect.fn("PiAccounts.separate")(function* (
  agentDir: string,
  family: PiAccountsSharedLogins["providerFamily"],
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const auth = (yield* readJsonRecord(NodePath.join(agentDir, AUTH_FILENAME))) ?? {};
  const registry = yield* readPiAccountsRegistry(agentDir);
  const taken = new Set(yield* takenProviderIds(agentDir));
  const createdAt = yield* nowIso;
  if (family === "antigravity") {
    const sidecarPath = NodePath.join(agentDir, ANTIGRAVITY_SIDECAR_FILENAME);
    const logins = antigravityLogins(
      auth["antigravity"],
      yield* antigravitySidecarAccounts(agentDir),
    );
    const existing = Object.entries(auth).filter(
      ([id, value]) => id.startsWith("antigravity-") && isRecord(value),
    ) as Array<[string, Record<string, unknown>]>;
    const placed = logins.map((login) => {
      const match = existing.find(
        ([, value]) =>
          value["refresh"] === login["refresh"] ||
          (typeof value["email"] === "string" &&
            value["email"].toLowerCase() === String(login["email"] ?? "").toLowerCase()),
      );
      if (match !== undefined) return { providerId: match[0], login, isNew: false };
      const email = typeof login["email"] === "string" ? login["email"] : "";
      const providerId = allocatePiProviderId("antigravity", email, taken);
      taken.add(providerId);
      return { providerId, login, isNew: true };
    });
    const bareLogin = isRecord(auth["antigravity"]) ? auth["antigravity"] : undefined;
    const replacement =
      placed.find(
        (entry) => bareLogin !== undefined && entry.login["refresh"] === bareLogin["refresh"],
      )?.providerId ?? placed[0]?.providerId;
    yield* modifyPiAccountsRegistry(agentDir, (current) => ({
      ...current,
      accounts: [
        ...current.accounts,
        ...placed
          .filter(
            (entry) => !current.accounts.some((account) => account.providerId === entry.providerId),
          )
          .map((entry) => ({
            providerId: entry.providerId,
            providerFamily: "antigravity" as const,
            label:
              typeof entry.login["email"] === "string" ? entry.login["email"] : entry.providerId,
            createdAt,
          })),
      ],
      ...(replacement === undefined || registry.replacedProviderIds?.["antigravity"] !== undefined
        ? {}
        : { replacedProviderIds: { ...current.replacedProviderIds, antigravity: replacement } }),
    }));
    yield* modifyPiAuth(agentDir, (current) => {
      const next: Record<string, unknown> = { ...current };
      // Pi may have refreshed the bare login since it was read; take its tokens as they are now.
      const bareNow = isRecord(current["antigravity"]) ? current["antigravity"] : undefined;
      for (const entry of placed) {
        if (!isRecord(next[entry.providerId])) {
          const login =
            bareNow !== undefined &&
            bareLogin !== undefined &&
            entry.login["refresh"] === bareLogin["refresh"]
              ? fresher(entry.login, bareNow)
              : entry.login;
          next[entry.providerId] = {
            type: "oauth",
            access: login["access"],
            refresh: login["refresh"],
            expires: login["expires"],
            ...(typeof entry.login["email"] === "string" ? { email: entry.login["email"] } : {}),
            ...(typeof entry.login["projectId"] === "string"
              ? { projectId: entry.login["projectId"] }
              : {}),
          };
        }
      }
      delete next["antigravity"];
      return next;
    });
    yield* fileSystem.remove(sidecarPath).pipe(Effect.ignore);
    const replaced = (yield* readPiAccountsRegistry(agentDir)).replacedProviderIds?.["antigravity"];
    return replaced === undefined ? undefined : { from: "antigravity", to: replaced };
  }
  const keysPath = NodePath.join(agentDir, COMMANDCODE_KEYS_FILENAME);
  const extraKeys = yield* commandCodeExtraKeys(agentDir);
  const ownKeys = new Set(
    Object.entries(auth)
      .filter(([id]) => id === "commandcode" || id.startsWith("commandcode-"))
      .flatMap(([, value]) => {
        const key = commandCodeKey(value);
        return key === undefined ? [] : [key];
      }),
  );
  const added = [...new Set(extraKeys)]
    .filter((key) => !ownKeys.has(key))
    .map((key, index) => {
      const providerId = allocatePiProviderId("commandcode", String(index + 2), taken);
      taken.add(providerId);
      return { providerId, key, label: `Command Code · ${index + 2}` };
    });
  yield* modifyPiAccountsRegistry(agentDir, (current) => {
    const listed = new Set(current.accounts.map((account) => account.providerId));
    return {
      ...current,
      accounts: [
        ...current.accounts,
        ...(listed.has("commandcode") || !Object.hasOwn(auth, "commandcode")
          ? []
          : [
              {
                providerId: "commandcode",
                providerFamily: "commandcode" as const,
                label: "Command Code",
                createdAt,
              },
            ]),
        ...added.map((entry) => ({
          providerId: entry.providerId,
          providerFamily: "commandcode" as const,
          label: entry.label,
          createdAt,
        })),
      ],
    };
  });
  if (added.length > 0) {
    yield* modifyPiAuth(agentDir, (current) => {
      const next: Record<string, unknown> = { ...current };
      for (const entry of added) {
        if (!isRecord(next[entry.providerId]))
          next[entry.providerId] = apiKeyCredential("commandcode", entry.key);
      }
      return next;
    });
  }
  yield* fileSystem.remove(keysPath).pipe(Effect.ignore);
  return undefined;
});

/**
 * Installs the extension that registers the providers T3 clones from Pi's built-ins, where
 * Pi discovers it for its own launches and T3's alike. Rewrites it only when it changed.
 */
export const installPiAccountsExtension = Effect.fn("PiAccounts.installExtension")(function* (
  agentDir: string,
) {
  const file = NodePath.join(agentDir, "extensions", PI_ACCOUNTS_EXTENSION_FILENAME);
  if ((yield* readText(file)) === PI_ACCOUNTS_EXTENSION_SOURCE) return false;
  yield* writePrivate(file, PI_ACCOUNTS_EXTENSION_SOURCE);
  return true;
});

/** Keeps an agent dir's extension at this T3 build's source while T3 lists accounts there. */
export const refreshPiAccountsExtension = Effect.fn("PiAccounts.refreshExtension")(function* (
  agentDir: string,
) {
  if ((yield* readPiAccountsRegistry(agentDir)).accounts.length === 0) return false;
  return yield* installPiAccountsExtension(agentDir);
});

const rewriteSlug = (value: string, from: string, to: string) =>
  value.startsWith(`${from}/`) ? `${to}/${value.slice(from.length + 1)}` : value;

/**
 * Moves Pi's own references to a retired provider (its default, scoped models and compaction
 * overrides) onto the account that replaced it, under the lock T3's other settings writes use.
 */
export const movePiSettingsProvider = Effect.fn("PiAccounts.moveSettingsProvider")(function* (
  agentDir: string,
  from: string,
  to: string,
) {
  const file = NodePath.join(agentDir, "settings.json");
  return yield* withPiFileLock(
    NodePath.join(agentDir, ".t3-compaction.lock"),
    T3_LOCK_STALE_MS,
    Effect.gen(function* () {
      const text = yield* readText(file);
      const parsed = text === undefined ? Option.none() : decodeJsonOption(text);
      if (Option.isNone(parsed) || !isRecord(parsed.value)) return false;
      const root: Record<string, unknown> = { ...parsed.value };
      if (root["defaultProvider"] === from) root["defaultProvider"] = to;
      if (Array.isArray(root["enabledModels"])) {
        root["enabledModels"] = root["enabledModels"].map((entry) =>
          typeof entry === "string" ? rewriteSlug(entry, from, to) : entry,
        );
      }
      const compaction = root["compaction"];
      if (isRecord(compaction) && isRecord(compaction["modelOverrides"])) {
        root["compaction"] = {
          ...compaction,
          modelOverrides: Object.fromEntries(
            Object.entries(compaction["modelOverrides"]).map(([key, value]) => [
              rewriteSlug(key, from, to),
              value,
            ]),
          ),
        };
      }
      const next = serializeSettings(root);
      if (next === text) return false;
      return yield* writeFile(file, next);
    }),
  );
});
