import { ProviderDriverKind } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { ClaudeAI, OpenAI } from "../Icons";
import {
  resolveProviderInstanceAcpRegistryIconUrl,
  resolveProviderInstanceIcon,
} from "./ProviderInstanceIcon";

describe("resolveProviderInstanceAcpRegistryIconUrl", () => {
  it("uses allowlisted catalog metadata and rejects untrusted overrides", () => {
    expect(
      resolveProviderInstanceAcpRegistryIconUrl({
        driverKind: ProviderDriverKind.make("acpRegistry"),
        agentId: "kilo",
        iconUrl: "https://cdn.agentclientprotocol.com/registry/icons/kilo.svg",
      }),
    ).toBe("https://cdn.agentclientprotocol.com/registry/icons/kilo.svg");
    expect(
      resolveProviderInstanceAcpRegistryIconUrl({
        driverKind: ProviderDriverKind.make("acpRegistry"),
        agentId: "generic-agent",
        iconUrl: "https://example.com/not-official.svg",
      }),
    ).toBe("https://cdn.agentclientprotocol.com/registry/v1/latest/generic-agent.svg");
  });
});

describe("resolveProviderInstanceIcon", () => {
  it("resolves model-matched icons for pi models and falls back to pi for default", () => {
    const piDriver = ProviderDriverKind.make("pi");
    expect(
      resolveProviderInstanceIcon({
        driverKind: piDriver,
        model: "openai/gpt-6-luna",
        subProvider: "openai",
      }),
    ).toMatchObject({ maker: "openai", Icon: OpenAI, packageIcon: undefined });
    expect(
      resolveProviderInstanceIcon({
        driverKind: piDriver,
        model: "anthropic/claude-opus-4-6",
        subProvider: "anthropic",
      }),
    ).toMatchObject({ maker: "anthropic", Icon: ClaudeAI, packageIcon: undefined });
    const deepseek = resolveProviderInstanceIcon({
      driverKind: piDriver,
      model: "opencode/deepseek-v4.1-flash",
      subProvider: "opencode",
    });
    expect(deepseek.maker).toBe("deepseek");
    expect(deepseek.Icon).toBeNull();
    expect(deepseek.packageIcon).toBeDefined();

    const fallback = resolveProviderInstanceIcon({
      driverKind: piDriver,
      model: "default",
    });
    expect(fallback.maker).toBeNull();
    expect(fallback.packageIcon).toBeDefined();
  });
});
