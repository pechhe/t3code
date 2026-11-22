import type { AccountId, PooledModelKey } from "@t3tools/contracts";
import type { PooledAccount, PooledModel, RoutingContext } from "@t3tools/shared/accountPools";

/**
 * Models served by several accounts, offered as one entry each. Choosing the entry lets T3 pick
 * the account by the model's route; choosing one of its accounts pins that account.
 */
export type ModelPickerPooling = {
  readonly models: ReadonlyArray<PooledModel>;
  /** The environment's runtime blocks, to show which accounts are held back. */
  readonly routing: RoutingContext;
  /** The pooled model the selection runs and its pinned account, null when it follows the route. */
  readonly active: {
    readonly key: PooledModelKey;
    readonly pinned: AccountId | null;
    /** The account the thread runs on now, when it has one. */
    readonly account?: AccountId;
  } | null;
  readonly onSelect: (model: PooledModel, account: PooledAccount | null) => void;
};
