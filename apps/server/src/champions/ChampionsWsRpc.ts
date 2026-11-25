import {
  WS_METHODS,
  WsChampionsRpcGroup,
  type OrchestrationV2ThreadShell,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { RpcInstrumentation } from "../observability/RpcInstrumentation.ts";
import { championThreadHiddenFromList } from "../orchestration-v2/ChampionThreadVisibility.ts";
import * as Champions from "./ChampionService.ts";

const ServerWsChampionsRpcGroup = WsChampionsRpcGroup.middleware(RpcInstrumentation);

/** The Champions RPC surface (fork/differences.md `champions`), one handler per method. */
export const layerWsChampionsRpc = ServerWsChampionsRpcGroup.toLayer(
  Effect.gen(function* () {
    const champions = yield* Champions.ChampionService;
    return ServerWsChampionsRpcGroup.of({
      [WS_METHODS.championsSetModels]: (input) => champions.setModels(input),
      [WS_METHODS.championsRuntimeState]: (input) => champions.runtimeState(input),
      [WS_METHODS.championsLearningQuery]: (input) => champions.learningQuery(input),
      [WS_METHODS.championsLearningSearch]: (input) => champions.learningSearch(input),
      [WS_METHODS.championsLearningRead]: (input) => champions.learningRead(input),
      [WS_METHODS.championsList]: (input) => champions.list(input),
      [WS_METHODS.championsSubscribe]: (input) => champions.subscribe(input),
      [WS_METHODS.championsGet]: (input) => champions.get(input),
      [WS_METHODS.championsHistory]: (input) => champions.history(input),
      [WS_METHODS.championsUpsert]: (input) => champions.upsert(input),
      [WS_METHODS.championsSetLifecycle]: (input) => champions.setLifecycle(input),
      [WS_METHODS.championsSetup]: (input) => champions.setup(input),
      [WS_METHODS.championsRunCheck]: (input) => champions.runCheck(input),
      [WS_METHODS.championsChangeMetrics]: (input) => champions.changeMetrics(input),
      [WS_METHODS.championsCancelSetup]: (input) => champions.cancelSetup(input),
      [WS_METHODS.championsStartMetricsLead]: (input) => champions.startMetricsLead(input),
      [WS_METHODS.championsFindingAction]: (input) => champions.findingAction(input),
    });
  }),
);

/**
 * A thread page as a client sees it: a client that has not opted in to Champion threads
 * (`CHAMPION_THREADS_CAPABILITY`) is not sent the ones hidden from lists.
 */
export const listableThreads =
  (championThreads: boolean) =>
  <T extends { readonly threads: ReadonlyArray<OrchestrationV2ThreadShell> }>(page: T): T =>
    championThreads
      ? page
      : {
          ...page,
          threads: page.threads.filter((thread) => !championThreadHiddenFromList(thread)),
        };
