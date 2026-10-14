// @effect-diagnostics nodeBuiltinImport:off - CLI transport tests use temporary files.
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { assert, it } from "@effect/vitest";
import {
  AgentRolesInput,
  AgentTaskOutcomeInput,
  ExperimentWorkAllocationInput,
  ExperimentOutcomeInput,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as CliError from "effect/cli/CliError";
import * as Option from "effect/Option";

import {
  callAgentTool,
  decodeAgentRequest,
  readAgentRequest,
  resolveAgentCredentialsDirectory,
  toAgentCommandError,
} from "./agent.ts";

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

it.effect("validates and dispatches a work request once, returning structured server data", () =>
  Effect.gen(function* () {
    const calls: Array<{
      endpoint: string;
      tool: string;
      args: Readonly<Record<string, unknown>>;
    }> = [];
    const client = {
      call: (endpoint: string, tool: string, args: Readonly<Record<string, unknown>>) =>
        Effect.sync(() => {
          calls.push({ endpoint, tool, args });
          return { workUnitId: "work-unit-1", assignmentIds: ["assignment-1"] };
        }),
    };
    const request = {
      id: "allocation-1",
      workUnitId: "work-unit-1",
      allocation: "delegated",
      reason: "The task has a bounded implementation scope.",
      deviationReason: null,
    };

    const result = yield* callAgentTool(
      client,
      "https://t3.example",
      "t3_work_allocate",
      ExperimentWorkAllocationInput,
      request,
    );

    assert.deepEqual(result, { workUnitId: "work-unit-1", assignmentIds: ["assignment-1"] });
    assert.deepEqual(calls, [
      {
        endpoint: "https://t3.example",
        tool: "t3_work_allocate",
        args: request,
      },
    ]);
  }),
);

it.effect("rejects unsafe work request values without exposing or dispatching them", () =>
  Effect.gen(function* () {
    let callCount = 0;
    const client = {
      call: () =>
        Effect.sync(() => {
          callCount += 1;
          return {};
        }),
    };
    const result = yield* Effect.result(
      callAgentTool(
        client,
        "https://t3.example",
        "t3_work_allocate",
        ExperimentWorkAllocationInput,
        { id: "invalid", workUnitId: "work-unit-1", evidence: "private payload" },
      ),
    );

    assert.equal(result._tag, "Failure");
    if (result._tag === "Failure") {
      assert.equal(result.failure._tag, "UserError");
      if (result.failure._tag === "UserError") {
        assert.equal(result.failure.userMessage, "Request JSON does not match the command schema.");
        assert.notInclude(result.failure.userMessage, "private payload");
      }
    }
    assert.equal(callCount, 0);
  }),
);

it.effect("records work outcomes without a delegated task id and forces self-report source", () =>
  Effect.gen(function* () {
    const calls: Array<{ tool: string; args: Readonly<Record<string, unknown>> }> = [];
    const client = {
      call: (_endpoint: string, tool: string, args: Readonly<Record<string, unknown>>) =>
        Effect.sync(() => {
          calls.push({ tool, args });
          return { recordedAt: "2026-10-14T12:00:00.000Z" };
        }),
    };
    const request = {
      id: "outcome-1",
      assignmentId: "assignment-from-enroll",
      runId: null,
      kind: "verified-completion",
      source: "independent-evidence",
      evidence: ["The requested behavior was verified."],
      note: "Completed the bounded work.",
      actualModelSelection: null,
      fallbackReason: null,
    };

    yield* callAgentTool(
      client,
      "https://t3.example",
      "t3_work_outcome",
      ExperimentOutcomeInput,
      request,
      (value) => ({ ...(value as Record<string, unknown>), source: "self-report" }),
    );

    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.tool, "t3_work_outcome");
    assert.equal(calls[0]?.args.source, "self-report");
    assert.equal("taskId" in (calls[0]?.args ?? {}), false);
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

it("keeps request errors visible and hides unexpected failure detail behind a credential hint", () => {
  const request = new CliError.UserError({
    cause: "read",
    userMessage: "Could not read request JSON.",
  });
  assert.strictEqual(toAgentCommandError(request), request);
  const unexpected = toAgentCommandError(new Error("secret-token-value"));
  assert.equal(
    unexpected.userMessage,
    "T3 agent command failed. Check the endpoint and local credentials.",
  );
  assert.notInclude(unexpected.userMessage, "secret-token-value");
});
