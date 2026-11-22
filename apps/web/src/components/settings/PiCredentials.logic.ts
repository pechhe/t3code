import type {
  PiAccount,
  PiAccountFamily,
  ServerProvider,
  ServerProviderUsageSlot,
} from "@t3tools/contracts";
import { allocatePiProviderId, PI_OAUTH_FAMILIES } from "@t3tools/shared/piAccounts";

export interface PiCredentialGroup {
  readonly id: string;
  readonly title: string;
  /** The families an account added here can be, in the order the add form lists them. */
  readonly families: ReadonlyArray<PiAccountFamily>;
  readonly accounts: ReadonlyArray<PiAccount>;
}

/** Grouped by who sells the credential, as Henry thinks of his subscriptions. */
const GROUPS: ReadonlyArray<Omit<PiCredentialGroup, "accounts">> = [
  {
    id: "anthropic",
    title: "Anthropic / Claude",
    families: ["claude-subscription", "anthropic-api"],
  },
  { id: "openai", title: "OpenAI / Codex", families: ["openai-codex", "openai-api"] },
  { id: "antigravity", title: "Antigravity", families: ["antigravity"] },
  { id: "commandcode", title: "Command Code", families: ["commandcode"] },
  { id: "opencode-go", title: "OpenCode Go", families: ["opencode-go"] },
  { id: "other", title: "Other providers", families: ["other"] },
];

export const PI_FAMILY_LABEL: Record<PiAccountFamily, string> = {
  "claude-subscription": "Claude subscription",
  "anthropic-api": "Anthropic API credits",
  "openai-codex": "Codex subscription",
  "openai-api": "OpenAI API credits",
  antigravity: "Antigravity login",
  commandcode: "Command Code key",
  "opencode-go": "OpenCode Go key",
  other: "Another Pi provider's key",
};

/** Every group but Other providers shows even when empty, so an account can be added there. */
export function groupPiAccounts(
  accounts: ReadonlyArray<PiAccount>,
): ReadonlyArray<PiCredentialGroup> {
  return GROUPS.flatMap((group) => {
    const members = accounts
      .filter((account) => group.families.includes(account.providerFamily))
      .toSorted((left, right) => left.label.localeCompare(right.label));
    return group.id === "other" && members.length === 0 ? [] : [{ ...group, accounts: members }];
  });
}

export const isSignInFamily = (family: PiAccountFamily) => PI_OAUTH_FAMILIES.has(family);

/** The provider ID a new account will get, as the server allocates it. */
export function previewPiProviderId(
  family: PiAccountFamily,
  label: string,
  accounts: ReadonlyArray<PiAccount>,
): string | null {
  if (family === "other") return null;
  return allocatePiProviderId(
    family,
    label,
    new Set(accounts.map((account) => account.providerId)),
  );
}

export type PiAccountBadge = {
  readonly label: string;
  readonly variant: "success" | "warning" | "info";
};

export function piAccountBadge(account: PiAccount, registered: boolean): PiAccountBadge {
  if (account.status === "missing") {
    return {
      label: account.authType === "oauth" || account.authType === null ? "Not signed in" : "No key",
      variant: "warning",
    };
  }
  if (account.status === "expired") return { label: "Sign in again", variant: "warning" };
  if (!registered) return { label: "Not registered in Pi", variant: "warning" };
  if (account.source === "models") return { label: "Key from models.json", variant: "info" };
  // Command Code stores a pasted key in OAuth's shape; only sign-in families have a sign-in.
  return isSignInFamily(account.providerFamily) && account.authType === "oauth"
    ? { label: "OAuth · Signed in", variant: "success" }
    : { label: "API key saved", variant: "success" };
}

/** Whether Pi offers any model under this provider ID, which only a registered one does. */
export function piProviderRegistered(
  provider: ServerProvider | undefined,
  providerId: string,
): boolean {
  return provider?.models.some((model) => model.slug.startsWith(`${providerId}/`)) ?? false;
}

export function piAccountSlot(
  provider: ServerProvider | undefined,
  providerId: string,
): ServerProviderUsageSlot | undefined {
  return provider?.usageSlots?.find((slot) => slot.accountKey === providerId);
}

/** API-credit accounts are the ones a monthly budget tracks. */
export const hasBudget = (account: PiAccount) =>
  account.providerFamily === "anthropic-api" || account.providerFamily === "openai-api";
