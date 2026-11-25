import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import { symlinksSupported } from "@t3tools/shared/testing/symlinks";

import type { AntigravityProfile } from "./antigravityAuthSupport.ts";
import {
  describeAntigravitySetup,
  isAntigravityHelper,
  prepareAntigravityHelperProfile,
  trimLeadOnlyInstructions,
} from "./antigravityHelperProfile.ts";

const RULES = "shared rules\n<!-- lead-only-below -->\nlead secrets\n";

const fixture = Effect.fn(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const directory = yield* fs.makeTempDirectoryScoped();
  const userGemini = path.join(directory, "home", ".gemini");
  const agentConfig = path.join(directory, "home", ".agents");
  const instance = path.join(directory, "profile");
  for (const folder of [
    path.join(agentConfig, "skills", "lead-skill"),
    path.join(userGemini, "config", "own-skills", "mine"),
    path.join(userGemini, "config", "agents"),
    path.join(instance, "antigravity-acp"),
    path.join(instance, "config"),
  ]) {
    yield* fs.makeDirectory(folder, { recursive: true });
  }
  yield* fs.writeFileString(path.join(agentConfig, "skills", "lead-skill", "SKILL.md"), "lead");
  yield* fs.writeFileString(path.join(userGemini, "config", "own-skills", "mine", "SKILL.md"), "m");
  yield* fs.writeFileString(
    path.join(userGemini, "config", "agents", "pi-light.md"),
    "light agent",
  );
  yield* fs.writeFileString(path.join(agentConfig, "AGENTS.md"), RULES);
  yield* fs.writeFileString(path.join(userGemini, "GEMINI.md"), "gemini rules");
  yield* fs.writeFileString(
    path.join(instance, "antigravity-acp", "antigravity-oauth-token"),
    "secret",
  );
  yield* fs.symlink(path.join(agentConfig, "AGENTS.md"), path.join(userGemini, "AGENTS.md"));
  // The user's skills folder links the agent-config skills and one of the user's own.
  yield* fs.makeDirectory(path.join(userGemini, "config", "skills"));
  yield* fs.symlink(
    path.join(agentConfig, "skills", "lead-skill"),
    path.join(userGemini, "config", "skills", "lead-skill"),
  );
  yield* fs.symlink(
    path.join(userGemini, "config", "own-skills", "mine"),
    path.join(userGemini, "config", "skills", "mine"),
  );
  yield* fs.symlink(
    path.join(userGemini, "config", "skills"),
    path.join(instance, "config", "skills"),
  );
  yield* fs.symlink(
    path.join(userGemini, "config", "agents"),
    path.join(instance, "config", "agents"),
  );
  yield* fs.symlink(path.join(userGemini, "AGENTS.md"), path.join(instance, "AGENTS.md"));
  yield* fs.symlink(path.join(userGemini, "GEMINI.md"), path.join(instance, "GEMINI.md"));
  const profile: AntigravityProfile = {
    platform: "linux",
    geminiHome: instance,
    acpDirectory: path.join(instance, "antigravity-acp"),
    tokenPath: path.join(instance, "antigravity-acp", "acp_token.json"),
    tempDirectory: path.join(directory, "tmp"),
    browserCommand: "browser",
  };
  return { fs, path, directory, agentConfig, userGemini, instance, profile };
});

