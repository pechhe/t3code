import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Logger from "effect/Logger";
import * as Option from "effect/Option";
import * as TestClock from "effect/testing/TestClock";

import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ForgeSpecOfThread from "./ForgeSpecOfThread.ts";
import * as HqAgentConnections from "./HqAgentConnections.ts";
import {
  delegation,
  leadThread,
  makeHqHarness,
  origin,
  otherDelegation,
  otherOrigin,
} from "./HqAgentConnections.testkit.ts";
import * as HqForgeRecords from "./HqForgeRecords.ts";
import * as HqForgeUsage from "./HqForgeUsage.ts";

const unlinkedThread = ThreadId.make("thread-without-build-link");
const tokens = { input: 1_200, output: 300, cacheRead: 4_000, cacheWrite: 500 };

/**
 * The queue over a real database and Weave's fake. A test drives the queue's pass itself, so
 * nothing depends on when its worker happens to wake.
 */
const harness = Effect.gen(function* () {
  const { hq, connections } = yield* makeHqHarness;
  const database = yield* Layer.build(SqlitePersistence.layerMemory);
  /** A read of the linked item that a test turns into an outage, as Weave being down would. */
  const specReads = { unavailable: false };
  // Only a thread with a Forge link records anything.
  const specs = Layer.succeed(ForgeSpecOfThread.ForgeSpecOfThread, {
    of: (threadId: ThreadId) =>
      threadId === leadThread
        ? specReads.unavailable
          ? Effect.fail(new ForgeSpecOfThread.BuildSpecUnavailable({ threadId, origin }))
          : Effect.succeed(
              Option.some({ specId: "spec-1", origin, project: null, leadThreadId: leadThread }),
            )
        : Effect.succeed(Option.none()),
  });
  const recordsLayer = HqForgeRecords.layer.pipe(
    Layer.provide(specs),
    Layer.provide(Layer.succeed(HqAgentConnections.HqAgentConnections, connections)),
    Layer.provide(
      Layer.mock(ProjectionStore.ProjectionStoreV2)({
        // A thread's own projection says which agent its rows act as, as a turn reads it.
        getThread: (threadId: ThreadId) =>
          Effect.succeed({
            id: threadId,
            lineage: { parentThreadId: null },
            modelSelection: { model: "claude-opus-5-5" },
          } as never),
      }),
    ),
    Layer.provide(
      Layer.succeed(
        ServerEnvironment.ServerEnvironment,
        ServerEnvironment.ServerEnvironment.of({
          getEnvironmentId: Effect.succeed(EnvironmentId.make("environment-hq")),
        } as ServerEnvironment.ServerEnvironment["Service"]),
      ),
    ),
    Layer.provide(Layer.succeedContext(database)),
  );
  const usageLayer = HqForgeUsage.layer.pipe(
    Layer.provide(recordsLayer),
    Layer.provide(specs),
    Layer.provide(NodeCrypto.layer),
  );
  const bootUsage = Effect.gen(function* () {
    return yield* HqForgeUsage.HqForgeUsage;
  }).pipe(Effect.provide(usageLayer));
  const bootRecords = Effect.service(HqForgeRecords.HqForgeRecords).pipe(
    Effect.provide(recordsLayer),
  );
  return { hq, connections, bootUsage, bootRecords, specReads };
});

const usageRequest = (overrides?: Partial<HqForgeUsage.HqForgeUsageInput>) =>
  ({
    threadId: leadThread,
    usageRef: "claude:provider-thread-1:msg-1",
    tokens,
    startedAt: 1_000,
    endedAt: 2_000,
    modelRef: "claude-opus-5-5",
    runId: "run-1",
    level: "request",
    ...overrides,
  }) satisfies HqForgeUsage.HqForgeUsageInput;

/** The session a lead's own link opened, which is what Weave attributes its turns to. */
const openLeadSession = (records: HqForgeRecords.HqForgeRecords["Service"]) =>
  records.enqueue({
    kind: "session",
    recordKey: `session:${leadThread}:spec-1`,
    threadId: leadThread,
    specId: "spec-1",
    origin,
    bind: { specId: "spec-1" },
    startSession: { specId: "spec-1", modelRef: "claude-opus-5-5" },
  });

