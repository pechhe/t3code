import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { expect, it } from "@effect/vitest";
import {
  EnvironmentId,
  EventId,
  ProjectId,
  ProviderInstanceId,
  ProviderThreadId,
  ProviderTurnId,
  MessageId,
  NodeId,
  RunId,
  ThreadId,
  type AgentTaskBinding,
  type ExperimentDefinition,
  type ExperimentWorkOwner,
  type ExperimentWorkEvidenceInput,
  type ExperimentWorkUnit,
  type ModelSelection,
  type OrchestrationV2Run,
  type TurnTokenUsage,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as TestClock from "effect/testing/TestClock";
import * as ProjectionStore from "../orchestration-v2/ProjectionStore.ts";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as AgentPolicyStore from "../agents/AgentPolicyStore.ts";
import {
  request as taskRequest,
  snapshot as policySnapshot,
} from "../agents/agentPolicy.testkit.ts";
import * as Experiments from "./ExperimentService.ts";

const layerExperiments = Experiments.layer.pipe(Layer.provide(NodeCrypto.layer));
const dependencies = Layer.merge(ProjectionStore.layer, AgentPolicyStore.layer).pipe(
  Layer.provideMerge(Sqlite.layerMemory),
);
const layer = layerExperiments.pipe(Layer.provideMerge(dependencies));
const selection: ModelSelection = {
  instanceId: ProviderInstanceId.make("codex"),
  model: "gpt-5.4",
};
const changedSelection: ModelSelection = {
  instanceId: ProviderInstanceId.make("claude"),
  model: "claude-sonnet-5-5",
};
const projectId = ProjectId.make("project:work-experiment");
const environmentId = EnvironmentId.make("environment:work-experiment");
const parentThreadId = ThreadId.make("thread:work-experiment-parent");
const workspacePath = "/fixture/work-experiment";

const policyDefinition = (id = "orchestration-policy"): ExperimentDefinition => {
  const policy = policySnapshot();
  return {
    id,
    title: "Inline first or delegate earlier",
    question: "Which orchestration policy completes coherent work better?",
    lever: "orchestration-policy",
    orchestrationControls: {
      orchestratorSelection: selection,
      policyHash: policy.hash,
      reviewerPolicyRevision: "reviewer-policy-r1",
      verificationRevision: "verification-r1",
      concurrency: 2,
    },
    primaryOutcome: "Independently accepted completion",
    variants: [
      { id: "inline-first", label: "Inline first", allocationPolicy: "inline-first" },
      { id: "delegate-earlier", label: "Delegate earlier", allocationPolicy: "delegate-earlier" },
    ],
    eligibility: { projectIds: [], models: [], taskCategories: ["implementation-worker"] },
    maxAssignments: 100,
    endsAt: "2999-01-01T00:00:00Z",
    stopConditions: ["Safety or quality regression"],
    codeRevision: "commit:test",
    briefRevision: null,
  };
};

const delegationDefinition = (): ExperimentDefinition => ({
  id: "delegation-overlap",
  title: "Delegation model",
  question: "Does delegation help?",
  lever: "delegation",
  primaryOutcome: "Completion",
  variants: [
    { id: "baseline", label: "Baseline", modelSelection: selection },
    { id: "alternate", label: "Alternate", modelSelection: changedSelection },
  ],
  eligibility: { projectIds: [], models: [], taskCategories: ["implementation-worker"] },
  maxAssignments: 100,
  endsAt: "2999-01-01T00:00:00Z",
  stopConditions: ["Review constraint misses"],
  codeRevision: "commit:test",
  briefRevision: null,
});

const internalOwner = (): ExperimentWorkOwner => ({
  environmentId,
  projectId,
  workspacePath,
  parentThreadId,
  externalSessionKey: null,
  clientSessionId: null,
});

const externalOwner = (): ExperimentWorkOwner => ({
  environmentId,
  projectId,
  workspacePath,
  parentThreadId: null,
  externalSessionKey: "a".repeat(64),
  clientSessionId: "mcp-client:experiment-owner",
});

const ownerReader = (owner: ExperimentWorkOwner) => ({
  environmentId,
  ...(owner.parentThreadId === null
    ? { clientSessionId: owner.clientSessionId! }
    : { threadId: owner.parentThreadId }),
});

const enroll = (
  service: Experiments.ExperimentService["Service"],
  owner: ExperimentWorkOwner,
  workId: string,
  overrides: Partial<Parameters<Experiments.ExperimentService["Service"]["enrollWork"]>[0]> = {},
) => {
  const policy = policySnapshot();
  return service.enrollWork({
    request: {
      workId,
      description: `Coherent work ${workId}`,
      taskCategory: "implementation-worker",
      sourceRevision: "revision:source",
    },
    owner,
    orchestratorSelection: selection,
    modelSource: "run-selection",
    policyHash: policy.hash,
    policyRevision: policy.sourceRevision,
    alreadyStarted: false,
    ...overrides,
  });
};

const startPolicyExperiment = (service: Experiments.ExperimentService["Service"]) =>
  Effect.gen(function* () {
    yield* service.create(policyDefinition());
    yield* service.transition({ experimentId: "orchestration-policy", status: "running" });
  });

const savePolicySnapshot = Effect.gen(function* () {
  const store = yield* AgentPolicyStore.AgentPolicyStore;
  yield* store.save(policySnapshot());
});

const workEvidence = (
  id: string,
  workUnitId: string,
  overrides: Partial<ExperimentWorkEvidenceInput> = {},
): ExperimentWorkEvidenceInput => ({
  id,
  workUnitId,
  actor: "parent",
  phase: "execution",
  attribution: "unavailable",
  threadId: null,
  providerTurnId: null,
  externalSegmentId: null,
  startedAt: null,
  completedAt: null,
  usage: null,
  evidence: [],
  ...overrides,
});

const bindingFor = (unit: ExperimentWorkUnit, attemptId: string): AgentTaskBinding => {
  const policy = policySnapshot();
  const req = taskRequest({
    workUnitId: unit.id,
    workId: unit.workId,
    attemptId,
    workspacePath: unit.owner.workspacePath,
    sourceRevision: unit.sourceRevision ?? undefined,
  });
  return {
    ...req,
    requestFingerprint: "c".repeat(64),
    policyHash: unit.policyHash,
    policyRevision: unit.policyRevision ?? policy.sourceRevision,
    briefHash: policy.briefs[req.role]!.hash,
    sourceAccess: policy.manifest.roles[req.role]!.sourceAccess,
    toolProfile: policy.manifest.roles[req.role]!.toolProfile,
    requested: selection,
    assigned: null,
    effective: selection,
  };
};

const allocateDelegated = (
  service: Experiments.ExperimentService["Service"],
  owner: ExperimentWorkOwner,
  unit: ExperimentWorkUnit,
  suffix: string,
) =>
  Effect.gen(function* () {
    const policy = unit.assignedPolicies[0]?.allocationPolicy;
    yield* service.allocateWork(
      {
        id: `allocation:${suffix}`,
        workUnitId: unit.id,
        allocation: "delegated",
        reason: "Parallel implementation work benefits from a delegated task.",
        deviationReason: policy === "inline-first" ? "The task is independently actionable." : null,
      },
      ownerReader(owner),
    );
    const threadId = ThreadId.make(`thread:child:${suffix}`);
    const binding = bindingFor(unit, `attempt:${suffix}`);
    yield* service.registerWorkTask({
      workUnitId: unit.id,
      owner,
      binding,
      taskId: `task:${suffix}`,
      threadId,
    });
    return { binding, threadId, taskId: `task:${suffix}` };
  });

const addThread = Effect.fn(function* (id: ThreadId) {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const now = yield* DateTime.now;
  yield* store.apply({
    id: EventId.make(`event:${id}:created`),
    type: "thread.created",
    threadId: id,
    occurredAt: now,
    payload: {
      createdBy: "user",
      creationSource: "web",
      id,
      projectId,
      title: String(id),
      providerInstanceId: selection.instanceId,
      modelSelection: selection,
      runtimeMode: "full-access",
      interactionMode: "default",
      branch: null,
      worktreePath: workspacePath,
      activeProviderThreadId: null,
      lineage: { parentThreadId: null, relationshipToParent: null, rootThreadId: id },
      forkedFrom: null,
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      settledOverride: null,
      settledAt: null,
      lastVisitedAt: null,
      deletedAt: null,
    },
  });
});

const usage = (inputTokens: number, outputTokens: number): TurnTokenUsage => ({
  usageScope: "main_agent",
  usageStatus: "complete",
  inputTokens,
  outputTokens,
  hasSubagents: false,
});

const addParentTurn = Effect.fn(function* (
  suffix: string,
  turnUsage: TurnTokenUsage | null,
  threadId = parentThreadId,
  span?: { start: number; end: number },
) {
  const store = yield* ProjectionStore.ProjectionStoreV2;
  const now = yield* DateTime.now;
  const runId = RunId.make(`run:${suffix}`);
  const nodeId = NodeId.make(`node:${suffix}`);
  const providerThreadId = ProviderThreadId.make(`provider:${suffix}`);
  const providerTurnId = ProviderTurnId.make(`turn:${suffix}`);
  const run: OrchestrationV2Run = {
    id: runId,
    threadId,
    ordinal: 1,
    providerInstanceId: selection.instanceId,
    modelSelection: selection,
    providerThreadId,
    userMessageId: MessageId.make(`message:${suffix}`),
    rootNodeId: nodeId,
    activeAttemptId: null,
    status: "completed",
    requestedAt: now,
    startedAt: null,
    completedAt: now,
    checkpointId: null,
    contextHandoffId: null,
  };
  yield* store.apply({
    id: EventId.make(`event:${suffix}:run`),
    type: "run.created",
    threadId,
    runId,
    nodeId,
    occurredAt: now,
    payload: run,
  });
  yield* store.apply({
    id: EventId.make(`event:${suffix}:node`),
    type: "node.updated",
    threadId,
    runId,
    nodeId,
    occurredAt: now,
    payload: {
      id: nodeId,
      threadId,
      runId,
      parentNodeId: null,
      rootNodeId: nodeId,
      kind: "root_turn",
      status: "completed",
      countsForRun: true,
      providerThreadId,
      providerTurnId,
      nativeItemRef: null,
      runtimeRequestId: null,
      checkpointScopeId: null,
      startedAt: now,
      completedAt: now,
    },
  });
  yield* store.apply({
    id: EventId.make(`event:${suffix}:turn`),
    type: "provider-turn.updated",
    threadId,
    runId,
    nodeId,
    occurredAt: now,
    payload: {
      id: providerTurnId,
      providerThreadId,
      nodeId,
      runAttemptId: null,
      nativeTurnRef: null,
      ordinal: 1,
      status: "completed",
      startedAt: span === undefined ? now : DateTime.makeUnsafe(span.start),
      completedAt: span === undefined ? now : DateTime.makeUnsafe(span.end),
      ...(turnUsage === null ? {} : { turnTokenUsage: turnUsage }),
    },
  });
  return providerTurnId;
});

it.effect("keeps a thread's instruction assignment through a policy save and a later run", () =>
  Effect.gen(function* () {
    yield* savePolicySnapshot;
    const service = yield* Experiments.ExperimentService;
    const instructions = {
      sourcePath: "skills/lead/SKILL.md",
      revision: "agent-config:abc123",
      text: "Keep each reply under five lines.",
      sha256: "9f2e399e91eddf0580cfa032b906deeb5cd0e1f966f6277c566fbe161f8b818c",
    };
    yield* service.create({
      ...policyDefinition("instructions"),
      lever: "instruction",
      variants: [
        { id: "terse", label: "Terse", instructions },
        {
          id: "thorough",
          label: "Thorough",
          instructions: {
            ...instructions,
            text: "Explain each decision in full.",
            sha256: "3e21fa350ebd30083dc279e80403a951c2a6e3e14b404a0d255f208b81edcfa2",
          },
        },
      ],
      eligibility: { projectIds: [], models: [], taskCategories: [] },
      orchestrationControls: undefined,
    });
    yield* service.transition({ experimentId: "instructions", status: "running" });
    const assign = service.assignForThread({
      threadLever: "instruction",
      threadId: parentThreadId,
      projectId,
      modelSelection: selection,
      enrollment: "new",
      unitCreatedAt: "2998-01-01T00:00:00Z",
    });
    const first = yield* assign;
    expect(first).toHaveLength(1);
    const policyStore = yield* AgentPolicyStore.AgentPolicyStore;
    yield* policyStore.save({ ...policySnapshot(), hash: "f".repeat(64), sourceRevision: "newer" });
    // Each run, a rollover run included, reads the assignment again; it never moves.
    expect(yield* assign).toEqual(first);
    expect(
      yield* service.assignForThread({
        threadLever: "instruction",
        threadId: parentThreadId,
        projectId,
        modelSelection: changedSelection,
        enrollment: "new",
        unitCreatedAt: "2998-01-01T00:00:00Z",
      }),
    ).toEqual(first);
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "enrolls stable work before allocation and pins its policy assignment through retries",
  () =>
    Effect.gen(function* () {
      yield* savePolicySnapshot;
      const service = yield* Experiments.ExperimentService;
      yield* startPolicyExperiment(service);
      const owner = externalOwner();
      const first = yield* enroll(service, owner, "work:stable");
      const assignments = yield* service.assignments(
        { experimentId: "orchestration-policy" },
        ownerReader(owner),
      );
      expect(first.assignmentIds).toHaveLength(1);
      expect(assignments).toHaveLength(1);
      expect(assignments[0]).toMatchObject({
        id: first.assignmentIds[0],
        unitKind: "work",
        unitId: first.id,
        threadId: null,
        variant: { allocationPolicy: expect.any(String) },
      });
      const experiment = (yield* service.list()).find(
        (candidate) => candidate.id === "orchestration-policy",
      )!;
      expect(experiment.orchestrationControls).toEqual(policyDefinition().orchestrationControls);
      expect(assignments[0]?.revision).toBe(experiment.revision);

      yield* service.transition({ experimentId: "orchestration-policy", status: "paused" });
      const policyStore = yield* AgentPolicyStore.AgentPolicyStore;
      const changedPolicy = {
        ...policySnapshot(),
        hash: "f".repeat(64),
        sourceRevision: "policy-newer",
      };
      yield* policyStore.save(changedPolicy);
      const retry = yield* enroll(service, owner, "work:stable", {
        request: {
          workId: "work:stable",
          description: "Coherent work work:stable",
          taskCategory: "implementation-worker",
          sourceRevision: "revision:source",
        },
        orchestratorSelection: changedSelection,
        modelSource: "self-report",
        policyHash: changedPolicy.hash,
        policyRevision: changedPolicy.sourceRevision,
        alreadyStarted: true,
      });
      expect(retry).toEqual(first);
      expect(retry).toMatchObject({
        policyHash: policySnapshot().hash,
        policyRevision: policySnapshot().sourceRevision,
        orchestratorSelection: selection,
        assignmentIds: first.assignmentIds,
      });
      expect(
        (yield* Effect.flip(
          enroll(service, owner, "work:stable", {
            request: {
              workId: "work:stable",
              description: "Different work request",
              taskCategory: "implementation-worker",
              sourceRevision: "revision:source",
            },
          }),
        )).reason,
      ).toBe("conflict");
    }).pipe(Effect.provide(layer)),
);

it.effect("records balanced policy arms and requires evidence for inline deviations", () =>
  Effect.gen(function* () {
    yield* savePolicySnapshot;
    const service = yield* Experiments.ExperimentService;
    yield* startPolicyExperiment(service);
    const owner = internalOwner();
    const units = yield* Effect.forEach(["work:a", "work:b", "work:c", "work:d"], (id) =>
      enroll(service, owner, id),
    );
    const assigned = yield* service.assignments(
      { experimentId: "orchestration-policy" },
      ownerReader(owner),
    );
    expect(new Set(assigned.map((a) => a.variant.allocationPolicy))).toEqual(
      new Set(["inline-first", "delegate-earlier"]),
    );
    expect(assigned.every((a) => a.variant.modelSelection === undefined)).toBe(true);
    expect(
      assigned.every(
        (a) =>
          a.assignedModelSelection.instanceId === selection.instanceId &&
          a.assignedModelSelection.model === selection.model,
      ),
    ).toBe(true);

    let registered = false;
    for (const [index, unit] of units.entries()) {
      const assignment = assigned.find((candidate) => candidate.unitId === unit.id)!;
      const delegateArm = assignment.variant.allocationPolicy === "delegate-earlier";
      const shouldDelegate = delegateArm && !registered;
      const allocation = shouldDelegate ? "delegated" : "inline";
      const deviationReason =
        delegateArm && !shouldDelegate ? "Kept this small task inline." : null;
      const input = {
        id: `allocation:${index}`,
        workUnitId: unit.id,
        allocation,
        reason: shouldDelegate ? "The task is parallelizable." : "The task is tightly coupled.",
        deviationReason,
      } as const;
      if (delegateArm && !shouldDelegate) {
        const rejected = yield* Effect.flip(
          service.allocateWork({ ...input, deviationReason: null }, ownerReader(owner)),
        );
        expect(rejected.reason).toBe("invalid-evidence");
      }
      const recorded = yield* service.allocateWork(input, ownerReader(owner));
      expect(recorded).toMatchObject({ source: "self-report", allocation, deviationReason });
      if (shouldDelegate) {
        yield* service.workDispatchPolicy({ workUnitId: unit.id, owner });
        const policy = policySnapshot();
        const req = taskRequest({
          workUnitId: unit.id,
          workId: unit.workId,
          attemptId: `attempt:${index}`,
          workspacePath: owner.workspacePath,
          sourceRevision: unit.sourceRevision!,
        });
        const binding: AgentTaskBinding = {
          ...req,
          requestFingerprint: "c".repeat(64),
          policyHash: unit.policyHash,
          policyRevision: unit.policyRevision ?? policy.sourceRevision,
          briefHash: policy.briefs[req.role]!.hash,
          sourceAccess: policy.manifest.roles[req.role]!.sourceAccess,
          toolProfile: policy.manifest.roles[req.role]!.toolProfile,
          requested: selection,
          assigned: null,
          effective: selection,
        };
        const mismatchedBinding = { ...binding, sourceRevision: "revision:foreign" };
        expect(
          (yield* Effect.flip(
            service.registerWorkTask({
              workUnitId: unit.id,
              owner,
              binding: mismatchedBinding,
              taskId: `task:mismatch:${index}`,
              threadId: ThreadId.make(`thread:child:mismatch:${index}`),
            }),
          )).reason,
        ).toBe("invalid-evidence");
        yield* service.registerWorkTask({
          workUnitId: unit.id,
          owner,
          binding,
          taskId: `task:${index}`,
          threadId: ThreadId.make(`thread:child:${index}`),
        });
        registered = true;
      } else if (allocation === "inline") {
        const dispatchDenied = yield* Effect.flip(
          service.workDispatchPolicy({ workUnitId: unit.id, owner }),
        );
        expect(dispatchDenied.reason).toBe("invalid-evidence");
      }
    }

    const paged = yield* service.report(
      { experimentId: "orchestration-policy", limit: 1 },
      ownerReader(owner),
    );
    expect(paged.work).toHaveLength(1);
    expect(paged.totalAssignments).toBe(4);
    expect(paged.policySummary?.reduce((total, arm) => total + arm.assignedCount, 0)).toBe(4);
    expect(paged.policySummary?.every((arm) => arm.missingParentCount === arm.assignedCount)).toBe(
      true,
    );
    expect(paged.exclusions).toEqual([]);
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "reserves only the controlled number of pending delegated tasks and retries idempotently",
  () =>
    Effect.gen(function* () {
      yield* savePolicySnapshot;
      const service = yield* Experiments.ExperimentService;
      yield* startPolicyExperiment(service);
      const owner = internalOwner();
      const units = yield* Effect.forEach(
        ["work:reserve-a", "work:reserve-b", "work:reserve-c"],
        (id) => enroll(service, owner, id),
      );
      const assignments = yield* service.assignments(
        { experimentId: "orchestration-policy" },
        ownerReader(owner),
      );
      expect(
        assignments.every((assignment) => assignment.variant.modelSelection === undefined),
      ).toBe(true);

      for (const [index, unit] of units.entries()) {
        const policy = unit.assignedPolicies[0]?.allocationPolicy;
        yield* service.allocateWork(
          {
            id: `allocation:reserve:${index}`,
            workUnitId: unit.id,
            allocation: "delegated",
            reason: "The task is independently actionable.",
            deviationReason:
              policy === "inline-first" ? "Parallel work improves throughput." : null,
          },
          ownerReader(owner),
        );
      }

      const firstThread = ThreadId.make("thread:child:reserve-a");
      const firstBinding = bindingFor(units[0]!, "attempt:reserve-a");
      expect(
        (yield* Effect.flip(
          service.registerWorkTask({
            workUnitId: units[0]!.id,
            owner,
            binding: { ...firstBinding, policyHash: "0".repeat(64) },
            taskId: "task:reserve:wrong-policy",
            threadId: ThreadId.make("thread:child:wrong-policy"),
          }),
        )).reason,
      ).toBe("invalid-evidence");
      expect(
        (yield* Effect.flip(
          service.registerWorkTask({
            workUnitId: units[0]!.id,
            owner,
            binding: { ...firstBinding, taskClass: "ui" },
            taskId: "task:reserve:ui",
            threadId: ThreadId.make("thread:child:ui"),
          }),
        )).reason,
      ).toBe("invalid-evidence");

      const firstTask = {
        workUnitId: units[0]!.id,
        owner,
        binding: firstBinding,
        taskId: "task:reserve:a",
        threadId: firstThread,
      };
      yield* service.registerWorkTask(firstTask);
      yield* service.registerWorkTask(firstTask);
      const secondTask = {
        workUnitId: units[1]!.id,
        owner,
        binding: bindingFor(units[1]!, "attempt:reserve-b"),
        taskId: "task:reserve:b",
        threadId: ThreadId.make("thread:child:reserve-b"),
      };
      yield* service.registerWorkTask(secondTask);
      const third = yield* Effect.flip(
        service.registerWorkTask({
          workUnitId: units[2]!.id,
          owner,
          binding: bindingFor(units[2]!, "attempt:reserve-c"),
          taskId: "task:reserve:c",
          threadId: ThreadId.make("thread:child:reserve-c"),
        }),
      );
      expect(third.reason).toBe("conflict");
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "uses launch receipts to release only definite refusals from the concurrency reservation",
  () =>
    Effect.gen(function* () {
      yield* savePolicySnapshot;
      const service = yield* Experiments.ExperimentService;
      yield* startPolicyExperiment(service);
      const owner = internalOwner();
      const units = yield* Effect.forEach(
        ["work:receipt-a", "work:receipt-b", "work:receipt-c", "work:receipt-d"],
        (id) => enroll(service, owner, id),
      );
      for (const [index, unit] of units.entries()) {
        const policy = unit.assignedPolicies[0]?.allocationPolicy;
        yield* service.allocateWork(
          {
            id: `allocation:receipt:${index}`,
            workUnitId: unit.id,
            allocation: "delegated",
            reason: "The task can run independently.",
            deviationReason: policy === "inline-first" ? "Concurrent work is useful here." : null,
          },
          ownerReader(owner),
        );
      }
      const registration = (index: number, fingerprint = "c".repeat(64)) => ({
        workUnitId: units[index]!.id,
        owner,
        binding: {
          ...bindingFor(units[index]!, `attempt:receipt-${index}`),
          requestFingerprint: fingerprint,
        },
        taskId: `task:receipt:${index}`,
        threadId: ThreadId.make(`thread:child:receipt:${index}`),
      });
      yield* service.registerWorkTask(registration(0));
      yield* service.registerWorkTask(registration(1));
      yield* service.recordWorkTaskLaunch({ taskId: "task:receipt:0", state: "refused" });
      yield* service.registerWorkTask(registration(2));
      const stillAtCapacity = yield* Effect.flip(service.registerWorkTask(registration(0)));
      expect(stillAtCapacity.reason).toBe("conflict");
      yield* service.recordWorkTaskLaunch({ taskId: "task:receipt:2", state: "refused" });
      yield* service.registerWorkTask(registration(0));

      yield* service.recordWorkTaskLaunch({ taskId: "task:receipt:1", state: "launch-unknown" });
      const unknownStillReserved = yield* Effect.flip(service.registerWorkTask(registration(3)));
      expect(unknownStillReserved.reason).toBe("conflict");
      const changedBinding = yield* Effect.flip(
        service.registerWorkTask(registration(1, "d".repeat(64))),
      );
      expect(changedBinding.reason).toBe("conflict");
    }).pipe(Effect.provide(layer)),
);

it.effect("refuses overlapping policy/delegation arms and historical policy assignments", () =>
  Effect.gen(function* () {
    yield* savePolicySnapshot;
    const service = yield* Experiments.ExperimentService;
    yield* service.create(policyDefinition());
    yield* service.transition({ experimentId: "orchestration-policy", status: "running" });
    yield* service.create(delegationDefinition());
    expect(
      (yield* Effect.flip(
        service.transition({ experimentId: "delegation-overlap", status: "running" }),
      )).reason,
    ).toBe("conflict");
    const historical = yield* Effect.flip(
      service.importHistorical({
        experimentId: "orchestration-policy",
        variantId: "inline-first",
        unitId: "historic-work",
        threadId: parentThreadId,
        projectId,
        taskCategory: "implementation-worker",
        assignedModelSelection: selection,
        assignedAt: "2026-10-01T00:00:00Z",
        codeRevision: "commit:old",
        briefRevision: null,
        provenance: "legacy trial import",
      }),
    );
    expect(historical.reason).toBe("invalid-evidence");
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "hides work from unrelated owners and distinguishes model claims from trusted acceptance",
  () =>
    Effect.gen(function* () {
      yield* savePolicySnapshot;
      const service = yield* Experiments.ExperimentService;
      yield* startPolicyExperiment(service);
      const owner = internalOwner();
      const unit = yield* enroll(service, owner, "work:owned");
      const foreignReader = { environmentId, threadId: ThreadId.make("thread:other-parent") };
      const outsiderRead = yield* Effect.flip(
        service.readWork({ workUnitId: unit.id }, foreignReader),
      );
      expect(outsiderRead.reason).toBe("not-found");
      expect(
        (yield* Effect.flip(
          service.allocateWork(
            {
              id: "allocation:outsider",
              workUnitId: unit.id,
              allocation: "inline",
              reason: "Outside owner",
              deviationReason: "Outside owner",
            },
            foreignReader,
          ),
        )).reason,
      ).toBe("not-found");
      expect(
        (yield* Effect.flip(
          service.recordWorkEvidence(workEvidence("evidence:outsider", unit.id), foreignReader),
        )).reason,
      ).toBe("not-found");

      const assignment = (yield* service.assignments(
        { experimentId: "orchestration-policy" },
        ownerReader(owner),
      ))[0]!;
      const selfReport = {
        id: "outcome:self-report",
        assignmentId: assignment.id,
        runId: null,
        kind: "verified-completion" as const,
        source: "self-report" as const,
        evidence: [],
        note: "The model reports completion and its own model selection.",
        actualModelSelection: changedSelection,
        fallbackReason: null,
      };
      yield* service.recordOutcome(selfReport, ownerReader(owner));
      let report = yield* service.readWork({ workUnitId: unit.id }, ownerReader(owner));
      expect(report.independentlySupportedAcceptance).toBe(false);
      expect(report.outcomes[0]).toMatchObject({
        source: "self-report",
        actualModelSelection: changedSelection,
      });
      expect(
        (yield* Effect.flip(
          service.recordOutcome(
            {
              ...selfReport,
              id: "outcome:untrusted-review-claim",
              source: "human-review",
              evidence: ["review:claimed-by-parent"],
            },
            ownerReader(owner),
          ),
        )).reason,
      ).toBe("invalid-evidence");

      yield* service.recordOutcome({
        ...selfReport,
        id: "outcome:human-review",
        source: "human-review",
        evidence: ["review:validated"],
        note: "A reviewer validated the completed change.",
      });
      report = yield* service.readWork({ workUnitId: unit.id }, ownerReader(owner));
      expect(report.independentlySupportedAcceptance).toBe(true);
      expect(report.outcomes.map((outcome) => outcome.source)).toEqual([
        "self-report",
        "human-review",
      ]);
    }).pipe(Effect.provide(layer)),
);

it.effect(
  "forces owner-submitted work outcomes to self-report and hides them from unrelated owners",
  () =>
    Effect.gen(function* () {
      yield* savePolicySnapshot;
      const service = yield* Experiments.ExperimentService;
      yield* startPolicyExperiment(service);
      const owner = internalOwner();
      const unit = yield* enroll(service, owner, "work:owner-outcome");
      const assignment = (yield* service.assignments(
        { experimentId: "orchestration-policy" },
        ownerReader(owner),
      ))[0]!;
      const outcome = {
        id: "outcome:owner-self-report",
        assignmentId: assignment.id,
        runId: null,
        kind: "verified-completion" as const,
        source: "human-review" as const,
        evidence: ["client-claimed-review"],
        note: "The supervised client claims this work was reviewed.",
        actualModelSelection: selection,
        fallbackReason: null,
      };
      const stored = yield* service.recordWorkOutcome(outcome, ownerReader(owner));
      expect(stored.source).toBe("self-report");
      expect("taskId" in stored).toBe(false);
      expect(
        (yield* Effect.flip(
          service.recordWorkOutcome(outcome, {
            environmentId,
            threadId: ThreadId.make("thread:unrelated-outcome-owner"),
          }),
        )).reason,
      ).toBe("not-found");
      const report = yield* service.readWork({ workUnitId: unit.id }, ownerReader(owner));
      expect(report.outcomes).toMatchObject([{ source: "self-report" }]);
      expect(report.independentlySupportedAcceptance).toBe(false);
    }).pipe(Effect.provide(layer)),
);

it.effect("keeps external parent self-report usage partial with null complete totals", () =>
  Effect.gen(function* () {
    yield* savePolicySnapshot;
    const service = yield* Experiments.ExperimentService;
    yield* startPolicyExperiment(service);
    const owner = externalOwner();
    const unit = yield* enroll(service, owner, "work:external-self-report");
    yield* service.recordWorkEvidence(
      workEvidence("evidence:external-segment", unit.id, {
        phase: "wait",
        attribution: "partial",
        externalSegmentId: "parent-span:1",
        startedAt: "2026-10-14T10:00:00.000Z",
        completedAt: "2026-10-14T10:00:30.000Z",
        usage: usage(400, 20),
        evidence: ["external-parent-reported"],
      }),
      ownerReader(owner),
    );
    const report = yield* service.readWork({ workUnitId: unit.id }, ownerReader(owner));
    expect(report.evidence[0]).toMatchObject({
      source: "self-report",
      attributionSource: "self-report",
      usage: usage(400, 20),
    });
    expect(report.parentCoverage).toBe("partial");
    expect(report.usage).toMatchObject({
      status: "partial",
      inputTokens: null,
      outputTokens: null,
    });
    expect(report.observedUsage.inputTokens).toBe(400);
  }).pipe(Effect.provide(layer)),
);

it.effect("deduplicates parent whole-turn telemetry across logical work units", () =>
  Effect.gen(function* () {
    yield* savePolicySnapshot;
    const service = yield* Experiments.ExperimentService;
    yield* startPolicyExperiment(service);
    const owner = internalOwner();
    yield* addThread(parentThreadId);
    const turnId = yield* addParentTurn("parent-evidence", usage(120, 12));
    const first = yield* enroll(service, owner, "work:turn-a");
    const second = yield* enroll(service, owner, "work:turn-b");
    const input = (workUnitId: string, id: string) =>
      workEvidence(id, workUnitId, {
        attribution: "whole-turn",
        threadId: parentThreadId,
        providerTurnId: turnId,
        startedAt: null,
        completedAt: null,
        usage: null,
      });
    const recorded = yield* service.recordWorkEvidence(
      input(first.id, "evidence:parent-turn-a"),
      ownerReader(owner),
    );
    expect(recorded).toMatchObject({
      source: "provider-telemetry",
      attributionSource: "self-report",
      usage: usage(120, 12),
    });
    const duplicate = yield* Effect.flip(
      service.recordWorkEvidence(input(second.id, "evidence:parent-turn-b"), ownerReader(owner)),
    );
    expect(duplicate.reason).toBe("conflict");
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "aggregates parallel child telemetry once and keeps totals incomplete when parent telemetry is missing",
  () =>
    Effect.gen(function* () {
      yield* savePolicySnapshot;
      const service = yield* Experiments.ExperimentService;
      yield* startPolicyExperiment(service);
      const owner = internalOwner();
      const unit = yield* enroll(service, owner, "work:parallel-child-telemetry");
      const first = yield* allocateDelegated(service, owner, unit, "parallel-a");
      const secondThread = ThreadId.make("thread:child:parallel-b");
      yield* service.registerWorkTask({
        workUnitId: unit.id,
        owner,
        binding: bindingFor(unit, "attempt:parallel-b"),
        taskId: "task:parallel-b",
        threadId: secondThread,
      });
      yield* addThread(first.threadId);
      yield* addThread(secondThread);
      yield* addParentTurn("parallel-child-a", usage(120, 12), first.threadId);
      yield* addParentTurn("parallel-child-b", usage(80, 8), secondThread);

      const report = yield* service.readWork({ workUnitId: unit.id }, ownerReader(owner));
      expect(report.tasks).toHaveLength(2);
      expect(report.childCoverage).toBe("complete");
      expect(report.childUsage).toMatchObject({
        status: "complete",
        inputTokens: 200,
        outputTokens: 20,
      });
      expect(report.parentCoverage).toBe("unavailable");
      expect(report.usage).toMatchObject({
        status: "partial",
        inputTokens: null,
        outputTokens: null,
      });
    }).pipe(Effect.provide(layer)),
);

it.effect("marks child coverage partial when a delegated turn has no usage telemetry", () =>
  Effect.gen(function* () {
    yield* savePolicySnapshot;
    const service = yield* Experiments.ExperimentService;
    yield* startPolicyExperiment(service);
    const owner = internalOwner();
    const unit = yield* enroll(service, owner, "work:missing-child-usage");
    const child = yield* allocateDelegated(service, owner, unit, "missing-usage");
    yield* addThread(child.threadId);
    yield* addParentTurn("missing-child-usage", null, child.threadId);

    const report = yield* service.readWork({ workUnitId: unit.id }, ownerReader(owner));
    expect(report.childCoverage).toBe("partial");
    expect(report.childUsage.status).toBe("unavailable");
    expect(report.parentCoverage).toBe("unavailable");
    expect(report.usage).toMatchObject({
      status: "unavailable",
      inputTokens: null,
      outputTokens: null,
    });
  }).pipe(Effect.provide(layer)),
);

it.effect(
  "keeps implementation inline while accounting for optional advice and independent review",
  () =>
    Effect.gen(function* () {
      yield* savePolicySnapshot;
      const service = yield* Experiments.ExperimentService;
      yield* startPolicyExperiment(service);
      const owner = internalOwner();
      const unit = yield* enroll(service, owner, "work:inline-with-support");
      const policy = policySnapshot();
      const advisorSelection = {
        instanceId: ProviderInstanceId.make("codex-test"),
        model: "gpt-astra-test",
        options: [{ id: "reasoning", value: "high" }],
      };
      const reviewerSelection = {
        instanceId: ProviderInstanceId.make("codex-test"),
        model: "gpt-sol-test",
        options: [{ id: "reasoning", value: "medium" }],
      };
      const advisor = {
        ...bindingFor(unit, "attempt:advice"),
        role: "advisor" as const,
        briefHash: policy.briefs.advisor.hash,
        sourceAccess: "read-only" as const,
        toolProfile: "source-reader" as const,
        requested: advisorSelection,
        effective: advisorSelection,
      };
      const review = {
        ...bindingFor(unit, "attempt:review"),
        role: "ticket-reviewer" as const,
        briefHash: policy.briefs["ticket-reviewer"].hash,
        sourceAccess: "read-only" as const,
        toolProfile: "source-reader" as const,
        requested: reviewerSelection,
        effective: reviewerSelection,
      };
      const adviceThread = ThreadId.make("thread:optional-advice");
      const reviewThread = ThreadId.make("thread:independent-review");
      // Advice can inform allocation; it never forces a delegated implementation.
      yield* service.registerWorkTask({
        workUnitId: unit.id,
        owner,
        binding: advisor,
        taskId: "task:advice",
        threadId: adviceThread,
      });
      expect(
        (yield* service.readWork({ workUnitId: unit.id }, ownerReader(owner))).actualAllocation,
      ).toBeNull();
      yield* service.allocateWork(
        {
          id: "allocation:inline-support",
          workUnitId: unit.id,
          allocation: "inline",
          reason: "The lead holds coupled implementation context",
          deviationReason: "The lead retains integrated work",
        },
        ownerReader(owner),
      );
      yield* service.registerWorkTask({
        workUnitId: unit.id,
        owner,
        binding: review,
        taskId: "task:review",
        threadId: reviewThread,
      });
      const worker = yield* service
        .registerWorkTask({
          workUnitId: unit.id,
          owner,
          binding: bindingFor(unit, "attempt:worker"),
          taskId: "task:unexpected-worker",
          threadId: ThreadId.make("thread:unexpected-worker"),
        })
        .pipe(Effect.flip);
      expect(worker.reason).toBe("invalid-evidence");
      yield* TestClock.adjust("20 seconds");
      yield* addThread(parentThreadId);
      yield* addThread(adviceThread);
      yield* addThread(reviewThread);
      const parentTurn = yield* addParentTurn(
        "inline-support-parent",
        usage(50, 5),
        parentThreadId,
        { start: 0, end: 20000 },
      );
      yield* addParentTurn("inline-support-advice", usage(10, 1), adviceThread, {
        start: 5000,
        end: 10000,
      });
      yield* addParentTurn("inline-support-review", usage(20, 2), reviewThread, {
        start: 5000,
        end: 10000,
      });
      yield* service.recordWorkEvidence(
        workEvidence("evidence:inline-support", unit.id, {
          threadId: parentThreadId,
          providerTurnId: parentTurn,
          attribution: "whole-turn",
          phase: "execution",
        }),
        ownerReader(owner),
      );
      yield* service.recordOutcome({
        id: "accept:inline-support",
        assignmentId: unit.assignmentIds[0]!,
        runId: null,
        kind: "verified-completion",
        source: "human-review",
        evidence: ["review:accepted"],
        note: "Independent review and checks accepted",
        actualModelSelection: null,
        fallbackReason: null,
      });
      const report = yield* service.readWork({ workUnitId: unit.id }, ownerReader(owner));
      expect(report.actualAllocation).toBe("inline");
      expect(report.unit.assignmentIds).toEqual(unit.assignmentIds);
      expect(report.childCoverage).toBe("complete");
      expect(report.parentCoverage).toBe("complete");
      expect(report.usage.inputTokens).toBe(80);
      expect(report.usage.outputTokens).toBe(8);
      expect(report.activeMs).toBe(20000);
      expect(report.elapsedToAcceptedMs).toBe(20000);
      expect(report.overlapMs).toBe(5000);
      expect(report.phaseMs.advice).toBe(5000);
      expect(report.phaseMs.verification).toBe(5000);
      expect(report.independentlySupportedAcceptance).toBe(true);
    }).pipe(Effect.provide(layer)),
);

it.effect.each(["verified-completion", "cancellation"] as const)(
  "ends advisor reuse after a recorded %s outcome while permitting final review",
  (kind) =>
    Effect.gen(function* () {
      yield* savePolicySnapshot;
      const service = yield* Experiments.ExperimentService;
      yield* startPolicyExperiment(service);
      const owner = internalOwner();
      const unit = yield* enroll(service, owner, `work:advisor-close:${kind}`);
      yield* service.allocateWork(
        {
          id: `allocation:${kind}`,
          workUnitId: unit.id,
          allocation: "inline",
          reason: "Keep coupled work inline",
          deviationReason: "Owner chose inline work",
        },
        ownerReader(owner),
      );
      // Consulting roles answer the lead, so inline work may still use them.
      for (const role of ["advisor", "scout", "researcher"] as const)
        expect((yield* service.workDispatchPolicy({ workUnitId: unit.id, owner, role })).id).toBe(
          unit.id,
        );
      yield* service.recordOutcome({
        id: `close:${kind}`,
        assignmentId: unit.assignmentIds[0]!,
        runId: null,
        kind,
        source: "human-review",
        evidence: ["owner:closure"],
        note: "Work ended",
        actualModelSelection: selection,
        fallbackReason: null,
      });
      for (const role of ["advisor", "scout", "researcher"] as const)
        expect(
          (yield* service
            .workDispatchPolicy({ workUnitId: unit.id, owner, role })
            .pipe(Effect.flip)).reason,
        ).toBe("invalid-evidence");
      expect(
        (yield* service.workDispatchPolicy({ workUnitId: unit.id, owner, role: "ticket-reviewer" }))
          .id,
      ).toBe(unit.id);
    }).pipe(Effect.provide(layer)),
);
