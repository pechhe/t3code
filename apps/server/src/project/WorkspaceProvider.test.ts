import { expect, it } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import * as Effect from "effect/Effect";
import * as Deferred from "effect/Deferred";
import * as Fiber from "effect/Fiber";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";
import * as Processes from "../processRunner.ts";
import * as Git from "../vcs/GitVcsDriver.ts";
import * as Workspaces from "./WorkspaceProvider.ts";

const output = (stdout = "") => ({
  stdout,
  stderr: "",
  code: ChildProcessSpawner.ExitCode(0),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});
it.layer(NodeServices.layer)("WorkspaceProvider lifecycle", (it) => {
  it.effect("removes JJ checkouts through SlipJay and linked Git worktrees through Git", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
      yield* fs.makeDirectory(`${root}/.jj`);
      yield* fs.writeFileString(`${root}/slipjay.json`, "{}");
      yield* fs.makeDirectory(`${root}/jj-child/.jj`, { recursive: true });
      yield* fs.makeDirectory(`${root}/git-child`);
      const commands: string[][] = [];
      const gitPaths: string[] = [];
      const service = yield* Workspaces.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(Processes.ProcessRunner)({
              run: (input) =>
                Effect.sync(() => {
                  commands.push([input.command, ...input.args]);
                  return output();
                }),
            }),
            Layer.mock(Git.GitVcsDriver)({
              removeWorktree: (input) =>
                Effect.sync(() => {
                  gitPaths.push(input.path);
                }),
            }),
          ),
        ),
      );
      yield* service.remove({ cwd: root, path: `${root}/jj-child`, force: true });
      yield* service.remove({ cwd: root, path: `${root}/git-child`, force: true });
      expect(commands).toEqual([["slipjay", "remove", `${root}/jj-child`]]);
      expect(gitPaths).toEqual([`${root}/git-child`]);
    }),
  );

  it.effect("finds a SlipJay project from its Jujutsu root, never from a Git-only repository", () =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const root = yield* fs.realPath(yield* fs.makeTempDirectoryScoped());
      const cwds: string[] = [];
      const service = yield* Workspaces.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(Processes.ProcessRunner)({
              run: (input) =>
                Effect.sync(() => {
                  // Nothing is committed on trunk() in these repositories.
                  if (input.command === "jj")
                    return { ...output(), code: ChildProcessSpawner.ExitCode(1) };
                  cwds.push(input.cwd ?? "");
                  return output(JSON.stringify({ workspacePath: `${root}/allocated` }));
                }),
            }),
            Layer.mock(Git.GitVcsDriver)({}),
          ),
        ),
      );
      yield* fs.makeDirectory(`${root}/jj/.jj`, { recursive: true });
      yield* fs.makeDirectory(`${root}/jj/packages/app`, { recursive: true });
      yield* fs.writeFileString(`${root}/jj/slipjay.json`, "{ not json");
      yield* fs.makeDirectory(`${root}/git/.git`, { recursive: true });
      yield* fs.makeDirectory(`${root}/git/packages/app`, { recursive: true });
      yield* fs.writeFileString(`${root}/git/slipjay.json`, "{}");
      yield* fs.makeDirectory(`${root}/plain-jj/.jj`, { recursive: true });
      // A subdirectory of a SlipJay project is one too, even when SlipJay cannot read its config.
      expect(yield* service.resolve(`${root}/jj/packages/app`)).toBe("slipjay");
      expect(yield* service.resolve(`${root}/git/packages/app`)).toBe("git-worktree");
      expect(yield* service.resolve(`${root}/plain-jj`)).toBe("git-worktree");
      // It allocates from the SlipJay root, where slipjay.json lives.
      yield* service.allocate({ projectRoot: `${root}/jj/packages/app`, task: "work" });
      expect(cwds).toEqual([`${root}/jj`]);
    }),
  );

  it.effect.each([true, false])(
    "releases a workspace it created when cancellation arrives before SlipJay emits the allocation receipt: %s",
    (created) =>
      Effect.gen(function* () {
        const entered = yield* Deferred.make<void>();
        const allowReceipt = yield* Deferred.make<void>();
        const commands: string[][] = [];
        const service = yield* Workspaces.make.pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.mock(Processes.ProcessRunner)({
                run: (input) =>
                  Effect.gen(function* () {
                    commands.push([input.command, ...input.args]);
                    if (input.args[0] === "start") {
                      yield* Deferred.succeed(entered, undefined);
                      yield* Deferred.await(allowReceipt);
                      return output(
                        JSON.stringify({ workspacePath: "/allocated-jj-workspace", created }),
                      );
                    }
                    return output();
                  }),
              }),
              Layer.mock(Git.GitVcsDriver)({}),
            ),
          ),
        );
        const allocation = yield* service
          .allocate({ projectRoot: "/project", task: "Bounded work" })
          .pipe(Effect.forkChild);
        yield* Deferred.await(entered);
        yield* Effect.sync(() => allocation.interruptUnsafe());
        yield* Deferred.succeed(allowReceipt, undefined);
        expect(Exit.isFailure(yield* Fiber.await(allocation))).toBe(true);
        // A resumed checkout predates this allocation, so it is kept.
        expect(commands).toEqual([
          ["slipjay", "start", "--integration", "--json", "Bounded work"],
          ...(created ? [["slipjay", "remove", "/allocated-jj-workspace"]] : []),
        ]);
      }),
  );
  it.effect("allocates a Build item's workspace through SlipJay's resume-or-create start", () =>
    Effect.gen(function* () {
      const commands: Array<{ readonly args: string[]; readonly cwd: string | undefined }> = [];
      const service = yield* Workspaces.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(Processes.ProcessRunner)({
              run: (input) =>
                Effect.sync(() => {
                  commands.push({ args: [input.command, ...input.args], cwd: input.cwd });
                  return output(JSON.stringify({ workspacePath: "/item-42", created: false }));
                }),
            }),
            Layer.mock(Git.GitVcsDriver)({}),
          ),
        ),
      );
      expect(
        yield* service.allocate({
          projectRoot: "/project",
          task: "work",
          issue: { number: 42, mode: "resume" },
        }),
      ).toEqual({ workspacePath: "/item-42", created: false, issue: 42 });
      expect(commands).toEqual([
        {
          args: ["slipjay", "start", "--integration", "--json", "--issue", "42", "work"],
          cwd: "/project",
        },
      ]);
    }),
  );
  it.effect.each([
    { attachCode: 0, issue: 42, attachFailure: undefined },
    {
      attachCode: 1,
      issue: null,
      attachFailure: "SlipJay could not allocate a workspace for /project (slipjay exited with 1).",
    },
  ])(
    "attaches a Build item to a new checkout only when no other workspace holds it: %o",
    ({ attachCode, issue, attachFailure }) =>
      Effect.gen(function* () {
        const commands: Array<{ readonly args: string[]; readonly cwd: string | undefined }> = [];
        const service = yield* Workspaces.make.pipe(
          Effect.provide(
            Layer.mergeAll(
              Layer.mock(Processes.ProcessRunner)({
                run: (input) =>
                  Effect.sync(() => {
                    commands.push({ args: [input.command, ...input.args], cwd: input.cwd });
                    return input.args[0] === "attach-issue"
                      ? { ...output(""), code: ChildProcessSpawner.ExitCode(attachCode) }
                      : output(JSON.stringify({ workspacePath: "/fresh", created: true }));
                  }),
              }),
              Layer.mock(Git.GitVcsDriver)({}),
            ),
          ),
        );
        expect(
          yield* service.allocate({
            projectRoot: "/project",
            task: "work",
            issue: { number: 42, mode: "attach" },
          }),
        ).toEqual({
          workspacePath: "/fresh",
          created: true,
          issue,
          ...(attachFailure === undefined ? {} : { attachFailure }),
        });
        expect(commands).toEqual([
          { args: ["slipjay", "start", "--integration", "--json", "work"], cwd: "/project" },
          { args: ["slipjay", "attach-issue", "42"], cwd: "/fresh" },
        ]);
      }),
  );

  it.effect.each([
    { name: "stderr", stdout: "progress", stderr: "Issue 42 is held by another workspace\n" },
    { name: "stdout when stderr is empty", stdout: "Issue 42 is held\n", stderr: "" },
  ])("a failed allocation says why SlipJay refused: $name", ({ stdout, stderr }) =>
    Effect.gen(function* () {
      const service = yield* Workspaces.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(Processes.ProcessRunner)({
              run: () =>
                Effect.succeed({
                  ...output(stdout),
                  stderr,
                  code: ChildProcessSpawner.ExitCode(1),
                }),
            }),
            Layer.mock(Git.GitVcsDriver)({}),
          ),
        ),
      );
      const error = yield* Effect.flip(service.allocate({ projectRoot: "/project", task: "work" }));
      expect(error.message).toBe(
        `SlipJay could not allocate a workspace for /project (slipjay exited with 1): ${(stderr || stdout).trim()}`,
      );
    }),
  );

  it.effect("bounds long SlipJay output to its tail and leaves a silent failure unchanged", () =>
    Effect.gen(function* () {
      let stderr = `${"noise ".repeat(1000)}the real cause`;
      const service = yield* Workspaces.make.pipe(
        Effect.provide(
          Layer.mergeAll(
            Layer.mock(Processes.ProcessRunner)({
              run: () =>
                Effect.succeed({ ...output(), stderr, code: ChildProcessSpawner.ExitCode(1) }),
            }),
            Layer.mock(Git.GitVcsDriver)({}),
          ),
        ),
      );
      const long = yield* Effect.flip(service.allocate({ projectRoot: "/project", task: "work" }));
      expect(long.detail?.length).toBeLessThanOrEqual(1000);
      expect(long.detail?.startsWith("…")).toBe(true);
      expect(long.message.endsWith("the real cause")).toBe(true);
      stderr = "  \n";
      const silent = yield* Effect.flip(
        service.allocate({ projectRoot: "/project", task: "work" }),
      );
      expect(silent.message).toBe(
        "SlipJay could not allocate a workspace for /project (slipjay exited with 1).",
      );
    }),
  );
});
