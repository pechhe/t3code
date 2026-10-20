import { describe, expect, it } from "vite-plus/test";
import { hqRepositoryKeyOf } from "./projectIdentity.ts";

describe("HQ repository keys", () => {
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
    expect(hqRepositoryKeyOf({ repositoryIdentity })).toBe("pechhe/app");
  });
  it("prefers an explicit link and returns to automatic matching when cleared", () => {
    expect(hqRepositoryKeyOf({ repositoryIdentity, hqRepositoryKey: "manual/app" })).toBe(
      "manual/app",
    );
    expect(hqRepositoryKeyOf({ repositoryIdentity, hqRepositoryKey: null })).toBe("pechhe/app");
    expect(hqRepositoryKeyOf({})).toBeNull();
  });
});
