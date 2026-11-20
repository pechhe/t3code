import type { ServerProviderUsageSlot, ServerProviderUsageWindow } from "@t3tools/contracts";
import { expandHomePath } from "@t3tools/provider-core/server/pathExpansion";
import {
  clampPercent,
  makeUnavailableUsageLimits,
  makeUsageLimits,
} from "@t3tools/provider-core/server/usageLimits";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Clock from "effect/Clock";
import * as Digest from "effect/crypto/Digest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientRequest from "effect/http/HttpClientRequest";
import * as HttpClientResponse from "effect/http/HttpClientResponse";

/**
 * Reads allowance per `~/.pi/agent/auth.json` entry (and `~/.pi/agent/antigravity-accounts.json`
 * for linked Google accounts) rather than per Pi instance.
 *
 * @module usageSlots
 */

const OauthCredential = Schema.Struct({
  type: Schema.Literal("oauth"),
  access: Schema.optional(Schema.String),
  refresh: Schema.optional(Schema.String),
  expires: Schema.optional(Schema.Number),
  accountId: Schema.optional(Schema.String),
  email: Schema.optional(Schema.String),
  projectId: Schema.optional(Schema.String),
});
const ApiKeyCredential = Schema.Struct({
  type: Schema.Literal("api_key"),
  key: Schema.optional(Schema.String),
});
const Credential = Schema.Union([OauthCredential, ApiKeyCredential]);

type OauthCredential = typeof OauthCredential.Type;
type ApiKeyCredential = typeof ApiKeyCredential.Type;
type Credential = typeof Credential.Type;

const AuthFile = Schema.Record(Schema.String, Schema.Unknown);
const AntigravityStoredAccount = Schema.Struct({
  accountId: Schema.optional(Schema.String),
  access: Schema.optional(Schema.String),
  refresh: Schema.optional(Schema.String),
  expires: Schema.optional(Schema.Number),
  email: Schema.optional(Schema.String),
  projectId: Schema.optional(Schema.String),
  addedAt: Schema.optional(Schema.Number),
  lastUsedAt: Schema.optional(Schema.Number),
});
const AntigravityAccountsFile = Schema.Struct({
  version: Schema.optional(Schema.Number),
  activeAccountId: Schema.optional(Schema.String),
  accounts: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
});
const GoogleTokenResponse = Schema.Struct({
  access_token: Schema.NonEmptyString,
  expires_in: Schema.Number.check(Schema.isGreaterThan(0)),
});

const decodeAuthFile = Schema.decodeEffect(Schema.fromJsonString(AuthFile));
const decodeAntigravityAccountsFile = Schema.decodeEffect(
  Schema.fromJsonString(AntigravityAccountsFile),
);
const decodeAntigravityStoredAccount = Schema.decodeUnknownOption(AntigravityStoredAccount);
const decodeCredential = Schema.decodeUnknownOption(Credential);

/** Only an unexpired access token can be used; refreshing is Pi's job, not a probe's. */
const usableAccess = (credential: OauthCredential, nowMs: number): string | undefined =>
  credential.access !== undefined &&
  credential.access.length > 0 &&
  (credential.expires === undefined || credential.expires > nowMs)
    ? credential.access
    : undefined;

const AUTH_DIRECTORY = ".pi/agent";
const AUTH_FILE = "auth.json";
const ANTIGRAVITY_ACCOUNTS_FILE = "antigravity-accounts.json";
const ANTIGRAVITY_OAUTH_RELATIVE_PATH = [
  "npm",
  "node_modules",
  "pi-antigravity",
  "src",
  "auth",
  "oauth.ts",
] as const;
const GOOGLE_TOKEN_URL = "https://oauth2.googleapis.com/token";
const ANTIGRAVITY_DAILY = "https://daily-cloudcode-pa.googleapis.com";
const ANTIGRAVITY_PROD = "https://cloudcode-pa.googleapis.com";
const OPENCODE_GO_USAGE = "https://opencode.ai/zen/go/v1/usage";
const ANTHROPIC_USAGE = "https://api.anthropic.com/api/oauth/usage";
const OPENAI_CODEX_USAGE = "https://chatgpt.com/backend-api/wham/usage";

export interface AntigravityCachedToken {
  readonly access: string;
  readonly expires: number;
}

const ANTIGRAVITY_TOKEN_REFRESH_SKEW_MS = 60_000;

/** Matches the Antigravity client's own User-Agent so its quota host answers as it does for it. */
const antigravityUserAgent = (platform: NodeJS.Platform, architecture: NodeJS.Architecture) =>
  `antigravity/hub/2.24.0 (aidev_client; os_type=${platform}; arch=${architecture}; cl=963137146)`;

