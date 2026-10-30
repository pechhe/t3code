import type {
  SlipJayRunnerOperation,
  SlipJayRunnerOverview,
  SlipJayRunnerDeploy,
  SlipJayRunnerRelease,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  resolveBoxFooter,
  resolveEnvironmentRows,
  resolveReleaseSteps,
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

  it("colours the release steps by state, and shows none once production is current", () => {
    const steps = resolveReleaseSteps(
      release({
        audit: {
          latest: { status: "failed", commitId: null, finishedAt: "2026-10-30T02:35:00Z" },
          nextRunAt: null,
        },
        production: {
          live: null,
          latestAttempt: {
            commitId: "413ae31",
            status: "rolled_back",
            at: "2026-10-30T03:00:00Z",
            reason: null,
          },
        },
      }),
    );
    expect(steps.map((step) => [step.key, step.tone])).toEqual([
      ["images", "ok"],
      ["audit", "bad"],
      ["deploy", "bad"],
    ]);
    expect(
      resolveReleaseSteps(release({ waitingOn: { kind: "up_to_date", detail: null } })),
    ).toEqual([]);
    expect(resolveReleaseSteps(release({ images: null, audit: null })).map((s) => s.key)).toEqual([
      "deploy",
    ]);
  });

  it("keeps the latest attempt a note under production, never its state", () => {
    const now = Date.parse("2026-10-30T13:00:00Z");
    const rows = resolveEnvironmentRows(
      release({
        production: {
          live: { commitId: "32bf841eaaaa", deployedAt: "2026-10-29T22:00:00Z", healthy: true },
          latestAttempt: {
            commitId: "413ae31aaaa",
            status: "rolled_back",
            at: "2026-10-30T03:00:00Z",
            reason: "images not built in time",
          },
        },
      }),
      now,
    );
    expect(rows.map((row) => row.key)).toEqual(["production", "images", "staging"]);
    expect(rows[0]).toMatchObject({
      sha: "32bf841",
      tone: "ok",
      status: "live · healthy · 15h",
      note: "Last attempt 413ae31 rolled back 10h ago (images not built in time)",
    });
    expect(rows[2]).toMatchObject({ status: "skipped (development mode)", tone: "dim" });
  });

  it("marks an unhealthy production and shows staging as skipped or from its deploys", () => {
    const rows = resolveEnvironmentRows(
      release({
        stagingSkipped: false,
        images: null,
        production: {
          live: { commitId: "32bf841eaaaa", deployedAt: "2026-10-30T12:00:00Z", healthy: false },
          latestAttempt: null,
        },
      }),
      Date.parse("2026-10-30T13:00:00Z"),
    );
    expect(rows.map((row) => row.key)).toEqual(["production", "staging"]);
    expect(rows[0]).toMatchObject({ tone: "bad", status: "live · unhealthy · 1h" });
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

  it("falls back to the latest deploys when the runner does not report release.staging", () => {
    const now = Date.parse("2026-10-30T13:00:00Z");
    const deploy = (
      status: string,
      commitId: string,
      finishedAt: string,
      environment = "staging",
    ): SlipJayRunnerDeploy => ({
      operationId: `${commitId}-${environment}`,
      repo: "o/r",
      environment,
      commitId,
      status,
      finishedAt,
    });
    const live = release({ stagingSkipped: false });
    const staging = (deploys: SlipJayRunnerDeploy[]) =>
      resolveEnvironmentRows(live, now, deploys).find((row) => row.key === "staging");
    expect(staging([deploy("deployed", "aaaaaaaa1", "2026-10-30T12:00:00Z")])).toMatchObject({
      sha: "aaaaaaa",
      tone: "ok",
      status: "deployed · 1h",
      note: null,
    });
    // A failed latest deploy is a note when an earlier one succeeded, else the row's state.
    expect(
      staging([
        deploy("failed", "bbbbbbb2", "2026-10-30T12:30:00Z"),
        deploy("deployed", "aaaaaaaa1", "2026-10-30T10:00:00Z"),
      ]),
    ).toMatchObject({ sha: "aaaaaaa", tone: "ok", note: "Last attempt bbbbbbb failed 30m ago" });
    expect(staging([deploy("failed", "bbbbbbb2", "2026-10-30T12:30:00Z")])).toMatchObject({
      sha: "bbbbbbb",
      tone: "bad",
      status: "failed · 30m",
    });
    expect(
      staging([deploy("deployed", "ccccccc3", "2026-10-30T12:00:00Z", "production")]),
    ).toMatchObject({
      tone: "dim",
      status: "nothing deployed",
    });
  });

  it("builds staging from release.staging like production: live A stays the state beside a failed B", () => {
    const now = Date.parse("2026-10-30T13:00:00Z");
    const staging = (value: NonNullable<SlipJayRunnerRelease["staging"]> | null) =>
      resolveEnvironmentRows(release({ stagingSkipped: false, staging: value }), now, []).find(
        (row) => row.key === "staging",
      );
    expect(
      staging({
        live: { commitId: "aaaaaaa1", deployedAt: "2026-10-30T10:00:00Z", healthy: true },
        latestAttempt: {
          commitId: "bbbbbbb2",
          status: "failed",
          at: "2026-10-30T12:30:00Z",
          reason: "health check",
        },
      }),
    ).toMatchObject({
      sha: "aaaaaaa",
      tone: "ok",
      status: "live · healthy · 3h",
      note: "Last attempt bbbbbbb failed 30m ago (health check)",
    });
    expect(
      staging({
        live: { commitId: "aaaaaaa1", deployedAt: "2026-10-30T10:00:00Z", healthy: null },
        latestAttempt: null,
      }),
    ).toMatchObject({ sha: "aaaaaaa", tone: "ok", status: "live · 3h", note: null });
    expect(
      staging({
        live: null,
        latestAttempt: {
          commitId: "bbbbbbb2",
          status: "running",
          at: "2026-10-30T12:50:00Z",
          reason: null,
        },
      }),
    ).toMatchObject({
      sha: "none",
      tone: "dim",
      status: "nothing deployed",
      note: "Deploying bbbbbbb · 10m",
    });
    expect(staging(null)).toMatchObject({ tone: "dim", status: "nothing deployed" });
  });

  it("keeps the skipped row even when release.staging is reported", () => {
    const rows = resolveEnvironmentRows(release({ staging: { live: null, latestAttempt: null } }));
    expect(rows.at(-1)).toMatchObject({ status: "skipped (development mode)", tone: "dim" });
  });
});
