import { describe, expect, it } from "vite-plus/test";

import { dragRolloverBand } from "./rolloverBand.logic";

const start = { soft: 200_000, hard: 260_000 };
const maxTokens = 400_000;

describe("dragRolloverBand", () => {
  it("moves one edge on whole thousands and stops it short of the other", () => {
    expect(dragRolloverBand({ start, part: "soft", deltaTokens: 12_345, maxTokens })).toEqual({
      soft: 212_000,
      hard: 260_000,
    });
    // The soft edge cannot pass the hard one: it keeps 2% of the window between them.
    expect(dragRolloverBand({ start, part: "soft", deltaTokens: 90_000, maxTokens })).toEqual({
      soft: 252_000,
      hard: 260_000,
    });
    expect(dragRolloverBand({ start, part: "hard", deltaTokens: -90_000, maxTokens })).toEqual({
      soft: 200_000,
      hard: 208_000,
    });
  });

  it("moves the whole band at its width and keeps it inside the window", () => {
    expect(dragRolloverBand({ start, part: "band", deltaTokens: 30_000, maxTokens })).toEqual({
      soft: 230_000,
      hard: 290_000,
    });
    expect(dragRolloverBand({ start, part: "band", deltaTokens: 500_000, maxTokens })).toEqual({
      soft: 340_000,
      hard: 400_000,
    });
    expect(dragRolloverBand({ start, part: "hard", deltaTokens: 500_000, maxTokens }).hard).toBe(
      400_000,
    );
  });
});
