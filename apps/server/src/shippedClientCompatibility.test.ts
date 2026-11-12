import {
  DEFAULT_SERVER_SETTINGS,
  ChampionRelayedApproval,
  Experiment,
  EnvironmentId,
  ExperimentAssignment,
  OrchestrationV2DelegatedCompletionTaskDeliveryState,
  OrchestrationV2Notification,
  OrchestrationV2Subagent,
  OrchestrationV2ThreadShell,
  OrchestrationV2ThreadStanding,
  RunId,
  ProjectId,
  ProviderDriverKind,
  ProviderInstanceId,
  ServerSettings,
  ThreadId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

import { REMEMBERED_LIMIT_WINDOW_ID, withRememberedLimits } from "@t3tools/shared/providerPools";

import { settingsForClient } from "./serverSettings.ts";
import { rpcSerializationForClient } from "./clientRoleSerialization.ts";

// Frozen from the upstream release before the fork's first settings addition (fork/shipped-client).
// To refresh it for a newer shipped client, extract that release's packages/contracts and write
// JSON.stringify(Schema.toJsonSchemaDocument(Schema.toEncoded(ServerSettings))) from its settings.ts.
const loadShippedSettingsSchema = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs.readFileString(
    new URL("../../../fork/shipped-client/server-settings.schema.json", import.meta.url).pathname,
  );
  const schema: JsonSchema = JSON.parse(text).schema;
  return schema;
});

interface JsonSchema {
  readonly type?: string | ReadonlyArray<string>;
  readonly enum?: ReadonlyArray<unknown>;
  readonly anyOf?: ReadonlyArray<JsonSchema>;
  readonly properties?: Record<string, JsonSchema>;
  readonly required?: ReadonlyArray<string>;
  readonly additionalProperties?: boolean | JsonSchema;
  readonly items?: JsonSchema;
}

// Only the keywords Effect emits for settings. Unknown keys pass, like Schema.Struct decoding.
function violations(value: unknown, schema: JsonSchema, at: string): ReadonlyArray<string> {
  if (schema.anyOf) {
    const attempts = schema.anyOf.map((branch) => violations(value, branch, at));
    return attempts.some((found) => found.length === 0) ? [] : (attempts[0] ?? []);
  }
  if (schema.enum && !schema.enum.includes(value)) {
    return [`${at}: ${JSON.stringify(value)} is not one of ${JSON.stringify(schema.enum)}`];
  }
  const types = schema.type === undefined ? [] : [schema.type].flat();
  const actual = value === null ? "null" : Array.isArray(value) ? "array" : typeof value;
  const matches = (type: string) =>
    type === actual || (type === "integer" && Number.isInteger(value));
  if (types.length > 0 && !types.some(matches)) {
    return [`${at}: expected ${types.join("|")}, got ${actual}`];
  }
  if (actual === "array" && schema.items) {
    const items = schema.items;
    return (value as ReadonlyArray<unknown>).flatMap((item, index) =>
      violations(item, items, `${at}[${index}]`),
    );
  }
  if (actual !== "object") return [];
  const record = value as Record<string, unknown>;
  const missing = (schema.required ?? [])
    .filter((key) => !(key in record))
    .map((key) => `${at}.${key}: missing`);
  const declared = Object.entries(schema.properties ?? {}).flatMap(([key, child]) =>
    key in record ? violations(record[key], child, `${at}.${key}`) : [],
  );
  const extra = schema.additionalProperties;
  const mapped =
    typeof extra === "object"
      ? Object.entries(record)
          .filter(([key]) => !(key in (schema.properties ?? {})))
          .flatMap(([key, child]) => violations(child, extra, `${at}.${key}`))
      : [];
  return [...missing, ...declared, ...mapped];
}

const encodeSettings = Schema.encodeSync(ServerSettings);
const encodeExperiment = Schema.encodeSync(Experiment);
const encodeAssignment = Schema.encodeSync(ExperimentAssignment);
const decodeAssignment = Schema.decodeUnknownSync(ExperimentAssignment);

const forkSettings = {
  ...DEFAULT_SERVER_SETTINGS,
  responseStreamingMode: "live" as const,
  projectSettingsOverrides: {
    [ProjectId.make("live")]: { responseStreamingMode: "live" as const },
  },
};