const Quota = Schema.Struct({
  remainingFraction: Schema.optional(Schema.Number),
  resetTime: Schema.optional(Schema.String),
});
const Bucket = Schema.Struct({
  ...Quota.fields,
  bucketId: Schema.NonEmptyString,
  window: Schema.optional(Schema.String),
  displayName: Schema.optional(Schema.String),
  disabled: Schema.optional(Schema.Boolean),
});
const AntigravitySummary = Schema.Struct({
  groups: Schema.optional(
    Schema.Array(
      Schema.Struct({
        displayName: Schema.optional(Schema.String),
        buckets: Schema.optional(Schema.Array(Bucket)),
      }),
    ),
  ),
  buckets: Schema.optional(Schema.Array(Bucket)),
});

const OpenCodeUsage = Schema.Struct({
  usage: Schema.Struct({
    rolling: Schema.Struct({ percent: Schema.Finite, resetsAt: Schema.DateTimeUtcFromString }),
    weekly: Schema.Struct({ percent: Schema.Finite, resetsAt: Schema.DateTimeUtcFromString }),
    monthly: Schema.Struct({ percent: Schema.Finite, resetsAt: Schema.DateTimeUtcFromString }),
  }),
});

const AnthropicWindow = Schema.Struct({
  utilization: Schema.Finite,
  resets_at: Schema.optional(Schema.NullOr(Schema.String)),
});
const AnthropicUsage = Schema.Struct({
  five_hour: Schema.optional(Schema.NullOr(AnthropicWindow)),
  seven_day: Schema.optional(Schema.NullOr(AnthropicWindow)),
});

const CodexWindow = Schema.Struct({
  used_percent: Schema.Finite,
  limit_window_seconds: Schema.Finite,
  reset_after_seconds: Schema.Finite,
  reset_at: Schema.optional(Schema.NullOr(Schema.Finite)),
});
const CodexUsage = Schema.Struct({
  email: Schema.optional(Schema.String),
  plan_type: Schema.optional(Schema.String),
  rate_limit: Schema.Struct({
    primary_window: Schema.optional(Schema.NullOr(CodexWindow)),
    secondary_window: Schema.optional(Schema.NullOr(CodexWindow)),
  }),
});

const decodeAntigravitySummary = Schema.decodeUnknownEffect(AntigravitySummary);
const decodeOpenCodeUsage = Schema.decodeUnknownEffect(OpenCodeUsage);
const decodeAnthropicUsage = Schema.decodeUnknownEffect(AnthropicUsage);
const decodeCodexUsage = Schema.decodeUnknownEffect(CodexUsage);
void decodeAntigravitySummary;
void decodeOpenCodeUsage;
void decodeAnthropicUsage;
void decodeCodexUsage;

/** The window length in whole minutes; a window shorter than a minute carries none. */
function durationMins(seconds: number): number | undefined {
  if (!Number.isFinite(seconds) || seconds < 60) return undefined;
  return Math.round(seconds / 60);
}

function codexWindows(usage: typeof CodexUsage.Type, nowMs: number): ServerProviderUsageWindow[] {
  return (
    [
      ["primary_window", "codex-primary"],
      ["secondary_window", "codex-secondary"],
    ] as const
  ).flatMap(([key, id]) => {
    const window = usage.rate_limit[key];
    if (!window) return [];
    const duration = durationMins(window.limit_window_seconds);
    const weekly = duration !== undefined && duration >= 10_080;
    const session = duration !== undefined && duration <= 300;
    const label = weekly ? "Weekly" : session ? "Session" : "Usage";
    const resetSeconds = window.reset_at ?? nowMs / 1000 + window.reset_after_seconds;
    return [
      {
        id,
        kind: weekly ? ("weekly" as const) : session ? ("session" as const) : ("other" as const),
        label,
        usedPercent: clampPercent(window.used_percent),
        ...(duration === undefined ? {} : { windowDurationMins: duration }),
        resetsAt: DateTime.formatIso(DateTime.makeUnsafe(resetSeconds * 1000)),
      },
    ];
  });
}

function iso(value: string | null | undefined): string | undefined {
  const parsed = value == null || value.length === 0 ? Option.none() : DateTime.make(value);
  return Option.isSome(parsed) ? DateTime.formatIso(parsed.value) : undefined;
}

