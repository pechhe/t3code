import {
  AuthOrchestrationOperateScope,
  AuthOrchestrationReadScope,
  AuthSettingsWriteScope,
} from "./auth.ts";
import { WS_METHODS } from "./rpc.ts";

/** Delegation settings, stance and champion methods the client guards by scope. */
export const DELEGATION_GUARDED_RPC_SCOPES = {
  [WS_METHODS.agentPolicySave]: AuthSettingsWriteScope,
  [WS_METHODS.delegationStanceResolve]: AuthOrchestrationReadScope,
  [WS_METHODS.championsUpsert]: AuthOrchestrationOperateScope,
  [WS_METHODS.championsSetModels]: AuthOrchestrationOperateScope,
  [WS_METHODS.championsSetLifecycle]: AuthOrchestrationOperateScope,
  [WS_METHODS.championsSetup]: AuthOrchestrationOperateScope,
  [WS_METHODS.championsRunCheck]: AuthOrchestrationOperateScope,
  [WS_METHODS.championsChangeMetrics]: AuthOrchestrationOperateScope,
  [WS_METHODS.championsCancelSetup]: AuthOrchestrationOperateScope,
  [WS_METHODS.championsStartMetricsLead]: AuthOrchestrationOperateScope,
  [WS_METHODS.championsFindingAction]: AuthOrchestrationOperateScope,
} as const;