it.effect("the frozen shipped-client schema rejects what a fork-only value would send", () =>
  Effect.gen(function* () {
    const shipped = yield* loadShippedSettingsSchema;
    assert.notDeepEqual(violations(encodeSettings(forkSettings), shipped, "settings"), []);
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "settings sent to a client that has not opted into fork features decode as the shipped client",
  () =>
    Effect.gen(function* () {
      const shipped = yield* loadShippedSettingsSchema;
      const sent = encodeSettings(
        settingsForClient(forkSettings, { liveResponseStreaming: false }),
      );
      assert.deepEqual(violations(sent, shipped, "settings"), []);
    }).pipe(Effect.provide(NodeServices.layer)),
);

it("a client that predates endedThreadWatches still decodes a thread shell that carries it", () => {
  const { id, title, threadWatches } = OrchestrationV2ThreadShell.fields;
  const shippedShell = Schema.Struct({ id, title, threadWatches });
  const decoded = Schema.decodeUnknownSync(shippedShell)({
    id: "thread-1",
    title: "Lead",
    endedThreadWatches: [
      { threadId: "thread-2", title: "Worker", endedAt: "2026-10-22T00:00:00Z" },
    ],
  });
  assert.deepEqual(Object.keys(decoded).toSorted(), ["id", "title"]);
});

it("a shipped client ignores additive Champion owner and approval origin metadata", () => {
  const { id, title, threadWatches } = OrchestrationV2ThreadShell.fields;
  const shippedShell = Schema.Struct({ id, title, threadWatches });
  const decoded = Schema.decodeUnknownSync(shippedShell)({
    id: "thread-champion",
    title: "Quality",
    champion: { id: "quality", attention: false },
  });
  assert.deepEqual(Object.keys(decoded).toSorted(), ["id", "title"]);
  const approval = {
    quote: "Yes, go ahead.",
    threadId: "source-thread",
    threadTitle: "Performance pass",
    model: "m",
    approvedAt: "2026-11-07T00:00:00.000Z",
    sourceEnvironment: { id: "mac", label: "Mac" },
  };
  const shippedApproval = decodeShippedApproval(approval);
  assert.notProperty(shippedApproval, "sourceEnvironment");
  assert.equal(shippedApproval.quote, approval.quote);
});

const { sourceEnvironment: _source, ...shippedApprovalFields } = ChampionRelayedApproval.fields;
const decodeShippedApproval = Schema.decodeSync(Schema.Struct(shippedApprovalFields));

const decodeSubagent = Schema.decodeSync(OrchestrationV2Subagent);

it("a shipped client decodes a task its parent's Stop paused as an interrupted task", () => {
  const { pausedByParentStop: _paused, ...fields } = OrchestrationV2Subagent.fields;
  // What a shipped client knows of a task: no pause mark, and a delivery without its stop flag.
  const shippedTask = Schema.Struct({
    ...fields,
    completionDelivery: Schema.optional(
      Schema.Struct({
        state: OrchestrationV2DelegatedCompletionTaskDeliveryState,
        observedByRunId: Schema.NullOr(RunId),
      }),
    ),
  });
  const now = DateTime.makeUnsafe("2026-11-10T09:00:00.000Z");
  const wire = decodeSubagent({
    id: "node:task",
    threadId: "thread-lead",
    runId: "run-lead",
    parentNodeId: "node:root",
    origin: "app_owned",
    createdBy: "agent",
    driver: "codex",
    providerInstanceId: "codex",
    providerThreadId: null,
    childThreadId: "thread-child",
    nativeTaskRef: null,
    prompt: "Lead the Spec.",
    title: null,
    model: null,
    status: "interrupted",
    result: "Stopped with its parent.",
    startedAt: now,
    completedAt: now,
    updatedAt: now,
    pausedByParentStop: true,
    completionDelivery: { state: "disposed", observedByRunId: null, stopped: true },
  });
  const decoded = Schema.decodeSync(shippedTask)(wire);
  assert.equal(decoded.status, "interrupted");
  assert.notProperty(decoded, "pausedByParentStop");
});

// Frozen from upstream's thread shell (fork/shipped-client/thread-shell.schema.json, pingdotgg/t3code
// 20c3dd3689, v0.1.9-nightly.20261110.4478), which has no watches or parked waits.
// To refresh it, extract that release's packages/contracts and write
// JSON.stringify(Schema.toJsonSchemaDocument(Schema.toEncoded(OrchestrationV2ThreadShell))).
const loadShippedThreadShellSchema = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs.readFileString(
    new URL("../../../fork/shipped-client/thread-shell.schema.json", import.meta.url).pathname,
  );
  const schema: JsonSchema = JSON.parse(text).schema;
  return schema;
});

