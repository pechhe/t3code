import type { SessionEntry } from "@t3tools/blackhole";
import { RunId, TextGenerationError, ThreadId } from "@t3tools/contracts";
import { it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { expect, vi } from "vite-plus/test";

import * as Orchestrator from "../orchestration-v2/Orchestrator.ts";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as TextGeneration from "../textGeneration/TextGeneration.ts";
import * as IdAllocator from "@t3tools/provider-core/server/IdAllocator";
import * as EventSink from "../orchestration-v2/EventSink.ts";
import * as BlackholeMemoryStore from "./BlackholeMemoryStore.ts";
import * as BlackholeStatusBoard from "./BlackholeStatusBoard.ts";
import { BlackholeService } from "./BlackholeService.ts";
import * as BlackholeTriggerService from "./BlackholeTriggerService.ts";

const threadId = ThreadId.make("thread-1");
const runId = RunId.make("run-1");
const window = 200_000;

// Enough conversation for Blackhole's observer (15k tokens) to be due.
const session: SessionEntry[] = [
  {
    type: "message",
    id: "u1",
    timestamp: "2026-11-25T10:00:00.000Z",
    message: {
      role: "user",
      content: [{ type: "text", text: "Ship the billing fix to staging only." }],
      timestamp: 0,
    },
  },
  {
    type: "message",
    id: "a1",
    timestamp: "2026-11-25T10:01:00.000Z",
    message: {
      role: "assistant",
      content: [
        { type: "text", text: "Deployed billing release r-512 to staging. ".repeat(1_600) },
      ],
      timestamp: 0,
    },
  },
];

function harness(input: {
  readonly usedTokens: number;
  readonly text?: string;
  readonly memory?: boolean;
  readonly workerFails?: boolean;
}) {
  const dispatch = vi.fn(() => Effect.succeed({} as never));
  const append = vi.fn<BlackholeMemoryStore.BlackholeMemoryStore["Service"]["append"]>(
    () => Effect.void,
  );
  const written: Array<{ readonly events: ReadonlyArray<{ readonly payload: unknown }> }> = [];
  const generateBlackholeMemory = vi.fn(() =>
    input.workerFails
      ? Effect.fail(
          new TextGenerationError({
            operation: "generateBlackholeMemory",
            detail: "Pi returned invalid structured output.",
          }),
        )
      : Effect.succeed({
          observations: [
            {
              content: "Billing release r-512 is on staging.",
              relevance: "high" as const,
              sourceEntryIds: ["a1"],
              supersedes: [],
            },
          ],
          complete: true,
        }),
  );
  const layer = Layer.mergeAll(
    Layer.mock(Orchestrator.OrchestratorV2)({ dispatch }),
    Layer.mock(ProjectionStore.ProjectionStoreV2)({
      getThread: () =>
        Effect.succeed({
          id: threadId,
          projectId: "project-1",
          deletedAt: null,
          compactAt: null,
          lineage: { relationshipToParent: null },
          activeProviderThreadId: "provider-thread-1",
          modelSelection: { instanceId: "codex", model: "gpt-6" },
        } as never),
      getThreadRecords: ((_thread: ThreadId, fields: ReadonlyArray<string>) =>
        Effect.succeed(
          fields.includes("providerSessions")
            ? {
                providerThreads: [
                  {
                    id: "provider-thread-1",
                    providerSessionId: "session-1",
                    contextUsage: { usedTokens: input.usedTokens, maxTokens: window },
                  },
                ],
                providerSessions: [
                  { id: "session-1", driver: "codex", providerInstanceId: "codex" },
                ],
              }
            : fields.includes("providerTurns")
              ? {
                  providerTurns: [
                    {
                      tokenUsage: {
                        usedTokens: input.usedTokens,
                        maxTokens: window,
                        updatedAt: "2026-11-25T10:02:00.000Z",
                      },
                    },
                  ],
                }
              : ({
                  runs: [
                    {
                      id: runId,
                      status: "completed",
                      activeAttemptId: "attempt-1",
                      userMessageId: "message-1",
                      modelSelection: { instanceId: "codex", model: "gpt-6" },
                    },
                  ],
                  messages: [{ id: "message-1", text: input.text ?? "Ship it" }],
                } as never),
        )) as never,
    }),
    ServerSettings.layerTest({
      blackhole: { compaction: true, memory: input.memory ?? true, memoryOffDrivers: [] },
    }),
    Layer.mock(BlackholeService)({
      settingsFor: () =>
        Effect.succeed({
          blackhole: { compaction: true, memory: input.memory ?? true, memoryOffDrivers: [] },
          driver: "codex",
        }),
      session: () => Effect.succeed({ entries: session, lastItemId: "item-a1" }),
      cwdOf: () => Effect.succeed("/repo"),
    }),
    Layer.mock(TextGeneration.TextGeneration)({ generateBlackholeMemory }),
    Layer.mock(BlackholeMemoryStore.BlackholeMemoryStore)({ append }),
    BlackholeStatusBoard.layer,
    Layer.mock(EventSink.EventSinkV2)({
      write: (batch) => {
        written.push(batch as never);
        return Effect.succeed([]);
      },
    }),
    IdAllocator.layer,
  );
  const use = <A, E>(
    body: (service: Effect.Success<typeof BlackholeTriggerService.make>) => Effect.Effect<A, E>,
  ) =>
    BlackholeTriggerService.make.pipe(Effect.flatMap(body), Effect.scoped, Effect.provide(layer));
  const run = use((service) => service.afterRun(threadId, runId));
  const statusTexts = () =>
    written
      .flatMap((batch) =>
        batch.events.flatMap(
          (event) =>
            (event.payload as { extensionStatuses?: ReadonlyArray<{ text: string }> })
              .extensionStatuses ?? [],
        ),
      )
      .map((status) => status.text);
  return { run, use, dispatch, append, generateBlackholeMemory, statusTexts };
}

it.effect("queues /compact behind any work once a run's context crosses the point", () =>
  Effect.gen(function* () {
    // pi-blackhole's default curve puts a 200k window's point near 149k.
    const crossed = harness({ usedTokens: 160_000, memory: false });
    yield* crossed.run;
    expect(crossed.dispatch).toHaveBeenCalledWith(
      expect.objectContaining({
        text: "/compact",
        threadId,
        dispatchMode: { type: "queue_after_active" },
      }),
    );

    const below = harness({ usedTokens: 100_000, memory: false });
    yield* below.run;
    expect(below.dispatch).not.toHaveBeenCalled();
  }),
);

it.effect("never compacts a compaction", () =>
  Effect.gen(function* () {
    const compaction = harness({ usedTokens: 190_000, text: "/compact", memory: false });
    yield* compaction.run;
    expect(compaction.dispatch).not.toHaveBeenCalled();
  }),
);

it.effect("records the Utility model's observations after the item they were written at", () =>
  Effect.gen(function* () {
    const remembering = harness({ usedTokens: 10_000 });
    yield* remembering.use((service) => service.rememberNow(threadId));
    expect(remembering.generateBlackholeMemory).toHaveBeenCalledWith(
      expect.objectContaining({ stage: "observer", modelSelection: expect.anything() }),
    );
    expect(remembering.append).toHaveBeenCalledWith(
      expect.objectContaining({
        threadId,
        anchorItemId: "item-a1",
        records: [
          expect.objectContaining({
            customType: "om.observations.recorded",
            data: expect.objectContaining({ coversUpToId: "a1" }),
          }),
        ],
      }),
    );
  }),
);

it.effect("runs no memory workers when memory is off, and still compacts", () =>
  Effect.gen(function* () {
    const off = harness({ usedTokens: 160_000, memory: false });
    yield* off.run;
    expect(off.generateBlackholeMemory).not.toHaveBeenCalled();
    expect(off.dispatch).toHaveBeenCalled();
  }),
);

it.effect("clears the worker's running marker when the Utility model's reply fails", () =>
  Effect.gen(function* () {
    const failing = harness({ usedTokens: 10_000, workerFails: true });
    yield* failing.use((service) => service.rememberNow(threadId));
    expect(failing.append).not.toHaveBeenCalled();
    const texts = failing.statusTexts();
    expect(texts[0]).toContain("[observer]");
    expect(texts.at(-1)).not.toContain("[observer]");
  }),
);
