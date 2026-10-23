// @effect-diagnostics nodeBuiltinImport:off -- Pi extensions run outside Effect; these tests exercise their native filesystem boundary.
import * as NodeFSP from "node:fs/promises";
import * as NodePath from "node:path";
import * as NodeOS from "node:os";
import * as NodeModule from "node:module";
import * as NodeVM from "node:vm";
import { assert, describe, it } from "@effect/vitest";

import { PI_T3_MCP_EXTENSION_SOURCE } from "./mcpExtensionSource.ts";
import { loadMcpBridge } from "./mcpBridge.testkit.ts";

type RequestHook = (
  event: { payload: unknown },
  ctx: { model: { provider: string } },
) => Record<string, unknown> | undefined;

interface SkillCommand {
  readonly name: string;
  readonly source: string;
  readonly sourceInfo: { readonly path: string };
}

type InputHook = (
  event: { text: string; images?: ReadonlyArray<unknown> },
  ctx: { ui: { notify: (message: string, level: string) => void } },
) => Promise<{ action: string; text: string; images?: ReadonlyArray<unknown> } | undefined>;

async function loadHooks(commands: ReadonlyArray<SkillCommand> = []) {
  const handlers = new Map<string, unknown>();
  const source = NodeModule.stripTypeScriptTypes(
    PI_T3_MCP_EXTENSION_SOURCE.replace(/^import .*;$/gm, "").replace(
      "export default async function",
      "async function",
    ),
  );
  await NodeVM.runInNewContext(`${source}\nt3McpExtension(pi)`, {
    process: { env: {} },
    NodeFSP,
    NodePath,
    stripFrontmatter: (content: string) => content,
    pi: {
      on: (name: string, handler: unknown) => handlers.set(name, handler),
      getCommands: () => commands,
    },
  });
  return handlers;
}

describe("Pi orchestration prompt section", () => {
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
    const bridge = await loadMcpBridge();
    const hook = bridge.handlers.get("before_agent_start")!;
    for (const event of events) {
      const result = await hook(event, { ui: { notify: assert.fail } });
      assert.isDefined(result);
      assert.isTrue(result!.systemPrompt.startsWith(`${event.systemPrompt}\n\n`));
      assert.include(result!.systemPrompt, "orchestrator_capabilities");
    }
  });
});

describe("Pi MCP result declarations", () => {
  // Pi renders this schema as the tool's declared return type, so a full result
  // tree costs context on every turn. The field names are what a caller reads.
  const detailed = {
    type: "object",
    required: ["taskId", "agentTask"],
    properties: {
      taskId: { type: "string", description: "A description that must not survive" },
      status: { type: "string", enum: ["queued", "running", "completed"] },
      agentTask: {
        type: "object",
        properties: {
          providerInstanceId: { type: "string" },
          options: {
            type: "array",
            items: { type: "object", properties: { id: { type: "string" } } },
          },
        },
      },
    },
  } as const;

  it("keeps a result's field names and drops the tree below them", async () => {
    const bridge = await loadMcpBridge({ modern: true, outputSchema: detailed });
    const tool = bridge.tools.find((tool) => tool.name === "mcp__t3-code__preview_snapshot")!;
    const declared = tool.outputSchema as {
      readonly properties: { readonly structuredContent: Record<string, unknown> };
    };

    assert.deepEqual(declared.properties.structuredContent, {
      type: "object",
      properties: {
        taskId: { type: "string" },
        status: { type: "string" },
        agentTask: {},
      },
      required: ["taskId", "agentTask"],
    });
    const declaredChars = JSON.stringify(tool.outputSchema).length;
    const detailedChars = JSON.stringify(detailed).length;
    assert.isBelow(declaredChars, detailedChars);
    assert.notInclude(JSON.stringify(tool.outputSchema), "must not survive");
  });
});

