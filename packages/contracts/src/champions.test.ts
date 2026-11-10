import { describe, expect, it } from "vite-plus/test";

import { championProposalResult, championProposalRetiring } from "./champions.ts";

describe("championProposalRetiring", () => {
  const accepted = [{ id: "errors" }, { id: "latency" }, { id: "crashes" }];

  it("names only the accepted metrics a proposal retires, never the ones it omits", () => {
    const proposal = { metrics: [{ id: "errors" }, { id: "uptime" }], retires: ["latency"] };
    expect(championProposalRetiring(accepted, proposal)).toEqual([{ id: "latency" }]);
    expect(championProposalResult(accepted, proposal).map((m) => m.id)).toEqual([
      "errors",
      "crashes",
      "uptime",
    ]);
    expect(championProposalRetiring(accepted, { metrics: [{ id: "uptime" }] })).toEqual([]);
  });
});
