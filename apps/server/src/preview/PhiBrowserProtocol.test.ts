import { describe, expect, it } from "@effect/vitest";
import * as NodeVM from "node:vm";

import {
  PHI_RUNNER_PROGRAM,
  translatePhiOperation,
  type PhiOperation,
} from "./PhiBrowserProtocol.ts";

const refs = new Map([["tab-a-document-1-element-1", "@123"]]);

/** Executes the actual fixed adapter against a skill fixture, without opening Phi. */
async function round(
  action: PhiOperation,
  options: {
    kind?: "shadow" | "agent";
    initial?: string;
    human?: boolean;
    expectedWindow?: number;
    windows?: Array<{ windowId: number }>;
    omitTarget?: boolean;
    createdWindow?: number;
    closeError?: unknown;
    allocationUrl?: string;
    tabs?: Array<{ targetId: string; url: string }>;
    password?: boolean;
    viewport?: { _tag: "freeform"; width: number; height: number };
    pageText?: string | Array<string>;
    elementPolls?: Array<boolean>;
    dialog?: boolean;
  } = {},
) {
  const calls: Array<unknown> = [];
  const polls = { element: 0, page: 0 };
  let value = options.initial ?? "existing";
  const guard = () => {
    if (options.human) throw new Error("user is controlling");
  };
  const helpers = {
    request: {
      action,
      context: { kind: options.kind ?? "shadow", name: "owned-task" },
      expectedWindow: options.expectedWindow,
      targetId: options.omitTarget ? undefined : "owned-tab",
      allocationUrl: options.allocationUrl,
      viewport: options.viewport,
    },
    enterContext: async () => {
      calls.push("enter");
      return { windowId: options.createdWindow ?? 1 };
    },
    currentContext: () => ({ kind: options.kind ?? "shadow", windowId: 1 }),
    listTabs: async () => options.tabs ?? [{ targetId: "owned-tab" }],
    observe: async () => ({ elements: options.password ? [{ type: "password" }] : [] }),
    listAgentSpaces: async () => [
      { taskId: "owned-task", windowId: 1, ownership: options.human ? "user" : "agent" },
    ],
    listShadowWindows: async () => options.windows ?? [{ windowId: 1 }],
    switchTab: async () => {
      guard();
      calls.push("switch");
    },
    click: async (...args: Array<unknown>) => {
      guard();
      calls.push(["click", ...args]);
    },
    fillInput: async (target: string, text: string) => {
      guard();
      calls.push(["fill", target, text]);
      value = text;
    },
    typeText: async (text: string) => {
      guard();
      value += text;
    },
    pressKey: async (key: string, options: unknown) => {
      guard();
      calls.push(["key", key, options]);
    },
    scroll: async (input: unknown) => {
      guard();
      calls.push(input);
    },
    goto: async (url: string, input: unknown) => {
      guard();
      calls.push([url, input]);
    },
    spaceStatus: async () => {
      calls.push("ownership");
      return { ownership: "user" };
    },
    closeShadowWindow: async (name: string) => {
      calls.push(["close-shadow", name]);
      if (options.closeError !== undefined) throw options.closeError;
    },
    closeTab: async (id: string) => {
      guard();
      calls.push(["close-tab", id]);
    },
    setViewport: async (size?: { width: number; height: number }) => {
      calls.push(["viewport", size]);
      return size ?? { width: 1280, height: 800 };
    },
    // Each poll reads the next entry of `elementPolls`/`pageText`, keeping the last one.
    waitForElement: async (target: string) => {
      const present = options.elementPolls?.[polls.element++] ?? options.elementPolls?.at(-1);
      calls.push(["wait-element", target]);
      if (!present) throw new Error("waitForElement: timed out");
    },
    // Evaluates the adapter's fixed condition against the page text of this poll.
    waitForFunction: async (expression: string) => {
      if (options.dialog) return { dialog: { type: "alert" } };
      const texts = [options.pageText ?? ""].flat();
      const page = NodeVM.createContext({
        document: { body: { innerText: texts[polls.page++] ?? texts.at(-1) } },
        location: { href: "https://example.com/done" },
      });
      if (!NodeVM.runInContext(expression, page)) throw new Error("waitForFunction: timed out");
      return true;
    },
    wait: async () => {},
    cliLog: (text: string) => {
      calls.push(JSON.parse(text));
    },
  };
  const context = NodeVM.createContext(helpers);
  await NodeVM.runInContext(`(async () => {${PHI_RUNNER_PROGRAM}\n})()`, context);
  return { calls, value };
}

