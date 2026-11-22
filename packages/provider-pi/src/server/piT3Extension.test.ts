// @effect-diagnostics nodeBuiltinImport:off -- Pi extensions run outside Effect; these tests exercise their native filesystem boundary.
import * as NodeChildProcess from "node:child_process";
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import * as Effect from "effect/Effect";
import { assert, describe, it } from "@effect/vitest";
import { PULL_REQUEST_LINKING_INSTRUCTIONS } from "@t3tools/provider-core/server/runtimeInstructions";

import { PI_T3_SERVICE_TIER_COMMAND } from "./mcpExtensionSource.ts";
import { T3_TOOL_TIMEOUT_SECONDS } from "./piT3Extension.ts";
import { loadPiT3Extension, type FakePiTool } from "./piT3Extension.testkit.ts";
import { PI_READ_ONLY_SHELL_FILENAME, PI_READ_ONLY_SHELL_SOURCE } from "./readOnlyShellSource.ts";

type Refusal = { block: true; reason: string } | undefined;
type ToolCallHook = (
  event: { toolName: string; input: unknown },
  ctx?: {
    signal?: AbortSignal;
    ui?: { confirm: (title: string, detail: string, options?: unknown) => Promise<boolean> };
  },
) => Promise<Refusal>;
type AgentStartHook = (
  event: { systemPrompt: string; systemPromptOptions?: Record<string, unknown> },
  ctx?: unknown,
) => Promise<{ systemPrompt: string } | undefined>;
type SessionStartHook = (event: unknown, ctx?: unknown) => void;
type RequestHook = (
  event: { payload: unknown },
  ctx: { model: { provider: string; serviceTiers?: ReadonlyArray<{ id: string }> } },
) => Record<string, unknown> | undefined;
type InputHook = (
  event: { text: string; images?: ReadonlyArray<unknown> },
  ctx: { ui: { notify: (message: string, level: string) => void } },
) => Promise<{ action: string; text: string; images?: ReadonlyArray<unknown> } | undefined>;

const T3_ENV = { T3_MCP_URL: "http://fixture.invalid/mcp", T3_MCP_BEARER_TOKEN: "fixture-token" };
const builtinSearch = { name: "tool_search", sourceInfo: { path: "builtin:tool-search" } };
const builtinCodemode = { name: "codemode", sourceInfo: { path: "builtin:codemode" } };

describe("Pi orchestration prompt section", () => {
  it("starts threads only with t3_thread_launch", async () => {
    const extension = await loadPiT3Extension();
    const result = await extension.hook<AgentStartHook>("before_agent_start")({
      systemPrompt: "base",
    });
    assert.notInclude(result?.systemPrompt ?? "", "create_threads");
    assert.include(result?.systemPrompt ?? "", "t3_thread_launch");
    assert.include(result?.systemPrompt ?? "", PULL_REQUEST_LINKING_INSTRUCTIONS);
  });

  it("does not include PR guidance on a SlipJay project", async () => {
    const extension = await loadPiT3Extension({
      environment: { ...T3_ENV, T3_PI_NO_PR_LINKING: "1" },
    });
    const result = await extension.hook<AgentStartHook>("before_agent_start")({
      systemPrompt: "base",
    });
    assert.include(result?.systemPrompt ?? "", "t3_thread_launch");
    assert.notInclude(result?.systemPrompt ?? "", "<pull_request_linking>");
  });

  it("gives a delegated thread its own instructions instead", async () => {
    const extension = await loadPiT3Extension({ delegatedInstructions: "child" });
    const result = await extension.hook<AgentStartHook>("before_agent_start")({
      systemPrompt: "base",
    });
    assert.include(result?.systemPrompt ?? "", "child");
    assert.notInclude(result?.systemPrompt ?? "", "orchestrator_capabilities");
  });

  it.each([
    {
      name: "on Pi builds without prompt sections",
      events: [
        { systemPrompt: "base" },
        { systemPrompt: "base", systemPromptOptions: {} },
        { systemPrompt: "base", systemPromptOptions: { sections: null } },
      ],
    },
    {
      name: "when an earlier extension forces the system prompt",
      events: [
        {
          systemPrompt: "forced",
          systemPromptOptions: { sections: {}, forceSystemPrompt: "forced" },
        },
      ],
    },
  ])("appends guidance $name", async ({ events }) => {
    const extension = await loadPiT3Extension();
    const hook = extension.hook<AgentStartHook>("before_agent_start");
    for (const event of events) {
      const result = await hook(event);
      assert.isDefined(result);
      assert.isTrue(result!.systemPrompt.startsWith(event.systemPrompt + "\n\n"));
      assert.include(result!.systemPrompt, "orchestrator_capabilities");
      assert.include(result!.systemPrompt, PULL_REQUEST_LINKING_INSTRUCTIONS);
    }
  });

  it("sets the guidance section on Pi builds with prompt sections", async () => {
    const extension = await loadPiT3Extension();
    const sections: Record<string, string> = {};
    const result = await extension.hook<AgentStartHook>("before_agent_start")({
      systemPrompt: "base",
      systemPromptOptions: { sections },
    });
    assert.isUndefined(result);
    assert.include(sections.t3_code_orchestration, "orchestrator_capabilities");
    assert.include(sections.t3_code_orchestration, PULL_REQUEST_LINKING_INSTRUCTIONS);
  });
});

