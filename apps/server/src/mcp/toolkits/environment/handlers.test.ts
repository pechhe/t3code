import { expect, it } from "@effect/vitest";
import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderInstanceId,
  ThreadId,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Ref from "effect/Ref";
import * as Stream from "effect/Stream";

import * as Environment from "../../../environment/ServerEnvironment.ts";
import * as ThreadCommandExecutor from "../../../orchestration-v2/ThreadCommandExecutor.ts";
import * as ThreadManagement from "../../../orchestration-v2/ThreadManagementService.ts";
import * as UnattendedReactor from "../../../orchestration-v2/UnattendedReactor.ts";
import * as PeerEnvironments from "../../../peers/PeerEnvironments.ts";
import * as Settings from "../../../serverSettings.ts";
import * as McpInvocationContext from "../../McpInvocationContext.ts";
import * as McpToolAccess from "../../McpToolAccess.ts";
import { liveThreadShell } from "../../McpToolAccess.testkit.ts";
import * as EnvironmentHandlers from "./handlers.ts";
import { EnvironmentToolkit } from "./tools.ts";

const environmentId = EnvironmentId.make("environment:preferences");
const threadId = ThreadId.make("thread:preferences");

it.effect("refuses a preferences update when the caller's turn ends while it waits", () =>
  Effect.gen(function* () {
    const caller = yield* Ref.make<OrchestrationV2ThreadShell>(liveThreadShell(threadId));
    const updates = yield* Ref.make(0);
    const checked = yield* Deferred.make<void>();
    const layerDependencies = Layer.mergeAll(
      ThreadCommandExecutor.layer,
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId,
        requestNamespace: "provider:preferences",
        thread: {
          threadId,
          providerSessionId: "provider:preferences",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration" as const]),
        issuedAt: 0,
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: () =>
          Ref.get(caller).pipe(Effect.tap(() => Deferred.succeed(checked, undefined))),
      }),
      Layer.mock(Environment.ServerEnvironment)({
        getDescriptor: Effect.succeed({
          environmentId,
          label: "Test",
          platform: { os: "linux", arch: "x64" },
          serverVersion: "0.0.0",
          capabilities: { repositoryIdentity: false },
        }),
      }),
      Layer.mock(Settings.ServerSettingsService)({
        getSettings: Effect.succeed(DEFAULT_SERVER_SETTINGS),
        updateSettings: () =>
          Ref.update(updates, (count) => count + 1).pipe(Effect.as(DEFAULT_SERVER_SETTINGS)),
      }),
      Layer.mock(UnattendedReactor.UnattendedReactor)({}),
      Layer.mock(PeerEnvironments.PeerEnvironments)({
        linked: Effect.die("a peer's call must not reach on to linked environments"),
        callTool: () => Effect.die("a peer's call must not reach on to linked environments"),
      }),
    );
    yield* Effect.gen(function* () {
      const toolkit = yield* EnvironmentToolkit;
      const executor = yield* ThreadCommandExecutor.ThreadCommandExecutor;
      const held = yield* Deferred.make<void>();
      const release = yield* Deferred.make<void>();
      const holder = yield* executor
        .withLock(
          threadId,
          Deferred.succeed(held, undefined).pipe(Effect.andThen(Deferred.await(release))),
        )
        .pipe(Effect.forkChild);
      yield* Deferred.await(held);
      const update = yield* toolkit
        .handle("t3_environment_preferences_update", { newWorktreesStartFromOrigin: true })
        .pipe(Stream.unwrap, Stream.runCollect, Effect.forkChild);
      yield* Deferred.await(checked);
      yield* Ref.update(caller, (shell) => ({ ...shell, activeRunId: null }));
      yield* Deferred.succeed(release, undefined);
      yield* Fiber.join(holder);
      const result = yield* Fiber.join(update);
      expect(result.at(-1)?.result).toMatchObject({ code: "parent_not_active" });
      expect(yield* Ref.get(updates)).toBe(0);
    }).pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(EnvironmentHandlers.layer).pipe(
          Layer.provideMerge(layerDependencies),
        ),
      ),
    );
  }),
);

