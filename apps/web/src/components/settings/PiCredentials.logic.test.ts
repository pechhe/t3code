import type { PiAccount } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { groupPiAccounts, piAccountBadge, previewPiProviderId } from "./PiCredentials.logic";

const account = (
  providerId: string,
  providerFamily: PiAccount["providerFamily"],
  label = providerId,
): PiAccount => ({
  providerId,
  providerFamily,
  label,
  authType: "api_key",
  status: "signedIn",
  source: "auth",
  managed: true,
});

describe("Pi credentials", () => {
  it("groups accounts by who sells them and shows Other providers only when present", () => {
    const groups = groupPiAccounts([
      account("anthropic-work", "anthropic-api", "Work"),
      account("claude-subscription-hfpetch", "claude-subscription", "HFPetch"),
      account("opencode-go-2", "opencode-go"),
    ]);
    expect(
      groups.map((group) => [group.title, group.accounts.map((entry) => entry.providerId)]),
    ).toEqual([
      ["Anthropic / Claude", ["claude-subscription-hfpetch", "anthropic-work"]],
      ["OpenAI / Codex", []],
      ["Antigravity", []],
      ["Command Code", []],
      ["OpenCode Go", ["opencode-go-2"]],
    ]);
    expect(groupPiAccounts([account("openrouter", "other")]).at(-1)?.title).toBe("Other providers");
  });

  it("previews the provider ID the server will give a new account", () => {
    const existing = [account("opencode-go-second", "opencode-go")];
    expect(previewPiProviderId("opencode-go", "Second", existing)).toBe("opencode-go-second-2");
    expect(previewPiProviderId("antigravity", "petch@example.com", existing)).toBe(
      "antigravity-petch",
    );
    expect(previewPiProviderId("anthropic-api", "", existing)).toBe("anthropic-2");
    expect(previewPiProviderId("other", "x", existing)).toBeNull();
  });

  it("says when Pi does not offer an account it holds a credential for", () => {
    expect(piAccountBadge(account("anthropic-work", "anthropic-api"), false).label).toBe(
      "Not registered in Pi",
    );
    expect(
      piAccountBadge({ ...account("commandcode-2", "commandcode"), authType: "oauth" }, true).label,
    ).toBe("API key saved");
    expect(
      piAccountBadge(
        { ...account("antigravity-a", "antigravity"), authType: "oauth", status: "expired" },
        true,
      ).label,
    ).toBe("Sign in again");
  });
});
