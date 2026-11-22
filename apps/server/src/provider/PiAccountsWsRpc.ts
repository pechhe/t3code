import { WS_METHODS, WsPiAccountsRpcGroup } from "@t3tools/contracts";
import * as Effect from "effect/Effect";

import { RpcInstrumentation } from "../observability/RpcInstrumentation.ts";
import * as PiAccounts from "./PiAccountsService.ts";

const ServerWsPiAccountsRpcGroup = WsPiAccountsRpcGroup.middleware(RpcInstrumentation);

/** Settings → Accounts for Pi (fork/differences.md `pi-accounts`), one handler per method. */
export const layerWsPiAccountsRpc = ServerWsPiAccountsRpcGroup.toLayer(
  Effect.gen(function* () {
    const accounts = yield* PiAccounts.PiAccountsService;
    return ServerWsPiAccountsRpcGroup.of({
      [WS_METHODS.piAccountsList]: (input) => accounts.list(input),
      [WS_METHODS.piAccountsSaveKey]: (input) => accounts.saveKey(input),
      [WS_METHODS.piAccountsRemove]: (input) => accounts.remove(input),
      [WS_METHODS.piAccountsSeparate]: (input) => accounts.separate(input),
      [WS_METHODS.piAccountsLoginStart]: (input) => accounts.loginStart(input),
      [WS_METHODS.piAccountsLoginRespond]: (input) => accounts.loginRespond(input),
      [WS_METHODS.piAccountsLoginCancel]: (input) => accounts.loginCancel(input),
      [WS_METHODS.piAccountsLoginSubscribe]: (input) => accounts.loginSubscribe(input),
    });
  }),
);