/** Each reported bucket's window, or undefined for one the host reports disabled or without a reading. */
function antigravityBuckets(
  summary: typeof AntigravitySummary.Type,
): Map<string, ServerProviderUsageWindow | undefined> {
  const windows = new Map<string, ServerProviderUsageWindow | undefined>();
  const groups = summary.groups?.some((group) => group.buckets?.length)
    ? (summary.groups ?? [])
    : [{ displayName: undefined, buckets: summary.buckets ?? [] }];
  for (const group of groups) {
    const groupDisplayName = group.displayName?.trim();
    for (const bucket of group.buckets ?? []) {
      const remaining = bucket.remainingFraction;
      if (bucket.disabled === true || remaining === undefined || !Number.isFinite(remaining)) {
        windows.set(bucket.bucketId, undefined);
        continue;
      }
      const session = bucket.window === "5h";
      const weekly = bucket.window === "weekly";
      const resetsAt = iso(bucket.resetTime);
      const family = bucket.bucketId.startsWith("gemini-argon-")
        ? groupDisplayName && /argon/i.test(groupDisplayName)
          ? groupDisplayName
          : "Gemini 4 Argon"
        : bucket.bucketId.startsWith("gemini-carbon-")
          ? groupDisplayName && /carbon/i.test(groupDisplayName)
            ? groupDisplayName
            : "Gemini Carbon"
          : bucket.bucketId.startsWith("gemini-")
            ? "Gemini"
            : bucket.bucketId.startsWith("3p-")
              ? "Claude & GPT (shared)"
              : groupDisplayName;
      const cadence = weekly
        ? "Weekly"
        : session
          ? "5-hour"
          : bucket.displayName?.trim() || "Quota";
      const label =
        family === undefined
          ? bucket.displayName?.trim() || bucket.bucketId
          : !session &&
              !weekly &&
              bucket.displayName?.trim().toLowerCase().startsWith(family.toLowerCase())
            ? bucket.displayName.trim()
            : `${family} · ${cadence}`;
      windows.set(bucket.bucketId, {
        id: bucket.bucketId,
        kind: session ? "session" : weekly ? "weekly" : "other",
        label,
        usedPercent: (1 - Math.max(0, Math.min(1, remaining))) * 100,
        ...(session
          ? { windowDurationMins: 5 * 60 }
          : weekly
            ? { windowDurationMins: 7 * 24 * 60 }
            : {}),
        ...(resetsAt === undefined ? {} : { resetsAt }),
      });
    }
  }
  return windows;
}

function anthropicWindows(usage: typeof AnthropicUsage.Type): ServerProviderUsageWindow[] {
  const windows: ServerProviderUsageWindow[] = [];
  const fiveHour = usage.five_hour;
  if (fiveHour) {
    const resetsAt = iso(fiveHour.resets_at);
    windows.push({
      id: "five_hour",
      kind: "session",
      label: "Session",
      windowDurationMins: 5 * 60,
      usedPercent: clampPercent(fiveHour.utilization),
      ...(resetsAt === undefined ? {} : { resetsAt }),
    });
  }
  const weekly = usage.seven_day;
  if (weekly) {
    const resetsAt = iso(weekly.resets_at);
    windows.push({
      id: "seven_day",
      kind: "weekly",
      label: "Weekly",
      windowDurationMins: 7 * 24 * 60,
      usedPercent: clampPercent(weekly.utilization),
      ...(resetsAt === undefined ? {} : { resetsAt }),
    });
  }
  return windows;
}

function openCodeWindows(usage: (typeof OpenCodeUsage.Type)["usage"]): ServerProviderUsageWindow[] {
  return [
    {
      id: "go_rolling",
      kind: "session",
      label: "Go · Session",
      windowDurationMins: 5 * 60,
      usedPercent: clampPercent(usage.rolling.percent),
      resetsAt: DateTime.formatIso(usage.rolling.resetsAt),
    },
    {
      id: "go_weekly",
      kind: "weekly",
      label: "Go · Weekly",
      windowDurationMins: 7 * 24 * 60,
      usedPercent: clampPercent(usage.weekly.percent),
      resetsAt: DateTime.formatIso(usage.weekly.resetsAt),
    },
    {
      id: "go_monthly",
      kind: "monthly",
      label: "Go · Monthly",
      usedPercent: clampPercent(usage.monthly.percent),
      resetsAt: DateTime.formatIso(usage.monthly.resetsAt),
    },
  ];
}

/** A credential names the same account on another machine only when its secret matches. */
const accountFingerprint = Effect.fn("PiUsageSlots.accountFingerprint")(function* (
  accountKey: string,
  credential: Credential,
) {
  const digest = yield* Digest.Digest;
  const material =
    credential.type === "oauth"
      ? (credential.accountId ?? credential.email ?? credential.refresh ?? credential.access ?? "")
      : (credential.key ?? "");
  const hash = yield* digest
    .digest(Digest.sha256, new TextEncoder().encode(`${accountKey}\0${material}`))
    .pipe(Effect.orDie);
  return Array.from(hash, (byte) => byte.toString(16).padStart(2, "0")).join("");
});

