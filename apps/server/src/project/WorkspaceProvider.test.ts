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

  it.effect(
    "releases a workspace when cancellation arrives before SlipJay emits the allocation receipt",
    () =>
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
                      return output(JSON.stringify({ workspacePath: "/allocated-jj-workspace" }));
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
        expect(commands).toEqual([
          ["slipjay", "start", "--integration", "--json", "Bounded work"],
          ["slipjay", "remove", "/allocated-jj-workspace"],
        ]);
      }),
  );
});
