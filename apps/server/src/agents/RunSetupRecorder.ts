import {
  type ContextRolloverSettings,
  type ModelCapabilities,
  type ExperimentRolloverPolicy,
  type OrchestrationV2AppThread,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
  RunSetupRecord,
  type RunSetupFile,
  type RunSetupSkill,
  type ThreadId,
} from "@t3tools/contracts";
import * as Clock from "effect/Clock";
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
import type * as Scope from "effect/Scope";
import * as SqlClient from "effect/sql/SqlClient";
import * as Stream from "effect/Stream";
import {
  buildProviderOptionSelectionsFromDescriptors,
  getProviderOptionDescriptors,
} from "@t3tools/shared/model";
import * as ExperimentService from "../experiments/ExperimentService.ts";
import * as InstructionOverlay from "../experiments/InstructionOverlay.ts";
import {
  ROLLOVER_NOTE_RECIPE,
  assignedRolloverThresholds,
  boundRolloverThresholds,
  rolloverHeld,
} from "../orchestration-v2/ContextRollover.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import { forkParked } from "../serverActivation.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as AgentConfigCheckout from "./AgentConfigCheckout.ts";
import * as Policy from "./AgentPolicyService.ts";

/** The provider tool that loads a skill; its calls are the skills a run actually invoked. */
const SKILL_TOOL_NAME = "Skill";
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
  const visit = (
    folder: string,
    depth: number,
  ): Effect.Effect<void, never, FileSystem.FileSystem | Crypto.Crypto> =>
    Effect.gen(function* () {
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
          if (Option.isSome(stat) && stat.value.type === "Directory")
            yield* visit(child, depth + 1);
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
  readonly thread: Pick<
    OrchestrationV2AppThread,
    "lineage" | "creationSource" | "rolloverThresholds" | "rolloverHold"
  >;
  /** The context window the provider reported for the run's session, when known. */
  readonly maxTokens: number | null;
  readonly workingDirectory: string | null;
  /** The run's model capabilities from the provider snapshot, or null when unknown. */
  readonly capabilities: ModelCapabilities | null;
  readonly rolloverSettings: ContextRolloverSettings;
  readonly rollover: ExperimentRolloverPolicy | undefined;
  readonly assignments: ReadonlyArray<{
    readonly experimentId: string;
    readonly variantId: string;
  }>;
  readonly instructionOverlay: InstructionOverlay.AssignedInstructionOverlay | null;
  readonly policy: (root: string) => Effect.Effect<{ hash: string; sourceRevision: string } | null>;
}) {
  const path = yield* Path.Path;
  const root = Option.getOrNull(yield* policyRoot.pipe(Effect.orElseSucceed(() => Option.none())));
  const workingDirectory = input.workingDirectory;
  const configured = assignedRolloverThresholds(
    input.rolloverSettings,
    input.thread,
    input.run.modelSelection.model,
    input.rollover,
  );
  const thresholds =
    configured === null ? null : boundRolloverThresholds(configured, input.maxTokens);
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
    workflow: input.run.workflow ?? null,
    rollover:
      thresholds === null
        ? null
        : {
            softLimit: thresholds.soft,
            hardLimit: thresholds.hard,
            held: rolloverHeld(input.thread.rolloverHold, yield* Clock.currentTimeMillis),
            noteRecipe: ROLLOVER_NOTE_RECIPE,
          },
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
    rollover: null,
    experimentAssignments: null,
  };
}

/**
 * What a run's setup changed from the thread's previous run: the agent-config revision
 * and each instruction file's hash. A value either record could not observe is not a change.
 */
export function setupChanges(previous: RunSetupRecord, next: RunSetupRecord) {
  const changes: Array<{ subject: string; from: string | null; to: string | null }> = [];
  const from = previous.agentConfig?.revision ?? null;
  const to = next.agentConfig?.revision ?? null;
  if (from !== null && to !== null && from !== to)
    changes.push({ subject: "agent-config", from, to });
  if (previous.instructions !== null && next.instructions !== null) {
    const before = new Map(previous.instructions.map((file) => [file.path, file.sha256]));
    const after = new Map(next.instructions.map((file) => [file.path, file.sha256]));
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

/** A thread's setup records, newest first. */
const listRunSetups = Effect.fn("RunSetupRecorder.listRunSetups")(function* (
  threadId: ThreadId,
  limit: number,
) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ record_json: string }>`SELECT record_json FROM run_setup_records
    WHERE thread_id = ${threadId} ORDER BY captured_at DESC LIMIT ${limit}`;
  return yield* Effect.forEach(rows, (row) => decodeRecord(row.record_json));
});

/** Reads stored setup records; the MCP read tool depends on this alone. */
export class RunSetupStore extends Context.Service<
  RunSetupStore,
  {
    readonly list: (
      threadId: ThreadId,
      limit: number,
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
      list: (threadId, limit) =>
        listRunSetups(threadId, limit).pipe(
          Effect.provideService(SqlClient.SqlClient, sql),
          Effect.mapError((cause) => new RunSetupStoreError({ cause })),
        ),
    });
  }),
);

