import {
  type EnvironmentId,
  OrchestratorMcpFailure,
  type ServerSettings,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Environment from "../../../environment/ServerEnvironment.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as UnattendedReactor from "../../../orchestration-v2/UnattendedReactor.ts";
import * as PeerEnvironments from "../../../peers/PeerEnvironments.ts";
import * as Settings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { readCaller, unavailable } from "../../threadAccess.ts";
import { EnvironmentToolkit } from "./tools.ts";

export function preferences(settings: ServerSettings) {
  const {
    defaultThreadEnvMode,
    newWorktreesStartFromOrigin,
    enableProviderUpdateChecks,
    backgroundActivity,
    sourceControlWritingStyle,
  } = settings;
  const characters = Array.from(sourceControlWritingStyle.customInstructions);
  return {
    defaultThreadEnvMode,
    newWorktreesStartFromOrigin,
    enableProviderUpdateChecks,
    backgroundActivity: { profile: backgroundActivity.profile },
    sourceControlWritingStyle: {
      ...sourceControlWritingStyle,
      customInstructions: characters.slice(0, 4000).join(""),
      truncated: characters.length > 4000,
    },
  };
}
const access = Effect.gen(function* () {
  const context = yield* readCaller();
  const environment = yield* Environment.ServerEnvironment;
  const descriptor = yield* environment.getDescriptor;
  if (descriptor.environmentId !== context.scope.environmentId)
    return yield* new OrchestratorMcpFailure({
      code: "capability_denied",
      message: "This credential belongs to another environment.",
    });
  return { ...context, descriptor, settings: yield* Settings.ServerSettingsService };
});
interface AwayResult {
  readonly environmentId: EnvironmentId;
  readonly away: boolean | null;
  readonly error?: string;
}

export const layer = McpToolAccess.toLayer(EnvironmentToolkit, {
  t3_environment_read: McpToolAccess.reads(() =>
    Effect.gen(function* () {
      const { descriptor, settings } = yield* access;
      const current = yield* settings.getSettings.pipe(Effect.mapError(unavailable));
      return {
        environmentId: descriptor.environmentId,
        label: descriptor.label,
        serverVersion: descriptor.serverVersion,
        platform: descriptor.platform,
        away: current.away,
        preferences: preferences(current),
      };
    }),
  ),
  t3_environment_preferences_update: McpToolAccess.writesEnvironment((patch, check) =>
    Effect.gen(function* () {
      const scope = yield* McpInvocationContext.McpInvocationContext;
      const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
      const update = Effect.gen(function* () {
        // The turn may have ended, or the thread's modes changed, while this waited for the lock.
        yield* check;
        const { settings } = yield* access;
        return preferences(
          yield* settings.updateSettings(patch).pipe(Effect.mapError(unavailable)),
        );
      });
      return yield* scope.thread === undefined
        ? update
        : executor.withLock(scope.thread.threadId, update);
    }),
  ),
  t3_environment_set_away: McpToolAccess.setsAway(({ away }, fromPeer) =>
    Effect.gen(function* () {
      const { descriptor } = yield* access;
      const here = descriptor.environmentId;
      const reactor = yield* UnattendedReactor.UnattendedReactor;
      const peers = yield* PeerEnvironments.PeerEnvironments;
      // One hop only: a linked environment's call sets Away here, never onward.
      const linked = fromPeer
        ? []
        : yield* peers.linked.pipe(
            Effect.map((environments) => environments.map(({ environmentId }) => environmentId)),
            Effect.mapError(unavailable),
          );
      const environments = yield* Effect.forEach(
        [here, ...linked.filter((environmentId) => environmentId !== here)],
        (environmentId): Effect.Effect<AwayResult, OrchestratorMcpFailure> =>
          environmentId === here
            ? reactor.setAway(away).pipe(
                Effect.mapError(unavailable),
                Effect.map((settings) => ({ environmentId, away: settings.away })),
              )
            : peers
                .callTool({ environmentId, name: "t3_environment_set_away", arguments: { away } })
                .pipe(
                  Effect.map((result) =>
                    result.isError
                      ? { environmentId, away: null, error: result.text }
                      : { environmentId, away },
                  ),
                  Effect.catchTags({
                    PeerCallError: (error) =>
                      Effect.succeed({ environmentId, away: null, error: error.message }),
                    PeerEnvironmentError: (error) =>
                      Effect.succeed({ environmentId, away: null, error: error.reason }),
                  }),
                ),
        { concurrency: 4 },
      );
      return { environments };
    }),
  ),
});
