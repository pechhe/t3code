import {
  type ModelCapabilities,
  type OrchestrationV2AppThread,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
  RunSetupRecord,
  type RunSetupReportEntry,
  type RunSetupFile,
  type RunSetupSkill,
} from "@t3tools/contracts";
import * as Config from "effect/Config";
import * as Crypto from "effect/Crypto";
import * as Hex from "effect/encoding/Hex";
import * as Context from "effect/Context";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Semaphore from "effect/Semaphore";
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import {
  buildProviderOptionSelectionsFromDescriptors,
  getProviderOptionDescriptors,
} from "@t3tools/shared/model";
import * as ExperimentService from "../experiments/ExperimentService.ts";
import * as InstructionOverlay from "../experiments/InstructionOverlay.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { forkParked } from "../serverActivation.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import * as AgentConfigCheckout from "./AgentConfigCheckout.ts";
import * as Policy from "./AgentPolicyService.ts";

/** The provider tool that loads a skill; its calls are the skills a run actually invoked. */
const SKILL_TOOL_NAME = "Skill";
/** Drivers whose runs report skill loads as `Skill` tool calls; for others "none" is unknown. */
const SKILL_REPORTING_DRIVERS: ReadonlySet<string> = new Set(["claudeAgent"]);
/**
 * Capture reads the files as they are now, so it describes a run's setup only shortly
 * after the run started. A run captured later than this (it waited behind another
 * capture, say) is recorded as unobserved; so is a run that started before this
 * recorder did, which a restart brings back.
 */
const MAX_CAPTURE_DELAY_MS = 10 * 1000;
/** Instruction files a provider reads from the agent-config root and the working directory. */
const SHARED_INSTRUCTIONS = ["AGENTS.md"];
const REPOSITORY_INSTRUCTIONS = ["AGENTS.md", "CLAUDE.md"];
const REPOSITORY_SKILL_DIRECTORIES = [".agents/skills", ".claude/skills"];
/** Skills nest at most this deep below a skills directory (`routines/<name>`). */
const SKILL_DEPTH = 2;

const decodeRecord = Schema.decodeUnknownEffect(Schema.fromJsonString(RunSetupRecord));
const encodeRecord = Schema.encodeSync(Schema.fromJsonString(RunSetupRecord));

const policyRoot = Config.option(Config.String("T3CODE_AGENT_POLICY_ROOT"));

const hashFile = Effect.fn("RunSetupRecorder.hashFile")(function* (file: string) {
  const fs = yield* FileSystem.FileSystem;
  const crypto = yield* Crypto.Crypto;
  return yield* fs.readFile(file).pipe(
    Effect.flatMap((bytes) => crypto.digest("SHA-256", bytes)),
    Effect.map(Hex.encode),
    Effect.orElseSucceed(() => null),
  );
});

const instructionFiles = Effect.fn("RunSetupRecorder.instructionFiles")(function* (
  directory: string,
  names: ReadonlyArray<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const files: Array<RunSetupFile> = [];
  for (const name of names) {
    const file = path.join(directory, name);
    if (!(yield* fs.exists(file).pipe(Effect.orElseSucceed(() => false)))) continue;
    files.push({ path: file, sha256: yield* hashFile(file) });
  }
  return files;
});

/** Every `SKILL.md` below `directory`, named by its folder relative to it. */
const skillsIn = Effect.fn("RunSetupRecorder.skillsIn")(function* (
  directory: string,
  source: RunSetupSkill["source"],
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const skills: Array<RunSetupSkill> = [];
  const visit: (
    folder: string,
    depth: number,
  ) => Effect.Effect<void, never, FileSystem.FileSystem | Crypto.Crypto> = Effect.fn(
    "RunSetupRecorder.visit",
  )(function* (folder: string, depth: number) {
    const entries = yield* fs.readDirectory(folder).pipe(Effect.orElseSucceed(() => []));
    for (const entry of [...entries].sort()) {
      if (entry.startsWith(".")) continue;
      const child = path.join(folder, entry);
      const skillFile = path.join(child, "SKILL.md");
      if (yield* fs.exists(skillFile).pipe(Effect.orElseSucceed(() => false))) {
        skills.push({
          name: path.relative(directory, child).split(path.sep).join("/"),
          source,
          path: skillFile,
          sha256: yield* hashFile(skillFile),
        });
      } else if (depth < SKILL_DEPTH) {
        const stat = yield* fs.stat(child).pipe(Effect.option);
        if (Option.isSome(stat) && stat.value.type === "Directory") yield* visit(child, depth + 1);
      }
    }
  });
  yield* visit(directory, 1);
  return skills;
});

