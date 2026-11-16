/** The composer slider's favourite detents, before its overflow detent. */
export const FAVORITE_SLOTS = 3;

/**
 * The first `limit` favourites the provider still supplies. A withdrawn or hidden model drops off
 * the slider instead of parking there under its raw id, and a later favourite takes its slot, as
 * the full picker lists only favourites it can resolve.
 */
export function resolveFavoriteSlots<Favorite, Slot>(
  favorites: ReadonlyArray<Favorite>,
  resolve: (favorite: Favorite) => Slot | null,
  limit: number,
): Slot[] {
  const slots: Slot[] = [];
  for (const favorite of favorites) {
    if (slots.length === limit) break;
    const slot = resolve(favorite);
    if (slot !== null) slots.push(slot);
  }
  return slots;
}
