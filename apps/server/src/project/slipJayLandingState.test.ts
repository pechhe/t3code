import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";

import {
  applyLandingOutcome,
  applyWatchEnvelope,
  initialLandingWatchState,
  landingChanges,
  landingForChange,
  parseLandingDetail,
  parseLandingOutcome,
  parseWatchLine,
  resolveWorkspaceLanding,
  runnerOverviewFromSnapshot,
  submittingWorkspace,
  type LandingWatchState,
} from "./slipJayLandingState.ts";

const REPO = "PechHe/T3Code";

function apply(state: LandingWatchState, ...lines: ReadonlyArray<object>) {
  let next = state;
  let vanished: ReadonlyArray<string> = [];
  for (const line of lines) {
    const envelope = Option.getOrThrow(parseWatchLine(JSON.stringify({ version: 1, ...line })));
    ({ state: next, vanished } = applyWatchEnvelope(next, envelope));
  }
  return { state: next, vanished };
}

const connected = (cursor = 0) => ({ type: "connection", state: "connected", cursor });
const event = (seq: number, operationId: string, body: object) => ({
  type: "event",
  event: { seq, operationId, event: body },
});
const submitted = (seq: number, operationId: string, changeId: string, kind?: string) =>
  event(seq, operationId, {
    type: "submitted",
    ...(kind === undefined ? {} : { kind }),
    repo: REPO,
    changeId,
    commitId: "candidate",
    bookmark: "t3peach",
    submittedBy: "host:/workspace",
  });
const snapshot = (seq: number, serial: ReadonlyArray<object>) => ({
  type: "snapshot",
  snapshot: { seq, lanes: { serial, deploy: [] } },
});

