import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
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
  leadThread,
  makeHqHarness,
  origin,
  otherOrigin,
  projectId,
} from "./HqAgentConnections.testkit.ts";

const threadId = ThreadId.make("thread-build");

it.effect.each(["summary", "card"] as const)(
  "%s backs off unchanged reads, resets on changes and observes agent writes",
  (surface) =>
    Effect.gen(function* () {
      const { hq, service, add, connections } = yield* makeHarness;
      const spec = item(1_000_078, "spec", "Stable", "in_progress");
      add(spec);
      yield* service.link({ threadId, reference: "#1000078" });
      const read = () =>
        surface === "summary"
          ? service.view(threadId)
          : service.card({ threadId, itemId: spec.id, open: "same-opening" });
      yield* read();
      for (const minutes of [1, 2, 4, 5, 5]) {
        const before = hq.toolCalls.length;
        for (let minute = 1; minute < minutes; minute++) {
          yield* TestClock.adjust(60_000);
          yield* read();
          assert.strictEqual(hq.toolCalls.length, before);
        }
        yield* TestClock.adjust(60_000);
        yield* read();
        assert.isAbove(hq.toolCalls.length, before);
      }
      spec.title = "Changed elsewhere";
      for (let minute = 1; minute <= 5; minute++) {
        yield* TestClock.adjust(60_000);
        const result = yield* read();
        assert.strictEqual(result?.item?.title, minute === 5 ? spec.title : "Stable");
      }
      // A changed read returns to one minute, even after reaching the cap.
      let before = hq.toolCalls.length;
      yield* TestClock.adjust(60_000);
      yield* read();
      assert.isAbove(hq.toolCalls.length, before);

      spec.status = "landed";
      const agent = yield* connections.connection(leadThread);
      const body = new TextEncoder().encode(
        JSON.stringify({
          jsonrpc: "2.0",
          id: 123,
          method: "tools/call",
          params: {
            name: "hq_build_set_status",
            arguments: { itemId: spec.id, status: "landed" },
          },
        }),
      );
      yield* connections.forward({
        authorization: agent!.authorizationHeader,
        contentType: undefined,
        accept: undefined,
        protocolVersion: undefined,
        body,
      });
      before = hq.toolCalls.length;
      yield* TestClock.adjust(60_000);
      assert.strictEqual((yield* read())?.item?.status, "landed");
      assert.isAbove(hq.toolCalls.length, before);
      // Advancing the clock alone never makes the display cache read HQ.
      before = hq.toolCalls.length;
      yield* TestClock.adjust(60 * 60_000);
      assert.strictEqual(hq.toolCalls.length, before);
    }),
);

interface FakeItem {
  id: string;
  number: number;
  /** The friendly ref; an older HQ, or an older item, has none and the field is absent. */
  ref?: string | null;
  kind: string;
  title: string;
  status: string;
  holds: Array<{ kind: string; note: string; clearedAt: string | null; openedAt?: string }>;
  /** The waits Build derives for it, as `hq_build_waits` returns them. */
  waits: Array<{ required: "landed" | "accepted"; blocker: FakeItem }>;
  parentId?: string;
  governedBy?: Array<{ id: string; number: number; title: string; status: string }>;
  updates?: Array<{ createdAt: string }>;
}

