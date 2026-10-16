import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  ProjectId,
  type OrchestrationV2ServerCommand,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2ThreadWorkItem,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as BuildWorkItems from "./BuildWorkItems.ts";
import * as HqAgentConnections from "./HqAgentConnections.ts";
import {
  delegation,
  makeHqHarness,
  origin,
  otherOrigin,
  projectId,
} from "./HqAgentConnections.testkit.ts";

const threadId = ThreadId.make("thread-build");

interface FakeItem {
  id: string;
  number: number;
  kind: string;
  title: string;
  status: string;
  holds: Array<{ kind: string; note: string; clearedAt: string | null }>;
  /** The waits Build derives for it, as `hq_build_waits` returns them. */
  waits: Array<{ required: "landed" | "accepted"; blocker: FakeItem }>;
}

const item = (number: number, kind: string, title: string, status: string): FakeItem => ({
  id: `item-${number}`,
  number,
  kind,
  title,
  status,
  holds: [],
  waits: [],
});

/**
 * BuildWorkItems over the real HqAgentConnections and a fake HQ whose Build answers
 * `hq_build_read` and `hq_build_waits` from `items`, for one thread in a connected project.
 */
const makeHarness = Effect.gen(function* () {
  const harness = yield* makeHqHarness;
  const items = new Map<number, FakeItem>();
  const add = (...added: FakeItem[]) => added.forEach((entry) => items.set(entry.number, entry));
  const byId = (id: unknown) => [...items.values()].find((entry) => entry.id === id);
  harness.hq.tools.call = (name, args) => {
    const found = args.itemId !== undefined ? byId(args.itemId) : items.get(Number(args.number));
    if (found === undefined) return { status: "failed", code: "build_item_unavailable" };
    if (name === "hq_build_read") {
      const { waits: _waits, ...view } = found;
      return { status: "succeeded", value: { ...view, summary: "A body summary", bodySize: 1 } };
    }
    if (name === "hq_build_waits")
      return {
        status: "succeeded",
        value: found.waits.map(({ required, blocker }) => ({
          relationId: `relation-${blocker.number}`,
          required,
          derivedFromTicketId: null,
          blocker: { ...blocker, waits: undefined },
        })),
      };
    return { status: "failed", code: "unknown_tool" };
  };

  const thread = { workItem: null as OrchestrationV2ThreadWorkItem | null };
  const dispatched: Array<OrchestrationV2ServerCommand> = [];
  const threads = Layer.mock(ThreadManagementService.ThreadManagementService)({
    getThreadShell: (id) =>
      Effect.succeed(
        id === threadId
          ? ({
              projectId,
              deletedAt: null,
              workItem: thread.workItem,
            } as OrchestrationV2ThreadShell)
          : null,
      ),
    dispatch: (command) =>
      Effect.sync(() => {
        dispatched.push(command);
        if (command.type === "thread.metadata.update" && command.workItem !== undefined)
          thread.workItem = command.workItem;
        return { sequence: dispatched.length, storedEvents: [] };
      }),
  });
  const service = yield* Effect.service(BuildWorkItems.BuildWorkItems).pipe(
    Effect.provide(
      BuildWorkItems.layer.pipe(
        Layer.provide(
          Layer.mergeAll(
            threads,
            NodeCrypto.layer,
            Layer.succeed(HqAgentConnections.HqAgentConnections, harness.connections),
          ),
        ),
      ),
    ),
  );
  const buildReads = () =>
    harness.hq.toolCalls.filter((call) => call.args.itemId !== undefined).length;
  return { ...harness, service, add, thread, dispatched, buildReads };
});

it.effect("links by URL, #number or number through T3's own observer agent", () =>
  Effect.gen(function* () {
    const { hq, service, add, thread, assertNoSecretsIn } = yield* makeHarness;
    add(item(1_000_078, "spec", "Show the Build item", "in_progress"));
    add(item(1_000_079, "ticket", "Link and header", "ready"));

    const linked = yield* service.link({ threadId, reference: `${origin}/build/1000078` });
    assert.deepStrictEqual(linked.workItem, { itemId: "item-1000078", number: 1_000_078, origin });
    assert.deepStrictEqual(thread.workItem, linked.workItem);
    // One observer for the environment: no thread, no model, and never a provider's agent.
    assert.deepStrictEqual(
      hq.agents.map(({ agentRef, role }) => ({ agentRef, role })),
      [{ agentRef: "environment-hq", role: "observer" }],
    );
    assert.isUndefined(hq.agents[0]!.model);

    yield* service.link({ threadId, reference: "#1000079" });
    assert.strictEqual(thread.workItem?.number, 1_000_079);
    yield* service.link({ threadId, reference: `${origin}/build/specs/1000078` });
    assert.strictEqual(thread.workItem?.number, 1_000_078);
    yield* service.link({ threadId, reference: "1000079" });
    assert.strictEqual(thread.workItem?.number, 1_000_079);
    assert.strictEqual(hq.agents.length, 1);

    yield* service.link({ threadId, reference: null });
    assert.isNull(thread.workItem);
    assert.isNull(yield* service.view(threadId));
    assertNoSecretsIn(linked);
  }),
);

it.effect("refuses another HQ, unknown numbers and items that are not Specs or Tickets", () =>
  Effect.gen(function* () {
    const { service, add, dispatched } = yield* makeHarness;
    add(item(1_000_001, "decision", "Use Build", "accepted"));
    const reason = (reference: string) =>
      service.link({ threadId, reference }).pipe(
        Effect.flip,
        Effect.map((error) => error.reason),
      );
    assert.strictEqual(yield* reason(`${otherOrigin}/build/1000001`), "other_hq");
    assert.strictEqual(yield* reason("#1000404"), "not_found");
    assert.strictEqual(yield* reason("1000001"), "unsupported_kind");
    assert.strictEqual(yield* reason("build-item"), "invalid_reference");
    assert.strictEqual(dispatched.length, 0);
  }),
);