describe("slipJayLandingState", () => {
  it("follows a landing of a change through its stages to the published commit", () => {
    const { state } = apply(
      initialLandingWatchState,
      connected(),
      submitted(1, "op_a", "change-a"),
      event(2, "op_a", { type: "stage", stage: "checks" }),
    );
    expect(landingForChange(state, "pechhe/t3code", "change-a")).toEqual({
      operationId: "op_a",
      status: "active",
      stage: "checks",
      live: true,
    });

    const landed = apply(
      state,
      event(3, "op_a", { type: "landed", base: "b", commitId: "abc1234def", branch: "t3peach" }),
    ).state;
    expect(landingForChange(landed, "pechhe/t3code", "change-a")).toMatchObject({
      status: "landed",
      commitId: "abc1234def",
    });
    expect(landed.cursor).toBe(3);
  });

  it("matches only the change and repository asked for", () => {
    const { state } = apply(
      initialLandingWatchState,
      submitted(1, "op_a", "change-a"),
      submitted(2, "op_b", "change-b"),
    );
    expect(landingForChange(state, "pechhe/t3code", "change-b")?.operationId).toBe("op_b");
    expect(landingForChange(state, "pechhe/other", "change-a")).toBeUndefined();
    expect(landingForChange(state, "pechhe/t3code", "change-c")).toBeUndefined();
  });

  it("ignores operations that never belong to a workspace", () => {
    const { state } = apply(initialLandingWatchState, submitted(1, "op_r", "change-a", "release"));
    expect(state.operations.size).toBe(0);
    expect(state.cursor).toBe(1);
  });

  it("keeps the failing stage and reason of a failed landing", () => {
    const { state } = apply(
      initialLandingWatchState,
      submitted(1, "op_a", "change-a"),
      event(2, "op_a", { type: "stage", stage: "checks" }),
      event(3, "op_a", { type: "failed", stage: "gate", reason: "tests failed" }),
      event(4, "op_a", { type: "stage", stage: "publish" }),
    );
    expect(landingForChange(state, REPO, "change-a")).toMatchObject({
      status: "failed",
      stage: "gate",
      reason: "tests failed",
    });
  });

  it("shows the resubmission when a newer landing supersedes the old one", () => {
    const { state } = apply(
      initialLandingWatchState,
      submitted(1, "op_a", "change-a"),
      event(2, "op_a", { type: "superseded", by: "op_b" }),
      submitted(3, "op_b", "change-a"),
    );
    expect(landingForChange(state, REPO, "change-a")?.operationId).toBe("op_b");
    expect(state.operations.has("op_a")).toBe(false);
  });

  it("reports a landing as not live while the watch is reconnecting", () => {
    const { state } = apply(
      initialLandingWatchState,
      connected(),
      submitted(5, "op_a", "change-a"),
      { type: "connection", state: "disconnected", cursor: 5 },
    );
    expect(landingForChange(state, REPO, "change-a")?.live).toBe(false);
    expect(state.cursor).toBe(5);
  });

  it("adopts active landings from a snapshot and flags ones that finished while away", () => {
    const before = apply(
      initialLandingWatchState,
      submitted(1, "op_gone", "change-a"),
      submitted(2, "op_kept", "change-b"),
    ).state;
    const { state, vanished } = apply(
      before,
      snapshot(9, [
        { id: "op_kept", kind: "landing", repo: REPO, changeId: "change-b", stage: "publish" },
        { id: "op_new", repo: REPO, changeId: "change-c", stage: "queued" },
        { id: "op_deploy", kind: "deploy", repo: REPO, stage: "deploy" },
      ]),
    );
    expect(vanished).toEqual(["op_gone"]);
    expect(landingForChange(state, REPO, "change-b")?.stage).toBe("publish");
    expect(landingForChange(state, REPO, "change-c")?.status).toBe("active");
    expect(state.operations.has("op_deploy")).toBe(false);
  });

  it("settles a vanished landing from the runner's retained outcome", () => {
    const { state } = apply(initialLandingWatchState, submitted(1, "op_a", "change-a"));
    const outcome = Option.getOrUndefined(
      parseLandingOutcome(
        JSON.stringify({
          status: "landed",
          stage: "finalizing",
          terminal: true,
          publication: { commitId: "def5678" },
        }),
      ),
    );
    expect(
      landingForChange(applyLandingOutcome(state, "op_a", outcome), REPO, "change-a"),
    ).toMatchObject({ status: "landed", commitId: "def5678" });
    expect(
      landingForChange(applyLandingOutcome(state, "op_a", undefined), REPO, "change-a")?.status,
    ).toBe("unknown");
  });

  it("keeps the Spec a snapshot named after the landing leaves the queue", () => {
    const { state } = apply(
      initialLandingWatchState,
      connected(),
      submitted(1, "op_a", "change-a"),
      snapshot(1, [{ id: "op_a", repo: REPO, changeId: "change-a", stage: "queued", spec: 189 }]),
      event(2, "op_a", { type: "stage", stage: "checks" }),
      event(3, "op_a", { type: "landed", commitId: "abc1234def" }),
      snapshot(3, []),
    );
    expect(landingForChange(state, REPO, "change-a")).toMatchObject({
      status: "landed",
      spec: 189,
    });
  });

  it("keeps the same operations when a heartbeat snapshot repeats what it knows", () => {
    const { state } = apply(
      initialLandingWatchState,
      submitted(1, "op_a", "change-a"),
      event(2, "op_a", { type: "stage", stage: "checks" }),
    );
    const repeated = apply(
      state,
      snapshot(2, [{ id: "op_a", repo: REPO, changeId: "change-a", stage: "checks" }]),
    );
    expect(repeated.state).toBe(state);
    expect(repeated.vanished).toEqual([]);
  });

  it("learns who submitted a landing from the snapshot that lists it active", () => {
    const { state } = apply(
      initialLandingWatchState,
      submitted(1, "op_a", "change-a"),
      snapshot(1, [
        {
          id: "op_a",
          repo: REPO,
          changeId: "change-a",
          stage: "queued",
          submittedBy: "host:ws-a",
        },
      ]),
      event(2, "op_a", { type: "failed", stage: "verifying", reason: "tests failed" }),
    );
    expect(state.operations.get("op_a")).toMatchObject({
      status: "failed",
      stage: "verifying",
      submittedBy: "host:ws-a",
    });
  });

  it("names the repository and change a stage moved, and every landing on reconnect", () => {
    const { state } = apply(
      initialLandingWatchState,
      connected(),
      submitted(1, "op_a", "change-a"),
    );
    const staged = apply(state, event(2, "op_a", { type: "stage", stage: "checks" })).state;
    expect(landingChanges(state, staged)).toEqual([
      { repository: "pechhe/t3code", changeId: "change-a" },
    ]);
    expect(landingChanges(staged, apply(staged, { type: "heartbeat" }).state)).toEqual([]);
    const dropped = apply(staged, { type: "connection", state: "disconnected", cursor: 2 }).state;
    expect(landingChanges(staged, dropped)).toEqual([{ repository: null }]);
  });

  it("recovers a landing that finished beyond the replay window after a reconnect", () => {
    const before = apply(initialLandingWatchState, connected(), submitted(1, "op_a", "change-a"), {
      type: "connection",
      state: "disconnected",
      cursor: 1,
    }).state;
    // Hundreds of events later the watch reconnects; its replay no longer reaches op_a.
    const { state, vanished } = apply(before, connected(600), snapshot(600, []));
    expect(vanished).toEqual(["op_a"]);
    expect(landingForChange(state, REPO, "change-a")?.status).toBe("active");
    const outcome = Option.getOrUndefined(
      parseLandingOutcome(
        JSON.stringify({
          status: "failed",
          stage: "gate",
          terminal: true,
          failure: { reason: "tests failed", stage: "gate" },
        }),
      ),
    );
    expect(
      landingForChange(applyLandingOutcome(state, "op_a", outcome), REPO, "change-a"),
    ).toMatchObject({
      status: "failed",
      stage: "gate",
      reason: "tests failed",
      live: true,
    });
  });

  it("drops a landing whose retained outcome says it was superseded", () => {
    const { state } = apply(initialLandingWatchState, submitted(1, "op_a", "change-a"));
    const outcome = Option.getOrUndefined(
      parseLandingOutcome(
        JSON.stringify({ status: "superseded", stage: "queued", terminal: true }),
      ),
    );
    expect(
      landingForChange(applyLandingOutcome(state, "op_a", outcome), REPO, "change-a"),
    ).toBeUndefined();
  });

  describe("resolveWorkspaceLanding", () => {
    const landed = apply(
      initialLandingWatchState,
      submitted(1, "op_a", "change-a"),
      event(2, "op_a", { type: "landed", base: "b", commitId: "abc1234def", branch: "t3peach" }),
    ).state;

    it("shows nothing for a fresh workspace on someone else's landed change", () => {
      expect(
        resolveWorkspaceLanding(
          landed,
          REPO,
          { changeId: "change-a", integrated: true },
          undefined,
        ),
      ).toEqual({ landing: undefined, submitted: undefined });
    });

    it("keeps showing a workspace's own landing once its change is integrated", () => {
      const submitting = resolveWorkspaceLanding(
        landed,
        REPO,
        { changeId: "change-a", integrated: false },
        undefined,
      );
      expect(submitting.submitted).toBe("op_a");
      const afterwards = resolveWorkspaceLanding(
        landed,
        REPO,
        { changeId: "change-tip", integrated: true },
        submitting.submitted,
      );
      expect(afterwards.landing).toMatchObject({ operationId: "op_a", status: "landed" });
      expect(afterwards.submitted).toBe("op_a");
    });

    it("forgets the submission once the workspace starts a change with no landing", () => {
      expect(
        resolveWorkspaceLanding(landed, REPO, { changeId: "change-b", integrated: false }, "op_a"),
      ).toEqual({ landing: undefined, submitted: undefined });
    });
  });

  it("skips lines that are not watch envelopes", () => {
    expect(Option.isNone(parseWatchLine("not json"))).toBe(true);
    expect(Option.isNone(parseWatchLine(JSON.stringify({ type: "unknown" })))).toBe(true);
  });
});