describe("Pi MCP tool results", () => {
  it("returns mixed screenshot blocks and typed script output without repeating structured text", async () => {
    const content = [
      { type: "text", text: "Browser screenshot" },
      { type: "image", data: "AAAA", mimeType: "image/png", _meta: { private: true } },
      { type: "text", text: "Screenshot captured" },
    ] as const;
    const result = { content, structuredContent: { count: 2 }, _meta: { private: true } };
    const bridge = await loadMcpBridge({ modern: true, result });
    const tool = bridge.tools.find((tool) => tool.name === "mcp__t3-code__preview_snapshot")!;
    const output = await tool.execute("snapshot", {});
    assert.deepEqual(output.content, [
      content[0],
      { type: "image", data: "AAAA", mimeType: "image/png" },
      content[2],
    ]);
    assert.deepEqual(output.structuredContent, { content, structuredContent: { count: 2 } });
    assert.deepEqual(tool.outputSchema, {
      type: "object",
      properties: {
        content: { type: "array", items: { type: "object" } },
        structuredContent: { type: "object", properties: { count: { type: "number" } } },
        isError: { type: "boolean" },
        _meta: { type: "object" },
      },
      required: ["content"],
    });
  });

  it.each([false, true])(
    "preserves image-only results and error status, isError=%s",
    async (isError) => {
      const image = { type: "image", data: "AAAA", mimeType: "image/png" };
      const result = { content: [image], isError };
      const bridge = await loadMcpBridge({ result });
      const output = await bridge.tools[0]!.execute("image", {});
      assert.deepEqual(output.content[0], image);
      assert.equal(output.content.length, isError ? 2 : 1);
      if (isError) assert.include(output.content[1]?.text ?? "", "returned an error");
      assert.equal(output.isError, isError ? true : undefined);
      assert.deepEqual(output.structuredContent, result);
    },
  );

  it("uses structured output as model text when content is empty", async () => {
    const result = { content: [], structuredContent: { count: 2 } };
    const bridge = await loadMcpBridge({ result });
    const output = await bridge.tools[0]!.execute("structured", {});
    assert.deepEqual(output.content, [{ type: "text", text: '{"count":2}' }]);
    assert.deepEqual(output.structuredContent, result);
  });
});

describe("Pi command guard", () => {
  type ToolCallHook = (
    event: { toolName: string; input: unknown },
    ctx: { signal: AbortSignal; ui: { confirm: (title: string) => Promise<boolean> } },
  ) => Promise<{ block: true; reason: string } | undefined>;

  it("blocks a command the repository guard refuses, in every runtime mode", async () => {
    for (const runtimeMode of ["full-access", "auto", "approval-required"]) {
      const bridge = await loadMcpBridge({
        modern: true,
        runtimeMode,
        result: { structuredContent: { allowed: false, reason: "main is protected" } },
      });
      const hook = bridge.handlers.get("tool_call") as unknown as ToolCallHook;
      let confirmed = false;
      const refusal = await hook(
        { toolName: "bash", input: { command: "git push origin main" } },
        {
          signal: new AbortController().signal,
          ui: {
            confirm: async () => {
              confirmed = true;
              return true;
            },
          },
        },
      );
      assert.deepEqual(refusal, { block: true, reason: "main is protected" });
      assert.isFalse(confirmed, "a guarded refusal never asks the user");
      const call = bridge.requests.find((request) => request.method === "tools/call");
      assert.deepEqual(call?.params, {
        name: "t3_guard_command",
        arguments: { cwd: "/fixture/workspace", command: "git push origin main" },
      });
    }
  });

  it("leaves an allowed command to the runtime mode", async () => {
    const bridge = await loadMcpBridge({
      modern: true,
      runtimeMode: "full-access",
      result: { structuredContent: { allowed: true, reason: null } },
    });
    const hook = bridge.handlers.get("tool_call") as unknown as ToolCallHook;
    assert.isUndefined(
      await hook(
        { toolName: "bash", input: { command: "git status" } },
        { signal: new AbortController().signal, ui: { confirm: async () => true } },
      ),
    );
  });

  it("lets the call through when T3's bridge is absent", async () => {
    const bridge = await loadMcpBridge({
      modern: true,
      runtimeMode: "full-access",
      withoutT3: true,
    });
    const hook = bridge.handlers.get("tool_call") as unknown as ToolCallHook;
    assert.isUndefined(
      await hook(
        { toolName: "bash", input: { command: "git push origin main" } },
        { signal: new AbortController().signal, ui: { confirm: async () => true } },
      ),
    );
  });

  it("lets the call through when the guard cannot answer", async () => {
    const bridge = await loadMcpBridge({ modern: true, runtimeMode: "full-access" });
    const hook = bridge.handlers.get("tool_call") as unknown as ToolCallHook;
    // The default fixture answers tools/call with a browser snapshot, no guard decision.
    assert.isUndefined(
      await hook(
        { toolName: "bash", input: { command: "git status" } },
        { signal: new AbortController().signal, ui: { confirm: async () => true } },
      ),
    );
  });
});

