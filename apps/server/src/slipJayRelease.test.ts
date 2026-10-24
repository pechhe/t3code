import { describe, expect, it } from "@effect/vitest";
import { isSlipJayWorkspacePath, parseReleaseResult, releaseOperationId, releaseSlipJayWorkspace, restoreSlipJayWorkspace } from "./slipJayRelease.ts";

const runner = (code: number, stdout: string, stderr = "") =>
  async () => ({ code, stdout, stderr });

describe("releasing a SlipJay workspace from cleanup", () => {
  it("reuses one operation id for a retry, and a new one after a resume", () => {
    const first = releaseOperationId("thread-1", "/home/h/.slipjay/workspaces/ys-12", "2026-10-24T04:00:00.000Z");
    const retry = releaseOperationId("thread-1", "/home/h/.slipjay/workspaces/ys-12", "2026-10-24T04:00:00.000Z");
    const resumed = releaseOperationId("thread-1", "/home/h/.slipjay/workspaces/ys-12", "2026-10-25T09:00:00.000Z");
    expect(retry).toBe(first);
    expect(resumed).not.toBe(first);
    // SlipJay records plain, short names; a path never leaks into the id.
    expect(first).toMatch(/^[A-Za-z0-9._-]{1,128}$/u);
    expect(first).not.toContain("slipjay");
  });

  it("reads the result from the last JSON line, whatever was logged before it", () => {
    const stdout = 'installing\ndeps ready\n{"state":"retired","operationId":"t3-x","archiveId":"abc"}\n';
    expect(parseReleaseResult(stdout)).toEqual({ state: "retired", archiveId: "abc" });
    expect(parseReleaseResult("nothing here")).toBeNull();
    expect(parseReleaseResult("{not json}")).toBeNull();
  });

  it("reports a retirement with its archive", async () => {
    const outcome = await releaseSlipJayWorkspace({
      workspacePath: "/w", threadId: "t", settledAt: null,
      run: runner(0, '{"state":"retired","archiveId":"a1"}'),
    });
    expect(outcome).toEqual({ kind: "retired", archiveId: "a1" });
  });

  it("keeps a checkout SlipJay refuses, and says why", async () => {
    const outcome = await releaseSlipJayWorkspace({
      workspacePath: "/w", threadId: "t", settledAt: null,
      run: runner(1, '{"state":"refused","reason":"in use by a live process"}'),
    });
    expect(outcome).toEqual({ kind: "refused", reason: "in use by a live process" });
  });

  it("does not call an uncertain answer a success", async () => {
    const outcome = await releaseSlipJayWorkspace({
      workspacePath: "/w", threadId: "t", settledAt: null,
      run: runner(2, '{"state":"uncertain","reason":"removal may have half-finished"}'),
    });
    expect(outcome).toEqual({ kind: "uncertain", reason: "removal may have half-finished" });
  });

  it("treats a missing slipjay as unavailable, never as permission to remove", async () => {
    const outcome = await releaseSlipJayWorkspace({
      workspacePath: "/w", threadId: "t", settledAt: null,
      run: async () => { throw new Error("spawn slipjay ENOENT"); },
    });
    expect(outcome.kind).toBe("unavailable");
    const noResult = await releaseSlipJayWorkspace({ workspacePath: "/w", threadId: "t", settledAt: null, run: runner(0, "oops") });
    expect(noResult.kind).toBe("unavailable");
  });
});

describe("restoring a released workspace on resume", () => {
  it("restores the newest archive of the path, in place", async () => {
    const calls: string[] = [];
    const outcome = await restoreSlipJayWorkspace({
      workspacePath: "/home/h/.slipjay/workspaces/ys-12",
      run: async (command, args) => {
        calls.push([command, ...args].join(" "));
        return { code: 0, stdout: '{"state":"restored","archiveId":"a1","workspacePath":"/home/h/.slipjay/workspaces/ys-12"}', stderr: "" };
      },
    });
    expect(outcome).toEqual({ kind: "restored", workspacePath: "/home/h/.slipjay/workspaces/ys-12" });
    expect(calls).toEqual(["slipjay restore --latest --path /home/h/.slipjay/workspaces/ys-12"]);
  });

  it("reports a missing archive rather than offering a branch checkout", async () => {
    const outcome = await restoreSlipJayWorkspace({
      workspacePath: "/w",
      run: async () => ({ code: 1, stdout: "", stderr: "No archive of /w to restore." }),
    });
    expect(outcome.kind).toBe("unavailable");
    expect(outcome.kind === "unavailable" && outcome.reason).toContain("No archive of /w to restore.");
  });

  it("knows a SlipJay home, and nothing else", () => {
    expect(isSlipJayWorkspacePath("/home/h/.slipjay/workspaces/ys-1", "/home/h", "/")).toBe(true);
    expect(isSlipJayWorkspacePath("/home/h/Engineering/t3code/.worktrees/a", "/home/h", "/")).toBe(false);
    expect(isSlipJayWorkspacePath("/home/h/.slipjay/workspaces-other/x", "/home/h", "/")).toBe(false);
    expect(isSlipJayWorkspacePath("/home/h/.slipjay/workspaces/ys-1", "", "/")).toBe(false);
  });
});
