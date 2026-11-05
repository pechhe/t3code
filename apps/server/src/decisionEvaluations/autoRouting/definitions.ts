import { PROJECTS, type Decision, type ProjectKey } from "./corpusTypes.ts";

export const PROJECT_DESCRIPTIONS: Readonly<Record<ProjectKey, string>> = {
  T3Peach:
    "Henry's fork of T3 Code: a Node WebSocket server wrapping coding-agent providers, with web, desktop and mobile clients, delegation, MCP tools and the fork's records.",
  YardSmith:
    "The YardSmith product monorepo: the Smith support assistant, the Hum mail assistant, the shared kit and the Forge work tracker.",
  Weave:
    "Weave, the internal workspace app inside the YardSmith monorepo: docs, mail, CRM, tasks and Forge over MCP.",
  PropSmith: "PropSmith, a placeholder for a property product inside the YardSmith monorepo.",
  SlipJay:
    "SlipJay, the delivery tool: agent workspaces, landing gates, the runner, promotion and release.",
  Agents:
    "The .agents configuration repository: global agent guidance, skills, roles and the delegation policy.",
  Homebase: "Homebase: personal notes and tools for food, Telegram and the VPS.",
  OddsAndEnds:
    "Small personal macOS tools: the Lodestone media player and the guard network blocker.",
  Splay: "Splay, a native macOS menu-bar app for per-application audio output routing.",
  NoProject: "No project: scratch conversations that need no repository.",
};

export const WORKFLOW_DEFINITIONS = {
  chat: "Answer or discuss only. Nothing in a repository is changed, so no workspace, plan or delivery is needed.",
  solo: "One agent makes a small, clear change directly and lands it as a chore: the way is obvious and one reviewer-free pass is enough.",
  shape:
    "The intent is not settled: work out what to build, the options or the scope and write it down before anyone implements it.",
  lead: "Substantial, settled work that needs written acceptance, independent review and coordinated delivery across components, led end to end.",
} as const;

export const TIER_DEFINITIONS = {
  routine:
    "Well-specified, local, low-risk work whose correctness is easy to see from the result. A cheaper, faster model is likely to finish it correctly without escalation.",
  demanding:
    "Work where a mistake is costly or hard to see: cross-cutting changes, security, permissions, concurrency or data, unclear requirements, or work needing deep reading of existing code. It warrants the strongest eligible model.",
} as const;

export const DECISION_QUESTIONS: Readonly<Record<Decision, string>> = {
  project:
    "Which project does this request belong to? Choose NoProject when it needs no repository. Choose unknown when the request does not say and could belong to several projects.",
  workflow:
    "Which workflow should handle this request? Choose the lightest one that is safe. Choose unknown when it cannot be judged from the request.",
  mainModel:
    "How hard is this request for the model that talks with the user and decides how to do it? Choose demanding when a mistake would be costly or hard to see, or the request is unclear.",
  subagentTier:
    "If a delegated worker did the implementation part of this request on its own, which tier of worker should it get? Choose demanding when a wrong result would be costly or hard to see, or the request is unclear.",
};

export const CHOICES = {
  project: [...PROJECTS].map((label) => ({ label, description: PROJECT_DESCRIPTIONS[label] })),
  workflow: Object.entries(WORKFLOW_DEFINITIONS).map(([label, description]) => ({
    label,
    description,
  })),
  mainModel: Object.entries(TIER_DEFINITIONS).map(([label, description]) => ({
    label,
    description,
  })),
  subagentTier: Object.entries(TIER_DEFINITIONS).map(([label, description]) => ({
    label,
    description,
  })),
} as const;
