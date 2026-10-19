import { isQuietRunCompletion, type RunId } from "@t3tools/contracts";

export function resolveThreadNotificationKind(input: {
  readonly attention: string | null;
  readonly priorAttention: string | null;
  readonly completion: number | null;
  readonly priorCompletion: number | null;
  readonly readOnCompletionRunId?: RunId | null | undefined;
  readonly latestRun: { readonly runId: RunId; readonly status: string } | null;
}): "input" | "completion" | null {
  if (input.attention && input.attention !== input.priorAttention) return "input";
  if (
    input.completion !== null &&
    (input.priorCompletion === null || input.completion > input.priorCompletion) &&
    !isQuietRunCompletion(
      input.readOnCompletionRunId,
      input.latestRun?.runId,
      input.latestRun?.status,
    )
  )
    return "completion";
  return null;
}
