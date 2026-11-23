import type {
  SlipJayRunnerOperation,
  SlipJayRunnerOverview,
  SlipJayRunnerRelease,
  VcsSlipJayPromotion,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  advanceReleaseClock,
  isStaleFailedPromotion,
  resolveBoxFooter,
  resolveReleaseAttention,
  resolveReleaseProgress,
  resolveReleaseStepTimes,
  createReleaseAnnouncementGate,
  resolveFailedPromotions,
  resolveProductionAges,
  resolvePromotionFailures,
  resolveReleaseFixPrompt,
  resolveReleasesInFlight,
  resolveProductionLine,
  resolveReleaseOutcomes,
  resolveReleaseRow,
  resolveReleaseWaiting,
  resolveScreeningLanes,
  resolveSlipJayPublishLane,
} from "./SlipJayBox.logic";

const landing = (over: Partial<SlipJayRunnerOperation> = {}): SlipJayRunnerOperation => ({
  operationId: "op",
  kind: "landing",
  repo: "o/r",
  status: "running",
  stage: "verifying",
  submittedBy: "h:w",
  ...over,
});

const release = (over: Partial<SlipJayRunnerRelease> = {}): SlipJayRunnerRelease => ({
  integrationBranch: "develop",
  candidate: { commitId: "b42c4213aaaa", landedAt: "2026-10-30T10:00:00Z" },
  stagingSkipped: true,
  production: {
    live: { commitId: "32bf841eaaaa", deployedAt: "2026-10-29T20:00:00Z", healthy: true },
    latestAttempt: null,
  },
  images: { commitId: "b42c4213aaaa", status: "built", at: "2026-10-30T12:19:00Z", reason: null },
  audit: { latest: null, nextRunAt: "2026-10-31T02:00:00Z" },
  waitingOn: { kind: "audit", detail: null },
  ...over,
});

const overview = (over: Partial<SlipJayRunnerOverview> = {}): SlipJayRunnerOverview => ({
  connected: true,
  paused: false,
  serial: [],
  deploy: [],
  deploys: [],
  repositories: [
    { repo: "o/r", screeningLanes: 3, today: { landed: 11, failedScreens: 7 }, release: null },
  ],
  ...over,
});

