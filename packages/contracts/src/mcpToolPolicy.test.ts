import { describe, expect, it } from "vite-plus/test";
import { isToolListedForSession, toolFamily } from "./mcpToolPolicy.ts";

describe("Weave connection aliases", () => {
  it.each(["t3_weave_connection", "t3_hq_connection"])(
    "keeps %s in the project family with the same permissions",
    (name) => {
      expect(toolFamily(name)).toBe("project");
      expect(isToolListedForSession(name, { toolProfile: "implementation", delegated: true })).toBe(
        true,
      );
      expect(isToolListedForSession(name, { toolProfile: "source-reader", delegated: true })).toBe(
        false,
      );
    },
  );
});

describe("web research tools", () => {
  it.each(["web_search", "web_fetch"])("lists %s only for research profiles", (name) => {
    expect(toolFamily(name)).toBe("web");
    for (const delegated of [true, false]) {
      expect(isToolListedForSession(name, { toolProfile: "web-research", delegated })).toBe(true);
      for (const toolProfile of [
        "source-reader",
        "implementation",
        "phi",
        "implementation-phi",
      ] as const) {
        expect(isToolListedForSession(name, { toolProfile, delegated })).toBe(false);
      }
    }
    expect(isToolListedForSession(name, undefined)).toBe(false);
  });
});
