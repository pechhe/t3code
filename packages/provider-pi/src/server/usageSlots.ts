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

import type { PiAccountFamily } from "@t3tools/contracts";
import { listPiModelsJsonAccounts, piAccountFamily, readPiAccountsRegistry } from "./accounts.ts";

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
const COMMANDCODE_CREDITS = "https://api.commandcode.ai/alpha/billing/credits";

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

const CommandCodeWindow = Schema.Struct({
  used: Schema.Finite,
  cap: Schema.Finite,
  resetAt: Schema.Finite,
});
const CommandCodeCredits = Schema.Struct({
  windowLimits: Schema.optional(
    Schema.NullOr(
      Schema.Struct({
        fiveHour: Schema.optional(Schema.NullOr(CommandCodeWindow)),
        weekly: Schema.optional(Schema.NullOr(CommandCodeWindow)),
      }),
    ),
  ),
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

function commandCodeWindows(usage: typeof CommandCodeCredits.Type): ServerProviderUsageWindow[] {
  return (
    [
      ["fiveHour", "cc-five-hour", "session", "Session", 5 * 60],
      ["weekly", "cc-weekly", "weekly", "Weekly", 7 * 24 * 60],
    ] as const
  ).flatMap(([key, id, kind, label, windowDurationMins]) => {
    const window = usage.windowLimits?.[key];
    if (!window || window.cap <= 0) return [];
    return [
      {
        id,
        kind,
        label,
        windowDurationMins,
        usedPercent: clampPercent((window.used / window.cap) * 100),
        resetsAt: DateTime.formatIso(DateTime.makeUnsafe(window.resetAt)),
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

interface SlotBase {
  readonly accountKey: string;
  readonly label: string;
  readonly account: string;
  readonly providerFamily?: PiAccountFamily | undefined;
}

const slotIdentity = (input: SlotBase) => ({
  accountKey: input.accountKey,
  label: input.label,
  account: input.account,
  ...(input.providerFamily === undefined ? {} : { providerFamily: input.providerFamily }),
});

const unavailable = (
  input: SlotBase & { readonly checkedAt: string },
  reason: "unsupported" | "probeFailed",
  message: string,
): ServerProviderUsageSlot => ({
  ...slotIdentity(input),
  usageLimits: makeUnavailableUsageLimits({ checkedAt: input.checkedAt, reason, message }),
});

const withWindows = (
  input: SlotBase,
  checkedAt: string,
  windows: ReadonlyArray<ServerProviderUsageWindow>,
): ServerProviderUsageSlot => ({
  ...slotIdentity(input),
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
    refreshIdle: boolean,
  ) {
    const direct = usableAccess(credential, nowMs);
    if (direct !== undefined) return direct;
    // An idle login's token is refreshed in memory only: what auth.json holds stays Pi's to rotate.
    if (!refreshIdle || !credential.refresh) return undefined;
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
    base: SlotBase,
    credential: Credential,
    options: { readonly family: PiAccountFamily; readonly refreshIdle: boolean },
  ) {
    const { family } = options;
    if (family === "antigravity") {
      if (credential.type !== "oauth") {
        return unavailable(
          { ...base, checkedAt },
          "probeFailed",
          "Antigravity credentials are missing or expired. Run `pi` and sign in again.",
        );
      }
      const access = yield* resolveAntigravityAccess(credential, options.refreshIdle);
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

    if (family === "opencode-go") {
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

    if (family === "commandcode") {
      const key = credential.type === "oauth" ? credential.access : credential.key;
      if (key === undefined || key.length === 0) {
        return unavailable({ ...base, checkedAt }, "probeFailed", "No Command Code key is stored.");
      }
      return yield* client
        .execute(
          HttpClientRequest.get(COMMANDCODE_CREDITS).pipe(HttpClientRequest.bearerToken(key)),
        )
        .pipe(
          Effect.flatMap(HttpClientResponse.schemaBodyJson(CommandCodeCredits)),
          Effect.map((response) => {
            const windows = commandCodeWindows(response);
            return windows.length === 0
              ? unavailable(
                  { ...base, checkedAt },
                  "unsupported",
                  "Command Code reported no usage windows for this key.",
                )
              : withWindows(base, checkedAt, windows);
          }),
          Effect.timeout("10 seconds"),
          Effect.orElseSucceed(() =>
            unavailable(
              { ...base, checkedAt },
              "probeFailed",
              "Command Code could not read usage.",
            ),
          ),
        );
    }

    if (family === "openai-codex") {
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
    if (family === "claude-subscription") {
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
    readonly base: SlotBase;
    readonly credential: Credential | null;
    readonly family: PiAccountFamily;
    readonly refreshIdle: boolean;
  }

  const registry = yield* readPiAccountsRegistry(agentDir).pipe(
    Effect.catchCause(() => Effect.succeed({ version: 1 as const, accounts: [] })),
  );
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
          const family = piAccountFamily(registry, accountKey, undefined);
          return {
            base: { accountKey, label: accountKey, account: accountKey, providerFamily: family },
            credential: null,
            family,
            refreshIdle: false,
          };
        }
        const family = piAccountFamily(registry, accountKey, credential.value.type);
        return {
          base: {
            accountKey,
            label: slotLabel(accountKey, credential.value),
            account: yield* accountFingerprint(accountKey, credential.value),
            providerFamily: family,
          },
          credential: credential.value,
          family,
          // Each managed Antigravity login sits idle until chosen, so its token may have lapsed.
          refreshIdle: family === "antigravity",
        };
      }),
  );

  const preparedAntigravityEntries: Array<PreparedSlot> =
    antigravityAccounts.length === 0 && rawAuthAntigravity !== undefined
      ? [
          {
            base: {
              accountKey: "antigravity",
              label: "antigravity",
              account: "antigravity",
              providerFamily: "antigravity",
            },
            credential: null,
            family: "antigravity",
            refreshIdle: false,
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
                providerFamily: "antigravity" as const,
              },
              credential: entry.credential,
              family: "antigravity" as const,
              refreshIdle: entry.fromAccountsStore,
            };
          }),
        );

  // A models.json key (a command Pi runs) is billed per use like any API key; T3 never runs it.
  const modelsJsonAccounts = yield* listPiModelsJsonAccounts(agentDir).pipe(
    Effect.catchCause(() => Effect.succeed([])),
  );
  const preparedModelsEntries: Array<PreparedSlot> = yield* Effect.forEach(
    modelsJsonAccounts.filter((entry) => !Object.hasOwn(file, entry.providerId)),
    (entry) =>
      Effect.gen(function* () {
        const credential: Credential = { type: "api_key" };
        const family =
          registry.accounts.find((account) => account.providerId === entry.providerId)
            ?.providerFamily ?? entry.providerFamily;
        return {
          base: {
            accountKey: entry.providerId,
            label: entry.providerId,
            account: yield* accountFingerprint(entry.providerId, credential),
            providerFamily: family,
          },
          credential,
          family,
          refreshIdle: false,
        };
      }),
  );

  const preparedEntries: Array<PreparedSlot> = [
    ...preparedAntigravityEntries,
    ...preparedAuthEntries,
    ...preparedModelsEntries,
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
    ({ base, credential, family, refreshIdle }) =>
      credential === null
        ? Effect.succeed(
            unavailable(
              { ...base, checkedAt },
              "probeFailed",
              "T3 cannot read this credential's format.",
            ),
          )
        : probeSlot(base, credential, { family, refreshIdle }).pipe(
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
 * Keeps a credential's last reading, with its own time, over a failed poll or an older reading, and
 * a window last seen spent that a reading omits until its reset (indefinitely when none is known),
 * so no stale, failed or partial reading frees an exhausted account early. A changed credential
 * drops them; `null` (credential store unreadable) keeps every slot with a `probeFailed` notice.
 */
export function retainPriorUsageSlots(
  previous: ReadonlyArray<ServerProviderUsageSlot>,
  probed: ReadonlyArray<ServerProviderUsageSlot> | null,
): ReadonlyArray<ServerProviderUsageSlot> {
  if (probed === null) {
    return previous.map((slot) => ({
      ...slot,
      usageLimits: {
        ...slot.usageLimits,
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
    const prior = byKey.get(slot.accountKey);
    if (
      prior === undefined ||
      prior.account !== slot.account ||
      prior.usageLimits.windows.length === 0
    ) {
      return slot;
    }
    if (slot.usageLimits.unavailable?.reason === "probeFailed") {
      return {
        ...slot,
        usageLimits: {
          ...slot.usageLimits,
          checkedAt: prior.usageLimits.checkedAt,
          windows: prior.usageLimits.windows,
        },
      };
    }
    const readAt = Date.parse(slot.usageLimits.checkedAt);
    if (readAt < Date.parse(prior.usageLimits.checkedAt))
      return { ...slot, usageLimits: prior.usageLimits };
    const read = new Set(slot.usageLimits.windows.map((window) => window.id));
    const stillSpent = prior.usageLimits.windows.filter((window) => {
      if (read.has(window.id) || (window.usedPercent ?? 0) < 100) return false;
      const resetMs = window.resetsAt === undefined ? Number.NaN : Date.parse(window.resetsAt);
      return !Number.isFinite(resetMs) || resetMs > readAt;
    });
    return stillSpent.length === 0
      ? slot
      : {
          ...slot,
          usageLimits: {
            ...slot.usageLimits,
            windows: [...slot.usageLimits.windows, ...stillSpent],
          },
        };
  });
}

export type { ApiKeyCredential, OauthCredential };
