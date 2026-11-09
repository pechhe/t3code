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