/**
 * Observes the setup a run starts with. Anything T3 cannot read is recorded as null or
 * left out; capture never fails, so a missing agent-config checkout cannot stop a run.
 */
export const captureRunSetup = Effect.fn("RunSetupRecorder.captureRunSetup")(function* (input: {
  readonly run: Pick<OrchestrationV2Run, "id" | "threadId" | "modelSelection" | "workflow"> &
    Partial<Pick<OrchestrationV2Run, "ordinal">>;
  readonly thread: Pick<OrchestrationV2AppThread, "lineage" | "creationSource">;
  readonly workingDirectory: string | null;
  /** The run's model capabilities from the provider snapshot, or null when unknown. */
  readonly capabilities: ModelCapabilities | null;
  readonly assignments: ReadonlyArray<{
    readonly experimentId: string;
    readonly variantId: string;
  }>;
  readonly instructionOverlay: InstructionOverlay.AssignedInstructionOverlay | null;
  readonly policy: (root: string) => Effect.Effect<{ hash: string; sourceRevision: string } | null>;
  /** Whether Away was on as the run started; a thread's own workflow no longer carries it. */
  readonly away: boolean;
}) {
  const path = yield* Path.Path;
  const root = Option.getOrNull(yield* policyRoot.pipe(Effect.orElseSucceed(() => Option.none())));
  const workingDirectory = input.workingDirectory;
  const policy = root === null ? null : yield* input.policy(root);
  return {
    runId: input.run.id,
    threadId: input.run.threadId,
    ...(input.run.ordinal === undefined ? {} : { runOrdinal: input.run.ordinal }),
    capturedAt: DateTime.formatIso(yield* DateTime.now),
    agentConfig: root === null ? null : yield* AgentConfigCheckout.read(root),
    instructions: [
      ...(root === null ? [] : yield* instructionFiles(root, SHARED_INSTRUCTIONS)),
      ...(workingDirectory === null || workingDirectory === root
        ? []
        : yield* instructionFiles(workingDirectory, REPOSITORY_INSTRUCTIONS)),
    ],
    skills: [
      ...(root === null ? [] : yield* skillsIn(path.join(root, "skills"), "agent-config")),
      ...(workingDirectory === null
        ? []
        : (yield* Effect.forEach(REPOSITORY_SKILL_DIRECTORIES, (directory) =>
            skillsIn(path.join(workingDirectory, directory), "repository"),
          )).flat()),
    ],
    policy:
      policy === null ? null : { policyHash: policy.hash, policyRevision: policy.sourceRevision },
    modelSelection: input.run.modelSelection,
    effectiveOptions:
      input.capabilities === null
        ? null
        : (buildProviderOptionSelectionsFromDescriptors(
            getProviderOptionDescriptors({
              caps: input.capabilities,
              selections: input.run.modelSelection.options,
            }),
          ) ?? []),
    workflow: input.run.workflow == null ? null : { ...input.run.workflow, unattended: input.away },
    instructionOverlay:
      input.instructionOverlay === null
        ? null
        : {
            experimentId: input.instructionOverlay.experimentId,
            variantId: input.instructionOverlay.variantId,
            sourcePath: input.instructionOverlay.sourcePath,
            revision: input.instructionOverlay.revision,
            sha256: input.instructionOverlay.sha256,
          },
    experimentAssignments: input.assignments,
  } satisfies RunSetupRecord;
});

