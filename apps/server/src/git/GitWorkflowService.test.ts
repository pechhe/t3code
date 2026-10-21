import * as WorkspaceProvider from "../project/WorkspaceProvider.ts";
import * as SlipJayLandings from "../project/SlipJayLandings.ts";
import { assert, expect, it } from "@effect/vitest";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Ref from "effect/Ref";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import * as NodeServices from "@effect/platform-node/NodeServices";
import * as FileSystem from "effect/FileSystem";

import * as ServerConfig from "../config.ts";
import * as ProcessRunner from "../processRunner.ts";
import * as VcsProcess from "../vcs/VcsProcess.ts";
import * as GitManager from "./GitManager.ts";
import * as GitWorkflowService from "./GitWorkflowService.ts";
import * as GitVcsDriver from "../vcs/GitVcsDriver.ts";
import * as VcsDriverRegistry from "../vcs/VcsDriverRegistry.ts";

function layer(input: {
  readonly detect: VcsDriverRegistry.VcsDriverRegistry["Service"]["detect"];
}) {
  return GitWorkflowService.layer.pipe(
    Layer.provide(SlipJayLandings.layerNone),
    Layer.provide(WorkspaceProvider.layerGitWorktree),
    Layer.provide(
      Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
        detect: input.detect,
      }),
    ),
    Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
    Layer.provide(Layer.mock(GitManager.GitManager)({})),
  );
}

