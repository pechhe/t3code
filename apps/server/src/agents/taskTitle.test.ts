import { expect, it } from "@effect/vitest";

import { managedTaskTitle } from "./taskTitle.ts";

it("a managed task is named by its role and the caller's topic", () => {
  expect(managedTaskTitle("reviewer", "Review the diff", "Review Spec 33")).toBe(
    "Reviewer · Review Spec 33",
  );
  // Callers that still add a thread-title prefix do not repeat it after the role.
  expect(managedTaskTitle("advisor", "Advise", "Worker · Managed browser advice")).toBe(
    "Advisor · Managed browser advice",
  );
  expect(managedTaskTitle("advisor", "Advise", "Worker-safe parsing review")).toBe(
    "Advisor · Worker-safe parsing review",
  );
  // A caller that names the role itself, with a colon or after T3's own label, leaves no repeat.
  expect(
    managedTaskTitle("scout", "Map the preview path", "Scout: combined preview serving path"),
  ).toBe("Scout · combined preview serving path");
  expect(managedTaskTitle("reviewer", "Review", "Reviewer · YS-1503 Spec review")).toBe(
    "Reviewer · YS-1503 Spec review",
  );
  expect(managedTaskTitle("scout", "Map it", "Scout")).toBe("Scout · Map it");
});

it("an untitled managed task is named by its role and the first line of its task", () => {
  expect(managedTaskTitle("reviewer", "\n  Review the diff\nMore detail", undefined)).toBe(
    "Reviewer · Review the diff",
  );
  expect(managedTaskTitle("implementer", "  ", undefined)).toBe("Implementer");
});
