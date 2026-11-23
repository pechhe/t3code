import {
  DEFAULT_SERVER_SETTINGS,
  ProviderInstanceId,
  type ServerSettings,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import { movedProviderReferences } from "./PiAccountsService.ts";

describe("movedProviderReferences", () => {
  it("moves the retired provider's slugs and routed accounts on its own instance only", () => {
    const pi = ProviderInstanceId.make("pi");
    const settings = {
      ...DEFAULT_SERVER_SETTINGS,
      favorites: [
        { provider: pi, model: "antigravity/gemini-4-argon" },
        { provider: ProviderInstanceId.make("pi-mac"), model: "antigravity/gemini-4-argon" },
        { provider: pi, model: "antigravity-2/gemini-4-argon" },
      ],
      providerModelPreferences: { pi: { hiddenModels: ["antigravity/gemini-4-hydrogen"] } },
      modelAccounts: {
        "gemini-4-argon": ["pi:antigravity", "pi-mac:antigravity", "pi:opencode-go"],
      },
      modelRouting: {
        "gemini-4-argon": {
          primary: ["pi:antigravity"],
          overflow: ["pi:opencode-go"],
          primaryOrder: "soonest",
        },
      },
      accountReserves: { "pi:antigravity": { percent: 10, allowedModels: ["gemini-4-argon"] } },
    } as unknown as ServerSettings;

    expect(movedProviderReferences(settings, [pi], "antigravity", "antigravity-hfpetch")).toEqual({
      favorites: [
        { provider: pi, model: "antigravity-hfpetch/gemini-4-argon" },
        { provider: ProviderInstanceId.make("pi-mac"), model: "antigravity/gemini-4-argon" },
        { provider: pi, model: "antigravity-2/gemini-4-argon" },
      ],
      providerModelPreferences: { pi: { hiddenModels: ["antigravity-hfpetch/gemini-4-hydrogen"] } },
      modelAccounts: {
        "gemini-4-argon": ["pi:antigravity-hfpetch", "pi-mac:antigravity", "pi:opencode-go"],
      },
      modelRouting: {
        "gemini-4-argon": {
          primary: ["pi:antigravity-hfpetch"],
          overflow: ["pi:opencode-go"],
          primaryOrder: "soonest",
        },
      },
      accountReserves: {
        "pi:antigravity": null,
        "pi:antigravity-hfpetch": { percent: 10, allowedModels: ["gemini-4-argon"] },
      },
    });
  });

  it("changes nothing when no setting names the retired provider", () => {
    const pi = ProviderInstanceId.make("pi");
    expect(
      movedProviderReferences(DEFAULT_SERVER_SETTINGS, [pi], "antigravity", "antigravity-a"),
    ).toEqual({});
  });
});
