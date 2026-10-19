import type { OrchestrationV2ThreadShell, ThreadId } from "@t3tools/contracts";
import { liveWorkspaceAttachments } from "@t3tools/shared/workspaceAttachments";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as ProcessRunner from "../processRunner.ts";
import type { ThreadManagementServiceShape } from "../orchestration-v2/ThreadManagementService.ts";
import type { ProjectService } from "../project/ProjectService.ts";
import type { WorkspaceOccupant } from "./ManagedAgentService.ts";

export class WorkspaceIdentityError extends Schema.TaggedError<WorkspaceIdentityError>()(
  "WorkspaceIdentityError",
  {},
) {}

/**
 * The shared repository store behind a workspace root: jj's `.jj/repo` or git's common
 * directory. Fails unless `root` is itself a workspace root, so a subdirectory of a
 * checkout is not mistaken for a separately allocated workspace.
 */
export const repositoryStore = Effect.fn("workspaceIdentity.repositoryStore")(function* (
  root: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const processes = yield* ProcessRunner.ProcessRunner;
  const entry = path.join(root, ".jj", "repo");
  if (yield* fs.exists(entry)) {
    const stat = yield* fs.stat(entry);
    return yield* fs.realPath(
      stat.type === "Directory"
        ? entry
        : path.resolve(root, ".jj", (yield* fs.readFileString(entry)).trim()),
    );
  }
  const git = (args: ReadonlyArray<string>) =>
    processes.run({ command: "git", args, cwd: root, timeout: "10 seconds", maxOutputBytes: 4096 });
  const top = yield* git(["rev-parse", "--show-toplevel"]);
  if (top.code !== 0 || (yield* fs.realPath(top.stdout.trim())) !== (yield* fs.realPath(root)))
    return yield* new WorkspaceIdentityError();
  const common = yield* git(["rev-parse", "--path-format=absolute", "--git-common-dir"]);
  if (common.code !== 0) return yield* new WorkspaceIdentityError();
  return yield* fs.realPath(common.stdout.trim());
});

/**
 * The directories a version-control client needs to write to commit from the workspace at
 * `root`: its shared repository store, and for jj the git directory behind that store.
 * Both are shared by every workspace of the repository.
 */
export const repositoryWriteRoots = Effect.fn("workspaceIdentity.repositoryWriteRoots")(function* (
  root: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const store = yield* repositoryStore(root);
  const target = path.join(store, "store", "git_target");
  if (!(yield* fs.exists(target))) return [store];
  const git = yield* fs.realPath(
    path.resolve(store, "store", (yield* fs.readFileString(target)).trim()),
  );
  return git === store ? [store] : [store, git];
});

/**
 * The workspace root of the checkout containing `directory`, which may be a subdirectory
 * of it, as a project's registered root can be. The nearest `.jj` or `.git` decides, so a
 * Git-only repository nested in a jj checkout is not taken for the outer one.
 */
export const checkoutRoot = Effect.fn("workspaceIdentity.checkoutRoot")(function* (
  directory: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const processes = yield* ProcessRunner.ProcessRunner;
  const real = yield* fs.realPath(directory);
  for (let root = real; ; root = path.dirname(root)) {
    if (yield* fs.exists(path.join(root, ".jj"))) return root;
    if (yield* fs.exists(path.join(root, ".git"))) break;
    if (path.dirname(root) === root) break;
  }
  const top = yield* processes.run({
    command: "git",
    args: ["rev-parse", "--show-toplevel"],
    cwd: real,
    timeout: "10 seconds",
    maxOutputBytes: 4096,
  });
  if (top.code !== 0) return yield* new WorkspaceIdentityError();
  return yield* fs.realPath(top.stdout.trim());
});

/** The repository store of the checkout containing `directory`. */
export const containingRepositoryStore = Effect.fn("workspaceIdentity.containingRepositoryStore")(
  function* (directory: string) {
    return yield* repositoryStore(yield* checkoutRoot(directory));
  },
);

