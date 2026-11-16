import type { ProviderInstanceId } from "@t3tools/contracts";
import * as Arr from "effect/Array";
import * as Order from "effect/Order";

export interface ModelSlugItem {
  readonly slug: string;
}

export interface ProviderModelItem extends ModelSlugItem {
  readonly instanceId: ProviderInstanceId;
}

export function providerModelKey(instanceId: ProviderInstanceId, slug: string): string {
  return `${instanceId}:${slug}`;
}

function rankByValue(values: ReadonlyArray<string>): ReadonlyMap<string, number> {
  return new Map(Arr.map(values, (value, index) => [value, index] as const));
}

function toSet(
  values: ReadonlySet<string> | ReadonlyArray<string> | undefined,
): ReadonlySet<string> {
  return values instanceof Set ? values : new Set(values ?? []);
}

function byOptionalRank<T>(rank: (item: T) => number | undefined): Order.Order<T> {
  return Order.mapInput(Order.Number, (item: T) => rank(item) ?? Number.POSITIVE_INFINITY);
}

function byTrueFirst<T>(predicate: (item: T) => boolean): Order.Order<T> {
  return Order.mapInput(Order.flip(Order.Boolean), predicate);
}

export function sortModelsForProviderInstance<T extends ModelSlugItem>(
  models: ReadonlyArray<T>,
  options?: {
    readonly modelOrder?: ReadonlyArray<string>;
    readonly favoriteModels?: ReadonlySet<string> | ReadonlyArray<string>;
    readonly groupFavorites?: boolean;
  },
): T[] {
  const modelOrder = options?.modelOrder ?? [];
  const favoriteModels = toSet(options?.favoriteModels);
  const orderBySlug = rankByValue(modelOrder);
  const originalOrder = rankByValue(Arr.map(models, (model) => model.slug));
  const orders: Array<Order.Order<T>> = [
    ...(options?.groupFavorites === true
      ? [byTrueFirst<T>((model) => favoriteModels.has(model.slug))]
      : []),
    byOptionalRank((model) => orderBySlug.get(model.slug)),
    byOptionalRank((model) => originalOrder.get(model.slug)),
  ];

  return Arr.sort(models, Order.combineAll(orders));
}

export function sortProviderModelItems<T extends ProviderModelItem>(
  items: ReadonlyArray<T>,
  options?: {
    readonly favoriteModelKeys?: ReadonlySet<string> | ReadonlyArray<string>;
    readonly groupFavorites?: boolean;
    /** Provider model keys in the order to list them; unlisted items keep their order after. */
    readonly keyOrder?: ReadonlyArray<string>;
  },
): T[] {
  const favoriteModelKeys = toSet(options?.favoriteModelKeys);
  const keyOrder = rankByValue(options?.keyOrder ?? []);
  const originalOrder = rankByValue(
    Arr.map(items, (item) => providerModelKey(item.instanceId, item.slug)),
  );
  const orders: Array<Order.Order<T>> = [
    ...(options?.groupFavorites === true
      ? [
          byTrueFirst<T>((item) =>
            favoriteModelKeys.has(providerModelKey(item.instanceId, item.slug)),
          ),
        ]
      : []),
    byOptionalRank((item) => keyOrder.get(providerModelKey(item.instanceId, item.slug))),
    byOptionalRank((item) => originalOrder.get(providerModelKey(item.instanceId, item.slug))),
  ];

  return Arr.sort(items, Order.combineAll(orders));
}

export interface ModelFavoriteItem {
  readonly provider: ProviderInstanceId;
  readonly model: string;
}

/**
 * Moves the favourite `key` to the place `targetKey` holds, shifting the ones between. The
 * favourites' order is the Favorites tab's and the composer's, so a drag or Alt+Arrow sets both.
 * Null when either key is not a favourite or nothing would move.
 */
export function moveFavorite<T extends ModelFavoriteItem>(
  favorites: ReadonlyArray<T>,
  key: string,
  targetKey: string,
): T[] | null {
  const keyOf = (favorite: T) => providerModelKey(favorite.provider, favorite.model);
  const from = favorites.findIndex((favorite) => keyOf(favorite) === key);
  const to = favorites.findIndex((favorite) => keyOf(favorite) === targetKey);
  if (from === -1 || to === -1 || from === to) return null;
  const next = [...favorites];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved!);
  return next;
}
