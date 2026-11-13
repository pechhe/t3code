import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  type OrchestrationV2AppThread,
  type OrchestrationV2ThreadArcRun,
  type OrchestrationV2ThreadShell,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as ForgeArcRuns from "./ForgeArcRuns.ts";
import * as ForgeWorkItems from "./ForgeWorkItems.ts";
import * as WeaveAgentConnections from "./WeaveAgentConnections.ts";
import { makeWeaveHarness, origin } from "./WeaveAgentConnections.testkit.ts";

const threadId = ThreadId.make("arc-lead");
const input = { threadId, arc: 10 };
const makeHarness = Effect.gen(function* () {
  const harness = yield* makeWeaveHarness;
  const state = {
    run: {
      arc: { number: 10 },
      state: "active",
      startedAt: "2026-11-01T00:00:00.000Z",
      progressAt: "2026-11-01T00:00:00.000Z",
      ceilingSince: "2026-11-01T00:00:00.000Z",
    } as OrchestrationV2ThreadArcRun | undefined,
    members: [1, 2, 3],
    failed: new Set<number>(),
    tooLarge: false,
    arcFailed: false,
    failCursor: false,
    unavailableLink: false,
    children: [] as OrchestrationV2AppThread[],
    runs: [] as OrchestrationV2AppThread[],
  };
  const items = new Map(
    [1, 2, 3, 4].map((number) => [
      number,
      {
        id: `spec-${number}`,
        number,
        kind: "spec",
        ref: `T3-${number}`,
        title: `Spec ${number}`,
        status: number === 1 ? "landed" : number === 3 ? "dropped" : "ready",
        holds: [],
      },
    ]),
  );
  harness.weave.tools.call = (tool, args) => {
    const success = (value: unknown) => ({ status: "succeeded", value });
    if (tool === "weave_graph_backlinks") {
      if (state.tooLarge && Number(args.limit) > 7)
        return { status: "failed", code: "mcp_result_too_large" };
      if (state.failCursor && args.cursor !== undefined)
        return { status: "failed", code: "unavailable" };
      const index = args.cursor === undefined ? 0 : Number(args.cursor);
      const number = state.members[index];
      return success({
        links:
          number === undefined
            ? []
            : [
                {
                  node: {
                    available: true,
                    object: "spec",
                    number,
                    node: { id: `spec-${number}`, kind: "record" },
                  },
                },
                {
                  node: {
                    available: true,
                    object: "spec",
                    number,
                    node: { id: `spec-${number}`, kind: "record" },
                  },
                },
                {
                  node: {
                    available: true,
                    object: "ticket",
                    number: 90,
                    node: { id: "ticket", kind: "record" },
                  },
                },
                ...(state.unavailableLink ? [{ node: { available: false } }] : []),
              ],
        cursor: index + 1 < state.members.length ? String(index + 1) : null,
      });
    }
    if (tool === "weave_forge_read" && args.number === 10)
      return state.arcFailed
        ? { status: "failed", code: "unavailable" }
        : success({
            id: "arc-10",
            number: 10,
            title: "The Arc",
            ref: "T3-ARC-10",
            summary: "The goal",
          });
    const found =
      args.number !== undefined
        ? items.get(Number(args.number))
        : [...items.values()].find((item) => item.id === args.itemId);
    if (found === undefined || state.failed.has(found.number))
      return { status: "failed", code: "unavailable" };
    if (tool === "weave_forge_read") return success(found);
    if (tool === "weave_forge_waits") return success([]);
    return { status: "failed", code: "unexpected_tool" };
  };
  const threads = Layer.mock(ThreadManagementService.ThreadManagementService)({
    getThreadShell: () =>
      Effect.succeed({ deletedAt: null, arcRun: state.run } as OrchestrationV2ThreadShell),
  });
  const weave = Layer.succeed(WeaveAgentConnections.WeaveAgentConnections, harness.connections);
  const workItems = ForgeWorkItems.layer.pipe(
    Layer.provide(Layer.mergeAll(threads, weave, NodeCrypto.layer)),
  );
  const projection = Layer.mock(ProjectionStore.ProjectionStoreV2)({
    listArcRunThreads: () => Effect.succeed(state.runs),
    listAppOwnedChildThreadIds: () => Effect.succeed(state.children.map((thread) => thread.id)),
    getThread: (id) => Effect.succeed(state.children.find((thread) => thread.id === id)!),
  });
  const service = yield* Effect.service(ForgeArcRuns.ForgeArcRuns).pipe(
    Effect.provide(
      ForgeArcRuns.layer.pipe(Layer.provide(Layer.mergeAll(threads, weave, workItems, projection))),
    ),
  );
  return { ...harness, service, state, items };
});

it.effect(
  "pages and deduplicates membership, retries smaller pages at the same cursor and counts whole and named runs",
  () =>
    Effect.gen(function* () {
      const { service, state, weave } = yield* makeHarness;
      state.tooLarge = true;
      assert.deepInclude(yield* service.summary(input), { landed: 1, total: 2, complete: true });
      const pages = weave.toolCalls.filter((call) => call.name === "weave_graph_backlinks");
      assert.deepEqual(
        pages.map((call) => [call.args.cursor, call.args.limit]),
        [
          [undefined, 15],
          [undefined, 7],
          ["1", 7],
          ["2", 7],
        ],
      );
      const before = weave.toolCalls.length;
      state.run = { ...state.run!, specs: [2, 3] };
      assert.deepInclude(yield* service.summary(input), { landed: 0, total: 1, complete: true });
      assert.strictEqual(weave.toolCalls.length, before);
      assert.isFalse(
        weave.toolCalls.some((call) =>
          ["weave_forge_sessions", "weave_forge_list", "weave_forge_attempts"].includes(call.name),
        ),
      );
    }),
);

