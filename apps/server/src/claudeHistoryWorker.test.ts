// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFS from "node:fs";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { describe, expect, it } from "vite-plus/test";

import { forkClaudeSession } from "./claudeHistoryWorker.ts";

const SESSION_ID = "6f1c2b8e-3d4a-4c5b-9e6f-7a8b9c0d1e2f";

describe("forkClaudeSession", () => {
  it("forks a transcript kept in the instance's own Claude home", async () => {
    const root = NodeFS.realpathSync(
      NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-fork-")),
    );
    const configDir = NodePath.join(root, "claude-home");
    const workspace = NodePath.join(root, "workspace");
    NodeFS.mkdirSync(workspace);
    const projectDir = NodePath.join(
      configDir,
      "projects",
      workspace.replace(/[^a-zA-Z0-9]/g, "-"),
    );
    NodeFS.mkdirSync(projectDir, { recursive: true });
    const line = (uuid: string, parentUuid: string | null, role: "user" | "assistant") =>
      JSON.stringify({
        type: role,
        uuid,
        parentUuid,
        sessionId: SESSION_ID,
        cwd: workspace,
        isSidechain: false,
        timestamp: "2026-10-16T08:00:00.000Z",
        message:
          role === "user"
            ? { role, content: "hello" }
            : { role, content: [{ type: "text", text: "hi" }] },
      });
    NodeFS.writeFileSync(
      NodePath.join(projectDir, `${SESSION_ID}.jsonl`),
      [
        line("a0000000-0000-4000-8000-000000000001", null, "user"),
        line(
          "a0000000-0000-4000-8000-000000000002",
          "a0000000-0000-4000-8000-000000000001",
          "assistant",
        ),
      ].join("\n") + "\n",
    );

    try {
      // The server's own environment has no such home, so this runs in the worker.
      const forked = await forkClaudeSession(
        SESSION_ID,
        { dir: workspace },
        { ...process.env, CLAUDE_CONFIG_DIR: configDir },
        // This checkout's CLI, as the server would run itself.
        { command: process.execPath, entrypoint: NodePath.join(import.meta.dirname, "bin.ts") },
      );
      expect(forked.sessionId).not.toBe(SESSION_ID);
      expect(NodeFS.existsSync(NodePath.join(projectDir, `${forked.sessionId}.jsonl`))).toBe(true);
    } finally {
      NodeFS.rmSync(root, { recursive: true, force: true });
    }
  });
});
