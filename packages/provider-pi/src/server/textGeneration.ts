import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schema from "effect/Schema";
import * as ChildProcessSpawner from "effect/process/ChildProcessSpawner";

import { ProviderDriverKind, TextGenerationError } from "@t3tools/contracts";
import { getModelSelectionStringOptionValue } from "@t3tools/shared/model";
import {
  brokenVersionDetail,
  noCompatibilityPolicy,
  type ProviderCompatibilityLookup,
} from "@t3tools/provider-core/server/compatibility";
import { parseGenericCliVersion } from "@t3tools/provider-core/server/snapshotProbe";
import type { PiSettings } from "../settings.ts";

import {
  findReportedPiModel,
  makePiRpcConnection,
  piRecordField,
  piRecordString,
  resolvePiModelSlug,
} from "./rpc.ts";
import {
  buildPiRpcLaunch,
  PI_PROJECT_TRUST_ARGUMENTS,
  resolvePiLaunchArgs,
} from "./mcpInjection.ts";
import * as TextGenerationOperations from "@t3tools/provider-core/server/textGenerationOperations";
import { isPiThinkingLevel } from "./modelCapabilities.ts";
import { runPiVersionCommand } from "./status.ts";

const PI_TIMEOUT_MS = 180_000;

const isTextGenerationError = Schema.is(TextGenerationError);

// Pi's `errorMessage` is the provider's raw response text and can echo
// credentials, so only a leading HTTP status reaches the error detail.
const piTurnErrorDetail = (errorMessage: string | undefined) => {
  const status = errorMessage?.match(/^([45]\d\d)\b/)?.[1];
  return status === undefined
    ? "Pi could not generate text: the model provider reported an error."
    : `Pi could not generate text: the model provider returned HTTP ${status}.`;
};

