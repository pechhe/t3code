import {
  isProviderNativeSubagentThread,
  type ContextRolloverSettings,
  type ExperimentRolloverPolicy,
  type OrchestrationV2AppThread,
  type OrchestrationV2RolloverHold,
} from "@t3tools/contracts";

/** Identifies the compaction addendum and nudges in experiment evidence; bump it when either changes. */
export const COMPACTION_RECIPE = "native-compaction-v1";

/**
 * Appended to the provider's own compaction instructions (Codex `compact_prompt`), so the
 * summary the agent continues from keeps what this product needs.
 */
export const COMPACTION_ADDENDUM = `Also keep, for the agent that continues this conversation:
- The active objective and the user's latest instructions and corrections, quoted exactly where they are not yet done.
- Decisions and constraints that must survive, and an approach that was rejected only when it would otherwise be tried again.
- What is verified (with the check that proved it) versus assumed or still unchecked.
- Live work by identifier and observed status: workspaces, branches and revisions, delegated agents and background tasks, and who owns the next action.
- The next concrete action, and any blocker.
Point to issues, commits, specs and files by path or URL instead of copying them. Never include credentials.`;

const k = (tokens: number) => `${Math.round(tokens / 1000)}k`;

/** Past the soft threshold: reach a natural break before the provider compacts. */
export const rolloverSoftNudge = (used: number) =>
  `Context is at ${k(used)} tokens and will be compacted automatically before it fills. Keep working: at the next natural break (a batch of work finished, a request answered, or before starting a new unit), record unsaved user decisions where they belong (an issue, spec, AGENTS.md or memory) and note the live work you will need afterwards. This is not a request to stop or to summarise for the user; if the task is finished, finish normally.`;

/** Past the hard threshold while work is running. */
export const rolloverHardNudge = (used: number) =>
  `Context is at ${k(used)} tokens and will be compacted at any moment. Finish the step in hand without starting a substantial new one, and make sure unsaved user decisions and live work are recorded where they belong. Then carry on with the task: compaction keeps this conversation, and nothing here asks you to stop.`;

/** The timeline row for a nudge; the nudge text is its detail. */
export const rolloverNudgeSummary = (action: "soft" | "hard", used: number) =>
  `Context at ${k(used)} tokens: ${action === "hard" ? "asked to reach a stopping point before compaction" : "asked to prepare for compaction at the next break"}`;

export interface RolloverThresholds {
  readonly soft: number;
  readonly hard: number;
  /** Provider context boundary after reserving headroom. */
  readonly safetyHard?: number;
}

const NATIVE_COMPACTION_DRIVERS: ReadonlySet<string> = new Set(["claudeAgent", "codex"]);

/**
 * Whether the provider behind `instanceId` compacts its own conversation, so a nudge to prepare
 * for compaction is true. Other providers are not nudged: nothing here falls back to a fresh session.
 */
export function compactsNatively(
  settings: { readonly providerInstances: Readonly<Record<string, { readonly driver: string }>> },
  instanceId: string,
): boolean {
  // A legacy instance id is its driver's name.
  return NATIVE_COMPACTION_DRIVERS.has(
    settings.providerInstances[instanceId]?.driver ?? instanceId,
  );
}

/**
 * The context size at which the provider will compact on its own: the smaller of its context
 * window and the "Auto-compact after" size set on the model's provider instance. Nudges must
 * come before this, so thresholds are bounded by it.
 */
export function compactionBoundary(
  maxTokens: number | null | undefined,
  settings: {
    readonly providerInstances: Readonly<
      Record<string, { readonly driver: string; readonly config?: unknown }>
    >;
  },
  instanceId: string,
): number | null {
  const config = settings.providerInstances[instanceId]?.config;
  const configured =
    typeof config === "object" && config !== null
      ? Number((config as { readonly autoCompactWindow?: unknown }).autoCompactWindow)
      : Number.NaN;
  const limits = [maxTokens, configured].filter(
    (value): value is number => value != null && Number.isFinite(value) && value > 0,
  );
  return limits.length === 0 ? null : Math.min(...limits);
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
 * itself. Only the reactor's own nudges check this.
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

/** Command id prefix of a context nudge; the orchestrator drops one that arrives after its run ended. */
export const ROLLOVER_NUDGE_COMMAND_PREFIX = "server:context-rollover-nudge:";

export type RolloverPhase = "idle" | "softNudged" | "hardNudged";

export type RolloverUsageAction = "none" | "soft" | "hard";

/**
 * How far a conversation must grow past its context after a native compaction before it is
 * nudged again. A compacted context still carries the system prompt, tools and summary;
 * when that alone passes a threshold, another nudge cannot help and would repeat.
 */
export const ROLLOVER_MIN_GROWTH_TOKENS = 20_000;

/**
 * Whether a conversation has grown enough to be nudged. `floor` is its context after the
 * last compaction, or null when it has not compacted.
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
  if (!grownSinceRollover(used, floor)) return "none";
  if (thresholds.safetyHard !== undefined && used >= thresholds.safetyHard) {
    return phase === "hardNudged" ? "none" : "hard";
  }
  if (used >= thresholds.hard) return phase === "hardNudged" ? "none" : "hard";
  if (used >= thresholds.soft) return phase === "idle" ? "soft" : "none";
  return "none";
}