describe("Pi project trust", () => {
  it.each([
    { name: "a trusted folder", trusted: true, argv: [], notices: 0 },
    { name: "an untrusted folder", trusted: false, argv: [], notices: 1 },
    { name: "--no-approve", trusted: false, argv: ["--approve", "-na"], notices: 0 },
  ])("sends $notices trust notice per session for $name", async ({ trusted, argv, notices }) => {
    const sent: string[] = [];
    const ctx = {
      cwd: "/repo",
      isProjectTrusted: () => trusted,
      ui: { notify: (message: string) => sent.push(message) },
    };
    // Pi reruns extension factories on session replacement without asking about trust again.
    for (const _session of [1, 2]) {
      const extension = await loadPiT3Extension({ environment: {}, argv });
      for (const _turn of [1, 2])
        await extension.hook<AgentStartHook>("before_agent_start")({ systemPrompt: "" }, ctx);
    }
    assert.equal(sent.length, notices * 2);
    for (const message of sent)
      assert.include(message, "for /repo because the folder is not trusted");
  });
});

describe("Pi command guard", () => {
  const confirmingContext = (onConfirm: () => void = () => {}) => ({
    signal: new AbortController().signal,
    ui: {
      confirm: async () => {
        onConfirm();
        return true;
      },
    },
  });

  it.each([false, true])(
    "blocks the original command before sandbox wrapping (read-only: %s), in every runtime mode",
    async (readOnly) => {
      for (const runtimeMode of ["full-access", "auto", "approval-required"]) {
        const extension = await loadPiT3Extension({
          result: { structuredContent: { allowed: false, reason: "main is protected" } },
          environment: {
            ...T3_ENV,
            T3_PI_RUNTIME_MODE: runtimeMode,
            ...(readOnly ? { T3_PI_READ_ONLY: "1", T3_PI_READ_ONLY_SHELL: "1" } : {}),
          },
        });
        let confirmed = false;
        const refusal = await extension.hook<ToolCallHook>("tool_call")(
          { toolName: "bash", input: { command: "git push origin main" } },
          confirmingContext(() => {
            confirmed = true;
          }),
        );
        assert.deepEqual(refusal, { block: true, reason: "main is protected" });
        assert.isFalse(confirmed, "a guarded refusal never asks the user");
        const call = extension.requests.find((request) => request.method === "tools/call");
        assert.deepEqual(call?.params, {
          name: "t3_guard_command",
          arguments: { cwd: "/fixture/workspace", command: "git push origin main" },
        });
      }
    },
  );

  it("leaves an allowed command to the runtime mode", async () => {
    const extension = await loadPiT3Extension({
      runtimeMode: "full-access",
      result: { structuredContent: { allowed: true, reason: null } },
    });
    assert.isUndefined(
      await extension.hook<ToolCallHook>("tool_call")(
        { toolName: "bash", input: { command: "git status" } },
        confirmingContext(),
      ),
    );
  });

  it("lets the call through when the thread has no t3-code session", async () => {
    const extension = await loadPiT3Extension({ runtimeMode: "full-access", withoutT3: true });
    assert.isUndefined(
      await extension.hook<ToolCallHook>("tool_call")(
        { toolName: "bash", input: { command: "git push origin main" } },
        confirmingContext(),
      ),
    );
    assert.lengthOf(extension.requests, 0);
  });

  it.each([
    { name: "answers without a decision", options: {}, reached: "tools/call" },
    { name: "fails", options: { controlStatus: 500 }, reached: "initialize" },
  ])("lets the call through when the guard $name", async ({ options, reached }) => {
    const extension = await loadPiT3Extension({ runtimeMode: "full-access", ...options });
    assert.isUndefined(
      await extension.hook<ToolCallHook>("tool_call")(
        { toolName: "bash", input: { command: "git status" } },
        confirmingContext(),
      ),
    );
    assert.isTrue(extension.requests.some((request) => request.method === reached));
  });
});

