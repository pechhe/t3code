import { expect, it } from "@effect/vitest";

import { managedTaskTitle } from "./taskTitle.ts";

it("a managed task is named by its role and the caller's topic", () => {
  expect(managedTaskTitle("spec-reviewer", "Review the diff", "Review Spec 33")).toBe(
    "Spec reviewer · Review Spec 33",
  );
  // Callers that still add a thread-title prefix do not repeat it after the role.
  expect(managedTaskTitle("advisor", "Advise", "Worker · Managed browser advice")).toBe(
    "Advisor · Managed browser advice",
  );
  expect(managedTaskTitle("advisor", "Advise", "Worker-safe parsing review")).toBe(
    "Advisor · Worker-safe parsing review",
  );
});

it("an untitled managed task is named by its role and the first line of its task", () => {
  expect(managedTaskTitle("ticket-reviewer", "\n  Review the diff\nMore detail", undefined)).toBe(
    "Ticket reviewer · Review the diff",
  );
  expect(managedTaskTitle("ui-worker", "  ", undefined)).toBe("UI worker");
});
