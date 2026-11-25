import { BLACKHOLE_DEFAULTS, type BlackholeConfig } from "./config.ts";
import type { SessionEntry } from "./session.ts";
import type { AgentLoop, AgentTool } from "./shims/pi-agent-core.ts";
import type { Message, Model } from "./shims/pi-ai.ts";
import { maxDropCountForPool } from "./upstream/om/agents/dropper/selection.ts";
import { runDropper } from "./upstream/om/agents/dropper/agent.ts";
import { runObserver } from "./upstream/om/agents/observer/agent.ts";
import { runReflector } from "./upstream/om/agents/reflector/agent.ts";
import { foldLedger } from "./upstream/om/ledger/fold.ts";
import {
  buildExistingObservationsSummary,
  earlierCoverageMarkerId,
  findLastCompactionIndex,
  isSourceEntry,
  latestCoverageIndex,
  latestCoverageMarkerId,
  observationPoolTokens,
  observationsCreatedAfterIndex,
  rawTokensAfterIndex,
  rawTokensSinceDropCoverage,
  rawTokensSinceReflectionCoverage,
  reflectionsCreatedAfterIndex,
  selectExistingReflections,
} from "./upstream/om/ledger/progress.ts";
import { fullProjection } from "./upstream/om/ledger/projection.ts";
import {
  makeReflectionRenderer,
  observationToSummaryLine,
  renderOptionsFromConfig,
  selectPriorObservations,
  selectPriorReflections,
} from "./upstream/om/ledger/render-summary.ts";
import {
  buildObservationsCoverageData,
  buildObservationsDroppedData,
  buildObservationsRecordedData,
  buildObservationsUnanchoredData,
  buildReflectionsRecordedData,
  type Entry,
  OM_OBSERVATIONS_COVERAGE,
  OM_OBSERVATIONS_DROPPED,
  OM_OBSERVATIONS_RECORDED,
  OM_OBSERVATIONS_UNANCHORED,
  OM_REFLECTIONS_RECORDED,
  type Reflection,
} from "./upstream/om/ledger/types.ts";
import { serializeSourceAddressedBranchEntries } from "./upstream/om/serialize.ts";
import { estimateEntryTokens } from "./upstream/om/tokens.ts";

export type MemoryStage = "observer" | "reflector" | "dropper";

/** One worker call: Blackhole's own system prompt and task, and the one tool it may answer with. */
export interface WorkerRequest {
  readonly stage: MemoryStage;
  readonly system: string;
  readonly prompt: string;
  readonly tool: {
    readonly name: string;
    readonly description: string;
    readonly parameters: unknown;
  };
}

/**
 * Runs a worker on the Utility model and returns the arguments of the one tool call it makes,
 * or null when it declines to call the tool. Pi runs these as multi-turn tool loops; T3 asks for
 * the final batch in one reply.
 */
export type RunWorker = (request: WorkerRequest, signal?: AbortSignal) => Promise<unknown>;

/** A ledger record to append to the thread, as pi-blackhole appends its custom session entries. */
export interface MemoryRecord {
  readonly customType: string;
  readonly data: unknown;
}

const OBSERVER_DRAIN_MAX_BATCHES = 3;
// The workers only size their output budget from this; T3's runners own the real limits.
const WORKER_MODEL: Model = { id: "t3-utility", provider: "t3" };

function textOf(message: Message): string {
  if (typeof message.content === "string") return message.content;
  return message.content.map((part) => ("text" in part ? part.text : "")).join("");
}

/** pi-agent-core's loop, reduced to the one tool call T3's text generation can make per worker. */
function singleCallLoop(stage: MemoryStage, runWorker: RunWorker): AgentLoop {
  return (prompts, context, _config, signal) => {
    const tool = context.tools[0] as AgentTool | undefined;
    let messages: Array<{ stopReason: string; errorMessage?: string }> = [];
    const done = (async () => {
      if (tool === undefined) throw new Error(`${stage} has no tool to answer with.`);
      try {
        const args = await runWorker(
          {
            stage,
            system: context.systemPrompt ?? "",
            prompt: prompts.map(textOf).join("\n\n"),
            tool: { name: tool.name, description: tool.description, parameters: tool.parameters },
          },
          signal,
        );
        if (args === null || args === undefined) {
          messages = [{ stopReason: "stop" }];
          return;
        }
        const result = await tool.execute(`t3-${stage}`, args, signal);
        messages = [{ stopReason: result.terminate === true ? "toolUse" : "stop" }];
      } catch (error) {
        messages = [
          {
            stopReason: signal?.aborted ? "aborted" : "error",
            errorMessage: error instanceof Error ? error.message : String(error),
          },
        ];
      }
    })();
    return {
      async *[Symbol.asyncIterator]() {
        await done;
        yield { type: "agent_end", messages };
      },
      result: () => done,
    };
  };
}

