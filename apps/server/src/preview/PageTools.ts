// @effect-diagnostics globalTimers:off - CDP event waits in Promise code, like the rest of the server browser.
/**
 * A page's own tools (WebMCP): the tools a page registers with `document.modelContext`, listed and
 * run over the tab's CDP session. Only registered tools run, never arbitrary page code.
 */
import type { CDPSession } from "playwright-core";

import * as ServerBrowserPage from "./ServerBrowserPage.ts";

/** Output is cut near here, as `browser_snapshot`'s text is. */
export const MAX_PAGE_TOOLS_OUTPUT_BYTES = 20_000;
/** How long a call waits for a page to register its tools. */
const PAGE_TOOLS_WAIT_MS = 3_000;
const MAX_UNCLAIMED_RESPONSES = 64;

/** The part of Playwright's CDPSession this module uses (WebMCP is not in its typed protocol). */
export interface PageToolsSession {
  send(method: string, params?: object): Promise<unknown>;
  on(event: string, listener: (payload: never) => void): unknown;
}

export interface PageTool {
  readonly name: string;
  readonly description?: string;
  readonly inputSchema?: unknown;
  readonly annotations?: unknown;
}

interface Registered extends PageTool {
  readonly frameId: string;
}
interface Response {
  readonly status?: string;
  readonly output?: unknown;
  readonly errorText?: string;
  readonly exception?: unknown;
}

interface State {
  readonly tools: Map<string, Map<string, Registered>>;
  readonly changed: Set<() => void>;
  readonly pending: Map<string, (response: Response) => void>;
  readonly unclaimed: Map<string, Response>;
  enabled: Promise<void> | undefined;
}

const states = new WeakMap<object, State>();

const fail = (tag: string, message: string, detail?: unknown) =>
  new ServerBrowserPage.ServerBrowserOperationError({ tag, message, detail });

const stateOf = (session: PageToolsSession): State => {
  const known = states.get(session);
  if (known) return known;
  const state: State = {
    tools: new Map(),
    changed: new Set(),
    pending: new Map(),
    unclaimed: new Map(),
    enabled: undefined,
  };
  states.set(session, state);
  const notify = () => {
    for (const wake of state.changed) wake();
  };
  const forget = (frameId: string) => {
    state.tools.delete(frameId);
  };
  session.on("WebMCP.toolsAdded", ((payload: { tools?: ReadonlyArray<Registered> }) => {
    for (const tool of payload.tools ?? []) {
      const frame = state.tools.get(tool.frameId) ?? new Map();
      frame.set(tool.name, tool);
      state.tools.set(tool.frameId, frame);
    }
    notify();
  }) as never);
  session.on("WebMCP.toolsRemoved", ((payload: {
    tools?: ReadonlyArray<{ name: string; frameId: string }>;
  }) => {
    for (const tool of payload.tools ?? []) state.tools.get(tool.frameId)?.delete(tool.name);
  }) as never);
  // A new document starts with none of the old one's tools.
  session.on("Page.frameNavigated", ((payload: { frame: { id: string } }) =>
    forget(payload.frame.id)) as never);
  session.on("Page.frameDetached", ((payload: { frameId: string }) =>
    forget(payload.frameId)) as never);
  session.on("WebMCP.toolResponded", ((payload: Response & { invocationId: string }) => {
    const waiting = state.pending.get(payload.invocationId);
    if (waiting) return waiting(payload);
    state.unclaimed.set(payload.invocationId, payload);
    for (const oldest of state.unclaimed.keys()) {
      if (state.unclaimed.size <= MAX_UNCLAIMED_RESPONSES) break;
      state.unclaimed.delete(oldest);
    }
  }) as never);
  return state;
};

