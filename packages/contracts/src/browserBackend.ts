import * as Schema from "effect/Schema";

export const BrowserBackend = Schema.Literals(["integrated", "phi"]);
export type BrowserBackend = typeof BrowserBackend.Type;

/** One value so a project override cannot inherit a disabled default. */
export const AgentBrowserBackends = Schema.Struct({
  enabled: Schema.Array(BrowserBackend).check(Schema.isMinLength(1)).check(Schema.isMaxLength(2)),
  default: BrowserBackend,
}).check(
  Schema.makeFilter(
    (value) =>
      (new Set(value.enabled).size === value.enabled.length &&
        value.enabled.includes(value.default)) ||
      "Browser backends must be unique and include the default.",
  ),
);
export type AgentBrowserBackends = typeof AgentBrowserBackends.Type;
export const DEFAULT_AGENT_BROWSER_BACKENDS: AgentBrowserBackends = {
  enabled: ["integrated"],
  default: "integrated",
};

/**
 * `shadow` is a hidden incognito window, `agents` the shared sign-in Space, and `user` the
 * window the user is looking at, so an agent can carry on in a tab they already have open.
 */
export const PhiBrowserLane = Schema.Literals(["shadow", "agents", "user"]);
export type PhiBrowserLane = typeof PhiBrowserLane.Type;
