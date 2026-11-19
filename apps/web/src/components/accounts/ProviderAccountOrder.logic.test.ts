import { describe, expect, it } from "vite-plus/test";

import { accountPositionsText } from "./ProviderAccountOrder.logic";

describe("accountPositionsText", () => {
  it.each([
    [[2], "2nd"],
    [[1, 3], "1st and 3rd"],
    [[4, 5], "4th and 5th"],
    [[12, 2, 4, 5, 6, 7, 8, 9, 10, 11, 13], "2nd and 4th–13th"],
    [[21, 22, 23, 1, 11], "1st, 11th and 21st–23rd"],
  ])("%j reads %s", (positions, text) => {
    expect(accountPositionsText(positions)).toBe(text);
  });
});