describe("Pi MCP server registration", () => {
  const agentServers = [
    {
      name: "weave",
      url: "http://weave.invalid/mcp/weave",
      authorizationHeader: "Bearer weave-token",
    },
  ];
  const direct = {
    lead: { agent_roles: "direct", delegate_task: "direct", task_status: "direct" },
    helper: { ask_advice: "direct", task_status: "direct" },
  };

  it.each([
    {
      availability: "builtin tool_search",
      tools: [builtinSearch, builtinCodemode],
      exposure: "deferred",
    },
    { availability: "codemode only", tools: [builtinCodemode], exposure: "codemode" },
    {
      availability: "codemode opted out",
      tools: [builtinCodemode],
      defaultTools: ["read", "-codemode"],
      exposure: "direct",
    },
    { availability: "neither", tools: [], exposure: "direct" },
  ])(
    "registers with $exposure exposure for $availability",
    async ({ tools, defaultTools, exposure }) => {
      for (const task of ["lead", "helper"] as const) {
        const extension = await loadPiT3Extension({
          allTools: tools,
          ...(defaultTools === undefined ? {} : { defaultTools }),
          agentServers,
          delegatedInstructions: "child",
          role: task === "lead" ? "lead" : "scout",
        });
        extension.hook<SessionStartHook>("session_start")({});
        const registered = Object.fromEntries(
          extension.servers.map((server) => [server.name, server.config]),
        );
        assert.deepEqual(Object.keys(registered), ["t3-code", "weave"]);
        assert.deepEqual(registered["t3-code"], {
          url: T3_ENV.T3_MCP_URL,
          headers: { Authorization: "Bearer fixture-token" },
          timeout: T3_TOOL_TIMEOUT_SECONDS,
          exposure,
          ...(exposure === "direct" ? {} : { toolExposure: direct[task] }),
        });
        // An agent server decides its own tool visibility, so it gets no per-tool exposure.
        assert.deepEqual(registered["weave"], {
          url: agentServers[0]!.url,
          headers: { Authorization: "Bearer weave-token" },
          timeout: T3_TOOL_TIMEOUT_SECONDS,
          exposure,
        });
      }
    },
  );

  it("registers nothing and says why on the first turn when Pi's builtin MCP is off", async () => {
    const extension = await loadPiT3Extension({ builtinMcp: false, agentServers });
    const sent: string[] = [];
    const ctx = { ui: { notify: (message: string) => sent.push(message) } };
    extension.hook<SessionStartHook>("session_start")({}, ctx);
    await extension.hook<AgentStartHook>("before_agent_start")({ systemPrompt: "" }, ctx);
    assert.lengthOf(extension.servers, 0);
    assert.lengthOf(sent, 1);
    assert.include(sent[0]!, "no t3-code or weave tools");
  });

  it("registers again only when the discovery exposure changes", async () => {
    const extension = await loadPiT3Extension({ allTools: [builtinCodemode], agentServers });
    const start = extension.hook<AgentStartHook>("before_agent_start");
    extension.hook<SessionStartHook>("session_start")({});
    await start({ systemPrompt: "" });
    await start({ systemPrompt: "" });
    assert.deepEqual(
      extension.servers.map((server) => [server.name, server.config.exposure]),
      [
        ["t3-code", "codemode"],
        ["weave", "codemode"],
      ],
    );
    extension.allTools.push(builtinSearch);
    await start({ systemPrompt: "" });
    await start({ systemPrompt: "" });
    assert.deepEqual(
      extension.servers.slice(2).map((server) => [server.name, server.config.exposure]),
      [
        ["t3-code", "deferred"],
        ["weave", "deferred"],
      ],
    );
  });

  it("registers agent servers with their own credentials for a thread without a t3-code session", async () => {
    const extension = await loadPiT3Extension({
      withoutT3: true,
      allTools: [builtinSearch],
      agentServers: [
        ...agentServers,
        { name: "t3_code", url: "http://other.invalid/mcp", authorizationHeader: "Bearer x" },
      ],
    });
    await extension.hook<(event: unknown) => Promise<void>>("session_start")({});
    assert.deepEqual(
      extension.servers.map((server) => [server.name, server.config.headers.Authorization]),
      [["weave", "Bearer weave-token"]],
    );
    assert.lengthOf(extension.requests, 0);
  });

  describe("same-named servers in Pi's mcp.json", () => {
    const withConfigs = async (
      files: { readonly global?: object; readonly project?: object },
      run: (directories: { readonly agentDir: string; readonly cwd: string }) => Promise<void>,
    ) => {
      const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pi-mcp-config-"));
      const agentDir = NodePath.join(root, "agent");
      const cwd = NodePath.join(root, "project");
      try {
        await NodeFSP.mkdir(NodePath.join(cwd, ".pi"), { recursive: true });
        await NodeFSP.mkdir(agentDir);
        if (files.global) {
          await NodeFSP.writeFile(
            NodePath.join(agentDir, "mcp.json"),
            JSON.stringify(files.global),
          );
        }
        if (files.project) {
          await NodeFSP.writeFile(
            NodePath.join(cwd, ".pi", "mcp.json"),
            JSON.stringify(files.project),
          );
        }
        await run({ agentDir, cwd });
      } finally {
        await NodeFSP.rm(root, { recursive: true, force: true });
      }
    };

    it.each([
      {
        name: "a global file",
        files: { global: { mcpServers: { weave: { url: "http://mine.invalid/mcp" } } } },
        trusted: true,
        notices: ["weave"],
      },
      {
        name: "a trusted project file naming t3_code for t3-code",
        files: { project: { mcpServers: { t3_code: { command: "node" } } } },
        trusted: true,
        notices: ["t3-code"],
      },
      {
        name: "an untrusted project file",
        files: { project: { mcpServers: { weave: { url: "http://mine.invalid/mcp" } } } },
        trusted: false,
        notices: [],
      },
      {
        name: "an entry without command, url or type",
        files: { global: { mcpServers: { weave: { lifecycle: "lazy" }, "t3-code": {} } } },
        trusted: true,
        notices: [],
      },
    ])("warns for $name: $notices", async ({ files, trusted, notices }) => {
      await withConfigs(files, async ({ agentDir, cwd }) => {
        const extension = await loadPiT3Extension({ agentDir, agentServers });
        const sent: string[] = [];
        const ctx = {
          cwd,
          isProjectTrusted: () => trusted,
          ui: { notify: (message: string) => sent.push(message) },
        };
        extension.hook<SessionStartHook>("session_start")({}, ctx);
        // T3 shows a notice only inside a turn, so it waits for the session's first one.
        assert.lengthOf(sent, 0);
        await extension.hook<AgentStartHook>("before_agent_start")({ systemPrompt: "" }, ctx);
        await extension.hook<AgentStartHook>("before_agent_start")({ systemPrompt: "" }, ctx);
        const clashes = sent.filter((message) => message.includes("MCP server in "));
        assert.lengthOf(clashes, notices.length);
        const sentClashes = clashes;
        notices.forEach((name, index) => {
          assert.include(sentClashes[index]!, '"' + name + '" MCP server in ');
          assert.include(sentClashes[index]!, "mcp.json");
        });
      });
    });

    it("withholds automatic approval from an overridden server's tools only", async () => {
      await withConfigs(
        { global: { mcpServers: { weave: { url: "http://mine.invalid/mcp" } } } },
        async ({ agentDir, cwd }) => {
          const extension = await loadPiT3Extension({
            agentDir,
            agentServers: [
              ...agentServers,
              { name: "sky", url: "http://sky.invalid/mcp", authorizationHeader: "Bearer sky" },
            ],
            runtimeMode: "approval-required",
          });
          extension.hook<SessionStartHook>("session_start")(
            {},
            { cwd, isProjectTrusted: () => true, ui: { notify: () => {} } },
          );
          const confirmations: string[] = [];
          const ctx = {
            ui: {
              confirm: async (title: string) => {
                confirmations.push(title);
                return false;
              },
            },
          };
          const hook = extension.hook<ToolCallHook>("tool_call");
          assert.isUndefined(await hook({ toolName: "mcp__sky__read", input: {} }, ctx));
          assert.equal((await hook({ toolName: "mcp__weave__read", input: {} }, ctx))?.block, true);
          assert.deepEqual(confirmations, ["Allow mcp__weave__read?"]);
        },
      );
    });
  });
});

