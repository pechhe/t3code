import { expect, it } from "@effect/vitest";
import type { AgentTaskBinding } from "@t3tools/contracts";

import { followupBinding, followupPrompt } from "./followup.ts";
import { codex, request, snapshot } from "./agentPolicy.testkit.ts";

const binding = (sourceRevision?: string): AgentTaskBinding => ({
  ...request({ role: "advisor", ...(sourceRevision === undefined ? {} : { sourceRevision }) }),
  policyHash: snapshot().hash,
  policyRevision: "policy",
  briefHash: "b".repeat(64),
  requestFingerprint: "c".repeat(64),
  sourceAccess: "read-only",
  toolProfile: "source-reader",
  requested: { instanceId: codex.instanceId, model: "gpt-astra-test" },
  assigned: null,
  effective: { instanceId: codex.instanceId, model: "gpt-astra-test" },
});

it("a follow-up states the revision its workspace is at now", () => {
  expect(followupBinding(binding("one"), { sourceRevision: "two" }, undefined)?.sourceRevision).toBe("two");
  expect(followupBinding(binding(), { sourceRevision: "two" }, "one")?.sourceRevision).toBe("two");
});

it("a task launched without a revision continues without one", () => {
  const unpinned = binding();
  expect(followupBinding(unpinned, {}, undefined)).toBe(unpinned);
});

it("a pinned task refuses a follow-up that states no revision", () => {
  expect(followupBinding(binding("one"), {}, undefined)).toBeUndefined();
  // A consulting role keeps the revision an earlier follow-up stated.
  expect(followupBinding(binding(), {}, "one")).toBeUndefined();
});

it("a worker's earlier follow-up revision does not pin it", () => {
  const worker = { ...binding(), role: "implementation-worker" as const };
  expect(followupBinding(worker, {}, "one")).toBe(worker);
});

it("the follow-up message names a revision only when one is stated", () => {
  expect(followupPrompt({ sourceRevision: "two", changes: "edited" }, "Ask")).toBe(
    "Source revision: two\nChanges since your previous task: edited\n\nAsk",
  );
  expect(followupPrompt({ changes: "edited" }, "Ask")).toBe(
    "Changes since your previous task: edited\n\nAsk",
  );
});
