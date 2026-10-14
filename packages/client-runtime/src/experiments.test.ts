import {
  EnvironmentId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type AgentTaskBinding,
  type ExperimentAssignment,
  type ExperimentWorkReport,
  type ExperimentWorkUnit,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";
import {
  compareWorkTreatment,
  describeAssignmentUnit,
  describeUsage,
  describeWorkDeviation,
  describeWorkExclusion,
  describeWorkTaskLaunch,
  orchestrationControlsError,
} from "./experiments.ts";

const hash = "a".repeat(64);
const parent = { instanceId: ProviderInstanceId.make("codex"), model: "gpt-6.1-sol" };
const controls = {
  orchestratorSelection: parent,
  policyHash: hash,
  reviewerPolicyRevision: "r1",
  verificationRevision: "v1",
  concurrency: 2,
};
const usage = {
  status: "partial" as const,
  inputTokens: null,
  outputTokens: 120,
  cachedInputTokens: null,
  cacheCreationTokens: null,
  reasoningTokens: null,
  missingTurns: 1,
  partialTurns: 0,
  hasUnattributedSubagentUsage: false,
};

function unit(overrides: Partial<ExperimentWorkUnit> = {}): ExperimentWorkUnit {
  return {
    id: "work:1",
    workId: "ticket-9",
    description: "Expose policy management",
    taskCategory: "implementation",
    taskClass: "non-ui",
    sourceRevision: null,
    owner: {
      environmentId: EnvironmentId.make("env"),
      projectId: ProjectId.make("project"),
      workspacePath: "/work",
      parentThreadId: null,
      externalSessionKey: "session",
      clientSessionId: "client",
    },
    orchestratorSelection: parent,
    modelSource: "self-report",
    policyHash: hash,
    policyRevision: "p1",
    createdAt: "2026-10-14T10:00:00.000Z",
    assignmentIds: ["assignment:1"],
    assignedPolicies: [{ experimentId: "trial", allocationPolicy: "inline-first", controls }],
    exclusions: [],
    ...overrides,
  };
}

function work(overrides: Partial<ExperimentWorkReport> = {}): ExperimentWorkReport {
  return {
    overlapMs: null,
    tasks: [],
    turns: [],
    runs: [],
    wallClockMs: null,
    activeMs: null,
    unit: unit(),
    allocations: [],
    evidence: [],
    assignmentIds: ["assignment:1"],
    actualAllocation: null,
    deviations: [],
    parentCoverage: "unavailable",
    childCoverage: "not-applicable",
    parentUsage: usage,
    childUsage: usage,
    usage,
    observedUsage: usage,
    elapsedToAcceptedMs: null,
    phaseMs: {
      briefing: null,
      startup: null,
      wait: null,
      execution: null,
      inspection: null,
      rework: null,
      verification: null,
      advice: null,
    },
    independentlySupportedAcceptance: false,
    outcomes: [],
    coExposureIds: [],
    ...overrides,
  };
}

function task(launchState: string | null): ExperimentWorkReport["tasks"][number] {
  const binding: AgentTaskBinding = {
    role: "implementation-worker",
    taskClass: "non-ui",
    workId: "ticket-9",
    attemptId: "1",
    workspacePath: "/work",
    requestFingerprint: hash,
    policyHash: hash,
    policyRevision: "p1",
    briefHash: hash,
    sourceAccess: "scoped-write",
    toolProfile: "implementation",
    requested: { instanceId: ProviderInstanceId.make("claude"), model: "claude-sonnet-5-5" },
    assigned: null,
    effective: { instanceId: ProviderInstanceId.make("claude"), model: "claude-sonnet-5-5" },
  };
  return { taskId: "task", threadId: ThreadId.make("child"), binding, launchState };
}

describe("orchestration-policy treatment comparison", () => {
  it("separates the assigned policy from the actual allocation", () => {
    expect(compareWorkTreatment(work(), "trial")).toEqual({
      assignedPolicy: "inline-first",
      actualAllocation: null,
      status: "undecided",
    });
    expect(compareWorkTreatment(work({ actualAllocation: "inline" }), "trial").status).toBe(
      "matches",
    );
    expect(compareWorkTreatment(work({ actualAllocation: "delegated" }), "trial").status).toBe(
      "differs",
    );
  });

  it("only reads the assignment made by the trial being inspected", () => {
    expect(compareWorkTreatment(work({ actualAllocation: "inline" }), "other-trial")).toEqual({
      assignedPolicy: null,
      actualAllocation: "inline",
      status: "not-assigned",
    });
  });

  it("labels parent-stated deviations as self-reports and observed changes as observations", () => {
    expect(describeWorkDeviation("needed the lead's context")).toBe(
      "Parent-stated: needed the lead's context",
    );
    expect(describeWorkDeviation("observed-child-selection-changed")).not.toContain(
      "Parent-stated",
    );
  });
});

describe("work task launch", () => {
  it("reports a refused route as an explicit block naming the route, without a substitute", () => {
    const launch = describeWorkTaskLaunch(task("refused"));
    expect(launch.label).toBe("refused before launch");
    expect(launch.blockedReason).toContain("implementation-worker");
    expect(launch.blockedReason).toContain("claude-sonnet-5-5");
    expect(launch.blockedReason).toContain("No other model or wider permission was substituted");
  });

  it("does not present an unknown launch as blocked or accepted", () => {
    expect(describeWorkTaskLaunch(task("launch-unknown"))).toEqual({
      label: "launch outcome unknown; inspect before retrying",
      blockedReason: null,
    });
    expect(describeWorkTaskLaunch(task("accepted")).blockedReason).toBeNull();
  });
});

describe("usage presentation", () => {
  it("shows missing counters as unavailable rather than zero", () => {
    const text = describeUsage(usage);
    expect(text).toContain("input unavailable");
    expect(text).toContain("output 120");
    expect(text).toContain("1 missing turns");
    expect(text).not.toMatch(/input 0\b/);
    expect(text).not.toMatch(/\$|cost|charge/i);
  });
});

describe("orchestration-policy draft controls", () => {
  const valid = {
    orchestratorSelection: parent,
    policyHash: hash,
    reviewerPolicyRevision: "r1",
    verificationRevision: "v1",
    concurrency: 1,
  };

  it("accepts complete fixed controls", () => {
    expect(orchestrationControlsError(valid)).toBeNull();
  });

  it("rejects missing or malformed controls before saving", () => {
    expect(orchestrationControlsError({ ...valid, orchestratorSelection: null })).not.toBeNull();
    expect(orchestrationControlsError({ ...valid, policyHash: "abc" })).not.toBeNull();
    expect(orchestrationControlsError({ ...valid, verificationRevision: " " })).not.toBeNull();
    expect(orchestrationControlsError({ ...valid, concurrency: 0 })).not.toBeNull();
    expect(orchestrationControlsError({ ...valid, concurrency: 1.5 })).not.toBeNull();
  });
});

describe("assignment description", () => {
  const base: ExperimentAssignment = {
    id: "assignment:1",
    experimentId: "trial",
    revision: 1,
    lever: "orchestration-policy",
    unitKind: "work",
    unitId: "work:1",
    threadId: null,
    projectId: ProjectId.make("project"),
    taskCategory: "implementation",
    boundaryRunId: null,
    variant: { id: "inline-first", label: "Inline-first", allocationPolicy: "inline-first" },
    assignedModelSelection: parent,
    enrollment: "new",
    assignmentMethod: "randomized",
    assignedAt: "2026-10-14T10:00:00.000Z",
    codeRevision: null,
    briefRevision: null,
    provenance: null,
  };

  it("describes an external parent's work unit without inventing a thread", () => {
    const description = describeAssignmentUnit({ ...base, work: unit() });
    expect(description.title).toBe("Work ticket-9: Expose policy management");
    expect(description.owner).toBe("External parent session");
    expect(description.modelLabel).toContain("Parent model");
  });

  it("keeps thread and task assignments unchanged", () => {
    expect(
      describeAssignmentUnit({
        ...base,
        lever: "delegation",
        unitKind: "task",
        unitId: "task-1",
        threadId: ThreadId.make("thread-1"),
      }),
    ).toEqual({ title: "task: task-1", owner: "Thread thread-1", modelLabel: "Model" });
  });

  it("explains known exclusion reasons and preserves unknown ones", () => {
    expect(describeWorkExclusion("work-already-started")).toContain("already started");
    expect(describeWorkExclusion("new-reason")).toBe("new-reason");
  });
});
