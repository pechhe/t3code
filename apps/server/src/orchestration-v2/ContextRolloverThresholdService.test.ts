import { assert, it } from "@effect/vitest";
import {
  type ExperimentAssignment,
  type OrchestrationV2AppThread,
  type OrchestrationV2RolloverHold,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ExperimentService from "../experiments/ExperimentService.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as ThresholdService from "./ContextRolloverThresholdService.ts";
import * as ThreadManagement from "./ThreadManagementService.ts";

const threadId = ThreadId.make("thread:rollover-thresholds");
const instanceId = ProviderInstanceId.make("codex");

const makeThread = (rolloverHold: OrchestrationV2RolloverHold | null) =>
  Effect.map(DateTime.now, (now): OrchestrationV2AppThread => ({
    id: threadId,
    projectId: ProjectId.make("project:rollover-thresholds"),
    title: "Rollover thresholds",
    providerInstanceId: instanceId,
    modelSelection: { instanceId, model: "gpt-6" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: threadId },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
    rolloverHold,
  }));

const read = (
  input: { readonly model: string; readonly maxTokens: number | null },
  options: {
    readonly hold?: OrchestrationV2RolloverHold;
    readonly assignment?: ExperimentAssignment;
  } = {},
) =>
  Effect.gen(function* () {
    const service = yield* ThresholdService.ContextRolloverThresholdService;
    return yield* service.read({ threadId, ...input });
  }).pipe(
    Effect.provide(
      ThresholdService.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            ServerSettings.layerTest({
              contextRollover: {
                enabled: true,
                softThreshold: 220_000,
                hardThreshold: 280_000,
                modelRules: [
                  {
                    modelPattern: "haiku",
                    enabled: true,
                    softThreshold: 80_000,
                    hardThreshold: 90_000,
                  },
                ],
              },
            }).pipe(Layer.orDie),
            Layer.mock(ExperimentService.ExperimentService)({
              getRolloverAssignment: () => Effect.succeed(options.assignment ?? null),
            }),
            Layer.unwrap(
              Effect.map(makeThread(options.hold ?? null), (thread) =>
                Layer.mock(ThreadManagement.ThreadManagementService)({
                  // The service reads only the thread record; the generic field-picked shape
                  // is not worth rebuilding in a mock.
                  getThreadRecords: () => Effect.succeed({ thread } as never),
                }),
              ),
            ),
          ),
        ),
      ),
    ),
  );

it.effect("reads the configured thresholds, or a model rule's", () =>
  Effect.gen(function* () {
    assert.deepStrictEqual(yield* read({ model: "gpt-6", maxTokens: null }), {
      soft: 220_000,
      hard: 280_000,
    });
    assert.deepStrictEqual(yield* read({ model: "claude-haiku-5-5", maxTokens: null }), {
      soft: 80_000,
      hard: 90_000,
    });
  }),
);

it.effect("keeps the hard threshold room below the provider's context window", () =>
  Effect.gen(function* () {
    // 200k window: 20k is reserved for writing the note, and soft sits at 80% of the rest.
    assert.deepStrictEqual(yield* read({ model: "gpt-6", maxTokens: 200_000 }), {
      soft: 144_000,
      hard: 180_000,
    });
  }),
);

it.effect("reports no thresholds while the thread's rollover is held", () =>
  Effect.gen(function* () {
    assert.strictEqual(
      yield* read({ model: "gpt-6", maxTokens: null }, { hold: { kind: "off" } }),
      null,
    );
  }),
);
