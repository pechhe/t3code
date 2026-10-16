import {
  isProviderNativeSubagentThread,
  type ContextRolloverSettings,
  type ExperimentRolloverPolicy,
  type OrchestrationV2AppThread,
  type OrchestrationV2RolloverHold,
  type OrchestrationV2Run,
  type RunId,
  type ThreadId,
} from "@t3tools/contracts";
import { DEFAULT_HANDOFF_TOKEN_CAP } from "@t3tools/provider-core/server/handoffBudget";
import * as Context from "effect/Context";

/** The T3 MCP tool an agent writes its rollover note with. */
export const ROLLOVER_NOTE_TOOL_NAME = "t3_write_rollover_note";
/** Identifies the note prompt and capture; bump it when either changes. */
export const ROLLOVER_NOTE_RECIPE = "rollover-v1";

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
  `Context is at ${k(used)} tokens. Do not hand off mid-step: at the next natural break (a batch of work finished, a request answered, or before starting a new unit), record unsaved user decisions where they belong, write a handoff note with ${ROLLOVER_NOTE_TOOL_NAME} and end your turn. T3 then continues this thread on a fresh session seeded with the note. That turn is not the end of the task: do not close it with a final status or summary for the user. Skip the handoff only when this thread's whole body of work is finished and nothing remains for it; answering one request does not finish a thread that has more to do. Until you hand off, T3 asks again each turn. A hard handoff is asked for at ${k(hard)}.`;

/** Past the hard threshold while work is running. */
export const rolloverHardNudge = (used: number) =>
  `Context is at ${k(used)} tokens: hand off now. Finish the step in hand without starting new work, record unsaved user decisions where they belong, then write a handoff note with ${ROLLOVER_NOTE_TOOL_NAME} and end your turn without a final status or summary for the user: T3 continues the thread on a fresh session.`;

/** The timeline row for a nudge; the nudge text is its detail. */
export const rolloverNudgeSummary = (action: "soft" | "hard", used: number) =>
  `Context at ${k(used)} tokens: ${action === "hard" ? "asked for a handoff now" : "asked for a handoff at the next break"}`;

export interface RolloverThresholds {
  readonly soft: number;
  readonly hard: number;
  /** Provider context boundary after reserving room to write the note. */
  readonly safetyHard?: number;
}

/** Unknown provider limits leave the explicit configured thresholds unchanged. */
export function boundRolloverThresholds(
  thresholds: RolloverThresholds,
  maxTokens: number | null | undefined,
): RolloverThresholds {
  if (maxTokens == null || !Number.isFinite(maxTokens) || maxTokens <= 0) return thresholds;
  const headroom = Math.min(20_000, Math.ceil(maxTokens * 0.1));
  const safetyHard = Math.max(1, maxTokens - headroom);
  const hard = Math.min(thresholds.hard, safetyHard);
  return { soft: Math.min(thresholds.soft, Math.floor(safetyHard * 0.8)), hard, safetyHard };
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

/**
 * An assigned experiment changes timing, retaining thread ownership restrictions. A
 * thread's own thresholds, set from its composer, win over both the settings and the
 * experiment, and turn rollover on for that thread.
 */
export function assignedRolloverThresholds(
  settings: ContextRolloverSettings,
  thread: Pick<OrchestrationV2AppThread, "lineage" | "creationSource" | "rolloverThresholds">,
  model: string,
  policy: ExperimentRolloverPolicy | undefined,
): RolloverThresholds | null {
  const own = thread.rolloverThresholds;
  if (own != null) {
    return threadRolloverThresholds(
      {
        ...settings,
        enabled: true,
        delegatedThreads: true,
        modelRules: [],
        softThreshold: own.soft,
        hardThreshold: own.hard,
      },
      thread,
      model,
    );
  }
  if (policy === undefined) return threadRolloverThresholds(settings, thread, model);
  return threadRolloverThresholds(
    {
      ...settings,
      enabled: true,
      modelRules: [],
      softThreshold: policy.softLimit,
      hardThreshold: policy.hardLimit,
    },
    thread,
    model,
  );
}

/**
 * Whether a thread's rollover hold stops new nudges at `nowMs`. A pause ends by
 * itself. A note already written or asked for is not withdrawn: only the
 * reactor's own nudges check this.
 */
export function rolloverHeld(
  hold: OrchestrationV2RolloverHold | null | undefined,
  nowMs: number,
): boolean {
  if (hold == null) return false;
  return hold.kind === "off" || Date.parse(hold.until) > nowMs;
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

/**
 * How far a session that began with a rollover must grow past its starting
 * context before it is asked for another note. A fresh session already carries
 * the system prompt, tools and the note; when that alone passes a threshold,
 * another rollover cannot free anything and would loop.
 */
export const ROLLOVER_MIN_GROWTH_TOKENS = 20_000;

/**
 * Whether a session has grown enough to roll over. `floor` is its context when
 * it began with a rollover, or null when it did not.
 */
export function grownSinceRollover(used: number, floor: number | null): boolean {
  return floor === null || used >= floor + ROLLOVER_MIN_GROWTH_TOKENS;
}

/** Which nudge a usage report calls for, given what the thread was already told. */
export function rolloverUsageAction(
  phase: RolloverPhase,
  used: number,
  thresholds: RolloverThresholds,
  floor: number | null,
): RolloverUsageAction {
  // The loop guard may delay a configured handoff, never a known context boundary.
  if (thresholds.safetyHard !== undefined && used >= thresholds.safetyHard) {
    return phase === "hardNudged" ? "none" : "hard";
  }
  if (!grownSinceRollover(used, floor)) return "none";
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
