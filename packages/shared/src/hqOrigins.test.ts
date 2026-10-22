import { describe, expect, it } from "vite-plus/test";

import { currentHqOrigin, DEFAULT_HQ_ORIGIN, sameHqAddress } from "./hqOrigins.ts";

describe("Weave's addresses", () => {
  it("uses the address Weave answers on now for one it has moved from", () => {
    expect(currentHqOrigin("https://hq.yardsmith.co.uk")).toBe(DEFAULT_HQ_ORIGIN);
    expect(currentHqOrigin(DEFAULT_HQ_ORIGIN)).toBe(DEFAULT_HQ_ORIGIN);
    expect(currentHqOrigin("https://hq.example.test")).toBe("https://hq.example.test");
  });

  it("treats a link, connection or record made at an address Weave has moved from as this Weave's", () => {
    expect(sameHqAddress("https://hq.yardsmith.co.uk", DEFAULT_HQ_ORIGIN)).toBe(true);
    expect(sameHqAddress(DEFAULT_HQ_ORIGIN, "https://hq.yardsmith.co.uk")).toBe(true);
    expect(sameHqAddress("https://other.example.test", DEFAULT_HQ_ORIGIN)).toBe(false);
  });
});