describe("the SlipJay box", () => {
  it("counts a lane busy for each landing screening in it", () => {
    const { lanes, busy } = resolveScreeningLanes(
      overview({
        serial: [
          landing({ operationId: "a", lane: 1 }),
          landing({ operationId: "b", lane: 3 }),
          landing({ operationId: "c", status: "queued" }),
        ],
      }),
    );
    expect(lanes).toEqual([true, false, true]);
    expect(busy).toBe(2);
  });

  it("offers one lane for a repository that screens one at a time, and sums repositories", () => {
    const single = overview({
      repositories: [
        { repo: "o/r", screeningLanes: 0, today: { landed: 0, failedScreens: 0 }, release: null },
        { repo: "o/s", screeningLanes: 2, today: { landed: 0, failedScreens: 0 }, release: null },
      ],
      serial: [landing({ repo: "o/s", lane: 2 })],
    });
    expect(resolveScreeningLanes(single).lanes).toEqual([false, false, true]);
    // An older runner reports no repositories: lanes follow what landings occupy.
    expect(
      resolveScreeningLanes(overview({ repositories: [], serial: [landing({ lane: 2 })] })).lanes,
    ).toEqual([false, true]);
  });

  it("names the landing publishing, else held while paused with landings waiting, else idle", () => {
    const publishing = landing({ stage: "publishing" });
    expect(resolveSlipJayPublishLane(overview({ serial: [publishing] }))).toEqual({
      kind: "publishing",
      operation: publishing,
    });
    const queued = landing({ status: "queued" });
    expect(resolveSlipJayPublishLane(overview({ paused: true, serial: [queued] })).kind).toBe(
      "held",
    );
    expect(resolveSlipJayPublishLane(overview({ paused: true })).kind).toBe("idle");
  });

  it("offers a press until production is current or deploying, and shows a release in flight", () => {
    const waiting = (kind: SlipJayRunnerRelease["waitingOn"]["kind"]) =>
      release({ waitingOn: { kind, detail: null } });
    expect(resolveReleaseRow(waiting("verification"), null)).toMatchObject({
      text: "Waiting on verification · b42c421",
      action: "release",
    });
    expect(resolveReleaseRow(waiting("up_to_date"), null).action).toBeNull();
    expect(resolveReleaseRow(waiting("deploy"), null).action).toBeNull();
    const promotion = (over: Partial<VcsSlipJayPromotion>): VcsSlipJayPromotion => ({
      repo: "o/r",
      status: "releasing",
      candidate: "b42c4213aaaa",
      reason: null,
      ...over,
    });
    expect(
      resolveReleaseRow(waiting("verification"), promotion({ candidate: null })),
    ).toMatchObject({ text: "Starting the release", action: "releasing" });
    expect(resolveReleaseRow(waiting("verification"), promotion({}))).toMatchObject({
      text: "Verifying b42c421, then releasing it",
      action: "releasing",
    });
    expect(resolveReleaseRow(waiting("deploy"), promotion({})).text).toBe(
      "Releasing b42c421 to production",
    );
    const failed = promotion({
      status: "failed",
      reason: "2 tests failed",
      finishedAt: "2026-10-30T10:05:00Z",
    });
    expect(resolveReleaseRow(waiting("verification"), failed)).toEqual({
      tone: "bad",
      text: "Release failed · b42c421",
      detail: "2 tests failed",
      action: "retry",
    });
    expect(resolveReleaseRow(waiting("verification"), { ...failed, candidate: null })).toEqual({
      tone: "bad",
      text: "Release failed",
      detail: "2 tests failed",
      action: "retry",
    });
    // Production caught up without it, so the failure no longer matters.
    expect(resolveReleaseRow(waiting("up_to_date"), failed).action).toBeNull();
  });

  it("calls attention only to failed releases production still needs", () => {
    const failed: VcsSlipJayPromotion = {
      repo: "o/r",
      status: "failed",
      candidate: null,
      reason: "no",
    };
    const running: VcsSlipJayPromotion = { ...failed, repo: "o/s", status: "releasing" };
    const withRelease = (
      kind: SlipJayRunnerRelease["waitingOn"]["kind"],
      over: Partial<SlipJayRunnerRelease> = {},
    ) =>
      overview({
        repositories: [
          {
            repo: "o/r",
            screeningLanes: 0,
            today: { landed: 0, failedScreens: 0 },
            release: release({ waitingOn: { kind, detail: null }, ...over }),
          },
        ],
      });
    expect(resolveFailedPromotions(withRelease("approval"), [failed, running])).toEqual([failed]);
    expect(resolveFailedPromotions(withRelease("up_to_date"), [failed])).toEqual([]);
    expect(resolveFailedPromotions(overview(), null)).toEqual([]);

    // Commit A failed before commit B deployed; commit C landed later so waitingOn is verification again.
    const supersededByTime: VcsSlipJayPromotion = {
      repo: "o/r",
      status: "failed",
      candidate: "aaaaaaa11111",
      reason: "2 tests failed",
      finishedAt: "2026-10-30T10:00:00Z",
    };
    const newerDeployOverview = withRelease("verification", {
      candidate: { commitId: "ccccccc33333", landedAt: "2026-10-30T10:20:00Z" },
      production: {
        live: { commitId: "bbbbbbb22222", deployedAt: "2026-10-30T10:10:00Z", healthy: true },
        latestAttempt: null,
      },
    });
    const newerDeployRelease = newerDeployOverview.repositories[0]!.release!;
    expect(isStaleFailedPromotion(newerDeployRelease, supersededByTime)).toBe(true);
    expect(resolveFailedPromotions(newerDeployOverview, [supersededByTime])).toEqual([]);
    expect(resolveReleaseAttention(newerDeployOverview, [supersededByTime])).toBeNull();
    expect(resolveReleaseRow(newerDeployRelease, supersededByTime)).toEqual({
      tone: "warn",
      text: "Waiting on verification · ccccccc",
      detail: null,
      action: "release",
    });

    // Production live commit matches the failed promotion's candidate.
    const sameLivePromotion: VcsSlipJayPromotion = {
      repo: "o/r",
      status: "failed",
      candidate: "bbbbbbb22222",
      reason: "timed out",
      finishedAt: "2026-10-30T10:15:00Z",
    };
    expect(isStaleFailedPromotion(newerDeployRelease, sameLivePromotion)).toBe(true);
    expect(resolveFailedPromotions(newerDeployOverview, [sameLivePromotion])).toEqual([]);
    expect(resolveReleaseAttention(newerDeployOverview, [sameLivePromotion])).toBeNull();
    expect(resolveReleaseRow(newerDeployRelease, sameLivePromotion).action).toBe("release");

    // Non-stale failure: finished after live deploy, or no live deploy yet.
    const activeFailure: VcsSlipJayPromotion = {
      repo: "o/r",
      status: "failed",
      candidate: "ccccccc33333",
      reason: "verification failed",
      finishedAt: "2026-10-30T10:25:00Z",
    };
    expect(isStaleFailedPromotion(newerDeployRelease, activeFailure)).toBe(false);
    expect(resolveFailedPromotions(newerDeployOverview, [activeFailure])).toEqual([activeFailure]);
    expect(resolveReleaseAttention(newerDeployOverview, [activeFailure])).toBe("failed");
    expect(resolveReleaseRow(newerDeployRelease, activeFailure)).toEqual({
      tone: "bad",
      text: "Release failed · ccccccc",
      detail: "verification failed",
      action: "retry",
    });

    const noLiveOverview = withRelease("verification", {
      production: { live: null, latestAttempt: null },
    });
    const noLiveRelease = noLiveOverview.repositories[0]!.release!;
    expect(isStaleFailedPromotion(noLiveRelease, supersededByTime)).toBe(false);
    expect(resolveReleaseAttention(noLiveOverview, [supersededByTime])).toBe("failed");
    expect(resolveReleaseRow(noLiveRelease, supersededByTime)).toEqual({
      tone: "bad",
      text: "Release failed · aaaaaaa",
      detail: "2 tests failed",
      action: "retry",
    });
  });

  it("says in a sentence what the candidate waits on", () => {
    expect(resolveReleaseWaiting(release()).text).toMatch(
      /^Waiting on the nightly audit · runs \d\d:\d\d$/,
    );
    expect(resolveReleaseWaiting(release({ audit: null })).text).toBe(
      "Waiting on the nightly audit",
    );
    expect(
      resolveReleaseWaiting(release({ waitingOn: { kind: "up_to_date", detail: null } })),
    ).toEqual({
      tone: "ok",
      text: "Production is up to date",
      detail: null,
    });
    expect(
      resolveReleaseWaiting(release({ waitingOn: { kind: "paused", detail: null } })).text,
    ).toBe("Held while the runner is paused");
  });

  it("says rolled back or deploy failed only for a production attempt that did", () => {
    const failed = (
      status: "rolled_back" | "failed" | null,
      detail: string | null,
    ): SlipJayRunnerRelease =>
      release({
        waitingOn: { kind: "failed", detail },
        production: {
          live: null,
          latestAttempt:
            status === null
              ? null
              : { commitId: "413ae31", status, at: "2026-10-30T03:00:00Z", reason: null },
        },
      });
    expect(resolveReleaseWaiting(failed("rolled_back", null)).text).toBe(
      "Production deploy failed · rolled back",
    );
    expect(resolveReleaseWaiting(failed("failed", null)).text).toBe("Production deploy failed");
    // Failed images or verification are not a production deploy; the why stays its own line.
    expect(resolveReleaseWaiting(failed(null, "images failed to build"))).toMatchObject({
      tone: "bad",
      text: "Release failed",
      detail: "images failed to build",
    });
    // A detail the sentence does not carry stays as the quiet why-line.
    expect(resolveReleaseWaiting(failed("failed", "timed out")).detail).toBe("timed out");
  });

  it("tells a release held for a decision from the routine wait for the next slot (T3-700)", () => {
    const reason =
      "Not promoting ea1f92012b2b automatically: it carries non-additive migrations (0479.sql): the owner decides";
    const held = release({ waitingOn: { kind: "withheld", detail: reason } });
    expect(resolveReleaseWaiting(held)).toEqual({
      tone: "bad",
      text: "Release held",
      detail: reason,
    });
    expect(resolveReleaseRow(held, null)).toMatchObject({
      tone: "bad",
      detail: reason,
      action: "release",
    });
    expect(resolveReleaseProgress("o/r", held, overview()).state).toBe("waiting");

    // 17:00 UTC in summer is 18:00 in London, whatever the viewer's own zone.
    const scheduled = release({
      waitingOn: {
        kind: "scheduled",
        detail: "Not promoting ea1f92012b2b automatically: waiting",
        at: "2026-07-16T17:00:00Z",
      },
    });
    expect(resolveReleaseWaiting(scheduled)).toEqual({
      tone: "warn",
      text: "Next release 18:00",
      detail: null,
    });
    expect(resolveReleaseProgress("o/r", scheduled, overview()).state).toBe("waiting");

    const resting = (kind: SlipJayRunnerRelease["waitingOn"]["kind"]) =>
      overview({
        repositories: [
          {
            repo: "o/r",
            screeningLanes: 0,
            today: { landed: 0, failedScreens: 0 },
            release: release({ waitingOn: { kind, detail: null } }),
          },
        ],
      });
    expect(resolveReleaseAttention(resting("withheld"), [])).toBe("held");
    expect(resolveReleaseAttention(resting("failed"), [])).toBe("failed");
    expect(resolveReleaseAttention(resting("scheduled"), [])).toBeNull();
    // Once the release goes out, nothing is left to dismiss.
    expect(resolveReleaseAttention(resting("up_to_date"), [])).toBeNull();
  });

  it("reads production in a line, keeping the latest attempt a note and flagging ill health", () => {
    const now = Date.parse("2026-10-30T20:00:00Z");
    expect(resolveProductionLine(release(), now)).toEqual({
      tone: "ok",
      text: "Production 32bf841 · healthy · 1d",
      note: null,
    });
    const attempted = resolveProductionLine(
      release({
        production: {
          live: { commitId: "32bf841eaaaa", deployedAt: "2026-10-29T20:00:00Z", healthy: false },
          latestAttempt: {
            commitId: "aaaaaaa1111",
            status: "rolled_back",
            at: "2026-10-30T19:00:00Z",
            reason: "health check",
          },
        },
      }),
      now,
    );
    expect(attempted.tone).toBe("bad");
    expect(attempted.note).toBe("Last attempt aaaaaaa rolled back 1h ago (health check)");
    expect(
      resolveProductionLine(release({ production: { live: null, latestAttempt: null } }), now).text,
    ).toBe("Production has nothing deployed");
  });

  it("totals today across repositories and reports the queue", () => {
    const footer = resolveBoxFooter(
      overview({
        paused: true,
        serial: [landing({ status: "queued" }), landing({ status: "queued" })],
        repositories: [
          {
            repo: "o/r",
            screeningLanes: 3,
            today: { landed: 11, failedScreens: 7 },
            release: null,
          },
          { repo: "o/s", screeningLanes: 1, today: { landed: 1, failedScreens: 1 }, release: null },
        ],
      }),
    );
    expect(footer).toEqual({ today: "Today 12 landed · 8 failed screens", queue: "2 held" });
    expect(resolveBoxFooter(overview()).queue).toBe("no queue");
  });
});

