import { describe, expect, it } from "vite-plus/test";
import {
  isToolListedForSession,
  SESSION_TOOL_ENDPOINTS,
  sessionEndpointKey,
  toolFamily,
} from "./mcpToolPolicy.ts";

describe("Weave connection tool", () => {
  it.each(["t3_weave_connection"])(
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
      for (const toolProfile of ["source-reader", "implementation", "phi"] as const) {
        expect(isToolListedForSession(name, { toolProfile, delegated })).toBe(false);
      }
    }
    expect(isToolListedForSession(name, undefined)).toBe(false);
  });
});

describe("bounded browser tools", () => {
  it("keeps them apart from the preview family and off every child profile's listing", () => {
    for (const name of ["t3_browser_open", "t3_browser_task", "t3_browser_snapshot"]) {
      expect(toolFamily(name)).toBe("bounded-browser");
      // An ordinary thread's endpoint may serve them; a child reaches them only on its own endpoint.
      expect(isToolListedForSession(name, undefined)).toBe(true);
      for (const toolProfile of ["source-reader", "implementation", "phi", "web-research"] as const)
        expect(isToolListedForSession(name, { toolProfile, delegated: true })).toBe(false);
    }
    expect(SESSION_TOOL_ENDPOINTS["bounded-browser"].families).toEqual(
      new Set(["bounded-browser"]),
    );
    // No profile maps onto the bounded endpoint: the registry assigns it from the task's grant.
    expect(
      sessionEndpointKey({ toolProfile: "source-reader", agentRole: "reviewer", delegated: true }),
    ).toBe("child-reader");
  });
});

describe("browser role tools", () => {
  it("lists the device tools beside preview for a browser task, and for a task bound as the retired ui-verifier", () => {
    for (const agentRole of ["browser", "ui-verifier"] as const)
      for (const delegated of [true, false]) {
        const session = { toolProfile: "phi" as const, agentRole, delegated };
        expect(isToolListedForSession("preview_open", session)).toBe(true);
        expect(isToolListedForSession("device_list", session)).toBe(true);
        expect(isToolListedForSession("t3_thread_launch", session)).toBe(false);
      }
  });
});
