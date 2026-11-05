import { describe, expect, it } from "vite-plus/test";

import { currentWeaveOrigin, DEFAULT_WEAVE_ORIGIN, sameWeaveAddress } from "./weaveOrigins.ts";

describe("Weave's addresses", () => {
  it("uses the address Weave answers on now for one it has moved from", () => {
    expect(currentWeaveOrigin("https://hq.yardsmith.co.uk")).toBe(DEFAULT_WEAVE_ORIGIN);
    expect(currentWeaveOrigin(DEFAULT_WEAVE_ORIGIN)).toBe(DEFAULT_WEAVE_ORIGIN);
    expect(currentWeaveOrigin("https://weave.example.test")).toBe("https://weave.example.test");
  });

  it("treats a link, connection or record made at an address Weave has moved from as this Weave's", () => {
    expect(sameWeaveAddress("https://hq.yardsmith.co.uk", DEFAULT_WEAVE_ORIGIN)).toBe(true);
    expect(sameWeaveAddress(DEFAULT_WEAVE_ORIGIN, "https://hq.yardsmith.co.uk")).toBe(true);
    expect(sameWeaveAddress("https://other.example.test", DEFAULT_WEAVE_ORIGIN)).toBe(false);
  });
});
