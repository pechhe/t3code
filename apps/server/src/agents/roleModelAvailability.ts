import {
  modelNote,
  type AgentListEntry,
  type AgentPolicyCandidate,
  type AgentPolicyManifest,
} from "@t3tools/contracts";
import {
  pooledModelOfBinding,
  type AccountRoutingSettings,
  type PooledModel,
} from "@t3tools/shared/accountPools";
import * as DateTime from "effect/DateTime";

/** Candidate reasons for an account that can start the role's work now. */
export const RUNNABLE_CANDIDATE_REASONS = new Set(["eligible", "selected", "lower-preference"]);

/** Candidate reasons for an account that serves the role but is held back now. */
const HELD_BACK = ["usage-limited", "reserved", "cooldown"] as const;

export interface RoleModel {
  readonly model: string;
  readonly effort?: string;
  readonly note?: string;
  readonly available: boolean;
  readonly returnsAt?: string;
  /** The model's one `usageLimited` entry, when every account serving it is held back. */
  readonly unavailable?: AgentPolicyCandidate;
}

/**
 * A role's models for `agent_roles`, one per routed model however many entries and accounts serve
 * it (fork/differences.md `account-pools`). A model is available when any of its accounts can start
 * now; only one no account can serve reports why and the earliest known return.
 */
export const roleModelAvailability = (input: {
  readonly list: ReadonlyArray<AgentListEntry>;
  readonly manifest: AgentPolicyManifest;
  readonly pools: ReadonlyArray<PooledModel>;
  readonly settings: Pick<AccountRoutingSettings, "modelLinks">;
  readonly candidates: ReadonlyArray<AgentPolicyCandidate>;
  /** Entries with an account that can start now. */
  readonly startable: ReadonlySet<string>;
}): ReadonlyArray<RoleModel> => {
  const groups = new Map<
    string,
    { readonly first: AgentListEntry; readonly aliases: Set<string>; note: string | undefined }
  >();
  for (const entry of input.list) {
    const binding = input.manifest.models[entry.model];
    if (binding === undefined) continue;
    const key = pooledModelOfBinding(input.pools, input.settings, binding)?.key ?? binding.model;
    const group = groups.get(key) ?? {
      first: entry,
      aliases: new Set<string>(),
      note: undefined,
    };
    group.aliases.add(entry.model);
    group.note ??= binding.note ?? modelNote(input.manifest, binding.model);
    groups.set(key, group);
  }
  return [...groups].map(([model, group]) => {
    const effort = group.first.effort;
    const base = {
      model,
      ...(effort === undefined ? {} : { effort }),
      ...(group.note === undefined ? {} : { note: group.note }),
    };
    if ([...group.aliases].some((alias) => input.startable.has(alias)))
      return { ...base, available: true };
    const held = input.candidates.filter(
      (candidate) =>
        group.aliases.has(candidate.alias) &&
        (HELD_BACK as ReadonlyArray<string>).includes(candidate.reason),
    );
    if (held.length === 0) return { ...base, available: false };
    const returns = held.flatMap((candidate) =>
      candidate.until === undefined ? [] : [Date.parse(candidate.until)],
    );
    const returnsAt =
      returns.length === 0
        ? undefined
        : DateTime.formatIso(DateTime.makeUnsafe(Math.min(...returns)));
    const reason =
      HELD_BACK.find((reason) => held.some((candidate) => candidate.reason === reason)) ??
      "usage-limited";
    return {
      ...base,
      available: false,
      ...(returnsAt === undefined ? {} : { returnsAt }),
      unavailable: {
        alias: [...group.aliases][0]!,
        model,
        reason,
        ...(returnsAt === undefined ? {} : { until: returnsAt }),
      },
    };
  });
};