/** The record kept when capture failed outright: only what the run itself carries is known. */
export function uncapturedRunSetup(
  run: Pick<OrchestrationV2Run, "id" | "threadId" | "modelSelection" | "workflow"> &
    Partial<Pick<OrchestrationV2Run, "ordinal">>,
  capturedAt: string,
): RunSetupRecord {
  return {
    runId: run.id,
    threadId: run.threadId,
    ...(run.ordinal === undefined ? {} : { runOrdinal: run.ordinal }),
    capturedAt,
    agentConfig: null,
    instructions: null,
    skills: null,
    policy: null,
    modelSelection: run.modelSelection,
    effectiveOptions: null,
    workflow: run.workflow ?? null,
    experimentAssignments: null,
  };
}

/**
 * What a run's setup changed from the thread's previous run: the agent-config revision
 * and each instruction and skill file's hash. A value either record could not observe is
 * not a change.
 */
export function setupChanges(previous: RunSetupRecord, next: RunSetupRecord) {
  const changes: Array<{ subject: string; from: string | null; to: string | null }> = [];
  const from = previous.agentConfig?.revision ?? null;
  const to = next.agentConfig?.revision ?? null;
  if (from !== null && to !== null && from !== to)
    changes.push({ subject: "agent-config", from, to });
  // An unlanded edit leaves the revision alone, so the files themselves are compared.
  for (const key of ["instructions", "skills"] as const) {
    const previousFiles = previous[key];
    const nextFiles = next[key];
    if (previousFiles === null || nextFiles === null) continue;
    const before = new Map(previousFiles.map((file) => [file.path, file.sha256]));
    const after = new Map(nextFiles.map((file) => [file.path, file.sha256]));
    for (const path of new Set([...before.keys(), ...after.keys()])) {
      const fromHash = before.get(path) ?? null;
      const toHash = after.get(path) ?? null;
      // An unreadable file (a null hash) on either side is unknown, not a change.
      if (before.has(path) && after.has(path) && (fromHash === null || toHash === null)) continue;
      if (fromHash !== toHash) changes.push({ subject: path, from: fromHash, to: toHash });
    }
  }
  return changes;
}

/** Skills a run invoked, from the provider tool calls it reported. */
export function invokedSkills(items: ReadonlyArray<OrchestrationV2TurnItem>, runId: string) {
  const names = new Set<string>();
  for (const item of items) {
    if (item.runId !== runId || item.type !== "dynamic_tool" || item.toolName !== SKILL_TOOL_NAME)
      continue;
    const input = item.input;
    const skill =
      typeof input === "object" && input !== null && "skill" in input ? input.skill : undefined;
    if (typeof skill === "string" && skill.trim() !== "") names.add(skill.trim());
  }
  return [...names];
}

type ReportRun = Pick<
  OrchestrationV2Run,
  | "id"
  | "threadId"
  | "ordinal"
  | "status"
  | "modelSelection"
  | "workflow"
  | "requestedAt"
  | "startedAt"
>;

/**
 * The runs one report covers, newest first: the `limit` runs before `beforeOrdinal` (the
 * newest when absent), or just the run with `runOrdinal`. Paging back by the oldest
 * ordinal returned reaches every run of a thread, started or not.
 */
export function setupWindow<Run extends Pick<OrchestrationV2Run, "ordinal">>(
  runs: ReadonlyArray<Run>,
  input: {
    readonly limit: number;
    readonly beforeOrdinal?: number | undefined;
    readonly runOrdinal?: number | undefined;
  },
) {
  const newestFirst = [...runs].sort((left, right) => right.ordinal - left.ordinal);
  if (input.runOrdinal !== undefined)
    return newestFirst.filter((run) => run.ordinal === input.runOrdinal);
  return newestFirst
    .filter((run) => input.beforeOrdinal === undefined || run.ordinal < input.beforeOrdinal)
    .slice(0, input.limit);
}

