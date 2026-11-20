import * as Predicate from "effect/Predicate";

type JsonObject = { [key: string]: unknown };

/** A check's JSON fragment arrives under `allOf`; one naming no key the schema already has reads flat. */
export const flattenAllOf = (result: JsonObject): JsonObject => {
  if (!Array.isArray(result.allOf)) return result;
  const { allOf, ...rest } = result;
  const parts = allOf.filter((part): part is JsonObject => Predicate.isObject(part));
  const keys = parts.flatMap((part) => Object.keys(part));
  return parts.length === allOf.length &&
    new Set(keys).size === keys.length &&
    keys.every((key) => !(key in rest))
    ? Object.assign(rest, ...parts)
    : result;
};