const sourceEntriesAfter = (entries: Entry[], index: number) =>
  entries.slice(index + 1).filter(isSourceEntry);

function capSourceEntriesToTokens(entries: Entry[], maxTokens: number) {
  let total = 0;
  const kept: Entry[] = [];
  for (const entry of entries) {
    const tokens = estimateEntryTokens(entry);
    if (total + tokens > maxTokens) {
      if (kept.length === 0) kept.push(entry);
      break;
    }
    kept.push(entry);
    total += tokens;
  }
  return kept;
}

/**
 * The observer stage (pi-blackhole om/consolidation.ts runObserverStage): once enough unobserved
 * conversation has built up, the oldest chunk becomes timestamped observations. Drains a backlog
 * in up to three bounded batches.
 */
async function observe(
  entries: Entry[],
  config: BlackholeConfig,
  loop: AgentLoop,
  signal: AbortSignal | undefined,
  drain: number,
): Promise<MemoryRecord[]> {
  const coverage = latestCoverageIndex(entries, OM_OBSERVATIONS_RECORDED);
  const start = coverage >= 0 ? coverage : findLastCompactionIndex(entries);
  const tokens = rawTokensAfterIndex(entries, start);
  if (tokens < config.observeAfterTokens && drain === OBSERVER_DRAIN_MAX_BATCHES) return [];
  let chunkEntries = sourceEntriesAfter(entries, start);
  if (tokens > config.observerChunkMaxTokens)
    chunkEntries = capSourceEntriesToTokens(chunkEntries, config.observerChunkMaxTokens);
  const {
    text: chunk,
    sourceEntryIds,
    sourceEntryTimestamps,
  } = serializeSourceAddressedBranchEntries(chunkEntries);
  const coversUpToId = sourceEntryIds.at(-1);
  if (coversUpToId === undefined || chunk.trim() === "") return [];
  const coversFromId = sourceEntryIds[0];

  const renderReflection = makeReflectionRenderer(renderOptionsFromConfig(config));
  const memory = fullProjection(entries, undefined, config.reflectionSupersedes);
  const preambleMaxTokens =
    config.observerPreambleMaxTokens > 0
      ? config.observerPreambleMaxTokens
      : Math.round(config.observerChunkMaxTokens * 0.3);
  const priorObservationRecords = selectPriorObservations(memory.observations, preambleMaxTokens);
  const result = await runObserver({
    model: WORKER_MODEL,
    apiKey: "",
    priorReflections: selectPriorReflections(
      memory.reflections,
      preambleMaxTokens,
      renderReflection,
    ).map(renderReflection),
    priorObservations: priorObservationRecords.map(observationToSummaryLine),
    priorObservationIds: priorObservationRecords.map((observation) => observation.id),
    chunk,
    allowedSourceEntryIds: sourceEntryIds,
    sourceEntryTimestamps,
    maxTurns: config.agentMaxTurns,
    agentLoop: loop as never,
    ...(signal === undefined ? {} : { signal }),
  });

  const records: MemoryRecord[] = [];
  let covered: string | undefined;
  if (result.observations !== undefined && result.observations.length > 0) {
    covered = result.partialCoverageId ?? coversUpToId;
    const data = buildObservationsRecordedData(result.observations, covered);
    if (data !== undefined) records.push({ customType: OM_OBSERVATIONS_RECORDED, data });
  } else if (result.unanchoredObservations !== undefined) {
    const data = buildObservationsUnanchoredData(result.unanchoredObservations);
    if (data !== undefined) records.push({ customType: OM_OBSERVATIONS_UNANCHORED, data });
  } else if (result.coverageComplete === true && coversFromId !== undefined) {
    const data = buildObservationsCoverageData(coversFromId, coversUpToId);
    if (data !== undefined) {
      covered = coversUpToId;
      records.push({ customType: OM_OBSERVATIONS_COVERAGE, data });
    }
  }
  const lastSourceId = entries.filter(isSourceEntry).at(-1)?.id;
  if (covered === undefined || covered === lastSourceId || drain <= 1) return records;
  // Continue the backlog against the ledger as it now stands.
  return [
    ...records,
    ...(await observe(withRecords(entries, records), config, loop, signal, drain - 1)),
  ];
}

