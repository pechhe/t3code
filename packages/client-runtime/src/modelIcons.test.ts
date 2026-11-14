import { describe, expect, it } from "vite-plus/test";

import { MODEL_MAKER_ICONS, resolveModelIconMaker } from "./modelIcons.ts";

describe("resolveModelIconMaker", () => {
  it("resolves model makers for pi, opencode, and openrouter models", () => {
    expect(resolveModelIconMaker({ driverKind: "pi", model: "openai/gpt-6-luna" })).toBe("openai");
    expect(resolveModelIconMaker({ driverKind: "pi", model: "openai/o3-mini" })).toBe("openai");
    expect(resolveModelIconMaker({ driverKind: "pi", model: "anthropic/claude-opus-4-6" })).toBe(
      "anthropic",
    );
    expect(
      resolveModelIconMaker({
        driverKind: "pi",
        model: "google-antigravity/claude-sonnet-4-5",
      }),
    ).toBe("anthropic");
    expect(
      resolveModelIconMaker({
        driverKind: "pi",
        model: "opencode/deepseek-v4.1-flash",
        subProvider: "opencode",
      }),
    ).toBe("deepseek");
    expect(
      resolveModelIconMaker({
        driverKind: "pi",
        model: "openrouter/deepseek/deepseek-chat",
        subProvider: "openrouter",
      }),
    ).toBe("deepseek");
    expect(
      resolveModelIconMaker({
        driverKind: "openrouter",
        model: "google/gemini-2.5-pro",
      }),
    ).toBe("google");
    expect(resolveModelIconMaker({ driverKind: "pi", model: "moonshotai/kimi-k2.6" })).toBe(
      "moonshot",
    );
    expect(resolveModelIconMaker({ driverKind: "opencode", model: "xai/grok-4" })).toBe("xai");
    expect(resolveModelIconMaker({ driverKind: "pi", model: "qwen/qwen3-coder" })).toBe("alibaba");
    expect(
      resolveModelIconMaker({ driverKind: "openrouter", model: "meta-llama/llama-4-maverick" }),
    ).toBe("meta");
    expect(resolveModelIconMaker({ driverKind: "pi", model: "mistralai/devstral-2" })).toBe(
      "mistral",
    );
    expect(resolveModelIconMaker({ driverKind: "pi", model: "zai/glm-4.7" })).toBe("zhipu");
    expect(resolveModelIconMaker({ driverKind: "pi", model: "minimax/minimax-m2" })).toBe(
      "minimax",
    );
  });

  it("returns null for Pi default, unknown slugs, and single-brand drivers", () => {
    expect(resolveModelIconMaker({ driverKind: "pi", model: "default" })).toBeNull();
    expect(resolveModelIconMaker({ driverKind: "pi", model: "opencode/custom-model" })).toBeNull();
    expect(resolveModelIconMaker({ driverKind: "pi", model: undefined })).toBeNull();
    expect(resolveModelIconMaker({ driverKind: "codex", model: "gpt-5" })).toBeNull();
    expect(
      resolveModelIconMaker({ driverKind: "claudeAgent", model: "claude-opus-4-6" }),
    ).toBeNull();
    expect(resolveModelIconMaker({ driverKind: "antigravity", model: "gemini-3-pro" })).toBeNull();
  });

  it("provides vector icon definitions for makers without dedicated app icons", () => {
    expect(MODEL_MAKER_ICONS.google.paths.length).toBeGreaterThan(0);
    expect(MODEL_MAKER_ICONS.deepseek.paths.length).toBeGreaterThan(0);
    expect(MODEL_MAKER_ICONS.moonshot.paths.length).toBeGreaterThan(0);
    expect(MODEL_MAKER_ICONS.alibaba.paths.length).toBeGreaterThan(0);
    expect(MODEL_MAKER_ICONS.meta.paths.length).toBeGreaterThan(0);
    expect(MODEL_MAKER_ICONS.mistral.paths.length).toBeGreaterThan(0);
    expect(MODEL_MAKER_ICONS.zhipu.paths.length).toBeGreaterThan(0);
    expect(MODEL_MAKER_ICONS.minimax.paths.length).toBeGreaterThan(0);
  });
});
