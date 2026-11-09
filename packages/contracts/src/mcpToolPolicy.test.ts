import { describe, expect, it } from "vite-plus/test";
import {
  isToolListedForSession,
  READ_ONLY_TOOLS,
  SESSION_TOOL_ENDPOINTS,
  sessionEndpointKey,
  toolFamily,
} from "./mcpToolPolicy.ts";

const reader = { toolProfile: "source-reader", agentRole: "reviewer", readOnly: true } as const;
const worker = { toolProfile: "implementation", agentRole: "implementation-worker" } as const;

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

  it("keeps browser agents and researchers on their own narrow endpoints", () => {
    expect(sessionEndpointKey({ toolProfile: "phi", agentRole: "browser", readOnly: true })).toBe(
      "preview",
    );
    expect(
      sessionEndpointKey({ toolProfile: "web-research", agentRole: "researcher", readOnly: true }),
    ).toBe("research");
  });
});

describe("web research tools", () => {
  it.each(["web_search", "web_fetch"])("lists %s to editors and researchers", (name) => {
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

describe("bounded browser tools", () => {
  it("keeps them apart from the preview family, with every editor listing them", () => {
    for (const name of ["t3_browser_open", "t3_browser_task", "t3_browser_snapshot"]) {
      expect(toolFamily(name)).toBe("bounded-browser");
      expect(isToolListedForSession(name, undefined)).toBe(true);
      expect(isToolListedForSession(name, worker)).toBe(true);
      expect(isToolListedForSession(name, { toolProfile: "web-research", readOnly: true })).toBe(
        false,
      );
    }
    expect(SESSION_TOOL_ENDPOINTS.reader.families.has("bounded-browser")).toBe(true);
  });
});

describe("browser role tools", () => {
  it("lists the device tools beside preview for a browser task, and for a task bound as the retired ui-verifier", () => {
    for (const agentRole of ["browser", "ui-verifier"] as const) {
      const session = { toolProfile: "phi" as const, agentRole, readOnly: true };
      expect(isToolListedForSession("preview_open", session)).toBe(true);
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
