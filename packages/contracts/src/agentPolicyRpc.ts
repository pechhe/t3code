import * as Rpc from "effect/rpc/Rpc";
import * as Schema from "effect/Schema";

import {
  AgentPolicyCompactionModel,
  AgentPolicySaveInput,
  AgentPolicySettings,
  AgentPolicySettingsError,
} from "./agentPolicySettings.ts";
import { EnvironmentAuthorizationError } from "./auth.ts";

export const AGENT_POLICY_WS_METHODS = {
  agentPolicyRead: "agentPolicy.read",
  agentPolicySave: "agentPolicy.save",
  agentPolicyCompactionModel: "agentPolicy.compactionModel",
} as const;

export const WsAgentPolicyReadRpc = Rpc.make(AGENT_POLICY_WS_METHODS.agentPolicyRead, {
  payload: Schema.Struct({}),
  success: AgentPolicySettings,
  error: Schema.Union([EnvironmentAuthorizationError, AgentPolicySettingsError]),
});
export const WsAgentPolicyCompactionModelRpc = Rpc.make(
  AGENT_POLICY_WS_METHODS.agentPolicyCompactionModel,
  {
    payload: Schema.Struct({}),
    success: AgentPolicyCompactionModel,
    error: EnvironmentAuthorizationError,
  },
);
export const WsAgentPolicySaveRpc = Rpc.make(AGENT_POLICY_WS_METHODS.agentPolicySave, {
  payload: AgentPolicySaveInput,
  success: AgentPolicySettings,
  error: Schema.Union([EnvironmentAuthorizationError, AgentPolicySettingsError]),
});
