import { describe, expect, it } from "@effect/vitest";
import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as BitwardenSecrets from "./BitwardenSecrets.ts";
import * as BrowserLogins from "./BrowserLogins.ts";

const STORE: ReadonlyArray<BitwardenSecrets.SecretEntry> = [
  { key: "EXECUTOR_PAT", value: "synthetic-pat", note: "https://site.test" },
  {
    key: "BROWSER_LOGIN_SITE",
    value: " synthetic pass ",
    note: "https://site.test\nhttp://127.0.0.1:4173/\n*.site.test\nhttps://site.test/login",
  },
  { key: "BROWSER_LOGIN_NOWHERE", value: "synthetic-nowhere", note: "anywhere" },
];

const loginsWith = (
  store: Effect.Effect<
    ReadonlyArray<BitwardenSecrets.SecretEntry>,
    BitwardenSecrets.BitwardenSecretsError
  >,
) => {
  const kept: unknown[] = [];
  const layer = BrowserLogins.layer.pipe(
    Layer.provide(
      Layer.succeed(BitwardenSecrets.BitwardenSecrets, {
        read: () => Effect.succeedNone,
        select: (pick) =>
          store.pipe(
            Effect.map((entries) => {
              const picked = pick(entries);
              kept.push(picked);
              return picked;
            }),
          ),
      }),
    ),
  );
  return { layer, kept };
};

describe("BrowserLogins", () => {
  it("reads only exact origins from a note, one per line", () => {
    expect(BrowserLogins.originsOf(STORE[1]!.note)).toEqual([
      "https://site.test",
      "http://127.0.0.1:4173",
    ]);
  });

  it.effect("reads a login with its value untrimmed and keeps no other secret", () => {
    const { layer, kept } = loginsWith(Effect.succeed(STORE));
    return Effect.gen(function* () {
      const logins = yield* BrowserLogins.BrowserLogins;
      const login = yield* logins.read("BROWSER_LOGIN_SITE");
      expect(login).toEqual({
        key: "BROWSER_LOGIN_SITE",
        value: " synthetic pass ",
        origins: ["https://site.test", "http://127.0.0.1:4173"],
      });
      // The key list is read in the background as the service starts.
      for (let turn = 0; turn < 10; turn += 1) yield* Effect.yieldNow;
      expect(yield* logins.keysFor("https://site.test/login?next=1")).toEqual([
        "BROWSER_LOGIN_SITE",
      ]);
      expect(yield* logins.keysFor("https://other.test/login")).toEqual([]);
      expect(JSON.stringify(kept)).not.toContain("synthetic-pat");
      expect(JSON.stringify(kept)).not.toContain("synthetic-nowhere");
    }).pipe(Effect.provide(layer));
  });

  it.effect("refuses each unusable login by its key alone", () => {
    const { layer } = loginsWith(Effect.succeed(STORE));
    return Effect.gen(function* () {
      const logins = yield* BrowserLogins.BrowserLogins;
      const refused = (key: string) =>
        logins.read(key).pipe(
          Effect.flip,
          Effect.map((error) => [error.reason, error.message]),
        );
      expect(yield* refused("EXECUTOR_PAT")).toEqual([
        "not-login",
        "EXECUTOR_PAT is not a saved login. Only BROWSER_LOGIN_ keys can be used.",
      ]);
      expect((yield* refused("BROWSER_LOGIN_ABSENT"))[0]).toBe("missing");
      expect((yield* refused("BROWSER_LOGIN_NOWHERE"))[0]).toBe("no-origin");
    }).pipe(Effect.provide(layer));
  });

  it.effect("tells an unconfigured store from an unreachable one", () =>
    Effect.gen(function* () {
      for (const [reason, expected] of [
        ["not-installed", "not-configured"],
        ["failed", "unreachable"],
      ] as const) {
        const { layer } = loginsWith(
          Effect.fail(new BitwardenSecrets.BitwardenSecretsError({ reason, cause: null })),
        );
        const error = yield* BrowserLogins.BrowserLogins.pipe(
          Effect.flatMap((logins) => logins.read("BROWSER_LOGIN_SITE")),
          Effect.flip,
          Effect.provide(layer),
        );
        expect(error.reason).toBe(expected);
        expect(error.message).toContain("BROWSER_LOGIN_SITE");
        // Opening a tab lists none and never fails.
        const keys = yield* BrowserLogins.BrowserLogins.pipe(
          Effect.flatMap((logins) => logins.keysFor("https://site.test/")),
          Effect.provide(layer),
        );
        expect(keys).toEqual([]);
      }
    }),
  );

  it.live("lists none at once while the store hangs", () => {
    const { layer } = loginsWith(Effect.never);
    return Effect.gen(function* () {
      const logins = yield* BrowserLogins.BrowserLogins;
      const started = yield* Clock.currentTimeMillis;
      expect(yield* logins.keysFor("https://site.test/")).toEqual([]);
      expect((yield* Clock.currentTimeMillis) - started).toBeLessThan(100);
    }).pipe(Effect.provide(layer));
  });
});