describe("Phi operation translation", () => {
  it("normalizes public URLs, blank opens and millisecond deadlines", () => {
    expect(translatePhiOperation("open", {}, refs)).toEqual({
      operation: "open",
      url: "about:blank",
    });
    expect(translatePhiOperation("open", { url: "about:blank" }, refs)).toEqual({
      operation: "open",
      url: "about:blank",
    });
    expect(
      translatePhiOperation("navigate", { url: "example.com", timeoutMs: 1250 }, refs),
    ).toEqual({ operation: "navigate", url: "https://example.com/", timeout: 1.25 });
  });

  it("translates CSS and supported roles and scopes snapshot refs", () => {
    expect(translatePhiOperation("click", { locator: "button[type='submit']" }, refs).target).toBe(
      "loc=css:button[type='submit']",
    );
    expect(
      translatePhiOperation("click", { locator: 'role=button[name="Save"]' }, refs).target,
    ).toBe("loc=role:button|Save");
    expect(
      translatePhiOperation("click", { locator: "aria-ref=tab-a-document-1-element-1" }, refs)
        .target,
    ).toBe("@123");
    expect(() =>
      translatePhiOperation("click", { locator: "aria-ref=another-task" }, refs),
    ).toThrow("stale or belongs to another tab");
    expect(() =>
      translatePhiOperation("click", { locator: 'role=button[name="Save"][exact=true]' }, refs),
    ).toThrow("does not support this locator");
  });

  it("converts modifier arrays into Phi's bitmask without double counting", () => {
    expect(
      translatePhiOperation(
        "press",
        { key: "ArrowLeft", modifiers: ["Control", "Shift", "Control"] },
        refs,
      ),
    ).toEqual({ operation: "press", key: "ArrowLeft", modifiers: 10 });
    expect(() => translatePhiOperation("press", { key: "a", modifiers: ["Meta"] }, refs)).toThrow(
      "does not support native Meta shortcuts",
    );
  });

  it("rejects unsupported operations, container scroll and unavailable remote loopback", () => {
    for (const operation of ["click", "type"] as const) {
      expect(() =>
        translatePhiOperation(
          operation,
          { selector: "input", text: "value", timeoutMs: 250 },
          refs,
        ),
      ).toThrow("does not support this locator or option");
    }
    expect(() =>
      translatePhiOperation("evaluate", { expression: "document.cookie" }, refs),
    ).toThrow("does not support this operation");
    expect(() => translatePhiOperation("scroll", { deltaY: 20, selector: "main" }, refs)).toThrow(
      "does not support this locator",
    );
    expect(() =>
      translatePhiOperation("navigate", { url: "http://localhost:5173" }, refs, true),
    ).toThrow("needs a route on the Mac");
    expect(() =>
      translatePhiOperation(
        "navigate",
        { target: { kind: "environment-port", port: 5173 } },
        refs,
        true,
      ),
    ).toThrow("needs a route on the Mac");
  });
});