const forkThreadShell = (extra: Record<string, unknown>) => ({
  createdBy: "agent",
  creationSource: "mcp",
  id: "thread-lead",
  projectId: "project-1",
  title: "Lead",
  providerInstanceId: "codex",
  modelSelection: { instanceId: "codex", model: "gpt-6.1-sol" },
  runtimeMode: "full-access",
  interactionMode: "default",
  branch: null,
  worktreePath: null,
  lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: "thread-lead" },
  forkedFrom: null,
  activeProviderThreadId: null,
  latestRunId: "run-1",
  activeRunId: null,
  status: "completed",
  pendingRuntimeRequest: null,
  latestVisibleMessage: null,
  latestUserMessageAt: "2026-11-10T09:00:00.000Z",
  hasActionableProposedPlan: false,
  pendingBackgroundTasks: [],
  itemCount: 4,
  visibleItemCount: 4,
  createdAt: "2026-11-10T08:00:00.000Z",
  updatedAt: "2026-11-10T09:00:00.000Z",
  archivedAt: null,
  settledOverride: null,
  settledAt: null,
  deletedAt: null,
  standing: { state: "finished" },
  parkedWaitGaveUp: { title: "Earlier wait", at: "2026-11-09T09:00:00.000Z" },
  parkedWaitWoke: { title: "Earlier wake", at: "2026-11-09T10:00:00.000Z" },
  ...extra,
});

const forkShellJson = Schema.toCodecJson(OrchestrationV2ThreadShell);

const decodeForkShell = Schema.decodeUnknownSync(forkShellJson);

const encodeForkShell = (extra: Record<string, unknown>) =>
  JSON.parse(
    JSON.stringify(Schema.encodeSync(forkShellJson)(decodeForkShell(forkThreadShell(extra)))),
  );

it.effect(
  "a shipped client decodes threads parked on Production and on a time as finished threads",
  () =>
    Effect.gen(function* () {
      const shipped = yield* loadShippedThreadShellSchema;
      const parked = [
        {
          id: "parked-wait:production",
          title: "Commit abc1234 reaching Production",
          startedAt: "2026-11-10T09:00:00.000Z",
          target: { kind: "production" as const, commitId: "abc1234" },
          expectedAt: "2026-11-11T09:00:00.000Z",
          givesUpAt: "2026-11-12T09:00:00.000Z",
          note: "Check the release notes.",
        },
        {
          id: "parked-wait:time",
          title: "Until 2026-11-11T09:00:00.000Z",
          startedAt: "2026-11-10T09:00:00.000Z",
          target: { kind: "time" as const, at: "2026-11-11T09:00:00.000Z" },
        },
      ];
      for (const wait of parked) {
        const sent = encodeForkShell({ parkedWaits: [wait] });
        assert.deepEqual(sent.parkedWaits, [wait]);
        assert.deepEqual(violations(sent, shipped, wait.target.kind), []);
        // The fork's own decoding keeps the wait.
        assert.deepEqual(decodeForkShell(sent).parkedWaits, [wait]);
      }
      // Upstream's shell has no threadWatches, so parked waits travel in their own field and the
      // fork never puts a parked target in threadWatches.
      assert.notProperty(shipped.properties ?? {}, "threadWatches");
      assert.notProperty(shipped.properties ?? {}, "parkedWaits");
      const wire = encodeForkShell({ parkedWaits: [parked[0]] });
      assert.notProperty(wire, "threadWatches");
      // The frozen schema still catches a shell a shipped client could not read.
      const { status: _status, ...withoutStatus } = wire;
      assert.notDeepEqual(violations(withoutStatus, shipped, "shell"), []);
      assert.notDeepEqual(violations({ ...wire, status: "parked" }, shipped, "shell"), []);
    }).pipe(Effect.provide(NodeServices.layer)),
);

const decodeStanding = Schema.decodeUnknownSync(OrchestrationV2ThreadStanding);

