import { describe, expect, it } from "vite-plus/test";
import { deriveProjectIdentity, weaveRepositoryKeyOf } from "./projectIdentity.ts";

describe("Weave repository keys", () => {
  const repositoryIdentity = {
    canonicalKey: "github.com/upstream/app",
    origin: { canonicalKey: "github.com/pechhe/app" },
    locator: {
      source: "git-remote" as const,
      remoteName: "upstream",
      remoteUrl: "https://github.com/upstream/app.git",
    },
  };
  it("uses the grouping identity, dropping only the host", () => {
    expect(weaveRepositoryKeyOf({ repositoryIdentity })).toBe("pechhe/app");
  });
  it("prefers an explicit link and returns to automatic matching when cleared", () => {
    expect(weaveRepositoryKeyOf({ repositoryIdentity, weaveRepositoryKey: "manual/app" })).toBe(
      "manual/app",
    );
    expect(weaveRepositoryKeyOf({ repositoryIdentity, weaveRepositoryKey: null })).toBe(
      "pechhe/app",
    );
    expect(weaveRepositoryKeyOf({})).toBeNull();
  });
});

describe("deriveProjectIdentity monogram", () => {
  it.each([
    ["YardSmith", "YS"],
    ["SlipJay", "SJ"],
    ["GitHub Actions", "GA"],
    ["Splay", "SY"],
    ["T3Code", "T3"],
    ["yardsmith", "YH"],
  ])("%s becomes %s", (name, monogram) => {
    expect(deriveProjectIdentity(name).monogram).toBe(monogram);
  });
});