it.effect("reads at once, then re-reads item and waits at most once a minute", () =>
  Effect.gen(function* () {
    const { service, add, buildReads } = yield* makeHarness;
    assert.isTrue((yield* service.connected(projectId)).connected);
    const blocker = item(1_000_077, "spec", "Observer role", "landed");
    const ticket = item(1_000_079, "ticket", "Link and header", "ready");
    ticket.holds.push(
      { kind: "decision", note: "Pick the glyph", clearedAt: null },
      { kind: "external", note: "Old hold", clearedAt: "2026-10-01T00:00:00.000Z" },
    );
    ticket.waits.push({ required: "accepted", blocker });
    add(blocker, ticket);
    yield* service.link({ threadId, reference: "#1000079" });

    const first = yield* service.view(threadId);
    assert.strictEqual(buildReads(), 2);
    assert.deepStrictEqual(first?.item, {
      kind: "ticket",
      title: "Link and header",
      status: "ready",
      holds: [{ kind: "decision", note: "Pick the glyph" }],
      waits: [
        { number: 1_000_077, title: "Observer role", status: "landed", required: "accepted" },
      ],
    });
    assert.strictEqual(first?.url, `${origin}/build/1000079`);
    assert.isFalse(first?.unavailable);
    // The client sees the compact view only, never the body or its summary.
    assert.notInclude(JSON.stringify(first), "A body summary");

    // Accepting the blocker moves only the blocker; the next minute's re-read sees it.
    blocker.status = "accepted";
    ticket.waits.length = 0;
    yield* TestClock.adjust(30_000);
    assert.strictEqual((yield* service.view(threadId))?.item?.waits.length, 1);
    assert.strictEqual(buildReads(), 2);
    yield* TestClock.adjust(30_000);
    assert.strictEqual((yield* service.view(threadId))?.item?.waits.length, 0);
    assert.strictEqual(buildReads(), 4);
  }),
);

it.effect("keeps the last known item when HQ is unreachable or the observer is revoked", () =>
  Effect.gen(function* () {
    const { hq, service, add, assertNoSecretsIn } = yield* makeHarness;
    add(item(1_000_078, "spec", "Show the Build item", "in_progress"));
    yield* service.link({ threadId, reference: "#1000078" });
    const known = yield* service.view(threadId);

    hq.state.unreachable = true;
    yield* TestClock.adjust(60_000);
    const unreachable = yield* service.view(threadId);
    assert.isTrue(unreachable?.unavailable);
    assert.strictEqual(unreachable?.item?.title, "Show the Build item");
    assert.strictEqual(unreachable?.readAt, known?.readAt);

    hq.state.unreachable = false;
    hq.agents.find((agent) => agent.role === "observer")!.revoked = true;
    yield* TestClock.adjust(60_000);
    const revoked = yield* service.view(threadId);
    assert.isTrue(revoked?.unavailable);
    assert.strictEqual(revoked?.item?.status, "in_progress");
    assertNoSecretsIn(unreachable, revoked);
  }),
);

it.effect("with nothing read yet an unreachable item shows only its number", () =>
  Effect.gen(function* () {
    const { hq, service, add, thread } = yield* makeHarness;
    add(item(1_000_078, "spec", "Show the Build item", "in_progress"));
    yield* service.link({ threadId, reference: "#1000078" });
    hq.state.unreachable = true;
    const cold = yield* service.view(threadId);
    assert.deepStrictEqual(
      { number: cold?.number, item: cold?.item, unavailable: cold?.unavailable },
      { number: 1_000_078, item: null, unavailable: true },
    );
    assert.strictEqual(thread.workItem?.number, 1_000_078);
  }),
);

it.effect(
  "a link made against another HQ is unavailable, and a project without HQ shows none",
  () =>
    Effect.gen(function* () {
      const { hq, service, add, connections } = yield* makeHarness;
      add(item(1_000_078, "spec", "Show the Build item", "in_progress"));
      yield* service.link({ threadId, reference: "#1000078" });
      yield* connections.connect({
        projectId,
        origin: otherOrigin,
        delegation: `yshqd_${"e".repeat(43)}`,
      });
      const moved = yield* service.view(threadId);
      assert.isTrue(moved?.unavailable);
      assert.isNull(moved?.item);
      // Replacing the connection ended the observer it used.
      assert.isTrue(hq.agents[0]!.ended);

      yield* connections.disconnect(projectId);
      assert.isNull(yield* service.view(threadId));
      assert.isFalse((yield* service.connected(projectId)).connected);
    }),
);

it.effect("the shared observer ends only when the last project using it disconnects", () =>
  Effect.gen(function* () {
    const { hq, connections } = yield* makeHarness;
    const otherProject = ProjectId.make("project-hq-other");
    yield* connections.connect({ projectId: otherProject, origin, delegation });
    yield* connections.observe(projectId, "hq_build_read", { number: 1 }).pipe(Effect.ignore);
    yield* connections.observe(otherProject, "hq_build_read", { number: 1 }).pipe(Effect.ignore);
    assert.strictEqual(hq.agents.length, 1);

    yield* connections.disconnect(projectId);
    assert.isFalse(hq.agents[0]!.ended);
    yield* connections.observe(otherProject, "hq_build_read", { number: 1 }).pipe(Effect.ignore);
    assert.strictEqual(hq.agents.length, 1);

    yield* connections.disconnect(otherProject);
    assert.isTrue(hq.agents[0]!.ended);
  }),
);