it.effect("a usage reference too long for Weave is bounded and stays distinct per request", () =>
  Effect.gen(function* () {
    const { hq, bootUsage, bootRecords } = yield* harness;
    const usage = yield* bootUsage;
    const records = yield* bootRecords;
    hq.tools.call = (name) =>
      name === "weave_forge_start_session"
        ? { status: "succeeded", value: { session: { id: "session-1" } } }
        : { status: "succeeded", value: {} };
    yield* openLeadSession(records);
    yield* records.deliverDue;
    const longRef = `claude:${"x".repeat(600)}`;

    yield* usage.record(usageRequest({ usageRef: `${longRef}:1` }));
    yield* usage.record(usageRequest({ usageRef: `${longRef}:2` }));
    yield* records.deliverDue;

    const refs = hq.toolCalls
      .filter(({ name }) => name === "weave_forge_record_usage")
      .map(({ args }) => String(args.usageRef));
    assert.lengthOf(refs, 2);
    assert.isTrue(refs.every((ref) => ref.length <= 500));
    assert.notStrictEqual(refs[0], refs[1]);
    assert.isTrue(refs.every((ref) => ref.startsWith("claude:xxx")));
  }),
);

it.effect("records what a linked thread's request spent, as Weave's usage tool takes it", () =>
  Effect.gen(function* () {
    const { hq, bootUsage, bootRecords } = yield* harness;
    const usage = yield* bootUsage;
    const records = yield* bootRecords;
    hq.tools.call = (name) =>
      name === "weave_forge_start_session"
        ? { status: "succeeded", value: { session: { id: "session-1" } } }
        : { status: "succeeded", value: {} };
    yield* openLeadSession(records);
    yield* records.deliverDue;

    yield* usage.record(usageRequest());

    assert.deepStrictEqual(
      (yield* records.outstanding()).map((record) => [
        record.recordKey,
        record.kind,
        record.specId,
      ]),
      [["usage:claude:provider-thread-1:msg-1", "usage", "spec-1"]],
    );

    yield* records.deliverDue;

    assert.deepStrictEqual(hq.toolCalls, [
      {
        name: "weave_forge_bind",
        args: { specId: "spec-1" },
        agentId: "agent-1",
      },
      {
        name: "weave_forge_start_session",
        args: {
          specId: "spec-1",
          modelRef: "claude-opus-5-5",
          sessionRef: "environment-hq/thread-lead",
        },
        agentId: "agent-1",
      },
      {
        name: "weave_forge_record_usage",
        args: {
          usageRef: "claude:provider-thread-1:msg-1",
          scope: "own",
          evidenceRef: `t3-thread://v1/${leadThread}#request`,
          startedAt: "1970-01-01T00:00:01.000Z",
          endedAt: "1970-01-01T00:00:02.000Z",
          tokens,
          activeMs: 1_000,
          modelRef: "claude-opus-5-5",
          sessionId: "session-1",
        },
        agentId: "agent-1",
      },
    ]);
  }),
);

it.effect("sends a cache write of zero when the provider reported none", () =>
  Effect.gen(function* () {
    const { hq, bootUsage, bootRecords } = yield* harness;
    const usage = yield* bootUsage;
    const records = yield* bootRecords;
    hq.tools.call = (name) =>
      name === "weave_forge_start_session"
        ? { status: "succeeded", value: { session: { id: "session-1" } } }
        : { status: "succeeded", value: {} };
    yield* openLeadSession(records);
    yield* records.deliverDue;

    yield* usage.record(usageRequest({ tokens: { input: 10, output: 5, cacheRead: 0 } }));
    yield* records.deliverDue;

    const sent = hq.toolCalls.find(({ name }) => name === "weave_forge_record_usage");
    assert.deepStrictEqual(sent?.args.tokens, {
      input: 10,
      output: 5,
      cacheRead: 0,
      cacheWrite: 0,
    });
  }),
);

it.effect("names the session its thread recorded, never a T3 run id, and waits for it", () =>
  Effect.gen(function* () {
    const { hq, bootUsage, bootRecords } = yield* harness;
    const usage = yield* bootUsage;
    const records = yield* bootRecords;
    hq.tools.call = (name) =>
      name === "weave_forge_start_session"
        ? { status: "succeeded", value: { session: { id: "session-1" } } }
        : { status: "succeeded", value: {} };

    yield* usage.record(usageRequest());
    yield* records.deliverDue;

    // Nothing has named a session yet, so there is nothing Weave could attribute the turn to.
    assert.deepStrictEqual(hq.toolCalls, []);
    assert.strictEqual(
      (yield* records.outstanding()).find((record) => record.kind === "usage")?.status,
      "pending",
    );

    yield* openLeadSession(records);
    yield* records.deliverDue;

    const sent = hq.toolCalls.find(({ name }) => name === "weave_forge_record_usage");
    assert.strictEqual(sent?.args.sessionId, "session-1");
    // A T3 run id means nothing to Weave: the run id it knows is a Forge run's.
    assert.isUndefined(sent?.args.runId);
  }),
);

