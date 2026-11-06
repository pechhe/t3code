import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as BitwardenSecrets from "./BitwardenSecrets.ts";

/**
 * Only keys with this prefix are logins. Henry's Bitwarden plan allows no further project, so the
 * prefix, not a project, is what keeps every other secret out of the browser.
 */
export const LOGIN_PREFIX = "BROWSER_LOGIN_";
/** A key list older than this is never shown. */
const KEYS_TTL_MS = 5 * 60_000;
/** Refreshed in the background well inside its lifetime, so opening a tab never waits on it. */
const KEYS_REFRESH_MS = 4 * 60_000;

export interface Login {
  readonly key: string;
  /** Held in server memory only: never logged, returned or persisted. */
  readonly value: string;
  readonly origins: ReadonlyArray<string>;
}

export class BrowserLoginRefused extends Schema.TaggedError<BrowserLoginRefused>()(
  "BrowserLoginRefused",
  {
    key: Schema.String,
    reason: Schema.Literals(["not-login", "missing", "no-origin", "not-configured", "unreachable"]),
  },
) {
  override get message() {
    switch (this.reason) {
      case "not-login":
        return `${this.key} is not a saved login. Only ${LOGIN_PREFIX} keys can be used.`;
      case "missing":
        return `No saved login ${this.key} exists.`;
      case "no-origin":
        return `Login ${this.key} names no valid origin in its note, so it cannot be used.`;
      case "not-configured":
        return `This server has no saved-login store (Bitwarden Secrets Manager's bws is not set up), so login ${this.key} cannot be used.`;
      case "unreachable":
        return `The saved-login store could not be read, so login ${this.key} was not used. Try again later.`;
    }
  }
}

/** One exact origin per line, such as `https://example.com`: no path, wildcard or subdomain rule. */
export const originsOf = (note: string): ReadonlyArray<string> =>
  note.split(/\r?\n/).flatMap((line) => {
    const text = line.trim();
    if (!/^https?:\/\//i.test(text)) return [];
    try {
      const { origin } = new URL(text);
      return text === origin || text === `${origin}/` ? [origin] : [];
    } catch {
      return [];
    }
  });

export const originOf = (url: string | null): string | undefined => {
  if (url === null) return undefined;
  try {
    const { origin } = new URL(url);
    return origin === "null" ? undefined : origin;
  } catch {
    return undefined;
  }
};

export class BrowserLogins extends Context.Service<
  BrowserLogins,
  {
    /** Read afresh for one run, so a refusal comes before any browser effect. */
    readonly read: (key: string) => Effect.Effect<Login, BrowserLoginRefused>;
    /** Login keys bound to the URL's origin. Never fails and never waits long; none when unknown. */
    readonly keysFor: (url: string | null) => Effect.Effect<ReadonlyArray<string>>;
  }
>()("t3/secrets/BrowserLogins") {}

export const layer = Layer.effect(
  BrowserLogins,
  Effect.gen(function* () {
    const store = yield* BitwardenSecrets.BitwardenSecrets;
    const scope = yield* Effect.scope;
    let keys:
      | {
          readonly at: number;
          readonly logins: ReadonlyArray<{
            readonly key: string;
            readonly origins: ReadonlyArray<string>;
          }>;
        }
      | undefined;
    let refreshing = false;

    const refresh = Effect.gen(function* () {
      const logins = yield* store.select((entries) =>
        entries
          .filter((entry) => entry.key.startsWith(LOGIN_PREFIX))
          .map((entry) => ({ key: entry.key, origins: originsOf(entry.note) })),
      );
      keys = { at: yield* Clock.currentTimeMillis, logins };
    });

    /** At most one refresh at a time; a hung store holds only that one. */
    const startRefresh = Effect.suspend(() => {
      if (refreshing) return Effect.void;
      refreshing = true;
      return refresh.pipe(
        Effect.ignore,
        Effect.ensuring(
          Effect.sync(() => {
            refreshing = false;
          }),
        ),
        Effect.forkIn(scope),
        Effect.asVoid,
      );
    });

    yield* startRefresh.pipe(
      Effect.andThen(Effect.sleep(Duration.millis(KEYS_REFRESH_MS))),
      Effect.forever,
      Effect.forkIn(scope),
    );

    const keysFor = Effect.fn("BrowserLogins.keysFor")(function* (url: string | null) {
      const origin = originOf(url);
      if (origin === undefined) return [];
      const now = yield* Clock.currentTimeMillis;
      if (keys === undefined || now - keys.at > KEYS_TTL_MS) {
        // Never awaited: an unreachable store lists none rather than delaying the tab.
        yield* startRefresh;
        return [];
      }
      return keys.logins
        .filter((login) => login.origins.includes(origin))
        .map((login) => login.key);
    });

    const read = Effect.fn("BrowserLogins.read")(function* (key: string) {
      if (!key.startsWith(LOGIN_PREFIX))
        return yield* new BrowserLoginRefused({ key, reason: "not-login" });
      const found = yield* store
        .select((entries) => {
          const entry = entries.find((candidate) => candidate.key === key);
          return entry === undefined
            ? Option.none<{ readonly value: string; readonly note: string }>()
            : Option.some({ value: entry.value, note: entry.note });
        })
        .pipe(
          Effect.mapError(
            (error) =>
              new BrowserLoginRefused({
                key,
                reason: error.reason === "not-installed" ? "not-configured" : "unreachable",
              }),
          ),
        );
      if (Option.isNone(found) || found.value.value.length === 0)
        return yield* new BrowserLoginRefused({ key, reason: "missing" });
      const origins = originsOf(found.value.note);
      if (origins.length === 0) return yield* new BrowserLoginRefused({ key, reason: "no-origin" });
      return { key, value: found.value.value, origins };
    });

    return BrowserLogins.of({ read, keysFor });
  }),
);

/** Adds the login keys bound to a tab's origin to its status; none listed means no field. */
export const withLoginKeys =
  (logins: BrowserLogins["Service"]) =>
  <S extends { readonly url: string | null }>(status: S) =>
    logins
      .keysFor(status.url)
      .pipe(Effect.map((keys) => (keys.length === 0 ? status : { ...status, logins: keys })));
