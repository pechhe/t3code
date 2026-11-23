import { describe, expect, it } from "vite-plus/test";
import { isSignInPath, rewriteForAutoSignIn } from "./ManagedBrowserSignIn.ts";

const signIn = { path: "/dev/agent-login?as={persona}&next={next}", defaultPersona: "admin" };
const defaults = {
  url: "https://demo.localhost:3102/report?sort=year#totals",
  signIn,
  allowlist: ["demo.localhost:3100-3199", "[::1]:80", "localhost:443"],
  signedInOrigins: new Map<string, string | null>(),
};

describe("managed browser sign-in", () => {
  it("encodes the persona and relative destination and leaves the fragment on the outer URL", () => {
    expect(rewriteForAutoSignIn(defaults)).toEqual({
      url: "https://demo.localhost:3102/dev/agent-login?as=admin&next=%2Freport%3Fsort%3Dyear#totals",
      signInOrigin: "https://demo.localhost:3102",
      signInPathname: "/dev/agent-login",
    });
    const override = rewriteForAutoSignIn({ ...defaults, persona: "lead&next=/elsewhere" });
    expect(new URL(override!.url).searchParams.get("as")).toBe("lead&next=/elsewhere");
    expect(new URL(override!.url).searchParams.get("next")).toBe("/report?sort=year");
  });

  it.each(["http://[::1]/", "https://localhost/", "https://demo.localhost:3199/"])(
    "matches the effective port for %s",
    (url) =>
      expect(rewriteForAutoSignIn({ ...defaults, url })?.signInOrigin).toBe(new URL(url).origin),
  );

  it.each([
    "https://example.com/",
    "https://demo.localhost:3200/",
    "file:///tmp/report",
    "not a URL",
    "https://demo.localhost:3102//example.com/",
    "https://demo.localhost:3102/dev/agent-login?as=explicit",
  ])("does not rewrite %s", (url) => {
    expect(rewriteForAutoSignIn({ ...defaults, url })).toBeNull();
  });

  it("recognizes the exact explicit sign-in route", () => {
    expect(isSignInPath("https://localhost/dev/agent-login?as=explicit#done", signIn)).toBe(true);
    expect(isSignInPath("https://localhost/dev/agent-login/other", signIn)).toBe(false);
  });

  it("skips disabled, opted-out and already signed-in contexts", () => {
    for (const overrides of [
      { signIn: null },
      { allowlist: null },
      { persona: "none" },
      { signedInOrigins: new Map([["https://demo.localhost:3102", "admin"]]) },
    ]) {
      expect(rewriteForAutoSignIn({ ...defaults, ...overrides })).toBeNull();
    }
  });

  it("refuses templates that expand to a different origin", () => {
    expect(
      rewriteForAutoSignIn({
        ...defaults,
        signIn: { ...signIn, path: "/\t/example.com/?next={next}" },
      }),
    ).toBeNull();
  });
});
