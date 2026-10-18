import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, it } from "@effect/vitest";
import {
  NodeId,
  type OrchestrationV2ServerCommand,
  type OrchestratorMcpRequestReleaseApprovalInput,
  ProjectId,
  RunId,
  ThreadId,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as ThreadManagementService from "../orchestration-v2/ThreadManagementService.ts";
import * as SqlitePersistence from "../persistence/Sqlite.ts";
import * as ReleaseApprovals from "./ReleaseApprovals.ts";

const projectId = ProjectId.make("project-release");
const candidateA = "a".repeat(40);
const candidateB = "b".repeat(40);

const requester = (name: string) => ({
  threadId: ThreadId.make(`thread-${name}`),
  runId: RunId.make(`run-${name}`),
  nodeId: NodeId.make(`node-${name}`),
});
const lead = requester("lead");
const other = requester("other");

const ask = (candidate: string): OrchestratorMcpRequestReleaseApprovalInput => ({
  repository: "pechhe/yardsmith",
  candidate,
  base: "c".repeat(40),
  summary: {
    commits: 3,
    items: [{ ref: "#2446", title: "Release approvals", partialBuild: false }],
    migrations: [{ name: "0042_drop_column", nonAdditive: true }],
    verification: { status: "passed" },
    coveredByEarlierApproval: false,
  },
  details: "Promotes three commits.",
});

type Sent = ThreadManagementService.ThreadManagementSendInput;

const withService = <A, E>(
  body: (input: {
    readonly service: ReleaseApprovals.ReleaseApprovals["Service"];
    readonly records: Array<
      Extract<OrchestrationV2ServerCommand, { type: "release_approval.record" }>
    >;
    readonly sent: Array<Sent>;
  }) => Effect.Effect<A, E>,
  options: {
    readonly archived?: ReadonlySet<ThreadId>;
    readonly failCardWrites?: (command: { readonly threadId: ThreadId }) => boolean;
  } = {},
) =>
  Effect.gen(function* () {
    const records: Array<
      Extract<OrchestrationV2ServerCommand, { type: "release_approval.record" }>
    > = [];
    const sent: Array<Sent> = [];
    // Like command receipts: a command id that already succeeded does nothing again.
    const receipts = new Set<string>();
    const threadManagement = Layer.mock(ThreadManagementService.ThreadManagementService)({
      dispatch: (command) =>
        command.type === "release_approval.record" && options.failCardWrites?.(command)
          ? Effect.fail(new Error("thread unavailable") as never)
          : Effect.sync(() => {
              if (receipts.has(command.commandId)) return {} as never;
              receipts.add(command.commandId);
              if (command.type === "release_approval.record") records.push(command);
              return {} as never;
            }),
      getThreadShell: (threadId) =>
        Effect.succeed({
          projectId,
          archivedAt: options.archived?.has(threadId) ? "2026-10-18T12:00:00.000Z" : null,
        } as never),
      sendToThread: (input) =>
        Effect.sync(() => {
          if (!receipts.has(input.commandId)) {
            receipts.add(input.commandId);
            sent.push(input);
          }
          return {} as never;
        }),
    });
    return yield* Effect.gen(function* () {
      const service = yield* ReleaseApprovals.ReleaseApprovals;
      return yield* body({ service, records, sent });
    }).pipe(
      Effect.provide(
        ReleaseApprovals.layer.pipe(
          Layer.provide(
            Layer.mergeAll(threadManagement, NodeCrypto.layer, SqlitePersistence.layerMemory),
          ),
        ),
      ),
    );
  });

it.effect("opens one card per repository, and a second thread joins it", () =>
  withService(({ service, records }) =>
    Effect.gen(function* () {
      const first = yield* service.request(lead, ask(candidateA));
      assert.strictEqual(first.status, "pending");
      assert.isFalse(first.joined);
      assert.deepStrictEqual(
        records.map((record) => [record.threadId, record.approvalStatus]),
        [[lead.threadId, "pending"]],
      );

      records.length = 0;
      const joined = yield* service.request(other, ask(candidateA));
      assert.strictEqual(joined.requestId, first.requestId);
      assert.isTrue(joined.joined);
      // Both threads show the same card; asking again never opens a second one.
      assert.deepStrictEqual(
        records.map((record) => [record.threadId, record.approvalId]).toSorted(),
        [
          [lead.threadId, first.requestId],
          [other.threadId, first.requestId],
        ].toSorted(),
      );
      const again = yield* service.request(lead, ask(candidateA));
      assert.strictEqual(again.requestId, first.requestId);
    }),
  ),
);

it.effect("delivers one answer to every requesting thread and keeps an approval", () =>
  withService(({ service, records, sent }) =>
    Effect.gen(function* () {
      const card = yield* service.request(lead, ask(candidateA));
      yield* service.request(other, ask(candidateA));
      records.length = 0;

      yield* service.answer({
        approvalId: card.requestId,
        candidate: candidateA,
        decision: "approved",
        note: "  Ship it  ",
        answeredBy: "henry",
      });

      assert.deepStrictEqual(
        records.map((record) => [record.threadId, record.approvalStatus]).toSorted(),
        [
          [lead.threadId, "approved"],
          [other.threadId, "approved"],
        ].toSorted(),
      );
      assert.deepStrictEqual(
        sent.map((message) => message.threadId).toSorted(),
        [lead.threadId, other.threadId].toSorted(),
      );
      for (const message of sent) {
        assert.strictEqual(message.createdBy, "user");
        assert.strictEqual(message.mode, "queue");
        assert.include(message.text, "approved");
        assert.include(message.text, candidateA);
        assert.include(message.text, "Note: Ship it");
        assert.include(message.text, "Answered by henry");
      }

      const twice = yield* Effect.flip(
        service.answer({
          approvalId: card.requestId,
          candidate: candidateA,
          decision: "declined",
          answeredBy: "henry",
        }),
      );
      assert.strictEqual(twice.reason, "already_answered");

      // The approval stands for exactly this candidate: asking again opens nothing.
      records.length = 0;
      const repeat = yield* service.request(requester("late"), ask(candidateA));
      assert.strictEqual(repeat.status, "approved");
      assert.strictEqual(repeat.answer?.note, "Ship it");
      assert.lengthOf(records, 0);
    }),
  ),
);

it.effect("replaces an open card for an older candidate and tells its other threads", () =>
  withService(({ service, records, sent }) =>
    Effect.gen(function* () {
      const older = yield* service.request(other, ask(candidateA));
      records.length = 0;

      const newer = yield* service.request(lead, ask(candidateB));
      assert.notStrictEqual(newer.requestId, older.requestId);
      assert.strictEqual(newer.supersededCandidate, candidateA);
      assert.deepStrictEqual(
        records.map((record) => [record.threadId, record.approvalStatus, record.supersededBy]),
        [
          [other.threadId, "superseded", candidateB],
          [lead.threadId, "pending", undefined],
        ],
      );
      assert.deepStrictEqual(
        sent.map((message) => [message.threadId, message.createdBy]),
        [[other.threadId, "agent"]],
      );
      assert.include(sent[0]!.text, candidateB);

      const stale = yield* Effect.flip(
        service.answer({
          approvalId: older.requestId,
          candidate: candidateA,
          decision: "approved",
          answeredBy: "henry",
        }),
      );
      assert.strictEqual(stale.reason, "superseded");
    }),
  ),
);

it.effect("refuses an answer for a different candidate and skips archived threads", () =>
  withService(
    ({ service, sent }) =>
      Effect.gen(function* () {
        const card = yield* service.request(lead, ask(candidateA));
        yield* service.request(other, ask(candidateA));
        const mismatch = yield* Effect.flip(
          service.answer({
            approvalId: card.requestId,
            candidate: candidateB,
            decision: "approved",
            answeredBy: "henry",
          }),
        );
        assert.strictEqual(mismatch.reason, "candidate_mismatch");

        yield* service.answer({
          approvalId: card.requestId,
          candidate: candidateA,
          decision: "declined",
          answeredBy: "henry",
        });
        assert.deepStrictEqual(
          sent.map((message) => message.threadId),
          [lead.threadId],
        );
        assert.include(sent[0]!.text, "declined");

        // A decline is not kept: asking again opens a new card.
        const again = yield* service.request(lead, ask(candidateA));
        assert.strictEqual(again.status, "pending");
        assert.notStrictEqual(again.requestId, card.requestId);
      }),
    { archived: new Set([other.threadId]) },
  ),
);

it.effect("still delivers the answer when a thread's card cannot be updated", () => {
  let failing = false;
  return withService(
    ({ service, sent }) =>
      Effect.gen(function* () {
        const card = yield* service.request(lead, ask(candidateA));
        yield* service.request(other, ask(candidateA));
        failing = true;
        yield* service.answer({
          approvalId: card.requestId,
          candidate: candidateA,
          decision: "approved",
          answeredBy: "henry",
        });
        assert.deepStrictEqual(
          sent.map((message) => message.threadId).toSorted(),
          [lead.threadId, other.threadId].toSorted(),
        );
      }),
    { failCardWrites: (command) => failing && command.threadId === other.threadId },
  );
});

it.effect("answering a card that missed its update repairs it without repeating messages", () => {
  let failing = false;
  return withService(
    ({ service, records, sent }) =>
      Effect.gen(function* () {
        const card = yield* service.request(lead, ask(candidateA));
        yield* service.request(other, ask(candidateA));
        failing = true;
        yield* service.answer({
          approvalId: card.requestId,
          candidate: candidateA,
          decision: "approved",
          answeredBy: "henry",
        });
        failing = false;
        records.length = 0;

        // The other thread's card still offers Approve; pressing it reports the answer and
        // brings that card up to date.
        const again = yield* Effect.flip(
          service.answer({
            approvalId: card.requestId,
            candidate: candidateA,
            decision: "approved",
            answeredBy: "henry",
          }),
        );
        assert.strictEqual(again.reason, "already_answered");
        assert.deepStrictEqual(
          records.map((record) => [record.threadId, record.approvalStatus]).toSorted(),
          [
            [lead.threadId, "approved"],
            [other.threadId, "approved"],
          ].toSorted(),
        );
        assert.lengthOf(sent, 2);
      }),
    { failCardWrites: (command) => failing && command.threadId === other.threadId },
  );
});

it.effect(
  "fails the ask when the asking thread's card cannot be shown, and a retry shows it",
  () => {
    let failing = true;
    return withService(
      ({ service, records }) =>
        Effect.gen(function* () {
          const failed = yield* Effect.flip(service.request(lead, ask(candidateA)));
          assert.strictEqual(failed.reason, "failed");
          failing = false;

          const retried = yield* service.request(lead, ask(candidateA));
          assert.strictEqual(retried.status, "pending");
          assert.deepStrictEqual(
            records.map((record) => [record.threadId, record.approvalId]),
            [[lead.threadId, retried.requestId]],
          );
        }),
      { failCardWrites: (command) => failing && command.threadId === lead.threadId },
    );
  },
);

it.effect("answering a replaced card repeats its notice only to threads that lack it", () =>
  withService(({ service, sent }) =>
    Effect.gen(function* () {
      const older = yield* service.request(other, ask(candidateA));
      yield* service.request(lead, ask(candidateB));
      sent.length = 0;
      const stale = yield* Effect.flip(
        service.answer({
          approvalId: older.requestId,
          candidate: candidateA,
          decision: "approved",
          answeredBy: "henry",
        }),
      );
      assert.strictEqual(stale.reason, "superseded");
      // The notice already reached the other thread, and the thread that replaced it needs none.
      assert.lengthOf(sent, 0);
    }),
  ),
);

it.effect("updates the other threads' cards even when the asking thread's fails", () => {
  let failing = false;
  return withService(
    ({ service, records }) =>
      Effect.gen(function* () {
        yield* service.request(lead, ask(candidateA));
        yield* service.request(other, ask(candidateA));
        failing = true;
        records.length = 0;
        const failed = yield* Effect.flip(service.request(lead, ask(candidateA)));
        assert.strictEqual(failed.reason, "failed");
        assert.deepStrictEqual(
          records.map((record) => record.threadId),
          [other.threadId],
        );
      }),
    { failCardWrites: (command) => failing && command.threadId === lead.threadId },
  );
});
