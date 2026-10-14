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
import { snapshot, request, codex, claude } from "./agentPolicy.testkit.ts";

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
  };
});

it.layer(testLayer)("ManagedAgentService", (it) => {
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
});
