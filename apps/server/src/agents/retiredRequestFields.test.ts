import { AgentTaskWireRequest, OrchestratorMcpDelegateTaskInput } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { withRetiredFields } from "./retiredRequestFields.ts";

// The request as it was fingerprinted while `agentTask` still carried `demanding`.
const before = Object.entries(AgentTaskWireRequest.fields);
before.splice(
  before.findIndex(([key]) => key === "readOnly"),
  0,
  ["demanding", Schema.optional(Schema.Boolean)],
);
const SavedInput = Schema.Struct({
  ...OrchestratorMcpDelegateTaskInput.fields,
  agentTask: Schema.optional(Schema.Struct(Object.fromEntries(before))),
});
const encodeSaved = Schema.encodeSync(Schema.fromJsonString(SavedInput));
const decode = Schema.decodeUnknownSync(OrchestratorMcpDelegateTaskInput);
const encode = Schema.encodeSync(Schema.fromJsonString(OrchestratorMcpDelegateTaskInput));

describe("withRetiredFields", () => {
  const agentTask = {
    role: "implementer",
    taskClass: "non-ui",
    workId: "work",
    attemptId: "attempt-1",
    workspacePath: "/repo",
    sourceRevision: "abc",
    readOnly: false,
    authorModel: "claude-opus-5-5",
  };
  const request = { task: "Build it", clientRequestId: "request-1", agentTask };

  it.each([
    ["with readOnly and authorModel", agentTask],
    ["without either", { ...agentTask, readOnly: undefined, authorModel: undefined }],
  ])("matches a task saved with demanding when retried with or without it (%s)", (_, task) => {
    for (const demanding of [true, false]) {
      const saved = encodeSaved({ ...request, agentTask: { ...task, demanding } } as never);
      for (const retry of [{ ...task }, { ...task, demanding }]) {
        // Decoding drops the retired flag, so the retry's own text never carries it.
        const text = encode(decode({ ...request, agentTask: retry }));
        expect(text).not.toContain("demanding");
        expect(withRetiredFields(text)).toContain(saved);
      }
    }
  });

  it("matches a task first called under a retired writer name, retried under any name", () => {
    const encodeWire = Schema.encodeSync(
      Schema.fromJsonString(
        Schema.Struct({
          ...OrchestratorMcpDelegateTaskInput.fields,
          agentTask: Schema.optional(AgentTaskWireRequest),
        }),
      ),
    );
    const task = { ...agentTask, readOnly: undefined, authorModel: undefined };
    const saved = encodeWire({ ...request, agentTask: { ...task, role: "ui-worker" } } as never);
    for (const role of ["ui-worker", "implementer"]) {
      const text = encode(decode({ ...request, agentTask: { ...task, role } }));
      expect(text).toContain('"role":"implementer"');
      expect(withRetiredFields(text)[0]).toBe(text);
      expect(withRetiredFields(text)).toContain(saved);
    }
  });

  it("leaves a request without a managed task as it is", () => {
    const text = encode(decode({ task: "Look", clientRequestId: "request-2" }));
    expect(withRetiredFields(text)).toEqual([text]);
  });
});
