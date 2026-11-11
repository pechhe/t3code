/**
 * The device model slider's favourite detents: the first `limit` favourites the
 * provider still supplies. A favourite whose model is no longer in the picker's
 * options (withdrawn upstream, or hidden in Settings) drops off the slider
 * instead of parking on it under its raw id, and a later favourite fills the
 * freed slot. Matches the full picker, which only lists favourites it can
 * resolve against supplied models.
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