let appendedRecords = 0;

/** The session with freshly written records appended at its tip, where Pi appends them. */
function withRecords(entries: Entry[], records: MemoryRecord[]): Entry[] {
  return [
    ...entries,
    ...records.map((record): Entry => ({
      type: "custom",
      id: `t3-pending-${++appendedRecords}`,
      customType: record.customType,
      data: record.data,
    })),
  ];
}

/** The reflector stage (runReflectorStage): new observations distilled into durable reflections. */
async function reflect(
  entries: Entry[],
  config: BlackholeConfig,
  loop: AgentLoop,
  signal: AbortSignal | undefined,
): Promise<{ records: MemoryRecord[]; reflections: Reflection[]; coverageId?: string }> {
  if (rawTokensSinceReflectionCoverage(entries) < config.reflectAfterTokens)
    return { records: [], reflections: [] };
  const observationCoverageId = latestCoverageMarkerId(entries, OM_OBSERVATIONS_RECORDED);
  if (observationCoverageId === undefined) return { records: [], reflections: [] };
  const renderOptions = renderOptionsFromConfig(config);
  const renderReflection = makeReflectionRenderer(renderOptions);
  const folded = foldLedger(entries);
  const lastReflection = latestCoverageIndex(entries, OM_REFLECTIONS_RECORDED);
  const newObservations = observationsCreatedAfterIndex(entries, lastReflection);
  if (newObservations.length === 0) return { records: [], reflections: [] };
  const shown = selectExistingReflections(
    folded.reflections,
    Math.floor(config.reflectorInputMaxTokens * 0.15),
    renderReflection,
  );
  const existingObservationsSummary = buildExistingObservationsSummary(
    folded.activeObservations.filter(
      (observation) => !newObservations.some((fresh) => fresh.id === observation.id),
    ),
    Math.floor(config.reflectorInputMaxTokens * 0.15),
  );
  const existingReflectionsSummary = shown.map(renderReflection).join("\n");
  const result = await runReflector({
    renderReflection,
    timestampsEnabled: renderOptions.timestamps,
    supersedesEnabled: renderOptions.supersedes,
    supersedableReflectionIds: shown.map((reflection) => reflection.id),
    model: WORKER_MODEL,
    apiKey: "",
    reflections: reflectionsCreatedAfterIndex(entries, lastReflection),
    observations: newObservations,
    ...(existingReflectionsSummary === "" ? {} : { existingReflectionsSummary }),
    ...(existingObservationsSummary === "" ? {} : { existingObservationsSummary }),
    maxTurns: config.agentMaxTurns,
    agentLoop: loop as never,
    ...(signal === undefined ? {} : { signal }),
  });
  const reflections = result.reflections ?? [];
  const data =
    reflections.length > 0
      ? buildReflectionsRecordedData(reflections, observationCoverageId)
      : undefined;
  return data === undefined
    ? { records: [], reflections: [] }
    : {
        records: [{ customType: OM_REFLECTIONS_RECORDED, data }],
        reflections,
        coverageId: observationCoverageId,
      };
}

function dropperPressureReached(config: BlackholeConfig, poolTokens: number) {
  const poolMax = config.observationsPoolMaxTokens;
  if (poolMax <= 0 || config.dropperPressureThreshold >= 1) return false;
  return (
    poolTokens / poolMax >= config.dropperPoolFullnessThreshold &&
    poolTokens >= config.dropperPressureThreshold * poolMax
  );
}

