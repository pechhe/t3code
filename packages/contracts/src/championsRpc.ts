import * as Rpc from "effect/rpc/Rpc";
import * as RpcGroup from "effect/rpc/RpcGroup";
import * as Schema from "effect/Schema";

import { EnvironmentAuthorizationError } from "./auth.ts";
import {
  ChampionLearningReadInput,
  ChampionLearningReadResult,
  ChampionLearningSearchInput,
  ChampionLearningSearchResult,
} from "./championLearnings.ts";
import {
  ChampionClassChoicesInput,
  ChampionClassChoicesResult,
  ChampionDetail,
  ChampionError,
  ChampionFindingActionInput,
  ChampionGetInput,
  ChampionHistoryInput,
  ChampionHistoryResult,
  ChampionInvestigation,
  ChampionInvestigationCancelInput,
  ChampionInvestigationStartInput,
  ChampionLearningQueryInput,
  ChampionLearningQueryResult,
  ChampionLifecycleInput,
  ChampionListInput,
  ChampionListResult,
  ChampionMetricChangeInput,
  ChampionMetricsLeadResult,
  ChampionRecommendation,
  ChampionRecommendationInput,
  ChampionRuntimeState,
  ChampionUpsertInput,
} from "./champions.ts";

export const CHAMPIONS_WS_METHODS = {
  championsClassChoices: "champions.classChoices",
  championsRuntimeState: "champions.runtimeState",
  championsRecommendation: "champions.recommendation",
  championsLearningQuery: "champions.learningQuery",
  championsLearningSearch: "champions.learningSearch",
  championsLearningRead: "champions.learningRead",
  championsStartInvestigation: "champions.startInvestigation",
  championsCancelInvestigation: "champions.cancelInvestigation",
  championsList: "champions.list",
  championsSubscribe: "champions.subscribe",
  championsGet: "champions.get",
  championsHistory: "champions.history",
  championsUpsert: "champions.upsert",
  championsSetLifecycle: "champions.setLifecycle",
  championsSetup: "champions.setup",
  championsRunCheck: "champions.runCheck",
  championsChangeMetrics: "champions.changeMetrics",
  championsCancelSetup: "champions.cancelSetup",
  championsStartMetricsLead: "champions.startMetricsLead",
  championsFindingAction: "champions.findingAction",
} as const;

