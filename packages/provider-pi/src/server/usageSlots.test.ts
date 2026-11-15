import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";
import * as HttpClientResponse from "effect/http/HttpClientResponse";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";

import { readPiUsageSlots, retainPriorUsageSlots } from "./usageSlots.ts";

/** A fixed epoch keeps the probe off the wall clock; every credential here is unexpired. */
const FUTURE_MS = 1_800_000_000_000;

const layerTest = Layer.mergeAll(NodeServices.layer, NodeCrypto.layer);

const authFile = (accounts: Record<string, unknown>) => ({
  agent: { defaultProvider: "anthropic" },
  ...accounts,
});

const writeAuth = (accounts: Record<string, unknown>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const home = yield* fs.makeTempDirectoryScoped();
    yield* fs.makeDirectory(`${home}/.pi/agent`, { recursive: true });
    yield* fs.writeFileString(`${home}/.pi/agent/auth.json`, JSON.stringify(authFile(accounts)));
    return home;
  });

const antigravityAnswer = {
  groups: [
    {
      buckets: [
        {
          bucketId: "gemini-5h",
          displayName: "Five Hour Limit Remaining",
          window: "5h",
          resetTime: "2026-11-15T17:34:04Z",
          remainingFraction: 0.75,
        },
        {
          bucketId: "gemini-weekly",
          displayName: "Weekly Limit Remaining",
          window: "weekly",
          resetTime: "2026-11-21T10:39:42Z",
          remainingFraction: 0.5,
        },
      ],
    },
  ],
};

