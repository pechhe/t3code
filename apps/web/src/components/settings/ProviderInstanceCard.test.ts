import { describe, expect, it } from "vite-plus/test";
import type { ServerProviderModel } from "@t3tools/contracts";

import {
  deriveProviderModelsForDisplay,
  nextProviderEnvironmentWithFieldValue,
  sharedModelsOfPoolMembers,
} from "./ProviderInstanceCard";

describe("deriveProviderModelsForDisplay", () => {
  it("uses current config custom models instead of stale live custom rows", () => {
    const liveModels: ReadonlyArray<ServerProviderModel> = [
      {
        slug: "server-model",
        name: "Server Model",
        isCustom: false,
        capabilities: null,
      },
      {
        slug: "removed-custom",
        name: "Removed Custom",
        isCustom: true,
        capabilities: null,
      },
      {
        slug: "kept-custom",
        name: "Kept Custom",
        isCustom: true,
        capabilities: null,
      },
    ];

    expect(
      deriveProviderModelsForDisplay({
        liveModels,
        customModels: [{ slug: "kept-custom", name: "kept-custom", capabilities: null }],
      }).map((model) => model.slug),
    ).toEqual(["server-model", "kept-custom"]);
  });
});

describe("provider environment helpers", () => {
  const cursorApiKeyField = {
    name: "CURSOR_API_KEY",
    label: "Cursor API key",
    sensitive: true,
  };

  it("writes dedicated provider secrets as sensitive environment variables", () => {
    expect(
      nextProviderEnvironmentWithFieldValue(
        [{ name: "EXTRA_FLAG", value: "1", sensitive: false }],
        cursorApiKeyField,
        "  cursor-key  ",
      ),
    ).toEqual([
      { name: "EXTRA_FLAG", value: "1", sensitive: false },
      { name: "CURSOR_API_KEY", value: "cursor-key", sensitive: true },
    ]);
  });

  it("replaces redacted provider secrets without preserving redaction markers", () => {
    expect(
      nextProviderEnvironmentWithFieldValue(
        [
          {
            name: "CURSOR_API_KEY",
            value: "",
            sensitive: true,
            valueRedacted: true,
          },
        ],
        cursorApiKeyField,
        "new-key",
      ),
    ).toEqual([{ name: "CURSOR_API_KEY", value: "new-key", sensitive: true }]);
  });

  it("applies the secure field default when replacing an existing non-sensitive value", () => {
    expect(
      nextProviderEnvironmentWithFieldValue(
        [{ name: "OPENAI_API_KEY", value: "old-key", sensitive: false }],
        {
          name: "OPENAI_API_KEY",
          label: "OpenAI API key",
        },
        "new-key",
      ),
    ).toEqual([{ name: "OPENAI_API_KEY", value: "new-key", sensitive: true }]);
  });
});

describe("sharedModelsOfPoolMembers", () => {
  const model = (slug: string, contextWindowTokens?: number): ServerProviderModel => ({
    slug,
    name: slug,
    isCustom: false,
    capabilities: null,
    ...(contextWindowTokens === undefined ? {} : { contextWindowTokens }),
  });

  it("keeps only the models every member offers and can compact with", () => {
    expect(
      sharedModelsOfPoolMembers([
        [model("sonnet", 200_000), model("opus", 200_000), model("without-window")],
        [model("sonnet", 200_000), model("haiku")],
        [model("sonnet", 200_000), model("opus", 200_000)],
      ]).map((option) => option.slug),
    ).toEqual(["sonnet"]);
  });

  it("uses the first member's names and order", () => {
    expect(
      sharedModelsOfPoolMembers([
        [
          { ...model("second", 100_000), name: "Second model" },
          { ...model("first", 100_000), name: "First model" },
        ],
        [model("first", 100_000), model("second", 100_000)],
      ]),
    ).toEqual([
      { slug: "second", name: "Second model" },
      { slug: "first", name: "First model" },
    ]);
  });

  it("skips a member that reports no models and offers nothing when none do", () => {
    expect(
      sharedModelsOfPoolMembers([[model("sonnet", 200_000)], []]).map((option) => option.slug),
    ).toEqual(["sonnet"]);
    expect(sharedModelsOfPoolMembers([[], []])).toEqual([]);
  });
});