const WsChampionsClassChoicesRpc = Rpc.make(CHAMPIONS_WS_METHODS.championsClassChoices, {
  payload: ChampionClassChoicesInput,
  success: ChampionClassChoicesResult,
  error: Schema.Union([ChampionError, EnvironmentAuthorizationError]),
});
const WsChampionsRecommendationRpc = Rpc.make(CHAMPIONS_WS_METHODS.championsRecommendation, {
  payload: ChampionRecommendationInput,
  success: ChampionRecommendation,
  error: Schema.Union([ChampionError, EnvironmentAuthorizationError]),
});
const WsChampionsRuntimeStateRpc = Rpc.make(CHAMPIONS_WS_METHODS.championsRuntimeState, {
  payload: ChampionGetInput,
  success: ChampionRuntimeState,
  error: Schema.Union([ChampionError, EnvironmentAuthorizationError]),
});
const WsChampionsLearningQueryRpc = Rpc.make(CHAMPIONS_WS_METHODS.championsLearningQuery, {
  payload: ChampionLearningQueryInput,
  success: ChampionLearningQueryResult,
  error: Schema.Union([ChampionError, EnvironmentAuthorizationError]),
});
const WsChampionsLearningSearchRpc = Rpc.make(CHAMPIONS_WS_METHODS.championsLearningSearch, {
  payload: ChampionLearningSearchInput,
  success: ChampionLearningSearchResult,
  error: Schema.Union([ChampionError, EnvironmentAuthorizationError]),
});
const WsChampionsLearningReadRpc = Rpc.make(CHAMPIONS_WS_METHODS.championsLearningRead, {
  payload: ChampionLearningReadInput,
  success: ChampionLearningReadResult,
  error: Schema.Union([ChampionError, EnvironmentAuthorizationError]),
});
const WsChampionsStartInvestigationRpc = Rpc.make(
  CHAMPIONS_WS_METHODS.championsStartInvestigation,
  {
    payload: ChampionInvestigationStartInput,
    success: ChampionInvestigation,
    error: Schema.Union([ChampionError, EnvironmentAuthorizationError]),
  },
);
const WsChampionsCancelInvestigationRpc = Rpc.make(
  CHAMPIONS_WS_METHODS.championsCancelInvestigation,
  {
    payload: ChampionInvestigationCancelInput,
    success: ChampionInvestigation,
    error: Schema.Union([ChampionError, EnvironmentAuthorizationError]),
  },
);
const WsChampionsListRpc = Rpc.make(CHAMPIONS_WS_METHODS.championsList, {
  payload: ChampionListInput,
  success: ChampionListResult,
  error: Schema.Union([ChampionError, EnvironmentAuthorizationError]),
});
const WsChampionsSubscribeRpc = Rpc.make(CHAMPIONS_WS_METHODS.championsSubscribe, {
  payload: ChampionListInput,
  success: ChampionListResult,
  error: Schema.Union([ChampionError, EnvironmentAuthorizationError]),
  stream: true,
});
const WsChampionsGetRpc = Rpc.make(CHAMPIONS_WS_METHODS.championsGet, {
  payload: ChampionGetInput,
  success: ChampionDetail,
  error: Schema.Union([ChampionError, EnvironmentAuthorizationError]),
});
const WsChampionsHistoryRpc = Rpc.make(CHAMPIONS_WS_METHODS.championsHistory, {
  payload: ChampionHistoryInput,
  success: ChampionHistoryResult,
  error: Schema.Union([ChampionError, EnvironmentAuthorizationError]),
});
const WsChampionsUpsertRpc = Rpc.make(CHAMPIONS_WS_METHODS.championsUpsert, {
  payload: ChampionUpsertInput,
  success: ChampionDetail,
  error: Schema.Union([ChampionError, EnvironmentAuthorizationError]),
});
const WsChampionsSetLifecycleRpc = Rpc.make(CHAMPIONS_WS_METHODS.championsSetLifecycle, {
  payload: ChampionLifecycleInput,
  success: ChampionDetail,
  error: Schema.Union([ChampionError, EnvironmentAuthorizationError]),
});
const WsChampionsSetupRpc = Rpc.make(CHAMPIONS_WS_METHODS.championsSetup, {
  payload: ChampionGetInput,
  success: ChampionDetail,
  error: Schema.Union([ChampionError, EnvironmentAuthorizationError]),
});
const WsChampionsRunCheckRpc = Rpc.make(CHAMPIONS_WS_METHODS.championsRunCheck, {
  payload: ChampionGetInput,
  success: ChampionDetail,
  error: Schema.Union([ChampionError, EnvironmentAuthorizationError]),
});
const WsChampionsChangeMetricsRpc = Rpc.make(CHAMPIONS_WS_METHODS.championsChangeMetrics, {
  payload: ChampionMetricChangeInput,
  success: ChampionDetail,
  error: Schema.Union([ChampionError, EnvironmentAuthorizationError]),
});
const WsChampionsCancelSetupRpc = Rpc.make(CHAMPIONS_WS_METHODS.championsCancelSetup, {
  payload: ChampionGetInput,
  success: ChampionDetail,
  error: Schema.Union([ChampionError, EnvironmentAuthorizationError]),
});
const WsChampionsStartMetricsLeadRpc = Rpc.make(CHAMPIONS_WS_METHODS.championsStartMetricsLead, {
  payload: ChampionGetInput,
  success: ChampionMetricsLeadResult,
  error: Schema.Union([ChampionError, EnvironmentAuthorizationError]),
});
const WsChampionsFindingActionRpc = Rpc.make(CHAMPIONS_WS_METHODS.championsFindingAction, {
  payload: ChampionFindingActionInput,
  success: ChampionDetail,
  error: Schema.Union([ChampionError, EnvironmentAuthorizationError]),
});

export const WsChampionsRpcs = RpcGroup.make(
  WsChampionsClassChoicesRpc,
  WsChampionsRuntimeStateRpc,
  WsChampionsRecommendationRpc,
  WsChampionsLearningQueryRpc,
  WsChampionsLearningSearchRpc,
  WsChampionsLearningReadRpc,
  WsChampionsStartInvestigationRpc,
  WsChampionsCancelInvestigationRpc,

  WsChampionsListRpc,
  WsChampionsSubscribeRpc,
  WsChampionsGetRpc,
  WsChampionsHistoryRpc,
  WsChampionsUpsertRpc,
  WsChampionsSetLifecycleRpc,
  WsChampionsSetupRpc,
  WsChampionsRunCheckRpc,
  WsChampionsChangeMetricsRpc,
  WsChampionsCancelSetupRpc,
  WsChampionsStartMetricsLeadRpc,
  WsChampionsFindingActionRpc,
);