describe("Pi MCP tool exposure", () => {
  const discoveryContext = {
    model: { api: "anthropic-messages" },
    ui: { notify: () => undefined },
  };

  it("keeps orchestration direct and optional bridge tools discoverable on modern Pi", async () => {
    const bridge = await loadMcpBridge({ modern: true, toolSearchAvailable: true });
    await bridge.handlers.get("session_start")!({ systemPrompt: "" }, discoveryContext);
    const start = bridge.handlers.get("before_agent_start");
    assert.isDefined(start);
    const prompt = await start!({ systemPrompt: "Pi system prompt" }, discoveryContext);
    assert.include(prompt?.systemPrompt ?? "", "orchestrator_capabilities");
    assert.equal(bridge.servers.length, 0);
    assert.equal(bridge.tools.length, 8);
    assert.deepEqual(bridge.getActiveTools(), ["read", "tool_search"]);
    assert.deepEqual(
      bridge.tools
        .filter((tool) => tool.exposure !== "hidden")
        .map((tool) => [tool.name, tool.exposure]),
      [
        ["mcp__t3-code__orchestrator_capabilities", "direct"],
        ["mcp__t3-code__delegate_task", "direct"],
        ["mcp__t3-code__task_status", "direct"],
        ["mcp__t3-code__preview_snapshot", "deferred"],
      ],
    );
    assert.deepEqual(
      bridge.tools.filter((tool) => tool.exposure === "hidden").map((tool) => tool.name),
      [
        "mcp__t3_code__orchestrator_capabilities",
        "mcp__t3_code__delegate_task",
        "mcp__t3_code__task_status",
        "mcp__t3_code__preview_snapshot",
      ],
    );
    const result = await bridge.tools
      .find((tool) => tool.name === "mcp__t3-code__preview_snapshot")!
      .execute("call-1", { depth: 2 });
    assert.equal(result.content[0]?.text, "browser snapshot");
    assert.equal(bridge.requests.at(-1)?.method, "tools/call");
  });

  it("does not eagerly declare the catalogue for a completions gateway", async () => {
    const bridge = await loadMcpBridge({
      modern: true,
      toolSearchAvailable: true,
      allowsTool: (name) => name !== "mcp__t3-code__delegate_task",
    });
    const event = { systemPrompt: "" };
    await bridge.handlers.get("session_start")!(event, discoveryContext);
    const gatewayContext = { model: { api: "openai-completions" }, ui: { notify: assert.fail } };
    await bridge.handlers.get("model_select")!(event, gatewayContext);
    bridge.restoreActiveTools(["read", "mcp__t3-code__task_status"]);
    await bridge.handlers.get("session_tree")!(event, gatewayContext);
    assert.deepEqual(bridge.getActiveTools(), ["read", "mcp__t3-code__task_status", "tool_search"]);
    assert.equal(
      bridge.tools.find((tool) => tool.name === "mcp__t3-code__preview_snapshot")?.exposure,
      "deferred",
    );
  });

  it.each(["legacy Pi", "disabled tool search"])(
    "keeps tool execution available with %s",
    async (mode) => {
      const bridge = await loadMcpBridge({
        modern: mode !== "legacy Pi",
        toolSearchAvailable: mode === "disabled tool search",
        toolSearchDisabled: mode === "disabled tool search",
      });
      if (mode !== "legacy Pi") {
        const start = bridge.handlers.get("session_start");
        await start!({ systemPrompt: "Pi system prompt" }, discoveryContext);
      }
      assert.equal(bridge.tools.filter((tool) => tool.exposure !== "hidden").length, 4);
      assert.isTrue(
        bridge.tools
          .filter((tool) => tool.exposure !== "hidden")
          .every((tool) => tool.exposure === undefined || tool.exposure === "direct"),
      );
      const tool = bridge.tools.find((tool) => tool.name === "mcp__t3-code__preview_snapshot");
      assert.isDefined(tool);
      const controller = new AbortController();
      const result = await tool!.execute("call-1", { depth: 2 }, controller.signal);
      assert.equal(result.content[0]?.text, "browser snapshot");
      assert.strictEqual(bridge.transports.at(-1)?.signal, controller.signal);
      assert.equal(bridge.transports.at(-1)?.url, "http://fixture.invalid/mcp");
      assert.equal(bridge.transports.at(-1)?.authorization, "Bearer fixture-token");
      assert.deepEqual(JSON.parse(JSON.stringify(bridge.requests.at(-1))), {
        jsonrpc: "2.0",
        id: 3,
        method: "tools/call",
        params: { name: "preview_snapshot", arguments: { depth: 2 } },
      });
      assert.isUndefined(tool?.promptSnippet);
      assert.isUndefined(tool?.promptGuidelines);
    },
  );
});

