import type { EnvironmentId, SharedProviderSetupState } from "@t3tools/contracts";

export interface SharedSetupMember {
  readonly environmentId: EnvironmentId;
  readonly state: SharedProviderSetupState;
}

export interface SharedSetupPlan {
  readonly sourceEnvironmentId: EnvironmentId;
  readonly version: number;
  readonly changedAt: string;
  /** Includes the source when it still has to record that its edit was spread. */
  readonly targets: ReadonlyArray<SharedSetupMember>;
}

const hasUnspreadEdit = ({ state }: SharedSetupMember) => state.version > state.baseVersion;

const laterEdit = (a: SharedSetupMember, b: SharedSetupMember): SharedSetupMember => {
  const difference = Date.parse(a.state.changedAt) - Date.parse(b.state.changedAt);
  if (difference !== 0) return difference > 0 ? a : b;
  return a.environmentId > b.environmentId ? a : b;
};

/** Agreement needs no clock: only edits nobody has seen together are compared by time. */
const newest = (a: SharedSetupMember, b: SharedSetupMember): SharedSetupMember => {
  const aEdited = hasUnspreadEdit(a);
  const bEdited = hasUnspreadEdit(b);
  if (aEdited && !bEdited && b.state.version <= a.state.baseVersion) return a;
  if (bEdited && !aEdited && a.state.version <= b.state.baseVersion) return b;
  if (!aEdited && !bEdited && a.state.version !== b.state.version) {
    return a.state.version > b.state.version ? a : b;
  }
  return laterEdit(a, b);
};

/** Null when every member already holds the same setup. */
export function planSharedSetupSync(
  members: ReadonlyArray<SharedSetupMember>,
): SharedSetupPlan | null {
  const [first, ...rest] = members;
  if (first === undefined || rest.length === 0) return null;
  const source = rest.reduce(newest, first);
  const highest = Math.max(...members.map(({ state }) => state.version));
  const sameEdit = (member: SharedSetupMember) =>
    member.state.version === source.state.version &&
    member.state.changedAt === source.state.changedAt;
  const unique = members.every((member) => member.state.version !== highest || sameEdit(member));
  const version = source.state.version === highest && unique ? highest : highest + 1;
  const targets = members.filter(
    (member) =>
      member.state.version !== version ||
      member.state.changedAt !== source.state.changedAt ||
      hasUnspreadEdit(member),
  );
  if (targets.length === 0) return null;
  return {
    sourceEnvironmentId: source.environmentId,
    version,
    changedAt: source.state.changedAt,
    targets,
  };
}

const EPOCH_ISO = "1970-01-01T00:00:00.000Z";

interface SharedModelPreferencesMember extends SharedSetupMember {
  readonly hasPreferences?: boolean;
}

function modelPreferencesSetupMember(member: SharedModelPreferencesMember): SharedSetupMember {
  return {
    environmentId: member.environmentId,
    state: {
      shared: member.state.shared,
      version: member.state.modelPreferencesVersion ?? 0,
      baseVersion: member.state.modelPreferencesBaseVersion ?? 0,
      changedAt: member.state.modelPreferencesChangedAt ?? EPOCH_ISO,
      digest: member.state.modelPreferencesDigest ?? "",
    },
  };
}

/** Null when every member already holds the same model preferences. */
export function planSharedModelPreferencesSync(
  members: ReadonlyArray<SharedModelPreferencesMember>,
): SharedSetupPlan | null {
  const projected = members.map(modelPreferencesSetupMember);
  const plan = planSharedSetupSync(projected);
  if (plan !== null) {
    const source = projected.find((member) => member.environmentId === plan.sourceEnvironmentId);
    if (!source) return plan;
    const targets = projected.filter(
      (member) =>
        member.state.version !== plan.version ||
        member.state.changedAt !== plan.changedAt ||
        hasUnspreadEdit(member) ||
        (source.state.digest !== "" && member.state.digest !== source.state.digest),
    );
    return { ...plan, targets };
  }
  if (projected.length < 2) return null;
  const digests = new Set(projected.map((member) => member.state.digest));
  if (digests.size <= 1) return null;

  // Migrated machines can start at the same version/epoch with different favorites: prefer a
  // populated member, then break ties deterministically so divergent machines still converge.
  const ranked = members.map((member, index) => ({
    raw: member,
    projected: projected[index]!,
  }));
  const winner = ranked.reduce((best, candidate) => {
    const bestPopulated = best.raw.hasPreferences !== false && best.projected.state.digest !== "";
    const candidatePopulated =
      candidate.raw.hasPreferences !== false && candidate.projected.state.digest !== "";
    if (candidatePopulated !== bestPopulated) {
      return candidatePopulated ? candidate : best;
    }
    return laterEdit(best.projected, candidate.projected) === candidate.projected
      ? candidate
      : best;
  });
  const highest = Math.max(...projected.map(({ state }) => state.version));
  const version = highest + 1;
  return {
    sourceEnvironmentId: winner.projected.environmentId,
    version,
    changedAt: winner.projected.state.changedAt,
    targets: projected,
  };
}

/**
 * A source records its edit as spread only once everyone else took it: a refused target can still
 * hold a newer edit, which has to stay comparable with the source's.
 */
export async function applySharedSetupPlan(
  plan: SharedSetupPlan,
  apply: (target: SharedSetupMember) => Promise<string | null>,
): Promise<ReadonlyMap<EnvironmentId, string>> {
  const failures = new Map<EnvironmentId, string>();
  const isSource = (target: SharedSetupMember) => target.environmentId === plan.sourceEnvironmentId;
  for (const target of plan.targets.filter((member) => !isSource(member))) {
    const failure = await apply(target);
    if (failure !== null) failures.set(target.environmentId, failure);
  }
  if (failures.size > 0) return failures;
  for (const target of plan.targets.filter(isSource)) {
    const failure = await apply(target);
    if (failure !== null) failures.set(target.environmentId, failure);
  }
  return failures;
}
