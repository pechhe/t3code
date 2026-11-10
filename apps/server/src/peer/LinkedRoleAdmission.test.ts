import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import {
  type AgentTaskBinding,
  type AgentTaskLinkedRequest,
  type AgentTaskRequest,
  ProjectId,
  ThreadId,
} from "@t3tools/contracts";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";

import * as ManagedAgent from "../agents/ManagedAgentService.ts";
import * as ThreadManagement from "../orchestration-v2/ThreadManagementService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as WorkspaceProvider from "../project/WorkspaceProvider.ts";
import * as ProviderRegistry from "../provider/ProviderRegistry.ts";
import * as ServerSettings from "../serverSettings.ts";
import { admitLinkedRole } from "./LinkedRoleAdmission.ts";

const projectId = ProjectId.make("project:box");
const threadId = ThreadId.make("thread:linked");
const workspaceRoot = "/box/repo";
const allocated = "/box/workspaces/w1";

type Row = {
  readonly role: string;
  readonly sourceAccess: "read-only" | "scoped-write";
  readonly refusal: string | null;
  readonly models: ReadonlyArray<string>;
};

const scout: Row = {
  role: "scout",
  sourceAccess: "read-only",
  refusal: null,
  models: ["deepseek"],
};
const worker: Row = {
  role: "implementer",
  sourceAccess: "scoped-write",
  refusal: null,
  models: ["deepseek"],
};

interface Seen {
  readonly prepared: Ref.Ref<ReadonlyArray<AgentTaskRequest>>;
  readonly selections: Ref.Ref<ReadonlyArray<unknown>>;
  readonly ceilings: Ref.Ref<ReadonlyArray<string>>;
  readonly allocations: Ref.Ref<number>;
  readonly abandoned: Ref.Ref<number>;
}

const admit = (input: {
  readonly request: Partial<AgentTaskLinkedRequest>;
  readonly rows?: ReadonlyArray<Row>;
  readonly configured?: boolean;
  readonly slipjay?: boolean;
  readonly prepareFails?: string;
}) =>
  Effect.gen(function* () {
    const seen: Seen = {
      prepared: yield* Ref.make<ReadonlyArray<AgentTaskRequest>>([]),
      selections: yield* Ref.make<ReadonlyArray<unknown>>([]),
      ceilings: yield* Ref.make<ReadonlyArray<string>>([]),
      allocations: yield* Ref.make(0),
      abandoned: yield* Ref.make(0),
    };
    const rows = input.rows ?? [scout, worker];
    const outcome = yield* admitLinkedRole({
      threadId,
      projectId,
      title: "Check",
      request: {
        role: "scout",
        taskClass: "non-ui",
        workId: "work:1",
        attemptId: "attempt:1",
        ...input.request,
      } as AgentTaskLinkedRequest,
      ceiling: "auto-accept-edits",
      runtimeMode: undefined,
    }).pipe(
      Effect.map((admitted) => ({ admitted, refused: null })),
      Effect.catch((error) => Effect.succeed({ admitted: undefined, refused: error.message })),
      Effect.provide(
        Layer.mergeAll(
          Layer.mock(ManagedAgent.ManagedAgentService)({
            configured: () => Effect.succeed(input.configured ?? true),
            roles: ({ ceiling, selection }) =>
              Ref.update(seen.ceilings, (all) => [...all, ceiling]).pipe(
                Effect.andThen(Ref.update(seen.selections, (all) => [...all, selection])),
                Effect.as({
                  policyHash: "a".repeat(64),
                  policyRevision: "test",
                  roles: rows.map((row) => ({
                    ...row,
                    selection:
                      row.refusal === null ? { instanceId: "pi", model: row.models[0] } : null,
                    models: row.models.map((model) => ({ model, effort: "low", available: true })),
                  })),
                } as never),
              ),
            prepare: ({ request }) =>
              input.prepareFails !== undefined
                ? Effect.fail(
                    new ManagedAgent.ManagedAgentError({
                      reason: "workspace",
                      detail: input.prepareFails,
                    }),
                  )
                : Ref.update(seen.prepared, (all) => [...all, request]).pipe(
                    Effect.as({
                      binding: {
                        ...request,
                        sourceAccess:
                          request.workspaceAssignment === "isolated" ? "scoped-write" : "read-only",
                        effective: { instanceId: "pi", model: "deepseek" },
                      } as unknown as AgentTaskBinding,
                      brief: "You are the role.",
                    }),
                  ),
            validate: () => Effect.void,
          }),
          Layer.mock(ProjectService.ProjectService)({
            getById: () =>
              Effect.succeedSome({ id: projectId, title: "Box", workspaceRoot } as never),
            listShells: () => Effect.succeed([]),
          }),
          Layer.mock(ThreadManagement.ThreadManagementService)({
            isProviderInstanceEnabledForProject: () => Effect.succeed(true),
            listProjectThreads: () => Effect.succeed([] as never),
          }),
          Layer.mock(ProviderRegistry.ProviderRegistry)({ getProviders: Effect.succeed([]) }),
          Layer.mock(WorkspaceProvider.WorkspaceProvider)({
            resolve: () => Effect.succeed(input.slipjay === false ? "git-worktree" : "slipjay"),
            allocate: () =>
              Ref.update(seen.allocations, (count) => count + 1).pipe(
                Effect.as({
                  workspacePath: allocated,
                  created: true,
                  issue: null,
                  attemptId: "attempt:alloc",
                }),
              ),
            settled: () => Effect.void,
            abandon: () => Ref.update(seen.abandoned, (count) => count + 1),
          }),
          ServerSettings.layerTest(),
          NodeCrypto.layer,
        ),
      ),
    );
    return { ...outcome, seen };
  });

