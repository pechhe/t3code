// @effect-diagnostics nodeBuiltinImport:off -- the fixture-file guard reads the testkit directory
// synchronously as this module loads, before any Effect runtime exists.
import * as NodeFS from "node:fs";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import type { OrchestrationV2DomainEvent, ProviderReplayTranscript } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";

import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import { checkpointWorkspace } from "@t3tools/provider-testing/replayWorkspace";
import { readProviderReplayTranscript } from "@t3tools/provider-testing/replayTranscript";
import { provideDeterministicTestRuntime } from "./DeterministicRuntime.ts";
import { ORCHESTRATOR_REPLAY_FIXTURES } from "./fixtures/index.ts";
import {
  assertProviderNativeSubagentRootTurns,
  materializeFixtureInput,
  type OrchestratorFixtureInput,
  type ProviderOrchestratorReplayVariant,
} from "./fixtures/shared.ts";
import {
  runOrchestratorV2ProviderReplayScenario,
  type OrchestratorV2ProviderReplayHarness,
} from "./ProviderReplayHarness.ts";
import { materializeReplayTranscriptRuntimeInstructions } from "./ReplayRuntimeInstructions.ts";

// Each driver's fixtures run from its own <Provider>ReplayFixtures<group>.integration.test.ts
// files, so a focused run loads one adapter. Tests within a file run one after another, so a
// driver whose fixtures are slow spreads them over several files that run in parallel. A
// fixture for a driver missing here, or a group whose file is missing, would silently never
// run, so loading this module fails instead.
const REPLAY_FIXTURE_FILES: Readonly<Record<string, { stem: string; files: number }>> = {
  acpRegistry: { stem: "AcpRegistryReplayFixtures", files: 1 },
  claudeAgent: { stem: "ClaudeReplayFixtures", files: 6 },
  codex: { stem: "CodexReplayFixtures", files: 1 },
  cursor: { stem: "CursorReplayFixtures", files: 1 },
  grok: { stem: "GrokReplayFixtures", files: 2 },
  muse: { stem: "MuseReplayFixtures", files: 1 },
  opencode: { stem: "OpenCodeReplayFixtures", files: 2 },
  pi: { stem: "PiReplayFixtures", files: 1 },
};
for (const fixture of ORCHESTRATOR_REPLAY_FIXTURES) {
  for (const provider of fixture.providers) {
    if (!Object.hasOwn(REPLAY_FIXTURE_FILES, provider.driver)) {
      throw new Error(
        `${fixture.name}/${provider.driver} has no ReplayFixtures test file to run it.`,
      );
    }
  }
}
for (const [driver, { stem, files }] of Object.entries(REPLAY_FIXTURE_FILES)) {
  const present = NodeFS.readdirSync(import.meta.dirname).filter((name) =>
    new RegExp(`^${stem}\\d*\\.integration\\.test\\.ts$`).test(name),
  );
  if (present.length !== files) {
    throw new Error(
      `${driver}'s replay fixtures are split over ${files} files, but there are ${present.length}: ${present.join(", ")}`,
    );
  }
}

export const readReplayFixtureTranscript = Effect.fn("readOrchestratorReplayTranscript")(function* (
  file: URL,
) {
  return yield* readProviderReplayTranscript(file);
}, Effect.provide(NodeServices.layer));

function normalizeTestError(cause: unknown): Error {
  return cause instanceof Error ? cause : new Error(String(cause));
}

function transcriptEntriesThroughLabel(
  transcript: ProviderReplayTranscript,
  label: string | undefined,
): ProviderReplayTranscript {
  if (label === undefined) {
    return transcript;
  }
  const entryIndex = transcript.entries.findIndex(
    (entry) => entry.type === "emit_inbound" && entry.label === label,
  );
  if (entryIndex === -1) {
    throw new Error(`${transcript.scenario} is missing inbound transcript label ${label}.`);
  }
  return {
    ...transcript,
    entries: transcript.entries.slice(0, entryIndex + 1),
  };
}

function isStreamingAssistantEvent(event: OrchestrationV2DomainEvent): boolean {
  switch (event.type) {
    case "node.updated":
      return event.payload.kind === "assistant_message" && event.payload.status === "running";
    case "message.updated":
      return event.payload.role === "assistant" && event.payload.streaming;
    case "turn-item.updated":
      return event.payload.type === "assistant_message" && event.payload.streaming;
    default:
      return false;
  }
}

export interface ReplayFixtureCase {
  readonly fixtureName: string;
  readonly buildInput: () => OrchestratorFixtureInput;
  readonly driver: ProviderOrchestratorReplayVariant;
  readonly transformTranscript?: (transcript: ProviderReplayTranscript) => ProviderReplayTranscript;
}

export interface ReplayFixtureRun<
  Transcript extends ProviderReplayTranscript,
  Error,
  WorkspaceError = never,
> extends ReplayFixtureCase {
  readonly harness: OrchestratorV2ProviderReplayHarness<Transcript, Error>;
  /** Rewrites recorded workspace paths to the replay workspace, for drivers that record them. */
  readonly materializeWorkspace?: (
    transcript: ProviderReplayTranscript,
    workspace: string,
  ) => Effect.Effect<ProviderReplayTranscript, WorkspaceError>;
}