it.effect("lets an agent read Away and turn it on and off, here and on every linked machine", () =>
  Effect.gen(function* () {
    const away = yield* Ref.make(false);
    const peerCalls = yield* Ref.make<ReadonlyArray<unknown>>([]);
    const linked = EnvironmentId.make("environment:linked");
    const layerDependencies = Layer.mergeAll(
      ThreadCommandExecutor.layer,
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId,
        requestNamespace: "provider:away",
        thread: {
          threadId,
          providerSessionId: "provider:away",
          providerInstanceId: ProviderInstanceId.make("codex"),
        },
        client: undefined,
        capabilities: new Set(["orchestration" as const]),
        issuedAt: 0,
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({
        getThreadShell: () => Effect.succeed(liveThreadShell(threadId)),
      }),
      Layer.mock(Environment.ServerEnvironment)({
        getDescriptor: Effect.succeed({
          environmentId,
          label: "Test",
          platform: { os: "linux", arch: "x64" },
          serverVersion: "0.0.0",
          capabilities: { repositoryIdentity: false },
        }),
      }),
      Layer.mock(Settings.ServerSettingsService)({
        getSettings: Effect.map(Ref.get(away), (on) => ({
          ...DEFAULT_SERVER_SETTINGS,
          away: on,
        })),
      }),
      Layer.mock(UnattendedReactor.UnattendedReactor)({
        setAway: (next) =>
          Ref.set(away, next).pipe(Effect.as({ ...DEFAULT_SERVER_SETTINGS, away: next })),
      }),
      Layer.mock(PeerEnvironments.PeerEnvironments)({
        linked: Effect.succeed([{ environmentId: linked, label: "Mac" }]),
        callTool: (input) =>
          Ref.update(peerCalls, (calls) => [...calls, input]).pipe(
            Effect.as({ isError: false, structuredContent: undefined, text: "" }),
          ),
      }),
    );
    yield* Effect.gen(function* () {
      const toolkit = yield* EnvironmentToolkit;
      const call = <Name extends "t3_environment_read" | "t3_environment_set_away">(
        name: Name,
        params: Parameters<typeof toolkit.handle<Name>>[1],
      ) =>
        toolkit.handle(name, params).pipe(
          Stream.unwrap,
          Stream.runCollect,
          Effect.map((results) => results.at(-1)?.result),
        );
      expect(yield* call("t3_environment_set_away", { away: true })).toEqual({
        environments: [
          { environmentId, away: true },
          { environmentId: linked, away: true },
        ],
      });
      expect(yield* Ref.get(peerCalls)).toEqual([
        { environmentId: linked, name: "t3_environment_set_away", arguments: { away: true } },
      ]);
      expect(yield* call("t3_environment_read", {})).toMatchObject({ away: true });
      expect(yield* call("t3_environment_set_away", { away: false })).toEqual({
        environments: [
          { environmentId, away: false },
          { environmentId: linked, away: false },
        ],
      });
      expect(yield* Ref.get(away)).toBe(false);
    }).pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(EnvironmentHandlers.layer).pipe(
          Layer.provideMerge(layerDependencies),
        ),
      ),
    );
  }),
);

it.effect("a linked environment's call sets Away here, and reaches no further", () =>
  Effect.gen(function* () {
    const away = yield* Ref.make(false);
    const layerDependencies = Layer.mergeAll(
      Layer.succeed(McpInvocationContext.McpInvocationContext, {
        environmentId,
        requestNamespace: "peer:away",
        thread: undefined,
        client: { sessionId: "peer-session", label: "Mac", access: "peer-threads" },
        capabilities: new Set(["orchestration" as const]),
        issuedAt: 0,
      }),
      Layer.mock(ThreadManagement.ThreadManagementService)({}),
      Layer.mock(ThreadCommandExecutor.ThreadCommandExecutor)({}),
      Layer.mock(Environment.ServerEnvironment)({
        getDescriptor: Effect.succeed({
          environmentId,
          label: "Test",
          platform: { os: "linux", arch: "x64" },
          serverVersion: "0.0.0",
          capabilities: { repositoryIdentity: false },
        }),
      }),
      Layer.mock(Settings.ServerSettingsService)({}),
      Layer.mock(UnattendedReactor.UnattendedReactor)({
        setAway: (next) =>
          Ref.set(away, next).pipe(Effect.as({ ...DEFAULT_SERVER_SETTINGS, away: next })),
      }),
      Layer.mock(PeerEnvironments.PeerEnvironments)({
        linked: Effect.die("a peer's call must not reach on to linked environments"),
        callTool: () => Effect.die("a peer's call must not reach on to linked environments"),
      }),
    );
    yield* Effect.gen(function* () {
      const toolkit = yield* EnvironmentToolkit;
      const call = (params: { away: boolean }) =>
        toolkit.handle("t3_environment_set_away", params).pipe(
          Stream.unwrap,
          Stream.runCollect,
          Effect.map((results) => results.at(-1)?.result),
        );
      expect(yield* call({ away: true })).toEqual({
        environments: [{ environmentId, away: true }],
      });
      expect(yield* Ref.get(away)).toBe(true);
    }).pipe(
      Effect.provide(
        McpToolAccess.HandlersLayer.layer(EnvironmentHandlers.layer).pipe(
          Layer.provideMerge(layerDependencies),
        ),
      ),
    );
  }),
);