export class RunSetupRecorder extends Context.Service<
  RunSetupRecorder,
  {
    /**
     * Capture and store `run`'s setup once; later calls for the same run do nothing.
     * `maxTokens` is the context window its provider session reported when it started.
     */
    readonly record: (run: OrchestrationV2Run, maxTokens: number | null) => Effect.Effect<void>;
    readonly start: () => Effect.Effect<void, never, Scope.Scope>;
  }
>()("t3/agents/RunSetupRecorder") {}

export const make = Effect.gen(function* () {
  const engine = yield* Orchestrator.OrchestratorV2;
  const projections = yield* ProjectionStore.ProjectionStoreV2;
  const projects = yield* ProjectStore.ProjectStoreV2;
  const settingsService = yield* ServerSettings.ServerSettingsService;
  const experiments = yield* ExperimentService.ExperimentService;
  const policyService = yield* Policy.AgentPolicyService;
  const providers = yield* ProviderRegistry.ProviderRegistry;
  const instructionOverlay = yield* InstructionOverlay.InstructionOverlay;
  const sql = yield* SqlClient.SqlClient;
  const context = yield* Effect.context<
    FileSystem.FileSystem | Path.Path | ProcessRunner.ProcessRunner | Crypto.Crypto
  >();
  const recorded = new Set<string>();

  const insert = (record: RunSetupRecord) =>
    sql`INSERT OR IGNORE INTO run_setup_records (run_id, thread_id, captured_at, record_json)
      VALUES (${record.runId}, ${record.threadId}, ${record.capturedAt}, ${encodeRecord(record)})`;

  const capture = (run: OrchestrationV2Run, maxTokens: number | null) =>
    Effect.gen(function* () {
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
      const record = yield* captureRunSetup({
        run,
        thread,
        maxTokens,
        workingDirectory:
          thread.worktreePath ?? Option.getOrNull(Option.map(project, (row) => row.workspaceRoot)),
        capabilities:
          provider?.models.find((model) => model.slug === run.modelSelection.model)?.capabilities ??
          null,
        rolloverSettings: (yield* settingsService.getSettings).contextRollover,
        rollover: (yield* experiments.getRolloverAssignment(run.threadId))?.variant.rollover,
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
    }).pipe(Effect.provide(context), Effect.timeout("30 seconds"));

  const recordAt = (threadId: string, ordinal: number, direction: "before" | "after") =>
    Effect.gen(function* () {
      const rows =
        direction === "before"
          ? yield* sql<{ record_json: string }>`SELECT record_json FROM run_setup_records
              WHERE thread_id = ${threadId} AND json_extract(record_json, '$.runOrdinal') < ${ordinal}
              ORDER BY json_extract(record_json, '$.runOrdinal') DESC LIMIT 1`
          : yield* sql<{ record_json: string }>`SELECT record_json FROM run_setup_records
              WHERE thread_id = ${threadId} AND json_extract(record_json, '$.runOrdinal') > ${ordinal}
              ORDER BY json_extract(record_json, '$.runOrdinal') ASC LIMIT 1`;
      return rows[0] === undefined ? null : yield* decodeRecord(rows[0].record_json);
    });

  /** Records a `setup-change` observation on `next` for each running experiment its thread is in. */
  const markCut = (previous: RunSetupRecord, next: RunSetupRecord) =>
    Effect.gen(function* () {
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
   */
  const markCutPoints = (record: RunSetupRecord) =>
    Effect.gen(function* () {
      if (record.runOrdinal === undefined) return;
      const previous = yield* recordAt(record.threadId, record.runOrdinal, "before");
      if (previous !== null) yield* markCut(previous, record);
      const following = yield* recordAt(record.threadId, record.runOrdinal, "after");
      if (following !== null) yield* markCut(record, following);
    });

  const record = (run: OrchestrationV2Run, maxTokens: number | null) =>
    Effect.gen(function* () {
      if (recorded.has(run.id)) return;
      recorded.add(run.id);
      const capturedAt = DateTime.formatIso(yield* DateTime.now);
      const captured = yield* capture(run, maxTokens).pipe(
        Effect.catchCause((cause) =>
          Effect.logWarning("Run setup capture failed", { runId: run.id, cause }).pipe(
            Effect.as(uncapturedRunSetup(run, capturedAt)),
          ),
        ),
      );
      yield* insert(captured);
      yield* markCutPoints(captured);
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Run setup record failed", { runId: run.id, cause }),
      ),
    );

  return RunSetupRecorder.of({
    record,
    start: Effect.fn("RunSetupRecorder.start")(function* () {
      // A run starts in one commit that updates its provider thread first, so the
      // window seen here is the one in force when the run's own event follows.
      const contextWindows = new Map<string, number | null>();
      yield* forkParked(
        Stream.runForEach(engine.streamDomainEvents, (event) => {
          if (event.type === "provider-thread.updated") {
            contextWindows.set(event.payload.id, event.payload.contextUsage?.maxTokens ?? null);
            return Effect.void;
          }
          // Captured off the event stream so a slow read never holds up the run itself.
          return event.type === "run.updated" &&
            event.payload.status === "running" &&
            event.payload.startedAt !== null &&
            !recorded.has(event.payload.id)
            ? Effect.forkDetach(
                record(
                  event.payload,
                  event.payload.providerThreadId === null
                    ? null
                    : (contextWindows.get(event.payload.providerThreadId) ?? null),
                ),
              ).pipe(Effect.asVoid)
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
