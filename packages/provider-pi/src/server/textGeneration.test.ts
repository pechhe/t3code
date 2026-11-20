import { assert, it } from "@effect/vitest";
import { ProviderInstanceId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import * as Cause from "effect/Cause";
import * as Effect from "effect/Effect";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as Sink from "effect/Sink";
import * as Stream from "effect/Stream";
import * as ChildProcess from "effect/process/ChildProcess";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { makePiTextGeneration } from "./textGeneration.ts";

const decodeJsonLine = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Unknown));
const encodeJsonLine = Schema.encodeSync(Schema.fromJsonString(Schema.Unknown));

const makeFakePi = (
  reply: string,
  setModelError?: string,
  turnEvents: ReadonlyArray<Record<string, unknown>> = [],
  models?: ReadonlyArray<Record<string, unknown>>,
  version = "1.0.4",
  thinkingError?: string,
  state?: unknown,
) =>
  Effect.gen(function* () {
    const stdout = yield* Queue.unbounded<Uint8Array, Cause.Done>();
    const received: Array<Record<string, unknown>> = [];
    const emit = (record: Record<string, unknown>) =>
      Queue.offer(stdout, new TextEncoder().encode(`${encodeJsonLine(record)}\n`));
    let buffered = "";
    const onStdin = (chunk: Uint8Array) =>
      Effect.gen(function* () {
        buffered += new TextDecoder().decode(chunk);
        const lines = buffered.split("\n");
        buffered = lines.pop() ?? "";
        for (const line of lines.filter((candidate) => candidate.length > 0)) {
          const record = decodeJsonLine(line) as Record<string, unknown>;
          received.push(record);
          const response = { type: "response", id: record["id"], command: record["type"] };
          if (record["type"] === "prompt") {
            yield* emit({ ...response, success: true });
            for (const event of turnEvents) yield* emit(event);
            yield* emit({ type: "agent_settled" });
          } else if (record["type"] === "get_last_assistant_text") {
            yield* emit({ ...response, success: true, data: { text: reply } });
          } else if (record["type"] === "get_state" && state !== undefined) {
            yield* emit({ ...response, success: true, data: state });
          } else if (record["type"] === "get_available_models" && models !== undefined) {
            yield* emit({ ...response, success: true, data: { models } });
          } else if (record["type"] === "set_model" && setModelError !== undefined) {
            yield* emit({ ...response, success: false, error: setModelError });
          } else if (record["type"] === "set_thinking_level" && thinkingError !== undefined) {
            yield* emit({ ...response, success: false, error: thinkingError });
          } else {
            yield* emit({ ...response, success: true });
          }
        }
      });
    const spawner = ChildProcessSpawner.make((command) => {
      const versionProbe =
        ChildProcess.isStandardCommand(command) && command.args.includes("--version");
      return Effect.succeed(
        ChildProcessSpawner.makeHandle({
          // Outside the valid pid range, so PiRpc's process-group kill never lands.
          pid: ChildProcessSpawner.ProcessId(999_999_999),
          exitCode: versionProbe ? Effect.succeed(ChildProcessSpawner.ExitCode(0)) : Effect.never,
          isRunning: Effect.succeed(true),
          kill: () => Effect.void,
          unref: Effect.succeed(Effect.void),
          stdin: Sink.forEach(onStdin),
          stdout: versionProbe
            ? Stream.make(new TextEncoder().encode(version))
            : Stream.fromQueue(stdout),
          stderr: Stream.empty,
          all: Stream.empty,
          getInputFd: () => Sink.drain,
          getOutputFd: () => Stream.empty,
        }),
      );
    });
    return { spawner, received };
  });

it.effect("runs Pi offline, since the process is stopped as soon as it answers", () =>
  Effect.gen(function* () {
    const pi = yield* makeFakePi(JSON.stringify({ subject: "Update README", body: "" }));
    const launches: Array<ReadonlyArray<string>> = [];
    const spawner = ChildProcessSpawner.make((command) => {
      if (ChildProcess.isStandardCommand(command)) launches.push(command.args.map(String));
      return pi.spawner.spawn(command);
    });
    const textGeneration = yield* makePiTextGeneration(
      {
        enabled: true,
        binaryPath: "pi",
        launchArgs: "",
        customModels: [],
        autoCompactWindow: "",
        memoryModel: "",
      },
      {},
    ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));

    const result = yield* textGeneration.generateCommitMessage({
      cwd: process.cwd(),
      branch: "main",
      stagedSummary: "M README.md",
      stagedPatch: "diff --git a/README.md b/README.md",
      modelSelection: createModelSelection(ProviderInstanceId.make("pi"), "default"),
    });

    assert.equal(result.subject, "Update README");
    assert.deepEqual(
      launches.map((args) => args.filter((arg) => arg === "--offline")),
      [["--offline"]],
    );
  }),
);

