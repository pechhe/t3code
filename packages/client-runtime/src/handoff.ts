import type {
  ModelSelection,
  OrchestrationV2Run,
  OrchestrationV2ThreadProjection,
  OrchestrationV2TurnItem,
  ProviderInstanceId,
  ServerProvider,
} from "@t3tools/contracts";
import { pickPoolMember } from "@t3tools/shared/providerPools";

export type HandoffTimelineRun = Pick<
  OrchestrationV2Run,
  "id" | "ordinal" | "providerInstanceId" | "modelSelection"
>;

export type HandoffEndpoints = ReturnType<typeof resolveHandoffEndpoints>;

export function resolvePendingHandoff(
  projection: OrchestrationV2ThreadProjection | null | undefined,
  selection: ModelSelection | null | undefined,
  providers: ReadonlyArray<ServerProvider>,
  nowMs: number,
): HandoffEndpoints | null {
  // A thread with an empty timeline has nothing to hand off. Any loaded row
  // counts: paging can leave a window of only tool rows.
  if (!projection?.visibleTurnItems.length) return null;
  const from = projection.runs.findLast(
    (run) => run.startedAt !== null && run.status !== "rolled_back",
  )?.modelSelection;
  if (from === undefined || selection == null) return null;
  // The server keeps the thread on the member its own selection names.
  const to = routePoolSelection(
    selection,
    providers,
    projection.thread.modelSelection.instanceId,
    nowMs,
  );
  const source = providers.find((provider) => provider.instanceId === from.instanceId);
  const target = providers.find((provider) => provider.instanceId === to.instanceId);
  const needsHandoff =
    from.instanceId === to.instanceId
      ? from.model !== to.model && target?.requiresNewThreadForModelChange === true
      : source?.continuation?.groupKey === undefined ||
        source.driver !== target?.driver ||
        source.continuation.groupKey !== target.continuation?.groupKey;
  return needsHandoff ? { from: [from], to } : null;
}

/** Mirrors the server's pool routing: a pool runs on the thread's member while it has allowance. */
function routePoolSelection(
  selection: ModelSelection,
  providers: ReadonlyArray<ServerProvider>,
  current: ProviderInstanceId,
  nowMs: number,
): ModelSelection {
  const pool = providers.find((provider) => provider.instanceId === selection.instanceId);
  const members = pool?.poolMembers;
  if (pool === undefined || members === undefined) return selection;
  const member =
    pickPoolMember({
      pool: {
        driver: pool.driver,
        members,
        preferredMember: pool.poolPreferredMember,
        policy: pool.poolPolicy,
      },
      providers,
      nowMs,
      current,
    }) ?? members[0];
  return member === undefined ? selection : { ...selection, instanceId: member };
}

/**
 * Whether handoff endpoints need their account names: two endpoints are
 * different accounts of the same provider, so icon and model alone read the same.
 */
export function handoffCrossesAccounts(
  endpoints: HandoffEndpoints,
  providers: ReadonlyArray<ServerProvider>,
): boolean {
  const instances = new Set(
    [...endpoints.from, endpoints.to].map((endpoint) => endpoint.instanceId),
  );
  const drivers = new Set(
    [...instances].map(
      (instanceId) =>
        providers.find((provider) => provider.instanceId === instanceId)?.driver ?? instanceId,
    ),
  );
  return drivers.size < instances.size;
}

export function resolveHandoffEndpoints(
  item: Pick<
    Extract<OrchestrationV2TurnItem, { type: "handoff" }>,
    "runId" | "fromModelSelections" | "fromProviderInstanceIds" | "toModel" | "toProviderInstanceId"
  >,
  runs: ReadonlyArray<HandoffTimelineRun>,
) {
  const handoffRun = item.runId === null ? undefined : runs.find((run) => run.id === item.runId);
  const toModel =
    item.toModel ??
    (handoffRun !== undefined && handoffRun.providerInstanceId === item.toProviderInstanceId
      ? handoffRun.modelSelection.model
      : undefined);
  const fromEndpoints: ReadonlyArray<{
    readonly instanceId: ProviderInstanceId;
    readonly model?: string | undefined;
  }> =
    item.fromModelSelections !== undefined && item.fromModelSelections.length > 0
      ? item.fromModelSelections
      : item.fromProviderInstanceIds.map((instanceId) => ({
          instanceId,
          model: latestRunModelBefore(runs, instanceId, handoffRun?.ordinal),
        }));
  return { from: fromEndpoints, to: { instanceId: item.toProviderInstanceId, model: toModel } };
}

function latestRunModelBefore(
  runs: ReadonlyArray<HandoffTimelineRun>,
  instanceId: ProviderInstanceId,
  beforeOrdinal: number | undefined,
): string | undefined {
  let latest: HandoffTimelineRun | undefined;
  for (const run of runs) {
    if (run.providerInstanceId !== instanceId) continue;
    if (beforeOrdinal !== undefined && run.ordinal >= beforeOrdinal) continue;
    if (latest === undefined || run.ordinal > latest.ordinal) latest = run;
  }
  return latest?.modelSelection.model;
}