describe("Pi MCP tool schemas", () => {
  it.each([{ type: "object" }, {}])(
    "declares empty properties on object schemas that omit them: %j",
    async (inputSchema) => {
      const bridge = await loadMcpBridge({ inputSchema });
      assert.isAbove(bridge.tools.length, 0);
      for (const tool of bridge.tools) {
        assert.deepEqual(tool.parameters, { type: "object", properties: {} });
      }
    },
  );

  it("keeps declared properties and other schema keywords", async () => {
    const inputSchema = {
      type: "object",
      properties: { depth: { type: "number" } },
      required: ["depth"],
      additionalProperties: false,
    };
    const bridge = await loadMcpBridge({ inputSchema });
    for (const tool of bridge.tools) {
      assert.deepEqual(tool.parameters, inputSchema);
    }
  });
});

describe("Pi tool discovery permissions", () => {
  it.each(["approval-required", "auto-accept-edits", "auto"])(
    "allows annotated T3 reads in %s while gating mutations and replacements",
    async (runtimeMode) => {
      const bridge = await loadMcpBridge({ modern: true, runtimeMode });
      const hook = bridge.handlers.get("tool_call") as unknown as (
        event: { toolName: string; input: unknown },
        ctx: { ui: { confirm: (title: string) => Promise<boolean> } },
      ) => Promise<{ block: true; reason: string } | undefined>;
      const confirmations: string[] = [];
      const ctx = {
        ui: {
          confirm: async (title: string) => {
            confirmations.push(title);
            return false;
          },
        },
      };
      for (const prefix of ["mcp__t3-code__", "mcp__t3_code__"]) {
        assert.isUndefined(
          await hook({ toolName: prefix + "orchestrator_capabilities", input: {} }, ctx),
        );
        assert.equal(
          (await hook({ toolName: prefix + "delegate_task", input: {} }, ctx))?.block,
          true,
        );
        assert.equal(
          (await hook({ toolName: prefix + "task_status", input: {} }, ctx))?.block,
          true,
        );
      }
      assert.equal(confirmations.length, 4);
      bridge.setBridgeSourcePath("/user/extensions/replacement.ts");
      assert.equal(
        (await hook({ toolName: "mcp__t3-code__orchestrator_capabilities", input: {} }, ctx))
          ?.block,
        true,
      );
      assert.equal(
        (await hook({ toolName: "mcp__other__orchestrator_capabilities", input: {} }, ctx))?.block,
        true,
      );
      assert.equal(confirmations.length, 6);
    },
  );

  it("allows discovery without confirmation and still gates the discovered tool", async () => {
    type ToolCallHook = (
      event: { toolName: string; input: unknown },
      ctx: {
        signal: AbortSignal;
        ui: {
          confirm: (
            title: string,
            detail: string,
            options: { signal: AbortSignal },
          ) => Promise<boolean>;
        };
      },
    ) => Promise<{ block: true; reason: string } | undefined>;
    let toolCall: ToolCallHook | undefined;
    let searchPath = "builtin:tool-search";
    const source = NodeModule.stripTypeScriptTypes(
      PI_T3_MCP_EXTENSION_SOURCE.replace(/^import .*;$/gm, "").replace(
        "export default async function",
        "async function",
      ),
    );
    await NodeVM.runInNewContext(`${source}\nt3McpExtension(pi)`, {
      process: { env: { T3_PI_RUNTIME_MODE: "approval-required" } },
      pi: {
        on: (name: string, handler: ToolCallHook) => {
          if (name === "tool_call") toolCall = handler;
        },
        getAllTools: () => [{ name: "tool_search", sourceInfo: { path: searchPath } }],
      },
    });
    assert.isDefined(toolCall);
    const confirmations: string[] = [];
    const controller = new AbortController();
    const ctx = {
      signal: controller.signal,
      ui: {
        confirm: async (title: string, _detail: string, options: { signal: AbortSignal }) => {
          assert.strictEqual(options.signal, controller.signal);
          confirmations.push(title);
          return false;
        },
      },
    };
    assert.isUndefined(
      await toolCall!({ toolName: "tool_search", input: { query: "preview_snapshot" } }, ctx),
    );
    assert.equal(confirmations.length, 0);
    const result = await toolCall!({ toolName: "mcp__t3-code__preview_snapshot", input: {} }, ctx);
    assert.equal(result?.block, true);
    assert.deepEqual(confirmations, ["Allow mcp__t3-code__preview_snapshot?"]);

    searchPath = "/extensions/custom-search.ts";
    const replaced = await toolCall!({ toolName: "tool_search", input: {} }, ctx);
    assert.equal(replaced?.block, true);
    assert.equal(confirmations.at(-1), "Allow tool_search?");
  });
});