describe("Pi composed context", () => {
  it("reports the first request's composed prompt and declarations once per run", async () => {
    const extension = await loadPiT3Extension();
    const start = extension.hook<AgentStartHook>("before_agent_start");
    const report = extension.hook<(event: unknown) => Promise<void>>("context_with_system");
    const tool = { name: "read", description: "Read", parameters: { type: "object" } };
    await start({
      systemPrompt: "base",
      systemPromptOptions: {
        sections: {},
        contextFiles: [{ path: "/repo/AGENTS.md", content: "rules" }],
        skills: [{ name: "local", filePath: "/repo/skill/SKILL.md" }],
      },
    });
    await report({ messages: [{ content: "composed prompt", toolsAdded: [tool] }] });
    await report({ messages: [{ content: "next request", toolsAdded: [tool, tool] }] });
    let reports = extension.requests.filter((request) => request.method === "t3/run-setup");
    assert.equal(reports.length, 1);
    assert.deepEqual(JSON.parse(JSON.stringify(reports[0]?.params)), {
      systemPromptCharacters: 15,
      instructions: [{ path: "/repo/AGENTS.md", characters: 5 }],
      skills: [{ name: "local", path: "/repo/skill/SKILL.md" }],
      tools: {
        count: 1,
        characters: JSON.stringify(tool).length,
        declarations: [{ name: "read", characters: JSON.stringify(tool).length }],
      },
    });
    assert.equal(extension.transports.at(-1)?.url, "http://fixture.invalid/mcp");
    await start({ systemPrompt: "base" });
    await report({ messages: [{ content: "second run", toolsAdded: [] }] });
    reports = extension.requests.filter((request) => request.method === "t3/run-setup");
    assert.equal(reports.length, 2);
  });

  it("resolves symlinked instructions and skill roots before filtering", async () => {
    const root = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pi-context-scratch-"));
    try {
      await NodeFSP.mkdir(NodePath.join(root, "config"));
      await NodeFSP.writeFile(NodePath.join(root, "config", "AGENTS.md"), "core");
      await NodeFSP.writeFile(NodePath.join(root, "config", "SKILL.md"), "skill");
      await NodeFSP.symlink(NodePath.join(root, "config"), NodePath.join(root, "alias"));
      const extension = await loadPiT3Extension({
        role: "reviewer",
        delegatedInstructions: "child",
        agentConfigRoot: NodePath.join(root, "alias"),
      });
      const options = {
        sections: {},
        contextFiles: ["config", "alias"].map((name) => ({
          path: NodePath.join(root, name, "AGENTS.md"),
          content: "core",
        })),
        skills: [
          { name: "global", filePath: NodePath.join(root, "config", "SKILL.md") },
          { name: "repository", filePath: NodePath.join(root, "repository", "SKILL.md") },
        ],
      };
      await extension.hook<AgentStartHook>("before_agent_start")({
        systemPrompt: "base",
        systemPromptOptions: options,
      });
      assert.equal(options.contextFiles.length, 1);
      assert.deepEqual(
        options.skills.map((skill) => skill.name),
        ["repository"],
      );
    } finally {
      await NodeFSP.rm(root, { recursive: true, force: true });
    }
  });

  it.each(["scout", "browser", "reviewer", "advisor", "implementer", "lead", undefined])(
    "cuts helper rules and agent-config skills for %s",
    async (role) => {
      const extension = await loadPiT3Extension({
        agentConfigRoot: "/config",
        ...(role ? { role, delegatedInstructions: "child" } : {}),
      });
      const options = {
        sections: {},
        contextFiles: [
          { path: "/config/AGENTS.md", content: "core\n<!-- lead-only-below -->\nlead" },
          { path: "/repo/AGENTS.md", content: "repository" },
          { path: "/config/AGENTS.md", content: "duplicate" },
        ],
        skills: [
          { name: "global", filePath: "/config/skills/global/SKILL.md" },
          { name: "local", filePath: "/repo/.agents/skills/local/SKILL.md" },
        ],
      };
      await extension.hook<AgentStartHook>("before_agent_start")({
        systemPrompt: "base",
        systemPromptOptions: options,
      });
      assert.equal(options.contextFiles.length, role === "browser" ? 1 : 2);
      const prompt = (options.sections as Record<string, string>).t3_code_orchestration ?? "";
      assert.equal(
        prompt.includes("<pull_request_linking>"),
        role === undefined || role === "lead",
      );
      assert.equal(
        options.contextFiles[0]?.content,
        role && role !== "lead" ? "core\n" : "core\n<!-- lead-only-below -->\nlead",
      );
      assert.deepEqual(
        options.skills.map((skill) => skill.name),
        role === "browser" || role === "scout" || role === "advisor"
          ? []
          : role && role !== "lead"
            ? ["local"]
            : ["global", "local"],
      );
    },
  );

  it.each([
    { query: "preview_snapshot", limit: undefined, expected: 1 },
    { query: " mcp__t3_code__preview_snapshot ", limit: 8, expected: 1 },
    { query: "inspect the browser", limit: undefined, expected: 3 },
    { query: "inspect the browser", limit: 15, expected: 3 },
    { query: "inspect the browser", limit: 2, expected: 2 },
    { query: "ask_advice, +task_status mcp__t3_code__agent_roles", limit: 1, expected: 3 },
    { query: "ask_advice browser", limit: undefined, expected: 3 },
  ])("narrows builtin search $query", async ({ query, limit, expected }) => {
    const extension = await loadPiT3Extension({
      runtimeMode: "full-access",
      allTools: [
        builtinSearch,
        ...["preview_snapshot", "ask_advice", "task_status", "agent_roles"].map((name) => ({
          name: "mcp__t3_code__" + name,
        })),
      ],
    });
    const input = { query, ...(limit === undefined ? {} : { limit }) };
    await extension.hook<ToolCallHook>("tool_call")({ toolName: "tool_search", input });
    assert.equal((input as { limit?: number }).limit, expected);
  });
});