describe("production deploys and release outcomes", () => {
  const withRelease = (rel: SlipJayRunnerRelease) =>
    overview({
      repositories: [
        { repo: "o/r", screeningLanes: 0, today: { landed: 0, failedScreens: 0 }, release: rel },
      ],
    });
  const live = (commitId: string) => ({
    commitId,
    deployedAt: "2026-11-09T10:00:00Z",
    healthy: true,
  });
  const attempt = (status: "running" | "failed" | "rolled_back", commitId = "bbbbbbb1") => ({
    commitId,
    status,
    at: "2026-11-09T11:00:00Z",
    reason: null,
  });

  it("lists a running production deploy but not a staging or queued one", () => {
    const deploy = (over: Partial<SlipJayRunnerOperation>) =>
      landing({ kind: "deploy", environment: "production", commitId: "25fb068aaaa", ...over });
    const result = resolveReleasesInFlight(
      overview({
        deploy: [
          deploy({ startedAt: "2026-11-09T11:00:00Z" }),
          deploy({ environment: "staging" }),
          deploy({ status: "queued" }),
        ],
      }),
    );
    expect(result).toEqual([
      { repo: "o/r", commitId: "25fb068aaaa", startedAt: "2026-11-09T11:00:00Z" },
    ]);
  });

  it("includes a release this environment started that is still verifying, until a deploy names it", () => {
    const promotion = (over: Partial<VcsSlipJayPromotion> = {}): VcsSlipJayPromotion => ({
      repo: "o/r",
      status: "releasing",
      candidate: "2c1d17eaaaa",
      reason: null,
      ...over,
    });
    expect(resolveReleasesInFlight(overview(), [promotion()])).toEqual([
      { repo: "o/r", commitId: "2c1d17eaaaa", startedAt: null },
    ]);
    const deploying = overview({
      deploy: [
        landing({
          kind: "deploy",
          environment: "production",
          commitId: "2c1d17eaaaa",
          startedAt: "2026-11-09T11:00:00Z",
        }),
      ],
    });
    expect(resolveReleasesInFlight(deploying, [promotion()])).toEqual([
      { repo: "o/r", commitId: "2c1d17eaaaa", startedAt: "2026-11-09T11:00:00Z" },
    ]);
    expect(resolveReleasesInFlight(overview(), [promotion({ status: "failed" })])).toEqual([]);
  });

  it("falls back to a running production attempt when no operation names it", () => {
    const result = resolveReleasesInFlight(
      withRelease(
        release({ production: { live: live("aaaaaaa1"), latestAttempt: attempt("running") } }),
      ),
    );
    expect(result).toEqual([
      { repo: "o/r", commitId: "bbbbbbb1", startedAt: "2026-11-09T11:00:00Z" },
    ]);
  });

  it("reports a release when production's live commit changes", () => {
    const before = withRelease(
      release({ production: { live: live("aaaaaaa1"), latestAttempt: attempt("running") } }),
    );
    const after = withRelease(
      release({ production: { live: live("bbbbbbb1"), latestAttempt: null } }),
    );
    expect(resolveReleaseOutcomes(before, after)).toEqual([
      { repo: "o/r", commitId: "bbbbbbb1", result: "released", reason: null },
    ]);
  });

  it("reports a new failed attempt once, not again on an unchanged snapshot", () => {
    const before = withRelease(
      release({ production: { live: live("aaaaaaa1"), latestAttempt: attempt("running") } }),
    );
    const failed = withRelease(
      release({ production: { live: live("aaaaaaa1"), latestAttempt: attempt("failed") } }),
    );
    expect(resolveReleaseOutcomes(before, failed)).toEqual([
      { repo: "o/r", commitId: "bbbbbbb1", result: "failed", reason: null },
    ]);
    expect(resolveReleaseOutcomes(failed, failed)).toEqual([]);
  });

  it("reports nothing while a deploy runs or for a repository first seen", () => {
    const idle = withRelease(
      release({ production: { live: live("aaaaaaa1"), latestAttempt: null } }),
    );
    const running = withRelease(
      release({ production: { live: live("aaaaaaa1"), latestAttempt: attempt("running") } }),
    );
    expect(resolveReleaseOutcomes(idle, running)).toEqual([]);
    expect(resolveReleaseOutcomes(overview(), idle)).toEqual([]);
  });
});