async function loadRequestHook(): Promise<RequestHook> {
  const handlers = new Map<string, RequestHook>();
  const source = NodeModule.stripTypeScriptTypes(
    PI_T3_MCP_EXTENSION_SOURCE.replace(/^import .*;$/gm, "").replace(
      "export default async function",
      "async function",
    ),
  );
  await NodeVM.runInNewContext(`${source}\nt3McpExtension(pi)`, {
    process: { env: {} },
    pi: { on: (name: string, handler: RequestHook) => handlers.set(name, handler) },
  });
  const hook = handlers.get("before_provider_request");
  assert.isDefined(hook);
  return hook!;
}

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
      assert.equal(payload[key], 231_969);
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

async function loadInputHook(commands: ReadonlyArray<SkillCommand>) {
  const handlers = await loadHooks(commands);
  const hook = handlers.get("input");
  assert.isDefined(hook);
  return hook as InputHook;
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
      assert.include(result?.text ?? "", `References are relative to ${directory}.`);
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
    tools: ["hq_build_read", "hq_build_update"],
  };
  const discoveryContext = {
    model: { api: "anthropic-messages" },
    ui: { notify: () => undefined },
  };

  it("attaches each agent server under its own name and credential beside t3-code", async () => {
    const bridge = await loadMcpBridge({
      modern: true,
      toolSearchAvailable: true,
      agentServers: [weave],
    });
    await bridge.handlers.get("session_start")!({ systemPrompt: "" }, discoveryContext);
    const read = bridge.tools.find((tool) => tool.name === "mcp__yardsmith-hq__hq_build_read");
    assert.isDefined(read);
    assert.equal(read!.exposure, "deferred");
    assert.equal(
      bridge.tools.find((tool) => tool.name === "mcp__yardsmith_hq__hq_build_read")?.exposure,
      "hidden",
    );
    assert.isDefined(bridge.tools.find((tool) => tool.name === "mcp__t3-code__delegate_task"));
    assert.isUndefined(bridge.tools.find((tool) => tool.name === "mcp__t3-code__hq_build_read"));

    await read!.execute("read", { ref: "T3-191" });
    assert.equal(bridge.transports.at(-1)?.url, weave.url);
    assert.equal(bridge.transports.at(-1)?.authorization, weave.authorizationHeader);
    assert.deepEqual(bridge.requests.at(-1)?.params, {
      name: "hq_build_read",
      arguments: { ref: "T3-191" },
    });
  });

  it("attaches agent servers to a thread without a t3-code session", async () => {
    const bridge = await loadMcpBridge({ modern: true, withoutT3: true, agentServers: [weave] });
    assert.deepEqual(
      bridge.tools
        .map((tool) => tool.name)
        .filter((name) => name.startsWith("mcp__yardsmith-hq__")),
      ["mcp__yardsmith-hq__hq_build_read", "mcp__yardsmith-hq__hq_build_update"],
    );
    assert.isFalse(bridge.tools.some((tool) => tool.name.startsWith("mcp__t3-code__")));
    assert.isFalse(bridge.transports.some((transport) => transport.url.includes("fixture")));
  });

  it("calls agent server tools without a T3 prompt, which the server authorises for the role", async () => {
    const bridge = await loadMcpBridge({
      modern: true,
      runtimeMode: "approval-required",
      agentServers: [weave],
    });
    const hook = bridge.handlers.get("tool_call") as unknown as (
      event: { toolName: string; input: unknown },
      ctx: { ui: { confirm: (title: string) => Promise<boolean> } },
    ) => Promise<{ block: true; reason: string } | undefined>;
    const confirmations: string[] = [];
    const ctx = {
      ui: {
        confirm: async (title: string) => {
          confirmations.push(title);
          return false;
        },
      },
    };
    assert.isUndefined(
      await hook({ toolName: "mcp__yardsmith-hq__hq_build_update", input: {} }, ctx),
    );
    assert.isUndefined(
      await hook({ toolName: "mcp__yardsmith_hq__hq_build_update", input: {} }, ctx),
    );
    assert.equal(
      (await hook({ toolName: "mcp__t3-code__delegate_task", input: {} }, ctx))?.block,
      true,
    );
    bridge.setBridgeSourcePath("/user/extensions/replacement.ts");
    assert.equal(
      (await hook({ toolName: "mcp__yardsmith-hq__hq_build_update", input: {} }, ctx))?.block,
      true,
    );
    assert.equal(confirmations.length, 2);
  });
});
