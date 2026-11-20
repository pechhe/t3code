import {
  AuthSettingsWriteScope,
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  WS_METHODS,
  WsRpcGroup,
} from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import * as RpcTest from "effect/rpc/RpcTest";

import { RPC_REQUIRED_SCOPES, requiredScopeForRpcMethod } from "./RpcAuthorization.ts";
import * as RpcAuthorization from "./RpcAuthorization.ts";
import { snapshot as policySnapshot } from "../agents/agentPolicy.testkit.ts";

describe("RPC authorization scopes", () => {
  it("restricts policy reads and saves to settings owners", () => {
    for (const method of [
      WS_METHODS.agentPolicyRead,
      WS_METHODS.agentPolicySave,
      WS_METHODS.secretsSave,
      WS_METHODS.secretsReveal,
      WS_METHODS.secretsDelete,
      WS_METHODS.secretsAnswerSavedRequest,
      WS_METHODS.secretsListTemporary,
      WS_METHODS.secretsRemoveTemporary,
    ])
      expect(requiredScopeForRpcMethod(method)).toBe(AuthSettingsWriteScope);
  });

  it("lets only clients that may operate threads answer a release approval", () => {
    expect(requiredScopeForRpcMethod(WS_METHODS.releaseApprovalsAnswer)).toBe(
      AuthOrchestrationOperateScope,
    );
  });
});

describe("owner delegation settings boundary", () => {
  const tested = [WS_METHODS.agentPolicyRead, WS_METHODS.agentPolicySave] as const;
  const group = WsRpcGroup.omit(
    ...[...WsRpcGroup.requests.keys()].filter(
      (tag): tag is Exclude<keyof typeof RPC_REQUIRED_SCOPES, (typeof tested)[number]> =>
        !(tested as readonly string[]).includes(tag),
    ),
  );
  it.effect("operate permission cannot read or change owner policy", () =>
    Effect.gen(function* () {
      const handled: string[] = [];
      const reject = (method: string) =>
        Effect.sync(() => handled.push(method)).pipe(Effect.andThen(Effect.never));
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(WS_METHODS.agentPolicyRead, () => reject("read")),
            group.toLayerHandler(WS_METHODS.agentPolicySave, () => reject("save")),
            RpcAuthorization.layer([AuthOrchestrationReadScope, AuthOrchestrationOperateScope]),
          ),
        ),
      );
      const policy = policySnapshot();
      for (const effect of [
        client[WS_METHODS.agentPolicyRead]({}).pipe(Effect.asVoid),
        client[WS_METHODS.agentPolicySave]({
          expectedHash: policy.hash,
          manifest: policy.manifest,
        }).pipe(Effect.asVoid),
      ]) {
        expect(yield* effect.pipe(Effect.flip)).toMatchObject({
          _tag: "EnvironmentAuthorizationError",
          requiredPermission: AuthSettingsWriteScope,
        });
      }
      expect(handled).toEqual([]);
    }),
  );
  it.effect("an owner settings grant reaches the policy service", () =>
    Effect.gen(function* () {
      const response = {
        snapshot: policySnapshot(),
        sourceRoot: "/policy-fixture",
        uncommitted: false,
        providers: [],
      };
      const client = yield* RpcTest.makeClient(group).pipe(
        Effect.provide(
          Layer.mergeAll(
            group.toLayerHandler(WS_METHODS.agentPolicyRead, () => Effect.succeed(response)),
            group.toLayerHandler(WS_METHODS.agentPolicySave, () => Effect.succeed(response)),
            RpcAuthorization.layer([AuthSettingsWriteScope]),
          ),
        ),
      );
      expect(yield* client[WS_METHODS.agentPolicyRead]({})).toEqual(response);
    }),
  );
});
