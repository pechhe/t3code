import {
  CommandId,
  type OrchestrationV2ThreadShell,
  type OrchestrationV2WorkspaceAttachment,
  ThreadId,
} from "@t3tools/contracts";
import {
  listedWorkspaceAttachments,
  liveWorkspaceAttachments,
} from "@t3tools/shared/workspaceAttachments";
import * as Context from "effect/Context";
import * as Crypto from "effect/Crypto";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";

import { occupantsEverywhere } from "../agents/workspaceIdentity.ts";
import * as GitWorkflowService from "../git/GitWorkflowService.ts";
import * as ProjectService from "../project/ProjectService.ts";
import * as SlipJayLandings from "../project/SlipJayLandings.ts";
import * as WorkspaceProvider from "../project/WorkspaceProvider.ts";
import * as ThreadManagementService from "./ThreadManagementService.ts";

export class WorkspaceAttachmentError extends Schema.TaggedError<WorkspaceAttachmentError>()(
  "WorkspaceAttachmentError",
  {
    reason: Schema.Literals(["not_found", "busy", "unfinished", "failed"]),
    message: Schema.String,
  },
) {}

/**
 * A thread's hold on workspaces in other projects: who holds a workspace, when SlipJay has
 * released one, and detaching, which releases a workspace the thread allocated.
 */
export class WorkspaceAttachments extends Context.Service<
  WorkspaceAttachments,
  {
    /** Threads other than `threadId` holding `workspacePath` as a live attachment. */
    readonly holders: (input: {
      readonly workspacePath: string;
      readonly threadId: ThreadId;
    }) => Effect.Effect<ReadonlyArray<ThreadId>>;
    /** Records each of the thread's allocated attachments SlipJay has released. */
    readonly markReleased: (threadId: ThreadId) => Effect.Effect<void>;
    /** Records the release of allocated attachments at or holding `cwd`, after a Land there. */
    readonly markReleasedAt: (cwd: string) => Effect.Effect<void>;
    /**
     * Removes the attachment, first releasing a workspace the thread allocated. Refused while
     * a Land or another thread's writer runs there, and when it holds uncommitted edits.
     */
    readonly detach: (input: {
      readonly threadId: ThreadId;
      readonly workspacePath: string;
    }) => Effect.Effect<void, WorkspaceAttachmentError>;
  }
>()("t3/orchestration-v2/WorkspaceAttachments") {}

