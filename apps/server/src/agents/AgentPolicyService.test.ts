import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Digest from "effect/crypto/Digest";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { AgentPolicyManifest } from "@t3tools/contracts";
import * as AgentPolicy from "./AgentPolicyService.ts";
import * as ProcessRunner from "../processRunner.ts";

function manifest() {
  const role = (
    list: string,
    name: string,
    sourceAccess: string,
    toolProfile: string,
    taskClasses = ["non-ui"],
  ) => ({ list, brief: `roles/${name}.md`, sourceAccess, toolProfile, taskClasses });
  const lists: Record<string, Array<{ model: string; effort: string }>> = Object.fromEntries(
    ["fast", "workhorse", "ui", "advisor"].map((name) => [
      name,
      [{ model: name, effort: "medium" }],
    ]),
  );
  return {
    version: 2,
    revision: "test-policy",
    models: Object.fromEntries(
      ["fast", "workhorse", "ui", "advisor"].map((name) => [
        name,
        { driverKind: "claudeAgent", model: `test-${name}`, effortOption: "effort" },
      ]),
    ),
    lists,
    roles: {
      implementer: role("workhorse", "implementer", "scoped-write", "implementation", [
        "non-ui",
        "ui",
        "mixed",
      ]),
      browser: role("fast", "browser", "read-only", "phi"),
      "ui-verifier": role("fast", "ui-verifier", "read-only", "phi", ["ui"]),
      advisor: role("advisor", "advisor", "read-only", "source-reader"),
      reviewer: {
        ...role("workhorse", "reviewer", "read-only", "source-reader"),
        specList: "workhorse",
      },
    },
  };
}

/** The same policy as saved before `implementer`, with the three writing roles in its place. */
function writerManifest() {
  const { implementer, ...current } = manifest().roles;
  const writer = (name: string, list: string, taskClasses: Array<string>) => ({
    ...implementer,
    list,
    brief: `roles/${name}.md`,
    taskClasses,
  });
  return {
    ...manifest(),
    roles: {
      ...current,
      "chore-worker": writer("chore-worker", "fast", ["non-ui"]),
      "implementation-worker": writer("implementation-worker", "workhorse", ["non-ui"]),
      "ui-worker": {
        ...writer("ui-worker", "ui", ["ui", "mixed"]),
        toolProfile: "implementation-phi",
      },
    },
  };
}

describe("policy authority", () => {
  const decode = Schema.decodeUnknownSync(AgentPolicyManifest);
  it("names each model in a list once", () => {
    const input = manifest();
    input.lists.workhorse = [
      { model: "workhorse", effort: "medium" },
      { model: "workhorse", effort: "high" },
    ];
    expect(() => decode(input)).toThrow();
  });
  it("refuses dangling aliases, empty or missing lists and role escalation", () => {
    const missing = manifest();
    delete missing.models.fast;
    expect(() => decode(missing)).toThrow();
    const empty = manifest();
    empty.lists.advisor = [];
    expect(() => decode(empty)).toThrow();
    const unknownList = manifest();
    unknownList.roles.advisor.list = "nowhere";
    expect(() => decode(unknownList)).toThrow();
    const access = manifest();
    access.roles["reviewer"].sourceAccess = "scoped-write";
    expect(() => decode(access)).toThrow();
    const browser = manifest();
    browser.roles.browser.toolProfile = "implementation";
    expect(() => decode(browser)).toThrow();
  });
  it("requires every role and contained canonical brief paths", () => {
    const input = manifest();
    const { reviewer: _spec, ...roles } = input.roles;
    expect(() => decode({ ...input, roles })).toThrow();
    input.roles["reviewer"].brief = "../secrets";
    expect(() => decode(input)).toThrow();
  });
  it("holds the implementer to the implementation tools", () => {
    const reader = manifest();
    reader.roles.implementer.toolProfile = "source-reader";
    expect(() => decode(reader)).toThrow();
  });
});