const piSettings = {
  enabled: true,
  binaryPath: "pi",
  launchArgs: "",
  customModels: [],
  autoCompactWindow: "",
  memoryModel: "",
} as const;

// Routes each launch to its own fake process: the no-extensions fast path or the relaunch.
const makeRoutedPi = (input: {
  readonly extensionFree: Effect.Success<ReturnType<typeof makeFakePi>>;
  readonly withExtensions: Effect.Success<ReturnType<typeof makeFakePi>>;
}) => {
  const launches: Array<ReadonlyArray<string>> = [];
  const spawner = ChildProcessSpawner.make((command) => {
    const args = ChildProcess.isStandardCommand(command) ? command.args.map(String) : [];
    if (!args.includes("--version")) launches.push(args);
    return (
      args.includes("--no-extensions") ? input.extensionFree : input.withExtensions
    ).spawner.spawn(command);
  });
  return { spawner, launches };
};

const generateWithModel = (
  model: string,
  spawner: ChildProcessSpawner.ChildProcessSpawner["Service"],
) =>
  Effect.gen(function* () {
    const textGeneration = yield* makePiTextGeneration(piSettings, {}).pipe(
      Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
    );
    return yield* textGeneration.generateCommitMessage({
      cwd: process.cwd(),
      branch: "main",
      stagedSummary: "M README.md",
      stagedPatch: "diff --git a/README.md b/README.md",
      modelSelection: createModelSelection(ProviderInstanceId.make("pi"), model),
    });
  });

it.effect("relaunches with extensions, still tool- and MCP-free, for a model they register", () =>
  Effect.gen(function* () {
    const extensionFree = yield* makeFakePi("", undefined, [], [{ provider: "a", id: "b" }]);
    const withExtensions = yield* makeFakePi(
      JSON.stringify({ subject: "Update README", body: "" }),
    );
    const routed = makeRoutedPi({ extensionFree, withExtensions });

    const result = yield* generateWithModel("demo/demo-model", routed.spawner);

    assert.equal(result.subject, "Update README");
    assert.equal(routed.launches.length, 2);
    const [fast = [], relaunch = []] = routed.launches;
    assert.include(fast, "--no-extensions");
    assert.notInclude(relaunch, "--no-extensions");
    for (const args of routed.launches) {
      assert.includeMembers([...args], ["--no-session", "--offline", "--no-tools", "--no-mcp"]);
    }
    assert.isUndefined(extensionFree.received.find((record) => record["type"] === "set_model"));
    assert.isUndefined(extensionFree.received.find((record) => record["type"] === "prompt"));
    assert.equal(
      withExtensions.received.find((record) => record["type"] === "set_model")?.["modelId"],
      "demo-model",
    );
  }),
);

it.effect("relaunches Pi's configured default model when only extensions register it", () =>
  Effect.gen(function* () {
    const extensionFree = yield* makeFakePi(
      "",
      undefined,
      [],
      [{ provider: "a", id: "b" }],
      "1.0.4",
      undefined,
      { model: { provider: "antigravity", id: "gemini" } },
    );
    const withExtensions = yield* makeFakePi(
      JSON.stringify({ subject: "Update README", body: "" }),
      undefined,
      [],
      [{ provider: "antigravity", id: "gemini" }],
    );
    const routed = makeRoutedPi({ extensionFree, withExtensions });

    const result = yield* generateWithModel("default", routed.spawner);

    assert.equal(result.subject, "Update README");
    assert.equal(routed.launches.length, 2);
    assert.notInclude(routed.launches[1] ?? [], "--no-extensions");
    assert.isUndefined(withExtensions.received.find((record) => record["type"] === "set_model"));
    assert.isDefined(withExtensions.received.find((record) => record["type"] === "prompt"));
  }),
);