function slotLabel(accountKey: string, credential: Credential): string {
  const account =
    credential.type === "oauth" ? (credential.email ?? credential.accountId) : undefined;
  return account === undefined ? accountKey : `${accountKey} · ${account}`;
}

const unavailable = (
  input: {
    readonly accountKey: string;
    readonly label: string;
    readonly account: string;
    readonly checkedAt: string;
  },
  reason: "unsupported" | "probeFailed",
  message: string,
): ServerProviderUsageSlot => ({
  accountKey: input.accountKey,
  label: input.label,
  account: input.account,
  usageLimits: makeUnavailableUsageLimits({ checkedAt: input.checkedAt, reason, message }),
});

const withWindows = (
  input: { readonly accountKey: string; readonly label: string; readonly account: string },
  checkedAt: string,
  windows: ReadonlyArray<ServerProviderUsageWindow>,
): ServerProviderUsageSlot => ({
  accountKey: input.accountKey,
  label: input.label,
  account: input.account,
  usageLimits: makeUsageLimits({ checkedAt, windows }),
});

interface AntigravityAccountEntry {
  readonly accountId: string;
  readonly addedAt: number;
  readonly credential: OauthCredential;
  readonly fromAccountsStore: boolean;
}

function normalizedEmail(email: string | undefined): string | undefined {
  const trimmed = email?.trim().toLowerCase();
  return trimmed && trimmed.length > 0 ? trimmed : undefined;
}

function pickFresherCredential(a: OauthCredential, b: OauthCredential): OauthCredential {
  const aHasAccess = typeof a.access === "string" && a.access.length > 0;
  const bHasAccess = typeof b.access === "string" && b.access.length > 0;
  const preferB =
    (!aHasAccess && bHasAccess) || (bHasAccess && (b.expires ?? 0) > (a.expires ?? 0));
  const primary = preferB ? b : a;
  const secondary = preferB ? a : b;
  return {
    type: "oauth",
    access: primary.access ?? secondary.access,
    refresh: primary.refresh ?? secondary.refresh,
    expires: primary.expires ?? secondary.expires,
    accountId: primary.accountId ?? secondary.accountId,
    email: primary.email ?? secondary.email,
    projectId: primary.projectId ?? secondary.projectId,
  };
}

function extractAtobConstant(source: string, constantName: string): string | undefined {
  const match = new RegExp(
    `export\\s+const\\s+${constantName}\\b[\\s\\S]*?atob\\(([\\s\\S]*?)\\)`,
  ).exec(source);
  if (!match?.[1]) return undefined;
  const parts = [...match[1].matchAll(/["']([^"']+)["']/g)].map((part) => part[1]);
  if (parts.length === 0) return undefined;
  const decoded = Buffer.from(parts.join(""), "base64").toString("utf8").trim();
  return decoded.length > 0 ? decoded : undefined;
}

function readAntigravityClientFromEnvironment(environment: NodeJS.ProcessEnv): {
  readonly clientId: string | undefined;
  readonly clientSecret: string | undefined;
} {
  return {
    clientId: environment.ANTIGRAVITY_CLIENT_ID?.trim() || environment.NOAGY_CLIENT_ID?.trim(),
    clientSecret:
      environment.ANTIGRAVITY_CLIENT_SECRET?.trim() || environment.NOAGY_CLIENT_SECRET?.trim(),
  };
}

