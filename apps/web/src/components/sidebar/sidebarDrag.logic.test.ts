import { describe, expect, it } from "vite-plus/test";

import { isWorkingRowDrag } from "./sidebarDrag.logic";

describe("isWorkingRowDrag", () => {
  it.each([
    ["working", true],
    ["landing", true],
    ["active", false],
    ["snoozed", false],
    [undefined, false],
  ] as const)("reads %s as %s", (section, expected) => {
    expect(isWorkingRowDrag(section)).toBe(expected);
  });
});