describe("Pi tool discovery permissions", () => {
  const t3Tools: ReadonlyArray<FakePiTool> = [
    { name: "mcp__t3_code__orchestrator_capabilities", annotations: { readOnlyHint: true } },
    { name: "mcp__t3_code__delegate_task" },
    { name: "mcp__t3_code__task_status", annotations: { readOnlyHint: false } },
  ];

  it.each(["approval-required", "auto-accept-edits", "auto"])(
    "allows annotated T3 reads in %s while gating mutations and unknown servers",
    async (runtimeMode) => {
      const extension = await loadPiT3Extension({ runtimeMode, allTools: t3Tools });
      const confirmations: string[] = [];
      const ctx = {
        ui: {
          confirm: async (title: string) => {
            confirmations.push(title);
            return false;
          },
        },
      };
      const hook = extension.hook<ToolCallHook>("tool_call");
      assert.isUndefined(
        await hook({ toolName: "mcp__t3_code__orchestrator_capabilities", input: {} }, ctx),
      );
      assert.equal(
        (await hook({ toolName: "mcp__t3_code__delegate_task", input: {} }, ctx))?.block,
        true,
      );
      assert.equal(
        (await hook({ toolName: "mcp__t3_code__task_status", input: {} }, ctx))?.block,
        true,
      );
      // Only a server this thread registered is trusted by its annotations.
      extension.allTools.push({
        name: "mcp__other__orchestrator_capabilities",
        annotations: { readOnlyHint: true },
      });
      assert.equal(
        (await hook({ toolName: "mcp__other__orchestrator_capabilities", input: {} }, ctx))?.block,
        true,
      );
      assert.equal(confirmations.length, 3);
    },
  );

  it("approves every T3 tool for a delegated task", async () => {
    const extension = await loadPiT3Extension({
      runtimeMode: "approval-required",
      delegatedInstructions: "child",
      allTools: t3Tools,
    });
    assert.isUndefined(
      await extension.hook<ToolCallHook>("tool_call")(
        { toolName: "mcp__t3_code__delegate_task", input: {} },
        { ui: { confirm: async () => assert.fail("asked") } },
      ),
    );
  });

  it("blocks non-readonly and extension-shadowed tools in a read-only session even under full-access", async () => {
    const weave = {
      name: "weave",
      url: "http://weave.invalid/mcp/weave",
      authorizationHeader: "Bearer weave-token",
    };
    const extension = await loadPiT3Extension({
      allTools: [builtinSearch, builtinCodemode, ...t3Tools],
      environment: {
        ...T3_ENV,
        T3_MCP_AGENT_SERVERS: JSON.stringify([weave]),
        T3_PI_RUNTIME_MODE: "full-access",
        T3_PI_INSTRUCTIONS: "read-only child",
        T3_PI_READ_ONLY: "1",
      },
    });
    const hook = extension.hook<ToolCallHook>("tool_call");
    const ctx = { ui: { confirm: async () => true } };
    for (const allowed of [
      "read",
      "grep",
      "find",
      "ls",
      "tool_search",
      // Each call a codemode script makes reaches this hook under its own name.
      "codemode",
      "mcp__t3_code__orchestrator_capabilities",
      "mcp__weave__weave_forge_read",
    ]) {
      assert.isUndefined(await hook({ toolName: allowed, input: {} }, ctx));
    }
    for (const blocked of [
      "bash",
      "edit",
      "write",
      "powershell",
      "evil_exec",
      "mcp__other__tool",
    ]) {
      assert.equal((await hook({ toolName: blocked, input: {} }, ctx))?.block, true);
    }

    // Shadowing a built-in read-only tool with a user extension tool is also blocked.
    const shadowed = await loadPiT3Extension({
      environment: {
        T3_PI_RUNTIME_MODE: "full-access",
        T3_PI_READ_ONLY: "1",
        T3_PI_READ_ONLY_SHELL: "1",
      },
      allTools: [
        { name: "bash", sourceInfo: { path: "/user/extensions/evil-bash.ts" } },
        { name: "read", sourceInfo: { path: "/user/extensions/evil-read.ts" } },
        { name: "tool_search", sourceInfo: { path: "/user/extensions/evil-search.ts" } },
        { name: "codemode", sourceInfo: { path: "/user/extensions/evil-codemode.ts" } },
      ],
    });
    const shadowedHook = shadowed.hook<ToolCallHook>("tool_call");
    for (const toolName of ["bash", "read", "tool_search", "codemode"]) {
      assert.equal(
        (await shadowedHook({ toolName, input: { command: "echo x" } }, ctx))?.block,
        true,
        toolName,
      );
    }
  });

  it.live("sandboxes codemode-origin bash, probes once and fails closed before execution", () =>
    Effect.promise(async () => {
      type Hook = (event: {
        toolName: string;
        parentToolCallId: string;
        input: { command: string };
      }) => Promise<Refusal>;
      const execute = NodeUtil.promisify(NodeChildProcess.execFile);
      const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pi-nested-shell-"));
      const launcher = NodePath.join(directory, PI_READ_ONLY_SHELL_FILENAME);
      const checkout = NodePath.join(directory, "checkout");
      const cleanups: Array<() => void> = [];
      try {
        await NodeFSP.writeFile(launcher, PI_READ_ONLY_SHELL_SOURCE);
        await NodeFSP.mkdir(checkout);
        await execute("git", ["init", "--quiet", checkout]);
        await NodeFSP.writeFile(NodePath.join(checkout, "tracked"), "original");
        await execute("git", ["add", "tracked"], { cwd: checkout });
        for (const available of [true, false]) {
          const calls: string[][] = [];
          const extension = await loadPiT3Extension({
            allTools: [{ name: "bash", sourceInfo: { path: "builtin:bash" } }],
            environment: {
              T3_PI_READ_ONLY: "1",
              T3_PI_READ_ONLY_SHELL: "1",
              T3_PI_MCP_EXTENSION_PATH: NodePath.join(directory, "extension.ts"),
            },
            globals: {
              NodeChildProcess: {
                execFile: (
                  binary: string,
                  args: string[],
                  callback: (error: Error | null, stdout: string, stderr: string) => void,
                ) => {
                  calls.push(args);
                  if (available) NodeChildProcess.execFile(binary, args, callback);
                  else callback(new Error("probe failed"), "", "no Landlock");
                },
              },
            },
          });
          cleanups.push(extension.runExitHandlers);
          const hook = extension.hook<Hook>("tool_call");
          for (const command of ["printf changed > tracked", "cat tracked"]) {
            const event = {
              toolName: "bash",
              parentToolCallId: "codemode-call",
              input: { command },
            };
            const result = await hook(event);
            if (available) {
              assert.isUndefined(result);
              const output = await execute("/bin/bash", ["-c", event.input.command], {
                cwd: checkout,
              }).then(
                ({ stdout, stderr }) => ({ stdout, stderr, code: 0 }),
                (error: { stdout: string; stderr: string; code: number }) => error,
              );
              if (command === "cat tracked") {
                assert.equal(output.code, 0);
                assert.equal(output.stdout, "original");
              } else {
                assert.equal(output.code, 1);
                assert.match(output.stderr, /Permission denied|Operation not permitted/);
              }
            } else {
              assert.equal(result?.block, true);
              assert.include(result!.reason, "read-only shell is unavailable on this host");
              assert.include(result!.reason, "no Landlock");
              assert.equal(event.input.command, command);
            }
          }
          assert.deepEqual(calls, [[launcher, "--probe"]]);
          assert.equal(
            await NodeFSP.readFile(NodePath.join(checkout, "tracked"), "utf8"),
            "original",
          );
        }
      } finally {
        for (const cleanup of cleanups) cleanup();
        await NodeFSP.rm(directory, { recursive: true, force: true });
      }
    }),
  );

  it("allows discovery and codemode without confirmation and still gates the discovered tool", async () => {
    const search = { name: "tool_search", sourceInfo: { path: "builtin:tool-search" } };
    const codemode = { name: "codemode", sourceInfo: { path: "builtin:codemode" } };
    const extension = await loadPiT3Extension({
      environment: { T3_PI_RUNTIME_MODE: "approval-required" },
      allTools: [search, codemode],
    });
    const toolCall = extension.hook<ToolCallHook>("tool_call");
    const confirmations: string[] = [];
    const controller = new AbortController();
    const ctx = {
      signal: controller.signal,
      ui: {
        confirm: async (title: string, _detail: string, options?: unknown) => {
          assert.strictEqual((options as { signal: AbortSignal }).signal, controller.signal);
          confirmations.push(title);
          return false;
        },
      },
    };
    for (const builtinPath of ["builtin:tool-search", "<builtin:tool-search>"]) {
      search.sourceInfo.path = builtinPath;
      assert.isUndefined(
        await toolCall({ toolName: "tool_search", input: { query: "preview_snapshot" } }, ctx),
      );
    }
    assert.isUndefined(await toolCall({ toolName: "codemode", input: { code: "return 1" } }, ctx));
    assert.equal(confirmations.length, 0);
    const result = await toolCall({ toolName: "mcp__t3_code__preview_snapshot", input: {} }, ctx);
    assert.equal(result?.block, true);
    assert.deepEqual(confirmations, ["Allow mcp__t3_code__preview_snapshot?"]);

    search.sourceInfo.path = "/extensions/custom-search.ts";
    assert.equal((await toolCall({ toolName: "tool_search", input: {} }, ctx))?.block, true);
    assert.equal(confirmations.at(-1), "Allow tool_search?");

    codemode.sourceInfo.path = "/extensions/custom-codemode.ts";
    assert.equal((await toolCall({ toolName: "codemode", input: {} }, ctx))?.block, true);
    assert.equal(confirmations.at(-1), "Allow codemode?");
  });

  it("gives long inputs that differ past the shown text different confirmation details", async () => {
    const extension = await loadPiT3Extension({ runtimeMode: "approval-required" });
    const hook = extension.hook<ToolCallHook>("tool_call");
    const details: string[] = [];
    const ctx = {
      ui: {
        confirm: async (_title: string, detail: string) => {
          details.push(detail);
          return true;
        },
      },
    };
    const filler = "a".repeat(4_100);
    await hook({ toolName: "bash", input: { command: filler + "\necho one" } }, ctx);
    await hook({ toolName: "bash", input: { command: filler + "\necho two" } }, ctx);
    await hook({ toolName: "bash", input: { command: "ls" } }, ctx);
    const [first, second, short] = details;
    assert.equal(first!.slice(0, 4_000), second!.slice(0, 4_000));
    assert.notEqual(first, second);
    assert.match(first!, /\n\.\.\. \d+ more characters not shown \(sha256 [0-9a-f]{64}\)$/);
    assert.equal(short, JSON.stringify({ command: "ls" }, null, 2));
  });
});

