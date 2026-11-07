import { OrchestratorMcpFailure } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as HostProcess from "@t3tools/shared/HostProcess";

import { deletePendingAttachment } from "../../assets/AttachmentUpload.ts";
import {
  parseThreadSegmentFromAttachmentId,
  resolveAttachmentPathById,
} from "../../attachmentStore.ts";
import * as ServerConfig from "../../config.ts";
import * as WorkspaceProvider from "../../project/WorkspaceProvider.ts";
import type * as ThreadImportService from "../../orchestration-v2/ThreadImportService.ts";
import * as ServerSettings from "../../serverSettings.ts";
import * as VcsProcess from "../../vcs/VcsProcess.ts";
import { resolveWorktreesDirectory } from "../../worktreesDirectory.ts";
import * as HandoffGit from "./HandoffGit.ts";

/**
 * Applies a handed-off thread's uploaded bundle in a new worktree, or a new
 * SlipJay workspace when the project uses SlipJay, so the thread can land from
 * it. The upload is spent either way; the checkout is undone if the import fails.
 */
export class HandoffImport extends Context.Service<
  HandoffImport,
  {
    readonly applyBundle: (input: {
      readonly repoRoot: string;
      /** The thread the import creates: a retry adopts the workspace its first attempt made. */
      readonly threadId: string;
      readonly handoffId: string;
      readonly bundle: {
        readonly attachmentId: string;
        readonly branch: string | null;
        readonly tip: string;
        readonly snapshot: string;
      };
    }) => Effect.Effect<ThreadImportService.ImportedWorkspace, OrchestratorMcpFailure>;
  }
>()("t3/peer/handoff/HandoffImport") {}

const make = Effect.gen(function* () {
  const config = yield* ServerConfig.ServerConfig;
  const settings = yield* ServerSettings.ServerSettingsService;
  const path = yield* Path.Path;
  const fileSystem = yield* FileSystem.FileSystem;
  const processes = yield* VcsProcess.VcsProcess;
  const git = yield* HandoffGit.HandoffGit;
  const workspaces = yield* WorkspaceProvider.WorkspaceProvider;

  const toFailure = (error: HandoffGit.HandoffGitError) =>
    new OrchestratorMcpFailure({
      code: error._tag === "HandoffGitStepError" ? "orchestration_error" : "invalid_request",
      message: error.message,
    });

  const spendUpload = (attachmentId: string) =>
    deletePendingAttachment(attachmentId).pipe(
      Effect.provideService(ServerConfig.ServerConfig, config),
      Effect.provideService(FileSystem.FileSystem, fileSystem),
      Effect.ignore,
    );

  const applyInSlipJayWorkspace = Effect.fn("HandoffImport.applyInSlipJayWorkspace")(function* (
    input: Parameters<HandoffImport["Service"]["applyBundle"]>[0],
    bundlePath: string,
  ) {
    const allocated = yield* workspaces
      .allocate({
        projectRoot: input.repoRoot,
        task: `Continue a thread moved here (handoff ${input.handoffId})`,
        owner: { kind: "thread-launch", ref: input.threadId },
      })
      .pipe(
        Effect.mapError(
          (error) =>
            new OrchestratorMcpFailure({ code: "orchestration_error", message: error.message }),
        ),
      );
    yield* git
      .applyInWorkspace({
        repoRoot: input.repoRoot,
        workspacePath: allocated.workspacePath,
        handoffId: input.handoffId,
        bundlePath,
        tip: input.bundle.tip,
        snapshot: input.bundle.snapshot,
      })
      .pipe(
        Effect.mapError(toFailure),
        Effect.tapError(() => workspaces.abandon(allocated.attemptId)),
      );
    yield* workspaces.settled(allocated.attemptId);
    return {
      worktreePath: allocated.workspacePath,
      branch: null,
      undo: workspaces.abandon(allocated.attemptId),
    } satisfies ThreadImportService.ImportedWorkspace;
  });

  const applyBundle: HandoffImport["Service"]["applyBundle"] = Effect.fn(
    "HandoffImport.applyBundle",
  )(function* (input) {
    if (parseThreadSegmentFromAttachmentId(input.bundle.attachmentId) !== "pending") {
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message: "The bundle must be a pending upload from t3_attachment_prepare_upload.",
      });
    }
    const bundlePath = resolveAttachmentPathById({
      attachmentsDir: config.attachmentsDir,
      attachmentId: input.bundle.attachmentId,
    });
    if (bundlePath === null) {
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message: "The bundle upload was not found. Upload it again.",
      });
    }
    if ((yield* workspaces.resolve(input.repoRoot)) === "slipjay") {
      return yield* applyInSlipJayWorkspace(input, bundlePath).pipe(
        Effect.ensuring(spendUpload(input.bundle.attachmentId)),
      );
    }
    const worktreesSetting = yield* settings.getSettings.pipe(
      Effect.map((current) => current.worktreesDirectory),
      Effect.orElseSucceed(() => ""),
    );
    const parent = resolveWorktreesDirectory(
      worktreesSetting,
      config.worktreesDir,
      path,
      yield* HostProcess.HomeDirectory,
    );
    if (parent === null) {
      return yield* new OrchestratorMcpFailure({
        code: "invalid_request",
        message:
          "This environment's worktree location is not usable. Fix it in Settings → Storage.",
      });
    }
    const name = (input.bundle.branch ?? `handoff-${input.handoffId}`).replace(/\//g, "-");
    const branchPath = path.join(parent, path.basename(input.repoRoot), name);
    // A branch moved here before keeps its folder; a later move of it gets its own.
    const worktreePath = (yield* fileSystem
      .exists(branchPath)
      .pipe(Effect.orElseSucceed(() => false)))
      ? `${branchPath}-${input.handoffId.slice(0, 8).replace(/[^A-Za-z0-9-]/g, "-")}`
      : branchPath;
    const applied = yield* git
      .apply({
        repoRoot: input.repoRoot,
        worktreePath,
        handoffId: input.handoffId,
        bundlePath,
        branch: input.bundle.branch,
        tip: input.bundle.tip,
        snapshot: input.bundle.snapshot,
      })
      .pipe(Effect.mapError(toFailure), Effect.ensuring(spendUpload(input.bundle.attachmentId)));
    return {
      worktreePath,
      branch: applied.branch,
      undo: processes
        .run({
          operation: "HandoffImport.undo",
          command: "git",
          cwd: input.repoRoot,
          args: ["worktree", "remove", "--force", worktreePath],
        })
        .pipe(Effect.ignore),
    } satisfies ThreadImportService.ImportedWorkspace;
  });

  return HandoffImport.of({ applyBundle });
});

export const layer = Layer.effect(HandoffImport, make);
