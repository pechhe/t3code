import * as Clock from "effect/Clock";
import * as Effect from "effect/Effect";
import * as Random from "effect/Random";

const randomBytes = Effect.all(
  Array.from({ length: 16 }, () => Random.nextIntBetween(0, 256, { halfOpen: true })),
);

const formatUuid = (bytes: ReadonlyArray<number>) => {
  const hex = bytes.map((byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
};

export const randomUuidV4 = randomBytes.pipe(
  Effect.map((bytes) => {
    bytes[6] = (bytes[6]! & 0x0f) | 0x40;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    return formatUuid(bytes);
  }),
);

/** A UUID whose first 48 bits are the current Unix time in milliseconds (RFC 9562). */
export const randomUuidV7 = Effect.all([Clock.currentTimeMillis, randomBytes]).pipe(
  Effect.map(([millis, bytes]) => {
    for (let index = 5; index >= 0; index -= 1) {
      bytes[index] = Math.floor(millis / 2 ** (8 * (5 - index))) % 256;
    }
    bytes[6] = (bytes[6]! & 0x0f) | 0x70;
    bytes[8] = (bytes[8]! & 0x3f) | 0x80;
    return formatUuid(bytes);
  }),
);