async function loadRequestHook() {
  const extension = await loadPiT3Extension({ environment: {} });
  const setServiceTier = extension.commands.get(PI_T3_SERVICE_TIER_COMMAND);
  assert.isDefined(setServiceTier);
  return Object.assign(extension.hook<RequestHook>("before_provider_request"), {
    setServiceTier: setServiceTier!,
  });
}

describe("Pi service tier", () => {
  it("sends only a tier the active model advertises, until Standard clears it", async () => {
    const hook = await loadRequestHook();
    const sol = {
      provider: "columbia-codex",
      serviceTiers: [{ id: "priority" }, { id: "ultrafast" }],
    };
    const payload = { model: "gpt-6.1-sol", reasoning: { effort: "high" } };
    assert.isUndefined(hook({ payload }, { model: sol }));

    await hook.setServiceTier("priority");
    assert.deepEqual(hook({ payload }, { model: sol }), { ...payload, service_tier: "priority" });

    await hook.setServiceTier("ultrafast");
    assert.equal(hook({ payload }, { model: sol })?.service_tier, "ultrafast");
    const fastOnly = { provider: "columbia-codex", serviceTiers: [{ id: "priority" }] };
    assert.isUndefined(hook({ payload }, { model: fastOnly }));
    assert.isUndefined(hook({ payload }, { model: { provider: "anthropic" } }));

    await hook.setServiceTier("");
    assert.isUndefined(hook({ payload }, { model: sol }));
  });
});