const testLayer = AgentPolicy.layer.pipe(
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);
const source = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "agent-policy-test-" });
  yield* fs.makeDirectory(`${root}/roles`);
  const input = manifest();
  yield* fs.writeFileString(`${root}/roles/policy.json`, JSON.stringify(input));
  for (const role of Object.values(input.roles))
    yield* fs.writeFileString(`${root}/${role.brief}`, `Brief for ${role.brief}\n`);
  return root;
});

const git = (cwd: string, ...args: ReadonlyArray<string>) =>
  Effect.gen(function* () {
    const processes = yield* ProcessRunner.ProcessRunner;
    const output = yield* processes.run({ command: "git", args, cwd, timeout: "30 seconds" });
    expect(output.code).toBe(0);
    return output.stdout.trim();
  }).pipe(Effect.provide(ProcessRunner.layer));

/** The same policy, in a git checkout on `main` whose `origin` is a bare remote. */
const gitSource = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const root = yield* fs.makeTempDirectoryScoped({ prefix: "agent-policy-git-" });
  const remote = yield* fs.makeTempDirectoryScoped({ prefix: "agent-policy-origin-" });
  yield* fs.makeDirectory(`${root}/roles`);
  const input = manifest();
  yield* fs.writeFileString(`${root}/roles/policy.json`, JSON.stringify(input));
  for (const role of Object.values(input.roles))
    yield* fs.writeFileString(`${root}/${role.brief}`, `Brief for ${role.brief}\n`);
  yield* fs.writeFileString(`${root}/notes.md`, "notes\n");
  yield* git(root, "init", "-b", "main");
  yield* git(root, "config", "user.email", "test@example.com");
  yield* git(root, "config", "user.name", "Test");
  yield* git(root, "add", ".");
  yield* git(root, "commit", "-m", "policy");
  yield* git(remote, "init", "--bare", "-b", "main");
  yield* git(root, "remote", "add", "origin", remote);
  yield* git(root, "push", "origin", "HEAD:main");
  return { root, remote, published: yield* git(remote, "rev-parse", "main") };
});

