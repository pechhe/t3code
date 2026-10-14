// @effect-diagnostics nodeBuiltinImport:off - CLI transport tests use temporary files.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import { AgentRolesInput, AgentTaskOutcomeInput } from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

import { decodeAgentRequest, readAgentRequest, resolveAgentCredentialsDirectory } from "./agent.ts";

it.effect("reads agent request JSON from either a file path or stdin", () =>
  Effect.gen(function* () {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-agent-cli-"));
    const requestPath = NodePath.join(directory, "request.json");
    NodeFS.writeFileSync(requestPath, '{"taskClass":"implementation"}');

    const fromFile = yield* readAgentRequest(
      requestPath,
      (path) => Effect.succeed(NodeFS.readFileSync(path, "utf8")),
      () => Effect.succeed("unused"),
    );
    const fromStdin = yield* readAgentRequest(
      "-",
      () => Effect.succeed("unused"),
      () => Effect.succeed('{"taskClass":"review"}'),
    );

    assert.equal(fromFile, '{"taskClass":"implementation"}');
    assert.equal(fromStdin, '{"taskClass":"review"}');
  }),
);

it.effect("rejects malformed request values with a safe message", () =>
  Effect.gen(function* () {
    const result = yield* Effect.result(
      decodeAgentRequest(AgentRolesInput, { secret: "must not appear" }),
    );
    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure") {
      assert.equal(result.failure.userMessage, "Request JSON does not match the command schema.");
      assert.notInclude(result.failure.userMessage, "must not appear");
    }
  }),
);

it.effect("decodes outcome requests with the task and assignment returned by submit", () =>
  Effect.gen(function* () {
    const request = {
      taskId: "task-123",
      outcome: {
        id: "outcome-123",
        assignmentId: "assignment-from-submit",
        runId: null,
        kind: "verified-completion",
        source: "self-report",
        evidence: ["Review completed"],
        note: "Completed the requested work.",
        actualModelSelection: null,
        fallbackReason: null,
      },
    };
    const decoded = yield* decodeAgentRequest(AgentTaskOutcomeInput, request);

    assert.equal(decoded.taskId, request.taskId);
    assert.equal(decoded.outcome.assignmentId, "assignment-from-submit");
    assert.equal(decoded.outcome.source, "self-report");
  }),
);

it("uses a separate default agent credential directory and honors an explicit directory", () => {
  assert.equal(
    resolveAgentCredentialsDirectory(Option.none(), "/home/person"),
    "/home/person/.t3/agent-clients",
  );
  assert.equal(
    resolveAgentCredentialsDirectory(Option.some("/tmp/isolated-agent-creds"), "/home/person"),
    "/tmp/isolated-agent-creds",
  );
});
