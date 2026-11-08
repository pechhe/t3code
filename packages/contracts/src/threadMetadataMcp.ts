import * as Schema from "effect/Schema";

import {
  CommandId,
  IsoDateTime,
  NonNegativeInt,
  PositiveInt,
  ThreadId,
  TrimmedNonEmptyString,
} from "./baseSchemas.ts";
import {
  OrchestrationV2ThreadArcRun,
  OrchestrationV2ThreadWorkflow,
  OrchestrationV2ThreadWorkItem,
} from "./orchestrationV2.ts";
import { ThreadLinkedPullRequest } from "./threadPullRequest.ts";
import { ThreadTitleRegeneration } from "./threadTitle.ts";

export function hasOnlyPairedSurrogates(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const codeUnit = value.charCodeAt(index);
    if (codeUnit >= 0xd800 && codeUnit <= 0xdbff) {
      const nextCodeUnit = value.charCodeAt(index + 1);
      if (index + 1 >= value.length || nextCodeUnit < 0xdc00 || nextCodeUnit > 0xdfff) {
        return false;
      }
      index += 1;
    } else if (codeUnit >= 0xdc00 && codeUnit <= 0xdfff) {
      return false;
    }
  }
  return true;
}

function isHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

const ThreadMetadataTitle = TrimmedNonEmptyString.check(Schema.isMaxLength(512)).annotate({
  description: "New concise display title. Required only when action is rename.",
});

const ThreadMetadataClientRequestId = TrimmedNonEmptyString.check(Schema.isMaxLength(256))
  .check(
    Schema.makeFilter((value) =>
      hasOnlyPairedSurrogates(value)
        ? true
        : "clientRequestId must contain valid paired Unicode surrogates.",
    ),
  )
  .annotate({ description: "Stable idempotency key to reuse when retrying this mutation." });

const ThreadMetadataMcpPullRequestUrl = TrimmedNonEmptyString.check(
  Schema.makeFilter((value) =>
    isHttpUrl(value) ? true : "Pull request URL must be a well-formed HTTP(S) URL.",
  ),
).annotate({
  description: "Canonical HTTP(S) pull request URL, including self-hosted repository URLs.",
});

export const ThreadMetadataMcpAction = Schema.Literals([
  "rename",
  "regenerate_title",
  "link_pull_request",
  "unlink_pull_request",
  "set_workflow",
  "link_work_item",
  "unlink_work_item",
  "arc_run",
]).annotate({
  description: "Metadata mutation. Each action takes only its own fields.",
});
export type ThreadMetadataMcpAction = typeof ThreadMetadataMcpAction.Type;

export const ThreadMetadataMcpPullRequest = Schema.Struct({
  repository: TrimmedNonEmptyString.annotate({
    description: "Repository name as owner/name.",
  }),
  number: PositiveInt.annotate({ description: "Pull request number." }),
  url: ThreadMetadataMcpPullRequestUrl,
});
export type ThreadMetadataMcpPullRequest = typeof ThreadMetadataMcpPullRequest.Type;

export const ThreadMetadataMcpWorkflow = Schema.Struct({
  kind: OrchestrationV2ThreadWorkflow.fields.kind,
});

export const ThreadMetadataMcpUpdateInput = Schema.Struct({
  threadId: Schema.optional(ThreadId),
  action: ThreadMetadataMcpAction,
  title: Schema.optional(ThreadMetadataTitle),
  pullRequest: Schema.optional(ThreadMetadataMcpPullRequest).annotate({
    description: "Pull request to link. Required only when action is link_pull_request.",
  }),
  workflow: Schema.optional(Schema.NullOr(ThreadMetadataMcpWorkflow)).annotate({
    description: "Governing workflow. Required only for set_workflow; null clears it.",
  }),
  workItem: Schema.optional(TrimmedNonEmptyString).annotate({
    description:
      "The Weave Build Spec or Ticket to link: Build URL, #<number> or number. Required only for link_work_item, which replaces any earlier item.",
  }),
  arcRun: Schema.optional(
    Schema.Struct({
      op: Schema.Literals(["start", "checkpoint", "pause", "end"]),
      arc: Schema.optional(PositiveInt),
      ref: Schema.optional(TrimmedNonEmptyString),
      specs: Schema.optional(Schema.NonEmptyArray(PositiveInt)),
      phase: Schema.optional(TrimmedNonEmptyString),
      note: Schema.optional(TrimmedNonEmptyString),
    }),
  ).annotate({
    description:
      "Required only for arc_run, on your own thread. start names arc (its Forge number) and ref, plus specs (Forge numbers) to answer for only those Specs in that Arc; checkpoint names phase (a new phase counts as progress) and note; only end finishes the run.",
  }),
  clientRequestId: Schema.optional(ThreadMetadataClientRequestId),
}).check(
  Schema.makeFilter((input) => {
    if (input.action === "arc_run") {
      if (
        input.arcRun === undefined ||
        input.title !== undefined ||
        input.pullRequest !== undefined ||
        input.workflow !== undefined ||
        input.workItem !== undefined
      ) {
        return "arc_run requires arcRun and accepts no title, pullRequest, workflow or workItem.";
      }
      if (input.arcRun.op === "start" && input.arcRun.arc === undefined) {
        return "arc_run start requires arc.";
      }
      if (input.arcRun.op === "checkpoint" && input.arcRun.phase === undefined) {
        return "arc_run checkpoint requires phase.";
      }
      return true;
    }
    if (input.arcRun !== undefined) return `${input.action} does not accept arcRun.`;
    if (input.action === "link_work_item") {
      return input.workItem !== undefined &&
        input.title === undefined &&
        input.pullRequest === undefined &&
        input.workflow === undefined
        ? true
        : "link_work_item requires workItem and accepts no title, pullRequest or workflow.";
    }
    if (input.workItem !== undefined) return `${input.action} does not accept workItem.`;
    if (input.action === "set_workflow") {
      return input.workflow !== undefined &&
        input.title === undefined &&
        input.pullRequest === undefined
        ? true
        : "set_workflow requires workflow (null to clear) and does not accept title or pullRequest.";
    }
    if (input.workflow !== undefined) return `${input.action} does not accept workflow.`;
    switch (input.action) {
      case "rename":
        return input.title !== undefined && input.pullRequest === undefined
          ? true
          : "rename requires title and does not accept pullRequest.";
      case "link_pull_request":
        return input.pullRequest !== undefined && input.title === undefined
          ? true
          : "link_pull_request requires pullRequest and does not accept title.";
      case "regenerate_title":
      case "unlink_pull_request":
      case "unlink_work_item":
        return input.title === undefined && input.pullRequest === undefined
          ? true
          : `${input.action} does not accept title or pullRequest.`;
    }
  }),
);
export type ThreadMetadataMcpUpdateInput = typeof ThreadMetadataMcpUpdateInput.Type;

export const ThreadMetadataMcpUpdateResult = Schema.Struct({
  threadId: ThreadId,
  action: ThreadMetadataMcpAction,
  commandId: CommandId,
  sequence: NonNegativeInt,
  title: Schema.String,
  titleRegeneration: Schema.NullOr(ThreadTitleRegeneration),
  linkedPullRequest: Schema.NullOr(ThreadLinkedPullRequest),
  workflow: Schema.NullOr(OrchestrationV2ThreadWorkflow),
  workItem: Schema.NullOr(OrchestrationV2ThreadWorkItem),
  arcRun: Schema.optional(OrchestrationV2ThreadArcRun),
  updatedAt: IsoDateTime,
});
export type ThreadMetadataMcpUpdateResult = typeof ThreadMetadataMcpUpdateResult.Type;