it.effect("retries the extensions relaunch with --no-approve when it exits before answering", () =>
  Effect.gen(function* () {
    const extensionFree = yield* makeFakePi("", undefined, [], [{ provider: "a", id: "b" }]);
    const withExtensions = yield* makeFakePi(
      JSON.stringify({ subject: "Update README", body: "" }),
    );
    const launches: Array<ReadonlyArray<string>> = [];
    const spawner = ChildProcessSpawner.make((command) => {
      const args = ChildProcess.isStandardCommand(command) ? command.args.map(String) : [];
      if (!args.includes("--version")) launches.push(args);
      if (args.includes("--no-extensions")) return extensionFree.spawner.spawn(command);
      if (!args.includes("--no-approve")) {
        // A project-trust dialog Pi cannot show over RPC: it exits without answering.
        return Effect.succeed(
          ChildProcessSpawner.makeHandle({
            pid: ChildProcessSpawner.ProcessId(999_999_999),
            exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
            isRunning: Effect.succeed(false),
            kill: () => Effect.void,
            unref: Effect.succeed(Effect.void),
            stdin: Sink.drain,
            stdout: Stream.empty,
            stderr: Stream.empty,
            all: Stream.empty,
            getInputFd: () => Sink.drain,
            getOutputFd: () => Stream.empty,
          }),
        );
      }
      return withExtensions.spawner.spawn(command);
    });

    const result = yield* generateWithModel("demo/demo-model", spawner);

    assert.equal(result.subject, "Update README");
    assert.equal(launches.length, 3);
    assert.include(launches[2] ?? [], "--no-approve");
    assert.notInclude(launches[2] ?? [], "--no-extensions");
    assert.equal(
      withExtensions.received.find((record) => record["type"] === "set_model")?.["modelId"],
      "demo-model",
    );
  }),
);

it.effect("fails with Pi's reason, without falling back, for a model no launch can load", () =>
  Effect.gen(function* () {
    const extensionFree = yield* makeFakePi("");
    const withExtensions = yield* makeFakePi("", "Model not found: demo/demo-model");
    const routed = makeRoutedPi({ extensionFree, withExtensions });

    const error = yield* generateWithModel("demo/demo-model", routed.spawner).pipe(Effect.flip);

    assert.equal(error._tag, "TextGenerationError");
    assert.include(error.detail, "Pi rejected model 'demo/demo-model'");
    assert.include(error.detail, "Model not found: demo/demo-model");
    assert.notInclude(error.detail, "--no-extensions");
    assert.isUndefined(withExtensions.received.find((record) => record["type"] === "prompt"));
  }),
);

it.effect("selects the provider and id Pi reported when the provider contains a slash", () =>
  Effect.gen(function* () {
    const provider = "llama-server=http://127.0.0.1:8080";
    const pi = yield* makeFakePi(
      JSON.stringify({ subject: "Update README", body: "" }),
      undefined,
      [],
      [{ provider, id: "qwen3" }],
    );
    const textGeneration = yield* makePiTextGeneration(
      {
        enabled: true,
        binaryPath: "pi",
        launchArgs: "",
        customModels: [],
        autoCompactWindow: "",
        memoryModel: "",
      },
      {},
    ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, pi.spawner));

    yield* textGeneration.generateCommitMessage({
      cwd: process.cwd(),
      branch: "main",
      stagedSummary: "M README.md",
      stagedPatch: "diff --git a/README.md b/README.md",
      modelSelection: createModelSelection(ProviderInstanceId.make("pi"), `${provider}/qwen3`),
    });

    const setModel = pi.received.find((record) => record["type"] === "set_model");
    assert.deepEqual(
      { provider: setModel?.["provider"], modelId: setModel?.["modelId"] },
      { provider, modelId: "qwen3" },
    );
  }),
);

const failedTurnWith = (errorMessage: string) => ({
  type: "message_end",
  message: { role: "assistant", stopReason: "error", errorMessage },
});

const failedTurn = failedTurnWith(
  '401: {"error":{"message":"Incorrect API key provided: sk-test-SECRET123"}}',
);

const generateCommitMessage = (turnEvents: ReadonlyArray<Record<string, unknown>>, reply = "") =>
  Effect.gen(function* () {
    const pi = yield* makeFakePi(reply, undefined, turnEvents);
    const textGeneration = yield* makePiTextGeneration(
      {
        enabled: true,
        binaryPath: "pi",
        launchArgs: "",
        customModels: [],
        autoCompactWindow: "",
        memoryModel: "",
      },
      {},
    ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, pi.spawner));
    return yield* textGeneration.generateCommitMessage({
      cwd: process.cwd(),
      branch: "main",
      stagedSummary: "M README.md",
      stagedPatch: "diff --git a/README.md b/README.md",
      modelSelection: createModelSelection(ProviderInstanceId.make("pi"), "default"),
    });
  });

it.effect("reports Pi's turn error when the reply is empty", () =>
  Effect.gen(function* () {
    const error = yield* generateCommitMessage([failedTurn]).pipe(Effect.flip);

    assert.equal(error._tag, "TextGenerationError");
    assert.equal(error.detail, "Pi could not generate text: the model provider returned HTTP 401.");
  }),
);

it.effect("keeps Pi's raw error text out of the error", () =>
  Effect.gen(function* () {
    const error = yield* generateCommitMessage([
      failedTurnWith("Invalid API key sk-test-SECRET123"),
    ]).pipe(Effect.flip);

    assert.equal(error.detail, "Pi could not generate text: the model provider reported an error.");
    assert.notInclude(error.message, "SECRET123");
  }),
);

