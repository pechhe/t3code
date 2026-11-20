import { describe, expect, it } from "vite-plus/test";
import {
  isProjectSelectionRequired,
  isUnstartedThreadShell,
  serverThreadOwnsDraft,
  shouldLaunchWarmThread,
  shouldRenewDraftThread,
  warmThreadsToDiscard,
} from "./draftWarmThread.logic";

const session = (
  threadId: string,
  extra: { promotedTo?: { environmentId: string; threadId: string } } = {},
) => ({
  environmentId: "env",
  threadId,
  ...extra,
});

describe("isProjectSelectionRequired", () => {
  it.each([
    { isDraft: true, hasProject: true, projectUnchosen: true, required: true },
    { isDraft: true, hasProject: false, projectUnchosen: false, required: true },
    { isDraft: true, hasProject: true, projectUnchosen: false, required: false },
    { isDraft: false, hasProject: false, projectUnchosen: true, required: false },
  ])("locks typing only for a draft without a chosen project: %j", ({ required, ...input }) => {
    expect(isProjectSelectionRequired(input)).toBe(required);
  });
});

describe("shouldLaunchWarmThread", () => {
  const ready = {
    hasDraftSession: true,
    promoted: false,
    projectChosen: true,
    hasProject: true,
    shellExists: false,
    alreadyAttempted: false,
    canOperate: true,
    environmentResolved: true,
  };
  it("launches a draft whose project is chosen, once", () => {
    expect(shouldLaunchWarmThread(ready)).toBe(true);
    expect(shouldLaunchWarmThread({ ...ready, alreadyAttempted: true })).toBe(false);
    expect(shouldLaunchWarmThread({ ...ready, shellExists: true })).toBe(false);
  });
  it.each([
    { projectChosen: false },
    { hasProject: false },
    { promoted: true },
    { hasDraftSession: false },
    { canOperate: false },
    { environmentResolved: false },
  ])("waits while %j", (override) => {
    expect(shouldLaunchWarmThread({ ...ready, ...override })).toBe(false);
  });
});

describe("thread shell state", () => {
  it("tells a launched draft from a started conversation", () => {
    expect(isUnstartedThreadShell({ latestRun: null, latestUserMessageAt: null })).toBe(true);
    expect(isUnstartedThreadShell({ latestRun: {}, latestUserMessageAt: null })).toBe(false);
    expect(isUnstartedThreadShell({ latestRun: null, latestUserMessageAt: "now" })).toBe(false);
    expect(isUnstartedThreadShell(null)).toBe(false);
    // A launched thread whose shell has not reached the client yet must not promote its draft.
    expect(serverThreadOwnsDraft(null)).toBe(false);
    expect(serverThreadOwnsDraft({ latestRun: null, latestUserMessageAt: null })).toBe(false);
    expect(serverThreadOwnsDraft({ latestRun: null, latestUserMessageAt: "now" })).toBe(true);
  });
});

describe("shouldRenewDraftThread", () => {
  const gone = {
    promoted: false,
    shellExists: false,
    launchSeen: true,
    launchRefused: false,
    renewedAfterRefusal: false,
  };
  it.each([
    { ...gone, renew: true },
    { ...gone, launchSeen: false, launchRefused: true, renew: true },
    { ...gone, launchSeen: false, launchRefused: true, renewedAfterRefusal: true, renew: false },
    { ...gone, launchSeen: false, renew: false },
    { ...gone, shellExists: true, renew: false },
    { ...gone, promoted: true, renew: false },
  ])(
    "gives an unsent draft a fresh id once its launched thread is gone: %j",
    ({ renew, ...input }) => {
      expect(shouldRenewDraftThread(input)).toBe(renew);
    },
  );
});

describe("warmThreadsToDiscard", () => {
  it("gives back the thread of a discarded draft", () => {
    expect(warmThreadsToDiscard({ d1: session("t1") }, {})).toEqual([
      { environmentId: "env", threadId: "t1" },
    ]);
  });
  it("gives back the old thread when switching project mints a new one", () => {
    expect(warmThreadsToDiscard({ d1: session("t1") }, { d1: session("t2") })).toEqual([
      { environmentId: "env", threadId: "t1" },
    ]);
  });
  it("gives back the thread of a launched draft that switches from No project to a project", () => {
    const scratch = { environmentId: "env", threadId: "dd00", promotedTo: null };
    const project = { environmentId: "env", threadId: "8ce1", promotedTo: null };
    expect(warmThreadsToDiscard({ draft: scratch }, { draft: project })).toEqual([
      { environmentId: "env", threadId: "dd00" },
    ]);
  });
  it("keeps a thread the draft still names or has sent", () => {
    expect(warmThreadsToDiscard({ d1: session("t1") }, { d1: session("t1") })).toEqual([]);
    const sent = { environmentId: "env", threadId: "t1" };
    expect(
      warmThreadsToDiscard({ d1: session("t1") }, { d1: session("t1", { promotedTo: sent }) }),
    ).toEqual([]);
    expect(warmThreadsToDiscard({ d1: session("t1", { promotedTo: sent }) }, {})).toEqual([]);
  });
  it("keeps a thread another draft took over", () => {
    expect(warmThreadsToDiscard({ d1: session("t1") }, { d2: session("t1") })).toEqual([]);
  });
});
