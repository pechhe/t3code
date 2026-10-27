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
