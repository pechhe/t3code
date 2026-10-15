import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import type { AgentPolicyManifest, AgentTaskBinding, ModelSelection } from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Sqlite from "../persistence/Sqlite.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as Managed from "./ManagedAgentService.ts";
import * as Store from "./AgentPolicyStore.ts";
import * as Policy from "./AgentPolicyService.ts";
import { snapshot, request, codex, claude, changeReview } from "./agentPolicy.testkit.ts";

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
        role: "reviewer",
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
      expect(
        (yield* f
          .validate({ ...accepted.binding, sourceRevision: "wrong-source" })
          .pipe(Effect.flip)).reason,
      ).toBe("source");
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
        role: "reviewer",
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
            Effect.map((result) => result.roles.find((role) => role.role === "reviewer")!),
          );
      expect((yield* reviewer()).refusal).toBeNull();
      expect((yield* reviewer("spec")).refusal).toBeNull();
    }),
  );
});