it.effect("reports incomplete membership and failed Spec reads", () =>
  Effect.gen(function* () {
    const { service, state } = yield* makeHarness;
    state.failCursor = true;
    assert.deepInclude(yield* service.summary(input), { complete: false, landed: 1, total: 1 });
    state.failCursor = false;
    state.failed.add(2);
    const detail = yield* service.detail({ ...input, open: "partial" });
    assert.isFalse(detail!.complete);
    assert.deepEqual(
      detail!.specs.map((spec) => spec.number),
      [1, 3],
    );
    state.failed.clear();
    state.unavailableLink = true;
    assert.isFalse((yield* service.detail({ ...input, open: "unavailable-link" }))!.complete);
  }),
);

it.effect("includes planned nonmembers and resolves Spec leads before other runs", () =>
  Effect.gen(function* () {
    const { service, state } = yield* makeHarness;
    state.run = { ...state.run!, plan: [2, 4, 1] };
    state.children = [
      {
        id: ThreadId.make("child"),
        title: "Spec lead",
        deletedAt: null,
        lineage: { parentThreadId: threadId },
        agentTask: { role: "lead" },
        workItem: { itemId: "spec-2", number: 2, origin },
      } as OrchestrationV2AppThread,
    ];
    state.runs = [
      {
        id: ThreadId.make("other"),
        title: "Other run",
        deletedAt: null,
        arcRun: { ...state.run!, specs: [1, 2] } as OrchestrationV2ThreadArcRun,
      } as OrchestrationV2AppThread,
    ];
    const detail = yield* service.detail({ ...input, open: "first" });
    assert.strictEqual(detail!.goal, "The goal");
    assert.deepInclude(
      detail!.specs.find((spec) => spec.number === 4),
      { inArc: false, thread: null },
    );
    assert.deepEqual(detail!.specs.find((spec) => spec.number === 2)!.thread, {
      threadId: "child",
      title: "Spec lead",
      relation: "spec-lead",
    });
    assert.strictEqual(
      detail!.specs.find((spec) => spec.number === 1)!.thread!.relation,
      "other-run",
    );
    state.children = [];
    state.runs[0] = {
      ...state.runs[0]!,
      arcRun: { ...state.run!, specs: undefined },
    } as OrchestrationV2AppThread;
    const whole = yield* service.detail({ ...input, open: "second" });
    assert.strictEqual(
      whole!.specs.find((spec) => spec.number === 4)!.thread!.relation,
      "other-run",
    );
  }),
);

it.effect(
  "reads detail only on request, refreshes a new opening and rate-limits repeated openings",
  () =>
    Effect.gen(function* () {
      const { service, weave, items } = yield* makeHarness;
      assert.strictEqual(weave.toolCalls.length, 0);
      yield* service.summary(input);
      const first = yield* service.detail({ ...input, open: "one" });
      const count = weave.toolCalls.length;
      items.get(2)!.title = "Changed";
      assert.deepEqual(yield* service.detail({ ...input, open: "one" }), first);
      assert.strictEqual(weave.toolCalls.length, count);
      assert.strictEqual(
        (yield* service.detail({ ...input, open: "two" }))!.specs.find((spec) => spec.number === 2)!
          .title,
        "Changed",
      );
      yield* TestClock.adjust(60_000);
      yield* service.detail({ ...input, open: "two" });
      assert.isAbove(weave.toolCalls.length, count);
    }),
);

it.effect("returns null without the matching run or a Weave connection", () =>
  Effect.gen(function* () {
    const { service, state, weave, connections } = yield* makeHarness;
    assert.isNull(yield* service.summary({ ...input, arc: 11 }));
    assert.isNull(yield* service.detail({ ...input, arc: 11, open: "none" }));
    state.run = undefined;
    assert.isNull(yield* service.summary(input));
    assert.strictEqual(weave.toolCalls.length, 0);
    state.run = { arc: { number: 10 } } as OrchestrationV2ThreadArcRun;
    yield* connections.disconnect;
    assert.isNull(yield* service.detail({ ...input, open: "disconnected" }));
  }),
);

it.effect("fails the first detail read when nothing can be read", () =>
  Effect.gen(function* () {
    const { service, state } = yield* makeHarness;
    state.arcFailed = true;
    const result = yield* service.detail({ ...input, open: "failed" }).pipe(Effect.result);
    assert.strictEqual(result._tag, "Failure");
    if (result._tag === "Failure") assert.strictEqual(result.failure.reason, "unavailable");
    assert.isFalse((yield* service.summary(input))!.complete);
  }),
);

it.effect("keeps the last detail visibly incomplete after a later total failure", () =>
  Effect.gen(function* () {
    const { service, state } = yield* makeHarness;
    const first = yield* service.detail({ ...input, open: "first" });
    state.arcFailed = true;
    const failed = yield* service.detail({ ...input, open: "failed" });
    assert.deepEqual(failed, { ...first!, complete: false });
  }),
);