describe("Pi upstream output-budget workaround", () => {
  it.each(["max_tokens", "max_completion_tokens"])(
    "caps %s without changing the conversation or tools",
    async (key) => {
      const hook = await loadRequestHook();
      const payload = {
        model: "moonshotai/kimi-k2.6",
        messages: [{ role: "user", content: "hello" }],
        tools: [{ type: "function", function: { name: "read" } }],
        [key]: 231_969,
      };
      const result = hook({ payload }, { model: { provider: "openrouter" } });
      assert.equal(result?.[key], 32_768);
      assert.strictEqual(result?.messages, payload.messages);
      assert.strictEqual(result?.tools, payload.tools);
      assert.equal(result?.model, payload.model);
      assert.equal(payload[key as "max_tokens"], 231_969);
    },
  );

  it("preserves smaller budgets and other providers' payloads", async () => {
    const hook = await loadRequestHook();
    for (const payload of [{ max_tokens: 8192 }, { max_completion_tokens: 32_768 }, {}, null]) {
      assert.isUndefined(hook({ payload }, { model: { provider: "openrouter" } }));
    }
    assert.isUndefined(
      hook({ payload: { max_tokens: 231_969 } }, { model: { provider: "anthropic" } }),
    );
  });
});

describe("Pi tool schema reference loops", () => {
  const crmFilter = {
    type: "object",
    properties: { filter: { $ref: "#/$defs/CrmFilter" } },
    required: ["filter"],
    $defs: {
      CrmFilter: {
        anyOf: [
          {
            type: "object",
            properties: { and: { type: "array", items: { $ref: "#/$defs/CrmFilter" } } },
            required: ["and"],
          },
          {
            type: "object",
            properties: { not: { $ref: "#/$defs/CrmFilter", description: "Negated filter" } },
            required: ["not"],
          },
          { $ref: "#/$defs/Condition" },
        ],
      },
      Condition: {
        type: "object",
        properties: { attribute: { type: "string" }, operator: { type: "string" } },
        required: ["attribute", "operator"],
      },
    },
  };
  const group = {
    type: "object",
    properties: { group: { $ref: "#/$defs/Group" } },
    $defs: {
      Group: {
        type: "object",
        properties: {
          members: { type: "array", items: { $ref: "#/$defs/Member" } },
          label: { $ref: "#/$defs/Label" },
        },
      },
      Member: { type: "object", properties: { group: { $ref: "#/$defs/Group" } } },
      Label: { type: "string" },
    },
  };

  it.each([
    {
      name: "each ref that leads back to its own definition",
      schema: crmFilter,
      cut: {
        ...crmFilter,
        $defs: {
          ...crmFilter.$defs,
          CrmFilter: {
            anyOf: [
              {
                type: "object",
                properties: { and: { type: "array", items: {} } },
                required: ["and"],
              },
              {
                type: "object",
                properties: { not: { description: "Negated filter" } },
                required: ["not"],
              },
              { $ref: "#/$defs/Condition" },
            ],
          },
        },
      },
    },
    {
      name: "a loop through several definitions, leaving refs off it",
      schema: group,
      cut: {
        ...group,
        $defs: {
          Group: {
            type: "object",
            properties: {
              members: { type: "array", items: {} },
              label: { $ref: "#/$defs/Label" },
            },
          },
          Member: { type: "object", properties: { group: {} } },
          Label: { type: "string" },
        },
      },
    },
  ])("cuts $name in tools and config.tools", async ({ schema, cut }) => {
    const hook = await loadRequestHook();
    const model = { provider: "google" };
    const tools = [{ type: "function", function: { name: "x", parameters: schema } }];
    const cutTools = [{ type: "function", function: { name: "x", parameters: cut } }];
    assert.deepEqual(hook({ payload: { tools } }, { model })?.tools, cutTools);
    const declared = [{ functionDeclarations: [{ name: "x", parameters: schema }] }];
    assert.deepEqual(hook({ payload: { config: { tools: declared } } }, { model })?.config, {
      tools: [{ functionDeclarations: [{ name: "x", parameters: cut }] }],
    });
    const acyclic = [{ type: "function", function: { name: "x", parameters: { type: "object" } } }];
    assert.isUndefined(hook({ payload: { tools: acyclic } }, { model }));
  });
});

