import { describe, expect, it } from "@effect/vitest";
import * as Option from "effect/Option";

import {
  applyLandingOutcome,
  applyWatchEnvelope,
  initialLandingWatchState,
  landingForChange,
  parseLandingOutcome,
  parseWatchLine,
  resolveWorkspaceLanding,
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
