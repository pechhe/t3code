import { expect, it } from "@effect/vitest";

import { managedTaskTitle } from "./taskTitle.ts";

it("a managed task keeps the title its caller gave", () => {
  expect(managedTaskTitle("reviewer", "Review the diff", "Ticket 18 review")).toBe(
    "Ticket 18 review",
  );
});

it("an untitled managed task is named by its role and the first line of its task", () => {
  expect(managedTaskTitle("reviewer", "\n  Review the diff\nMore detail", undefined)).toBe(
    "Reviewer: Review the diff",
  );
  expect(managedTaskTitle("ui-worker", "  ", undefined)).toBe("UI worker");
});
