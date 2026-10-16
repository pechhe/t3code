import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ContextRolloverSettings,
  type OrchestrationV2Run,
  type OrchestrationV2TurnItem,
  RunId,
  RunSetupRecord,
  ThreadId,
} from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Option from "effect/Option";
import * as ExperimentService from "../experiments/ExperimentService.ts";
import * as InstructionOverlay from "../experiments/InstructionOverlay.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as TestClock from "effect/testing/TestClock";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as Policy from "./AgentPolicyService.ts";
import * as RunSetup from "./RunSetupRecorder.ts";

const threadId = ThreadId.make("thread:setup");
const run = {
  id: RunId.make("run:setup:1"),
  threadId,
  modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" },
  workflow: { kind: "lead", unattended: true },
} as never;
const thread = {
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
  creationSource: "web",
} as const;
const rolloverOn = Schema.decodeSync(ContextRolloverSettings)({ enabled: true });

const layer = ProcessRunner.layer.pipe(Layer.provideMerge(NodeServices.layer));

const decodeStored = Schema.decodeUnknownSync(Schema.fromJsonString(RunSetupRecord));

/** A thread's stored setup records, newest captured first. */
const storedSetups = Effect.fn("storedSetups")(function* (thread: ThreadId, limit: number) {
  const sql = yield* SqlClient.SqlClient;
  const rows = yield* sql<{ record_json: string }>`SELECT record_json FROM run_setup_records
    WHERE thread_id = ${thread} ORDER BY captured_at DESC LIMIT ${limit}`;
  return rows.map((row) => decodeStored(row.record_json));
});

const sha256 = (text: string) =>
  Effect.gen(function* () {
    const crypto = yield* Crypto.Crypto;
    return Hex.encode(yield* crypto.digest("SHA-256", new TextEncoder().encode(text)));
  });

const capture = (
  root: string | null,
  workingDirectory: string | null,
  maxTokens: number | null = null,
) =>
  RunSetup.captureRunSetup({
    run,
    thread,
    maxTokens,
    workingDirectory,
    capabilities: {
      optionDescriptors: [
        {
          id: "reasoningEffort",
          label: "Effort",
          type: "select",
          options: [
            { id: "medium", label: "Medium", isDefault: true },
            { id: "high", label: "High" },
          ],
        },
      ],
    } as never,
    rolloverSettings: rolloverOn,
    rollover: undefined,
    assignments: [{ experimentId: "trial", variantId: "a" }],
    instructionOverlay: null,
    policy: () => Effect.succeed({ hash: "a".repeat(64), sourceRevision: "2026-10-15.4" }),
  }).pipe(
    Effect.provideService(
      ConfigProvider.ConfigProvider,
      ConfigProvider.fromUnknown(root === null ? {} : { T3CODE_AGENT_POLICY_ROOT: root }),
    ),
  );

describe("captureRunSetup", () => {
  it.effect("hashes shared and repository instructions and every available skill", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const root = yield* fs.makeTempDirectoryScoped({ prefix: "run-setup-config-" });
      const repo = yield* fs.makeTempDirectoryScoped({ prefix: "run-setup-repo-" });
      const write = (file: string, text: string) =>
        fs
          .makeDirectory(path.dirname(file), { recursive: true })
          .pipe(Effect.andThen(fs.writeFileString(file, text)));
      yield* write(path.join(root, "AGENTS.md"), "shared");
      yield* write(path.join(root, "skills/lead/SKILL.md"), "lead v1");
      yield* write(path.join(root, "skills/routines/digest/SKILL.md"), "digest");
      yield* write(path.join(repo, "AGENTS.md"), "repo");
      yield* write(path.join(repo, ".claude/skills/local/SKILL.md"), "local");

      const record = yield* capture(root, repo);

      assert.deepEqual(record.instructions, [
        { path: path.join(root, "AGENTS.md"), sha256: yield* sha256("shared") },
        { path: path.join(repo, "AGENTS.md"), sha256: yield* sha256("repo") },
      ]);
      assert.deepEqual(
        record.skills.map(({ name, source, sha256 }) => ({ name, source, sha256 })),
        [
          { name: "lead", source: "agent-config", sha256: yield* sha256("lead v1") },
          { name: "routines/digest", source: "agent-config", sha256: yield* sha256("digest") },
          { name: "local", source: "repository", sha256: yield* sha256("local") },
        ],
      );
      // Not a jj checkout: the revision is unknown, not guessed.
      assert.deepEqual(record.agentConfig, {
        root,
        revision: null,
        workingCopyRevision: null,
        hasLocalChanges: null,
      });
      assert.deepEqual(record.policy, {
        policyHash: "a".repeat(64),
        policyRevision: "2026-10-15.4",
      });
      assert.deepEqual(record.rollover, {
        softLimit: 220_000,
        hardLimit: 280_000,
        held: false,
        noteRecipe: "rollover-v1",
      });
      assert.deepEqual(record.experimentAssignments, [{ experimentId: "trial", variantId: "a" }]);
      assert.deepEqual(record.workflow, { kind: "lead", unattended: true });
      // No effort was chosen, so the provider default is what the run used.
      assert.deepEqual(record.effectiveOptions, [{ id: "reasoningEffort", value: "medium" }]);
    }).pipe(Effect.scoped, Effect.provide(layer)),
  );

  it.effect("records nulls without agent-config and never fails on a missing directory", () =>
    Effect.gen(function* () {
      const record = yield* capture(null, "/nonexistent/run-setup-repo");
      assert.isNull(record.agentConfig);
      assert.isNull(record.policy);
      assert.deepEqual(record.instructions, []);
      assert.deepEqual(record.skills, []);
    }).pipe(Effect.provide(layer)),
  );

  it.effect("bounds rollover by the context window the run's session reported", () =>
    Effect.gen(function* () {
      const record = yield* capture(null, null, 100_000);
      assert.deepEqual(record.rollover, {
        softLimit: 72_000,
        hardLimit: 90_000,
        held: false,
        noteRecipe: "rollover-v1",
      });
    }).pipe(Effect.provide(layer)),
  );
});

