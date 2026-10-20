import { ThreadId } from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Layer from "effect/Layer";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { parseAttachmentUuid, resolveAttachmentPathById } from "../attachmentStore.ts";
import * as ServerConfig from "../config.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as PreviewManager from "../preview/Manager.ts";
import * as ScheduledTaskService from "../scheduledTasks/ScheduledTaskService.ts";
import * as TerminalManager from "../terminal/Manager.ts";

export class ResourceCleanupError extends Schema.TaggedError<ResourceCleanupError>()(
  "ResourceCleanupError",
  {
    operation: Schema.Literals(["terminal", "preview", "attachment", "scheduled-tasks"]),
    threadId: Schema.optional(Schema.String),
    attachmentId: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {}

export class ResourceCleanupService extends Context.Reference<{
  readonly cleanupScheduledTasks: (threadId: ThreadId) => Effect.Effect<void, ResourceCleanupError>;
  readonly cleanupTerminals: (threadId: string) => Effect.Effect<void, ResourceCleanupError>;
  readonly cleanupPreviews: (threadId: string) => Effect.Effect<void, ResourceCleanupError>;
  /**
   * Closes the browser tabs a thread's MCP sessions opened. A tab handed to a person stays
   * open: Phi refuses to close it.
   */
  readonly releaseBrowserSessions: (threadId: string) => Effect.Effect<void>;
  readonly cleanupAttachments: (
    attachmentIds: ReadonlyArray<string>,
  ) => Effect.Effect<void, ResourceCleanupError>;
}>("t3/orchestration-v2/ResourceCleanupService", {
  defaultValue: () => ({
    cleanupScheduledTasks: () => Effect.void,
    cleanupTerminals: () => Effect.void,
    cleanupPreviews: () => Effect.void,
    releaseBrowserSessions: () => Effect.void,
    cleanupAttachments: () => Effect.void,
  }),
}) {}

export const layer = Layer.effect(
  ResourceCleanupService,
  Effect.gen(function* () {
    const terminals = yield* TerminalManager.TerminalManager;
    const previews = yield* PreviewManager.PreviewManager;
    const mcpSessions = yield* McpSessionRegistry.McpSessionRegistry;
    const fileSystem = yield* FileSystem.FileSystem;
    const config = yield* ServerConfig.ServerConfig;
    const paths = yield* Path.Path;
    const scheduledTasks = yield* ScheduledTaskService.ScheduledTaskService;
    return {
      cleanupScheduledTasks: (threadId: ThreadId) =>
        scheduledTasks
          .deleteForThread(threadId)
          .pipe(
            Effect.mapError(
              (cause) =>
                new ResourceCleanupError({ operation: "scheduled-tasks", threadId, cause }),
            ),
          ),
      cleanupTerminals: (threadId: string) =>
        terminals
          .close({ threadId, deleteHistory: true })
          .pipe(
            Effect.mapError(
              (cause) => new ResourceCleanupError({ operation: "terminal", threadId, cause }),
            ),
          ),
      cleanupPreviews: (threadId: string) =>
        previews
          .close({ threadId: ThreadId.make(threadId) })
          .pipe(
            Effect.mapError(
              (cause) => new ResourceCleanupError({ operation: "preview", threadId, cause }),
            ),
          ),
      releaseBrowserSessions: (threadId: string) =>
        mcpSessions.releaseThreadBrowser(ThreadId.make(threadId)),
      cleanupAttachments: (attachmentIds: ReadonlyArray<string>) =>
        Effect.forEach(
          attachmentIds,
          (attachmentId) => {
            const path = resolveAttachmentPathById({
              attachmentsDir: config.attachmentsDir,
              attachmentId,
            });
            const removeCache = parseAttachmentUuid(attachmentId)
              ? fileSystem.remove(paths.join(config.attachmentsDir, "video-frames", attachmentId), {
                  recursive: true,
                  force: true,
                })
              : Effect.void;
            return (path === null ? Effect.void : fileSystem.remove(path, { force: true }))
              .pipe(Effect.andThen(removeCache))
              .pipe(
                Effect.mapError(
                  (cause) =>
                    new ResourceCleanupError({ operation: "attachment", attachmentId, cause }),
                ),
              );
          },
          { discard: true, concurrency: 4 },
        ),
    };
  }),
);