it.layer(NodeServices.layer)("Antigravity helper profile", (it) => {
  it("cuts instruction text from the lead-only marker line and keeps text without one", () => {
    expect(trimLeadOnlyInstructions(RULES)).toBe("shared rules\n");
    expect(trimLeadOnlyInstructions("a\r\n<!-- lead-only-below -->\r\nb")).toBe("a\r\n");
    expect(trimLeadOnlyInstructions("plain")).toBe("plain");
  });

  it("treats a delegated task as a helper unless its role is lead", () => {
    expect(isAntigravityHelper({})).toBe(false);
    expect(isAntigravityHelper({ delegated: true, delegatedRole: "lead" })).toBe(false);
    expect(isAntigravityHelper({ delegated: true, delegatedRole: "reviewer" })).toBe(true);
    expect(isAntigravityHelper({ delegated: true })).toBe(true);
  });

  it.effect.skipIf(!symlinksSupported)(
    "gives a helper trimmed instructions, only non-agent-config skills and the shared credentials",
    () =>
      Effect.gen(function* () {
        const { fs, path, directory, agentConfig, instance, profile } = yield* fixture();
        const helper = yield* prepareAntigravityHelperProfile({
          instance: profile,
          directory: path.join(directory, "helper"),
          role: "reviewer",
          agentConfigRoot: agentConfig,
        });

        expect(helper.geminiHome).toBe(path.join(directory, "helper"));
        expect(yield* fs.readFileString(path.join(helper.geminiHome, "AGENTS.md"))).toBe(
          "shared rules\n",
        );
        expect(yield* fs.readFileString(path.join(helper.geminiHome, "GEMINI.md"))).toBe(
          "gemini rules",
        );
        expect(yield* fs.readDirectory(path.join(helper.geminiHome, "config", "skills"))).toEqual([
          "mine",
        ]);
        expect(
          yield* fs.readFileString(path.join(helper.acpDirectory, "antigravity-oauth-token")),
        ).toBe("secret");
        expect(
          yield* fs.readFileString(path.join(helper.geminiHome, "config", "agents", "pi-light.md")),
        ).toBe("light agent");
        // The shared profile and the user's files are untouched.
        expect(yield* fs.readFileString(path.join(instance, "AGENTS.md"))).toBe(RULES);
        expect(yield* fs.readDirectory(path.join(instance, "config", "skills"))).toEqual([
          "lead-skill",
          "mine",
        ]);
      }),
  );

  it.effect.skipIf(!symlinksSupported)(
    "strips skills for a scout and keeps only the policy for a browser",
    () =>
      Effect.gen(function* () {
        const { fs, path, directory, agentConfig, profile } = yield* fixture();
        const scout = yield* prepareAntigravityHelperProfile({
          instance: profile,
          directory: path.join(directory, "scout"),
          role: "scout",
          agentConfigRoot: agentConfig,
        });
        expect(yield* fs.readDirectory(path.join(scout.geminiHome, "config", "skills"))).toEqual(
          [],
        );
        expect(yield* fs.exists(path.join(scout.geminiHome, "GEMINI.md"))).toBe(true);

        const browser = yield* prepareAntigravityHelperProfile({
          instance: profile,
          directory: path.join(directory, "browser"),
          role: "browser",
          agentConfigRoot: agentConfig,
        });
        expect(yield* fs.readFileString(path.join(browser.geminiHome, "AGENTS.md"))).toBe(
          "shared rules\n",
        );
        expect(yield* fs.exists(path.join(browser.geminiHome, "GEMINI.md"))).toBe(false);
      }),
  );

  it.effect.skipIf(!symlinksSupported)(
    "records what T3 gave the agent: instruction sizes after trimming, skills, the custom agent and its appended prompt",
    () =>
      Effect.gen(function* () {
        const { path, directory, agentConfig, profile } = yield* fixture();
        const describe = (home: string) =>
          describeAntigravitySetup({
            profileDirectory: home,
            agent: "pi-light",
            appendedSystemPrompt: "append",
          });
        const lead = yield* describe(profile.geminiHome);
        expect(lead.systemPromptCharacters).toBe(6);
        expect(
          lead.instructions.map(({ path: file, characters }) => [path.basename(file), characters]),
        ).toEqual([
          ["AGENTS.md", RULES.length],
          ["GEMINI.md", 12],
          ["pi-light.md", 11],
        ]);
        expect(lead.skills.map((skill) => skill.name)).toEqual(["lead-skill", "mine"]);

        const helper = yield* prepareAntigravityHelperProfile({
          instance: profile,
          directory: path.join(directory, "helper"),
          role: "reviewer",
          agentConfigRoot: agentConfig,
        });
        const trimmed = yield* describe(helper.geminiHome);
        expect(trimmed.instructions[0]?.characters).toBe("shared rules\n".length);
        expect(trimmed.skills.map((skill) => skill.name)).toEqual(["mine"]);
      }),
  );
});
