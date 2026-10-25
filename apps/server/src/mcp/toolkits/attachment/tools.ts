import { McpAttachmentInput } from "./input.ts";
import {
  AttachmentCreateUploadUrlInput,
  ChatAttachmentId,
  AttachmentCreateUploadUrlResult,
  AttachmentDeleteInput,
  MessageId,
  RunId,
  ThreadId,
  OrchestrationV2RunStatus,
  OrchestratorMcpFailure,
} from "@t3tools/contracts";
import * as Crypto from "effect/Crypto";
import * as FileSystem from "effect/FileSystem";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";
import * as ServerSecretStore from "../../../auth/ServerSecretStore.ts";
import * as ServerConfig from "../../../config.ts";
import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as VideoFrames from "../../../videoFrames/VideoFrames.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";

const shared = {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ServerConfig.ServerConfig,
    ServerSecretStore.ServerSecretStore,
    FileSystem.FileSystem,
    Crypto.Crypto,
  ],
};
const AttachmentUploadTool = Tool.make("t3_attachment_prepare_upload", {
  ...shared,
  description:
    "Get an upload URL. POST the file's exact bytes to `relativeUrl` on this MCP server's HTTP origin, then send via `t3_thread_send_attachments` with the returned `attachmentId`.",
  parameters: Schema.Struct({ upload: AttachmentCreateUploadUrlInput }),
  success: AttachmentCreateUploadUrlResult,
}).annotate(Tool.Destructive, false);
const AttachmentDiscardTool = Tool.make("t3_attachment_discard", {
  ...shared,
  description: "Discard a pending upload (not a sent attachment).",
  parameters: AttachmentDeleteInput,
  success: Schema.Struct({}),
}).annotate(Tool.Destructive, true);
const AttachmentSendTool = Tool.make("t3_thread_send_attachments", {
  ...shared,
  description:
    "Send uploaded attachments as a new message to a thread. No retry key. Target modes cannot exceed yours. Success does not mean the provider read them or finished.",
  parameters: Schema.Struct({
    threadId: Schema.optional(ThreadId),
    message: Schema.optional(Schema.String.check(Schema.isMaxLength(120000))),
    attachments: Schema.Array(McpAttachmentInput).check(
      Schema.isMinLength(1),
      Schema.isMaxLength(8),
    ),
  }),
  success: Schema.Struct({
    threadId: ThreadId,
    messageId: MessageId,
    runId: RunId,
    status: OrchestrationV2RunStatus,
  }),
})
  .annotate(Tool.Destructive, false)
  .annotate(Tool.OpenWorld, false);
const VideoFramesTool = Tool.make("t3_video_frames", {
  failure: OrchestratorMcpFailure,
  failureMode: "return" as const,
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    VideoFrames.VideoFrames,
  ],
  description:
    "Sample more frames from a video attached in your own thread, between startMs and endMs. Returns JPEG paths on this server with their timestamps; view them with your image or file reading tool. Use it when the frames sent with the message miss the moment you need: frames marked changed show where the screen changed, so ask for a narrow range around one to see it frame by frame.",
  parameters: Schema.Struct({
    attachmentId: ChatAttachmentId,
    startMs: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
    endMs: Schema.Number.check(Schema.isGreaterThanOrEqualTo(0)),
    maxFrames: Schema.optional(
      Schema.Int.check(Schema.isGreaterThanOrEqualTo(1), Schema.isLessThanOrEqualTo(12)),
    ),
  }),
  success: Schema.Struct({
    videoName: Schema.String,
    frames: Schema.Array(
      Schema.Struct({
        timestampMs: Schema.Number,
        changed: Schema.optional(Schema.Boolean),
        path: Schema.String,
      }),
    ),
  }),
}).annotate(Tool.Readonly, true);
export const AttachmentToolkit = Toolkit.make(
  AttachmentUploadTool,
  AttachmentDiscardTool,
  AttachmentSendTool,
  VideoFramesTool,
);