it("a shipped client decodes a stalled thread and one that waits on the owner as threads it knows", () => {
  const { id, title, status, pendingBackgroundTasks, blockedOnThreadWait } =
    OrchestrationV2ThreadShell.fields;
  // What a shipped client reads of a watch: the fork's waitsOnPerson is not among its fields.
  const shippedWatch = Schema.Struct({
    id: Schema.String,
    title: Schema.String,
    startedAt: Schema.String,
    target: Schema.Unknown,
  });
  const shippedShell = Schema.Struct({
    id,
    title,
    status,
    pendingBackgroundTasks,
    blockedOnThreadWait,
    threadWatches: Schema.optional(Schema.Array(shippedWatch)),
  });
  const watch = {
    id: "thread-watch:1",
    title: "Ship it",
    startedAt: "2026-11-10T09:00:00.000Z",
    target: { kind: "build_item", number: 7, until: "unblocked" },
  };
  const stalledWire = {
    id: "thread-stalled",
    title: "Lead",
    status: "completed",
    blockedOnThreadWait: true,
    pendingBackgroundTasks: [{ taskId: "task-1", kind: "subagent" }],
    standing: {
      state: "stalled",
      stalled: { childThreadId: "thread-child", title: "Quiet", since: "2026-11-10T08:00:00.000Z" },
    },
  };
  const waitingOnOwnerWire = {
    id: "thread-owner",
    title: "Lead",
    status: "completed",
    pendingBackgroundTasks: [
      { taskId: "thread-watch:1", kind: "monitor", awaited: true, watching: watch.target },
    ],
    threadWatches: [{ ...watch, waitsOnPerson: { need: "acceptance", title: "Ship it" } }],
    standing: {
      state: "needs_you",
      waitsOnPerson: { kind: "build_item", number: 7, title: "Ship it", need: "acceptance" },
    },
  };
  for (const wire of [stalledWire, waitingOnOwnerWire]) {
    const decoded = Schema.decodeUnknownSync(shippedShell)(wire);
    assert.equal(decoded.status, "completed");
    assert.notProperty(decoded, "standing");
    // The same wire is what the fork's own clients read.
    const forkDecoded: unknown = decodeStanding(wire.standing);
    assert.deepEqual(forkDecoded, wire.standing);
  }
});

const encodeNotification = Schema.encodeSync(OrchestrationV2Notification);

it("a shipped client reads a watch on a thread in another environment as a thread watch", () => {
  // What a shipped client reads: a thread target is its kind and thread id, a stored thread
  // wake the legacy background-task source. The environment is an extra key it ignores.
  const shippedWatch = Schema.Struct({
    id: Schema.String,
    title: Schema.String,
    startedAt: Schema.String,
    target: Schema.Struct({ kind: Schema.Literal("thread"), threadId: Schema.String }),
  });
  const watch = {
    id: "thread-watch:remote",
    title: "Fix the login on the box",
    startedAt: "2026-11-12T09:00:00.000Z",
    target: { kind: "thread", threadId: "thread-box", environmentId: "environment-box" },
  };
  const decoded = Schema.decodeUnknownSync(shippedWatch)(watch);
  assert.deepEqual(decoded.target, { kind: "thread", threadId: "thread-box" });

  const wake = encodeNotification({
    source: {
      kind: "thread",
      threadId: ThreadId.make("thread-box"),
      environmentId: EnvironmentId.make("environment-box"),
    },
    outcome: "completed",
    summary: "Finished: Fix the login on the box",
  });
  const shippedSource = Schema.Struct({
    kind: Schema.Literal("background_task"),
    work: Schema.Literal("thread"),
    threadId: Schema.String,
  });
  assert.deepEqual(Schema.decodeUnknownSync(shippedSource)(wake.source), {
    kind: "background_task",
    work: "thread",
    threadId: "thread-box",
  });
});

it("shipped thread shells ignore managed roles and preceding fork clients accept reviewer", () => {
  const { id, title } = OrchestrationV2ThreadShell.fields;
  const shippedShell = Schema.Struct({ id, title });
  // The preceding fork's AgentTaskBinding accepted these three wire role values.
  const precedingForkShell = Schema.Struct({
    id,
    title,
    agentTask: Schema.Struct({
      role: Schema.Literals(["reviewer", "ticket-reviewer", "spec-reviewer"]),
    }),
  });
  const wire = { id: "thread-review", title: "Reviewer", agentTask: { role: "reviewer" } };
  assert.deepEqual(Schema.decodeSync(shippedShell)(wire), {
    id: "thread-review",
    title: "Reviewer",
  });
  assert.strictEqual(
    Schema.decodeSync(precedingForkShell)({ ...wire, agentTask: { role: "reviewer" } }).agentTask
      .role,
    "reviewer",
  );
});

