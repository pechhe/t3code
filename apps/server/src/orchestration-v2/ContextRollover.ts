import {
  isProviderNativeSubagentThread,
  type ContextRolloverSettings,
  type OrchestrationV2AppThread,
  type OrchestrationV2Run,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import { DEFAULT_HANDOFF_TOKEN_CAP } from "@t3tools/provider-core/server/handoffBudget";
import * as Context from "effect/Context";

/** The T3 MCP tool an agent writes its rollover note with. */
export const ROLLOVER_NOTE_TOOL_NAME = "t3_write_rollover_note";

/**
 * The fresh session receives the note through the handoff budget (bytes, by default
 * DEFAULT_HANDOFF_TOKEN_CAP); a note over the budget would be left out whole. Keep
 * room for the handoff's coverage line and framing.
 */
export const ROLLOVER_NOTE_MAX_BYTES = DEFAULT_HANDOFF_TOKEN_CAP - 4_000;

export const ROLLOVER_NOTE_SECTIONS = `## Goal
## Completed and verified (each with the check that proved it)
## Done, not yet verified
## Tried and rejected (approaches ruled out, and why)
## Live work (worktrees, agents, background tasks: id, state, owner)
## Blockers
## Unsaved decisions (user decisions with no durable home yet; point to the rest where you recorded them)
## Queue (next steps, in order)
## User's todo list
## In-flight message (the latest user instruction not yet completed, quoted exactly)
## Gotchas
## Restart steps (exact first actions after resuming)`;

export const ROLLOVER_NOTE_RULES = `Before writing it, record each unsaved user decision where it belongs (an issue, AGENTS.md, a spec or memory) and point to it there. Point to issues, commits, specs, diffs and files by path or URL instead of copying them. Redact secrets. Keep it under about 1,500 words: notes over ${ROLLOVER_NOTE_MAX_BYTES.toLocaleString("en-US")} bytes are refused. Write only what the next context cannot rediscover cheaply.`;

export const ROLLOVER_RESUME_TEXT =
  "Context rolled over: this is a fresh session seeded with your handoff note. Follow its restart steps, then continue.";

const k = (tokens: number) => `${Math.round(tokens / 1000)}k`;

/** Past the soft threshold: hand off at the next natural break, not mid-step. */
export const rolloverSoftNudge = (used: number, hard: number) =>
  `Context is at ${k(used)} tokens. Do not hand off mid-step: at the next natural break (a batch of work finished, or before starting a new unit), record unsaved user decisions where they belong, write a handoff note with ${ROLLOVER_NOTE_TOOL_NAME} and end your turn. T3 then continues this thread on a fresh session seeded with the note. A hard handoff is asked for at ${k(hard)}.`;

/** Past the hard threshold, or at a run's end after an unanswered soft nudge. */
export const rolloverHardNudge = (used: number) =>
  `Context is at ${k(used)} tokens: hand off now. Finish the step in hand without starting new work, record unsaved user decisions where they belong, then write a handoff note with ${ROLLOVER_NOTE_TOOL_NAME} and end your turn.`;

export interface RolloverThresholds {
  readonly soft: number;
  readonly hard: number;
}

/**
 * The thresholds that apply to `model`, or null when rollover is off for it.
 * The first rule whose pattern the model id contains (ignoring case) wins.
 */
export function resolveRolloverThresholds(
  settings: ContextRolloverSettings,
  model: string,
): RolloverThresholds | null {
  if (!settings.enabled) return null;
  const id = model.toLowerCase();
  const rule = settings.modelRules.find((candidate) =>
    id.includes(candidate.modelPattern.toLowerCase()),
  );
  if (rule === undefined) return { soft: settings.softThreshold, hard: settings.hardThreshold };
  return rule.enabled ? { soft: rule.softThreshold, hard: rule.hardThreshold } : null;
}

/**
 * The thresholds for a thread running `model`, or null when it does not roll
 * over. Provider-native subagents own their conversation; delegated children
 * roll over only when the setting allows it.
 */
export function threadRolloverThresholds(
  settings: ContextRolloverSettings,
  thread: Pick<OrchestrationV2AppThread, "lineage" | "creationSource">,
  model: string,
): RolloverThresholds | null {
  if (isProviderNativeSubagentThread(thread)) return null;
  if (thread.lineage.relationshipToParent === "subagent" && !settings.delegatedThreads) {
    return null;
  }
  return resolveRolloverThresholds(settings, model);
}

/** The lowest soft threshold any model rolls over at, or null when rollover is off. */
export function lowestSoftThreshold(settings: ContextRolloverSettings): number | null {
  if (!settings.enabled) return null;
  return Math.min(
    settings.softThreshold,
    ...settings.modelRules.filter((rule) => rule.enabled).map((rule) => rule.softThreshold),
  );
}

export type RolloverPhase = "idle" | "softNudged" | "hardNudged";

export type RolloverUsageAction = "none" | "soft" | "hard";

/** Which nudge a usage report calls for, given what the thread was already told. */
export function rolloverUsageAction(
  phase: RolloverPhase,
  used: number,
  thresholds: RolloverThresholds,
): RolloverUsageAction {
  if (used >= thresholds.hard) return phase === "hardNudged" ? "none" : "hard";
  if (used >= thresholds.soft) return phase === "idle" ? "soft" : "none";
  return "none";
}

export interface RolloverNote {
  readonly runId: RunId;
  readonly note: string;
}

/**
 * Notes agents have written, waiting for their run to end. Held in memory:
 * a server restart drops them, and the next usage report asks again.
 */
export interface RolloverNotes {
  readonly save: (threadId: ThreadId, note: RolloverNote) => void;
  readonly get: (threadId: ThreadId) => RolloverNote | undefined;
  readonly delete: (threadId: ThreadId) => void;
  /** A run whose note is waiting holds a delegated child's result for the rollover run. */
  readonly holdsResult: (run: Pick<OrchestrationV2Run, "id" | "threadId">) => boolean;
}

export function makeRolloverNotes(): RolloverNotes {
  const notes = new Map<ThreadId, RolloverNote>();
  return {
    save: (threadId, note) => void notes.set(threadId, note),
    get: (threadId) => notes.get(threadId),
    delete: (threadId) => void notes.delete(threadId),
    holdsResult: (run) => notes.get(run.threadId)?.runId === run.id,
  };
}

/** One registry per process, shared by the orchestrator, the reactor and the MCP tool. */
export class ContextRolloverNotes extends Context.Reference<RolloverNotes>(
  "t3/orchestration-v2/ContextRolloverNotes",
  { defaultValue: makeRolloverNotes },
) {}