/** A file list's size and one digest of every path and content hash in it. */
const fileSummary = Effect.fn("RunSetupRecorder.fileSummary")(function* (
  files: ReadonlyArray<{ readonly path: string; readonly sha256: string | null }>,
) {
  const crypto = yield* Crypto.Crypto;
  const text = files
    .map((file) => `${file.path}\0${file.sha256 ?? ""}`)
    .sort()
    .join("\n");
  const digest = yield* crypto
    .digest("SHA-256", new TextEncoder().encode(text))
    .pipe(Effect.map(Hex.encode), Effect.orDie);
  return { count: files.length, digest };
});

/**
 * Each run with its setup, in the order given. A run with no stored record has null setup
 * fields, and one whose driver reports no skill loads has `invokedSkills: null`, not an empty
 * list. Instruction and skill files are a count and digest unless `detail: "full"`.
 */
export const setupReport = Effect.fn("RunSetupRecorder.setupReport")(function* (input: {
  readonly runs: ReadonlyArray<ReportRun>;
  readonly records: ReadonlyArray<RunSetupRecord>;
  readonly turnItems: ReadonlyArray<OrchestrationV2TurnItem>;
  /** The driver kind of a provider instance, when the instance is known. */
  readonly driverOf: (instanceId: string) => string | undefined;
  readonly detail?: "summary" | "full";
}) {
  const stored = new Map(input.records.map((record) => [record.runId as string, record]));
  const entries: Array<RunSetupReportEntry> = [];
  for (const run of input.runs) {
    const {
      instructions,
      skills,
      runOrdinal: _runOrdinal,
      ...record
    } = stored.get(run.id) ??
    uncapturedRunSetup(run, DateTime.formatIso(run.startedAt ?? run.requestedAt));
    const driver = input.driverOf(record.modelSelection.instanceId) ?? null;
    entries.push({
      ...record,
      runOrdinal: run.ordinal,
      driver,
      status: run.status,
      startedAt: run.startedAt === null ? null : DateTime.formatIso(run.startedAt),
      instructionSummary: instructions === null ? null : yield* fileSummary(instructions),
      skillSummary: skills === null ? null : yield* fileSummary(skills),
      ...(input.detail === "full" ? { instructions, skills } : {}),
      invokedSkills:
        driver !== null && SKILL_REPORTING_DRIVERS.has(driver)
          ? invokedSkills(input.turnItems, run.id)
          : null,
    });
  }
  return entries;
});

/** The stored setup records of the given runs, in no particular order. */
const listRunSetups = Effect.fn("RunSetupRecorder.listRunSetups")(function* (
  runIds: ReadonlyArray<string>,
) {
  if (runIds.length === 0) return [];
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ record_json: string }>`SELECT record_json FROM run_setup_records
    WHERE run_id IN ${sql.in(runIds)}`;
  return yield* Effect.forEach(rows, (row) => decodeRecord(row.record_json));
});

/** Reads stored setup records; the MCP read tool depends on this alone. */
export class RunSetupStore extends Context.Service<
  RunSetupStore,
  {
    readonly list: (
      runIds: ReadonlyArray<string>,
    ) => Effect.Effect<ReadonlyArray<RunSetupRecord>, RunSetupStoreError>;
  }
>()("t3/agents/RunSetupRecorder/RunSetupStore") {}

export class RunSetupStoreError extends Schema.TaggedError<RunSetupStoreError>()(
  "RunSetupStoreError",
  { cause: Schema.Defect() },
) {}

export const storeLayer = Layer.effect(
  RunSetupStore,
  Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return RunSetupStore.of({
      list: (runIds) =>
        listRunSetups(runIds).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.mapError((cause) => new RunSetupStoreError({ cause })),
        ),
    });
  }),
);