/** The dropper stage (runDropperStage): prunes low-value observations from a filling pool. */
async function drop(
  entries: Entry[],
  config: BlackholeConfig,
  loop: AgentLoop,
  signal: AbortSignal | undefined,
  sameRunReflections: Reflection[],
  sameRunReflectionCoverageId: string | undefined,
): Promise<MemoryRecord[]> {
  const pressureRun = dropperPressureReached(config, observationPoolTokens(entries).tokens);
  if (rawTokensSinceDropCoverage(entries) < config.reflectAfterTokens && !pressureRun) return [];
  const observationCoverageId =
    latestCoverageMarkerId(entries, OM_OBSERVATIONS_RECORDED) ??
    (pressureRun ? entries.at(-1)?.id : undefined);
  if (observationCoverageId === undefined) return [];
  const folded = foldLedger(entries);
  const lastDrop = latestCoverageIndex(entries, OM_OBSERVATIONS_DROPPED);
  const candidates = pressureRun
    ? folded.activeObservations
    : observationsCreatedAfterIndex(entries, lastDrop);
  const poolTokens = candidates.reduce((sum, observation) => sum + observation.tokenCount, 0);
  if (
    maxDropCountForPool(
      candidates,
      poolTokens,
      config.observationsPoolMaxTokens,
      config.dropperPoolFullnessThreshold,
    ) <= 0
  )
    return [];
  const known = new Set(folded.reflections.map((reflection) => reflection.id));
  const reflections = [
    ...folded.reflections,
    ...sameRunReflections.filter((reflection) => !known.has(reflection.id)),
  ];
  const existingObservationsSummary = buildExistingObservationsSummary(
    folded.activeObservations.filter(
      (observation) => !candidates.some((candidate) => candidate.id === observation.id),
    ),
    Math.floor(config.dropperInputMaxTokens * 0.2),
  );
  const dropped = await runDropper({
    renderReflection: makeReflectionRenderer(renderOptionsFromConfig(config)),
    model: WORKER_MODEL,
    apiKey: "",
    reflections,
    observations: candidates,
    ...(existingObservationsSummary === "" ? {} : { existingObservationsSummary }),
    budgetTokens: config.observationsPoolMaxTokens,
    skipFullness: config.dropperPoolFullnessThreshold,
    maxTurns: config.agentMaxTurns,
    agentLoop: loop as never,
    ...(signal === undefined ? {} : { signal }),
  });
  if (dropped === undefined || dropped.length === 0) return [];
  const coversUpToId = earlierCoverageMarkerId(
    entries,
    observationCoverageId,
    sameRunReflectionCoverageId ?? latestCoverageMarkerId(entries, OM_REFLECTIONS_RECORDED),
  );
  const data =
    coversUpToId === undefined ? undefined : buildObservationsDroppedData(dropped, coversUpToId);
  return data === undefined ? [] : [{ customType: OM_OBSERVATIONS_DROPPED, data }];
}

/**
 * One consolidation pass over a session: observer, then reflector, then dropper, each only when
 * pi-blackhole's own thresholds say it is due. Returns the ledger records to append, in order;
 * the caller appends them after the session's last entry.
 */
export async function runMemoryCycle(input: {
  readonly entries: ReadonlyArray<SessionEntry>;
  readonly runWorker: RunWorker;
  readonly config?: Partial<BlackholeConfig>;
  readonly signal?: AbortSignal;
}): Promise<MemoryRecord[]> {
  const config = { ...BLACKHOLE_DEFAULTS, ...input.config };
  let entries = [...input.entries] as Entry[];
  const append = (records: MemoryRecord[]) => {
    entries = withRecords(entries, records);
  };
  const observed = await observe(
    entries,
    config,
    singleCallLoop("observer", input.runWorker),
    input.signal,
    OBSERVER_DRAIN_MAX_BATCHES,
  );
  append(observed);
  const reflected = await reflect(
    entries,
    config,
    singleCallLoop("reflector", input.runWorker),
    input.signal,
  );
  append(reflected.records);
  const dropped = await drop(
    entries,
    config,
    singleCallLoop("dropper", input.runWorker),
    input.signal,
    reflected.reflections,
    reflected.coverageId,
  );
  return [...observed, ...reflected.records, ...dropped];
}
