import type { AgentBrowserBackends } from "@t3tools/contracts";

/** One picker choice per valid `AgentBrowserBackends` value, shared by every client. */
export const AGENT_BROWSER_BACKEND_CHOICES = [
  {
    id: "integrated",
    label: "T3 browser",
    description: "Agents use the browser built into T3 Code.",
    value: { enabled: ["integrated"], default: "integrated" },
  },
  {
    id: "phi",
    label: "Phi",
    description: "Agents use Phi on the Mac. Nothing falls back to the T3 browser.",
    value: { enabled: ["phi"], default: "phi" },
  },
  {
    id: "both-integrated",
    label: "Both, T3 browser first",
    description: "Agents can use either; new tabs open in the T3 browser unless they ask for Phi.",
    value: { enabled: ["integrated", "phi"], default: "integrated" },
  },
  {
    id: "both-phi",
    label: "Both, Phi first",
    description: "Agents can use either; new tabs open in Phi unless they ask for the T3 browser.",
    value: { enabled: ["integrated", "phi"], default: "phi" },
  },
] as const satisfies ReadonlyArray<{
  readonly id: string;
  readonly label: string;
  readonly description: string;
  readonly value: AgentBrowserBackends;
}>;

export type AgentBrowserBackendChoiceId = (typeof AGENT_BROWSER_BACKEND_CHOICES)[number]["id"];

export function agentBrowserBackendChoiceId(
  backends: AgentBrowserBackends,
): AgentBrowserBackendChoiceId {
  const both = backends.enabled.length === 2;
  if (both) return backends.default === "phi" ? "both-phi" : "both-integrated";
  return backends.default === "phi" ? "phi" : "integrated";
}