describe("the release announcement gate", () => {
  const released = { repo: "o/r", commitId: "bbbbbbb1", result: "released", reason: null } as const;

  it("announces an outcome once however many environments report it", () => {
    const shouldAnnounce = createReleaseAnnouncementGate(60_000);
    expect(shouldAnnounce(released, 0)).toBe(true);
    expect(shouldAnnounce(released, 2_000)).toBe(false);
  });

  it("announces the same commit released again after the window", () => {
    const shouldAnnounce = createReleaseAnnouncementGate(60_000);
    expect(shouldAnnounce(released, 0)).toBe(true);
    expect(shouldAnnounce(released, 3_600_000)).toBe(true);
  });
});

describe("production ages", () => {
  const withRelease = (rel: SlipJayRunnerRelease) =>
    overview({
      repositories: [
        { repo: "o/r", screeningLanes: 0, today: { landed: 0, failedScreens: 0 }, release: rel },
      ],
    });

  it("reports when production went live, and skips a repository that does not release", () => {
    const result = resolveProductionAges(
      overview({
        repositories: [
          {
            repo: "o/none",
            screeningLanes: 0,
            today: { landed: 0, failedScreens: 0 },
            release: null,
          },
          ...withRelease(release()).repositories,
        ],
      }),
    );
    expect(result).toEqual([
      {
        repo: "o/r",
        commitId: "32bf841eaaaa",
        deployedAt: "2026-10-29T20:00:00Z",
        healthy: true,
        failed: false,
      },
    ]);
  });

  it("marks a newer failed attempt, but not one still running", () => {
    const live = { commitId: "aaaaaaa1", deployedAt: "2026-11-09T10:00:00Z", healthy: true };
    const attempt = (status: "running" | "failed") => ({
      commitId: "bbbbbbb1",
      status,
      at: "2026-11-09T11:00:00Z",
      reason: null,
    });
    const failed = resolveProductionAges(
      withRelease(release({ production: { live, latestAttempt: attempt("failed") } })),
    );
    const running = resolveProductionAges(
      withRelease(release({ production: { live, latestAttempt: attempt("running") } })),
    );
    expect([failed[0]?.failed, running[0]?.failed]).toEqual([true, false]);
  });
});