describe("invokedSkills", () => {
  const tool = (runId: string, toolName: string, input: unknown) =>
    ({ type: "dynamic_tool", runId, toolName, input }) as unknown as OrchestrationV2TurnItem;

  it("lists each skill the run's Skill tool calls loaded, once", () => {
    assert.deepEqual(
      RunSetup.invokedSkills(
        [
          tool("run:1", "Skill", { skill: "lead" }),
          tool("run:1", "Skill", { skill: "lead" }),
          tool("run:1", "Bash", { command: "ls" }),
          tool("run:2", "Skill", { skill: "shape" }),
          tool("run:1", "Skill", { skill: "code-review" }),
        ],
        "run:1",
      ),
      ["lead", "code-review"],
    );
  });
});

describe("setupReport", () => {
  const started = DateTime.makeUnsafe("2026-10-16T00:00:00.000Z");
  const runOf = (ordinal: number, instanceId: string, startedAt: DateTime.Utc | null = started) =>
    ({
      id: RunId.make(`run:report:${ordinal}`),
      threadId,
      ordinal,
      status: startedAt === null ? "cancelled" : "completed",
      modelSelection: { instanceId, model: "m" },
      workflow: null,
      requestedAt: started,
      startedAt,
    }) as never as OrchestrationV2Run;
  const driverOf = (instanceId: string) => (instanceId === "claude" ? "claudeAgent" : "codex");
  const skillCall = (runId: string, skill: string) =>
    ({ type: "dynamic_tool", runId, toolName: "Skill", input: { skill } }) as never;
  const skill = (name: string, sha256: string | null) => ({
    name,
    source: "agent-config" as const,
    path: `/config/skills/${name}/SKILL.md`,
    sha256,
  });
  const recordWith = (
    run: OrchestrationV2Run,
    skills: ReadonlyArray<ReturnType<typeof skill>>,
  ) => ({
    ...RunSetup.uncapturedRunSetup(run, "2026-10-16T00:00:01.000Z"),
    instructions: [{ path: "/config/AGENTS.md", sha256: "a".repeat(64) }],
    skills,
  });

  it.effect(
    "lists every run newest first with its driver, and null setup for one that predates capture or never started",
    () =>
      Effect.gen(function* () {
        const report = yield* RunSetup.setupReport({
          runs: [
            runOf(4, "unknown"),
            runOf(3, "claude"),
            runOf(2, "claude", null),
            runOf(1, "codex"),
          ],
          records: [],
          turnItems: [],
          driverOf: (instanceId) => (instanceId === "unknown" ? undefined : driverOf(instanceId)),
        });
        const started = "2026-10-16T00:00:00.000Z";
        assert.deepEqual(
          report.map((entry) => ({
            runOrdinal: entry.runOrdinal,
            driver: entry.driver,
            status: entry.status,
            startedAt: entry.startedAt,
            agentConfig: entry.agentConfig,
            skillSummary: entry.skillSummary,
          })),
          [
            { runOrdinal: 4, driver: null, status: "completed" as const, startedAt: started },
            {
              runOrdinal: 3,
              driver: "claudeAgent",
              status: "completed" as const,
              startedAt: started,
            },
            { runOrdinal: 2, driver: "claudeAgent", status: "cancelled" as const, startedAt: null },
            { runOrdinal: 1, driver: "codex", status: "completed" as const, startedAt: started },
          ].map((entry) => ({ ...entry, agentConfig: null, skillSummary: null })),
        );
      }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("reports skills only for drivers that report skill loads", () =>
    Effect.gen(function* () {
      const report = yield* RunSetup.setupReport({
        runs: [runOf(2, "claude"), runOf(1, "codex")],
        records: [],
        turnItems: [skillCall("run:report:1", "lead"), skillCall("run:report:2", "shape")],
        driverOf,
      });
      assert.deepEqual(
        report.map((entry) => ({ runId: entry.runId, invokedSkills: entry.invokedSkills })),
        [
          { runId: RunId.make("run:report:2"), invokedSkills: ["shape"] },
          { runId: RunId.make("run:report:1"), invokedSkills: null },
        ],
      );
    }).pipe(Effect.provide(NodeServices.layer)),
  );

  it.effect("summarises files by count and digest and lists them only on request", () =>
    Effect.gen(function* () {
      const runs = [runOf(3, "claude"), runOf(2, "claude"), runOf(1, "claude")];
      const sha = (character: string) => character.repeat(64);
      const records = [
        recordWith(runs[2]!, [skill("lead", sha("1")), skill("shape", sha("2"))]),
        recordWith(runs[1]!, [skill("shape", sha("2")), skill("lead", sha("1"))]),
        recordWith(runs[0]!, [skill("lead", sha("3")), skill("shape", sha("2"))]),
      ];
      const summary = yield* RunSetup.setupReport({ runs, records, turnItems: [], driverOf });
      const [third, second, first] = summary;
      assert.deepEqual(first?.skillSummary?.count, 2);
      // The same files in another order digest alike; a changed hash digests differently.
      assert.equal(first?.skillSummary?.digest, second?.skillSummary?.digest);
      assert.notEqual(first?.skillSummary?.digest, third?.skillSummary?.digest);
      assert.equal(first?.instructionSummary?.count, 1);
      assert.notProperty(first!, "skills");
      assert.notProperty(first!, "instructions");

      const [full] = yield* RunSetup.setupReport({
        runs: [runs[2]!],
        records: [records[0]!],
        turnItems: [],
        driverOf,
        detail: "full",
      });
      assert.deepEqual(full?.skills, records[0]!.skills);
      assert.deepEqual(full?.instructions, records[0]!.instructions);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("setupReport size", () => {
  it.effect("keeps ten runs of thirty skills under 15k characters", () =>
    Effect.gen(function* () {
      const started = DateTime.makeUnsafe("2026-10-16T00:00:00.000Z");
      const runs = Array.from(
        { length: 10 },
        (_, index) =>
          ({
            id: RunId.make(`run:size:${index + 1}`),
            threadId,
            ordinal: index + 1,
            status: "completed",
            modelSelection: { instanceId: "claude", model: "m" },
            workflow: null,
            requestedAt: started,
            startedAt: started,
          }) as never as OrchestrationV2Run,
      );
      const records = runs.map((run) => ({
        ...RunSetup.uncapturedRunSetup(run, "2026-10-16T00:00:01.000Z"),
        instructions: [{ path: "/Users/someone/.agents/AGENTS.md", sha256: "a".repeat(64) }],
        skills: Array.from({ length: 30 }, (_, skill) => ({
          name: `skill-${skill}`,
          source: "agent-config" as const,
          path: `/Users/someone/.agents/skills/skill-${skill}/SKILL.md`,
          sha256: "b".repeat(64),
        })),
      }));
      const report = yield* RunSetup.setupReport({
        runs,
        records,
        turnItems: [],
        driverOf: () => "claudeAgent",
      });
      assert.isBelow(JSON.stringify(report).length, 15_000);
    }).pipe(Effect.provide(NodeServices.layer)),
  );
});

describe("setupWindow", () => {
  const runs = [4, 1, 7, 3, 6, 2, 5].map((ordinal) => ({ ordinal }));
  const ordinalsOf = (input: Parameters<typeof RunSetup.setupWindow>[1]) =>
    RunSetup.setupWindow(runs, input).map((run) => run.ordinal);

  it("pages back through every run once, newest first", () => {
    assert.deepEqual(ordinalsOf({ limit: 3 }), [7, 6, 5]);
    assert.deepEqual(ordinalsOf({ limit: 3, beforeOrdinal: 5 }), [4, 3, 2]);
    assert.deepEqual(ordinalsOf({ limit: 3, beforeOrdinal: 2 }), [1]);
    assert.deepEqual(ordinalsOf({ limit: 3, beforeOrdinal: 1 }), []);
  });

  it("selects one run by ordinal", () => {
    assert.deepEqual(ordinalsOf({ limit: 3, runOrdinal: 4 }), [4]);
    assert.deepEqual(ordinalsOf({ limit: 3, runOrdinal: 9 }), []);
  });
});

describe("RunSetupStore", () => {
  it.effect("lists the stored records of the runs asked for", () =>
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      const store = yield* RunSetup.RunSetupStore;
      const recordAt = (id: string, capturedAt: string) => ({
        runId: id,
        threadId,
        capturedAt,
        agentConfig: null,
        instructions: [],
        skills: [],
        policy: null,
        modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" },
        effectiveOptions: null,
        workflow: null,
        rollover: null,
        experimentAssignments: [],
      });
      for (const record of [
        recordAt("run:a", "2026-10-15T10:00:00.000Z"),
        recordAt("run:b", "2026-10-15T11:00:00.000Z"),
      ])
        yield* sql`INSERT INTO run_setup_records (run_id, thread_id, captured_at, record_json)
          VALUES (${record.runId}, ${threadId}, ${record.capturedAt}, ${JSON.stringify(record)})`;
      assert.deepEqual(
        (yield* store.list(["run:b", "run:missing"])).map((record) => record.runId),
        ["run:b"],
      );
      assert.deepEqual(yield* store.list([]), []);
    }).pipe(Effect.provide(RunSetup.storeLayer.pipe(Layer.provideMerge(Sqlite.layerMemory)))),
  );
});

const recorderLayer = (
  getThread: ProjectionStore.ProjectionStoreV2["Service"]["getThread"],
  experiments: Partial<ExperimentService.ExperimentService["Service"]> = {},
  overlay: InstructionOverlay.AssignedInstructionOverlay | null = null,
) =>
  Layer.effect(RunSetup.RunSetupRecorder, RunSetup.make).pipe(
    Layer.provide(
      Layer.mergeAll(
        Layer.mock(Orchestrator.OrchestratorV2)({}),
        Layer.mock(ProjectionStore.ProjectionStoreV2)({ getThread }),
        Layer.mock(ProjectStore.ProjectStoreV2)({ get: () => Effect.succeed(Option.none()) }),
        Layer.mock(ExperimentService.ExperimentService)({
          assignments: () => Effect.succeed([]),
          getRolloverAssignment: () => Effect.succeed(null),
          list: () => Effect.succeed([]),
          ...experiments,
        }),
        Layer.mock(Policy.AgentPolicyService)({}),
        Layer.mock(ProviderRegistry.ProviderRegistry)({
          getProviders: Effect.succeed([
            { instanceId: "codex", driver: "codex", models: [] },
          ] as never),
        }),
        Layer.mock(InstructionOverlay.InstructionOverlay)({
          forRun: (input) => Effect.succeed(input.driver === "codex" ? overlay : null),
        }),
        ServerSettings.layerTest(),
      ),
    ),
    Layer.provideMerge(RunSetup.storeLayer),
    Layer.provideMerge(Sqlite.layerMemory),
    Layer.provide(layer),
    Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
  );

describe("RunSetupRecorder.record", () => {
  const runAt = (ordinal: number) =>
    ({
      id: RunId.make(`run:setup:${ordinal}`),
      threadId,
      modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" },
      workflow: { kind: "lead", unattended: true },
    }) as never;

  it.effect("gives each run, a rollover run included, its own record once", () =>
    Effect.gen(function* () {
      const recorder = yield* RunSetup.RunSetupRecorder;
      yield* recorder.record(runAt(1), null);
      yield* recorder.record(runAt(1), null);
      // A rollover continues the thread in a new run, which is captured afresh.
      yield* recorder.record(runAt(2), null);
      const records = yield* storedSetups(threadId, 10);
      assert.deepEqual(records.map((record) => record.runId).sort(), [
        "run:setup:1",
        "run:setup:2",
      ]);
      assert.deepEqual(records[0]?.workflow, { kind: "lead", unattended: true });
      // The model has no provider snapshot here, so its options are unknown.
      assert.isNull(records[0]?.effectiveOptions);
      assert.isNull(records[0]?.instructionOverlay);
    }).pipe(
      Effect.provide(
        recorderLayer(() => Effect.succeed({ ...thread, projectId: "project:setup" } as never)),
      ),
    ),
  );

  it.effect("names the instruction variant the run was delivered by its hash", () =>
    Effect.gen(function* () {
      const recorder = yield* RunSetup.RunSetupRecorder;
      yield* recorder.record(runAt(4), null);
      const [record] = yield* storedSetups(threadId, 10);
      assert.deepEqual(record?.instructionOverlay, {
        experimentId: "instructions",
        variantId: "terse",
        sourcePath: "skills/lead/SKILL.md",
        revision: "agent-config:abc123",
        sha256: "b".repeat(64),
      });
    }).pipe(
      Effect.provide(
        recorderLayer(
          () => Effect.succeed({ ...thread, projectId: "project:setup" } as never),
          {},
          {
            experimentId: "instructions",
            variantId: "terse",
            sourcePath: "skills/lead/SKILL.md",
            revision: "agent-config:abc123",
            sha256: "b".repeat(64),
            text: "Keep each reply under five lines.",
          },
        ),
      ),
    ),
  );

  it.effect("keeps a null record when capture fails", () =>
    Effect.gen(function* () {
      const recorder = yield* RunSetup.RunSetupRecorder;
      yield* recorder.record(runAt(3), null);
      const [record] = yield* storedSetups(threadId, 10);
      assert.deepEqual(
        { ...record, capturedAt: "" },
        { ...RunSetup.uncapturedRunSetup(runAt(3), ""), capturedAt: "" },
      );
    }).pipe(Effect.provide(recorderLayer(() => Effect.die("projection unavailable")))),
  );
});

describe("setup cut points", () => {
  const record = (runId: string, revision: string | null, hash: string | null) =>
    ({
      ...RunSetup.uncapturedRunSetup(
        {
          id: RunId.make(runId),
          threadId,
          modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" },
        } as never,
        "2026-10-16T00:00:00.000Z",
      ),
      agentConfig:
        revision === null
          ? null
          : { root: "/agents", revision, workingCopyRevision: null, hasLocalChanges: false },
      instructions: [{ path: "/repo/AGENTS.md", sha256: hash }],
    }) as never;

  it("names the old and new revision and instruction hashes, and ignores unknowns", () => {
    assert.deepEqual(RunSetup.setupChanges(record("a", "r1", "h1"), record("b", "r2", "h2")), [
      { subject: "agent-config", from: "r1", to: "r2" },
      { subject: "/repo/AGENTS.md", from: "h1", to: "h2" },
    ]);
    assert.deepEqual(RunSetup.setupChanges(record("a", "r1", "h1"), record("b", "r1", "h1")), []);
    assert.deepEqual(RunSetup.setupChanges(record("a", null, null), record("b", "r2", "h2")), []);
  });

  it("counts a changed skill file even when the revision is unchanged", () => {
    const withSkill = (hash: string) =>
      ({
        ...(record("a", "r1", "h1") as unknown as RunSetupRecord),
        skills: [
          {
            name: "lead",
            source: "agent-config",
            path: "/agents/skills/lead/SKILL.md",
            sha256: hash,
          },
        ],
      }) as never;
    assert.deepEqual(RunSetup.setupChanges(withSkill("s1"), withSkill("s2")), [
      { subject: "/agents/skills/lead/SKILL.md", from: "s1", to: "s2" },
    ]);
    assert.deepEqual(RunSetup.setupChanges(withSkill("s1"), withSkill("s1")), []);
  });

  it.effect("marks one observation when a skill file changes and the revision does not", () => {
    let repoPath = "";
    const observations: Array<{ id: string; setupChanges?: unknown }> = [];
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const recorder = yield* RunSetup.RunSetupRecorder;
      const repo = yield* fs.makeTempDirectoryScoped({ prefix: "run-setup-skill-" });
      repoPath = repo;
      const skill = path.join(repo, ".claude/skills/lead/SKILL.md");
      yield* fs.makeDirectory(path.dirname(skill), { recursive: true });
      const runAt = (ordinal: number) =>
        ({
          id: RunId.make(`run:skill:${ordinal}`),
          threadId,
          ordinal,
          modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" },
        }) as never;
      yield* fs.writeFileString(skill, "lead v1");
      yield* recorder.record(runAt(1), null);
      yield* fs.writeFileString(skill, "lead v2");
      yield* recorder.record(runAt(2), null);
      yield* recorder.record(runAt(3), null);
      assert.deepEqual(
        observations.map((observation) => observation.id),
        ["setup-change:assignment:trial:run:skill:2"],
      );
      assert.deepEqual(observations[0]?.setupChanges, [
        { subject: skill, from: yield* sha256("lead v1"), to: yield* sha256("lead v2") },
      ]);
    }).pipe(
      Effect.provide(
        recorderLayer(
          () =>
            Effect.sync(
              () => ({ ...thread, projectId: "project:setup", worktreePath: repoPath }) as never,
            ),
          {
            list: () => Effect.succeed([{ id: "trial", status: "running" }] as never),
            assignments: () =>
              Effect.succeed([
                { id: "assignment:trial", experimentId: "trial", variant: { id: "a" } },
              ] as never),
            recordObservation: (input) =>
              Effect.sync(() => {
                observations.push(input);
                return input as never;
              }),
          },
        ),
      ),
      Effect.scoped,
      Effect.provide(layer),
    );
  });

  it.effect("marks the cut across a run whose setup was unobserved", () => {
    let repoPath = "";
    const observations: Array<{ id: string }> = [];
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const recorder = yield* RunSetup.RunSetupRecorder;
      const repo = yield* fs.makeTempDirectoryScoped({ prefix: "run-setup-gap-" });
      repoPath = repo;
      const agents = path.join(repo, "AGENTS.md");
      const runAt = (ordinal: number, startedAt?: DateTime.Utc) =>
        ({
          id: RunId.make(`run:gap:${ordinal}`),
          threadId,
          ordinal,
          ...(startedAt === undefined ? {} : { startedAt }),
          modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" },
        }) as never;
      yield* fs.writeFileString(agents, "v1");
      yield* recorder.record(runAt(1), null);
      yield* fs.writeFileString(agents, "v2");
      // Run 2 started before the recorder did, so it is stored as unobserved.
      yield* recorder.record(runAt(2, DateTime.makeUnsafe(-60 * 1000)), null);
      yield* recorder.record(runAt(3), null);
      assert.deepEqual(
        observations.map((observation) => observation.id),
        ["setup-change:assignment:trial:run:gap:3"],
      );
    }).pipe(
      Effect.provide(
        recorderLayer(
          () =>
            Effect.sync(
              () => ({ ...thread, projectId: "project:setup", worktreePath: repoPath }) as never,
            ),
          {
            list: () => Effect.succeed([{ id: "trial", status: "running" }] as never),
            assignments: () =>
              Effect.succeed([
                { id: "assignment:trial", experimentId: "trial", variant: { id: "a" } },
              ] as never),
            recordObservation: (input) =>
              Effect.sync(() => {
                observations.push(input);
                return input as never;
              }),
          },
        ),
      ),
      Effect.scoped,
      Effect.provide(layer),
    );
  });

  it.effect("captures runs one at a time in the order they start", () => {
    const captured: Array<string> = [];
    let gate: Deferred.Deferred<void> | null = null;
    return Effect.gen(function* () {
      const recorder = yield* RunSetup.RunSetupRecorder;
      gate = yield* Deferred.make<void>();
      const runAt = (ordinal: number) =>
        ({
          id: RunId.make(`run:order:${ordinal}`),
          threadId,
          ordinal,
          modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" },
        }) as never;
      const first = yield* Effect.forkChild(recorder.record(runAt(1), null));
      yield* Effect.yieldNow;
      const second = yield* Effect.forkChild(recorder.record(runAt(2), null));
      yield* Effect.yieldNow;
      // Run 1's capture is still reading; run 2 waits for it instead of reading first.
      assert.deepEqual(captured, ["run:order:1"]);
      yield* Deferred.succeed(gate, undefined);
      yield* Fiber.joinAll([first, second]);
      assert.deepEqual(captured, ["run:order:1", "run:order:2"]);
      assert.lengthOf(yield* storedSetups(threadId, 10), 2);
    }).pipe(
      Effect.provide(
        recorderLayer(() =>
          Effect.gen(function* () {
            captured.push(`run:order:${captured.length + 1}`);
            if (captured.length === 1 && gate !== null) yield* Deferred.await(gate);
            return { ...thread, projectId: "project:setup" } as never;
          }),
        ),
      ),
    );
  });

  it.effect("records a run that started before the recorder did as unobserved", () =>
    Effect.gen(function* () {
      const recorder = yield* RunSetup.RunSetupRecorder;
      // The test clock starts at the epoch, so this run started a minute before the
      // recorder: a run brought back by a restart.
      yield* recorder.record(
        {
          id: RunId.make("run:restarted:1"),
          threadId,
          ordinal: 1,
          startedAt: DateTime.makeUnsafe(-60 * 1000),
          modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" },
        } as never,
        null,
      );
      const [record] = yield* storedSetups(threadId, 1);
      assert.isNull(record?.instructions);
      assert.isNull(record?.skills);
    }).pipe(
      Effect.provide(
        recorderLayer(() => Effect.succeed({ ...thread, projectId: "project:setup" } as never)),
      ),
    ),
  );

  it.effect("records a capture that waited too long behind another as unobserved", () => {
    let gate: Deferred.Deferred<void> | null = null;
    let calls = 0;
    return Effect.gen(function* () {
      const recorder = yield* RunSetup.RunSetupRecorder;
      gate = yield* Deferred.make<void>();
      const runAt = (ordinal: number) =>
        ({
          id: RunId.make(`run:waited:${ordinal}`),
          threadId,
          ordinal,
          // Run 1 is the one holding the capture; only run 2 waits on the clock.
          ...(ordinal === 2 ? { startedAt: DateTime.makeUnsafe(0) } : {}),
          modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" },
        }) as never;
      const first = yield* Effect.forkChild(recorder.record(runAt(1), null));
      yield* Effect.yieldNow;
      const second = yield* Effect.forkChild(recorder.record(runAt(2), null));
      yield* Effect.yieldNow;
      yield* TestClock.adjust("31 seconds");
      yield* Deferred.succeed(gate, undefined);
      yield* Fiber.joinAll([first, second]);
      const records = yield* storedSetups(threadId, 10);
      const byRun = new Map(records.map((record) => [record.runId as string, record]));
      // Run 1's own capture timed out, so run 2 only got its turn after the delay passed.
      assert.isNull(byRun.get("run:waited:2")?.instructions);
    }).pipe(
      Effect.provide(
        recorderLayer(() =>
          Effect.gen(function* () {
            calls += 1;
            if (calls === 1 && gate !== null) yield* Deferred.await(gate);
            return { ...thread, projectId: "project:setup" } as never;
          }),
        ),
      ),
    );
  });

  it.effect("records a capture whose reads ran past the delay as unobserved", () => {
    let gate: Deferred.Deferred<void> | null = null;
    return Effect.gen(function* () {
      const recorder = yield* RunSetup.RunSetupRecorder;
      gate = yield* Deferred.make<void>();
      const reading = yield* Effect.forkChild(
        recorder.record(
          {
            id: RunId.make("run:slow:1"),
            threadId,
            ordinal: 1,
            startedAt: DateTime.makeUnsafe(0),
            modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" },
          } as never,
          null,
        ),
      );
      yield* Effect.yieldNow;
      // The capture began on time but its reads took longer than the bound.
      yield* TestClock.adjust("11 seconds");
      yield* Deferred.succeed(gate, undefined);
      yield* Fiber.join(reading);
      const [record] = yield* storedSetups(threadId, 1);
      assert.isNull(record?.instructions);
    }).pipe(
      Effect.provide(
        recorderLayer(() =>
          Effect.gen(function* () {
            if (gate !== null) yield* Deferred.await(gate);
            return { ...thread, projectId: "project:setup" } as never;
          }),
        ),
      ),
    );
  });

  it.effect("does not make one thread's capture wait for another's", () => {
    let gate: Deferred.Deferred<void> | null = null;
    return Effect.gen(function* () {
      const recorder = yield* RunSetup.RunSetupRecorder;
      gate = yield* Deferred.make<void>();
      const runIn = (thread: string) =>
        ({
          id: RunId.make(`run:${thread}:1`),
          threadId: ThreadId.make(thread),
          ordinal: 1,
          modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" },
        }) as never;
      const slow = yield* Effect.forkChild(recorder.record(runIn("thread:slow"), null));
      yield* Effect.yieldNow;
      yield* recorder.record(runIn("thread:quick"), null);
      assert.lengthOf(yield* storedSetups(ThreadId.make("thread:quick"), 10), 1);
      assert.lengthOf(yield* storedSetups(ThreadId.make("thread:slow"), 10), 0);
      yield* Deferred.succeed(gate, undefined);
      yield* Fiber.join(slow);
    }).pipe(
      Effect.provide(
        recorderLayer((id) =>
          Effect.gen(function* () {
            if (id === "thread:slow" && gate !== null) yield* Deferred.await(gate);
            return { ...thread, projectId: "project:setup" } as never;
          }),
        ),
      ),
    );
  });

  it.effect("marks no cut for a run whose record was stored before a restart", () => {
    let repoPath = "";
    const observations: Array<{ id: string }> = [];
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const sql = yield* SqlClient.SqlClient;
      const recorder = yield* RunSetup.RunSetupRecorder;
      const repo = yield* fs.makeTempDirectoryScoped({ prefix: "run-setup-restart-" });
      repoPath = repo;
      const agents = path.join(repo, "AGENTS.md");
      const runAt = (ordinal: number) =>
        ({
          id: RunId.make(`run:restart:${ordinal}`),
          threadId,
          ordinal,
          modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" },
        }) as never;
      yield* fs.writeFileString(agents, "v1");
      yield* recorder.record(runAt(1), null);
      // Run 2 was captured before the restart: its record is stored, and this recorder
      // has not seen it, so it captures run 2 again from today's files.
      const [first] = yield* storedSetups(threadId, 1);
      const stored = { ...first!, runId: RunId.make("run:restart:2"), runOrdinal: 2 };
      const json = yield* Schema.encodeEffect(Schema.fromJsonString(RunSetupRecord))(stored);
      yield* sql`INSERT INTO run_setup_records (run_id, thread_id, captured_at, record_json)
        VALUES (${stored.runId}, ${threadId}, ${stored.capturedAt}, ${json})`;
      yield* fs.writeFileString(agents, "v2");
      yield* recorder.record(runAt(2), null);
      assert.deepEqual(observations, []);
    }).pipe(
      Effect.provide(
        recorderLayer(
          () =>
            Effect.sync(
              () => ({ ...thread, projectId: "project:setup", worktreePath: repoPath }) as never,
            ),
          {
            list: () => Effect.succeed([{ id: "trial", status: "running" }] as never),
            assignments: () =>
              Effect.succeed([
                { id: "assignment:trial", experimentId: "trial", variant: { id: "a" } },
              ] as never),
            recordObservation: (input) =>
              Effect.sync(() => {
                observations.push(input);
                return input as never;
              }),
          },
        ),
      ),
      Effect.scoped,
      Effect.provide(layer),
    );
  });

  it.effect("marks one observation when a thread's instructions change mid-trial", () => {
    let repoPath = "";
    const observations: Array<{ id: string; runId: string; setupChanges?: unknown }> = [];
    return Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const recorder = yield* RunSetup.RunSetupRecorder;
      const repo = yield* fs.makeTempDirectoryScoped({ prefix: "run-setup-cut-" });
      const agents = path.join(repo, "AGENTS.md");
      const runAt = (ordinal: number) =>
        ({
          id: RunId.make(`run:cut:${ordinal}`),
          threadId,
          ordinal,
          modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" },
        }) as never;
      repoPath = repo;
      yield* fs.writeFileString(agents, "v1");
      yield* recorder.record(runAt(1), null);
      yield* fs.writeFileString(agents, "v2");
      yield* recorder.record(runAt(2), null);
      yield* recorder.record(runAt(3), null);
      // Run 5 sees v3 and its capture lands before run 4's, which still saw v2.
      yield* fs.writeFileString(agents, "v3");
      yield* recorder.record(runAt(5), null);
      yield* fs.writeFileString(agents, "v2");
      yield* recorder.record(runAt(4), null);
      assert.deepEqual(
        observations.map((observation) => observation.id),
        ["setup-change:assignment:trial:run:cut:2", "setup-change:assignment:trial:run:cut:5"],
      );
      assert.deepEqual(observations[0]?.setupChanges, [
        { subject: agents, from: yield* sha256("v1"), to: yield* sha256("v2") },
      ]);
      assert.deepEqual(observations[1]?.setupChanges, [
        { subject: agents, from: yield* sha256("v2"), to: yield* sha256("v3") },
      ]);
    }).pipe(
      Effect.provide(
        recorderLayer(
          () =>
            Effect.sync(
              () => ({ ...thread, projectId: "project:setup", worktreePath: repoPath }) as never,
            ),
          {
            list: () => Effect.succeed([{ id: "trial", status: "running" }] as never),
            assignments: () =>
              Effect.succeed([
                { id: "assignment:trial", experimentId: "trial", variant: { id: "a" } },
              ] as never),
            recordObservation: (input) =>
              // Like the service, a repeated id with the same content is one observation.
              Effect.sync(() => {
                if (!observations.some((observation) => observation.id === input.id))
                  observations.push(input);
                return input as never;
              }),
          },
        ),
      ),
      Effect.scoped,
      Effect.provide(layer),
    );
  });
});