const enable = (session: PageToolsSession, state: State) => {
  state.enabled ??= session
    .send("WebMCP.enable")
    .then(() => undefined)
    .catch((cause: unknown) => {
      state.enabled = undefined;
      throw fail(
        "PreviewAutomationExecutionError",
        `This browser cannot list page tools: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    });
  return state.enabled;
};

const mainFrame = async (session: PageToolsSession) =>
  (
    (await session.send("Page.getFrameTree")) as {
      frameTree: { frame: { id: string; url?: string } };
    }
  ).frameTree.frame;

/** Resolves true once `ready()` holds, or false when `ms` pass first; woken by tool events. */
const waitUntil = (state: State, ready: () => boolean, ms: number) =>
  new Promise<boolean>((resolve) => {
    if (ready()) return resolve(true);
    const finish = (result: boolean) => {
      clearTimeout(timer);
      state.changed.delete(check);
      resolve(result);
    };
    const check = () => {
      if (ready()) finish(true);
    };
    const timer = setTimeout(() => finish(false), Math.max(0, ms));
    state.changed.add(check);
  });

const remaining = (deadlineMs: number) => Math.max(0, deadlineMs - performance.now());

const present = (tool: Registered): PageTool => ({
  name: tool.name,
  ...(tool.description === undefined ? {} : { description: tool.description }),
  ...(tool.inputSchema === undefined ? {} : { inputSchema: tool.inputSchema }),
  ...(tool.annotations === undefined ? {} : { annotations: tool.annotations }),
});

/** The main frame's tools, waiting up to `waitMs` for the page to register one. */
const settledTools = async (
  session: PageToolsSession,
  deadlineMs: number,
  waitMs: number,
  wanted?: string,
) => {
  const state = stateOf(session);
  await enable(session, state);
  const ownTools = (frameId: string) => state.tools.get(frameId);
  let frame = await mainFrame(session);
  const ready = () => {
    const tools = ownTools(frame.id);
    return wanted === undefined ? (tools?.size ?? 0) > 0 : tools?.has(wanted) === true;
  };
  if (!ready()) {
    await waitUntil(state, ready, Math.min(waitMs, remaining(deadlineMs)));
    // A navigation may have replaced the frame while waiting; this round trip also flushes
    // events that arrived with the first tool.
    frame = await mainFrame(session);
  }
  return { state, frame, tools: ownTools(frame.id) ?? new Map<string, Registered>() };
};

export interface PageToolsListing {
  readonly url?: string;
  readonly tools: ReadonlyArray<PageTool>;
  readonly note?: string;
}

export const listPageTools = async (
  session: PageToolsSession,
  options: { readonly deadlineMs: number; readonly waitMs?: number },
): Promise<PageToolsListing> => {
  const { frame, tools } = await settledTools(
    session,
    options.deadlineMs,
    options.waitMs ?? PAGE_TOOLS_WAIT_MS,
  );
  const listed = [...tools.values()].map(present);
  return {
    ...(frame.url === undefined ? {} : { url: frame.url }),
    tools: listed,
    ...(listed.length === 0
      ? { note: "This page has registered no tools. Use browser_snapshot and browser_act." }
      : {}),
  };
};

export interface PageToolResult {
  readonly name: string;
  readonly status: string;
  readonly output?: unknown;
}

export const invokePageTool = async (
  session: PageToolsSession,
  input: { readonly name: string; readonly input?: unknown },
  options: { readonly deadlineMs: number; readonly waitMs?: number },
): Promise<PageToolResult> => {
  const { state, frame, tools } = await settledTools(
    session,
    options.deadlineMs,
    options.waitMs ?? PAGE_TOOLS_WAIT_MS,
    input.name,
  );
  if (!tools.has(input.name))
    throw fail(
      "PreviewAutomationExecutionError",
      `This page has no tool named ${input.name}. Registered: ${[...tools.keys()].join(", ") || "none"}.`,
    );
  const started = (await session.send("WebMCP.invokeTool", {
    frameId: frame.id,
    toolName: input.name,
    input: input.input ?? {},
  })) as { invocationId: string };
  const id = started.invocationId;
  const early = state.unclaimed.get(id);
  state.unclaimed.delete(id);
  const response =
    early ??
    (await new Promise<Response | undefined>((resolve) => {
      const timer = setTimeout(
        () => {
          state.pending.delete(id);
          resolve(undefined);
        },
        Math.max(1, remaining(options.deadlineMs)),
      );
      state.pending.set(id, (value) => {
        clearTimeout(timer);
        state.pending.delete(id);
        resolve(value);
      });
    }));
  if (response === undefined)
    throw fail(
      "PreviewAutomationTimeoutError",
      `The page tool ${input.name} did not respond in time. It may still be running; check the page before retrying.`,
    );
  if (response.status !== "Completed")
    throw fail(
      "PreviewAutomationExecutionError",
      `The page tool ${input.name} ${response.status === "Canceled" ? "was canceled" : "failed"}${response.errorText ? `: ${response.errorText}` : ""}.`,
    );
  return {
    name: input.name,
    status: response.status,
    ...(response.output === undefined ? {} : { output: response.output }),
  };
};

/** The server browser's entry: list the page's tools, or run one by name. */
export const run = (
  cdp: CDPSession,
  operation: "pageToolList" | "pageToolInvoke",
  input: unknown,
  deadlineMs: number,
) =>
  operation === "pageToolList"
    ? listPageTools(cdp as unknown as PageToolsSession, { deadlineMs })
    : invokePageTool(
        cdp as unknown as PageToolsSession,
        input as { name: string; input?: unknown },
        { deadlineMs },
      );

const utf8Length = (text: string) => Buffer.byteLength(text, "utf8");

/** Bounds what a reply carries, naming what it cut. Redaction has already run. */
export const capPageToolsReply = <A extends object>(
  reply: A,
  maxBytes = MAX_PAGE_TOOLS_OUTPUT_BYTES,
): A => {
  const text = JSON.stringify(reply);
  if (utf8Length(text) <= maxBytes) return reply;
  const record = reply as { tools?: ReadonlyArray<unknown>; output?: unknown };
  if (record.tools !== undefined) {
    let keep = record.tools.length;
    const build = (count: number) => ({
      ...reply,
      tools: record.tools!.slice(0, count),
      truncated: true,
      note: `${record.tools!.length - count} of ${record.tools!.length} tools left out to fit ${maxBytes} bytes.`,
    });
    while (keep > 0 && utf8Length(JSON.stringify(build(keep))) > maxBytes) keep -= 1;
    return build(keep);
  }
  const output = typeof record.output === "string" ? record.output : JSON.stringify(record.output);
  const build = (text: string) => ({
    ...reply,
    output: text,
    truncated: true,
    note: `Output cut to ${utf8Length(text)} of ${utf8Length(output)} bytes (as JSON text).`,
  });
  let cut = output;
  while (cut.length > 0 && utf8Length(JSON.stringify(build(cut))) > maxBytes)
    cut = cut.slice(0, Math.floor(cut.length * 0.9));
  return build(cut);
};