async function loadInputHook(
  commands: ReadonlyArray<{ name: string; source: string; sourceInfo: { path: string } }>,
) {
  const extension = await loadPiT3Extension({ environment: {}, skillCommands: commands });
  return extension.hook<InputHook>("input");
}

describe("Pi skill references", () => {
  it("loads every selected skill once while preserving inline prose, whitespace, and images", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pi-skill-mentions-"));
    try {
      const alpha = NodePath.join(directory, "alpha.md");
      const beta = NodePath.join(directory, "beta.md");
      await NodeFSP.writeFile(alpha, "ALPHA_INSTRUCTIONS");
      await NodeFSP.writeFile(beta, "BETA_INSTRUCTIONS");
      const hook = await loadInputHook([
        { name: "skill:alpha", source: "skill", sourceInfo: { path: alpha } },
        { name: "skill:beta", source: "skill", sourceInfo: { path: beta } },
      ]);
      const text =
        "Please use the $alpha philosophy, then $beta and $alpha\n```ts\n  const x = 1;\n```";
      const images = [{ type: "image", data: "fixture" }];
      const result = await hook({ text, images }, { ui: { notify: assert.fail } });
      assert.equal(result?.action, "transform");
      assert.isTrue(result?.text.startsWith(text + "\n\n"));
      assert.equal(result?.text.split("ALPHA_INSTRUCTIONS").length, 2);
      assert.equal(result?.text.split("BETA_INSTRUCTIONS").length, 2);
      assert.include(result?.text ?? "", "References are relative to " + directory + ".");
      assert.strictEqual(result?.images, images);
    } finally {
      await NodeFSP.rm(directory, { recursive: true });
    }
  });

  it("leaves unknown references and native skill commands for Pi", async () => {
    const hook = await loadInputHook([
      { name: "skill:alpha", source: "skill", sourceInfo: { path: "/unused" } },
    ]);
    for (const text of [
      "Explain $HOME",
      "/skill:alpha use $alpha",
      "Hello",
      "$missing",
      "Use $alpha, then continue",
      "Use ($alpha)",
    ]) {
      assert.isUndefined(await hook({ text }, { ui: { notify: assert.fail } }));
    }
  });

  it("loads additional chips without duplicating a leading native skill", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pi-skill-mentions-"));
    try {
      const path = NodePath.join(directory, "beta.md");
      await NodeFSP.writeFile(path, "BETA_INSTRUCTIONS");
      const hook = await loadInputHook([
        { name: "skill:alpha", source: "skill", sourceInfo: { path: "/unused" } },
        { name: "skill:beta", source: "skill", sourceInfo: { path } },
      ]);
      const text = "/skill:alpha use $alpha and $beta";
      const result = await hook({ text }, { ui: { notify: assert.fail } });
      assert.isTrue(result?.text.startsWith(text + "\n\n"));
      assert.notInclude(result?.text ?? "", '<skill name="alpha"');
      assert.include(result?.text ?? "", "BETA_INSTRUCTIONS");
    } finally {
      await NodeFSP.rm(directory, { recursive: true });
    }
  });

  it("reports an unreadable skill without deleting its reference or other selected instructions", async () => {
    const directory = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "pi-skill-mentions-"));
    try {
      const path = NodePath.join(directory, "readable.md");
      await NodeFSP.writeFile(path, "READABLE_INSTRUCTIONS");
      const hook = await loadInputHook([
        {
          name: "skill:missing",
          source: "skill",
          sourceInfo: { path: NodePath.join(directory, "missing.md") },
        },
        { name: "skill:readable", source: "skill", sourceInfo: { path } },
      ]);
      const notices: string[] = [];
      const text = "Use $missing and $readable";
      const result = await hook(
        { text },
        {
          ui: {
            notify: (message) => {
              notices.push(message);
            },
          },
        },
      );
      assert.isTrue(result?.text.startsWith(text + "\n\n"));
      assert.include(result?.text ?? "", "READABLE_INSTRUCTIONS");
      assert.equal(notices.length, 1);
      assert.include(notices[0] ?? "", "Could not load skill missing");
    } finally {
      await NodeFSP.rm(directory, { recursive: true });
    }
  });
});

describe("Pi agent MCP servers", () => {
  const weave = {
    name: "yardsmith-hq",
    url: "http://weave.invalid/mcp/yardsmith-hq",
    authorizationHeader: "Bearer thread-weave-credential",
  };

  it("approves agent server tools without a T3 prompt, which the server authorises for the role", async () => {
    const extension = await loadPiT3Extension({
      runtimeMode: "approval-required",
      agentServers: [weave],
      allTools: [{ name: "mcp__t3_code__delegate_task" }],
    });
    const confirmations: string[] = [];
    const ctx = {
      ui: {
        confirm: async (title: string) => {
          confirmations.push(title);
          return false;
        },
      },
    };
    const hook = extension.hook<ToolCallHook>("tool_call");
    assert.isUndefined(
      await hook({ toolName: "mcp__yardsmith_hq__weave_forge_update", input: {} }, ctx),
    );
    assert.equal(
      (await hook({ toolName: "mcp__t3_code__delegate_task", input: {} }, ctx))?.block,
      true,
    );
    assert.deepEqual(confirmations, ["Allow mcp__t3_code__delegate_task?"]);
  });
});
