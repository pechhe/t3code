import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  ProjectId,
  type AgentPolicyManifest,
  type AgentTaskBinding,
  type AgentTaskRequest,
  type ModelSelection,
  type OrchestrationV2AppThread,
} from "@t3tools/contracts";
import type { ProviderInstance } from "@t3tools/provider-core/server/driver";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as Managed from "./ManagedAgentService.ts";
import * as Store from "./AgentPolicyStore.ts";
import * as Policy from "./AgentPolicyService.ts";
import * as RuntimePolicy from "../orchestration-v2/RuntimePolicy.ts";
import * as Projects from "../orchestration-v2/ProjectStore.ts";
import * as Providers from "../provider/ProviderInstanceRegistry.ts";
import * as Settings from "../serverSettings.ts";
import {
  snapshot,
  request,
  codex,
  claude,
  codexModel,
  claudeModel,
  changeReview,
} from "./agentPolicy.testkit.ts";

const sourceRevision = "fixture-source-commit";
const processes = Layer.succeed(ProcessRunner.ProcessRunner, {
  run: (input) =>
    Effect.succeed({
      stdout: input.args[0] === "status" ? "" : sourceRevision + "\n",
      stderr: "",
      code: ChildProcessSpawner.ExitCode(0),
      timedOut: false,
      stdoutTruncated: false,
      stderrTruncated: false,
      stdoutInvalidUtf8: false,
      stderrInvalidUtf8: false,
    }),
});
const dependencies = Layer.mergeAll(Sqlite.layerMemory, NodeServices.layer, processes);
const testLayer = Layer.mergeAll(Managed.layer, Store.layer, Policy.layer).pipe(
  Layer.provideMerge(dependencies),
);
const fixture = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const temporary = yield* fs.makeTempDirectoryScoped({ prefix: "managed-agent-test-" });
  const root = yield* fs.realPath(temporary);
  const workspacePath = `${root}/workspace`;
  const policyRoot = `${root}/policy`;
  yield* fs.makeDirectory(workspacePath);
  yield* fs.makeDirectory(`${policyRoot}/roles`, { recursive: true });
  const manifest = snapshot().manifest;
  const writeManifest = (value: AgentPolicyManifest) =>
    fs.writeFileString(`${policyRoot}/roles/policy.json`, JSON.stringify(value));
  yield* writeManifest(manifest);
  for (const role of Object.values(manifest.roles))
    yield* fs.writeFileString(`${policyRoot}/${role.brief}`, `Original ${role.brief}\n`);
  const service = yield* Managed.ManagedAgentService;
  const config = ConfigProvider.fromUnknown({ T3CODE_AGENT_POLICY_ROOT: policyRoot });
  const authority = { workspacePath, providers: [codex, claude], ceiling: "full-access" as const };
  const prepareInput = {
    ...authority,
    request: request({ workspacePath }),
    requestFingerprint: "c".repeat(64),
  };
  const prepare = (overrides: Partial<Parameters<typeof service.prepare>[0]> = {}) =>
    service
      .prepare({ ...prepareInput, ...overrides })
      .pipe(Effect.provideService(ConfigProvider.ConfigProvider, config));
  const validate = (binding: AgentTaskBinding, selection: ModelSelection = binding.effective) =>
    service
      .validate({ ...authority, binding, selection })
      .pipe(Effect.provideService(ConfigProvider.ConfigProvider, config));
  return {
    fs,
    root,
    workspacePath,
    policyRoot,
    manifest,
    writeManifest,
    prepare,
    validate,
    service,
    prepareInput,
    config,
  };
});

