import type {
  SlipJayRunnerOperation,
  SlipJayRunnerOverview,
  SlipJayRunnerRelease,
  VcsSlipJayPromotion,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  resolveBoxFooter,
  resolveFailedPromotions,
  resolveProductionLine,
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
    const failed = promotion({ status: "failed", reason: "2 tests failed" });
    expect(resolveReleaseRow(waiting("verification"), failed)).toEqual({
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
    const withRelease = (kind: SlipJayRunnerRelease["waitingOn"]["kind"]) =>
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
    expect(resolveFailedPromotions(withRelease("approval"), [failed, running])).toEqual([failed]);
    expect(resolveFailedPromotions(withRelease("up_to_date"), [failed])).toEqual([]);
    expect(resolveFailedPromotions(overview(), null)).toEqual([]);
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
    // Failed images, verification or withheld promotion are not a production deploy.
    const held = resolveReleaseWaiting(failed(null, "images failed to build"));
    expect(held.text).toBe("Release held: images failed to build");
    expect(held.detail).toBeNull();
    expect(resolveReleaseWaiting(failed(null, null))).toMatchObject({
      text: "Release held",
      detail: null,
    });
    // A detail the sentence does not carry stays as the quiet why-line.
    expect(resolveReleaseWaiting(failed("failed", "timed out")).detail).toBe("timed out");
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
