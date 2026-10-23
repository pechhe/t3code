import { describe, expect, it } from "vite-plus/test";

import { chooseCompactionModel, conversationPromptCacheExpiresAt } from "./claudeCompaction.ts";

const NOW_ISO = "2026-09-04T12:00:00.000Z";
const NOW = Date.parse(NOW_ISO);
const EXPIRED = "2026-09-04T11:00:00.000Z";
const WARM = "2026-09-04T13:00:00.000Z";

const choose = (overrides: Partial<Parameters<typeof chooseCompactionModel>[0]> = {}) =>
  chooseCompactionModel({
    setting: { model: "claude-haiku-4-5", onlyWhenCold: true },
    conversationModel: "claude-sonnet-5-5",
    usedTokens: 150_000,
    promptCacheExpiresAt: EXPIRED,
    nowMs: NOW,
    chosenWindowTokens: 200_000,
    sameAccount: true,
    ...overrides,
  });

describe("chooseCompactionModel", () => {
  it("chooses the setting's model once the cache has expired", () => {
    expect(choose()).toEqual({
      model: "claude-haiku-4-5",
      crossAccount: false,
      windowTooSmall: false,
    });
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
    expect(choose(overrides)).toEqual({ model: null, crossAccount: false, windowTooSmall: false });
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
    expect(choose({ usedTokens: 200_001 })).toEqual({
      model: null,
      crossAccount: false,
      windowTooSmall: true,
    });
    expect(choose({ usedTokens: 200_000 }).model).toBe("claude-haiku-4-5");
  });

  it("chooses another account's model whatever the thread's size or that model's window", () => {
    expect(
      choose({ sameAccount: false, usedTokens: 900_000, chosenWindowTokens: undefined }),
    ).toEqual({ model: "claude-haiku-4-5", crossAccount: true, windowTooSmall: false });
  });

  it("summarises on another account when it names the conversation's own model", () => {
    expect(
      choose({
        sameAccount: false,
        setting: { model: "claude-sonnet-5-5", onlyWhenCold: false },
      }),
    ).toEqual({ model: "claude-sonnet-5-5", crossAccount: true, windowTooSmall: false });
  });

  it("still keeps the conversation's model on another account while the cache is warm", () => {
    expect(choose({ sameAccount: false, promptCacheExpiresAt: WARM })).toEqual({
      model: null,
      crossAccount: false,
      windowTooSmall: false,
    });
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