export class RunSetupRecorder extends Context.Service<
  RunSetupRecorder,
  {
    /** Capture and store `run`'s setup once; later calls for the same run do nothing. */
    readonly record: (run: OrchestrationV2Run) => Effect.Effect<void>;
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/agents/RunSetupRecorder") {}

export const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const experiments = yield* ExperimentService.ExperimentService;
  const policyService = yield* Policy.AgentPolicyService;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const instructionOverlay = yield* InstructionOverlay.InstructionOverlay;
  const settings = yield* ServerSettingsService;
  const sql = yield* SqlClient.SqlClient;
  const context = yield* Effect.context<
    FileSystem.FileSystem | Path.Path | ProcessRunner.ProcessRunner | Crypto.Crypto
  >();
  const recorded = new Set<string>();
  const recorderStartedAt = yield* DateTime.now;
  // A thread's captures run one at a time, in the order its runs start, so a later run
  // never reads the files before an earlier one and cut points follow run order.
  const captureOrders = new Map<string, Semaphore.Semaphore>();
  const captureOrder = (threadId: string) => {
    const existing = captureOrders.get(threadId);
    if (existing !== undefined) return existing;
    const created = Semaphore.makeUnsafe(1);
    captureOrders.set(threadId, created);
    return created;
  };

  /** True when the record was stored; false when the run already had one. */
  const insert = (record: RunSetupRecord) =>
    sql`INSERT OR IGNORE INTO run_setup_records (run_id, thread_id, captured_at, record_json)
      VALUES (${record.runId}, ${record.threadId}, ${record.capturedAt}, ${encodeRecord(record)})
      RETURNING run_id`.pipe(Effect.map((rows) => rows.length > 0));

  const capture = Effect.fn("RunSetupRecorder.capture")(
    function* (run: OrchestrationV2Run) {
      const thread = yield* projections.getThread(run.threadId);
      const project = yield* projects.get(thread.projectId);
      const provider = (yield* providers.getProviders).find(
        (candidate) => candidate.instanceId === run.modelSelection.instanceId,
      );
      // The same per-run decision the provider turn reads, so the record names what was sent.
      const overlay =
        provider === undefined
          ? null
          : yield* instructionOverlay.forRun({
              runId: run.id,
              thread,
              modelSelection: run.modelSelection,
              driver: provider.driver,
            });
      const assignments = yield* experiments.assignments({ threadId: run.threadId });
      const away = yield* settings.getSettings.pipe(
        Effect.map((current) => current.away),
        Effect.orElseSucceed(() => false),
      );
      const record = yield* captureRunSetup({
        away,
        run,
        thread,
        workingDirectory:
          thread.worktreePath ?? Option.getOrNull(Option.map(project, (row) => row.workspaceRoot)),
        capabilities:
          provider?.models.find((model) => model.slug === run.modelSelection.model)?.capabilities ??
          null,
        instructionOverlay: overlay,
        assignments: assignments.map((assignment) => ({
          experimentId: assignment.experimentId,
          variantId: assignment.variant.id,
        })),
        policy: (root) =>
          policyService.snapshot(root).pipe(
            Effect.map((snapshot) => ({
              hash: snapshot.hash,
              sourceRevision: snapshot.sourceRevision,
            })),
            Effect.orElseSucceed(() => null),
          ),
      });
      return record;
    },
    Effect.provide(context),
    Effect.timeout("30 seconds"),
  );

  /** The nearest run before or after `ordinal` whose setup was observed; unobserved runs say nothing. */
  const recordAt = Effect.fn("RunSetupRecorder.recordAt")(function* (
    threadId: string,
    ordinal: number,
    direction: "before" | "after",
  ) {
    const rows =
      direction === "before"
        ? yield* sql<{ record_json: string }>`SELECT record_json FROM run_setup_records
            WHERE thread_id = ${threadId} AND json_extract(record_json, '$.runOrdinal') < ${ordinal}
              AND json_extract(record_json, '$.instructions') IS NOT NULL
            ORDER BY json_extract(record_json, '$.runOrdinal') DESC LIMIT 1`
        : yield* sql<{ record_json: string }>`SELECT record_json FROM run_setup_records
            WHERE thread_id = ${threadId} AND json_extract(record_json, '$.runOrdinal') > ${ordinal}
              AND json_extract(record_json, '$.instructions') IS NOT NULL
            ORDER BY json_extract(record_json, '$.runOrdinal') ASC LIMIT 1`;
    return rows[0] === undefined ? null : yield* decodeRecord(rows[0].record_json);
  });

  /** Records a `setup-change` observation on `next` for each running experiment its thread is in. */
  const markCut = Effect.fn("RunSetupRecorder.markCut")(function* (
    previous: RunSetupRecord,
    next: RunSetupRecord,
  ) {
    const changes = setupChanges(previous, next);
    if (changes.length === 0) return;
    const running = new Set(
      (yield* experiments.list())
        .filter((experiment) => experiment.status === "running")
        .map((experiment) => experiment.id),
    );
    const assignments = (yield* experiments.assignments({ threadId: next.threadId })).filter(
      (assignment) => running.has(assignment.experimentId),
    );
    yield* Effect.forEach(assignments, (assignment) =>
      experiments.recordObservation({
        id: `setup-change:${assignment.id}:${next.runId}`,
        assignmentId: assignment.id,
        runId: next.runId,
        kind: "setup-change",
        usedTokens: null,
        maxTokens: null,
        setupChanges: changes,
        evidence: [`run-setup:${previous.runId}`, `run-setup:${next.runId}`],
      }),
    );
  });

  /**
   * Compares a new record with its neighbours in run order. Captures finish out of order,
   * so a record stored after a later run's still marks the cut that later run starts.
   * A record holds the files as they were when it was captured, shortly after its run
   * started, so a change landing in that window can be attributed to the earlier run.
   */
  const markCutPoints = Effect.fn("RunSetupRecorder.markCutPoints")(function* (
    record: RunSetupRecord,
  ) {
    if (record.runOrdinal === undefined) return;
    const previous = yield* recordAt(record.threadId, record.runOrdinal, "before");
    if (previous !== null) yield* markCut(previous, record);
    const following = yield* recordAt(record.threadId, record.runOrdinal, "after");
    if (following !== null) yield* markCut(record, following);
  });

  const record = (run: OrchestrationV2Run) =>
    captureOrder(run.threadId)
      .withPermits(1)(
        Effect.gen(function* () {
          if (recorded.has(run.id)) return;
          recorded.add(run.id);
          const startedAt = DateTime.now;
          const unobservable = Effect.gen(function* () {
            const now = yield* DateTime.now;
            return (
              run.startedAt != null &&
              (DateTime.isLessThan(run.startedAt, recorderStartedAt) ||
                DateTime.toEpochMillis(now) - DateTime.toEpochMillis(run.startedAt) >
                  MAX_CAPTURE_DELAY_MS)
            );
          });
          const capturedAt = DateTime.formatIso(yield* startedAt);
          const unobserved = uncapturedRunSetup(run, capturedAt);
          // Checked again once the files are read: a slow read may have spanned a change.
          const captured = (yield* unobservable)
            ? unobserved
            : yield* capture(run).pipe(
                Effect.flatMap((record) =>
                  Effect.map(unobservable, (late) => (late ? unobserved : record)),
                ),
                Effect.catchCause((cause) =>
                  Effect.logWarning("Run setup capture failed", { runId: run.id, cause }).pipe(
                    Effect.as(unobserved),
                  ),
                ),
              );
          // After a restart a running run is captured again from today's files; its stored
          // record stands, and the new one must not mark a cut.
          if (yield* insert(captured)) yield* markCutPoints(captured);
        }),
      )
      .pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Run setup record failed", { runId: run.id, cause }),
        ),
      );

  return RunSetupRecorder.of({
    record,
    start: Effect.fn("RunSetupRecorder.start")(function* () {
      yield* forkParked(
        Stream.runForEach(engine.streamDomainEvents, (event) => {
          // Captured off the event stream so a slow read never holds up the run itself.
          return event.type === "run.updated" &&
            event.payload.status === "running" &&
            event.payload.startedAt !== null &&
            !recorded.has(event.payload.id)
            ? Effect.forkDetach(record(event.payload)).pipe(Effect.asVoid)
            : Effect.void;
        }).pipe(
          Effect.catchCause((cause) => Effect.logWarning("Run setup recorder stopped", { cause })),
        ),
      );
    }),
  });
});

/** Needs the runtime's own `InstructionOverlay`, whose per-run decisions its runs delivered. */
export const layer = Layer.effect(RunSetupRecorder, make).pipe(Layer.provide(Policy.layer));