describe("runnerOverviewFromSnapshot", () => {
  const HOST = "henrys-mac.local";
  const snapshotOf = (snapshot: object) => {
    const envelope = Option.getOrThrow(
      parseWatchLine(JSON.stringify({ version: 1, type: "snapshot", snapshot })),
    );
    if (envelope.type !== "snapshot") throw new Error("expected a snapshot");
    return envelope.snapshot;
  };

  it("passes through repository release state and screening lane names", () => {
    const release = {
      integrationBranch: "develop",
      candidate: { commitId: "candidate", landedAt: "2026-10-30T12:00:00Z" },
      stagingSkipped: false,
      production: {
        live: { commitId: "live", deployedAt: "2026-10-29T12:00:00Z", healthy: true },
        latestAttempt: {
          commitId: "candidate",
          status: "failed",
          at: "2026-10-30T13:00:00Z",
          reason: "Health check failed",
        },
      },
      images: { commitId: "candidate", status: "built", at: null, reason: null },
      audit: {
        latest: { status: "green", commitId: "live", finishedAt: "2026-10-30T05:00:00Z" },
        nextRunAt: "2026-10-31T05:00:00Z",
      },
      waitingOn: { kind: "audit", detail: "Waiting for tonight's audit" },
    };
    const repositories = [
      { repo: REPO, screeningLanes: 3, today: { landed: 4, failedScreens: 2 }, release },
      {
        repo: "pechhe/agent-config",
        screeningLanes: 0,
        today: { landed: 0, failedScreens: 0 },
        release: null,
      },
    ];
    const overview = runnerOverviewFromSnapshot(
      snapshotOf({
        seq: 1,
        lanes: {
          serial: [{ id: "op_screen", repo: REPO, stage: "checks", title: "Fix export", lane: 2 }],
        },
        repositories,
      }),
      HOST,
    );
    expect(overview.repositories).toEqual(repositories);
    expect(overview.serial[0]).toMatchObject({ title: "Fix export", lane: 2 });
    const old = runnerOverviewFromSnapshot(
      snapshotOf({ seq: 2, lanes: { serial: [{ id: "op_old", repo: REPO, stage: "queued" }] } }),
      HOST,
    );
    expect(old.repositories).toEqual([]);
    expect(old.serial[0]).not.toHaveProperty("title");
    expect(old.serial[0]).not.toHaveProperty("lane");
  });

  it("names this host's submitting workspace, by name or by path, and no other", () => {
    expect(submittingWorkspace(`${HOST}:ys-calendar-fix`, HOST)).toBe("ys-calendar-fix");
    expect(submittingWorkspace(`${HOST}:/Users/h/.slipjay/workspaces/ys-spare/`, HOST)).toBe(
      "ys-spare",
    );
    expect(submittingWorkspace("other-host:ys-calendar-fix", HOST)).toBeUndefined();
    expect(submittingWorkspace("promotion:op_1", HOST)).toBeUndefined();
  });

  it("keeps lane order, each landing's Spec and the latest deploys, and drops run details", () => {
    const overview = runnerOverviewFromSnapshot(
      snapshotOf({
        seq: 9,
        lanes: {
          serial: [
            {
              id: "op_running",
              kind: "landing",
              repo: REPO,
              changeId: "c1",
              stage: "verifying",
              status: "running",
              position: 1,
              submittedBy: `${HOST}:ys-one`,
              runs: [{ command: "bun install", commandEvidence: { environmentNames: ["SECRET"] } }],
            },
            {
              id: "op_queued",
              kind: "landing",
              repo: REPO,
              changeId: "c2",
              stage: "queued",
              status: "queued",
              position: 2,
              submittedBy: "other-host:ys-two",
              spec: 189,
            },
          ],
          deploy: [],
        },
        paused: null,
        lastStagingDeploys: [
          {
            id: "op_staging",
            kind: "deploy",
            repo: REPO,
            stage: "deploying",
            status: "deployed",
            environment: "staging",
            commitId: "bbb",
            finishedAt: "2026-10-16T12:30:00.000Z",
          },
        ],
        recentProductionDeploys: [
          {
            id: "op_production",
            kind: "deploy",
            repo: REPO,
            stage: "deploying",
            status: "deployed",
            environment: "production",
            commitId: "aaa",
            finishedAt: "2026-10-16T00:20:00.000Z",
          },
        ],
      }),
      HOST,
    );
    expect(overview.paused).toBe(false);
    expect(
      overview.serial.map((operation) => [
        operation.operationId,
        operation.workspaceName,
        operation.spec,
      ]),
    ).toEqual([
      ["op_running", "ys-one", undefined],
      ["op_queued", undefined, 189],
    ]);
    expect(JSON.stringify(overview)).not.toContain("SECRET");
    expect(overview.deploys.map((deploy) => [deploy.environment, deploy.commitId])).toEqual([
      ["staging", "bbb"],
      ["production", "aaa"],
    ]);
  });

  it("skips a deploy entry it cannot read and keeps the rest of the snapshot", () => {
    const overview = runnerOverviewFromSnapshot(
      snapshotOf({
        seq: 2,
        lanes: { serial: [], deploy: [{ id: "op_bad" }] },
        lastStagingDeploys: [
          { id: "op_bad", environment: "staging" },
          {
            id: "op_staging",
            repo: REPO,
            stage: "deploying",
            status: "deployed",
            environment: "staging",
            commitId: "bbb",
          },
        ],
      }),
      HOST,
    );
    expect(overview.deploy).toEqual([]);
    expect(overview.deploys.map((deploy) => deploy.operationId)).toEqual(["op_staging"]);
  });

  it("carries when the running stage started and its median, without the rest of the timing", () => {
    const overview = runnerOverviewFromSnapshot(
      snapshotOf({
        seq: 3,
        lanes: {
          serial: [
            {
              id: "op_running",
              repo: REPO,
              changeId: "c1",
              stage: "verifying",
              status: "running",
              stageStartedAt: "2026-10-17T15:00:00.000Z",
              timing: { state: "normal", medianMs: 77_000, amberAfterMs: 154_000, samples: 85 },
              submittedBy: `${HOST}:ys-one`,
            },
            {
              id: "op_queued",
              repo: REPO,
              changeId: "c2",
              stage: "queued",
              status: "queued",
              timing: { state: "unknown", medianMs: null, samples: 0 },
              submittedBy: `${HOST}:ys-two`,
            },
          ],
        },
      }),
      HOST,
    );
    expect(
      overview.serial.map(({ stageStartedAt, stageMedianMs }) => [stageStartedAt, stageMedianMs]),
    ).toEqual([
      ["2026-10-17T15:00:00.000Z", 77_000],
      [undefined, undefined],
    ]);
    expect(JSON.stringify(overview)).not.toContain("amberAfterMs");
  });

  it("dates a running operation's start from its first command run, and not before one", () => {
    const overview = runnerOverviewFromSnapshot(
      snapshotOf({
        seq: 4,
        lanes: {
          serial: [
            {
              id: "op_running",
              repo: REPO,
              stage: "verifying",
              status: "running",
              submittedAt: "2026-10-17T14:30:00.000Z",
              stageStartedAt: "2026-10-17T15:00:00.000Z",
              runs: [
                { startedAt: "2026-10-17T14:55:00.000Z", purpose: "dependencies" },
                { startedAt: "2026-10-17T15:00:01.000Z", purpose: "gate" },
              ],
              submittedBy: `${HOST}:ys-one`,
            },
            {
              id: "op_fetching",
              repo: REPO,
              stage: "fetching",
              status: "running",
              stageStartedAt: "2026-10-17T15:01:00.000Z",
              runs: [],
              submittedBy: `${HOST}:ys-two`,
            },
            {
              id: "op_queued",
              repo: REPO,
              stage: "queued",
              status: "queued",
              submittedAt: "2026-10-17T14:40:00.000Z",
              submittedBy: `${HOST}:ys-three`,
            },
          ],
        },
      }),
      HOST,
    );
    expect(overview.serial.map((operation) => operation.startedAt)).toEqual([
      "2026-10-17T14:55:00.000Z",
      undefined,
      undefined,
    ]);
  });

  it("reports a paused queue", () => {
    const overview = runnerOverviewFromSnapshot(
      snapshotOf({ seq: 1, lanes: { serial: [] }, paused: { by: "owner" } }),
      HOST,
    );
    expect(overview.paused).toBe(true);
    expect(overview.deploy).toEqual([]);
  });
});