const make = Effect.gen(function* () {
  const crypto = yield* Crypto.Crypto;
  const sql = yield* SqlClient.SqlClient;
  const threads = yield* ThreadManagementService.ThreadManagementService;
  const projects = yield* ProjectService.ProjectService;
  const workspaces = yield* WorkspaceProvider.WorkspaceProvider;
  const gitWorkflow = yield* GitWorkflowService.GitWorkflowService;
  const landings = yield* SlipJayLandings.SlipJayLandings;

  const commandId = (threadId: ThreadId, action: string) =>
    crypto.randomUUIDv4().pipe(
      Effect.orDie,
      Effect.map((uuid) =>
        CommandId.make(`server:workspace-attachment:${threadId}:${action}:${uuid}`),
      ),
    );

  const record = (
    threadId: ThreadId,
    action: "release" | "detach",
    attachment: OrchestrationV2WorkspaceAttachment,
  ) =>
    Effect.gen(function* () {
      yield* threads.dispatch({
        type: "thread.workspace-attachment.update",
        commandId: yield* commandId(threadId, action),
        threadId,
        change: { action, workspacePath: attachment.workspacePath },
      });
    });

  const projectRoot = (attachment: OrchestrationV2WorkspaceAttachment) =>
    projects.getById(attachment.projectId).pipe(
      Effect.map((project) => Option.getOrUndefined(project)?.workspaceRoot),
      Effect.orElseSucceed(() => undefined),
    );

  // Released means no longer a checkout of the project, as for a primary workspace: SlipJay
  // may have removed or recycled the folder.
  const released = (attachment: OrchestrationV2WorkspaceAttachment) =>
    Effect.gen(function* () {
      const root = yield* projectRoot(attachment);
      return root !== undefined && !(yield* workspaces.contains(root, attachment.workspacePath));
    });

  const releaseGone = (
    threadId: ThreadId,
    attachments: ReadonlyArray<OrchestrationV2WorkspaceAttachment>,
  ) =>
    Effect.forEach(
      attachments.filter((attachment) => attachment.origin === "allocated"),
      (attachment) =>
        Effect.gen(function* () {
          if (yield* released(attachment)) yield* record(threadId, "release", attachment);
        }),
      { discard: true },
    );

  // The threads holding any attachment; few threads hold one, so the payload is filtered here.
  const holdingShells = Effect.gen(function* () {
    const rows = yield* sql<{ thread_id: string }>`
      SELECT thread_id FROM orchestration_v2_projection_threads
      WHERE deleted_at IS NULL
        AND json_extract(payload_json, '$.workspaceAttachments') IS NOT NULL`;
    const shells = yield* Effect.forEach(rows, (row) =>
      threads.getThreadShell(ThreadId.make(row.thread_id)),
    );
    return shells.filter((shell): shell is OrchestrationV2ThreadShell => shell !== null);
  });

  const holders: WorkspaceAttachments["Service"]["holders"] = ({ workspacePath, threadId }) =>
    holdingShells.pipe(
      Effect.map((shells) =>
        shells
          .filter(
            (shell) =>
              shell.id !== threadId &&
              liveWorkspaceAttachments(shell).some(
                (attachment) => attachment.workspacePath === workspacePath,
              ),
          )
          .map((shell) => shell.id),
      ),
      Effect.orDie,
    );

  const markReleased: WorkspaceAttachments["Service"]["markReleased"] = (threadId) =>
    threads.getThreadShell(threadId).pipe(
      Effect.flatMap((shell) =>
        shell === null ? Effect.void : releaseGone(threadId, liveWorkspaceAttachments(shell)),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("workspace attachment release check failed", { threadId, cause }),
      ),
    );

  const markReleasedAt: WorkspaceAttachments["Service"]["markReleasedAt"] = (cwd) =>
    holdingShells.pipe(
      Effect.flatMap((shells) =>
        Effect.forEach(
          shells,
          (shell) =>
            releaseGone(
              shell.id,
              liveWorkspaceAttachments(shell).filter(
                (attachment) =>
                  cwd === attachment.workspacePath ||
                  cwd.startsWith(`${attachment.workspacePath}/`),
              ),
            ),
          { discard: true },
        ),
      ),
      Effect.catchCause((cause) =>
        Effect.logWarning("workspace attachment release check failed", { cwd, cause }),
      ),
    );

  const detach: WorkspaceAttachments["Service"]["detach"] = Effect.fn(
    "WorkspaceAttachments.detach",
  )(function* ({ threadId, workspacePath }) {
    const refuse = (reason: WorkspaceAttachmentError["reason"], message: string) =>
      new WorkspaceAttachmentError({ reason, message });
    const failed = (prefix: string) =>
      Effect.mapError((cause: { readonly message: string }) =>
        refuse("failed", `${prefix}: ${cause.message}`),
      );
    const shell = yield* threads.getThreadShell(threadId).pipe(failed("Unable to read the thread"));
    const attachment = (shell === null ? [] : listedWorkspaceAttachments(shell)).find(
      (candidate) => candidate.workspacePath === workspacePath,
    );
    if (shell === null || attachment === undefined)
      return yield* refuse(
        "not_found",
        `The thread has no workspace attached at ${workspacePath}.`,
      );
    // Detaching drops the thread's hold, so it waits for work running in the workspace,
    // whether the thread allocated it or adopted it.
    if (attachment.releasedAt === null) {
      if (yield* landings.isLanding(workspacePath))
        return yield* refuse("busy", `A Land is running in ${workspacePath}.`);
      const occupants = yield* occupantsEverywhere(projects, threads, threadId).pipe(
        failed("Unable to read the workspace's occupants"),
      );
      if (
        occupants.some(
          (occupant) =>
            occupant.workspacePath === workspacePath && occupant.running && occupant.writes,
        )
      )
        return yield* refuse("busy", `Another agent is writing in ${workspacePath}.`);
    }
    const root = yield* projectRoot(attachment);
    if (
      attachment.origin === "allocated" &&
      attachment.releasedAt === null &&
      root !== undefined &&
      (yield* workspaces.contains(root, workspacePath))
    ) {
      const status = yield* gitWorkflow
        .localStatus({ cwd: workspacePath })
        .pipe(failed("Unable to read the workspace's changes"));
      const files = status.workingTree.files.map((file) => file.path);
      if (files.length > 0)
        return yield* refuse(
          "unfinished",
          `${workspacePath} has uncommitted edits: ${files.slice(0, 10).join(", ")}${
            files.length > 10 ? ` and ${files.length - 10} more` : ""
          }. Commit, land or discard them first; the workspace stays attached.`,
        );
      yield* workspaces
        .remove({ cwd: root, path: workspacePath })
        .pipe(
          failed(
            `Unable to release ${workspacePath}; it may hold unfinished work, and stays attached`,
          ),
        );
    }
    yield* record(threadId, "detach", attachment).pipe(
      failed("The workspace was released, but the thread still lists it"),
    );
  });

  return WorkspaceAttachments.of({ holders, markReleased, markReleasedAt, detach });
});

export const layer = Layer.effect(WorkspaceAttachments, make);
