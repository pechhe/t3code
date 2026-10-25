import { EnvironmentId, OrchestratorMcpPeerNotice } from "@t3tools/contracts";
import { formatThreadLink } from "@t3tools/shared/threadLinks";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as PeerEnvironments from "./PeerEnvironments.ts";
import * as ThreadDirectory from "./ThreadDirectory.ts";

const peerId = EnvironmentId.make("peer-environment");
const localId = EnvironmentId.make("local-environment");

const thread = {
  threadId: "peer-thread",
  projectId: "peer-project",
  title: "Peer work",
  createdBy: "user",
  creationSource: "web",
  status: "idle",
  latestRunId: null,
  activeRunId: null,
  providerInstanceId: "codex",
  model: "gpt-5",
  runtimeMode: "auto",
  interactionMode: "default",
  linkedPullRequest: null,
  titleRegeneration: null,
  branch: null,
  worktreePath: null,
  parentThreadId: null,
  relationshipToParent: null,
  runCount: 0,
  itemCount: 0,
  pendingRequestCount: 0,
  archived: false,
  settled: false,
  settledAt: null,
  snoozed: false,
  snoozedUntil: null,
  createdAt: "2026-01-01T00:00:00.000Z",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const withPeer = (
  callTool: PeerEnvironments.PeerEnvironments["Service"]["callTool"],
  linked: ReadonlyArray<EnvironmentId> = [peerId],
) =>
  Effect.gen(function* () {
    return yield* ThreadDirectory.ThreadDirectory;
  }).pipe(
    Effect.provide(
      ThreadDirectory.layer.pipe(
        Layer.provide(
          Layer.mock(PeerEnvironments.PeerEnvironments)({
            linked: Effect.succeed(
              linked.map((environmentId) => ({ environmentId, label: "Mac" })),
            ),
            callTool,
          }),
        ),
      ),
    ),
  );

it.effect("reads a thread on a linked environment and marks its text as quoted data", () =>
  Effect.gen(function* () {
    const directory = yield* withPeer((input) =>
      Effect.succeed({
        isError: false,
        text: "",
        structuredContent: {
          environmentId: "whatever-the-peer-says",
          thread,
          recentRuns: [],
          items: [],
          nextPosition: null,
          hasMore: false,
        },
      }).pipe(Effect.tap(() => Effect.sync(() => expect(input.name).toBe("t3_thread_read")))),
    );
    const read = yield* directory.read(peerId, { threadId: "peer-thread" });
    expect(read).toMatchObject({
      environmentId: peerId,
      notice: OrchestratorMcpPeerNotice,
      thread: { title: "Peer work" },
    });
  }),
);

it.effect("reports a thread read that cannot be had as a tool failure", () =>
  Effect.gen(function* () {
    const missing = yield* (yield* withPeer(() =>
      Effect.succeed({
        isError: true,
        text: JSON.stringify({ code: "thread_not_found", message: "Thread x was not found." }),
        structuredContent: undefined,
      }),
    ))
      .read(peerId, { threadId: "x" })
      .pipe(Effect.flip);
    expect(missing).toMatchObject({ code: "thread_not_found", message: "Thread x was not found." });

    const offline = yield* (yield* withPeer(() =>
      Effect.fail(new PeerEnvironments.PeerCallError({ environmentId: peerId, status: "offline" })),
    ))
      .read(peerId, { threadId: "x" })
      .pipe(Effect.flip);
    expect(offline).toMatchObject({ code: "orchestration_error", message: "Mac is offline." });

    const unlinked = yield* (yield* withPeer(() => Effect.die("never called"), []))
      .read(peerId, { threadId: "x" })
      .pipe(Effect.flip);
    expect(unlinked).toMatchObject({ code: "invalid_request" });
  }),
);

it.effect("reports a peer whose answer this build cannot read as unsupported", () =>
  Effect.gen(function* () {
    const directory = yield* withPeer(() =>
      Effect.succeed({ isError: false, text: "", structuredContent: { threads: "not a list" } }),
    );
    expect(yield* directory.list("all", {})).toMatchObject([
      { environmentId: peerId, status: "unsupported", page: null },
    ]);
    expect(yield* directory.search("all", { query: "rollover" })).toMatchObject([
      { status: "unsupported", page: null },
    ]);
  }),
);

it.effect("points a peer's search match link at the peer's environment", () =>
  Effect.gen(function* () {
    const directory = yield* withPeer(() =>
      Effect.succeed({
        isError: false,
        text: "",
        structuredContent: {
          matches: [
            {
              threadId: "peer-thread",
              projectId: "peer-project",
              title: "Peer work",
              source: "title",
              environmentId: "whatever-the-peer-says",
              link: formatThreadLink("peer-thread", "Peer work"),
            },
          ],
        },
      }),
    );
    const [answer] = yield* directory.search(peerId, { query: "peer" });
    expect(answer?.page?.matches).toMatchObject([
      { environmentId: peerId, link: formatThreadLink("peer-thread", "Peer work", peerId) },
    ]);
  }),
);

it("covers this environment, every peer, or one peer, and never chains from a peer", () => {
  const plan = (requested: EnvironmentId | "all" | undefined, fromPeer = false) =>
    ThreadDirectory.environmentPlan({ requested, localId, fromPeer });
  expect(plan(undefined)).toEqual({ includeLocal: true, peers: "all" });
  expect(plan("all")).toEqual({ includeLocal: true, peers: "all" });
  expect(plan(localId)).toEqual({ includeLocal: true, peers: undefined });
  expect(plan(peerId)).toEqual({ includeLocal: false, peers: peerId });
  expect(plan("all", true)).toEqual({ includeLocal: true, peers: undefined });
  expect(plan(peerId, true)).toEqual({ includeLocal: true, peers: undefined });
});

it("reports a single environment's status and notice beside its page, answered or not", () => {
  const answered = {
    environmentId: peerId,
    label: "Mac",
    status: "ok" as const,
    notice: OrchestratorMcpPeerNotice,
    page: { threads: [thread] },
  };
  expect(ThreadDirectory.reportedBesidePage(answered)).toEqual([{ ...answered, page: null }]);
  expect(
    ThreadDirectory.reportedBesidePage({ ...answered, status: "offline", page: null }),
  ).toEqual([{ ...answered, status: "offline", page: null }]);
  expect(ThreadDirectory.reportedBesidePage(undefined)).toEqual([]);
});