describe("failed releases", () => {
  const failed = (over: Partial<VcsSlipJayPromotion> = {}): VcsSlipJayPromotion => ({
    repo: "o/r",
    status: "failed",
    candidate: "5f0843d149aa",
    reason: "No pre-verification passed",
    ...over,
  });

  it("reports a release that newly failed, once, and not one already failed", () => {
    expect(resolvePromotionFailures([], [failed()])).toEqual([
      {
        repo: "o/r",
        commitId: "5f0843d149aa",
        result: "release_failed",
        reason: "No pre-verification passed",
      },
    ]);
    expect(resolvePromotionFailures([failed()], [failed()])).toEqual([]);
    expect(
      resolvePromotionFailures([failed()], [failed({ reason: "Another reason" })]),
    ).toHaveLength(1);
    expect(resolvePromotionFailures([], [failed({ status: "releasing" })])).toEqual([]);
  });

  it("announces one failure for a refused release and the failed deploy under it", () => {
    const shouldAnnounce = createReleaseAnnouncementGate(60_000);
    const [refused] = resolvePromotionFailures([], [failed()]);
    expect(shouldAnnounce(refused!, 0)).toBe(true);
    expect(
      shouldAnnounce({ repo: "o/r", commitId: "x", result: "failed", reason: null }, 1_000),
    ).toBe(false);
  });

  it("briefs a thread with the candidate and SlipJay's reason, without starting a release", () => {
    const prompt = resolveReleaseFixPrompt({
      name: "YardSmith + PropSmith + Weave",
      candidate: "5f0843d149aa",
      reason: "No pre-verification passed",
    });
    expect(prompt).toContain("YardSmith + PropSmith + Weave");
    expect(prompt).toContain("5f0843d");
    expect(prompt).toContain("No pre-verification passed");
    expect(prompt).toContain("Do not start a release yourself");
  });
});

