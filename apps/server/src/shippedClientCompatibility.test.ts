import {
  DEFAULT_SERVER_SETTINGS,
  Experiment,
  ExperimentAssignment,
  OrchestrationV2ThreadShell,
  ProjectId,
  ProviderInstanceId,
  ServerSettings,
  ThreadId,
} from "@t3tools/contracts";
import { assert, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";

import { settingsForClient } from "./serverSettings.ts";

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

it("a shipped client ignores additive champion owner metadata on an ordinary thread shell", () => {
  const { id, title, threadWatches } = OrchestrationV2ThreadShell.fields;
  const shippedShell = Schema.Struct({ id, title, threadWatches });
  const decoded = Schema.decodeUnknownSync(shippedShell)({
    id: "thread-champion",
    title: "Quality",
    champion: { id: "quality", attention: false },
  });
  assert.deepEqual(Object.keys(decoded).toSorted(), ["id", "title"]);
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
      assert.deepEqual(
        violations(encodeExperiment(value), frozen.experiment, value.lever),
        [],
      );
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
    assert.deepEqual(
      violations(encodeAssignment(assignment), frozen.assignment, "a"),
      [],
    );
    // The frozen schema still catches what an older client could not read.
    assert.notDeepEqual(
      violations(
        { ...encodeExperiment(newTrials[0]!), lever: "council" },
        frozen.experiment,
        "x",
      ),
      [],
    );
  }).pipe(Effect.provide(NodeServices.layer)),
);
