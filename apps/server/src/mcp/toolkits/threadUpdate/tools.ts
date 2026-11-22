import {
  IsoDateTime,
  ModelSelection,
  OrchestrationV2ThreadForkSourcePoint,
  OrchestratorMcpEnvironmentTarget,
  OrchestratorMcpFailure,
  ProjectId,
  ThreadId,
  ThreadMetadataMcpUpdateInput,
  TrimmedNonEmptyString,
} from "@t3tools/contracts";
import * as SecureRandom from "effect/crypto/SecureRandom";
import * as Schema from "effect/Schema";
import { Tool, Toolkit } from "effect/ai";

import * as ThreadManagementService from "../../../orchestration-v2/ThreadManagementService.ts";
import * as ThreadProjectMoveService from "../../../orchestration-v2/ThreadProjectMoveService.ts";
import * as ManagedProjectFolders from "../../../project/ManagedProjectFolders.ts";
import * as ProjectService from "../../../project/ProjectService.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as ThreadMetadataMcpService from "../../ThreadMetadataMcpService.ts";
import { OrchestratorToolkit } from "../orchestrator/tools.ts";
import { ThreadToolkit } from "../thread/tools.ts";

/** Each action and the upstream tool whose work it does, with the fields it takes. */
export const THREAD_UPDATE_ROUTES = {
  t3_thread_update: {
    actions: ["rename", "regenerate_title", "link_work_item", "unlink_work_item", "arc_run"],
    fields: ["threadId", "title", "workItem", "arcRun", "clientRequestId"],
  },
  t3_thread_organize: {
    actions: [
      "pin",
      "unpin",
      "snooze",
      "unsnooze",
      "settle",
      "unsettle",
      "archive",
      "unarchive",
      "mark_read",
      "mark_unread",
    ],
    fields: ["threadId", "snoozedUntil"],
  },
  t3_thread_configure: { actions: ["configure"], fields: ["threadId", "modelSelection"] },
  t3_thread_move_to_project: {
    actions: ["move_to_project"],
    fields: ["threadId", "projectId", "continuationPrompt"],
  },
  t3_thread_suggest_project: { actions: ["suggest_project"], fields: ["projectId", "reason"] },
  t3_thread_transfer: {
    actions: ["fork", "merge_back", "transfers"],
    fields: ["threadId", "sourcePoint", "targetThreadId", "title"],
  },
} as const;

export type ThreadUpdateRoute = keyof typeof THREAD_UPDATE_ROUTES;
export type ThreadUpdateAction =
  (typeof THREAD_UPDATE_ROUTES)[ThreadUpdateRoute]["actions"][number];

const ACTIONS = Object.values(THREAD_UPDATE_ROUTES).flatMap(
  (route) => route.actions,
) as ReadonlyArray<ThreadUpdateAction>;

const upstream = OrchestratorToolkit.tools.t3_thread_update;
const thread = ThreadToolkit.tools;
const metadata = ThreadMetadataMcpUpdateInput.fields;

/**
 * Every session's one tool for changing a thread (T3-853): it does the work of upstream's
 * `t3_thread_update` and the thread tools beside it, each with that tool's own checks.
 */
export const ThreadUpdateTool = Tool.make("t3_thread_update", {
  description:
    "Change a thread; omit `threadId` for this one. rename (`title`), regenerate_title, link_work_item (`workItem`, its Forge item) and unlink_work_item, arc_run (`arcRun`: start, checkpoint, log a decision, pause or end this thread's Arc or autonomous run). pin, unpin, snooze (`snoozedUntil`), unsnooze, settle, unsettle, archive, unarchive, mark_read, mark_unread: marking or settling this thread applies when your turn ends, after background work you left has finished. configure: read its provider, model and modes, or set `modelSelection` (values from orchestrator_capabilities). move_to_project: move a No project thread into `projectId` in place; moving this thread ends the turn, and another thread moving it gives `continuationPrompt`, its one-sentence next step. suggest_project: offer this No project chat a move to `projectId` with a one-line `reason`, once, only when the fit is clear. fork: copy it from `sourcePoint` into a new thread (`title`); merge_back: merge it into `targetThreadId`; transfers: list its context transfers. Pull requests: link_pull_requests. Workspace and branch cannot change here.",
  parameters: Schema.Struct({
    environmentId: OrchestratorMcpEnvironmentTarget,
    threadId: Schema.optional(ThreadId),
    action: Schema.Literals(ACTIONS),
    title: metadata.title,
    workItem: metadata.workItem,
    arcRun: metadata.arcRun,
    clientRequestId: metadata.clientRequestId,
    snoozedUntil: Schema.optional(IsoDateTime),
    modelSelection: Schema.optional(ModelSelection),
    projectId: Schema.optional(ProjectId),
    reason: Schema.optional(TrimmedNonEmptyString),
    continuationPrompt: Schema.optional(TrimmedNonEmptyString),
    sourcePoint: Schema.optional(OrchestrationV2ThreadForkSourcePoint),
    targetThreadId: Schema.optional(ThreadId),
  }),
  // A union encodes with its first matching member, so bare command results come last.
  success: Schema.Union([
    upstream.successSchema,
    thread.t3_thread_transfer.successSchema,
    thread.t3_thread_configure.successSchema,
    thread.t3_thread_organize.successSchema,
  ]),
  failure: OrchestratorMcpFailure,
  failureMode: "return",
  dependencies: [
    McpInvocationContext.McpInvocationContext,
    ThreadManagementService.ThreadManagementService,
    ThreadMetadataMcpService.ThreadMetadataMcpService,
    SecureRandom.SecureRandom,
    ProjectService.ProjectService,
    ManagedProjectFolders.ManagedProjectFolders,
    ThreadProjectMoveService.ThreadProjectMoveService,
  ],
})
  .annotate(Tool.Title, "Update a T3 thread")
  .annotate(Tool.Destructive, true)
  .annotate(Tool.Idempotent, false);

export const ThreadUpdateToolkit = Toolkit.make(ThreadUpdateTool);
