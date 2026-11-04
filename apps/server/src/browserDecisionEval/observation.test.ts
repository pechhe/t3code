import { expect, it } from "@effect/vitest";
import type { PreviewAutomationSnapshot } from "@t3tools/contracts";

import { observationFromSnapshot } from "./observation.ts";

const snapshot = {
  url: "http://localhost:3100/signup",
  title: "Sign up",
  loading: false,
  visibleText: "Sign up",
  interactiveElements: [
    {
      tag: "unknown",
      role: "textbox",
      name: "Full name",
      selector: "aria-ref=e3",
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    },
    {
      tag: "unknown",
      role: "combobox",
      name: "Plan",
      selector: "aria-ref=e4",
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    },
    {
      tag: "unknown",
      role: "checkbox",
      name: "Terms",
      selector: "aria-ref=e5",
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    },
    {
      tag: "unknown",
      role: "heading",
      name: "Sign up",
      selector: "aria-ref=e6",
      x: 0,
      y: 0,
      width: 1,
      height: 1,
    },
  ],
  accessibilityTree: [
    "- generic [ref=e1]:",
    '  - textbox "Full name" [ref=e3]',
    '  - combobox "Plan" [ref=e4]:',
    '    - option "Free" [selected]',
    '    - option "Team"',
    '  - checkbox "Terms" [checked] [ref=e5]',
  ].join("\n"),
} as unknown as PreviewAutomationSnapshot;

it("offers only operable controls with numbered labels, select options and checkbox state", () => {
  const observation = observationFromSnapshot(snapshot);
  expect(observation.elements.map((element) => [element.index, element.operations[0]])).toEqual([
    ["e1", "TYPE_TEXT"],
    ["e2", "SELECT"],
    ["e3", "CLICK"],
  ]);
  expect(observation.elements[1]!.options).toEqual([
    { index: "e2_1", label: "Free" },
    { index: "e2_2", label: "Team" },
  ]);
  expect(observation.elements[2]!.value).toBe("checked");
});