// Upstream builds have no experiments; the fork's own clients from before T3-393 read them
// against these schemas (fork/shipped-client/experiments.schema.json, frozen at bd0027eb).
const loadFrozenExperimentSchemas = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const text = yield* fs.readFileString(
    new URL("../../../fork/shipped-client/experiments.schema.json", import.meta.url).pathname,
  );
  const parsed = JSON.parse(text);
  return {
    experiment: parsed.experiment.schema as JsonSchema,
    assignment: parsed.assignment.schema as JsonSchema,
  };
});

const trial = {
  id: "trial",
  title: "Trial",
  question: "Which is better?",
  primaryOutcome: "Results",
  maxAssignments: 40,
  endsAt: "2999-01-01T00:00:00Z",
  stopConditions: [],
  codeRevision: null,
  briefRevision: null,
  revision: 1,
  createdAt: "2026-11-05T00:00:00Z",
  startedAt: "2026-11-05T00:00:00Z",
  updatedAt: "2026-11-05T00:00:00Z",
  eligibility: { projectIds: [], models: [], taskCategories: [] },
};
const sol = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-6.1-sol",
  options: [{ id: "reasoningEffort", value: "high" }],
};
const newTrials: ReadonlyArray<Experiment> = [
  {
    ...trial,
    status: "running",
    lever: "delegation",
    eligibility: { ...trial.eligibility, agentRoles: ["scout"] },
    variants: [
      { id: "a", label: "A", modelSelection: { ...sol, options: [] } },
      { id: "b", label: "B", modelSelection: sol },
    ],
  },
  {
    ...trial,
    status: "paused",
    lever: "instruction",
    variants: [
      { id: "today", label: "Today's instructions" },
      {
        id: "added",
        label: "With checklist",
        instructions: {
          sourcePath: "added-text",
          revision: "added-text",
          sha256: "a".repeat(64),
          text: "Add a severity checklist.",
        },
      },
    ],
  },
  {
    ...trial,
    status: "stopped",
    adoptedVariantId: "earlier",
    lever: "orchestration-policy",
    variants: [
      { id: "inline", label: "Inline first", allocationPolicy: "inline-first" },
      { id: "earlier", label: "Delegate earlier", allocationPolicy: "delegate-earlier" },
    ],
  },
];

