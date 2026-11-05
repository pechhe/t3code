import * as Digest from "effect/crypto/Digest";
import * as Effect from "effect/Effect";
import * as Hex from "effect/encoding/Hex";

/**
 * Keeps a reference within the length Weave accepts, which refuses the whole record otherwise. A
 * longer one keeps its head and ends in a hash of the whole, so two long references stay distinct
 * and a replay of one stays the same.
 */
export const boundedRef = (crypto: Digest.Digest["Service"], ref: string, maxLength: number) => {
  if (ref.length <= maxLength) return Effect.succeed(ref);
  return crypto.digest(Digest.sha256, new TextEncoder().encode(ref)).pipe(
    Effect.map((digest) => {
      const hash = Hex.encode(digest);
      return `${ref.slice(0, maxLength - hash.length - 1)}#${hash}`;
    }),
  );
};
