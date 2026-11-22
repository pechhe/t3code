import * as Schema from "effect/Schema";
import * as SchemaGetter from "effect/SchemaGetter";

/** How much of the building a thread hands to delegated writers. */
export const DelegationStance = Schema.Literals(["orchestrate", "implement"]);
export type DelegationStance = typeof DelegationStance.Type;
export const DEFAULT_DELEGATION_STANCE: DelegationStance = "implement";

/**
 * A stance read back from a thread, policy, task or older peer. The retired middle stance,
 * `flexible`, reads as `implement`; only the current two are ever written.
 */
export const StoredDelegationStance = Schema.Literals([
  "orchestrate",
  "flexible",
  "implement",
]).pipe(
  Schema.decodeTo(DelegationStance, {
    decode: SchemaGetter.transform((stance) => (stance === "flexible" ? "implement" : stance)),
    encode: SchemaGetter.transform((stance) => stance),
  }),
);

/** The only stance a thread stores: one somebody chose. Absent means nobody chose. */
export const DelegationStanceChoice = Schema.Struct({
  stance: StoredDelegationStance,
  chosenBy: Schema.Literals(["owner", "parent"]),
});
export type DelegationStanceChoice = typeof DelegationStanceChoice.Type;

/** A stance as the server resolves it, with the first rule that applied. */
export const ResolvedDelegationStance = Schema.Struct({
  stance: StoredDelegationStance,
  source: Schema.Literals(["owner", "parent", "role", "arc", "model", "fallback"]),
});
export type ResolvedDelegationStance = typeof ResolvedDelegationStance.Type;
