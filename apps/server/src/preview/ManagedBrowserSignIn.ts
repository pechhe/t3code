import type { AgentBrowserSignIn } from "@t3tools/contracts";
import type { BrowserContext, Response } from "playwright-core";
import { allowedAddress } from "./ManagedBrowserProxy.ts";
import { ServerBrowserOperationError } from "./ServerBrowserPage.ts";

const placeholders = /\{(?:persona|next)\}/g;
const signedInByContext = new WeakMap<BrowserContext, Map<string, string | null>>();

const allowedUrl = (url: string, allowlist: ReadonlyArray<string>) => {
  const parsed = URL.parse(url);
  if (!parsed || (parsed.protocol !== "http:" && parsed.protocol !== "https:")) return null;
  const port = Number(parsed.port) || (parsed.protocol === "https:" ? 443 : 80);
  return allowedAddress(parsed.hostname, port, allowlist) ? parsed : null;
};

export const isSignInPath = (url: string, signIn: AgentBrowserSignIn) => {
  const route = URL.parse(signIn.path.replace(placeholders, "x"), "http://localhost");
  return route !== null && URL.parse(url)?.pathname === route.pathname;
};

export const rewriteForAutoSignIn = ({
  url,
  signIn,
  allowlist,
  signedInOrigins,
  persona,
}: {
  url: string;
  signIn: AgentBrowserSignIn | null;
  allowlist: ReadonlyArray<string> | null;
  signedInOrigins: ReadonlyMap<string, string | null>;
  persona?: string | null;
}) => {
  if (signIn === null || allowlist === null || persona === "none") return null;
  const parsed = allowedUrl(url, allowlist);
  if (!parsed || signedInOrigins.has(parsed.origin) || isSignInPath(url, signIn)) return null;
  const nextPath = parsed.pathname + parsed.search;
  // A protocol-relative path is not a same-origin redirect target.
  if (nextPath.startsWith("//")) return null;
  const expanded = signIn.path.replace(placeholders, (key) =>
    encodeURIComponent(key === "{persona}" ? (persona ?? signIn.defaultPersona) : nextPath),
  );
  const rewritten = URL.parse(expanded, parsed.origin);
  if (!rewritten || rewritten.origin !== parsed.origin) return null;
  rewritten.hash = parsed.hash;
  return { url: rewritten.href, signInOrigin: parsed.origin, signInPathname: rewritten.pathname };
};

export const prepareAutoSignIn = (
  context: BrowserContext,
  url: string,
  policy: { signIn: AgentBrowserSignIn | null; allowlist: ReadonlyArray<string> },
  persona: string | undefined,
  defaultPersona: string | undefined,
) => {
  const { signIn, allowlist } = policy;
  if (signIn === null) return null;
  const parsed = allowedUrl(url, allowlist);
  if (!parsed) return null;
  let signedInOrigins = signedInByContext.get(context);
  if (!signedInOrigins) {
    signedInOrigins = new Map();
    signedInByContext.set(context, signedInOrigins);
  }
  const existing = signedInOrigins.get(parsed.origin);
  if (
    existing !== undefined &&
    persona !== undefined &&
    persona !== "none" &&
    persona !== existing
  ) {
    const identity = existing === null ? "an unknown persona" : JSON.stringify(existing);
    throw new ServerBrowserOperationError({
      tag: "PreviewAutomationExecutionError",
      message: `The shared browser context is already signed into ${parsed.origin} as ${identity}. Use a fresh browser context to sign in with a different persona.`,
    });
  }
  const effectivePersona = persona ?? defaultPersona ?? signIn.defaultPersona;
  const rewritten = rewriteForAutoSignIn({
    url,
    signIn,
    allowlist,
    signedInOrigins,
    persona: effectivePersona,
  });
  if (!rewritten && !isSignInPath(url, signIn)) return null;
  const signInOrigin = rewritten?.signInOrigin ?? parsed.origin;
  const signInPathname = rewritten?.signInPathname ?? parsed.pathname;
  return {
    url: rewritten?.url ?? url,
    complete: (response: Response | null, committedUrl: string) => {
      if (!response) return;
      const status = response.status();
      const stayed = URL.parse(committedUrl)?.pathname === signInPathname;
      if (stayed && status >= 400) {
        throw new ServerBrowserOperationError({
          tag: "PreviewAutomationExecutionError",
          message: `${rewritten ? "Automatic agent sign-in" : "Agent sign-in"} at ${signInOrigin}${signInPathname} failed with HTTP ${status}.`,
        });
      }
      if (!stayed || response.ok())
        signedInOrigins.set(signInOrigin, rewritten ? effectivePersona : null);
    },
  };
};
