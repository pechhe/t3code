import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as TestClock from "effect/testing/TestClock";

import {
  listPiAccounts,
  modifyPiAuth,
  readPiAccountsRegistry,
  removePiAccount,
  savePiAccountKey,
  separatePiSharedLogins,
} from "./accounts.ts";

const agentDirWith = (files: Record<string, unknown>) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const dir = yield* fs.makeTempDirectoryScoped();
    for (const [name, value] of Object.entries(files)) {
      yield* fs.writeFileString(`${dir}/${name}`, JSON.stringify(value));
    }
    return dir;
  });

const readJson = (file: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    return JSON.parse(yield* fs.readFileString(file)) as Record<string, unknown>;
  });

const oauth = (name: string) => ({
  type: "oauth",
  access: `access-${name}`,
  refresh: `refresh-${name}`,
  expires: 4_102_444_800_000,
  email: `${name}@example.com`,
  projectId: `project-${name}`,
});

describe("Pi accounts", () => {
  it.effect("adds an API-key account as its own provider, written 0600 and never listed back", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* fs.makeTempDirectoryScoped();
      const providerId = yield* savePiAccountKey(dir, {
        providerFamily: "opencode-go",
        label: "Second Go",
        key: "oc-secret",
      });
      expect(providerId).toBe("opencode-go-second-go");
      expect(yield* readJson(`${dir}/auth.json`)).toEqual({
        "opencode-go-second-go": { type: "api_key", key: "oc-secret" },
      });
      expect(((yield* fs.stat(`${dir}/auth.json`)).mode & 0o777).toString(8)).toBe("600");
      expect(yield* fs.exists(`${dir}/auth.json.lock`)).toBe(false);
      expect((yield* readPiAccountsRegistry(dir)).accounts).toMatchObject([
        { providerId, providerFamily: "opencode-go", label: "Second Go" },
      ]);
      const listing = yield* listPiAccounts(dir);
      expect(listing.accounts).toEqual([
        {
          providerId,
          providerFamily: "opencode-go",
          label: "Second Go",
          authType: "api_key",
          status: "signedIn",
          source: "auth",
          managed: true,
        },
      ]);
      expect(JSON.stringify(listing)).not.toContain("oc-secret");
      const mismatched = yield* savePiAccountKey(dir, {
        providerId,
        providerFamily: "commandcode",
        label: "Second Go",
        key: "other",
      }).pipe(Effect.flip);
      expect(mismatched).toMatchObject({
        detail: "opencode-go-second-go is not a commandcode account.",
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("waits for Pi's auth.json lock and writes on top of what Pi wrote under it", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* agentDirWith({ "auth.json": { "claude-subscription-a": oauth("a") } });
      yield* fs.makeDirectory(`${dir}/auth.json.lock`);
      const write = yield* modifyPiAuth(dir, (auth) => ({
        ...auth,
        "opencode-go-2": { type: "api_key", key: "k" },
      })).pipe(Effect.forkChild);
      // Pi finishes its token refresh and releases the lock.
      yield* fs.writeFileString(
        `${dir}/auth.json`,
        JSON.stringify({ "claude-subscription-a": { ...oauth("a"), access: "refreshed" } }),
      );
      yield* fs.remove(`${dir}/auth.json.lock`, { recursive: true });
      yield* TestClock.adjust(100);
      yield* Fiber.join(write);
      expect(yield* readJson(`${dir}/auth.json`)).toEqual({
        "claude-subscription-a": { ...oauth("a"), access: "refreshed" },
        "opencode-go-2": { type: "api_key", key: "k" },
      });
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("removes the credential, its models.json key and T3's record", () =>
    Effect.gen(function* () {
      const dir = yield* agentDirWith({
        "auth.json": {
          "anthropic-work": { type: "api_key", key: "sk" },
          openai: { type: "api_key", key: "o" },
        },
        "models.json": {
          providers: {
            "anthropic-work": { api: "anthropic-messages", apiKey: "!cat key", models: [] },
          },
        },
        "t3-accounts.json": {
          version: 1,
          accounts: [
            { providerId: "anthropic-work", providerFamily: "anthropic-api", label: "Work" },
          ],
        },
      });
      yield* removePiAccount(dir, "anthropic-work");
      expect(yield* readJson(`${dir}/auth.json`)).toEqual({
        openai: { type: "api_key", key: "o" },
      });
      expect(yield* readJson(`${dir}/models.json`)).toEqual({
        providers: { "anthropic-work": { api: "anthropic-messages", models: [] } },
      });
      expect((yield* readPiAccountsRegistry(dir)).accounts).toEqual([]);
      expect((yield* listPiAccounts(dir)).accounts.map((account) => account.providerId)).toEqual([
        "openai",
      ]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("splits Antigravity's shared logins into aliases once, keeping every token", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const dir = yield* agentDirWith({
        "auth.json": { antigravity: oauth("hfpetch"), openai: { type: "api_key", key: "o" } },
        "antigravity-accounts.json": {
          version: 1,
          accounts: {
            "hfpetch@example.com": { ...oauth("hfpetch"), expires: 1 },
            "petch@example.com": oauth("petch"),
          },
        },
      });
      expect((yield* listPiAccounts(dir)).sharedLogins).toEqual([
        { providerFamily: "antigravity", count: 2 },
      ]);
      const replaced = yield* separatePiSharedLogins(dir, "antigravity");
      expect(replaced).toEqual({ from: "antigravity", to: "antigravity-hfpetch" });
      const auth = yield* readJson(`${dir}/auth.json`);
      expect(auth).toEqual({
        openai: { type: "api_key", key: "o" },
        "antigravity-hfpetch": oauth("hfpetch"),
        "antigravity-petch": oauth("petch"),
      });
      expect(yield* fs.exists(`${dir}/antigravity-accounts.json`)).toBe(false);
      const registry = yield* readPiAccountsRegistry(dir);
      expect(registry.accounts.map((account) => account.providerId)).toEqual([
        "antigravity-hfpetch",
        "antigravity-petch",
      ]);
      expect(registry.replacedProviderIds).toEqual({ antigravity: "antigravity-hfpetch" });
      // A second run, as after an interruption, changes nothing.
      yield* separatePiSharedLogins(dir, "antigravity");
      expect(yield* readJson(`${dir}/auth.json`)).toEqual(auth);
      expect((yield* readPiAccountsRegistry(dir)).accounts).toHaveLength(2);
      expect((yield* listPiAccounts(dir)).sharedLogins).toEqual([]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("turns Command Code's extra keys into accounts of their own", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const key = (value: string) => ({
        type: "oauth",
        access: value,
        refresh: "",
        expires: 4_102_444_800_000,
      });
      const dir = yield* agentDirWith({
        "auth.json": { commandcode: key("K1") },
        "commandcode-keys.json": ["K1", "K2"],
      });
      expect((yield* listPiAccounts(dir)).sharedLogins).toEqual([
        { providerFamily: "commandcode", count: 2 },
      ]);
      yield* separatePiSharedLogins(dir, "commandcode");
      expect(yield* readJson(`${dir}/auth.json`)).toEqual({
        commandcode: key("K1"),
        "commandcode-2": key("K2"),
      });
      expect(yield* fs.exists(`${dir}/commandcode-keys.json`)).toBe(false);
      expect(
        (yield* readPiAccountsRegistry(dir)).accounts.map((account) => account.providerId),
      ).toEqual(["commandcode", "commandcode-2"]);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});
