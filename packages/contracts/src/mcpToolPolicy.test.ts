import { describe, expect, it } from "vite-plus/test";
import {
  isToolListedForSession,
  READ_ONLY_TOOLS,
  SESSION_TOOL_ENDPOINTS,
  sessionEndpointKey,
  toolFamily,
} from "./mcpToolPolicy.ts";

const reader = { toolProfile: "source-reader", agentRole: "reviewer", readOnly: true } as const;
const worker = { toolProfile: "implementation", agentRole: "implementer" } as const;

describe("permission classes", () => {
  it("gives every editor one endpoint and a read-only task the reader endpoint", () => {
    expect(sessionEndpointKey(undefined)).toBe("editor");
    expect(sessionEndpointKey(worker)).toBe("editor");
    expect(sessionEndpointKey({ toolProfile: "implementation", agentRole: "lead" })).toBe("editor");
    expect(sessionEndpointKey(reader)).toBe("reader");
  });

  it("lists a read-only task only the closed list", () => {
    expect(isToolListedForSession("t3_weave_connection", worker)).toBe(true);
    expect(isToolListedForSession("t3_weave_connection", reader)).toBe(false);
    expect(READ_ONLY_TOOLS.has("t3_weave_connection")).toBe(false);
    for (const name of ["t3_thread_read", "delegate_task", "t3_champions_record_learning"]) {
      expect(READ_ONLY_TOOLS.has(name)).toBe(true);
      expect(isToolListedForSession(name, reader)).toBe(true);
    }
    for (const name of ["t3_thread_send", "t3_thread_launch", "schedule_task", "t3_decide"])
      expect(isToolListedForSession(name, reader)).toBe(false);
  });

  it("keeps browser agents and web-reading scouts on their own narrow endpoints", () => {
    expect(sessionEndpointKey({ toolProfile: "phi", agentRole: "browser", readOnly: true })).toBe(
      "preview",
    );
    expect(
      sessionEndpointKey({ toolProfile: "web-research", agentRole: "scout", readOnly: true }),
    ).toBe("research");
  });
});

describe("web research tools", () => {
  it.each(["web_search", "web_fetch"])("lists %s to editors and web-reading scouts", (name) => {
    expect(toolFamily(name)).toBe("web");
    expect(isToolListedForSession(name, undefined)).toBe(true);
    expect(isToolListedForSession(name, worker)).toBe(true);
    expect(isToolListedForSession(name, { toolProfile: "web-research", readOnly: true })).toBe(
      true,
    );
    expect(isToolListedForSession(name, reader)).toBe(false);
    expect(isToolListedForSession(name, { toolProfile: "phi", readOnly: true })).toBe(false);
  });
});

describe("browser tools", () => {
  it("lists one browser family to editors, readers and browser agents, never to web readers", () => {
    for (const name of ["browser_open", "browser_act", "browser_task", "browser_snapshot"]) {
      expect(toolFamily(name)).toBe("browser");
      expect(isToolListedForSession(name, undefined)).toBe(true);
      expect(isToolListedForSession(name, worker)).toBe(true);
      expect(isToolListedForSession(name, reader)).toBe(true);
      expect(isToolListedForSession(name, { toolProfile: "web-research", readOnly: true })).toBe(
        false,
      );
    }
    // A reviewer's browser is headless and bounded: nothing it can hand to the user.
    expect(isToolListedForSession("browser_handoff", reader)).toBe(false);
  });
});

describe("consolidated tools", () => {
  it("lists none of the tools a consolidated tool replaced on any session endpoint", () => {
    for (const name of [
      "preview_open",
      "preview_interact",
      "t3_preview_list",
      "t3_browser_open",
      "t3_browser_task_cancel",
      "create_threads",
      "t3_thread_organize",
      "t3_thread_configure",
      "t3_thread_transfer",
      "t3_thread_move_to_project",
      "t3_thread_suggest_project",
      "link_pull_request",
      "unlink_pull_request",
    ]) {
      expect(toolFamily(name), name).toBe("superseded");
      for (const endpoint of Object.values(SESSION_TOOL_ENDPOINTS))
        expect(endpoint.families.has(toolFamily(name))).toBe(false);
    }
    // `t3 browser run`'s own lane keeps its names.
    expect(toolFamily("t3_browser_run_open")).not.toBe("superseded");
    for (const name of ["t3_thread_update", "t3_thread_launch", "link_pull_requests"])
      expect(isToolListedForSession(name, worker)).toBe(true);
  });
});

describe("browser role tools", () => {
  it("lists the device tools beside the browser for a browser task, and for a task bound as the retired ui-verifier", () => {
    for (const agentRole of ["browser", "ui-verifier"] as const) {
      const session = { toolProfile: "phi" as const, agentRole, readOnly: true };
      expect(isToolListedForSession("browser_open", session)).toBe(true);
      expect(isToolListedForSession("device_list", session)).toBe(true);
      expect(isToolListedForSession("t3_thread_launch", session)).toBe(false);
    }
  });
});

describe("Champion learning tools", () => {
  it("lists the learning reads to every agent session, and recording to all but the narrow readers", () => {
    const sessions = [
      undefined,
      worker,
      reader,
      { toolProfile: "phi", readOnly: true },
      { toolProfile: "web-research", readOnly: true },
    ] as const;
    for (const name of ["t3_champions_learning_search", "t3_champions_learning_read"]) {
      expect(toolFamily(name)).toBe("learnings");
      for (const session of sessions) expect(isToolListedForSession(name, session)).toBe(true);
    }
    expect(isToolListedForSession("t3_champions_record_learning", worker)).toBe(true);
    expect(isToolListedForSession("t3_champions_record_learning", reader)).toBe(true);
  });
});