it.layer(testLayer)("ManagedAgentService", (it) => {
  it.effect(
    "admits trusted Claude only with destination opt-in and full caller and child access",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const settings = yield* Settings.ServerSettingsService;
        const writer = request({
          workspacePath: f.workspacePath,
          role: "ui-worker",
          taskClass: "ui",
        });
        const prepare = (overrides: Partial<Parameters<typeof f.prepare>[0]> = {}) =>
          f.prepare({ request: writer, ...overrides });
        expect((yield* prepare().pipe(Effect.flip)).message).toContain("trusted-claude-disabled");
        yield* settings.updateSettings({ delegation: { allowTrustedClaudeWriters: true } });
        const accepted = yield* prepare();
        expect(accepted.binding).toMatchObject({
          executionRequirement: "trusted-host-allowed",
          executionBoundary: "trusted-host-access",
        });
        yield* f.validate(accepted.binding);
        // Exercise the real launch guard and emitted adapter policy, not only resolution.
        const runtimeLayer = RuntimePolicy.layerFromProjectStore.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(Projects.ProjectStoreV2)({
                get: () => Effect.succeed(Option.some({ workspaceRoot: f.workspacePath } as never)),
              }),
              Layer.mock(Providers.ProviderInstanceRegistry)({
                getInstance: () =>
                  Effect.succeed({
                    snapshot: { getSnapshot: Effect.succeed(claude) },
                  } as ProviderInstance),
              }),
            ),
          ),
        );
        yield* Effect.gen(function* () {
          const runtime = yield* RuntimePolicy.RuntimePolicyV2;
          const projectId = ProjectId.make("trusted-writer-runtime");
          yield* settings.updateSettings({
            projectSettingsOverrides: {
              [projectId]: { providerInstances: { [claude.instanceId]: { enabled: true } } },
            },
          });
          const resolved = yield* runtime.resolve({
            thread: {
              projectId,
              worktreePath: f.workspacePath,
              runtimeMode: "full-access",
              interactionMode: "default",
              agentTask: accepted.binding,
            } as OrchestrationV2AppThread,
            modelSelection: accepted.binding.effective,
          });
          expect(resolved.managedAgent).toBe(true);
          expect(resolved.sandboxPolicy).toEqual({ type: "dangerFullAccess" });
          expect(resolved.cwd).toBe(f.workspacePath);
          // Queued starts and resumes after a restart pass this guard with the recorded
          // binding; revoking the owner opt-in refuses the next one.
          yield* settings.updateSettings({ delegation: { allowTrustedClaudeWriters: false } });
          const revoked = yield* runtime
            .resolve({
              thread: {
                projectId,
                worktreePath: f.workspacePath,
                runtimeMode: "full-access",
                interactionMode: "default",
                agentTask: accepted.binding,
              } as OrchestrationV2AppThread,
              modelSelection: accepted.binding.effective,
            })
            .pipe(Effect.flip);
          expect(revoked.cause).toMatchObject({ _tag: "ManagedAgentError", reason: "selection" });
          yield* settings.updateSettings({ delegation: { allowTrustedClaudeWriters: true } });
        }).pipe(
          Effect.provide(runtimeLayer),
          Effect.provideService(ConfigProvider.ConfigProvider, f.config),
        );
        for (const overrides of [
          { ceiling: "auto" as const },
          { runtimeMode: "auto-accept-edits" as const },
          { request: { ...writer, executionRequirement: "sandbox-required" as const } },
        ])
          expect((yield* prepare(overrides).pipe(Effect.flip)).reason).toBe("selection");
        yield* settings.updateSettings({
          delegation: { defaultChildRuntimeMode: "approval-required" },
        });
        expect((yield* prepare().pipe(Effect.flip)).reason).toBe("selection");
        // An explicit authorized override uses the existing child mode, not another permission system.
        yield* prepare({ runtimeMode: "full-access" });
        yield* settings.updateSettings({ delegation: { defaultChildRuntimeMode: "inherit" } });
        const {
          executionRequirement: _requirement,
          executionBoundary: _boundary,
          ...legacy
        } = accepted.binding;
        expect((yield* f.validate(legacy).pipe(Effect.flip)).reason).toBe("selection");
        expect(
          (yield* f
            .validate({ ...accepted.binding, executionBoundary: undefined })
            .pipe(Effect.flip)).reason,
        ).toBe("selection");
        expect(
          (yield* f
            .validate({ ...accepted.binding, executionBoundary: "workspace-sandbox" })
            .pipe(Effect.flip)).reason,
        ).toBe("selection");
        yield* settings.updateSettings({ delegation: { allowTrustedClaudeWriters: false } });
        expect((yield* f.validate(accepted.binding).pipe(Effect.flip)).reason).toBe("selection");
        expect(
          (yield* prepare({ recordedBinding: accepted.binding }).pipe(Effect.flip)).reason,
        ).toBe("selection");
      }).pipe(Effect.provide(Settings.layerTest())),
  );

  it.effect(
    "keeps discovery, preparation and preview treatment consistent without widening readers or Codex",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const settings = yield* Settings.ServerSettingsService;
        const roles = yield* f.service
          .roles({ ...f.prepareInput, request: { taskClass: "ui" } })
          .pipe(Effect.provideService(ConfigProvider.ConfigProvider, f.config));
        const ui = roles.roles.find((role) => role.role === "ui-worker")!;
        expect(ui.executionBoundary).toBe("trusted-host-access");
        expect(ui.executionRequirement).toBe("trusted-host-allowed");
        const writer = yield* f.prepare({
          selection: { instanceId: codex.instanceId, model: codexModel },
        });
        expect(writer.binding.executionBoundary).toBe("workspace-sandbox");
        yield* settings.updateSettings({ delegation: { allowTrustedClaudeWriters: false } });
        yield* f.validate(writer.binding);
        const fallback = yield* f
          .validate(writer.binding, {
            instanceId: claude.instanceId,
            model: claudeModel,
            options: [{ id: "effort", value: "medium" }],
          })
          .pipe(Effect.flip);
        expect(fallback.reason).toBe("selection");
        const reader = yield* f.prepare({
          request: request({ workspacePath: f.workspacePath, readOnly: true }),
        });
        expect(reader.binding.executionRequirement).toBe("sandbox-required");
        expect(reader.binding.executionBoundary).toBe("read-only");
      }).pipe(
        Effect.provide(Settings.layerTest({ delegation: { allowTrustedClaudeWriters: true } })),
      ),
  );

  it.effect(
    "checks regular hard links on admission and each protected start, while readers can inspect them",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const accepted = yield* f.prepare();
        yield* f.fs.writeFileString(`${f.root}/outside`, "preserve");
        const alias = `${f.workspacePath}/alias`;
        yield* f.fs.link(`${f.root}/outside`, alias);
        const error = yield* f.prepare().pipe(Effect.flip);
        expect(error.reason).toBe("hard-link");
        expect(error.message).toContain(alias);
        expect((yield* f.validate(accepted.binding).pipe(Effect.flip)).reason).toBe("hard-link");
        yield* f.prepare({ request: request({ workspacePath: f.workspacePath, readOnly: true }) });
      }),
  );
  it.effect(
    "enforces read-only runtime authority for an explicit author-model reviewer at the project root",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const accepted = yield* f.prepare({
          workspacePath: null,
          projectRoot: f.workspacePath,
          request: request({
            role: "ticket-reviewer",
            workspacePath: f.workspacePath,
            readOnly: true,
            sourceRevision,
            review: changeReview,
            authorModel: codexModel,
          }),
          selection: { model: codexModel },
        });
        const provider = [codex, claude].find(
          (p) => p.instanceId === accepted.binding.effective.instanceId,
        )!;
        const runtimeLayer = RuntimePolicy.layerFromProjectStore.pipe(
          Layer.provide(
            Layer.mergeAll(
              Layer.mock(Projects.ProjectStoreV2)({
                get: () => Effect.succeed(Option.some({ workspaceRoot: f.workspacePath } as never)),
              }),
              Layer.mock(Providers.ProviderInstanceRegistry)({
                getInstance: () =>
                  Effect.succeed({
                    snapshot: { getSnapshot: Effect.succeed(provider) },
                  } as ProviderInstance),
              }),
            ),
          ),
        );
        yield* Effect.gen(function* () {
          const runtime = yield* RuntimePolicy.RuntimePolicyV2;
          const settings = yield* Settings.ServerSettingsService;
          const projectId = ProjectId.make("root-reader-project");
          yield* settings.updateSettings({
            projectSettingsOverrides: {
              [projectId]: { providerInstances: { [provider.instanceId]: { enabled: true } } },
            },
          });
          const thread = {
            projectId,
            worktreePath: null,
            runtimeMode: "full-access",
            interactionMode: "default",
            agentTask: accepted.binding,
          } as OrchestrationV2AppThread;
          const resolved = yield* runtime.resolve({
            thread,
            modelSelection: accepted.binding.effective,
          });
          expect(resolved.cwd).toBe(f.workspacePath);
          expect(resolved.managedAgent).toBe(true);
          expect(resolved.sandboxPolicy).toEqual({ type: "readOnly", networkAccess: false });
          // The runtime must not turn its resolved cwd into explicit writer authority.
          const denied = yield* runtime
            .resolve({
              thread: {
                ...thread,
                agentTask: { ...accepted.binding, sourceAccess: "scoped-write" },
              },
              modelSelection: accepted.binding.effective,
            })
            .pipe(Effect.flip);
          expect(denied.cause).toMatchObject({ reason: "workspace" });
        }).pipe(
          Effect.provide(runtimeLayer.pipe(Layer.provideMerge(Settings.layerTest()))),
          Effect.provideService(ConfigProvider.ConfigProvider, f.config),
        );
      }),
  );

  it.effect("allows only read-only lead work at an unbound thread's canonical project root", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const authority = { workspacePath: null, projectRoot: f.workspacePath };
      const input = request({ workspacePath: f.workspacePath, readOnly: true });
      const accepted = yield* f.prepare({ ...authority, request: input });
      expect(accepted.binding.sourceAccess).toBe("read-only");
      expect(accepted.binding.workspacePath).toBe(f.workspacePath);
      yield* f.service
        .validate({
          ...f.prepareInput,
          ...authority,
          binding: accepted.binding,
          selection: accepted.binding.effective,
        })
        .pipe(Effect.provideService(ConfigProvider.ConfigProvider, f.config));
      for (const invalid of [
        request({ workspacePath: f.workspacePath }),
        request({
          workspacePath: f.workspacePath,
          readOnly: true,
          workspaceAssignment: "isolated",
        }),
        request({ workspacePath: f.root, readOnly: true }),
        request({ workspacePath: `${f.workspacePath}/../workspace`, readOnly: true }),
      ]) {
        expect(
          (yield* f.prepare({ ...authority, request: invalid }).pipe(Effect.flip)).reason,
        ).toBe("workspace");
      }
      const alias = `${f.root}/root-alias`;
      yield* f.fs.symlink(f.workspacePath, alias);
      expect(
        (yield* f
          .prepare({
            workspacePath: null,
            projectRoot: alias,
            request: request({ workspacePath: alias, readOnly: true }),
          })
          .pipe(Effect.flip)).reason,
      ).toBe("workspace");
    }),
  );

  it.effect("requires an exact existing canonical workspace", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      expect((yield* f.prepare({ workspacePath: null }).pipe(Effect.flip)).reason).toBe(
        "workspace",
      );
      expect(
        (yield* f
          .prepare({ request: request({ workspacePath: `${f.workspacePath}/../workspace` }) })
          .pipe(Effect.flip)).reason,
      ).toBe("workspace");
      expect(
        (yield* f
          .prepare({
            workspacePath: `${f.root}/missing`,
            request: request({ workspacePath: `${f.root}/missing` }),
          })
          .pipe(Effect.flip)).reason,
      ).toBe("workspace");
      const alias = `${f.root}/alias`;
      yield* f.fs.symlink(f.workspacePath, alias);
      expect(
        (yield* f
          .prepare({ workspacePath: alias, request: request({ workspacePath: alias }) })
          .pipe(Effect.flip)).reason,
      ).toBe("workspace");
      const result = yield* f.prepare();
      expect(result.binding.workspacePath).toBe(f.workspacePath);
      expect(result.binding.requestFingerprint).toBe(f.prepareInput.requestFingerprint);
    }),
  );

  it.effect(
    "persists original policy and brief bytes across edits without rewriting accepted treatment",
    () =>
      Effect.gen(function* () {
        const f = yield* fixture;
        const accepted = yield* f.prepare();
        const store = yield* Store.AgentPolicyStore;
        const original = yield* store.get(accepted.binding.policyHash);
        expect(original.briefs["implementation-worker"].text).toBe(accepted.brief);
        yield* f.fs.writeFileString(
          `${f.policyRoot}/roles/implementation-worker.md`,
          "Revised instructions\n",
        );
        const policy = yield* Policy.AgentPolicyService;
        const changed = yield* policy.snapshot(f.policyRoot);
        expect(changed.hash).not.toBe(accepted.binding.policyHash);
        yield* f.validate(accepted.binding);
        const retained = yield* store.get(accepted.binding.policyHash);
        expect(retained).toEqual(original);
        expect(retained.briefs["implementation-worker"].hash).toBe(accepted.binding.briefHash);
        expect(retained.briefs["implementation-worker"].text).toBe(accepted.brief);
      }),
  );

  it.effect("denies current model and role authority revocation", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const accepted = yield* f.prepare();
      yield* f.writeManifest({
        ...f.manifest,
        models: {
          ...f.manifest.models,
          sol: { ...f.manifest.models.sol!, model: "gpt-replacement-test" },
        },
      });
      expect((yield* f.validate(accepted.binding).pipe(Effect.flip)).reason).toBe("revoked");
      yield* f.writeManifest({
        ...f.manifest,
        roles: {
          ...f.manifest.roles,
          "implementation-worker": {
            ...f.manifest.roles["implementation-worker"],
            sourceAccess: "read-only",
          },
        },
      });
      expect((yield* f.validate(accepted.binding).pipe(Effect.flip)).reason).toBe("revoked");
    }),
  );

  it.effect("rejects forbidden effective experiment model and effort before execution", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const accepted = yield* f.prepare();
      expect(
        (yield* f
          .validate(accepted.binding, { ...accepted.binding.effective, model: "gpt-astra-test" })
          .pipe(Effect.flip)).reason,
      ).toBe("selection");
      expect(
        (yield* f
          .validate(accepted.binding, {
            ...accepted.binding.effective,
            options: [{ id: "reasoning", value: "high" }],
          })
          .pipe(Effect.flip)).reason,
      ).toBe("selection");
    }),
  );

  it.effect("requires the pinned source revision at preparation and validation", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const reviewerRequest = request({
        workspacePath: f.workspacePath,
        role: "ticket-reviewer",
        sourceRevision,
        review: changeReview,
      });
      const accepted = yield* f.prepare({ request: reviewerRequest });
      yield* f.validate(accepted.binding);
      expect(
        (yield* f
          .prepare({ request: { ...reviewerRequest, sourceRevision: "wrong-source" } })
          .pipe(Effect.flip)).reason,
      ).toBe("source");
      const refused = yield* f
        .validate({ ...accepted.binding, sourceRevision: "wrong-source" })
        .pipe(Effect.flip);
      expect(refused.reason).toBe("source");
      // The caller learns what to pass, not only that dispatch was refused.
      expect(refused.message).toContain("full commit id");
      expect(refused.message).toContain("jj log -r @");
      expect(refused.message).not.toContain("wrong-source");
    }),
  );

  it.effect("fails closed with missing destination policy configuration", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const error = yield* f.service
        .prepare(f.prepareInput)
        .pipe(
          Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromUnknown({})),
          Effect.flip,
        );
      expect(error.reason).toBe("policy");
    }),
  );
  it.effect("recovers the recorded binding and original brief on retry after policy edits", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const original = yield* f.prepare();
      yield* f.fs.writeFileString(
        `${f.policyRoot}/roles/implementation-worker.md`,
        "Changed after accepted dispatch\n",
      );
      const retry = yield* f.prepare({ recordedBinding: original.binding });
      expect(retry.binding).toEqual(original.binding);
      expect(retry.brief).toBe(original.brief);
      const current = yield* f.prepare();
      expect(current.binding.policyHash).not.toBe(original.binding.policyHash);
      expect(current.brief).not.toBe(original.brief);
      const conflict = yield* f
        .prepare({ recordedBinding: original.binding, requestFingerprint: "d".repeat(64) })
        .pipe(Effect.flip);
      expect(conflict.reason).toBe("policy");
    }),
  );

  it.effect("rejects tampered source access and tool authority in a durable binding", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const accepted = yield* f.prepare({
        request: request({ workspacePath: f.workspacePath, readOnly: true }),
      });
      yield* f.validate(accepted.binding);
      expect(
        (yield* f.validate({ ...accepted.binding, sourceAccess: "scoped-write" }).pipe(Effect.flip))
          .reason,
      ).toBe("policy");
      expect(
        (yield* f
          .validate({ ...accepted.binding, toolProfile: "implementation" })
          .pipe(Effect.flip)).reason,
      ).toBe("policy");
    }),
  );

  it.effect("binds an isolated helper only to a separate workspace of the lead's repository", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      // jj workspaces point at a shared repository store through `.jj/repo`.
      const store = `${f.root}/repo-store`;
      const otherStore = `${f.root}/other-store`;
      yield* f.fs.makeDirectory(store);
      yield* f.fs.makeDirectory(otherStore);
      const workspace = (name: string, target: string) =>
        Effect.gen(function* () {
          const path = `${f.root}/${name}`;
          yield* f.fs.makeDirectory(`${path}/.jj`, { recursive: true });
          yield* f.fs.writeFileString(`${path}/.jj/repo`, target);
          return path;
        });
      const lead = yield* workspace("lead", store);
      const helper = yield* workspace("helper", store);
      const foreign = yield* workspace("foreign", otherStore);
      const nested = `${helper}/packages`;
      yield* f.fs.makeDirectory(nested);
      const isolated = (path: string, overrides: Partial<ReturnType<typeof request>> = {}) =>
        request({ workspacePath: path, workspaceAssignment: "isolated", ...overrides });
      const refused = (input: Partial<Parameters<typeof f.service.prepare>[0]>) =>
        f
          .prepare({
            workspacePath: lead,
            projectRoot: f.workspacePath,
            owner: "lead-thread",
            ...input,
          })
          .pipe(
            Effect.flip,
            Effect.map((error) => error.reason),
          );

      const accepted = yield* f.prepare({
        workspacePath: lead,
        projectRoot: f.workspacePath,
        owner: "lead-thread",
        request: isolated(helper),
      });
      expect(accepted.binding).toMatchObject({
        workspacePath: helper,
        workspaceAssignment: "isolated",
        sourceAccess: "scoped-write",
      });
      // Not the lead's own checkout, the main checkout, a subdirectory or another repository.
      expect(yield* refused({ request: isolated(lead) })).toBe("workspace");
      expect(yield* refused({ request: isolated(f.workspacePath) })).toBe("workspace");
      expect(yield* refused({ request: isolated(nested) })).toBe("workspace");
      expect(yield* refused({ request: isolated(foreign) })).toBe("workspace");
      // Without the explicit assignment a different path is still a wrong lead workspace.
      expect(yield* refused({ request: request({ workspacePath: helper }) })).toBe("workspace");

      // One writer at a time; a retry of the same work is not a second writer.
      const writer = {
        workspacePath: helper,
        owner: "lead-thread",
        workId: "other-work",
        attemptId: "attempt-test",
        writes: true,
        running: true,
      };
      expect(yield* refused({ request: isolated(helper), occupants: [writer] })).toBe("workspace");
      yield* f.prepare({
        workspacePath: lead,
        owner: "lead-thread",
        request: isolated(helper),
        occupants: [{ ...writer, workId: "work-test" }],
      });
      // A new attempt of the same work waits for the previous writer to stop.
      expect(
        yield* refused({
          request: isolated(helper, { attemptId: "attempt-2" }),
          occupants: [{ ...writer, workId: "work-test" }],
        }),
      ).toBe("workspace");
      // A workspace another lead holds is theirs, even while nothing runs in it.
      expect(
        yield* refused({
          request: isolated(helper),
          occupants: [{ ...writer, owner: "other-lead", running: false }],
        }),
      ).toBe("workspace");
      // This lead's own finished helper workspace can take its next task.
      yield* f.prepare({
        workspacePath: lead,
        owner: "lead-thread",
        request: isolated(helper),
        occupants: [{ ...writer, running: false }],
      });
      // A pinned read-only view tolerates other readers but not a live writer.
      const reviewer = isolated(helper, {
        role: "ticket-reviewer",
        sourceRevision,
        review: changeReview,
      });
      yield* f.prepare({
        workspacePath: lead,
        owner: "lead-thread",
        request: reviewer,
        occupants: [{ ...writer, writes: false }],
      });
      expect(yield* refused({ request: reviewer, occupants: [writer] })).toBe("workspace");

      // Validation re-checks against the lead it was accepted under.
      yield* f.service
        .validate({
          workspacePath: lead,
          providers: [codex, claude],
          ceiling: "full-access",
          binding: accepted.binding,
          selection: accepted.binding.effective,
        })
        .pipe(Effect.provideService(ConfigProvider.ConfigProvider, f.config));
      expect(
        (yield* f.service
          .validate({
            workspacePath: foreign,
            providers: [codex, claude],
            ceiling: "full-access",
            binding: accepted.binding,
            selection: accepted.binding.effective,
          })
          .pipe(Effect.provideService(ConfigProvider.ConfigProvider, f.config), Effect.flip))
          .reason,
      ).toBe("workspace");
    }),
  );

  it.effect("reports the handed-off source only for a finished isolated writer", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const lead = yield* f.prepare();
      expect(yield* f.service.handoff(lead.binding)).toBeUndefined();
      const isolated = { ...lead.binding, workspaceAssignment: "isolated" as const };
      expect(yield* f.service.handoff(isolated)).toEqual({
        workspacePath: f.workspacePath,
        revision: sourceRevision,
        quiescent: true,
      });
      expect(yield* f.service.handoff({ ...isolated, sourceAccess: "read-only" })).toBeUndefined();
    }),
  );

  it.effect("discovers the reviewer as a change review unless another scope is asked", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const reviewer = (reviewScope?: "change" | "spec") =>
        f.service
          .roles({
            providers: [codex, claude],
            ceiling: "full-access",
            request: {
              taskClass: "non-ui",
              sourceRevision,
              ...(reviewScope === undefined ? {} : { reviewScope }),
            },
          })
          .pipe(
            Effect.provideService(ConfigProvider.ConfigProvider, f.config),
            Effect.map((result) => result.roles.find((role) => role.role === "ticket-reviewer")!),
          );
      expect((yield* reviewer()).refusal).toBeNull();
      expect((yield* reviewer("spec")).refusal).toBeNull();
    }),
  );

  it.effect("discovers each role under a requested model, as a launch would resolve it", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const roles = (model: string, role: AgentTaskRequest["role"] = "advisor") =>
        f.service
          .roles({
            providers: [codex, claude],
            ceiling: "full-access",
            request: {
              taskClass: "non-ui",
              readOnly: true,
              sourceRevision: "reviewed-commit",
              authorModel: codexModel,
            },
            selection: { model },
          })
          .pipe(
            Effect.provideService(ConfigProvider.ConfigProvider, f.config),
            Effect.map((result) => result.roles.find((entry) => entry.role === role)!),
          );
      expect((yield* roles("gpt-astra-test")).selection?.model).toBe("gpt-astra-test");
      const outside = yield* roles(claudeModel);
      expect(outside.selection).toBeNull();
      expect(outside.refusal).toBe("selection-denied");
      // Model identity is a preference; an explicit eligible author-model choice is allowed.
      const reviewer = yield* roles(codexModel, "ticket-reviewer");
      expect(reviewer.refusal).toBeNull();
      const accepted = yield* f.prepare({
        request: request({
          role: "ticket-reviewer",
          workspacePath: f.workspacePath,
          sourceRevision,
          review: changeReview,
          authorModel: codexModel,
          readOnly: true,
        }),
        selection: { model: codexModel },
      });
      expect(accepted.binding).toMatchObject({
        authorModel: codexModel,
        sourceAccess: "read-only",
        toolProfile: "source-reader",
        requested: reviewer.selection,
        assigned: null,
        effective: reviewer.selection,
      });
      yield* f.validate(accepted.binding);
      expect(
        (yield* f.validate({ ...accepted.binding, sourceRevision: "wrong-pin" }).pipe(Effect.flip))
          .reason,
      ).toBe("source");
      expect(
        (yield* f.validate({ ...accepted.binding, workspacePath: f.root }).pipe(Effect.flip))
          .reason,
      ).toBe("workspace");
      expect((yield* roles(claudeModel, "ticket-reviewer")).selection?.model).toBe(claudeModel);
      // A launch names why the choice was refused.
      const refused = yield* f.prepare({ selection: { model: claudeModel } }).pipe(Effect.flip);
      expect(refused.message).toContain("selection-denied");
    }),
  );

  it.effect("lets an advisor follow-up omit its revision only outside a repository", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const advisor = (yield* f.prepare({
        request: request({ role: "advisor", workspacePath: f.workspacePath, readOnly: true }),
      })).binding;
      const followup = (revisionStated: boolean) =>
        f.service
          .validate({
            workspacePath: f.workspacePath,
            providers: [codex, claude],
            ceiling: "full-access",
            binding: revisionStated ? { ...advisor, sourceRevision } : advisor,
            selection: advisor.effective,
            followupWithoutRevision: !revisionStated,
          })
          .pipe(Effect.provideService(ConfigProvider.ConfigProvider, f.config));
      // A scratch folder has no revision to state.
      yield* followup(false);
      // In a repository the advisor reads a stated revision, which must match.
      yield* f.fs.makeDirectory(`${f.workspacePath}/.jj/repo`, { recursive: true });
      expect((yield* followup(false).pipe(Effect.flip)).reason).toBe("source");
      yield* followup(true);
    }),
  );

  it.effect("discovers the model a launch for the same caller would use", () =>
    Effect.gen(function* () {
      const f = yield* fixture;
      const advisorFor = (callerModel: string) =>
        f.service
          .roles({
            providers: [codex, claude],
            ceiling: "full-access",
            request: { taskClass: "non-ui" },
            callerModel,
          })
          .pipe(
            Effect.provideService(ConfigProvider.ConfigProvider, f.config),
            Effect.map((result) => result.roles.find((role) => role.role === "advisor")!),
          );
      // The policy starts an Opus caller's advisor with Astra; others follow the list.
      expect((yield* advisorFor("claude-opus-test")).selection?.model).toBe("gpt-astra-test");
      expect((yield* advisorFor(claudeModel)).selection?.model).toBe("claude-fable-test");
    }),
  );
});
