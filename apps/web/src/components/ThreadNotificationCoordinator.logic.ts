import { isQuietRunCompletion, type RunId } from "@t3tools/contracts";

export function resolveThreadNotificationKind(input: {
  readonly attention: string | null;
  readonly priorAttention: string | null;
  readonly completion: number | null;
  readonly priorCompletion: number | null;
  readonly readOnCompletionRunId?: RunId | null | undefined;
  readonly latestRun: { readonly runId: RunId; readonly status: string } | null;
  /** A run with nothing to report, such as a compaction T3 started, stays quiet. */
  readonly latestRunSilent?: boolean | undefined;
}): "input" | "completion" | null {
  if (input.attention && input.attention !== input.priorAttention) return "input";
  if (
    input.latestRunSilent !== true &&
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
