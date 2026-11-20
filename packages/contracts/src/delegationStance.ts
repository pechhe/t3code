import * as Schema from "effect/Schema";

/** How much of the building a thread hands to delegated writers. */
export const DelegationStance = Schema.Literals(["orchestrate", "flexible", "implement"]);
export type DelegationStance = typeof DelegationStance.Type;
export const DEFAULT_DELEGATION_STANCE: DelegationStance = "flexible";

/** The only stance a thread stores: one somebody chose. Absent means nobody chose. */
export const DelegationStanceChoice = Schema.Struct({
  stance: DelegationStance,
  chosenBy: Schema.Literals(["owner", "parent"]),
});
export type DelegationStanceChoice = typeof DelegationStanceChoice.Type;

/** A stance as the server resolves it, with the first rule that applied. */
export const ResolvedDelegationStance = Schema.Struct({
  stance: DelegationStance,
  source: Schema.Literals(["owner", "parent", "role", "arc", "model", "fallback"]),
});
export type ResolvedDelegationStance = typeof ResolvedDelegationStance.Type;