describe("releases started elsewhere", () => {
  it("counts a running confirm verification as a release in flight, but not background verification", () => {
    const op = (submittedBy: string) =>
      landing({ kind: "verification", submittedBy, startedAt: "2026-10-30T12:00:00Z" });
    expect(
      resolveReleasesInFlight(overview({ serial: [op("peach-live:confirm")] })).map(
        (deploy) => deploy.startedAt,
      ),
    ).toEqual(["2026-10-30T12:00:00Z"]);
    expect(resolveReleasesInFlight(overview({ serial: [op("peach-live:background")] }))).toEqual(
      [],
    );
  });
});

describe("release progress", () => {
  const verifying = release({ waitingOn: { kind: "verification", detail: null } });

  it("places the release in its phase, with the runner's operation and start", () => {
    const operation = landing({
      kind: "verification",
      stage: "waiting-for-budget",
      startedAt: "2026-10-30T12:00:00Z",
    });
    const progress = resolveReleaseProgress("o/r", verifying, overview({ serial: [operation] }));
    expect(progress.phase).toBe("verification");
    expect(progress.steps.map((step) => step.state)).toEqual([
      "done",
      "done",
      "current",
      "pending",
    ]);
    expect(progress.operation).toBe(operation);
    expect(progress.startedAt).toBe("2026-10-30T12:00:00Z");
  });

  it("is in the deploy phase while a production deploy runs, and fails in the phase that failed", () => {
    const deploy = landing({ kind: "deploy", environment: "production", stage: "deploying" });
    expect(resolveReleaseProgress("o/r", verifying, overview({ deploy: [deploy] })).phase).toBe(
      "deploy",
    );
    const failed = release({
      waitingOn: { kind: "failed", detail: null },
      images: { commitId: "b42c4213aaaa", status: "failed", at: null, reason: null },
    });
    const progress = resolveReleaseProgress("o/r", failed, overview());
    expect([progress.phase, progress.state]).toEqual(["images", "bad"]);
    expect(
      resolveReleaseProgress(
        "o/r",
        release({ waitingOn: { kind: "up_to_date", detail: null } }),
        overview(),
      ).phase,
    ).toBeNull();
  });

  it("times a finished phase to where the next began and the current one to now", () => {
    const progress = resolveReleaseProgress("o/r", verifying, overview());
    const at = (ms: number) => new Date(ms).toISOString();
    const clock = advanceReleaseClock(
      advanceReleaseClock({}, "o/r@x", { ...progress, phase: "audit", startedAt: at(1_000) }),
      "o/r@x",
      { ...progress, startedAt: at(61_000) },
    );
    expect(resolveReleaseStepTimes(progress.steps, clock["o/r@x"], 100_000)).toEqual([
      null,
      60_000,
      39_000,
      null,
    ]);
  });

  it("times no phase while nothing runs in it, such as a candidate waiting to be verified", () => {
    const waiting = resolveReleaseProgress("o/r", verifying, overview());
    const earlier = landing({ kind: "verification", startedAt: "2026-10-30T12:00:00Z" });
    const checked = resolveReleaseProgress("o/r", verifying, overview({ serial: [earlier] }));
    // Seen waiting, and waiting again after an earlier verification of it finished.
    for (const clock of [{}, advanceReleaseClock({}, "o/r@x", checked)]) {
      const starts = advanceReleaseClock(clock, "o/r@x", waiting)["o/r@x"];
      expect(
        resolveReleaseStepTimes(waiting.steps, starts, Date.parse("2026-10-30T12:10:00Z"))[2],
      ).toBeNull();
    }
  });
});
