// @effect-diagnostics-next-line nodeBuiltinImport:off - Effect's symlink has no type argument, and Windows needs a junction to link without elevation.
import * as NodeFSP from "node:fs/promises";

import type { RunSetupComposedPrompt } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import type { AntigravityProfile } from "./antigravityAuthSupport.ts";

/** An instruction file's text from this line on is for the lead only; helpers never see it. */
const LEAD_ONLY_MARKER = /^<!-- lead-only-below -->\r?$/m;

export function trimLeadOnlyInstructions(content: string): string {
  const marker = LEAD_ONLY_MARKER.exec(content);
  return marker === null ? content : content.slice(0, marker.index);
}

export class AntigravityHelperLinkError extends Schema.TaggedError<AntigravityHelperLinkError>()(
  "AntigravityHelperLinkError",
  { link: Schema.String, cause: Schema.Defect() },
) {
  override get message(): string {
    return `Could not link the Antigravity helper profile entry ${this.link}.`;
  }
}

const INSTRUCTION_FILES = ["AGENTS.md", "GEMINI.md"] as const;
/** Directories of the profile that hold a `skills` folder next to other entries. */
const SKILL_PARENTS = ["config", "antigravity-cli"] as const;
/** Roles whose helpers get no skills at all; the browser role also keeps only the global policy. */
const SKILLLESS_ROLES: ReadonlySet<string> = new Set(["browser", "scout", "advisor"]);
/** Skills nest at most this deep below a skills directory (`routines/<name>`). */
const SKILL_DEPTH = 2;

/** A helper is any delegated task that is not the lead, an unknown role included, as for Pi. */
export const isAntigravityHelper = (session: {
  readonly delegated?: boolean | undefined;
  readonly delegatedRole?: string | undefined;
}) => session.delegated === true && session.delegatedRole !== "lead";

const exists = (fs: FileSystem.FileSystem, target: string) =>
  fs.exists(target).pipe(Effect.orElseSucceed(() => false));

const realPath = (fs: FileSystem.FileSystem, target: string) =>
  fs.realPath(target).pipe(Effect.orElseSucceed(() => target));

const isWithin = (path: Path.Path, root: string, target: string) => {
  const relative = path.relative(root, target);
  return (
    relative === "" ||
    (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative))
  );
};

/** Links `link` to `target`; Windows junctions directories and copies files, which need elevation to link. */
const linkEntry = Effect.fn("antigravityHelperProfile.linkEntry")(function* (
  target: string,
  link: string,
  platform: NodeJS.Platform,
) {
  const fs = yield* FileSystem.FileSystem;
  const info = yield* fs.stat(target).pipe(Effect.option);
  if (info._tag === "None") return;
  if (info.value.type === "Directory") {
    yield* Effect.tryPromise({
      try: () => NodeFSP.symlink(target, link, platform === "win32" ? "junction" : "dir"),
      catch: (cause) => new AntigravityHelperLinkError({ link, cause }),
    });
  } else if (platform === "win32") {
    yield* fs.copyFile(target, link);
  } else {
    yield* Effect.tryPromise({
      try: () => NodeFSP.symlink(target, link, "file"),
      catch: (cause) => new AntigravityHelperLinkError({ link, cause }),
    });
  }
});

/**
 * A per-launch profile for a delegated helper, derived from the instance profile: every entry is a link
 * to the instance's (so credentials, sessions and the user's tooling are shared), except trimmed copies
 * of the instruction files and a `skills` folder holding only the skills the helper may see. Nothing
 * of the instance profile or the user's files is written.
 */
