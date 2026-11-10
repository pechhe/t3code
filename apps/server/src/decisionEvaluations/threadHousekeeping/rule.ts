import type { DecisionRequest } from "@t3tools/contracts";
import { PROJECT_QUESTION, WAKE_CHOICES, WAKE_QUESTION } from "./definitions.ts";
import type { Engine, ProjectCase, WakeCase } from "./types.ts";

export const RULE = { id: "thread-housekeeping-pilot", version: "1" } as const;

const line = (e: { role: string; n: number; text: string }) =>
  `[${e.role}${e.role === "user" ? ` ${e.n}` : ""}] ${e.text}`;

/**
 * The engine sees the conversation up to one turn and the projects with their recent chat titles, nothing else: not where the chat
 * ended up, the keyword rule, the labels or any later turn. Shape fixed before the run: at most 12 projects with 5 titles of 70
 * characters, the first message cut to 700 characters, up to two later user messages and the last assistant message cut to 400.
 */
export const buildProjectRequest = (
  engine: Engine,
  c: ProjectCase,
  askIndex: number,
): DecisionRequest => ({
  engine,
  rule: { id: `${RULE.id}-project`, version: RULE.version },
  evidence: { conversation: c.asks[askIndex]!.evidence.map(line) },
  questions: [
    {
      id: "project",
      type: "choice",
      instructions: PROJECT_QUESTION,
      choices: [
        ...c.projects.map((p) => ({
          label: p.choice,
          description: `${p.title} (folder ${p.root}). Recent chats: ${p.recent.join(" | ") || "none yet"}`,
        })),
        { label: "none", description: "The chat is general and belongs in no project." },
        { label: "unknown", description: "The conversation does not support a confident choice." },
      ],
    },
  ],
});

/** The wake and the thread's four most recent messages (each cut to 500 characters; the wake's summary and detail to 1000 each). */
export const buildWakeRequest = (engine: Engine, c: WakeCase): DecisionRequest => ({
  engine,
  rule: { id: `${RULE.id}-wake`, version: RULE.version },
  evidence: {
    thread: c.threadTitle ?? "",
    recentMessages: c.prior.map((p) => `[${p.role}] ${p.text}`),
    wake: {
      kind: c.source ?? "",
      outcome: c.outcome ?? "",
      summary: c.wake.summary,
      detail: c.wake.detail,
    },
  },
  questions: [
    { id: "wake", type: "choice", instructions: WAKE_QUESTION, choices: [...WAKE_CHOICES] },
  ],
});