function collectAntigravityAccounts(
  storedRaw: typeof AntigravityAccountsFile.Type | undefined,
  authAntigravity: Credential | undefined,
): ReadonlyArray<AntigravityAccountEntry> {
  const entries: Array<AntigravityAccountEntry> = [];
  if (storedRaw?.accounts) {
    for (const [key, raw] of Object.entries(storedRaw.accounts)) {
      const parsed = decodeAntigravityStoredAccount(raw);
      if (Option.isNone(parsed)) continue;
      const account = parsed.value;
      if (typeof account.refresh !== "string" || account.refresh.length === 0) continue;
      const accountId = account.accountId?.trim() || normalizedEmail(account.email) || key.trim();
      if (!accountId) continue;
      const existingIndex = entries.findIndex(
        (entry) =>
          entry.accountId === accountId ||
          entry.credential.refresh === account.refresh ||
          (normalizedEmail(account.email) !== undefined &&
            normalizedEmail(entry.credential.email) === normalizedEmail(account.email)),
      );
      const nextEntry: AntigravityAccountEntry = {
        accountId,
        addedAt: account.addedAt ?? 0,
        fromAccountsStore: true,
        credential: {
          type: "oauth",
          ...(account.access === undefined ? {} : { access: account.access }),
          refresh: account.refresh,
          ...(account.expires === undefined ? {} : { expires: account.expires }),
          accountId,
          ...(account.email === undefined ? {} : { email: account.email }),
          ...(account.projectId === undefined ? {} : { projectId: account.projectId }),
        },
      };
      if (existingIndex >= 0) {
        const previous = entries[existingIndex]!;
        entries[existingIndex] = {
          ...previous,
          addedAt: Math.min(previous.addedAt, nextEntry.addedAt),
          credential: pickFresherCredential(previous.credential, nextEntry.credential),
        };
      } else {
        entries.push(nextEntry);
      }
    }
  }
  entries.sort(
    (left, right) => left.addedAt - right.addedAt || left.accountId.localeCompare(right.accountId),
  );
  if (authAntigravity?.type === "oauth") {
    const authEmail = normalizedEmail(authAntigravity.email);
    const matchIndex = entries.findIndex(
      (entry) =>
        (authAntigravity.refresh !== undefined &&
          authAntigravity.refresh.length > 0 &&
          entry.credential.refresh === authAntigravity.refresh) ||
        (authEmail !== undefined && normalizedEmail(entry.credential.email) === authEmail),
    );
    if (matchIndex >= 0) {
      const matched = entries[matchIndex]!;
      entries[matchIndex] = {
        ...matched,
        credential: pickFresherCredential(matched.credential, authAntigravity),
      };
    } else {
      const fallbackId = authEmail || authAntigravity.accountId?.trim() || "antigravity";
      entries.push({
        accountId: fallbackId,
        addedAt: Number.MAX_SAFE_INTEGER,
        fromAccountsStore: false,
        credential: authAntigravity,
      });
    }
  }
  return entries;
}

/**
 * Reads each stored Pi credential and asks its provider what allowance is left. Providers with
 * no quota endpoint keep an `unsupported` reading rather than a guessed figure, and a failed
 * call says so, so Usage can show the last known windows as stale.
 */