describe("landing detail", () => {
  it("reads when it ran, what it published and each current check", () => {
    const detail = Option.getOrThrow(
      parseLandingDetail(
        JSON.stringify({
          status: "failed",
          stage: "verifying",
          terminal: true,
          submittedAt: "2026-10-18T14:31:57.449Z",
          finishedAt: "2026-10-18T14:34:41.342Z",
          identity: { type: "identity", workspace: "t3-landing", machine: "mac" },
          publication: { state: "unpublished", base: "087f8b4" },
          failure: { reason: "a gate failed", stage: "verifying" },
          runs: [
            {
              command: "vp test",
              purpose: "gate",
              outcome: "failed",
              durationMs: 900,
              invalidated: true,
            },
            {
              command: "vp test",
              purpose: "gate",
              outcome: "failed",
              durationMs: 1200,
              failingTests: ["chip > tears"],
              invalidated: false,
            },
            { command: "vp typecheck", purpose: "gate", outcome: "incomplete", durationMs: null },
          ],
        }),
      ),
    );
    expect(detail).toEqual({
      status: "failed",
      stage: "verifying",
      terminal: true,
      submittedAt: "2026-10-18T14:31:57.449Z",
      finishedAt: "2026-10-18T14:34:41.342Z",
      workspace: "t3-landing",
      baseCommitId: "087f8b4",
      failure: { reason: "a gate failed", stage: "verifying" },
      checks: [
        {
          command: "vp test",
          purpose: "gate",
          outcome: "failed",
          durationMs: 1200,
          failingTests: ["chip > tears"],
        },
        { command: "vp typecheck", purpose: "gate", outcome: "incomplete", failingTests: [] },
      ],
    });
  });

  it("is none for output that is not an outcome", () => {
    expect(Option.isNone(parseLandingDetail("SlipJay: no such operation"))).toBe(true);
  });
});
