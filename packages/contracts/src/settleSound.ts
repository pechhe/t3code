import * as Schema from "effect/Schema";

/** What plays once a thread settles; `seat` is the default, `whoosh` the metal recording ported from peach-pi. */
export const SettleSound = Schema.Literals([
  "off",
  "seat",
  "tick",
  "press",
  "pair",
  "soft",
  "detent",
  "whoosh",
  "filed",
  "stamp",
  "resolve",
  "switch",
  "tap",
]);
export type SettleSound = typeof SettleSound.Type;