/**
 * The finished revision a writer hands back. jj reports the working-copy commit, or its
 * parent when the working copy is empty; git reports HEAD and whether the tree is clean.
 */
export const handoffRevision = Effect.fn("workspaceIdentity.handoffRevision")(function* (
  root: string,
) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const processes = yield* ProcessRunner.ProcessRunner;
  const run = (command: string, args: ReadonlyArray<string>) =>
    processes.run({ command, args, cwd: root, timeout: "10 seconds", maxOutputBytes: 4096 });
  if (yield* fs.exists(path.join(root, ".jj"))) {
    const output = yield* run("jj", [
      "log",
      "-r",
      "@",
      "--no-graph",
      "-T",
      'if(empty, parents.map(|c| c.commit_id()).join(","), commit_id) ++ "\\n"',
    ]);
    const revision = output.stdout.trim();
    // A merge working copy has several parents; there is no single revision to adopt.
    if (output.code !== 0 || revision === "" || revision.includes(","))
      return { revision: null, quiescent: false };
    return { revision, quiescent: true };
  }
  const head = yield* run("git", ["rev-parse", "HEAD"]);
  const dirty = yield* run("git", ["status", "--porcelain", "--untracked-files=normal"]);
  return {
    revision: head.code === 0 ? head.stdout.trim() : null,
    quiescent: head.code === 0 && dirty.code === 0 && dirty.stdout.trim() === "",
  };
});

const SETTLED = new Set(["idle", "completed", "interrupted", "failed", "cancelled", "rolled_back"]);

/** The accountable lead of a thread: an external session, else its root thread. */
export const threadOwner = (
  thread: Pick<OrchestrationV2ThreadShell, "id" | "lineage" | "agentTask">,
): string =>
  thread.agentTask?.externalOwner?.externalSessionKey ?? thread.lineage?.rootThreadId ?? thread.id;

/**
 * Threads bound to a workspace, or holding one in another project as a live attachment; one
 * without a managed read-only binding writes. Given its project's main checkout, an unbound
 * thread occupies that checkout, where it runs.
 */
export const workspaceOccupants = (
  shells: ReadonlyArray<OrchestrationV2ThreadShell>,
  projectRoot?: string,
): ReadonlyArray<WorkspaceOccupant> =>
  shells.flatMap((shell) => {
    const primary = shell.worktreePath ?? projectRoot;
    return [
      ...(primary === undefined ? [] : [primary]),
      ...liveWorkspaceAttachments(shell).map((attachment) => attachment.workspacePath),
    ].map((workspacePath) => ({
      workspacePath,
      owner: threadOwner(shell),
      workId: shell.agentTask?.workId ?? null,
      attemptId: shell.agentTask?.attemptId ?? null,
      writes: shell.agentTask?.sourceAccess !== "read-only",
      running: !SETTLED.has(shell.status),
    }));
  });

/**
 * Occupants of every registered project. A workspace may be held by a thread of any project:
 * one registered in the same repository and working unbound in its main checkout, or one
 * holding it as an attachment, so a placement or release there is checked against all of them.
 * `except` leaves out the asking thread itself.
 */
export const occupantsEverywhere = (
  projects: ProjectService["Service"],
  threads: Pick<ThreadManagementServiceShape, "listProjectThreads">,
  except?: ThreadId,
) =>
  projects.listShells().pipe(
    Effect.flatMap((all) =>
      Effect.forEach(all, (project) =>
        threads
          .listProjectThreads({ projectId: project.id, includeSubagents: true })
          .pipe(
            Effect.map((shells) =>
              workspaceOccupants(
                except === undefined ? shells : shells.filter((shell) => shell.id !== except),
                project.workspaceRoot,
              ),
            ),
          ),
      ),
    ),
    Effect.map((occupants) => occupants.flat()),
  );
