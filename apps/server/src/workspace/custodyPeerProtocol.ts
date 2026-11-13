import { RunId, ThreadId, TrimmedNonEmptyString } from "@t3tools/contracts";
import * as Schema from "effect/Schema";

export const toolName = "t3_workspace_custody_handoff";
export const Input = Schema.Struct({
  threadId: ThreadId,
  sourceRunId: RunId,
  runId: RunId,
  receiptRef: TrimmedNonEmptyString,
});
export const Success = Schema.Struct({
  version: Schema.Literals([1]),
  acknowledged: Schema.Literals([true]),
});

export const receiptRef = (threadId: string, sourceRunId: string, runId: string) =>
  `remote-custody:${encodeURIComponent(threadId)}:${encodeURIComponent(sourceRunId)}:${encodeURIComponent(runId)}`;

export class CustodyHandoffIdentityError extends Schema.TaggedError<CustodyHandoffIdentityError>()(
  "CustodyHandoffIdentityError",
  { threadId: ThreadId },
) {
  override get message(): string {
    return "Workspace handback does not own this delivery.";
  }
}