const runFixtureProvider = Effect.fn("runOrchestratorReplayFixture")(function* <
  Transcript extends ProviderReplayTranscript,
  Error,
  WorkspaceError,
>(input: ReplayFixtureRun<Transcript, Error, WorkspaceError>) {
  const recordedTranscript = yield* readReplayFixtureTranscript(input.driver.transcriptFile);
  const rawTranscript = input.transformTranscript?.(recordedTranscript) ?? recordedTranscript;
  const replayTranscript = materializeReplayTranscriptRuntimeInstructions(
    transcriptEntriesThroughLabel(rawTranscript, input.driver.transcriptEntriesThroughLabel),
    { driver: input.driver.driver, model: input.driver.modelSelection.model },
  );
  const fixtureInput = input.buildInput();
  const workspace = yield* checkpointWorkspace(input.fixtureName, fixtureInput.workspaceFiles);
  const transcript = yield* input.harness.decodeTranscript(
    input.materializeWorkspace === undefined
      ? replayTranscript
      : yield* input.materializeWorkspace(replayTranscript, workspace),
  );
  const materialized = yield* materializeFixtureInput({
    scenario: input.fixtureName,
    fixtureInput,
    driver: input.driver.driver,
    modelSelection: input.driver.modelSelection,
  }).pipe(Effect.provide(IdAllocator.layer), provideDeterministicTestRuntime);
  const scenario = {
    name: `${input.fixtureName}/${input.driver.driver}`,
    transcript,
    commands: materialized.commands,
    steps: materialized.steps,
    projectionThreadIds: materialized.projectionThreadIds,
    runtimePolicyOverride: {
      ...input.driver.runtimePolicyOverride,
      cwd: workspace,
    },
  };

  const result = yield* runOrchestratorV2ProviderReplayScenario(
    scenario,
    input.harness,
    input.driver.runContinuationWorker === true ? { runContinuationWorker: true } : {},
  ).pipe(provideDeterministicTestRuntime);
  input.driver.assertOutput(result, transcript);
  assertProviderNativeSubagentRootTurns(result);
  const expectedAbsentWorkspacePaths = input.driver.expectedAbsentWorkspacePaths;
  if (expectedAbsentWorkspacePaths !== undefined) {
    yield* Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      for (const relativePath of expectedAbsentWorkspacePaths) {
        assert.isFalse(
          yield* fs.exists(path.join(workspace, relativePath)),
          `${input.fixtureName}/${input.driver.driver} must not create ${relativePath} in the replay workspace`,
        );
      }
    }).pipe(Effect.provide(NodeServices.layer));
  }
  assert.isFalse(
    result.domainEvents.some(isStreamingAssistantEvent),
    "buffered delivery must not persist streaming assistant artifacts",
  );
  const projectionThreadId = materialized.projectionThreadIds[0];
  assert.isDefined(projectionThreadId);
  const projection = result.projections.get(projectionThreadId);
  assert.isDefined(projection);
  const latestRun = projection.runs.at(-1);
  assert.deepEqual(latestRun?.modelSelection, input.driver.modelSelection);
  if (projection.runs.some((run) => run.status === "completed")) {
    const threadStartCheckpoint = projection.checkpoints.find(
      (checkpoint) => checkpoint.ordinalWithinScope === 0 && checkpoint.appRunOrdinal === null,
    );
    assert.isDefined(
      threadStartCheckpoint,
      "completed threads must retain an addressable thread-start checkpoint",
    );
    assert.equal(threadStartCheckpoint.status, "ready");
  }
  return result;
});

/** Replays one fixture variant through OrchestratorV2 and runs the shared output checks. */
export function runReplayFixture<
  Transcript extends ProviderReplayTranscript,
  Error,
  WorkspaceError = never,
>(input: ReplayFixtureRun<Transcript, Error, WorkspaceError>) {
  return runFixtureProvider(input).pipe(Effect.mapError(normalizeTestError), Effect.scoped);
}

export function findReplayFixture(name: string) {
  return ORCHESTRATOR_REPLAY_FIXTURES.find((fixture) => fixture.name === name);
}

/**
 * Registers this file's share of `driver`'s recorded fixtures: those whose position among the
 * driver's fixtures leaves `group` when divided by the driver's file count. Call it inside the
 * provider file's `describe`. `run` picks the harness for each variant.
 */
export function itRunsReplayFixtures<E>(
  driver: string,
  run: (input: ReplayFixtureCase) => Effect.Effect<unknown, E>,
  group = 0,
) {
  const files = REPLAY_FIXTURE_FILES[driver]?.files;
  if (files === undefined) {
    throw new Error(`${driver} has no ReplayFixtures test files to run its fixtures from.`);
  }
  if (group >= files) {
    throw new Error(
      `${driver} splits its fixtures over ${files} files, not one numbered ${group}.`,
    );
  }
  it.effect.each(
    ORCHESTRATOR_REPLAY_FIXTURES.flatMap((fixture) =>
      fixture.providers
        .filter((provider) => provider.driver === driver)
        .map((provider) => [fixture.name, provider.driver, fixture, provider] as const),
    ).filter((_, index) => index % files === group),
  )("runs %s/%s through OrchestratorV2 using deterministic replay", ([, , fixture, provider]) =>
    run({ fixtureName: fixture.name, buildInput: fixture.buildInput, driver: provider }),
  );
}

/** Runs one of `driver`'s recorded fixtures through its `harness`, with the shared checks. */
export function replayFixtureRunner<Transcript extends ProviderReplayTranscript, Error>(
  harness: OrchestratorV2ProviderReplayHarness<Transcript, Error>,
) {
  return (input: ReplayFixtureCase) => runReplayFixture({ ...input, harness });
}