it.effect("keeps the reply when Pi answers after a failed attempt", () =>
  Effect.gen(function* () {
    const result = yield* generateCommitMessage(
      [failedTurn, { type: "message_end", message: { role: "assistant", stopReason: "stop" } }],
      JSON.stringify({ subject: "Update README", body: "" }),
    );

    assert.equal(result.subject, "Update README");
  }),
);

it.effect("drops an earlier error once a later attempt succeeds", () =>
  Effect.gen(function* () {
    const error = yield* generateCommitMessage([
      failedTurn,
      { type: "message_end", message: { role: "assistant", stopReason: "stop" } },
    ]).pipe(Effect.flip);

    assert.equal(error.detail, "Pi returned empty output.");
  }),
);

it.effect.each([
  { model: "demo/demo-model", thinking: "off", expected: "off", version: "1.0.4" },
  { model: "demo/demo-model", thinking: "max", expected: "max", version: "1.4.0" },
  { model: "demo/demo-model", thinking: "invalid", expected: undefined, version: "1.0.4" },
  { model: "demo/demo-model", thinking: undefined, expected: undefined, version: "1.0.4" },
  { model: "default", thinking: "off", expected: "off", version: "1.0.4" },
  { model: "demo/demo-model", thinking: "low", expected: undefined, version: "1.0.3" },
])(
  "handles thinking=$thinking for $model on Pi $version",
  ({ model, thinking, expected, version }) =>
    Effect.gen(function* () {
      const pi = yield* makeFakePi(
        JSON.stringify({ subject: "Update README", body: "" }),
        undefined,
        [],
        [{ provider: "demo", id: "demo-model" }],
        version,
      );
      const textGeneration = yield* makePiTextGeneration(
        {
          enabled: true,
          binaryPath: "pi",
          launchArgs: "",
          customModels: [],
          autoCompactWindow: "",
          memoryModel: "",
        },
        {},
        (_driver, detected) =>
          Effect.succeed(
            detected === "1.0.3"
              ? {
                  status: "broken" as const,
                  message: null,
                  recommendedVersion: null,
                  recommendedRange: ">=1.0.0",
                }
              : undefined,
          ),
      ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, pi.spawner));

      const generation = textGeneration.generateCommitMessage({
        cwd: process.cwd(),
        branch: "main",
        stagedSummary: "M README.md",
        stagedPatch: "diff --git a/README.md b/README.md",
        modelSelection: createModelSelection(
          ProviderInstanceId.make("pi"),
          model,
          thinking === undefined ? [] : [{ id: "thinking", value: thinking }],
        ),
      });
      if (version === "1.0.3") {
        const error = yield* generation.pipe(Effect.flip);
        assert.include(error.detail, "Pi 1.0.3 does not work");
        assert.deepEqual(pi.received, []);
        return;
      }
      const result = yield* generation;

      assert.equal(result.subject, "Update README");
      assert.deepEqual(
        pi.received.map((record) => record["type"]),
        [
          ...(model === "default" ? ["get_state"] : ["get_available_models", "set_model"]),
          ...(expected === undefined ? [] : ["set_thinking_level"]),
          "prompt",
          "get_last_assistant_text",
        ],
      );
      assert.equal(
        pi.received.find((record) => record["type"] === "set_thinking_level")?.["level"],
        expected,
      );
    }),
);

it.effect("generates at Pi's default level when Pi rejects the saved thinking level", () =>
  Effect.gen(function* () {
    const pi = yield* makeFakePi(
      JSON.stringify({ subject: "Update README", body: "" }),
      undefined,
      [],
      [{ provider: "demo", id: "demo-model" }],
      "1.4.0",
      'Thinking level "max" is not supported by demo/demo-model',
    );
    const textGeneration = yield* makePiTextGeneration(
      {
        enabled: true,
        binaryPath: "pi",
        launchArgs: "",
        customModels: [],
        autoCompactWindow: "",
        memoryModel: "",
      },
      {},
    ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, pi.spawner));

    const result = yield* textGeneration.generateCommitMessage({
      cwd: process.cwd(),
      branch: "main",
      stagedSummary: "M README.md",
      stagedPatch: "diff --git a/README.md b/README.md",
      modelSelection: createModelSelection(ProviderInstanceId.make("pi"), "demo/demo-model", [
        { id: "thinking", value: "max" },
      ]),
    });

    assert.equal(result.subject, "Update README");
    assert.deepEqual(
      pi.received.map((record) => record["type"]),
      [
        "get_available_models",
        "set_model",
        "set_thinking_level",
        "prompt",
        "get_last_assistant_text",
      ],
    );
  }),
);
