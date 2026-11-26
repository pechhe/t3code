import type { OrchestrationV2TurnItem, ThreadId } from "@t3tools/contracts";
import { it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import { expect } from "vite-plus/test";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ProjectStore from "../orchestration-v2/ProjectStore.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as BlackholeMemoryStore from "./BlackholeMemoryStore.ts";
import { BlackholeService, layer } from "./BlackholeService.ts";
import { entryIdOf } from "./BlackholeSession.ts";

const at = DateTime.makeUnsafe(Date.UTC(2026, 10, 25, 10));
const item = (id: string, threadId: string, runId: string, text: string) =>
  ({
    id,
    threadId,
    runId,
    nodeId: null,
    providerThreadId: null,
    providerTurnId: null,
    nativeItemRef: null,
    parentItemId: null,
    ordinal: 1,
    status: "completed",
    title: null,
    startedAt: at,
    completedAt: at,
    updatedAt: at,
    type: "user_message",
    text,
    attachments: [],
  }) as unknown as OrchestrationV2TurnItem;

const threads = {
  parent: { id: "parent", forkedFrom: null, lineage: {}, historyOrigin: null },
  fork: {
    id: "fork",
    forkedFrom: { type: "run", threadId: "parent", runId: "parent-run" },
    lineage: {},
    historyOrigin: null,
  },
};
const parentRun = { id: "parent-run", ordinal: 1, status: "completed" };
const parentItem = item("p1", "parent", "parent-run", "Never push to main.");
const forkItem = item("f1", "fork", "fork-run", "Now rename clamp.");
const records = (seq: number, anchorItemId: string) => [
  { seq, anchorItemId, customType: "om.reflections.recorded", data: {}, createdAt: "" },
];

it.effect("gives a fork its parent's history and the memory written at it", () =>
  Effect.gen(function* () {
    const service = yield* BlackholeService;
    const { entries } = yield* service.session("fork" as ThreadId);
    expect(entries.map((entry) => entry.id)).toEqual([
      entryIdOf("p1"),
      `memory-${entryIdOf("parent")}-1`,
      entryIdOf("f1"),
      "memory-1",
    ]);
  }).pipe(
    Effect.provide(
      layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            Layer.mock(ProjectionStore.ProjectionStoreV2)({
              getThreadRecords: ((threadId: keyof typeof threads, fields: ReadonlyArray<string>) =>
                Effect.succeed(
                  fields.includes("turnItems")
                    ? { turnItems: threadId === "parent" ? [parentItem] : [] }
                    : {
                        thread: threads[threadId],
                        runs: threadId === "parent" ? [parentRun] : [],
                        attempts: [],
                      },
                )) as never,
              getTurnStartHistory: () => Effect.succeed([forkItem]),
              getForkSourceRunIds: () => Effect.succeed([parentRun.id] as never),
            }),
            Layer.mock(ProjectStore.ProjectStoreV2)({}),
            ServerSettings.layerTest(),
            Layer.mock(BlackholeMemoryStore.BlackholeMemoryStore)({
              list: (threadId) =>
                Effect.succeed(threadId === "parent" ? records(1, "p1") : records(1, "f1")),
            }),
          ),
        ),
      ),
    ),
  ),
);
