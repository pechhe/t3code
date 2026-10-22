import { describe, expect, it } from "vite-plus/test";

import {
  chooseClaudeCompactionModel,
  conversationPromptCacheExpiresAt,
} from "./claudeCompaction.ts";

const NOW_ISO = "2026-09-04T12:00:00.000Z";
const NOW = Date.parse(NOW_ISO);
const EXPIRED = "2026-09-04T11:00:00.000Z";
const WARM = "2026-09-04T13:00:00.000Z";

const choose = (overrides: Partial<Parameters<typeof chooseClaudeCompactionModel>[0]> = {}) =>
  chooseClaudeCompactionModel({
    setting: { model: "claude-haiku-4-5", onlyWhenCold: true },
    conversationModel: "claude-sonnet-5-5",
    usedTokens: 150_000,
    promptCacheExpiresAt: EXPIRED,
    nowMs: NOW,
    chosenWindowTokens: 200_000,
    ...overrides,
  });

describe("chooseClaudeCompactionModel", () => {
  it("chooses the setting's model once the cache has expired", () => {
    expect(choose()).toEqual({ model: "claude-haiku-4-5", windowTooSmall: false });
  });

  it("treats the expiry instant itself as cold", () => {
    expect(choose({ promptCacheExpiresAt: NOW_ISO }).model).toBe("claude-haiku-4-5");
  });

  it.each([
    ["the cache is warm", { promptCacheExpiresAt: WARM }],
    ["the expiry is unknown", { promptCacheExpiresAt: undefined }],
    ["the expiry is unreadable", { promptCacheExpiresAt: "soon" }],
    ["no model is chosen", { setting: { model: " ", onlyWhenCold: true } }],
    [
      "the chosen model is the conversation's",
      { setting: { model: "claude-sonnet-5-5", onlyWhenCold: true } },
    ],
    ["the chosen model's window is unknown", { chosenWindowTokens: undefined }],
  ])("keeps the conversation's model when %s", (_name, overrides) => {
    expect(choose(overrides)).toEqual({ model: null, windowTooSmall: false });
  });

  it("chooses the model on a warm cache when the switch is off", () => {
    expect(
      choose({
        setting: { model: "claude-haiku-4-5", onlyWhenCold: false },
        promptCacheExpiresAt: WARM,
      }).model,
    ).toBe("claude-haiku-4-5");
  });

  it("passes over a model whose window is smaller than the thread", () => {
    expect(choose({ usedTokens: 200_001 })).toEqual({ model: null, windowTooSmall: true });
    expect(choose({ usedTokens: 200_000 }).model).toBe("claude-haiku-4-5");
  });
});

describe("conversationPromptCacheExpiresAt", () => {
  it("takes the latest usage's expiry", () => {
    expect(
      conversationPromptCacheExpiresAt([
        { updatedAt: "2026-09-04T10:00:00Z", promptCacheExpiresAt: "a" },
        { updatedAt: "2026-09-04T11:00:00Z", promptCacheExpiresAt: "b" },
      ]),
    ).toBe("b");
  });

  it("ignores a usage left by a cheaper model's compaction", () => {
    expect(
      conversationPromptCacheExpiresAt([
        { updatedAt: "2026-09-04T10:00:00Z", promptCacheExpiresAt: EXPIRED },
        {
          updatedAt: "2026-09-04T11:00:00Z",
          promptCacheExpiresAt: WARM,
          compactedWith: "claude-haiku-4-5",
        },
      ]),
    ).toBe(EXPIRED);
  });

  it("is unknown without any usage", () => {
    expect(conversationPromptCacheExpiresAt([])).toBeUndefined();
  });
});