export const prepareAntigravityHelperProfile = Effect.fn("prepareAntigravityHelperProfile")(
  function* (input: {
    readonly instance: AntigravityProfile;
    readonly directory: string;
    readonly role: string | undefined;
    /** Skills under this checkout stay with the lead. */
    readonly agentConfigRoot: string | undefined;
  }) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const { instance, directory } = input;
    const root =
      input.agentConfigRoot === undefined ? undefined : yield* realPath(fs, input.agentConfigRoot);
    const policy = root === undefined ? undefined : path.join(root, "AGENTS.md");
    const skillless = input.role !== undefined && SKILLLESS_ROLES.has(input.role);
    yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
    const link = (name: string, parent = "") =>
      linkEntry(
        path.join(instance.geminiHome, parent, name),
        path.join(directory, parent, name),
        instance.platform,
      );
    for (const name of yield* fs.readDirectory(instance.geminiHome)) {
      if ((INSTRUCTION_FILES as ReadonlyArray<string>).includes(name)) {
        const source = path.join(instance.geminiHome, name);
        // The browser keeps the global policy alone, even when the profile reaches it through a link.
        if (
          input.role === "browser" &&
          (policy === undefined || (yield* realPath(fs, source)) !== policy)
        ) {
          continue;
        }
        const content = yield* fs.readFileString(source).pipe(Effect.option);
        if (content._tag === "Some") {
          yield* fs.writeFileString(
            path.join(directory, name),
            trimLeadOnlyInstructions(content.value),
          );
        }
      } else if (!(SKILL_PARENTS as ReadonlyArray<string>).includes(name)) {
        yield* link(name);
      }
    }
    for (const parent of SKILL_PARENTS) {
      const source = path.join(instance.geminiHome, parent);
      if (!(yield* exists(fs, source))) continue;
      // Evidence (an instance profile after 12 days of use): agy keeps conversations, MCP state and
      // sessions under `antigravity-acp` (linked), and writes nothing new in these two directories
      // after the first launch, so a real directory here loses no state.
      yield* fs.makeDirectory(path.join(directory, parent), { recursive: true, mode: 0o700 });
      for (const name of yield* fs.readDirectory(source)) {
        if (name !== "skills") {
          yield* link(name, parent);
          continue;
        }
        const skills = path.join(directory, parent, "skills");
        yield* fs.makeDirectory(skills, { recursive: true });
        if (skillless) continue;
        const skillSource = path.join(source, "skills");
        for (const skill of yield* fs
          .readDirectory(skillSource)
          .pipe(Effect.orElseSucceed(() => []))) {
          const target = path.join(skillSource, skill);
          if (root !== undefined && isWithin(path, root, yield* realPath(fs, target))) continue;
          yield* linkEntry(target, path.join(skills, skill), instance.platform);
        }
      }
    }
    return {
      ...instance,
      geminiHome: directory,
      acpDirectory: path.join(directory, "antigravity-acp"),
      tokenPath: path.join(directory, "antigravity-acp", path.basename(instance.tokenPath)),
    } satisfies AntigravityProfile;
  },
);

/**
 * What T3 knows of the agent's setup, in the shape Pi reports what it composed: the instruction files
 * the profile holds, the skills it lists, the selected custom agent's file, and T3's appended system
 * prompt. agy's own system prompt and tool declarations are hidden from T3, so those are not counted.
 */
export const describeAntigravitySetup = Effect.fn("describeAntigravitySetup")(function* (input: {
  readonly profileDirectory: string;
  readonly agent: string | undefined;
  readonly appendedSystemPrompt: string | undefined;
}) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const instructions: Array<{ path: string; characters: number }> = [];
  const sized = (file: string) =>
    fs.readFileString(file).pipe(
      Effect.map((content) => content.length),
      Effect.option,
    );
  for (const name of INSTRUCTION_FILES) {
    const file = path.join(input.profileDirectory, name);
    const characters = yield* sized(file);
    if (characters._tag === "Some") instructions.push({ path: file, characters: characters.value });
  }
  const agentName = input.agent?.trim();
  if (agentName) {
    const file = path.join(input.profileDirectory, "config", "agents", `${agentName}.md`);
    const characters = yield* sized(file);
    if (characters._tag === "Some") instructions.push({ path: file, characters: characters.value });
  }
  const skills: Array<{ name: string; path: string }> = [];
  const visit: (directory: string, base: string, depth: number) => Effect.Effect<void> = Effect.fn(
    "antigravityHelperProfile.visitSkills",
  )(function* (directory: string, base: string, depth: number) {
    for (const entry of [
      ...(yield* fs.readDirectory(directory).pipe(Effect.orElseSucceed(() => []))),
    ].sort()) {
      if (entry.startsWith(".")) continue;
      const child = path.join(directory, entry);
      const skillFile = path.join(child, "SKILL.md");
      if (yield* exists(fs, skillFile)) {
        skills.push({
          name: path.relative(base, child).split(path.sep).join("/"),
          path: skillFile,
        });
      } else if (depth < SKILL_DEPTH) {
        yield* visit(child, base, depth + 1);
      }
    }
  });
  for (const parent of SKILL_PARENTS) {
    const base = path.join(input.profileDirectory, parent, "skills");
    yield* visit(base, base, 1);
  }
  return {
    systemPromptCharacters: input.appendedSystemPrompt?.length ?? 0,
    instructions,
    skills,
    tools: { count: 0, characters: 0, declarations: [] },
  } satisfies RunSetupComposedPrompt;
});
