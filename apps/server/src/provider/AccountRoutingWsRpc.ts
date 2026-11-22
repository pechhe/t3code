import { WS_METHODS, WsAccountRoutingRpcGroup } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { RpcInstrumentation } from "../observability/RpcInstrumentation.ts";
import * as AccountAvailability from "./AccountAvailability.ts";

const ServerWsAccountRoutingRpcGroup = WsAccountRoutingRpcGroup.middleware(RpcInstrumentation);

/** Model routing's runtime blocks (fork/differences.md `account-pools`), one handler per method. */
export const layerWsAccountRoutingRpc = ServerWsAccountRoutingRpcGroup.toLayer(
  Effect.gen(function* () {
    const availability = yield* AccountAvailability.AccountAvailability;
    return ServerWsAccountRoutingRpcGroup.of({
      [WS_METHODS.accountRoutingSubscribe]: () => availability.changes,
      [WS_METHODS.accountRoutingClear]: (input) => availability.clear(input),
    });
  }),
);