export const makePiTextGeneration = Effect.fn("makePiTextGeneration")(function* (
  piSettings: PiSettings,
  environment: NodeJS.ProcessEnv = process.env,
  compatibility: ProviderCompatibilityLookup = noCompatibilityPolicy,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;

  const runPiJson: TextGenerationOperations.Runner = Effect.fn("PiTextGeneration.runPiJson")(
    function* (request) {
      const { operation, cwd, prompt, modelSelection } = request;
      const thinking = getModelSelectionStringOptionValue(modelSelection, "thinking");
      if (thinking !== undefined && isPiThinkingLevel(thinking)) {
        const output = yield* runPiVersionCommand(piSettings, environment, cwd).pipe(
          Effect.timeoutOption(4_000),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
        );
        const version =
          Option.isSome(output) && output.value.code === 0
            ? parseGenericCliVersion(`${output.value.stdout}\n${output.value.stderr}`)
            : null;
        const broken =
          version === null
            ? "T3 Code could not determine the Pi version. Update Pi and try again."
            : brokenVersionDetail({
                name: "Pi",
                version,
                advisory: yield* compatibility(ProviderDriverKind.make("pi"), version),
              });
        if (broken !== undefined) {
          return yield* new TextGenerationError({ operation, detail: broken });
        }
      }

      const resolvedLaunchArgs = resolvePiLaunchArgs(piSettings.launchArgs);
      if (!resolvedLaunchArgs.ok) {
        return yield* new TextGenerationError({
          operation,
          detail: resolvedLaunchArgs.message,
        });
      }
      // The no-extensions launch is the fast path. A model that an extension or package registers
      // is missing from its inventory, so that one generation relaunches with extensions loaded.
      const launchPi = (withExtensions: boolean, extraArgs: ReadonlyArray<string> = []) => {
        const launch = buildPiRpcLaunch({
          launchArgs: [...resolvedLaunchArgs.args, ...extraArgs],
          environment,
          mcpSession: undefined,
          extensionPath: undefined,
          ephemeral: true,
          shortLived: true,
          disableExtensions: !withExtensions,
          // Background naming/content helpers must never mutate the workspace.
          disableTools: true,
          disableMcp: true,
        });
        return makePiRpcConnection({
          command: piSettings.binaryPath || "pi",
          args: launch.args,
          cwd,
          env: launch.env,
        }).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
      };
      const readModels = (pi: Effect.Success<ReturnType<typeof launchPi>>) =>
        pi.request({ type: "get_available_models" });

      let connection = yield* launchPi(false);

      // "default" runs Pi's configured model, which an extension may register too.
      const wanted =
        modelSelection.model === "default"
          ? yield* connection.request({ type: "get_state" }).pipe(
              Effect.map((state) => {
                const model = piRecordField(state, "model");
                const provider = piRecordString(model, "provider");
                const id = piRecordString(model, "id");
                return provider !== undefined && id !== undefined ? `${provider}/${id}` : undefined;
              }),
              Effect.orElseSucceed(() => undefined),
            )
          : modelSelection.model;

      if (wanted !== undefined) {
        // Reject unusable custom slugs; silently using Pi's default would misreport the requested model.
        const inventory = yield* readModels(connection).pipe(Effect.orElseSucceed(() => undefined));
        let models = piRecordField(inventory, "models");
        if (findReportedPiModel(wanted, models) === undefined) {
          // Stop the extension-free process before starting its replacement.
          yield* connection.terminate;
          connection = yield* launchPi(true);
          // Provider names may contain "/", so the slug resolves against this launch's models.
          const relaunchInventory = yield* readModels(connection).pipe(
            Effect.map((data) => ({ data })),
            // Pi exits before answering when a startup dialog cannot be answered over RPC;
            // retry declining project trust unless the user chose a trust mode.
            Effect.catchIf(
              (error) =>
                error._tag === "PiRpcError" &&
                (error.operation === "read" || error.operation === "exit") &&
                !resolvedLaunchArgs.args.some((arg) => PI_PROJECT_TRUST_ARGUMENTS.has(arg)),
              () =>
                connection.terminate.pipe(
                  Effect.andThen(launchPi(true, ["--no-approve"])),
                  Effect.flatMap((retry) => {
                    connection = retry;
                    return readModels(retry).pipe(Effect.map((data) => ({ data })));
                  }),
                ),
            ),
            Effect.orElseSucceed(() => ({ data: undefined })),
          );
          models = piRecordField(relaunchInventory.data, "models");
        }
        const parsed = resolvePiModelSlug(wanted, models);
        if (parsed === null) {
          return yield* new TextGenerationError({
            operation,
            detail: `Pi model '${modelSelection.model}' must use provider/model format.`,
          });
        }
        if (modelSelection.model !== "default") {
          yield* connection
            .request({ type: "set_model", provider: parsed.provider, modelId: parsed.modelId })
            .pipe(
              Effect.mapError((error) =>
                error._tag === "PiRpcError" && error.operation === "set_model"
                  ? new TextGenerationError({
                      operation,
                      detail: `Pi rejected model '${modelSelection.model}': ${error.detail ?? "unknown error"}.`,
                      cause: error,
                    })
                  : error,
              ),
            );
        }
      }

      if (thinking !== undefined && isPiThinkingLevel(thinking)) {
        // Pi rejects xhigh/max for models without a thinkingLevelMap entry; a stale saved
        // level falls back to Pi's default instead of failing the whole generation.
        yield* connection
          .request({ type: "set_thinking_level", level: thinking })
          .pipe(Effect.catchTags({ PiRpcError: () => Effect.void }));
      }

      yield* connection.request({ type: "prompt", message: prompt });
      // Provider failures (bad key, rate limit, 5xx) arrive on the assistant
      // `message_end`. Keep only the latest, since Pi can retry and still answer.
      let turnError: string | undefined;
      yield* Effect.gen(function* () {
        while (true) {
          const event = yield* Queue.take(connection.events);
          if (event["type"] === "agent_settled") return;
          const message = event["message"];
          if (event["type"] === "message_end" && piRecordString(message, "role") === "assistant") {
            turnError =
              piRecordString(message, "stopReason") === "error"
                ? piTurnErrorDetail(piRecordString(message, "errorMessage"))
                : undefined;
          }
        }
      });
      const data = yield* connection.request({ type: "get_last_assistant_text" });
      const text =
        typeof data === "object" &&
        data !== null &&
        typeof (data as { text?: unknown }).text === "string"
          ? (data as { text: string }).text.trim()
          : "";
      if (!text) {
        return yield* new TextGenerationError({
          operation,
          detail: turnError ?? "Pi returned empty output.",
        });
      }
      return yield* TextGenerationOperations.decodeJsonReply(request, "Pi", text);
    },
    (effect, request) => {
      const { operation } = request;
      return effect.pipe(
        Effect.timeoutOption(PI_TIMEOUT_MS),
        Effect.flatMap(
          Option.match({
            onNone: () =>
              Effect.fail(new TextGenerationError({ operation, detail: "Pi request timed out." })),
            onSome: (value) => Effect.succeed(value),
          }),
        ),
        Effect.mapError((cause) =>
          isTextGenerationError(cause)
            ? cause
            : new TextGenerationError({
                operation,
                detail: "Pi text generation failed.",
                cause,
              }),
        ),
        Effect.scoped,
      );
    },
  );

  return TextGenerationOperations.fromRunner(
    "PiTextGeneration",
    TextGenerationOperations.withoutInvestigation("Pi", runPiJson),
  );
});
