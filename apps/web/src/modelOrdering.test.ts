import { ProviderInstanceId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { moveFavorite, providerModelKey, sortProviderModelItems } from "./modelOrdering";

const codex = ProviderInstanceId.make("codex");
const claude = ProviderInstanceId.make("claude");
const favorite = (provider: ProviderInstanceId, model: string) => ({ provider, model });
const keyOf = (item: { provider: ProviderInstanceId; model: string }) =>
  providerModelKey(item.provider, item.model);

describe("moveFavorite", () => {
  const favorites = [
    favorite(codex, "a"),
    favorite(claude, "b"),
    favorite(codex, "c"),
    favorite(claude, "d"),
  ];

  it("moves a favourite down into the target's place", () => {
    expect(
      moveFavorite(favorites, providerModelKey(codex, "a"), providerModelKey(codex, "c"))?.map(
        keyOf,
      ),
    ).toEqual(["claude:b", "codex:c", "codex:a", "claude:d"]);
  });

  it("moves a favourite up into the target's place", () => {
    expect(
      moveFavorite(favorites, providerModelKey(claude, "d"), providerModelKey(claude, "b"))?.map(
        keyOf,
      ),
    ).toEqual(["codex:a", "claude:d", "claude:b", "codex:c"]);
  });

  it("returns null when nothing moves", () => {
    expect(moveFavorite(favorites, "codex:a", "codex:a")).toBeNull();
    expect(moveFavorite(favorites, "codex:gone", "codex:a")).toBeNull();
  });
});

describe("sortProviderModelItems", () => {
  it("lists items in the given key order, unlisted ones after", () => {
    const items = [
      { instanceId: codex, slug: "a" },
      { instanceId: claude, slug: "b" },
      { instanceId: codex, slug: "c" },
    ];
    expect(
      sortProviderModelItems(items, { keyOrder: ["codex:c", "codex:a"] }).map((item) => item.slug),
    ).toEqual(["c", "a", "b"]);
  });
});
