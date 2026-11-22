// Installed as `<agentDir>/extensions/t3-accounts.ts`, so Pi loads it in every launch, T3's
// and the terminal's. No T3 imports inside the string; Pi resolves its own packages.
export const PI_ACCOUNTS_EXTENSION_SOURCE = `\
// Written by T3 Code (Settings → Accounts). Edits are replaced; manage accounts in T3 Code.
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

import { builtinProviders } from "@earendil-works/pi-ai/providers/all";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";

// Each family T3 Code clones from a Pi built-in, with only the credential it may use.
const FAMILIES: Record<string, { base: string; auth: "oauth" | "apiKey" }> = {
  "anthropic-api": { base: "anthropic", auth: "apiKey" },
  "openai-api": { base: "openai", auth: "apiKey" },
  "openai-codex": { base: "openai-codex", auth: "oauth" },
  "opencode-go": { base: "opencode-go", auth: "apiKey" },
};

function agentDir(): string {
  const configured = process.env.PI_CODING_AGENT_DIR?.trim();
  if (!configured) return join(homedir(), ".pi", "agent");
  return configured.startsWith("~") ? join(homedir(), configured.slice(1)) : configured;
}

function managedAccounts(): Array<{ providerId: string; providerFamily: string; label: string }> {
  try {
    const parsed = JSON.parse(readFileSync(join(agentDir(), "t3-accounts.json"), "utf8"));
    return Array.isArray(parsed?.accounts) ? parsed.accounts : [];
  } catch {
    return [];
  }
}

/** The stored key only: never an environment variable another account also uses. */
function storedKeyOnly(name: string) {
  return {
    name,
    login: async (interaction: any) => {
      interaction.signal.throwIfAborted();
      return { type: "api_key", key: await interaction.prompt({ type: "secret", message: \`Enter \${name}\` }) };
    },
    resolve: async ({ credential }: any) =>
      credential?.key ? { auth: { apiKey: credential.key }, env: credential.env, source: "stored credential" } : undefined,
  };
}

export default function t3Accounts(pi: ExtensionAPI): void {
  const builtins = builtinProviders();
  for (const account of managedAccounts()) {
    const family = FAMILIES[account?.providerFamily];
    const id = account?.providerId;
    if (!family || typeof id !== "string" || id === family.base || !/^[a-z0-9][a-z0-9-]*$/.test(id)) continue;
    const base = builtins.find((provider: any) => provider.id === family.base);
    if (!base) continue;
    const name = typeof account.label === "string" && account.label.trim() ? account.label.trim() : id;
    const auth =
      family.auth === "oauth"
        ? base.auth.oauth && { oauth: { ...base.auth.oauth, name } }
        : { apiKey: storedKeyOnly(\`\${name} API key\`) };
    if (!auth) continue;
    pi.registerProvider({
      ...base,
      id,
      name,
      auth,
      getModels: () => base.getModels().map((model: any) => ({ ...model, provider: id })),
      ...(base.getAllModels
        ? { getAllModels: () => base.getAllModels!().map((model: any) => ({ ...model, provider: id })) }
        : {}),
    } as any);
  }
}
`;
