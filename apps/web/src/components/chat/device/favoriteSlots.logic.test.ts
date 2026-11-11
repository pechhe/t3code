import { describe, expect, it } from "vite-plus/test";

import { resolveFavoriteSlots } from "./favoriteSlots.logic";

const favorite = (model: string) => ({ provider: "pi", model });

describe("resolveFavoriteSlots", () => {
  const resolve = (favorite: { provider: string; model: string }) =>
    favorite.model === "gone" ? null : `slot:${favorite.model}`;

  it("keeps supplied favourites up to the limit, in order", () => {
    expect(
      resolveFavoriteSlots([favorite("a"), favorite("b"), favorite("c")], resolve, 2),
    ).toEqual(["slot:a", "slot:b"]);
  });

  it("drops a favourite whose model is no longer supplied instead of parking it", () => {
    expect(resolveFavoriteSlots([favorite("gone")], resolve, 4)).toEqual([]);
  });

  it("lets a later favourite fill the slot a withdrawn one freed", () => {
    expect(
      resolveFavoriteSlots([favorite("gone"), favorite("a"), favorite("b")], resolve, 2),
    ).toEqual(["slot:a", "slot:b"]);
  });

  it("stops asking once the limit is filled", () => {
    let asked = 0;
    resolveFavoriteSlots(
      [favorite("a"), favorite("b"), favorite("c")],
      (fav) => {
        asked += 1;
        return `slot:${fav.model}`;
      },
      2,
    );
    expect(asked).toBe(2);
  });
});