describe("fixed Phi skill adapter", () => {
  it("appends by default, replaces explicitly, and can clear a focused input", async () => {
    const append = await round(
      translatePhiOperation("type", { selector: "input", text: " appended" }, refs),
    );
    expect(append.value).toBe("existing appended");
    const replace = await round(
      translatePhiOperation("type", { selector: "input", text: "replacement", clear: true }, refs),
    );
    expect(replace.value).toBe("replacement");
    const clear = await round(translatePhiOperation("type", { text: "", clear: true }, refs));
    expect(clear.value).toBe("");
    expect(clear.calls).toContainEqual(["fill", "loc=css::focus", ""]);
  });

  it("passes supported modified keys to the skill without inventing editing commands", async () => {
    const result = await round(
      translatePhiOperation("press", { key: "ArrowLeft", modifiers: ["Shift"] }, refs),
    );
    expect(result.calls).toContainEqual(["key", "ArrowLeft", { modifiers: 8 }]);
  });

  it("stops shadow input at a visible sign-in form without migrating its state", async () => {
    const result = await round({ operation: "type", text: "private" }, { password: true });
    expect(result.value).toBe("existing");
    expect(result.calls.at(-1)).toMatchObject({ t3Phi: { failure: "login-required" } });
  });

  it("preserves literal code-like text as input data", async () => {
    const text = "` ${process.exit(1)} ' \\n </script>";
    const result = await round(
      translatePhiOperation("type", { selector: "input", text, clear: true }, refs),
    );
    expect(result.value).toBe(text);
  });

  it("converts navigation timeouts and wheel deltas at the helper boundary", async () => {
    expect(
      (await round(translatePhiOperation("navigate", { url: "example.com", timeoutMs: 500 }, refs)))
        .calls,
    ).toContainEqual(["https://example.com/", { timeout: 0.5 }]);
    expect(
      (await round(translatePhiOperation("scroll", { deltaX: 10, deltaY: -40 }, refs))).calls,
    ).toContainEqual({ dx: 10, dy: -40 });
  });

  it("waits for an element, then for visible text and URL as literal data", async () => {
    const wait = translatePhiOperation(
      "waitFor",
      {
        locator: "aria-ref=tab-a-document-1-element-1",
        text: 'Saved "draft"',
        urlIncludes: "/done",
        timeoutMs: 2000,
      },
      refs,
    );
    const done = await round(wait, {
      elementPolls: [true],
      pageText: 'Draft: Saved "draft" just now',
    });
    expect(done.calls).toContainEqual(["wait-element", "@123"]);
    expect(done.calls.at(-1)).toMatchObject({ t3Phi: { result: {} } });
    const hostile = translatePhiOperation(
      "waitFor",
      { text: '") || process.exit(1) || ("', timeoutMs: 100 },
      refs,
    );
    await expect(round(hostile, { pageText: "nothing" })).rejects.toThrow("timed out");
  });

  it("waits until the element and the text hold at the same moment", async () => {
    const wait = translatePhiOperation(
      "waitFor",
      { selector: ".save", text: "Saved", timeoutMs: 5000 },
      refs,
    );
    // The button disappears just as the text appears; only the third poll has both.
    const done = await round(wait, {
      elementPolls: [true, false, true],
      pageText: ["Saving", "Saved", "Saved"],
    });
    expect(
      done.calls.filter((call) => Array.isArray(call) && call[0] === "wait-element"),
    ).toHaveLength(3);
    expect(done.calls.at(-1)).toMatchObject({ t3Phi: { result: {} } });
  });

  it("fails a wait interrupted by a dialog instead of reporting a match", async () => {
    const wait = translatePhiOperation("waitFor", { text: "Saved", timeoutMs: 5000 }, refs);
    await expect(round(wait, { dialog: true })).rejects.toThrow("dialog interrupted");
  });

  it("resizes to a preset, keeps the size on later rounds and resets to fill", async () => {
    const preset = await round(
      translatePhiOperation("resize", { mode: "preset", preset: "iphone-se" }, refs),
    );
    expect(preset.calls).toContainEqual(["viewport", { width: 375, height: 667 }]);
    expect(preset.calls.at(-1)).toMatchObject({ t3Phi: { result: { width: 375, height: 667 } } });
    const later = await round(
      { operation: "click", target: "@123" },
      { viewport: { _tag: "freeform", width: 375, height: 667 } },
    );
    expect(later.calls).toContainEqual(["viewport", { width: 375, height: 667 }]);
    const fill = await round(translatePhiOperation("resize", { mode: "fill" }, refs), {
      viewport: { _tag: "freeform", width: 375, height: 667 },
    });
    expect(fill.calls).toContainEqual(["viewport", undefined]);
  });

  it("does not use Agents-only ownership APIs in shadow status", async () => {
    expect((await round({ operation: "status" })).calls).not.toContain("ownership");
    expect((await round({ operation: "status" }, { kind: "agent" })).calls).toContain("ownership");
  });

  it("stops when the human owns input and refuses a lost shadow window", async () => {
    await expect(round({ operation: "type", text: "bad" }, { human: true })).rejects.toThrow(
      "user is controlling",
    );
    await expect(
      round({ operation: "status" }, { expectedWindow: 1, windows: [] }),
    ).rejects.toThrow("refusing a replacement context");
  });

  it("cleans interrupted shadow allocation by name, and only closes the owned Agents tab", async () => {
    expect((await round({ operation: "close" })).calls).toEqual([
      ["close-shadow", "owned-task"],
      { t3Phi: { result: {}, context: null } },
    ]);
    const agents = (await round({ operation: "close" }, { kind: "agent" })).calls;
    expect(agents).toContainEqual(["close-tab", "owned-tab"]);
    expect(agents).not.toContainEqual(["close-shadow", "owned-task"]);
  });
  it("finishes cleanup when interrupted allocation has no remaining shadow resource", async () => {
    const closeError = Object.assign(new Error("agentSpace.shadow.close: unknown_task"), {
      reply: { ok: false, error: "unknown_task" },
    });
    const result = await round({ operation: "close" }, { closeError });
    expect(result.calls).toEqual([
      ["close-shadow", "owned-task"],
      { t3Phi: { result: {}, context: null } },
    ]);
    const disconnected = Object.assign(new Error("connection lost"), {
      reply: { ok: false, error: "disconnected" },
    });
    await expect(round({ operation: "close" }, { closeError: disconnected })).rejects.toThrow(
      "connection lost",
    );
  });

  it("refuses an Agents mutation without an explicit owned tab before binding", async () => {
    await expect(
      round({ operation: "close" }, { kind: "agent", omitTarget: true }),
    ).rejects.toThrow("requires the task-owned tab identifier");
    await expect(
      round({ operation: "type", text: "bad" }, { kind: "agent", omitTarget: true }),
    ).rejects.toThrow("requires the task-owned tab identifier");
  });

  it("recovers a lost Agents allocation reply by closing only its unique blank marker", async () => {
    const allocationUrl = "about:blank#t3-unique-allocation";
    const options = {
      kind: "agent" as const,
      omitTarget: true,
      allocationUrl,
      tabs: [
        { targetId: "unrelated", url: "https://example.com" },
        { targetId: "lost-allocation", url: allocationUrl },
      ],
    };
    const result = await round({ operation: "close" }, options);
    expect(result.calls).toContainEqual(["close-tab", "lost-allocation"]);
    expect(result.calls).not.toContainEqual(["close-tab", "unrelated"]);
    await expect(round({ operation: "close" }, { ...options, human: true })).rejects.toThrow(
      "user is controlling",
    );
  });

  it("closes a replacement shadow created during the window-loss race", async () => {
    const closed: Array<string> = [];
    const context = NodeVM.createContext({
      request: {
        context: { kind: "shadow", name: "owned-task" },
        expectedWindow: 1,
        action: { operation: "status" },
      },
      listShadowWindows: async () => [{ windowId: 1 }],
      enterContext: async () => ({ windowId: 2 }),
      closeShadowWindow: async (name: string) => closed.push(name),
    });
    await expect(
      NodeVM.runInContext(`(async () => {${PHI_RUNNER_PROGRAM}\n})()`, context),
    ).rejects.toThrow("refusing a replacement context");
    expect(closed).toEqual(["owned-task"]);
  });
});