export const probePiUsageSlots = Effect.fn("PiUsageSlots.probePiUsageSlots")(function* (input: {
  readonly environment: NodeJS.ProcessEnv;
  readonly antigravityTokenCache?: Map<string, AntigravityCachedToken>;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const platform = yield* HostProcess.Platform;
  const architecture = yield* HostProcess.Architecture;
  const client = (yield* HttpClient.HttpClient).pipe(HttpClient.filterStatusOk);
  const home =
    // Ki: probe the environment the provider runs with, so an instance's own home is honoured.
    input.environment.HOME ?? input.environment.USERPROFILE ?? (yield* HostProcess.HomeDirectory);
  const configuredAgentDir = input.environment.PI_CODING_AGENT_DIR?.trim();
  const agentDir = configuredAgentDir
    ? path.resolve(expandHomePath(configuredAgentDir, home))
    : path.join(home, AUTH_DIRECTORY);
  const authPath = path.join(agentDir, AUTH_FILE);
  const antigravityAccountsPath = path.join(agentDir, ANTIGRAVITY_ACCOUNTS_FILE);
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const nowMs = yield* Clock.currentTimeMillis;
  const tokenCache = input.antigravityTokenCache ?? new Map<string, AntigravityCachedToken>();
  const fileOption = yield* fs.readFileString(authPath).pipe(
    Effect.flatMap((contents) => decodeAuthFile(contents)),
    Effect.catchTags({
      PlatformError: (error) =>
        error.reason._tag === "NotFound"
          ? Effect.succeed<Record<string, unknown>>({})
          : Effect.fail(error),
    }),
    Effect.asSome,
    Effect.catchCause(() => Effect.succeedNone),
  );
  if (Option.isNone(fileOption)) {
    return null;
  }
  const file = fileOption.value;
  const antigravityAccountsOption = yield* fs.readFileString(antigravityAccountsPath).pipe(
    Effect.flatMap((contents) => decodeAntigravityAccountsFile(contents)),
    Effect.asSome,
    Effect.catchCause(() => Effect.succeedNone),
  );

  const resolveAntigravityClient = Effect.fn("PiUsageSlots.resolveAntigravityClient")(function* () {
    const fromEnv = readAntigravityClientFromEnvironment(input.environment);
    if (fromEnv.clientId && fromEnv.clientSecret) {
      return { clientId: fromEnv.clientId, clientSecret: fromEnv.clientSecret };
    }
    const oauthPath = path.join(agentDir, ...ANTIGRAVITY_OAUTH_RELATIVE_PATH);
    const oauthSource = yield* fs.readFileString(oauthPath).pipe(
      Effect.asSome,
      Effect.catchCause(() => Effect.succeedNone),
    );
    if (Option.isNone(oauthSource)) return undefined;
    const clientId = fromEnv.clientId ?? extractAtobConstant(oauthSource.value, "CLIENT_ID");
    const clientSecret =
      fromEnv.clientSecret ?? extractAtobConstant(oauthSource.value, "CLIENT_SECRET");
    return clientId && clientSecret ? { clientId, clientSecret } : undefined;
  });

  const resolveAntigravityAccess = Effect.fn("PiUsageSlots.resolveAntigravityAccess")(function* (
    credential: OauthCredential,
    fromAccountsStore: boolean,
  ) {
    const direct = usableAccess(credential, nowMs);
    if (direct !== undefined) return direct;
    // Only refresh idle multi-account store entries in memory; single auth.json entries remain owned by Pi.
    if (!fromAccountsStore || !credential.refresh) return undefined;
    const cached = tokenCache.get(credential.refresh);
    if (cached !== undefined && cached.expires > nowMs + ANTIGRAVITY_TOKEN_REFRESH_SKEW_MS) {
      return cached.access;
    }
    const clientCredentials = yield* resolveAntigravityClient();
    if (clientCredentials === undefined) return undefined;
    const refreshed = yield* client
      .execute(
        HttpClientRequest.post(GOOGLE_TOKEN_URL).pipe(
          HttpClientRequest.bodyUrlParams({
            client_id: clientCredentials.clientId,
            client_secret: clientCredentials.clientSecret,
            refresh_token: credential.refresh,
            grant_type: "refresh_token",
          }),
        ),
      )
      .pipe(
        Effect.flatMap(HttpClientResponse.schemaBodyJson(GoogleTokenResponse)),
        Effect.timeout("10 seconds"),
        Effect.asSome,
        Effect.catchCause(() => Effect.succeedNone),
      );
    if (Option.isNone(refreshed)) return undefined;
    tokenCache.set(credential.refresh, {
      access: refreshed.value.access_token,
      expires: nowMs + refreshed.value.expires_in * 1000,
    });
    return refreshed.value.access_token;
  });

  const probeSlot = Effect.fn("PiUsageSlots.readSlot")(function* (
    base: { readonly accountKey: string; readonly label: string; readonly account: string },
    credential: Credential,
    options?: { readonly isAntigravity?: boolean; readonly fromAccountsStore?: boolean },
  ) {
    const { accountKey } = base;
    if (options?.isAntigravity === true || accountKey === "antigravity") {
      if (credential.type !== "oauth") {
        return unavailable(
          { ...base, checkedAt },
          "probeFailed",
          "Antigravity credentials are missing or expired. Run `pi` and sign in again.",
        );
      }
      const access = yield* resolveAntigravityAccess(
        credential,
        options?.fromAccountsStore === true,
      );
      if (access === undefined) {
        return unavailable(
          { ...base, checkedAt },
          "probeFailed",
          "Antigravity credentials are missing or expired. Run `pi` and sign in again.",
        );
      }
      const body = credential.projectId ? { project: credential.projectId } : {};
      const perEndpoint = yield* Effect.forEach(
        [ANTIGRAVITY_DAILY, ANTIGRAVITY_PROD],
        (endpoint) =>
          client
            .execute(
              HttpClientRequest.post(`${endpoint}/v1internal:retrieveUserQuotaSummary`).pipe(
                HttpClientRequest.setHeaders({
                  Authorization: `Bearer ${access}`,
                  "User-Agent": antigravityUserAgent(platform, architecture),
                }),
                HttpClientRequest.bodyJsonUnsafe(body),
              ),
            )
            .pipe(
              Effect.flatMap(HttpClientResponse.schemaBodyJson(AntigravitySummary)),
              Effect.map(antigravityBuckets),
              Effect.timeout("10 seconds"),
              Effect.orElseSucceed(() => new Map<string, ServerProviderUsageWindow | undefined>()),
            ),
        { concurrency: 2 },
      );
      // Pi's sign-ins are metered on the daily host, so its reading of a bucket, disabled included,
      // wins; cloudcode-pa only fills buckets daily leaves out.
      const buckets = new Map<string, ServerProviderUsageWindow | undefined>();
      for (const [id, window] of perEndpoint.flatMap((answer) => [...answer])) {
        if (!buckets.has(id)) buckets.set(id, window);
      }
      const windows = [...buckets.values()].filter((window) => window !== undefined);
      return windows.length === 0
        ? unavailable(
            { ...base, checkedAt },
            "probeFailed",
            "Antigravity did not return usable quota information.",
          )
        : withWindows(base, checkedAt, windows);
    }

    if (accountKey === "opencode-go") {
      const key = credential.type === "api_key" ? credential.key : undefined;
      if (key === undefined || key.length === 0) {
        return unavailable(
          { ...base, checkedAt },
          "probeFailed",
          "No OpenCode Go API key is stored.",
        );
      }
      return yield* client
        .execute(HttpClientRequest.get(OPENCODE_GO_USAGE).pipe(HttpClientRequest.bearerToken(key)))
        .pipe(
          Effect.flatMap(HttpClientResponse.schemaBodyJson(OpenCodeUsage)),
          Effect.map((response) => withWindows(base, checkedAt, openCodeWindows(response.usage))),
          Effect.timeout("10 seconds"),
          Effect.orElseSucceed(() =>
            unavailable({ ...base, checkedAt }, "probeFailed", "OpenCode Go could not read usage."),
          ),
        );
    }

    if (accountKey === "openai-codex") {
      const access = credential.type === "oauth" ? usableAccess(credential, nowMs) : undefined;
      if (access === undefined || credential.type !== "oauth") {
        return unavailable(
          { ...base, checkedAt },
          "probeFailed",
          "OpenAI Codex credentials are missing or expired. Run `pi` and sign in again.",
        );
      }
      return yield* client
        .execute(
          HttpClientRequest.get(OPENAI_CODEX_USAGE).pipe(
            HttpClientRequest.bearerToken(access),
            HttpClientRequest.setHeaders({ "User-Agent": "pi/1.5.9" }),
          ),
        )
        .pipe(
          Effect.flatMap(HttpClientResponse.schemaBodyJson(CodexUsage)),
          Effect.map((response) => withWindows(base, checkedAt, codexWindows(response, nowMs))),
          Effect.timeout("10 seconds"),
          Effect.orElseSucceed(() =>
            unavailable(
              { ...base, checkedAt },
              "probeFailed",
              "OpenAI Codex could not read usage.",
            ),
          ),
        );
    }

    // Claude subscription accounts expose the same rate-limit buckets their CLI reports.
    if (accountKey.startsWith("claude-subscription-")) {
      const access = credential.type === "oauth" ? usableAccess(credential, nowMs) : undefined;
      if (access === undefined || credential.type !== "oauth") {
        return unavailable(
          { ...base, checkedAt },
          "probeFailed",
          "Claude credentials are missing or expired. Run `pi` and sign in again.",
        );
      }
      return yield* client
        .execute(
          HttpClientRequest.get(ANTHROPIC_USAGE).pipe(
            HttpClientRequest.bearerToken(access),
            HttpClientRequest.setHeaders({ "anthropic-beta": "oauth-2025-04-20" }),
          ),
        )
        .pipe(
          Effect.flatMap(HttpClientResponse.schemaBodyJson(AnthropicUsage)),
          Effect.map((response) => withWindows(base, checkedAt, anthropicWindows(response))),
          Effect.timeout("10 seconds"),
          Effect.orElseSucceed(() =>
            unavailable({ ...base, checkedAt }, "probeFailed", "Claude could not read usage."),
          ),
        );
    }

    // An API key reports no remaining credit, so its allowance comes from a budget, not a probe.
    if (credential.type === "api_key") {
      return {
        ...unavailable(
          { ...base, checkedAt },
          "unsupported",
          "Set a monthly budget to track this account's spend.",
        ),
        metered: true,
      };
    }
    return unavailable(
      { ...base, checkedAt },
      "probeFailed",
      "This account's provider reports no usage limits to T3.",
    );
  });

  interface PreparedSlot {
    readonly base: {
      readonly accountKey: string;
      readonly label: string;
      readonly account: string;
    };
    readonly credential: Credential | null;
    readonly isAntigravity?: boolean;
    readonly fromAccountsStore?: boolean;
  }

  const rawAuthAntigravity = Object.hasOwn(file, "antigravity") ? file.antigravity : undefined;
  const authAntigravityCredential =
    rawAuthAntigravity === undefined ? Option.none() : decodeCredential(rawAuthAntigravity);
  const antigravityAccounts = collectAntigravityAccounts(
    Option.getOrUndefined(antigravityAccountsOption),
    Option.getOrUndefined(authAntigravityCredential),
  );

  const entries = Object.entries(file).filter(
    ([accountKey]) =>
      accountKey.trim().length > 0 && accountKey !== "agent" && accountKey !== "antigravity",
  );
  const preparedAuthEntries: Array<PreparedSlot> = yield* Effect.forEach(
    entries,
    ([accountKey, raw]) =>
      Effect.gen(function* () {
        const credential = decodeCredential(raw);
        if (Option.isNone(credential)) {
          return {
            base: { accountKey, label: accountKey, account: accountKey },
            credential: null,
          };
        }
        return {
          base: {
            accountKey,
            label: slotLabel(accountKey, credential.value),
            account: yield* accountFingerprint(accountKey, credential.value),
          },
          credential: credential.value,
        };
      }),
  );

  const preparedAntigravityEntries: Array<PreparedSlot> =
    antigravityAccounts.length === 0 && rawAuthAntigravity !== undefined
      ? [
          {
            base: { accountKey: "antigravity", label: "antigravity", account: "antigravity" },
            credential: null,
            isAntigravity: true,
          },
        ]
      : yield* Effect.forEach(antigravityAccounts, (entry, index) =>
          Effect.gen(function* () {
            const accountKey = index === 0 ? "antigravity" : `antigravity:${entry.accountId}`;
            return {
              base: {
                accountKey,
                label: slotLabel("antigravity", entry.credential),
                account: yield* accountFingerprint("antigravity", entry.credential),
              },
              credential: entry.credential,
              isAntigravity: true,
              fromAccountsStore: entry.fromAccountsStore,
            };
          }),
        );

  const preparedEntries: Array<PreparedSlot> = [
    ...preparedAntigravityEntries,
    ...preparedAuthEntries,
  ];

  const timedOutSlots = (): ReadonlyArray<ServerProviderUsageSlot> =>
    preparedEntries.map(({ base, credential }) =>
      credential === null
        ? unavailable(
            { ...base, checkedAt },
            "probeFailed",
            "T3 cannot read this credential's format.",
          )
        : unavailable({ ...base, checkedAt }, "probeFailed", "Usage quota check timed out."),
    );

  return yield* Effect.forEach(
    preparedEntries,
    ({ base, credential, isAntigravity, fromAccountsStore }) =>
      credential === null
        ? Effect.succeed(
            unavailable(
              { ...base, checkedAt },
              "probeFailed",
              "T3 cannot read this credential's format.",
            ),
          )
        : probeSlot(base, credential, {
            ...(isAntigravity === undefined ? {} : { isAntigravity }),
            ...(fromAccountsStore === undefined ? {} : { fromAccountsStore }),
          }).pipe(
            Effect.timeout("12 seconds"),
            Effect.catchCause(() =>
              Effect.succeed(
                unavailable({ ...base, checkedAt }, "probeFailed", "Usage quota check timed out."),
              ),
            ),
          ),
    { concurrency: 4 },
  ).pipe(
    Effect.timeout("15 seconds"),
    // A quota reading is advisory: no defect, timeout or missing host may fail provider status.
    Effect.catchCause(() => Effect.succeed(timedOutSlots())),
  );
});

export const readPiUsageSlots = Effect.fn("PiUsageSlots.readPiUsageSlots")(function* (input: {
  readonly environment: NodeJS.ProcessEnv;
  readonly antigravityTokenCache?: Map<string, AntigravityCachedToken>;
}) {
  return (
    (yield* probePiUsageSlots(input).pipe(Effect.catchCause(() => Effect.succeed(null)))) ?? []
  );
});

/**
 * Keeps a slot's last known quota windows visible as stale when a subsequent poll fails
 * for the same credential identity, while discarding them if the credential changed.
 * Passing `null` means reading the credential store itself failed, so all prior slots stay
 * visible with a `probeFailed` notice.
 */
export function retainPriorUsageSlots(
  previous: ReadonlyArray<ServerProviderUsageSlot>,
  probed: ReadonlyArray<ServerProviderUsageSlot> | null,
  checkedAt?: string,
): ReadonlyArray<ServerProviderUsageSlot> {
  if (probed === null) {
    return previous.map((slot) => ({
      ...slot,
      usageLimits: {
        ...slot.usageLimits,
        ...(checkedAt === undefined ? {} : { checkedAt }),
        unavailable: {
          reason: "probeFailed" as const,
          message: "Could not read Pi credentials.",
        },
      },
    }));
  }
  if (previous.length === 0) return probed;
  const byKey = new Map(previous.map((slot) => [slot.accountKey, slot] as const));
  return probed.map((slot) => {
    if (slot.usageLimits.unavailable?.reason !== "probeFailed") return slot;
    const prior = byKey.get(slot.accountKey);
    if (
      prior === undefined ||
      prior.account !== slot.account ||
      prior.usageLimits.windows.length === 0
    ) {
      return slot;
    }
    return {
      ...slot,
      usageLimits: {
        ...slot.usageLimits,
        windows: prior.usageLimits.windows,
      },
    };
  });
}

export type { ApiKeyCredential, OauthCredential };