it.layer(testLayer)("immutable policy snapshots", (it) => {
  it.effect("saves a validated edit, advances its revision and preserves earlier snapshots", () =>
    Effect.gen(function* () {
      const service = yield* AgentPolicy.AgentPolicyService;
      const fs = yield* FileSystem.FileSystem;
      const root = yield* source;
      yield* fs.chmod(`${root}/roles/policy.json`, 0o640);
      const first = yield* service.snapshot(root);
      const edited = manifest();
      edited.revision = "caller-cannot-set-revision";
      edited.lists.workhorse = [{ model: "workhorse", effort: "high" }];
      const saved = yield* service.save(root, { expectedHash: first.hash, manifest: edited });
      expect(saved.snapshot.sourceRevision).toBe("test-policy.1");
      expect(saved.snapshot.manifest.lists["workhorse"]).toEqual([
        { model: "workhorse", effort: "high" },
      ]);
      expect(saved.snapshot.hash).not.toBe(first.hash);
      expect((yield* service.snapshot(root)).hash).toBe(saved.snapshot.hash);
      expect((yield* fs.stat(`${root}/roles/policy.json`)).mode & 0o777).toBe(0o640);
      expect(first.manifest.lists["workhorse"]?.[0]?.effort).toBe("medium");
      expect(Object.isFrozen(saved.snapshot.manifest)).toBe(true);
      // A policy root that is not a git checkout saves without publishing.
      expect(saved.publish).toEqual({ pushed: false, detail: "not a git checkout" });
      const again = yield* service.save(root, {
        expectedHash: saved.snapshot.hash,
        manifest: manifest(),
      });
      expect(again.snapshot.sourceRevision).toBe("test-policy.2");
      expect(yield* fs.readDirectory(`${root}/roles`)).not.toContainEqual(
        expect.stringMatching(/^\.policy-edit-/),
      );
    }),
  );
  it.effect(
    "loads a policy with the retired writing roles as implementer and saves it current",
    () =>
      Effect.gen(function* () {
        const service = yield* AgentPolicy.AgentPolicyService;
        const fs = yield* FileSystem.FileSystem;
        const root = yield* source;
        const retired = writerManifest();
        yield* fs.writeFileString(`${root}/roles/policy.json`, JSON.stringify(retired));
        yield* fs.remove(`${root}/roles/implementer.md`);
        for (const role of Object.values(retired.roles))
          yield* fs.writeFileString(`${root}/${role.brief}`, `Brief for ${role.brief}\n`);
        const first = yield* service.snapshot(root);
        // implementer takes the implementation-worker entry and its list, and every task class.
        expect(first.manifest.roles.implementer).toMatchObject({
          list: "workhorse",
          brief: "roles/implementer.md",
          toolProfile: "implementation",
          taskClasses: ["non-ui", "ui", "mixed"],
          browserTasks: true,
        });
        expect(first.briefs.implementer.text).toBe("Brief for roles/implementation-worker.md\n");
        yield* service.save(root, { expectedHash: first.hash, manifest: first.manifest });
        const written = JSON.parse(yield* fs.readFileString(`${root}/roles/policy.json`));
        for (const name of ["chore-worker", "implementation-worker", "ui-worker", "ui-verifier"])
          expect(Object.keys(written.roles)).not.toContain(name);
        expect(written.roles.implementer).toMatchObject({
          brief: "roles/implementer.md",
          browserTasks: true,
        });
        // The old brief serves until the new one is written; then the new one is read.
        yield* fs.writeFileString(`${root}/roles/implementer.md`, "Implementer brief\n");
        expect((yield* service.snapshot(root)).briefs.implementer.text).toBe("Implementer brief\n");
        yield* fs.remove(`${root}/roles/ui-verifier.md`);
        expect((yield* service.snapshot(root)).manifest.roles["ui-verifier"]).toBeUndefined();
      }),
  );

  it.effect("loads split policies through the Spec brief and saves both reviewer lists", () =>
    Effect.gen(function* () {
      const service = yield* AgentPolicy.AgentPolicyService;
      const fs = yield* FileSystem.FileSystem;
      const root = yield* source;
      // Split and version 1 policies both predate implementer.
      const current = writerManifest();
      const { reviewer, ...roles } = current.roles;
      yield* fs.remove(`${root}/roles/reviewer.md`);
      yield* fs.writeFileString(`${root}/roles/spec-reviewer.md`, "Spec rubric\n");
      yield* fs.writeFileString(`${root}/roles/ticket-reviewer.md`, "Change rubric\n");
      yield* fs.writeFileString(
        `${root}/roles/policy.json`,
        JSON.stringify({
          ...current,
          roles: {
            ...roles,
            "ticket-reviewer": { ...reviewer, brief: "roles/ticket-reviewer.md" },
            "spec-reviewer": { ...reviewer, list: "advisor", brief: "roles/spec-reviewer.md" },
          },
        }),
      );
      const first = yield* service.snapshot(root);
      expect(first.briefs.reviewer.text).toBe("Spec rubric\n");
      expect(first.manifest.roles.reviewer).not.toHaveProperty("large");
      expect(first.manifest.roles.reviewer.list).toBe("workhorse");
      expect(first.manifest.roles.reviewer.specList).toBe("advisor");
      expect(first.manifest.lists).toEqual(current.lists);
      const saved = yield* service.save(root, {
        expectedHash: first.hash,
        manifest: first.manifest,
      });
      const written = JSON.parse(yield* fs.readFileString(`${root}/roles/policy.json`));
      expect(written.roles.reviewer.brief).toBe("roles/reviewer.md");
      expect(written.roles.reviewer.specList).toBe("advisor");
      expect(written.roles).not.toHaveProperty("spec-reviewer");
      expect(yield* fs.exists(`${root}/roles/reviewer.md`)).toBe(false);
      expect((yield* service.snapshot(root)).hash).toBe(saved.snapshot.hash);
    }),
  );
  it.effect("reads an unconverted version 1 policy and saves it as version 2", () =>
    Effect.gen(function* () {
      const service = yield* AgentPolicy.AgentPolicyService;
      const fs = yield* FileSystem.FileSystem;
      const root = yield* source;
      // Split and version 1 policies both predate implementer.
      const current = writerManifest();
      const legacyRole = (name: string, role: (typeof current.roles)["advisor"]) => ({
        pool: role.list,
        brief: `roles/${name}.md`,
        sourceAccess: role.sourceAccess,
        toolProfile: role.toolProfile,
        taskClasses: role.taskClasses,
        restrictions: {},
        effort: { [role.list]: { default: "medium" } },
      });
      const { reviewer, ...roles } = current.roles;
      yield* fs.writeFileString(
        `${root}/roles/policy.json`,
        JSON.stringify({
          version: 1,
          revision: "legacy-policy",
          models: current.models,
          pools: Object.fromEntries(
            Object.keys(current.lists).map((name) => [name, { allow: [name], prefer: [name] }]),
          ),
          roles: {
            ...Object.fromEntries(
              Object.entries(roles).map(([name, role]) => [name, legacyRole(name, role)]),
            ),
            reviewer: legacyRole("reviewer", reviewer),
          },
        }),
      );
      const legacy = yield* service.snapshot(root);
      expect(legacy.manifest.roles["reviewer"].list).toBe("reviewer");
      expect(legacy.briefs["reviewer"].text).toBe("Brief for roles/reviewer.md\n");
      yield* service.save(root, { expectedHash: legacy.hash, manifest: legacy.manifest });
      expect(JSON.parse(yield* fs.readFileString(`${root}/roles/policy.json`)).version).toBe(2);
    }),
  );
  it.effect(
    "refuses stale edits after a policy or brief changes and preserves the newer bytes",
    () =>
      Effect.gen(function* () {
        const service = yield* AgentPolicy.AgentPolicyService;
        const fs = yield* FileSystem.FileSystem;
        const root = yield* source;
        const first = yield* service.snapshot(root);
        const changed = manifest();
        changed.revision = "external-change";
        const newerBytes = JSON.stringify(changed);
        yield* fs.writeFileString(`${root}/roles/policy.json`, newerBytes);
        expect(
          (yield* service
            .save(root, {
              expectedHash: first.hash,
              manifest: manifest(),
            })
            .pipe(Effect.flip)).reason,
        ).toBe("stale");
        expect(yield* fs.readFileString(`${root}/roles/policy.json`)).toBe(newerBytes);
        const second = yield* service.snapshot(root);
        yield* fs.writeFileString(`${root}/roles/reviewer.md`, "External rubric change");
        expect(
          (yield* service
            .save(root, {
              expectedHash: second.hash,
              manifest: manifest(),
            })
            .pipe(Effect.flip)).reason,
        ).toBe("stale");
        expect(yield* fs.readFileString(`${root}/roles/policy.json`)).toBe(newerBytes);
      }),
  );
  it.effect("accepts only one of two concurrent saves from the same loaded policy", () =>
    Effect.gen(function* () {
      const service = yield* AgentPolicy.AgentPolicyService;
      const root = yield* source;
      const first = yield* service.snapshot(root);
      const edit = { expectedHash: first.hash, manifest: manifest() };
      const results = yield* Effect.all(
        [
          service.save(root, edit).pipe(Effect.result),
          service.save(root, edit).pipe(Effect.result),
        ],
        { concurrency: "unbounded" },
      );
      expect(results.filter((result) => result._tag === "Success")).toHaveLength(1);
      expect(results.filter((result) => result._tag === "Failure")).toMatchObject([
        { failure: { reason: "stale" } },
      ]);
    }),
  );
  it.effect("invalid, unknown and oversized edits leave the working policy untouched", () =>
    Effect.gen(function* () {
      const service = yield* AgentPolicy.AgentPolicyService;
      const fs = yield* FileSystem.FileSystem;
      const root = yield* source;
      const first = yield* service.snapshot(root);
      const original = yield* fs.readFileString(`${root}/roles/policy.json`);
      const invalid = manifest();
      invalid.lists.workhorse = [];
      const oversized = manifest();
      oversized.models.workhorse!.model = "x".repeat(65_537);
      for (const [proposed, reason] of [
        [invalid, "invalid"],
        [{ ...manifest(), unknownSetting: true }, "invalid"],
        [oversized, "too-large"],
      ] as const) {
        expect(
          (yield* service
            .save(root, {
              expectedHash: first.hash,
              manifest: proposed,
            })
            .pipe(Effect.flip)).reason,
        ).toBe(reason);
        expect(yield* fs.readFileString(`${root}/roles/policy.json`)).toBe(original);
      }
    }),
  );
  it.effect("a failed atomic publication leaves the old policy and removes staged files", () =>
    Effect.gen(function* () {
      const service = yield* AgentPolicy.AgentPolicyService;
      const fs = yield* FileSystem.FileSystem;
      const root = yield* source;
      const first = yield* service.snapshot(root);
      const original = yield* fs.readFileString(`${root}/roles/policy.json`);
      const failure = yield* Effect.gen(function* () {
        const writer = yield* AgentPolicy.AgentPolicyService;
        return yield* writer.save(root, { expectedHash: first.hash, manifest: manifest() });
      }).pipe(
        Effect.provide(Layer.fresh(AgentPolicy.layer)),
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          rename: () => fs.rename(`${root}/missing-file`, `${root}/never-written`),
        }),
        Effect.flip,
      );
      expect(failure.reason).toBe("write");
      expect(yield* fs.readFileString(`${root}/roles/policy.json`)).toBe(original);
      expect(yield* fs.readDirectory(`${root}/roles`)).not.toContainEqual(
        expect.stringMatching(/^\.policy-edit-/),
      );
      expect(
        (yield* service.save(root, { expectedHash: first.hash, manifest: manifest() })).snapshot
          .sourceRevision,
      ).toBe("test-policy.1");
    }),
  );
  it.effect("a separate service cannot overwrite a policy while another holds the file lock", () =>
    Effect.gen(function* () {
      const firstService = yield* AgentPolicy.AgentPolicyService;
      const fs = yield* FileSystem.FileSystem;
      const root = yield* source;
      const first = yield* firstService.snapshot(root);
      let competingReason: string | undefined;
      yield* Effect.gen(function* () {
        const secondService = yield* AgentPolicy.AgentPolicyService;
        yield* secondService.save(root, { expectedHash: first.hash, manifest: manifest() });
      }).pipe(
        Effect.provide(Layer.fresh(AgentPolicy.layer)),
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          writeFileString: (file, text, options) =>
            fs.writeFileString(file, text, options).pipe(
              Effect.andThen(
                firstService.save(root, { expectedHash: first.hash, manifest: manifest() }).pipe(
                  Effect.result,
                  Effect.tap((result) =>
                    Effect.sync(() => {
                      if (result._tag === "Failure") competingReason = result.failure.reason;
                    }),
                  ),
                  Effect.asVoid,
                ),
              ),
            ),
        }),
      );
      expect(competingReason).toBe("busy");
      expect(
        (yield* firstService
          .save(root, { expectedHash: first.hash, manifest: manifest() })
          .pipe(Effect.flip)).reason,
      ).toBe("stale");
      const latest = yield* firstService.snapshot(root);
      expect(
        (yield* firstService.save(root, { expectedHash: latest.hash, manifest: manifest() }))
          .snapshot.sourceRevision,
      ).toBe("test-policy.2");
    }),
  );
  it.effect("rechecks an external edit made while the replacement is being staged", () =>
    Effect.gen(function* () {
      const service = yield* AgentPolicy.AgentPolicyService;
      const fs = yield* FileSystem.FileSystem;
      const root = yield* source;
      const first = yield* service.snapshot(root);
      const external = JSON.stringify({ ...manifest(), revision: "external-during-save" });
      const result = yield* Effect.gen(function* () {
        const writer = yield* AgentPolicy.AgentPolicyService;
        return yield* writer.save(root, { expectedHash: first.hash, manifest: manifest() });
      }).pipe(
        Effect.provide(Layer.fresh(AgentPolicy.layer)),
        Effect.provideService(FileSystem.FileSystem, {
          ...fs,
          writeFileString: (file, text, options) =>
            fs
              .writeFileString(file, text, options)
              .pipe(Effect.andThen(fs.writeFileString(`${root}/roles/policy.json`, external))),
        }),
        Effect.flip,
      );
      expect(result.reason).toBe("stale");
      expect(yield* fs.readFileString(`${root}/roles/policy.json`)).toBe(external);
      expect(yield* fs.readDirectory(`${root}/roles`)).not.toContainEqual(
        expect.stringMatching(/^\.policy-edit-/),
      );
    }),
  );
  it.effect("pins all briefs and changes identity when source changes", () =>
    Effect.gen(function* () {
      const service = yield* AgentPolicy.AgentPolicyService;
      const fs = yield* FileSystem.FileSystem;
      const root = yield* source;
      const first = yield* service.snapshot(root);
      const crypto = yield* Digest.Digest;
      expect(first.briefs["reviewer"].text).toBe("Brief for roles/reviewer.md\n");
      expect(first.briefs["reviewer"].hash).toBe(
        Hex.encode(
          yield* crypto.digest(
            Digest.sha256,
            new TextEncoder().encode(first.briefs["reviewer"].text),
          ),
        ),
      );
      const retry = yield* service.snapshot(root);
      expect(retry.hash).toBe(first.hash);
      yield* fs.writeFileString(`${root}/roles/reviewer.md`, "Changed rubric");
      const second = yield* service.snapshot(root);
      expect(second.hash).not.toBe(first.hash);
      expect(second.briefs["reviewer"].hash).not.toBe(first.briefs["reviewer"].hash);
      expect(first.briefs["reviewer"].text).not.toBe("Changed rubric");
      expect(Object.isFrozen(first.manifest.lists["workhorse"])).toBe(true);
      expect(Object.isFrozen(first.briefs["reviewer"])).toBe(true);
    }),
  );
  it.effect("refuses missing briefs and symlinks outside the source root", () =>
    Effect.gen(function* () {
      const service = yield* AgentPolicy.AgentPolicyService;
      const fs = yield* FileSystem.FileSystem;
      const root = yield* source;
      yield* fs.remove(`${root}/roles/reviewer.md`);
      const missing = yield* service.snapshot(root).pipe(Effect.flip);
      expect(missing.reason).toBe("read");
      const other = yield* fs.makeTempDirectoryScoped({ prefix: "agent-policy-outside-" });
      yield* fs.writeFileString(`${other}/brief.md`, "Outside");
      yield* fs.symlink(`${other}/brief.md`, `${root}/roles/reviewer.md`);
      const escaped = yield* service.snapshot(root).pipe(Effect.flip);
      expect(escaped.reason).toBe("outside-root");
    }),
  );
  it.effect("names the policy file and field it could not load", () =>
    Effect.gen(function* () {
      const service = yield* AgentPolicy.AgentPolicyService;
      const fs = yield* FileSystem.FileSystem;
      const root = yield* source;
      const invalid = manifest();
      invalid.revision = "";
      yield* fs.writeFileString(`${root}/roles/policy.json`, JSON.stringify(invalid));
      const refusal = yield* service.snapshot(root).pipe(Effect.flip);
      expect(refusal.reason).toBe("invalid");
      expect(refusal.message).toContain("roles/policy.json");
      expect(refusal.message).toContain('["revision"]');
      yield* fs.remove(`${root}/roles/policy.json`);
      const missing = yield* service.snapshot(root).pipe(Effect.flip);
      expect(missing.reason).toBe("read");
      expect(missing.message).toContain("roles/policy.json");
    }),
  );
  it.effect("rejects oversized and invalid policy without falling back", () =>
    Effect.gen(function* () {
      const service = yield* AgentPolicy.AgentPolicyService;
      const fs = yield* FileSystem.FileSystem;
      const root = yield* source;
      yield* fs.writeFileString(`${root}/roles/policy.json`, "x".repeat(65_537));
      expect((yield* service.snapshot(root).pipe(Effect.flip)).reason).toBe("too-large");
      yield* fs.writeFileString(`${root}/roles/policy.json`, "{}");
      expect((yield* service.snapshot(root).pipe(Effect.flip)).reason).toBe("invalid");
    }),
  );
  it.effect("publishes one save to origin/main and leaves other changes where they were", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const service = yield* AgentPolicy.AgentPolicyService;
        const fs = yield* FileSystem.FileSystem;
        const { root, remote } = yield* gitSource;
        // A staged and an unstaged change must survive the save untouched.
        yield* fs.writeFileString(`${root}/staged.md`, "staged\n");
        yield* git(root, "add", "staged.md");
        yield* fs.writeFileString(`${root}/notes.md`, "edited\n");
        const first = yield* service.snapshot(root);
        const saved = yield* service.save(root, { expectedHash: first.hash, manifest: manifest() });
        expect(saved.publish).toEqual({ pushed: true, detail: null });
        expect(saved.snapshot.sourceRevision).toBe("test-policy.1");
        expect((yield* git(remote, "show", "main:roles/policy.json")).trim()).toBe(
          (yield* fs.readFileString(`${root}/roles/policy.json`)).trim(),
        );
        expect((yield* git(remote, "show", "main:roles/policy.json")).trim()).toContain(
          '"revision": "test-policy.1"',
        );
        // The commit carries the policy alone: the staged file stays staged and the edit unstaged.
        expect((yield* git(root, "show", "--name-only", "--format=", "HEAD")).trim()).toBe(
          "roles/policy.json",
        );
        expect(yield* git(root, "diff", "--cached", "--name-only")).toBe("staged.md");
        expect(yield* git(root, "diff", "--name-only")).toBe("notes.md");
      }),
    ),
  );
  it.effect("keeps the saved policy when the push is rejected", () =>
    Effect.scoped(
      Effect.gen(function* () {
        const service = yield* AgentPolicy.AgentPolicyService;
        const fs = yield* FileSystem.FileSystem;
        const { root, remote, published } = yield* gitSource;
        yield* fs.makeDirectory(`${remote}/hooks`, { recursive: true });
        yield* fs.writeFileString(`${remote}/hooks/pre-receive`, "#!/bin/sh\nexit 1\n");
        yield* fs.chmod(`${remote}/hooks/pre-receive`, 0o755);
        const first = yield* service.snapshot(root);
        const saved = yield* service.save(root, { expectedHash: first.hash, manifest: manifest() });
        expect(saved.publish).toEqual({
          pushed: false,
          detail: "push rejected: pull agent-config's main, then save again",
        });
        expect(saved.snapshot.sourceRevision).toBe("test-policy.1");
        expect(JSON.parse(yield* fs.readFileString(`${root}/roles/policy.json`)).revision).toBe(
          "test-policy.1",
        );
        // Nothing reached the remote, so its main still names the old policy.
        expect(yield* git(remote, "rev-parse", "main")).toBe(published);
        // Once the remote accepts again, the next save pushes the refused commit with its own.
        yield* fs.remove(`${remote}/hooks/pre-receive`);
        const next = yield* service.save(root, {
          expectedHash: saved.snapshot.hash,
          manifest: manifest(),
        });
        expect(next.publish).toEqual({ pushed: true, detail: null });
        expect(yield* git(remote, "rev-list", "--count", `${published}..main`)).toBe("2");
      }),
    ),
  );
});
