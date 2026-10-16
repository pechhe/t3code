import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import {
  ContextRolloverSettings,
  type OrchestrationV2TurnItem,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Hex from "effect/encoding/Hex";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import * as Option from "effect/Option";
import * as ExperimentService from "../experiments/ExperimentService.ts";
import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
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

describe("RunSetupStore", () => {
  it.effect("lists a thread's records newest first", () =>
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
      const records = yield* store.list(threadId, 10);
      assert.deepEqual(
        records.map((record) => record.runId),
        ["run:b", "run:a"],
      );
    }).pipe(Effect.provide(RunSetup.storeLayer.pipe(Layer.provideMerge(Sqlite.layerMemory)))),
  );
});

describe("RunSetupRecorder.record", () => {
  const recorderLayer = (getThread: ProjectionStore.ProjectionStoreV2["Service"]["getThread"]) =>
    Layer.effect(RunSetup.RunSetupRecorder, RunSetup.make).pipe(
      Layer.provide(
        Layer.mergeAll(
          Layer.mock(Orchestrator.OrchestratorV2)({}),
          Layer.mock(ProjectionStore.ProjectionStoreV2)({ getThread }),
          Layer.mock(ProjectStore.ProjectStoreV2)({ get: () => Effect.succeed(Option.none()) }),
          Layer.mock(ExperimentService.ExperimentService)({
            assignments: () => Effect.succeed([]),
            getRolloverAssignment: () => Effect.succeed(null),
          }),
          Layer.mock(Policy.AgentPolicyService)({}),
          Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
          ServerSettings.layerTest(),
        ),
      ),
      Layer.provideMerge(RunSetup.storeLayer),
      Layer.provideMerge(Sqlite.layerMemory),
      Layer.provide(layer),
      Layer.provide(ConfigProvider.layer(ConfigProvider.fromUnknown({}))),
    );
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
      const store = yield* RunSetup.RunSetupStore;
      yield* recorder.record(runAt(1), null);
      yield* recorder.record(runAt(1), null);
      // A rollover continues the thread in a new run, which is captured afresh.
      yield* recorder.record(runAt(2), null);
      const records = yield* store.list(threadId, 10);
      assert.deepEqual(records.map((record) => record.runId).sort(), [
        "run:setup:1",
        "run:setup:2",
      ]);
      assert.deepEqual(records[0]?.workflow, { kind: "lead", unattended: true });
      // The model has no provider snapshot here, so its options are unknown.
      assert.isNull(records[0]?.effectiveOptions);
    }).pipe(
      Effect.provide(
        recorderLayer(() => Effect.succeed({ ...thread, projectId: "project:setup" } as never)),
      ),
    ),
  );

  it.effect("keeps a null record when capture fails", () =>
    Effect.gen(function* () {
      const recorder = yield* RunSetup.RunSetupRecorder;
      const store = yield* RunSetup.RunSetupStore;
      yield* recorder.record(runAt(3), null);
      const [record] = yield* store.list(threadId, 10);
      assert.deepEqual(
        { ...record, capturedAt: "" },
        { ...RunSetup.uncapturedRunSetup(runAt(3), ""), capturedAt: "" },
      );
    }).pipe(Effect.provide(recorderLayer(() => Effect.die("projection unavailable")))),
  );
});