it.layer(NodeServices.layer)("GitWorkflowService", (it) => {
  it.effect(
    "serves live JJ workspace changes through the shared status path without enabling Git actions",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "t3-jj-workflow-status-" });
        const processes = yield* VcsProcess.VcsProcess;
        const jj = (args: ReadonlyArray<string>) =>
          processes.run({
            operation: "test.jjStatus",
            command: "jj",
            cwd,
            args,
          });
        yield* jj(["git", "init", "--no-colocate", "."]);
        yield* fs.writeFileString(`${cwd}/slipjay.json`, '{"integrationBranch":"develop"}');
        yield* jj(["bookmark", "set", "develop", "-r", "@"]);
        yield* jj(["new"]);
        yield* fs.writeFileString(`${cwd}/changed.txt`, "changed\n");
        const workflow = yield* GitWorkflowService.GitWorkflowService;
        const status = yield* workflow.status({ cwd });
        const local = yield* workflow.localStatus({ cwd });
        const remote = yield* workflow.remoteStatus({ cwd });
        assert.equal(status.isRepo, false);
        assert.equal(status.otherVcsKind, "jj");
        assert.equal(local.refName, "develop");
        assert.equal(local.hasWorkingTreeChanges, true);
        assert.deepEqual(
          local.workingTree.files.map((file) => file.path),
          ["changed.txt"],
        );
        assert.equal(remote?.behindCount, 0);
        const refused = yield* workflow.switchRef({ cwd, refName: "develop" }).pipe(Effect.flip);
        assert.equal(refused._tag, "GitCommandError");
      }).pipe(
        Effect.scoped,
        Effect.provide(
          GitWorkflowService.layer.pipe(
            Layer.provide(SlipJayLandings.layerNone),
            Layer.provide(WorkspaceProvider.layerGitWorktree),
            Layer.provide(Layer.mock(GitManager.GitManager)({})),
            Layer.provideMerge(GitVcsDriver.layer),
            Layer.provideMerge(VcsDriverRegistry.layer),
            Layer.provideMerge(VcsProcess.layer),
            Layer.provideMerge(
              ServerConfig.layerTest(process.cwd(), { prefix: "t3-jj-workflow-status-" }),
            ),
            Layer.provideMerge(NodeServices.layer),
          ),
        ),
      ),
  );

  it.effect(
    "routes normal workspace removal through the workspace provider before Git-only checks",
    () => {
      const removed: string[] = [];
      return Effect.gen(function* () {
        const workflow = yield* GitWorkflowService.GitWorkflowService;
        yield* workflow.removeWorktree({ cwd: "/jj-project", path: "/jj-child", force: true });
        expect(removed).toEqual(["/jj-child"]);
      }).pipe(
        Effect.provide(
          GitWorkflowService.layer.pipe(
            Layer.provide(SlipJayLandings.layerNone),
            Layer.provide(
              Layer.mergeAll(
                Layer.mock(WorkspaceProvider.WorkspaceProvider)({
                  remove: (input) =>
                    Effect.sync(() => {
                      removed.push(input.path);
                    }),
                }),
                Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({}),
                Layer.mock(GitVcsDriver.GitVcsDriver)({}),
                Layer.mock(GitManager.GitManager)({}),
              ),
            ),
          ),
        ),
      );
    },
  );

  it.effect("tells the Git status of a Jujutsu repository which kind it is", () =>
    Effect.gen(function* () {
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const local = yield* workflow.localStatus({ cwd: "/jj-repo" });
      const full = yield* workflow.status({ cwd: "/jj-repo" });

      assert.equal(local.isRepo, false);
      assert.equal(local.otherVcsKind, "jj");
      assert.equal(full.otherVcsKind, "jj");
      assert.equal(yield* workflow.remoteStatus({ cwd: "/jj-repo" }), null);
    }).pipe(
      Effect.provide(
        layer({
          detect: () =>
            Effect.succeed({
              kind: "jj",
              repository: {
                kind: "jj",
                rootPath: "/jj-repo",
                metadataPath: "/jj-repo/.jj",
                freshness: {
                  source: "live-local",
                  observedAt: DateTime.makeUnsafe("2026-01-01T00:00:00.000Z"),
                  expiresAt: Option.none(),
                },
              },
              driver: {} as VcsDriverRegistry.VcsDriverHandle["driver"],
            }),
        }),
      ),
    ),
  );

  it.effect("still reports what landed from a SlipJay workspace after SlipJay removes it", () => {
    const removed = "/nonexistent/.slipjay/workspaces/sl-spare-152cb3";
    return Effect.gen(function* () {
      const asked = yield* Ref.make<ReadonlyArray<string>>([]);
      // SlipJay's record of each landing by its workspace's exact path.
      const runner = Layer.mock(ProcessRunner.ProcessRunner)({
        run: (input) =>
          Ref.update(asked, (paths) => [...paths, input.args[1] ?? ""]).pipe(
            Effect.as({
              stdout:
                input.command === "slipjay" &&
                input.args[0] === "landed" &&
                input.args[1] === removed
                  ? JSON.stringify({
                      workspaceName: "sl-50",
                      workspacePath: removed,
                      artifactCommitId: "abc1234def",
                      operationId: "op_landed",
                    })
                  : "null",
              stderr: "",
              code: ChildProcessSpawner.ExitCode(0),
              timedOut: false,
              stdoutTruncated: false,
              stderrTruncated: false,
              stdoutInvalidUtf8: false,
              stderrInvalidUtf8: false,
            }),
          ),
      });
      const registry = Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
        detect: () => Effect.succeed(null),
      });
      const services = GitWorkflowService.layer.pipe(
        Layer.provide(
          Layer.effect(SlipJayLandings.SlipJayLandings, SlipJayLandings.make).pipe(
            Layer.provide(runner),
            Layer.provide(registry),
            Layer.provide(NodeServices.layer),
          ),
        ),
        Layer.provide(WorkspaceProvider.layerGitWorktree),
        Layer.provide(registry),
        Layer.provide(Layer.mock(GitVcsDriver.GitVcsDriver)({})),
        Layer.provide(Layer.mock(GitManager.GitManager)({})),
      );

      yield* Effect.gen(function* () {
        // A fresh server, so nothing was watched: the landing comes from SlipJay's record.
        const workflow = yield* GitWorkflowService.GitWorkflowService;
        const status = yield* workflow.localStatus({ cwd: removed });
        expect(status).toMatchObject({ isRepo: false, otherVcsKind: "jj" });
        // No workspace, so nothing offers to land it again.
        expect(status.slipJay).toEqual({
          integration: null,
          landing: {
            operationId: "op_landed",
            status: "landed",
            stage: "landed",
            commitId: "abc1234def",
            live: true,
          },
        });
        expect((yield* workflow.status({ cwd: removed })).slipJay?.landing?.commitId).toBe(
          "abc1234def",
        );

        // Another missing folder is a plain missing folder, whatever its name.
        const elsewhere = yield* workflow.status({ cwd: "/nonexistent/other/sl-spare-152cb3" });
        expect(elsewhere.slipJay).toBeUndefined();
        expect(elsewhere.otherVcsKind).toBeUndefined();

        // A landing does not change, so SlipJay is asked once per path.
        expect(yield* Ref.get(asked)).toEqual([removed, "/nonexistent/other/sl-spare-152cb3"]);
      }).pipe(Effect.provide(services));
    });
  });

  it.effect("finds a name among the refs of every namespace", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const cwd = yield* fileSystem.makeTempDirectoryScoped({ prefix: "t3-ref-named-" });
      const workflow = yield* GitWorkflowService.GitWorkflowService;
      const driver = yield* GitVcsDriver.GitVcsDriver;
      for (const args of [
        ["init", "-b", "main"],
        ["-c", "user.email=t@t", "-c", "user.name=t", "commit", "--allow-empty", "-m", "init"],
        ["update-ref", "refs/remotes/upstream/feature/topic", "HEAD"],
        ["symbolic-ref", "refs/remotes/origin/alias", "refs/heads/main"],
        ["update-ref", "refs/mirror/origin/mirrored", "HEAD"],
      ]) {
        yield* driver.execute({ operation: "test.setupRepo", cwd, args });
      }
      const found = yield* Effect.forEach(
        ["main", "feature/topic", "alias", "mirrored", "t3/renamed", "feature/*"],
        (refName) => workflow.hasRefNamed({ cwd, refName }),
      );
      assert.deepEqual(found, [true, true, true, true, false, false]);
    }).pipe(
      Effect.scoped,
      Effect.provide(
        GitWorkflowService.layer.pipe(
          Layer.provide(SlipJayLandings.layerNone),
          Layer.provide(WorkspaceProvider.layerGitWorktree),
          Layer.provide(
            Layer.mock(VcsDriverRegistry.VcsDriverRegistry)({
              resolve: () => Effect.succeed({ kind: "git" } as VcsDriverRegistry.VcsDriverHandle),
            }),
          ),
          Layer.provide(Layer.mock(GitManager.GitManager)({})),
          Layer.provideMerge(GitVcsDriver.layer),
          Layer.provideMerge(VcsProcess.layer),
          Layer.provideMerge(
            ServerConfig.layerTest(process.cwd(), { prefix: "t3-ref-named-" }).pipe(
              Layer.provide(NodeServices.layer),
            ),
          ),
          Layer.provideMerge(NodeServices.layer),
        ),
      ),
    ),
  );
});