it.effect("a fork client from before T3-393 reads new trials and their pause and stop", () =>
  Effect.gen(function* () {
    const frozen = yield* loadFrozenExperimentSchemas;
    for (const value of newTrials)
      assert.deepEqual(violations(encodeExperiment(value), frozen.experiment, value.lever), []);
    const assignment: ExperimentAssignment = {
      id: "assignment",
      experimentId: "trial",
      revision: 1,
      lever: "orchestration-policy",
      unitKind: "thread",
      unitId: "delivery:7",
      threadId: ThreadId.make("lead"),
      projectId: ProjectId.make("project"),
      taskCategory: null,
      boundaryRunId: null,
      variant: newTrials[2]!.variants[1]!,
      assignedModelSelection: sol,
      enrollment: "new",
      assignmentMethod: "randomized",
      assignedAt: "2026-11-05T00:00:00Z",
      codeRevision: null,
      briefRevision: null,
      provenance: null,
    };
    assert.deepEqual(violations(encodeAssignment(assignment), frozen.assignment, "a"), []);
    // A task saved with the retired `demanding` flag reads back without it and still decodes.
    const saved = decodeAssignment({
      ...encodeAssignment(assignment),
      lever: "delegation",
      variant: newTrials[0]!.variants[1]!,
      agentTask: {
        role: "scout",
        taskClass: "non-ui",
        workId: "work",
        attemptId: "attempt",
        workspacePath: "/repo",
        demanding: true,
        readOnly: true,
        requestFingerprint: "c".repeat(64),
        policyHash: "d".repeat(64),
        policyRevision: "policy",
        briefHash: "e".repeat(64),
        sourceAccess: "read-only",
        toolProfile: "source-reader",
        requested: sol,
        assigned: sol,
        effective: sol,
      },
    });
    assert.notProperty(saved.agentTask, "demanding");
    assert.deepEqual(violations(encodeAssignment(saved), frozen.assignment, "a"), []);
    // The frozen schema still catches what an older client could not read.
    assert.notDeepEqual(
      violations({ ...encodeExperiment(newTrials[0]!), lever: "council" }, frozen.experiment, "x"),
      [],
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);

it.effect(
  "an implementer task sent to a client that has not opted in decodes as a fork client before T3-563",
  () =>
    Effect.gen(function* () {
      const frozen = yield* loadFrozenExperimentSchemas;
      const assignment = encodeAssignment(
        decodeAssignment({
          id: "assignment",
          experimentId: "trial",
          revision: 1,
          lever: "delegation",
          unitKind: "task",
          unitId: "work",
          threadId: "worker",
          projectId: "project",
          taskCategory: null,
          boundaryRunId: null,
          variant: newTrials[0]!.variants[1]!,
          assignedModelSelection: sol,
          enrollment: "new",
          assignmentMethod: "randomized",
          assignedAt: "2026-11-10T00:00:00Z",
          codeRevision: null,
          briefRevision: null,
          provenance: null,
          agentTask: {
            role: "implementer",
            taskClass: "ui",
            workId: "work",
            attemptId: "attempt",
            workspacePath: "/repo",
            requestFingerprint: "c".repeat(64),
            policyHash: "d".repeat(64),
            policyRevision: "policy",
            briefHash: "e".repeat(64),
            sourceAccess: "scoped-write",
            toolProfile: "implementation",
            requested: sol,
            assigned: sol,
            effective: sol,
          },
        }),
      );
      const experiment = encodeExperiment({
        ...newTrials[0]!,
        eligibility: { ...newTrials[0]!.eligibility, agentRoles: ["implementer"] },
      } as Experiment);
      const message = {
        _tag: "Exit",
        requestId: "1",
        exit: { assignment, experiment, title: "implementer" },
      };
      const sent = (implementerRole: boolean) => {
        const encoded = rpcSerializationForClient(implementerRole).makeUnsafe().encode(message);
        return JSON.parse(String(encoded)).exit;
      };
      // The frozen schemas refuse the new role, so the downgrade is what makes them decode.
      assert.notDeepEqual(violations(sent(true).assignment, frozen.assignment, "a"), []);
      assert.deepEqual(violations(sent(false).assignment, frozen.assignment, "a"), []);
      assert.deepEqual(violations(sent(false).experiment, frozen.experiment, "e"), []);
      assert.strictEqual(sent(false).assignment.agentTask.role, "implementation-worker");
      // Only role values change: a user's text that happens to read "implementer" is kept.
      assert.strictEqual(sent(false).title, "implementer");
    }).pipe(Effect.provide(NodeServices.layer)),
);

it("a shipped client decodes the usage window that carries a remembered usage limit", () => {
  // Frozen from upstream's ServerProviderUsageWindow; a new kind would fail shipped clients whole.
  const shippedWindow = Schema.Struct({
    id: Schema.String,
    kind: Schema.Literals(["session", "weekly", "monthly", "other"]),
    label: Schema.String,
    usedPercent: Schema.Number,
    resetsAt: Schema.optional(Schema.String),
  });
  const account = ProviderInstanceId.make("claudeAgent");
  const [provider] = withRememberedLimits(
    [
      {
        instanceId: account,
        driver: ProviderDriverKind.make("claudeAgent"),
        enabled: true,
        installed: true,
        version: "1.0.0",
        status: "ready",
        auth: { status: "authenticated" },
        checkedAt: "2026-11-10T12:00:00.000Z",
        models: [],
        slashCommands: [],
        skills: [],
      },
    ],
    new Map([[account, Date.parse("2026-11-10T15:00:00.000Z")]]),
    Date.parse("2026-11-10T12:00:00.000Z"),
  );
  const window = provider?.usageLimits?.windows.find(
    (candidate) => candidate.id === REMEMBERED_LIMIT_WINDOW_ID,
  );
  assert.isDefined(window);
  Schema.decodeSync(shippedWindow)(window!);
});
