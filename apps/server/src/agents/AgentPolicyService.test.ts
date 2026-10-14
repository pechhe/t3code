import * as NodeServices from "@effect/platform-node/NodeServices";
import { it, describe, expect } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Crypto from "effect/Crypto";
import * as Hex from "effect/encoding/Hex";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import { AgentPolicyManifest } from "@t3tools/contracts";
import * as AgentPolicy from "./AgentPolicyService.ts";

function manifest() {
  const role = (
    pool: string,
    name: string,
    sourceAccess: string,
    toolProfile: string,
    taskClasses = ["non-ui"],
  ) => ({
    pool,
    brief: `roles/${name}.md`,
    sourceAccess,
    toolProfile,
    taskClasses,
    restrictions: {},
    effort: { [pool]: { default: "medium" } },
  });
  return {
    version: 1,
    revision: "test-policy",
    models: Object.fromEntries(
      ["fast", "workhorse", "ui", "advisor"].map((name) => [
        name,
        { driverKind: "claudeAgent", model: `test-${name}`, effortOption: "effort" },
      ]),
    ),
    pools: Object.fromEntries(
      ["fast", "workhorse", "ui", "advisor"].map((name) => [
        name,
        { allow: [name], prefer: [name] },
      ]),
    ),
    roles: {
      "chore-worker": role("fast", "chore-worker", "scoped-write", "implementation"),
      "implementation-worker": role(
        "workhorse",
        "implementation-worker",
        "scoped-write",
        "implementation",
      ),
      "ui-worker": role("ui", "ui-worker", "scoped-write", "implementation", ["ui", "mixed"]),
      browser: role("fast", "browser", "read-only", "phi"),
      "ui-verifier": role("fast", "ui-verifier", "read-only", "phi", ["ui"]),
      advisor: role("advisor", "advisor", "read-only", "source-reader"),
      reviewer: role("workhorse", "reviewer", "read-only", "source-reader"),
    },
  };
}

describe("policy authority", () => {
  const decode = Schema.decodeUnknownSync(AgentPolicyManifest);
  it("keeps preferences separate from allowed candidates", () => {
    const input = manifest();
    input.pools.workhorse = { allow: ["workhorse"], prefer: [] };
    expect(decode(input).pools.workhorse).toEqual({ allow: ["workhorse"], prefer: [] });
    input.pools.workhorse.prefer = ["fast"];
    expect(() => decode(input)).toThrow();
  });
  it("refuses dangling aliases, missing effort and role escalation", () => {
    const missing = manifest();
    delete missing.models.fast;
    expect(() => decode(missing)).toThrow();
    const effort = manifest();
    effort.roles.reviewer.effort = {};
    expect(() => decode(effort)).toThrow();
    const access = manifest();
    access.roles.reviewer.sourceAccess = "scoped-write";
    expect(() => decode(access)).toThrow();
    const browser = manifest();
    browser.roles.browser.toolProfile = "implementation";
    expect(() => decode(browser)).toThrow();
  });
  it("requires seven roles and contained canonical brief paths", () => {
    const input = manifest();
    const { reviewer: _reviewer, ...roles } = input.roles;
    expect(() => decode({ ...input, roles })).toThrow();
    input.roles.reviewer.brief = "../secrets";
    expect(() => decode(input)).toThrow();
  });
  it("does not allow a separate reviewer pool or UI implementation worker", () => {
    const input = manifest();
    input.roles.reviewer.pool = "advisor";
    expect(() => decode(input)).toThrow();
    const mixed = manifest();
    mixed.roles["implementation-worker"].taskClasses = ["mixed"];
    expect(() => decode(mixed)).toThrow();
  });
});

const testLayer = AgentPolicy.layer.pipe(Layer.provideMerge(NodeServices.layer));
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

it.layer(testLayer)("immutable policy snapshots", (it) => {
  it.effect("pins all briefs and changes identity when source changes", () =>
    Effect.gen(function* () {
      const service = yield* AgentPolicy.AgentPolicyService;
      const fs = yield* FileSystem.FileSystem;
      const root = yield* source;
      const first = yield* service.snapshot(root);
      const crypto = yield* Crypto.Crypto;
      expect(first.briefs.reviewer.text).toBe("Brief for roles/reviewer.md\n");
      expect(first.briefs.reviewer.hash).toBe(
        Hex.encode(
          yield* crypto.digest("SHA-256", new TextEncoder().encode(first.briefs.reviewer.text)),
        ),
      );
      const retry = yield* service.snapshot(root);
      expect(retry.hash).toBe(first.hash);
      yield* fs.writeFileString(`${root}/roles/reviewer.md`, "Changed rubric");
      const second = yield* service.snapshot(root);
      expect(second.hash).not.toBe(first.hash);
      expect(second.briefs.reviewer.hash).not.toBe(first.briefs.reviewer.hash);
      expect(first.briefs.reviewer.text).not.toBe("Changed rubric");
      expect(Object.isFrozen(first.manifest.pools.workhorse.allow)).toBe(true);
      expect(Object.isFrozen(first.briefs.reviewer)).toBe(true);
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
});
