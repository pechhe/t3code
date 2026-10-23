import { describe, expect, it } from "vite-plus/test";
import { makeProviderSettingsSchema, ProviderDriverKind, TrimmedString } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { providerClients } from "./providerDriverMeta";
import {
  deriveProviderSettingsFields,
  nextProviderConfigWithFieldValue,
} from "./ProviderSettingsForm";

describe("ProviderSettingsForm helpers", () => {
  it("keeps every masked field as a stored secret", () => {
    const settingsSchema = makeProviderSettingsSchema({
      token: TrimmedString.pipe(
        Schema.annotateKey({ providerSettingsForm: { control: "password" } }),
      ),
    });

    expect(deriveProviderSettingsFields({ settingsSchema })).toMatchObject([
      { key: "token", secret: true },
    ]);
  });

  it("preserves unknown config keys while omitting empty configurable fields", () => {
    const opencode = providerClients.get(ProviderDriverKind.make("opencode"));
    expect(opencode).toBeDefined();

    const serverUrl = deriveProviderSettingsFields(opencode!).find(
      (field) => field.key === "serverUrl",
    );
    expect(serverUrl).toBeDefined();

    const next = nextProviderConfigWithFieldValue(
      { forkOwned: 1, serverUrl: "http://127.0.0.1:4096" },
      serverUrl!,
      "",
    );

    expect(next).toEqual({ forkOwned: 1 });
  });

  it("offers the compact model picker only where the environment's accounts are known", () => {
    const claude = providerClients.get(ProviderDriverKind.make("claudeAgent"));
    expect(claude).toBeDefined();
    const environmentId = "environment-1" as never;

    const withoutAccounts = deriveProviderSettingsFields(claude!);
    const withAccounts = deriveProviderSettingsFields(claude!, {}, environmentId);

    expect(withoutAccounts.some((field) => field.key === "compactModel")).toBe(false);
    expect(withoutAccounts.some((field) => field.key === "compactModelInstanceId")).toBe(false);
    expect(withAccounts.find((field) => field.key === "compactModel")).toMatchObject({
      control: "model",
      label: "Compact with",
      modelChoice: {
        instanceKey: "compactModelInstanceId",
        emptyLabel: "Same as the conversation",
      },
    });
  });

  it("stores false boolean fields when true is the default", () => {
    const next = nextProviderConfigWithFieldValue(
      undefined,
      {
        key: "experimental",
        control: "switch",
        label: "Experimental",
        clearWhenEmpty: "omit",
        defaultBooleanValue: true,
      },
      false,
    );

    expect(next).toEqual({ experimental: false });
  });
});

describe("ProviderSettingsForm explicit values", () => {
  const launchArgsField = {
    key: "launchArgs",
    control: "text",
    label: "Launch arguments",
    clearWhenEmpty: "omit",
  } as const;
  const compactOnlyWhenColdField = {
    key: "compactOnlyWhenCold",
    control: "switch",
    label: "Only when the prompt cache has expired",
    clearWhenEmpty: "omit",
    defaultBooleanValue: true,
  } as const;

  it("stores an empty value where a pooled field would otherwise be omitted", () => {
    expect(
      nextProviderConfigWithFieldValue({ launchArgs: "--chrome" }, launchArgsField, "", {
        storeExplicit: true,
      }),
    ).toEqual({ launchArgs: "" });
  });

  it("stores a switch at its default where a pooled field would otherwise be omitted", () => {
    expect(
      nextProviderConfigWithFieldValue(undefined, compactOnlyWhenColdField, true, {
        storeExplicit: true,
      }),
    ).toEqual({ compactOnlyWhenCold: true });
  });

  it("still omits both without storeExplicit", () => {
    expect(
      nextProviderConfigWithFieldValue({ launchArgs: "--chrome" }, launchArgsField, ""),
    ).toEqual(undefined);
    expect(nextProviderConfigWithFieldValue(undefined, compactOnlyWhenColdField, true)).toEqual(
      undefined,
    );
  });
});
