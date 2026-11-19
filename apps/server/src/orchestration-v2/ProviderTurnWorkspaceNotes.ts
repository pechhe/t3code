/**
 * The fork's workspace facts for a provider turn, kept out of `ProviderTurnStartService`: the
 * managed checkout identity check and the notes that list a thread's workspaces.
 */
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";

import type { OrchestrationV2AppThread, ProjectId } from "@t3tools/contracts";

import { checkoutOffset, checkoutRoot, repositoryWriteRoots } from "../agents/workspaceIdentity.ts";
import * as ProcessRunner from "../processRunner.ts";

const INSTRUCTION_FILES = ["AGENTS.md", "CLAUDE.md"];

type WorkspaceProject = { readonly workspaceRoot: string; readonly title: string };
type GetProject<E> = (projectId: ProjectId) => Effect.Effect<Option.Option<WorkspaceProject>, E>;
type WorkspaceServices = {
  readonly fileSystem: FileSystem.FileSystem;
  readonly path: Path.Path;
  readonly processes: ProcessRunner.ProcessRunner["Service"];
};

/** One of a thread's workspaces, as the workspaces note lists it. */
export interface TurnWorkspace {
  readonly project: string;
  readonly path: string;
  readonly branch: string | null;
  readonly role: "primary" | "attached" | "released";
  readonly instructionFiles: ReadonlyArray<string>;
}

/**
 * Managed agents cannot rely on inherited configuration to load workspace instructions.
 */
const workspacesNote = (workspaces: ReadonlyArray<TurnWorkspace>, managed = false): string =>
  [
    managed
      ? "This thread works in these workspaces. Read a workspace's instruction files before working there."
      : "This thread works in these workspaces. Read a workspace's instruction files before working there, and land each repository from its own workspace.",
    ...workspaces.map((workspace) => {
      const role =
        workspace.role === "primary"
          ? "primary, where this session runs"
          : workspace.role === "attached"
            ? "attached"
            : "released by SlipJay; attach a fresh workspace to work in this project again";
      const branch = workspace.branch === null ? "" : ` on ${workspace.branch}`;
      const instructions =
        workspace.instructionFiles.length === 0
          ? ""
          : `; instructions: ${workspace.instructionFiles.join(", ")}`;
      return `- ${workspace.project} (${role}): ${workspace.path}${branch}${instructions}`;
    }),
  ].join("\n");

/**
 * A project registered in a repository subdirectory still binds whole checkouts, and turns start
 * at their root: provider sandboxes grant writes under the working directory, and the project's
 * work may need to change shared code outside its folder.
 */
const projectFolderNote = (folder: string): string =>
  `This project is the \`${folder}\` folder of its repository. This turn starts at the repository root so it can also change shared code. Work on that folder's product and read the instruction files in \`${folder}\` before changing it.`;

/**
 * A managed task's workspace must be a checkout of its project's repository, at the same place in
 * it. Scratch and non-repository projects have no repository identity to preserve.
 */
export const managedWorkspaceInvalid = Effect.fnUntraced(function* <E>(input: {
  readonly thread: Pick<OrchestrationV2AppThread, "agentTask" | "projectId">;
  readonly worktreePath: string | null;
  readonly workspaceMissing: boolean;
  readonly getProject: GetProject<E>;
  readonly services: WorkspaceServices;
}) {
  const { worktreePath, services } = input;
  if (input.thread.agentTask === undefined || worktreePath === null || input.workspaceMissing) {
    return false;
  }
  const project = yield* input.getProject(input.thread.projectId);
  if (Option.isNone(project)) return false;
  // The repository a directory belongs to, and where it sits in that checkout.
  const locate = Effect.fn("ProviderTurnStartService.workspaceIdentity")(function* (
    directory: string,
  ) {
    const checkout = yield* checkoutRoot(directory);
    return {
      offset: services.path.relative(checkout, yield* services.fileSystem.realPath(directory)),
      stores: yield* repositoryWriteRoots(checkout),
    };
  });
  const identity = (directory: string) =>
    locate(directory).pipe(
      Effect.provideService(FileSystem.FileSystem, services.fileSystem),
      Effect.provideService(Path.Path, services.path),
      Effect.provideService(ProcessRunner.ProcessRunner, services.processes),
      Effect.orElseSucceed(() => null),
    );
  const expected = yield* identity(project.value.workspaceRoot);
  if (expected === null) return false;
  const actual = yield* identity(worktreePath);
  // A workspace is allocated whole, so a subdirectory project's is bound at its root.
  return (
    actual === null ||
    (actual.offset !== expected.offset && actual.offset !== "") ||
    !actual.stores.some((store) => expected.stores.includes(store))
  );
});

/** The two notes a turn adds about where it works; each is empty when it has nothing to say. */
export const turnWorkspaceNotes = Effect.fnUntraced(function* <E>(input: {
  readonly thread: Pick<
    OrchestrationV2AppThread,
    "projectId" | "worktreePath" | "branch" | "workspaceAttachments"
  >;
  readonly managedAgent: boolean;
  readonly getProject: GetProject<E>;
  readonly services: WorkspaceServices;
}) {
  const { thread, services } = input;
  const { fileSystem, path, processes } = services;
  const projectFolder =
    thread.worktreePath === null
      ? ""
      : yield* Effect.gen(function* () {
          const project = yield* input.getProject(thread.projectId);
          if (Option.isNone(project)) return "";
          return (yield* checkoutOffset(thread.worktreePath!)) === ""
            ? yield* checkoutOffset(project.value.workspaceRoot)
            : "";
        }).pipe(
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
          Effect.provideService(ProcessRunner.ProcessRunner, processes),
          Effect.orElseSucceed(() => ""),
        );
  const attachments = thread.workspaceAttachments ?? [];
  const turnWorkspaces =
    attachments.length === 0 && !input.managedAgent
      ? []
      : yield* Effect.forEach(
          [
            {
              projectId: thread.projectId,
              path: thread.worktreePath,
              branch: thread.branch,
              role: "primary" as const,
            },
            ...attachments.map((attachment) => ({
              projectId: attachment.projectId,
              path: attachment.workspacePath,
              branch: attachment.branch,
              role: attachment.releasedAt === null ? ("attached" as const) : ("released" as const),
            })),
          ],
          (workspace) =>
            Effect.gen(function* () {
              const project = Option.getOrUndefined(
                yield* input
                  .getProject(workspace.projectId)
                  .pipe(Effect.orElseSucceed(() => Option.none())),
              );
              const root = workspace.path ?? project?.workspaceRoot ?? "";
              const instructionFiles =
                workspace.role === "released"
                  ? []
                  : yield* Effect.filter(INSTRUCTION_FILES, (file) =>
                      fileSystem
                        .exists(path.join(root, file))
                        .pipe(Effect.orElseSucceed(() => false)),
                    );
              return {
                project: project?.title ?? workspace.projectId,
                path: root,
                branch: workspace.branch,
                role: workspace.role,
                instructionFiles,
              } satisfies TurnWorkspace;
            }),
        );
  return {
    projectFolder: projectFolder === "" ? "" : projectFolderNote(projectFolder),
    workspaces:
      turnWorkspaces.length === 0
        ? ""
        : workspacesNote(turnWorkspaces, input.managedAgent && attachments.length === 0),
  };
});
