import { assert, describe, it } from "@effect/vitest";

import * as HostResources from "./HostResources.ts";

describe("HostResources", () => {
  it("reads macOS swap usage in the unit sysctl prints it in", () => {
    assert.deepEqual(
      HostResources.darwinSwap("total = 10240.00M  used = 9876.12M  free = 363.88M  (encrypted)\n"),
      { totalBytes: 10 * 1024 ** 3, usedBytes: Math.round(9876.12 * 1024 ** 2) },
    );
    assert.deepEqual(HostResources.darwinSwap("total = 2.00G  used = 0.00M  free = 2.00G"), {
      totalBytes: 2 * 1024 ** 3,
      usedBytes: 0,
    });
  });

  it("reports no swap when sysctl prints nothing it recognises", () => {
    assert.isNull(HostResources.darwinSwap(""));
    assert.isNull(HostResources.darwinSwap("vm.swapusage: unknown oid"));
  });
});