interface FakeSession {
  specId: string;
  parentSessionId: string | null;
  ticketIds: string[];
  harness: string;
  sessionRef: string;
  activity: "active" | "quiet" | "stalled" | "ended";
  currentGeneration: boolean;
  lastActivityAt: string;
  endedAt: string | null;
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

/** The body Build never sends T3: a card carries only the summary. */
const BODY = "The whole Spec body, which T3 never asks for";

/**
 * BuildWorkItems over the real HqAgentConnections and a fake HQ whose Build answers its read
 * tools from `items`, `sessions`, `attempts` and `acceptances`, for one thread in a connected
 * project.
 */
const makeHarness = Effect.gen(function* () {
  const harness = yield* makeHqHarness;
  const items = new Map<number, FakeItem>();
  const sessions: FakeSession[] = [];
  const attempts = new Map<string, unknown[]>();
  const acceptances = new Map<string, { acceptedAt: string }>();
  const add = (...added: FakeItem[]) => added.forEach((entry) => items.set(entry.number, entry));
  const byId = (id: unknown) => [...items.values()].find((entry) => entry.id === id);
  const viewOf = ({ waits: _waits, ...found }: FakeItem) => ({
    ...found,
    holds: found.holds.map((hold) => ({ openedAt: "2026-10-01T00:00:00.000Z", ...hold })),
    parentId: found.parentId ?? null,
    specKind: found.kind === "spec" ? "feature" : null,
    effectiveHorizon: found.kind === "spec" ? "now" : null,
    createdAt: "2026-10-01T00:00:00.000Z",
    updates: found.updates ?? [],
    summary: "A body summary",
    bodySize: 1,
    body: BODY,
  });
  harness.hq.tools.call = (name, args) => {
    if (name === "hq_build_list")
      return {
        status: "succeeded",
        value: [...items.values()]
          .filter((entry) => entry.kind === args.kind && entry.parentId === args.parentId)
          .toSorted((a, b) => a.number - b.number)
          .map(viewOf),
      };
    if (name === "hq_build_sessions")
      return {
        status: "succeeded",
        value: sessions.filter((session) => session.specId === args.specId),
      };
    if (name === "hq_build_acceptance")
      return { status: "succeeded", value: acceptances.get(String(args.specId)) ?? null };
    const found =
      args.itemId !== undefined
        ? byId(args.itemId)
        : args.ref !== undefined
          ? [...items.values()].find((entry) => entry.ref === args.ref)
          : items.get(Number(args.number));
    if (found === undefined) return { status: "failed", code: "build_item_unavailable" };
    if (name === "hq_build_read") return { status: "succeeded", value: viewOf(found) };
    if (name === "hq_build_attempts")
      return { status: "succeeded", value: attempts.get(found.id) ?? [] };
    if (name === "hq_build_waits")
      return {
        status: "succeeded",
        value: found.waits.map(({ required, blocker }) => ({
          relationId: `relation-${blocker.number}`,
          required,
          derivedFromTicketId: null,
          blocker: viewOf(blocker),
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
  return {
    ...harness,
    service,
    add,
    thread,
    dispatched,
    buildReads,
    sessions,
    attempts,
    acceptances,
  };
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

it.effect("links by a friendly ref in any case with hq_build_read {ref}", () =>
  Effect.gen(function* () {
    const { hq, service, add, thread } = yield* makeHarness;
    add({ ...item(1_000_078, "spec", "Show the Build item", "in_progress"), ref: "YS-12" });
    add({ ...item(1_000_079, "ticket", "Link and header", "ready"), ref: "YS-12.1" });

    const resolved = yield* service.resolve("ys-12");
    assert.deepStrictEqual(resolved, { itemId: "item-1000078", number: 1_000_078, origin });
    yield* service.link({ threadId, reference: "YS-12.1" });
    assert.strictEqual(thread.workItem?.number, 1_000_079);
    assert.deepStrictEqual(
      hq.toolCalls.filter((call) => call.name === "hq_build_read").map((call) => call.args),
      [{ ref: "YS-12" }, { ref: "YS-12.1" }],
    );
    const unknown = yield* service.link({ threadId, reference: "YS-99" }).pipe(Effect.flip);
    assert.strictEqual(unknown.reason, "not_found");
    assert.include(unknown.message, "YS-99");
    const malformed = yield* service.link({ threadId, reference: "YS-12.x" }).pipe(Effect.flip);
    assert.strictEqual(malformed.reason, "invalid_reference");
    assert.include(malformed.message, "YS-12");
  }),
);

it.effect("carries an item's ref to its summary, waits and card, and works without one", () =>
  Effect.gen(function* () {
    const { service, add } = yield* makeHarness;
    const blocker = { ...item(1_000_070, "spec", "Earlier", "in_progress"), ref: "YS-9" };
    const spec = { ...item(1_000_078, "spec", "Show the Build item", "in_progress"), ref: "YS-12" };
    add(blocker, spec);
    add({
      ...item(1_000_079, "ticket", "Link and header", "ready"),
      ref: "YS-12.1",
      parentId: spec.id,
      waits: [{ required: "landed", blocker }],
    });
    add({ ...item(1_000_080, "spec", "An older Spec", "accepted") });

    yield* service.link({ threadId, reference: "YS-12.1" });
    const view = yield* service.view(threadId);
    assert.strictEqual(view?.number, 1_000_079);
    assert.strictEqual(view?.item?.ref, "YS-12.1");
    assert.strictEqual(view?.item?.waits[0]?.ref, "YS-9");
    const card = yield* service.card({ threadId, itemId: "item-1000079", open: "a" });
    assert.strictEqual(card?.detail.kind === "ticket" ? card.detail.spec?.ref : null, "YS-12");

    // An older HQ omits the field: the item decodes, with no ref to show.
    yield* service.link({ threadId, reference: "#1000080" });
    const older = yield* service.view(threadId);
    assert.strictEqual(older?.item?.title, "An older Spec");
    assert.notProperty(older?.item ?? {}, "ref");
  }),
);

it.effect("treats an empty ref from HQ as none", () =>
  Effect.gen(function* () {
    const { service, add } = yield* makeHarness;
    add({ ...item(1_000_078, "spec", "Show the Build item", "in_progress"), ref: "" });
    yield* service.link({ threadId, reference: "#1000078" });
    assert.isNull((yield* service.view(threadId))?.item?.ref);
  }),
);

it.effect("a failed re-read keeps the last label", () =>
  Effect.gen(function* () {
    const { hq, service, add } = yield* makeHarness;
    add({ ...item(1_000_078, "spec", "Show the Build item", "in_progress"), ref: "YS-12" });
    yield* service.link({ threadId, reference: "YS-12" });
    assert.strictEqual((yield* service.view(threadId))?.item?.ref, "YS-12");
    hq.state.unreachable = true;
    yield* TestClock.adjust(60_000);
    const kept = yield* service.view(threadId);
    assert.isTrue(kept?.unavailable);
    assert.strictEqual(kept?.item?.ref, "YS-12");
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
    assert.isTrue((yield* service.connected).connected);
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
        origin: otherOrigin,
        delegation: `yshqd_${"e".repeat(43)}`,
      });
      const moved = yield* service.view(threadId);
      assert.isTrue(moved?.unavailable);
      assert.isNull(moved?.item);
      // Replacing the connection ended the observer it used.
      assert.isTrue(hq.agents[0]!.ended);

      yield* connections.disconnect;
      assert.isNull(yield* service.view(threadId));
      assert.isFalse((yield* service.connected).connected);
    }),
);

it.effect("one observer reads for the environment until it disconnects", () =>
  Effect.gen(function* () {
    const { hq, connections } = yield* makeHarness;
    yield* connections.connect({ origin, delegation });
    yield* connections.observe("hq_build_read", { number: 1 }).pipe(Effect.ignore);
    yield* connections.observe("hq_build_read", { number: 1 }).pipe(Effect.ignore);
    assert.strictEqual(hq.agents.length, 1);

    yield* connections.disconnect;
    assert.isTrue(hq.agents[0]!.ended);
  }),
);

const session = (
  overrides: Partial<FakeSession> & Pick<FakeSession, "sessionRef">,
): FakeSession => ({
  specId: "item-1000078",
  parentSessionId: null,
  ticketIds: [],
  harness: "t3",
  activity: "active",
  currentGeneration: true,
  lastActivityAt: "2026-10-16T10:00:00.000Z",
  endedAt: null,
  ...overrides,
});

it.effect("a Spec card shows its summary, Tickets by status, Decisions and current lead", () =>
  Effect.gen(function* () {
    const { service, add, sessions, assertNoSecretsIn } = yield* makeHarness;
    const spec = item(1_000_078, "spec", "Show the Build item", "in_progress");
    spec.holds.push({ kind: "information", note: "Waiting on the glyphs", clearedAt: null });
    spec.governedBy = [
      { id: "item-1000010", number: 1_000_010, title: "Build is the source", status: "accepted" },
    ];
    spec.updates = [{ createdAt: "2026-10-15T09:00:00.000Z" }];
    add(spec);
    const statuses = ["landed", "landed", "in_progress", "ready", "ready", "ready", "dropped"];
    statuses.forEach((status, index) =>
      add({ ...item(1_000_100 + index, "ticket", `Ticket ${index}`, status), parentId: spec.id }),
    );
    sessions.push(
      session({
        sessionRef: "env/old-lead",
        currentGeneration: false,
        endedAt: "2026-10-14T00:00:00.000Z",
        activity: "ended",
      }),
      session({
        sessionRef: "env/lead",
        activity: "quiet",
        lastActivityAt: "2026-10-16T11:00:00.000Z",
      }),
      session({
        sessionRef: "env/helper",
        parentSessionId: "lead",
        lastActivityAt: "2026-10-16T12:00:00.000Z",
      }),
    );

    const card = yield* service.card({ threadId, itemId: spec.id, open: "open-1" });
    assert.strictEqual(card?.url, `${origin}/build/1000078`);
    assert.strictEqual(card?.summary, "A body summary");
    assert.deepStrictEqual(card?.item.holds, [
      { kind: "information", note: "Waiting on the glyphs" },
    ]);
    assert.deepStrictEqual(card?.detail, {
      kind: "spec",
      specKind: "feature",
      horizon: "now",
      ticketCounts: { landed: 2, in_progress: 1, ready: 3, dropped: 1 },
      tickets: statuses.slice(0, 5).map((status, index) => ({
        number: 1_000_100 + index,
        title: `Ticket ${index}`,
        status,
      })),
      acceptedAt: null,
      governedBy: [{ number: 1_000_010, title: "Build is the source", status: "accepted" }],
      lead: {
        harness: "t3",
        sessionRef: "env/lead",
        activity: "quiet",
        lastActivityAt: "2026-10-16T11:00:00.000Z",
      },
    });
    // The lead's activity is the latest change; helpers never stand in for the lead.
    assert.strictEqual(card?.updatedAt, "2026-10-16T11:00:00.000Z");
    assert.notInclude(JSON.stringify(card), BODY);
    assertNoSecretsIn(card);
  }),
);

it.effect(
  "a Ticket card names its Spec, blocker, delivery and worker, falling back to the last ended worker",
  () =>
    Effect.gen(function* () {
      const { service, add, sessions, attempts } = yield* makeHarness;
      const spec = item(1_000_078, "spec", "Show the Build item", "in_progress");
      const blocker = item(1_000_079, "ticket", "Link and header", "in_progress");
      const ticket = { ...item(1_000_080, "ticket", "Cards", "ready"), parentId: spec.id };
      ticket.waits.push({ required: "landed", blocker });
      add(spec, blocker, ticket);
      attempts.set(ticket.id, [
        {
          status: "failed",
          failure: { stage: "verifying", cause: "typecheck failed" },
          events: [{ occurredAt: "2026-10-16T08:00:00.000Z" }],
        },
        { status: "queued", failure: null, events: [{ occurredAt: "2026-10-16T09:00:00.000Z" }] },
      ]);
      sessions.push(
        session({ sessionRef: "env/lead" }),
        session({
          sessionRef: "env/worker-a",
          parentSessionId: "lead",
          ticketIds: [ticket.id],
          activity: "ended",
          endedAt: "2026-10-16T07:00:00.000Z",
          lastActivityAt: "2026-10-16T07:00:00.000Z",
        }),
        session({
          sessionRef: "env/other-ticket",
          parentSessionId: "lead",
          ticketIds: [blocker.id],
        }),
      );

      const card = yield* service.card({ threadId, itemId: ticket.id, open: "open-1" });
      assert.deepStrictEqual(card?.item.waits, [
        { number: 1_000_079, title: "Link and header", status: "in_progress", required: "landed" },
      ]);
      assert.deepStrictEqual(card?.detail, {
        kind: "ticket",
        spec: { number: 1_000_078, title: "Show the Build item", status: "in_progress" },
        attempts: 2,
        latestAttempt: { status: "queued", at: "2026-10-16T09:00:00.000Z" },
        lastFailure: { stage: "verifying", cause: "typecheck failed" },
        worker: {
          harness: "t3",
          sessionRef: "env/worker-a",
          activity: "ended",
          lastActivityAt: "2026-10-16T07:00:00.000Z",
        },
      });
      assert.strictEqual(card?.updatedAt, "2026-10-16T09:00:00.000Z");
    }),
);

it.effect(
  "card sessions stay in the current generation and prefer open activity to ended history",
  () =>
    Effect.gen(function* () {
      const { service, add, sessions } = yield* makeHarness;
      const spec = item(1_000_078, "spec", "Spec", "in_progress");
      const ticket = { ...item(1_000_082, "ticket", "Ticket", "ready"), parentId: spec.id };
      add(spec, ticket);

      for (const parentSessionId of [null, "lead"]) {
        const role = parentSessionId === null ? "lead" : "worker";
        for (const [suffix, lastActivityAt, endedAt, currentGeneration] of [
          ["older-open", "2026-10-16T08:00:00.000Z", null, true],
          ["open", "2026-10-16T09:00:00.000Z", null, true],
          ["older-ended", "2026-10-16T11:00:00.000Z", "2026-10-16T10:00:00.000Z", true],
          ["ended", "2026-10-16T10:00:00.000Z", "2026-10-16T11:00:00.000Z", true],
          ["old-generation", "2026-10-16T12:00:00.000Z", "2026-10-16T12:00:00.000Z", false],
        ] as const) {
          sessions.push(
            session({
              sessionRef: `env/${role}-${suffix}`,
              parentSessionId,
              ticketIds: parentSessionId === null ? [] : [ticket.id],
              lastActivityAt,
              endedAt,
              currentGeneration,
            }),
          );
        }
      }

      const expectSessions = (suffix: string | null, open: string) =>
        Effect.gen(function* () {
          const specCard = yield* service.card({ threadId, itemId: spec.id, open });
          const ticketCard = yield* service.card({ threadId, itemId: ticket.id, open });
          assert.strictEqual(specCard?.detail.kind, "spec");
          assert.strictEqual(ticketCard?.detail.kind, "ticket");
          if (specCard?.detail.kind !== "spec" || ticketCard?.detail.kind !== "ticket") return;
          for (const [role, selected] of [
            ["lead", specCard.detail.lead],
            ["worker", ticketCard.detail.worker],
          ] as const) {
            assert.strictEqual(
              selected?.sessionRef ?? null,
              suffix === null ? null : `env/${role}-${suffix}`,
            );
            if (suffix === "ended") assert.strictEqual(selected?.activity, "ended");
          }
        });

      yield* expectSessions("open", "open-1");
      sessions.splice(0, sessions.length, ...sessions.filter((entry) => entry.endedAt !== null));
      yield* expectSessions("ended", "open-2");
      sessions.splice(0, sessions.length, ...sessions.filter((entry) => !entry.currentGeneration));
      yield* expectSessions(null, "open-3");
    }),
);

it.effect(
  "a card reads at once, re-reads at most once a minute and keeps the last card when HQ fails",
  () =>
    Effect.gen(function* () {
      const { hq, service, add } = yield* makeHarness;
      const spec = item(1_000_078, "spec", "Show the Build item", "in_progress");
      add(spec);
      const calls = () => hq.toolCalls.length;

      const first = yield* service.card({ threadId, itemId: spec.id, open: "open-1" });
      const afterFirst = calls();
      assert.isFalse(first?.unavailable);

      spec.status = "landed";
      yield* TestClock.adjust(30_000);
      assert.strictEqual(
        (yield* service.card({ threadId, itemId: spec.id, open: "open-1" }))?.item.status,
        "in_progress",
      );
      assert.strictEqual(calls(), afterFirst);
      yield* TestClock.adjust(30_000);
      assert.strictEqual(
        (yield* service.card({ threadId, itemId: spec.id, open: "open-1" }))?.item.status,
        "landed",
      );
      assert.isAbove(calls(), afterFirst);

      hq.state.unreachable = true;
      yield* TestClock.adjust(60_000);
      const stale = yield* service.card({ threadId, itemId: spec.id, open: "open-1" });
      assert.isTrue(stale?.unavailable);
      assert.strictEqual(stale?.item.status, "landed");

      const cold = yield* service
        .card({ threadId, itemId: "item-never-read", open: "open-1" })
        .pipe(Effect.flip);
      assert.strictEqual(cold.reason, "unavailable");
    }),
);

it.effect("each opening of a card reads Build at once, and retries a failed first read", () =>
  Effect.gen(function* () {
    const { hq, service, add } = yield* makeHarness;
    const spec = item(1_000_078, "spec", "Show the Build item", "in_progress");
    add(spec);
    const open = (opening: string) => service.card({ threadId, itemId: spec.id, open: opening });

    yield* open("first");
    spec.status = "landed";
    yield* TestClock.adjust(20_000);
    // The same opening polling again waits for the minute; closing and reopening does not.
    assert.strictEqual((yield* open("first"))?.item.status, "in_progress");
    assert.strictEqual((yield* open("second"))?.item.status, "landed");

    const fresh = item(1_000_090, "spec", "Never read", "ready");
    add(fresh);
    hq.state.unreachable = true;
    const failed = yield* service
      .card({ threadId, itemId: fresh.id, open: "third" })
      .pipe(Effect.flip);
    assert.strictEqual(failed.reason, "unavailable");
    hq.state.unreachable = false;
    const retried = yield* service.card({ threadId, itemId: fresh.id, open: "fourth" });
    assert.strictEqual(retried?.item.title, "Never read");
  }),
);

it.effect("keeps the last known state of only the most recently asked-for cards", () =>
  Effect.gen(function* () {
    const { hq, service, add } = yield* makeHarness;
    const specs = Array.from({ length: BuildWorkItems.CARD_CACHE_LIMIT + 1 }, (_, index) =>
      item(1_100_000 + index, "spec", `Spec ${index}`, "ready"),
    );
    add(...specs);
    for (const spec of specs) yield* service.card({ threadId, itemId: spec.id, open: "a" });

    hq.state.unreachable = true;
    const newest = yield* service.card({ threadId, itemId: specs.at(-1)!.id, open: "b" });
    assert.isTrue(newest?.unavailable);
    assert.strictEqual(newest?.item.title, `Spec ${BuildWorkItems.CARD_CACHE_LIMIT}`);
    const evicted = yield* service
      .card({ threadId, itemId: specs[0]!.id, open: "b" })
      .pipe(Effect.flip);
    assert.strictEqual(evicted.reason, "unavailable");
  }),
);

it.effect("reads the items chat mentions by number, leaving out ones Build doesn't know", () =>
  Effect.gen(function* () {
    const { service, add, connections } = yield* makeHarness;
    add(
      item(1_000_078, "spec", "Show the Build item", "in_progress"),
      item(1_000_081, "ticket", "Chat chips", "ready"),
      item(1_000_001, "decision", "Use Build", "accepted"),
    );
    assert.strictEqual((yield* service.connected).origin, origin);

    const { items } = yield* service.mentions({
      threadId,
      numbers: [1_000_081, 1_000_078, 1_000_404, 1_000_001, 1_000_078],
    });
    assert.deepStrictEqual(
      items.map((found) => [found.number, found.itemId, found.item?.title, found.url]),
      [
        [1_000_081, "item-1000081", "Chat chips", `${origin}/build/1000081`],
        [1_000_078, "item-1000078", "Show the Build item", `${origin}/build/1000078`],
      ],
    );
    assert.notInclude(JSON.stringify(items), "A body summary");
    assert.notInclude(JSON.stringify(items), BODY);

    yield* connections.disconnect;
    assert.deepStrictEqual(yield* service.mentions({ threadId, numbers: [1_000_078] }), {
      items: [],
    });
    assert.isNull((yield* service.connected).origin);
  }),
);

it.effect("re-reads mentioned items once a minute, sharing the linked item's reads", () =>
  Effect.gen(function* () {
    const { hq, service, add, buildReads } = yield* makeHarness;
    const spec = item(1_000_078, "spec", "Show the Build item", "in_progress");
    add(spec);
    const numberReads = () => hq.toolCalls.filter((call) => call.args.number !== undefined).length;

    yield* service.mentions({ threadId, numbers: [1_000_078, 1_000_404] });
    assert.deepStrictEqual([numberReads(), buildReads()], [2, 2]);
    // The thread's own link to the same item reads nothing more.
    yield* service.link({ threadId, reference: "#1000078" });
    const linkReads = numberReads();
    assert.strictEqual((yield* service.view(threadId))?.item?.title, "Show the Build item");
    assert.strictEqual(buildReads(), 2);

    // Another chip, or another client, within the minute reads nothing.
    spec.title = "Renamed";
    yield* TestClock.adjust(30_000);
    const repeated = yield* service.mentions({ threadId, numbers: [1_000_078, 1_000_404] });
    assert.strictEqual(repeated.items[0]?.item?.title, "Show the Build item");
    assert.deepStrictEqual([numberReads(), buildReads()], [linkReads, 2]);

    // A minute on, the item is re-read and the unknown number asked once more; a known number
    // stays resolved.
    add(item(1_000_404, "ticket", "Now known", "ready"));
    yield* TestClock.adjust(30_000);
    const fresh = yield* service.mentions({ threadId, numbers: [1_000_078, 1_000_404] });
    assert.deepStrictEqual(
      fresh.items.map((found) => found.item?.title),
      ["Renamed", "Now known"],
    );
    assert.deepStrictEqual([numberReads(), buildReads()], [linkReads + 1, 6]);
  }),
);

it.effect("resolves mentions on the project's current HQ, never by number alone", () =>
  Effect.gen(function* () {
    const { hq, service, add, connections } = yield* makeHarness;
    add(item(1_000_078, "spec", "Show the Build item", "in_progress"));
    const numberReads = () => hq.toolCalls.filter((call) => call.args.number !== undefined).length;
    yield* service.mentions({ threadId, numbers: [1_000_078] });
    yield* connections.connect({
      origin: otherOrigin,
      delegation: `yshqd_${"e".repeat(43)}`,
    });
    const moved = yield* service.mentions({ threadId, numbers: [1_000_078] });
    assert.strictEqual(numberReads(), 2);
    assert.strictEqual(moved.items[0]?.url, `${otherOrigin}/build/1000078`);
  }),
);

it.effect("a mention HQ can't answer is left out without caching it as unknown", () =>
  Effect.gen(function* () {
    const { hq, service, add } = yield* makeHarness;
    add(item(1_000_078, "spec", "Show the Build item", "in_progress"));
    hq.state.unreachable = true;
    // Unreachable is told apart from a number Build doesn't know, which sets no flag.
    assert.deepStrictEqual(yield* service.mentions({ threadId, numbers: [1_000_078] }), {
      items: [],
      unavailable: true,
    });
    hq.state.unreachable = false;
    const { items, unavailable } = yield* service.mentions({
      threadId,
      numbers: [1_000_078, 1_000_404],
    });
    assert.strictEqual(items[0]?.item?.title, "Show the Build item");
    assert.isUndefined(unavailable);
  }),
);

it.effect("a card for a link made against another HQ is unavailable and reads nothing", () =>
  Effect.gen(function* () {
    const { hq, service, add, connections } = yield* makeHarness;
    const spec = item(1_000_078, "spec", "Show the Build item", "in_progress");
    const mentioned = item(1_000_081, "ticket", "Chat chips", "ready");
    add(spec, mentioned);
    yield* service.link({ threadId, reference: "#1000078" });
    yield* connections.connect({
      origin: otherOrigin,
      delegation: `yshqd_${"e".repeat(43)}`,
    });
    const reads = hq.toolCalls.length;
    const failed = yield* service.card({ threadId, itemId: spec.id, open: "a" }).pipe(Effect.flip);
    assert.strictEqual(failed.reason, "unavailable");
    assert.strictEqual(hq.toolCalls.length, reads);
    // A mention's card keeps reading the project's current HQ.
    const card = yield* service.card({ threadId, itemId: mentioned.id, open: "b" });
    assert.strictEqual(card?.item.title, "Chat chips");
  }),
);
