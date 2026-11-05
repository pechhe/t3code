import { describe, expect, it } from "vite-plus/test";
import {
  makeProviderSettingsSchema,
  ProviderDriverKind,
  SettingsSecretValue,
  TrimmedString,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";

import { providerClients } from "./providerDriverMeta";
import {
  deriveProviderSettingsFields,
  nextProviderConfigWithFieldValue,
  reconcileRowsDraft,
  seedRowsDraft,
} from "./ProviderSettingsForm";

describe("ProviderSettingsForm helpers", () => {
  it("keeps every masked field as a stored secret and offers a reference only where typed so", () => {
    const settingsSchema = makeProviderSettingsSchema({
      token: TrimmedString.pipe(
        Schema.annotateKey({ providerSettingsForm: { control: "password" } }),
      ),
      apiKey: SettingsSecretValue,
    });

    expect(
      deriveProviderSettingsFields({ settingsSchema }).map(
        ({ key, secret, acceptsSecretReference }) => ({ key, secret, acceptsSecretReference }),
      ),
    ).toEqual([
      { key: "token", secret: true, acceptsSecretReference: undefined },
      { key: "apiKey", secret: true, acceptsSecretReference: true },
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

describe("reconcileRowsDraft", () => {
  let nextId = 0;
  const toRows = (values: ReadonlyArray<string>) =>
    values.map((value) => ({ id: nextId++, value }));
  const equal = (left: ReadonlyArray<string>, right: ReadonlyArray<string>) =>
    left.length === right.length && left.every((value, index) => value === right[index]);

  it("keeps rows when an equal value arrives with a new identity", () => {
    const draft = seedRowsDraft(["a"], toRows);
    expect(reconcileRowsDraft(draft, ["a"], equal, toRows)).toBe(draft);
  });

  it("keeps row ids when the published value echoes back", () => {
    const seeded = seedRowsDraft(["a"], toRows);
    const edited = { rows: [...seeded.rows, { id: 99, value: "" }], seen: seeded.seen };
    const draft = { ...edited, lastPublished: ["a", ""] };
    const next = reconcileRowsDraft(draft, ["a", ""], equal, toRows);
    expect(next.rows).toBe(draft.rows);
    expect(next.seen).toEqual(["a", ""]);
    expect(next.lastPublished).toBeUndefined();
  });

  it("reseeds rows when the value changes from outside", () => {
    const draft = { ...seedRowsDraft(["a"], toRows), lastPublished: ["b"] };
    const next = reconcileRowsDraft(draft, ["c"], equal, toRows);
    expect(next.rows.map((row) => row.value)).toEqual(["c"]);
    expect(next.lastPublished).toBeUndefined();
  });
});
