import { describe, expect, it } from "@effect/vitest";
import { vi } from "vite-plus/test";
import {
  AuthOrchestrationOperateScope,
  EnvironmentId,
  WS_METHODS,
  type AuthSessionState,
} from "@t3tools/contracts";

import * as Effect from "effect/Effect";

import * as Layer from "effect/Layer";

import { Atom, AtomRegistry, AsyncResult } from "effect/reactivity";
import { EnvironmentRegistry } from "../connection/registry.ts";
import { createCommandPermissions } from "./commandPermissions.ts";

vi.mock("./session.ts", () => ({
  createEnvironmentSessionAtoms: () => ({ sessionStateAtom: sessions }),
}));
const sessions = Atom.family((_id: EnvironmentId) =>
  Atom.make<AsyncResult.AsyncResult<AuthSessionState, string>>(AsyncResult.initial()),
);
const env = EnvironmentId.make("target");
const other = EnvironmentId.make("other");
const grant = (allowed: boolean): AuthSessionState => ({
  authenticated: true,
  auth: {
    policy: "remote-reachable",
    bootstrapMethods: [],
    sessionMethods: [],
    sessionCookieName: "test",
  },
  scopes: allowed ? [AuthOrchestrationOperateScope] : [],
  permissions: allowed ? [AuthOrchestrationOperateScope] : [],
});
const runtime = Atom.runtime(
  Layer.succeed(EnvironmentRegistry, {
    run: (_id: EnvironmentId, effect: Effect.Effect<unknown>) => effect,
  } as unknown as EnvironmentRegistry["Service"]),
);

const setup = Effect.gen(function* () {
  const registry = AtomRegistry.make();
  registry.mount(sessions(env));
  yield* Effect.addFinalizer(() => Effect.sync(() => registry.dispose()));
  return registry;
});

describe("command permissions", () => {
  it.effect.each([
    WS_METHODS.championsStartInvestigation,
    WS_METHODS.championsCancelInvestigation,
    WS_METHODS.championsUpsert,
    WS_METHODS.championsSetLifecycle,
    WS_METHODS.championsSetup,
    WS_METHODS.championsRunCheck,
    WS_METHODS.championsChangeMetrics,
    WS_METHODS.championsCancelSetup,
    WS_METHODS.championsStartMetricsLead,
    WS_METHODS.championsFindingAction,
  ])("authorizes champion mutations against the destination environment: %s", (method) =>
    Effect.scoped(
      Effect.gen(function* () {
        const registry = yield* setup;
        const command = createCommandPermissions(runtime, method);
        registry.set(sessions(env), AsyncResult.success(grant(true)));
        registry.set(sessions(other), AsyncResult.success(grant(false)));
        expect(registry.get(command.permissionAtom(env))).toBe(true);
        yield* command.authorize(registry, env);
        expect(registry.get(command.permissionAtom(other))).toBe(false);
        expect((yield* command.authorize(registry, other).pipe(Effect.flip))._tag).toBe(
          "EnvironmentAuthorizationError",
        );
      }),
    ),
  );
});
