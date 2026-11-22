/**
 * Pi account identity (fork/differences.md `pi-accounts`), shared by the server that writes
 * Pi's credentials and Settings, which shows the provider ID an account will get.
 */
import type { PiAccountFamily } from "@t3tools/contracts";

/** The prefix every provider ID of a family starts with, before `-<name>`. */
const PI_FAMILY_PREFIX: Record<Exclude<PiAccountFamily, "other">, string> = {
  "claude-subscription": "claude-subscription",
  "anthropic-api": "anthropic",
  "openai-codex": "openai-codex",
  "openai-api": "openai",
  antigravity: "antigravity",
  commandcode: "commandcode",
  "opencode-go": "opencode-go",
};

/** Families whose credential is an OAuth sign-in rather than a pasted key. */
export const PI_OAUTH_FAMILIES: ReadonlySet<PiAccountFamily> = new Set([
  "claude-subscription",
  "openai-codex",
  "antigravity",
]);

/** Provider IDs a new account never takes: Pi's own and the extensions' bare providers. */
const PI_RESERVED_PROVIDER_IDS: ReadonlySet<string> = new Set([
  "anthropic",
  "openai",
  "openai-codex",
  "opencode-go",
  "antigravity",
  "commandcode",
]);

/** The family of a credential T3 did not register, from Pi's own provider IDs. */
export function inferPiAccountFamily(
  providerId: string,
  credentialType: "oauth" | "api_key" | undefined,
): PiAccountFamily {
  if (providerId.startsWith("claude-subscription-")) return "claude-subscription";
  if (providerId === "anthropic") {
    return credentialType === "oauth" ? "claude-subscription" : "anthropic-api";
  }
  if (providerId === "openai-codex" || providerId.startsWith("openai-codex-"))
    return "openai-codex";
  if (providerId === "openai") return "openai-api";
  if (providerId === "antigravity" || providerId.startsWith("antigravity-")) return "antigravity";
  if (providerId === "commandcode" || providerId.startsWith("commandcode-")) return "commandcode";
  if (providerId === "opencode-go" || providerId.startsWith("opencode-go-")) return "opencode-go";
  return "other";
}

function slug(value: string): string {
  return value
    .toLowerCase()
    .replace(/@.*$/, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 24)
    .replace(/-+$/g, "");
}

/** A new provider ID for an account of `family` named `label`, never one already taken. */
export function allocatePiProviderId(
  family: Exclude<PiAccountFamily, "other">,
  label: string,
  taken: ReadonlySet<string>,
): string {
  const prefix = PI_FAMILY_PREFIX[family];
  const base = slug(label);
  const unavailable = (id: string) => taken.has(id) || PI_RESERVED_PROVIDER_IDS.has(id);
  const first = base.length > 0 ? `${prefix}-${base}` : `${prefix}-2`;
  if (!unavailable(first)) return first;
  for (let index = 2; ; index += 1) {
    const candidate = base.length > 0 ? `${prefix}-${base}-${index}` : `${prefix}-${index}`;
    if (!unavailable(candidate)) return candidate;
  }
}