it.effect(
  "a usage row queued for one Weave is never sent to another when its Spec was unreadable",
  () =>
    Effect.gen(function* () {
      const { hq, connections, bootUsage, bootRecords, specReads } = yield* harness;
      const usage = yield* bootUsage;
      const records = yield* bootRecords;
      hq.tools.call = (name) =>
        name === "weave_forge_start_session"
          ? { status: "succeeded", value: { session: { id: "session-1" } } }
          : { status: "succeeded", value: {} };
      yield* openLeadSession(records);
      yield* records.deliverDue;

      // The link is there, but Weave cannot be read for its item when the turn reports.
      specReads.unavailable = true;
      yield* usage.record(usageRequest());
      const [queued] = yield* records.outstanding();
      // Which Weave the row belongs to is known from the link itself, without reading the item.
      assert.strictEqual(queued?.origin, origin);
      assert.isNull(queued?.specId ?? null);

      // T3 moves to another Weave: the row must wait rather than be recorded there.
      specReads.unavailable = false;
      yield* connections.connect({ origin: otherOrigin, delegation: otherDelegation });
      yield* records.deliverDue;
      assert.deepStrictEqual(
        hq.toolCalls.map(({ name }) => name),
        ["weave_forge_bind", "weave_forge_start_session"],
      );
      assert.strictEqual((yield* records.outstanding())[0]?.status, "pending");

      // Back on its own Weave, its item reads and the turn is recorded where it belongs.
      yield* connections.connect({ origin, delegation });
      yield* TestClock.adjust(Duration.millis(1_000));
      yield* records.deliverDue;
      assert.strictEqual(
        hq.toolCalls.find(({ name }) => name === "weave_forge_record_usage")?.args.sessionId,
        "session-1",
      );
      assert.deepStrictEqual(yield* records.outstanding(), []);
    }),
);

it.effect("records nothing for a thread that counts toward no Spec", () =>
  Effect.gen(function* () {
    const { bootUsage, bootRecords } = yield* harness;
    const usage = yield* bootUsage;
    const records = yield* bootRecords;

    yield* usage.record(usageRequest({ threadId: unlinkedThread }));

    assert.deepStrictEqual(yield* records.outstanding(), []);
  }),
);

it.effect("records nothing when the usage is unknown, rather than a free request", () =>
  Effect.gen(function* () {
    const { bootUsage, bootRecords } = yield* harness;
    const usage = yield* bootUsage;
    const records = yield* bootRecords;

    yield* usage.record(usageRequest({ tokens: null }));

    assert.deepStrictEqual(yield* records.outstanding(), []);
  }),
);

it.effect("stores a repeated usageRef once", () =>
  Effect.gen(function* () {
    const { bootUsage, bootRecords } = yield* harness;
    const usage = yield* bootUsage;
    const records = yield* bootRecords;

    yield* usage.record(usageRequest());
    // A replay of the same request reports the same usage under the same ref.
    yield* usage.record(usageRequest({ endedAt: 3_000 }));

    assert.deepStrictEqual(
      (yield* records.outstanding()).map((record) => record.recordKey),
      ["usage:claude:provider-thread-1:msg-1"],
    );
  }),
);

it.effect("the default recorder says once that a turn's usage was dropped", () =>
  Effect.gen(function* () {
    const messages: Array<unknown> = [];
    const logger = Logger.make(({ message }) => void messages.push(message));
    const defaultUsage = yield* HqForgeUsage.HqForgeUsage;

    yield* Effect.all([
      defaultUsage.record(usageRequest()),
      defaultUsage.record(usageRequest()),
      defaultUsage.record(usageRequest({ tokens: null })),
    ]).pipe(Effect.provide(Logger.layer([logger])));

    assert.lengthOf(messages, 1);
  }),
);