it.effect("resolves a linked reader in the project's own checkout, under the caller's mode", () =>
  Effect.gen(function* () {
    const { refused, admitted, seen } = yield* admit({ request: {} });
    expect(refused).toBeNull();
    expect(admitted?.workspaceStrategy).toEqual({ type: "root" });
    expect(admitted?.binding.effective.model).toBe("deepseek");
    expect(yield* Ref.get(seen.prepared)).toContainEqual(
      expect.objectContaining({ role: "scout", workspacePath: workspaceRoot }),
    );
    expect(yield* Ref.get(seen.ceilings)).toContain("auto-accept-edits");
    expect(yield* Ref.get(seen.allocations)).toBe(0);
  }),
);

it.effect("gives a linked writer a workspace allocated here, never the caller's", () =>
  Effect.gen(function* () {
    const { admitted, seen } = yield* admit({ request: { role: "implementer" } });
    expect(admitted?.workspaceStrategy).toEqual({
      type: "existing_worktree",
      worktreePath: allocated,
    });
    expect(yield* Ref.get(seen.prepared)).toContainEqual(
      expect.objectContaining({ workspacePath: allocated, workspaceAssignment: "isolated" }),
    );
  }),
);

it.effect("gives the workspace back when the resolver refuses after allocating it", () =>
  Effect.gen(function* () {
    const { refused, seen } = yield* admit({
      request: { role: "implementer" },
      prepareFails: "the role's sandbox is unavailable",
    });
    expect(refused).toContain("sandbox is unavailable");
    expect(yield* Ref.get(seen.abandoned)).toBe(yield* Ref.get(seen.allocations));
  }),
);

it.effect("refuses before allocating anything, naming the cause", () =>
  Effect.gen(function* () {
    const cases = [
      [{ request: {}, configured: false }, "no role policy"],
      [{ request: { role: "lead" } }, "own environment"],
      [{ request: { role: "advisor" } }, "has no `advisor` role"],
      [
        { request: { role: "implementer", selection: { model: "claude-fable" } } },
        "claude-fable is not on this environment's list",
      ],
      [
        { request: { role: "implementer" }, rows: [{ ...worker, refusal: "usage-limited" }] },
        "cannot start `implementer` now: usage-limited",
      ],
      [{ request: { role: "implementer" }, slipjay: false }, "only in a SlipJay project"],
    ] as const;
    for (const [input, message] of cases) {
      const { refused, seen } = yield* admit(input as Parameters<typeof admit>[0]);
      expect(refused, message).toContain(message);
      expect(yield* Ref.get(seen.allocations), message).toBe(0);
      expect(yield* Ref.get(seen.prepared), message).toEqual([]);
    }
  }),
);

it.effect("passes a requested model to the resolver as a request, not a choice", () =>
  Effect.gen(function* () {
    const { seen } = yield* admit({ request: { selection: { model: "deepseek" } } });
    expect(yield* Ref.get(seen.selections)).toContainEqual({ model: "deepseek" });
  }),
);