describe("readPiUsageSlots", () => {
  it.effect("reports one slot per stored credential and reads each provider's own quota", () =>
    Effect.gen(function* () {
      const home = yield* writeAuth({
        antigravity: {
          type: "oauth",
          access: "ag-token",
          refresh: "ag-refresh",
          expires: FUTURE_MS,
          projectId: "project-1",
          email: "hfpetch@gmail.com",
        },
        "claude-subscription-yardsmith": {
          type: "oauth",
          access: "claude-token",
          refresh: "claude-refresh",
          expires: FUTURE_MS,
        },
        "opencode-go": { type: "api_key", key: "oc-key" },
        anthropic: { type: "api_key", key: "sk-ant" },
      });
      const calls: Array<string> = [];
      const slots = yield* readPiUsageSlots({ environment: { HOME: home } }).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) => {
            calls.push(request.url);
            if (request.url.includes("retrieveUserQuotaSummary")) {
              return Effect.succeed(
                HttpClientResponse.fromWeb(request, Response.json(antigravityAnswer)),
              );
            }
            if (request.url.includes("api.anthropic.com")) {
              expect(request.headers.authorization).toBe("Bearer claude-token");
              return Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  Response.json({
                    five_hour: { utilization: 25, resets_at: "2026-11-15T19:20:00Z" },
                    seven_day: { utilization: 60, resets_at: null },
                  }),
                ),
              );
            }
            if (request.url.includes("opencode.ai")) {
              expect(request.headers.authorization).toBe("Bearer oc-key");
              const window = { percent: 40, resetsAt: "2026-11-16T00:00:00Z" };
              return Effect.succeed(
                HttpClientResponse.fromWeb(
                  request,
                  Response.json({ usage: { rolling: window, weekly: window, monthly: window } }),
                ),
              );
            }
            return Effect.die(`Unexpected request ${request.url}`);
          }),
        ),
      );

      expect(slots.map((slot) => slot.accountKey).toSorted()).toEqual([
        "anthropic",
        "antigravity",
        "claude-subscription-yardsmith",
        "opencode-go",
      ]);

      const antigravity = slots.find((slot) => slot.accountKey === "antigravity")!;
      expect(antigravity.label).toContain("hfpetch@gmail.com");
      expect(antigravity.usageLimits.windows).toMatchObject([
        { id: "gemini-5h", kind: "session", usedPercent: 25, resetsAt: "2026-11-15T17:34:04.000Z" },
        { id: "gemini-weekly", kind: "weekly", usedPercent: 50 },
      ]);

      const claude = slots.find((slot) => slot.accountKey === "claude-subscription-yardsmith")!;
      expect(claude.usageLimits.windows).toMatchObject([
        { id: "five_hour", kind: "session", usedPercent: 25 },
        { id: "seven_day", kind: "weekly", usedPercent: 60 },
      ]);
      expect(claude.usageLimits.windows[1]?.resetsAt).toBeUndefined();

      const opencode = slots.find((slot) => slot.accountKey === "opencode-go")!;
      expect(opencode.usageLimits.windows).toHaveLength(3);

      // An API key reports no remaining credit; a budget is how its allowance is known.
      const anthropic = slots.find((slot) => slot.accountKey === "anthropic")!;
      expect(anthropic.usageLimits.unavailable?.reason).toBe("unsupported");
      expect(anthropic.usageLimits.windows).toEqual([]);

      // Two hosts answer the quota summary; neither duplicates a bucket.
      expect(calls.filter((url) => url.includes("retrieveUserQuotaSummary"))).toHaveLength(2);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("separates two accounts of the same sub-provider", () =>
    Effect.gen(function* () {
      const home = yield* writeAuth({
        "claude-subscription-hfpetch": {
          type: "oauth",
          access: "a",
          refresh: "refresh-a",
          expires: FUTURE_MS,
        },
        "claude-subscription-yardsmith": {
          type: "oauth",
          access: "b",
          refresh: "refresh-b",
          expires: FUTURE_MS,
        },
      });
      const slots = yield* readPiUsageSlots({ environment: { HOME: home } }).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                Response.json({ five_hour: { utilization: 10, resets_at: null } }),
              ),
            ),
          ),
        ),
      );
      expect(slots).toHaveLength(2);
      expect(slots[0]?.account).not.toBe(slots[1]?.account);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("maps OpenAI Codex windows and preserves a failed probe reason", () =>
    Effect.gen(function* () {
      const home = yield* writeAuth({
        "openai-codex": { type: "oauth", access: "codex-token", expires: FUTURE_MS },
      });
      const slots = yield* readPiUsageSlots({ environment: { HOME: home } }).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) => {
            expect(request.url).toBe("https://chatgpt.com/backend-api/wham/usage");
            expect(request.headers.authorization).toBe("Bearer codex-token");
            expect(request.headers["user-agent"]).toBe("pi/1.5.9");
            return Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                Response.json({
                  email: "codex@example.com",
                  plan_type: "plus",
                  rate_limit: {
                    primary_window: {
                      used_percent: 25,
                      limit_window_seconds: 18_000,
                      reset_after_seconds: 1800,
                      reset_at: 1_800_000_060,
                    },
                    secondary_window: null,
                  },
                }),
              ),
            );
          }),
        ),
      );
      expect(slots[0]?.usageLimits.windows).toMatchObject([
        {
          id: "codex-primary",
          kind: "session",
          label: "Session",
          usedPercent: 25,
          windowDurationMins: 300,
          resetsAt: "2027-01-15T08:01:00.000Z",
        },
      ]);
      const failed = yield* readPiUsageSlots({ environment: { HOME: home } }).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.succeed(
              HttpClientResponse.fromWeb(request, new Response("no", { status: 401 })),
            ),
          ),
        ),
      );
      expect(failed[0]?.usageLimits.unavailable?.reason).toBe("probeFailed");
      expect(failed[0]?.usageLimits.windows).toEqual([]);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("carries only whole positive window lengths", () =>
    Effect.gen(function* () {
      const home = yield* writeAuth({
        "openai-codex": { type: "oauth", access: "codex-token", expires: FUTURE_MS },
      });
      const slots = yield* readPiUsageSlots({ environment: { HOME: home } }).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make((request) =>
            Effect.succeed(
              HttpClientResponse.fromWeb(
                request,
                Response.json({
                  rate_limit: {
                    primary_window: {
                      used_percent: 10,
                      limit_window_seconds: 45,
                      reset_after_seconds: 60,
                      reset_at: 1_800_000_060,
                    },
                    secondary_window: {
                      used_percent: 5,
                      limit_window_seconds: 90,
                      reset_after_seconds: 60,
                      reset_at: 1_800_000_060,
                    },
                  },
                }),
              ),
            ),
          ),
        ),
      );
      // A window shorter than a minute carries no length; 90s rounds to a whole minute.
      const windows = slots[0]?.usageLimits.windows ?? [];
      const short = windows.find((window) => window.id === "codex-primary");
      const rounded = windows.find((window) => window.id === "codex-secondary");
      expect(short?.windowDurationMins).toBeUndefined();
      expect(rounded).toMatchObject({ windowDurationMins: 2, kind: "session" });
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("says why a reading is unavailable instead of reporting zero allowance", () =>
    Effect.gen(function* () {
      const home = yield* writeAuth({
        antigravity: {
          type: "oauth",
          access: "expired-token",
          refresh: "refresh",
          // Pi has not refreshed this yet, so the probe must not use it.
          expires: -1,
        },
      });
      const slots = yield* readPiUsageSlots({ environment: { HOME: home } }).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("An expired credential must not be sent")),
        ),
      );
      expect(slots[0]?.usageLimits.unavailable?.reason).toBe("probeFailed");
      expect(slots[0]?.usageLimits.windows).toEqual([]);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("returns no slots when Pi has never signed in", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const home = yield* fs.makeTempDirectoryScoped();
      const slots = yield* readPiUsageSlots({ environment: { HOME: home } }).pipe(
        Effect.provideService(
          HttpClient.HttpClient,
          HttpClient.make(() => Effect.die("No credentials, no requests")),
        ),
      );
      expect(slots).toEqual([]);
    }).pipe(Effect.provide(layerTest)),
  );

  it("retains last known windows across a failed poll only for the same credential", () => {
    const window = {
      id: "five_hour",
      kind: "session" as const,
      label: "Session",
      usedPercent: 42,
    };
    const prior = [
      {
        accountKey: "claude-subscription-hfpetch",
        label: "claude-subscription-hfpetch",
        account: "cred-a",
        usageLimits: { checkedAt: "2026-11-15T10:00:00.000Z", windows: [window] },
      },
      {
        accountKey: "openai-codex",
        label: "openai-codex",
        account: "codex-a",
        usageLimits: { checkedAt: "2026-11-15T10:00:00.000Z", windows: [window] },
      },
    ];
    const probed = [
      {
        accountKey: "claude-subscription-hfpetch",
        label: "claude-subscription-hfpetch",
        account: "cred-a",
        usageLimits: {
          checkedAt: "2026-11-15T11:00:00.000Z",
          windows: [],
          unavailable: { reason: "probeFailed" as const, message: "Network error." },
        },
      },
      {
        accountKey: "openai-codex",
        label: "openai-codex",
        account: "codex-b",
        usageLimits: {
          checkedAt: "2026-11-15T11:00:00.000Z",
          windows: [],
          unavailable: { reason: "probeFailed" as const, message: "Expired." },
        },
      },
    ];
    const retained = retainPriorUsageSlots(prior, probed);
    expect(retained[0]?.usageLimits.windows).toEqual([window]);
    expect(retained[0]?.usageLimits.unavailable).toEqual({
      reason: "probeFailed",
      message: "Network error.",
    });
    expect(retained[1]?.usageLimits.windows).toEqual([]);
  });
});
