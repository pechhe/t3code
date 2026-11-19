import {
  type EnvironmentId,
  type OrchestrationV2ProviderTurnTokenUsage,
  resolveClaudeCompactionSetting,
} from "@t3tools/contracts";
import { resolveSelectableModel } from "@t3tools/shared/model";

import type { ProviderInstanceEntry } from "../../providerInstances";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { resolveCompactionModelDisplayName } from "./compaction.logic";

/**
 * The model the offered resume compaction would summarise with, or null when none is offered.
 * An unset compaction model asks the server which chore-worker model would run it.
 */
export function useResumeCompactionModelName(input: {
  readonly environmentId: EnvironmentId;
  readonly settings: Parameters<typeof resolveClaudeCompactionSetting>[0];
  readonly selectedProviderEntry: ProviderInstanceEntry | undefined;
  readonly providerInstanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  readonly threadModel: string | undefined;
  readonly providerTurns: ReadonlyArray<{
    readonly tokenUsage?: OrchestrationV2ProviderTurnTokenUsage | undefined;
    readonly providerThreadId: string;
  }>;
  readonly providerThreadId: string | undefined;
  readonly resumeCompactionTokens: number | null;
  readonly nowMinute: string;
}): string | null {
  const {
    environmentId,
    settings,
    selectedProviderEntry,
    providerInstanceEntries,
    threadModel,
    resumeCompactionTokens,
    nowMinute,
  } = input;
  const unsetCompactionModel =
    selectedProviderEntry !== undefined &&
    resolveClaudeCompactionSetting(settings, selectedProviderEntry.instanceId).model.trim() === "";
  const choreWorkerCompactionQuery = useEnvironmentQuery(
    resumeCompactionTokens !== null && unsetCompactionModel
      ? serverEnvironment.agentPolicyCompactionModel({ environmentId, input: {} })
      : null,
  );
  const choreWorkerSelection = choreWorkerCompactionQuery.data?.selection ?? null;
  return resumeCompactionTokens !== null &&
    selectedProviderEntry !== undefined &&
    threadModel !== undefined
    ? resolveCompactionModelDisplayName({
        setting: resolveClaudeCompactionSetting(settings, selectedProviderEntry.instanceId),
        conversationInstanceId: selectedProviderEntry.instanceId,
        conversationModel:
          resolveSelectableModel(
            selectedProviderEntry.driverKind,
            threadModel,
            selectedProviderEntry.models,
          ) ?? threadModel,
        models:
          providerInstanceEntries.find(
            (entry) =>
              entry.instanceId ===
              resolveClaudeCompactionSetting(settings, selectedProviderEntry.instanceId).instanceId,
          )?.models ?? selectedProviderEntry.models,
        usages: input.providerTurns.flatMap((turn) =>
          turn.tokenUsage !== undefined && turn.providerThreadId === input.providerThreadId
            ? [turn.tokenUsage]
            : [],
        ),
        usedTokens: resumeCompactionTokens,
        now: `${nowMinute}:00.000Z`,
        choreWorker: {
          selection: choreWorkerSelection,
          models:
            providerInstanceEntries.find(
              (entry) => entry.instanceId === choreWorkerSelection?.instanceId,
            )?.models ?? [],
        },
      })
    : null;
}
