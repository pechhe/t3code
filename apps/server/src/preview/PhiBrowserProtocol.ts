import {
  PreviewAutomationClickInput,
  PreviewAutomationNavigateInput,
  PreviewAutomationOpenInput,
  PreviewAutomationPressInput,
  PreviewAutomationScrollInput,
  PreviewAutomationTypeInput,
  type PreviewAutomationOperation,
} from "@t3tools/contracts";
import { normalizePreviewUrl } from "@t3tools/shared/preview";
import * as Schema from "effect/Schema";

const decodeOpen = Schema.decodeUnknownSync(PreviewAutomationOpenInput);
const decodeNavigate = Schema.decodeUnknownSync(PreviewAutomationNavigateInput);
const decodeClick = Schema.decodeUnknownSync(PreviewAutomationClickInput);
const decodeType = Schema.decodeUnknownSync(PreviewAutomationTypeInput);
const decodePress = Schema.decodeUnknownSync(PreviewAutomationPressInput);
const decodeScroll = Schema.decodeUnknownSync(PreviewAutomationScrollInput);

export const PHI_OPERATIONS = [
  "open",
  "status",
  "navigate",
  "snapshot",
  "click",
  "type",
  "press",
  "scroll",
  "close",
  "handoff",
  "resume",
] as const satisfies ReadonlyArray<PreviewAutomationOperation>;

export class PhiBrowserInputError extends Schema.TaggedError<PhiBrowserInputError>()(
  "PhiBrowserInputError",
  {
    reason: Schema.Literals([
      "unsupported-operation",
      "unsupported-option",
      "stale-reference",
      "invalid-input",
      "unavailable-route",
      "unsupported-shortcut",
    ]),
  },
) {
  override get message(): string {
    switch (this.reason) {
      case "unsupported-operation":
        return "Phi does not support this operation. Read preview_status capabilities.";
      case "unsupported-option":
        return "Phi does not support this locator or option. Use CSS, a supported role locator, or a fresh snapshot ref.";
      case "stale-reference":
        return "This Phi reference is stale or belongs to another tab. Take a new snapshot.";
      case "unavailable-route":
        return "This local URL needs a route on the Mac running Phi. Configure the supported Mac route before navigating.";
      case "invalid-input":
        return "Invalid Phi browser operation input.";
      case "unsupported-shortcut":
        return "Phi's installed key helper does not support native Meta shortcuts. Use preview_type with clear=true to replace input, or a supported key without Meta.";
    }
  }
}

export interface PhiOperation {
  readonly operation: (typeof PHI_OPERATIONS)[number];
  readonly target?: string | undefined;
  readonly url?: string | undefined;
  readonly timeout?: number | undefined;
  readonly text?: string | undefined;
  readonly message?: string | undefined;
  readonly clear?: boolean | undefined;
  readonly key?: string | undefined;
  readonly modifiers?: number | undefined;
  readonly x?: number | undefined;
  readonly y?: number | undefined;
  readonly dx?: number | undefined;
  readonly dy?: number | undefined;
  readonly button?: "left" | "right" | "middle" | undefined;
  readonly clickCount?: number | undefined;
}

/** Common refs are opaque, tab/document-scoped tokens; Phi's numeric refs never cross the wire. */
const target = (
  input: { locator?: string | undefined; selector?: string | undefined },
  refs: ReadonlyMap<string, string>,
) => {
  if (input.selector !== undefined) return `loc=css:${input.selector}`;
  const locator = input.locator;
  if (locator === undefined) return undefined;
  if (locator.startsWith("aria-ref=")) {
    const resolved = refs.get(locator.slice("aria-ref=".length));
    if (resolved === undefined) throw new PhiBrowserInputError({ reason: "stale-reference" });
    return resolved;
  }
  // Phi's role-name matching is substring based. Exact matching, filters,
  // frames and Playwright engines need explicit support, never a lossy rewrite.
  const role = /^role=([a-z]+)(?:\[name=(?:"([^"\\]*)"|'([^'\\]*)')\])?$/.exec(locator);
  if (role && !(role[2] ?? role[3] ?? "").includes("|"))
    return `loc=role:${role[1]}${(role[2] ?? role[3]) ? `|${role[2] ?? role[3]}` : ""}`;
  if (/^(?:css=)/.test(locator)) return `loc=css:${locator.slice(4)}`;
  if (!/(?:^[\w-]+=|>>|\|\||:has-text\(|:text\()/.test(locator)) return `loc=css:${locator}`;
  throw new PhiBrowserInputError({ reason: "unsupported-option" });
};

/** Validate with the common contract, then translate to the stable skill API. */
export function translatePhiOperation(
  operation: PreviewAutomationOperation,
  input: unknown,
  refs: ReadonlyMap<string, string>,
  browserIsRemote = false,
): PhiOperation {
  const url = (raw: string) => {
    if (raw === "about:blank") return raw;
    const normalized = normalizePreviewUrl(raw);
    if (browserIsRemote && /^(localhost|127\.[\d.]+|\[::1\])$/.test(new URL(normalized).hostname)) {
      throw new PhiBrowserInputError({ reason: "unavailable-route" });
    }
    return normalized;
  };
  switch (operation) {
    case "open": {
      const value = decodeOpen(input);
      return { operation, url: value.url === undefined ? "about:blank" : url(value.url) };
    }
    case "navigate": {
      const value = decodeNavigate(input);
      if (value.readiness !== undefined && value.readiness !== "load") {
        throw new PhiBrowserInputError({ reason: "unsupported-option" });
      }
      const portTarget = value.target?.kind === "environment-port" ? value.target : undefined;
      const relativePath = portTarget?.path ?? "";
      const environmentUrl =
        portTarget === undefined
          ? undefined
          : `${portTarget.protocol ?? "http"}://localhost:${portTarget.port}${relativePath.startsWith("/") || relativePath === "" ? relativePath : `/${relativePath}`}`;
      const raw = value.url ?? (value.target?.kind === "url" ? value.target.url : environmentUrl);
      if (raw === undefined) throw new PhiBrowserInputError({ reason: "unavailable-route" });
      return { operation, url: url(raw), timeout: (value.timeoutMs ?? 15_000) / 1000 };
    }
    case "click": {
      const value = decodeClick(input);
      if (value.timeoutMs !== undefined)
        throw new PhiBrowserInputError({ reason: "unsupported-option" });
      return {
        operation,
        target: target(value, refs),
        x: value.x,
        y: value.y,
        button: value.button,
        clickCount: value.clickCount,
      };
    }
    case "type": {
      const value = decodeType(input);
      if (value.timeoutMs !== undefined)
        throw new PhiBrowserInputError({ reason: "unsupported-option" });
      return {
        operation,
        target: target(value, refs),
        text: value.text,
        clear: value.clear ?? false,
      };
    }
    case "press": {
      const value = decodePress(input);
      // The public skill helper sends key events, without the native editing
      // commands that macOS Meta shortcuts require. Refuse instead of claiming
      // success after an event that does not perform the requested shortcut.
      if (value.modifiers?.includes("Meta"))
        throw new PhiBrowserInputError({ reason: "unsupported-shortcut" });
      const masks = { Alt: 1, Control: 2, Meta: 4, Shift: 8 };
      return {
        operation,
        key: value.key,
        modifiers: (value.modifiers ?? []).reduce((bits, key) => bits | masks[key], 0),
      };
    }
    case "scroll": {
      const value = decodeScroll(input);
      // The skill can scroll at coordinates, but not a semantic container.
      // Clicking a container to focus it would introduce an unrelated action.
      if (value.locator !== undefined || value.selector !== undefined) {
        throw new PhiBrowserInputError({ reason: "unsupported-option" });
      }
      return { operation, dx: value.deltaX ?? 0, dy: value.deltaY ?? 0 };
    }
    case "handoff": {
      if (
        typeof input !== "object" ||
        input === null ||
        !("message" in input) ||
        typeof input.message !== "string" ||
        input.message.length > 500
      ) {
        throw new PhiBrowserInputError({ reason: "invalid-input" });
      }
      return { operation, message: input.message };
    }
    case "resume":
      return { operation };
    case "status":
    case "snapshot":
    case "close":
      return { operation };
    default:
      throw new PhiBrowserInputError({ reason: "unsupported-operation" });
  }
}

/**
 * Fixed runner program. Only JSON data is appended by the transport. No tool
 * argument becomes executable code, a shell command, page evaluation or CDP.
 * The runner itself selects the supported local/remote connection route.
 */
export const PHI_RUNNER_PROGRAM = String.raw`
if (request.probe) {
  await listAgentSpaces();
  cliLog(JSON.stringify({t3Phi: {result: {}, context: null}}));
  return;
}
if (request.context.kind === 'agent' && request.action.operation === 'close' && (request.targetId || request.allocationUrl)) {
  // Never create or replace the persistent Space while recovering an open.
  const tasks = await listAgentSpaces();
  const task = tasks.find(task => task.taskId === request.context.name);
  if (task) {
    await enterContext(request.context);
    const tabs = await listTabs();
    const owned = tabs.filter(tab => request.targetId ? tab.targetId === request.targetId : tab.url === request.allocationUrl);
    if (owned.length && task.ownership === 'user') throw new Error('user is controlling this agent space');
    for (const tab of owned) {
      await closeTab(tab.targetId);
    }
  }
  cliLog(JSON.stringify({t3Phi: {result: {}, context: null}}));
  return;
}
if (request.context.kind === 'agent' &&
    !['open', 'status'].includes(request.action.operation) && !request.targetId) {
  throw new Error('An Agents operation requires the task-owned tab identifier');
}
if (request.action.operation === 'close' && request.context.kind === 'shadow') {
  // Close by the name recorded before allocation, even if the allocating
  // request was interrupted before its identifier reached T3. Never bind a
  // missing context merely to clean it up.
  try {
    await closeShadowWindow(request.context.name);
  } catch (error) {
    // No resource was allocated, or an earlier cleanup already removed it.
    // Keep connection, permission and other cleanup failures recoverable.
    if (error?.reply?.error !== 'unknown_task') throw error;
  }
  cliLog(JSON.stringify({t3Phi: {result: {}, context: null}}));
  return;
}
if (request.expectedWindow !== undefined && request.context.kind === 'shadow') {
  const windows = await listShadowWindows();
  if (!windows.some(window => window.windowId === request.expectedWindow)) {
    throw new Error('Phi window was lost; refusing a replacement context');
  }
}
if (request.expectedWindow !== undefined && request.context.kind === 'agent') {
  const tasks = await listAgentSpaces();
  if (!tasks.some(task => task.taskId === request.context.name && task.windowId === request.expectedWindow)) {
    throw new Error('Phi Agents context is unavailable to this driver; refusing a replacement context');
  }
}
const ctx = await enterContext(request.context);
if (request.expectedWindow !== undefined && ctx.windowId !== request.expectedWindow) {
  if (request.context.kind === 'shadow') await closeShadowWindow(request.context.name);
  throw new Error('Phi window was lost; refusing a replacement context');
}
if (ctx.pendingUserMessages && request.action.operation !== 'status') throw new Error('Phi has pending human instructions; read status through the owning task');
if (request.targetId) {
  const tabs = await listTabs();
  if (!tabs.some(tab => tab.targetId === request.targetId)) throw new Error('Phi tab was lost');
}
const op = request.action;
if (request.context.kind === 'shadow' && ['click', 'type', 'press', 'scroll'].includes(op.operation)) {
  const page = await observe();
  if (page.elements?.some(element => element.type === 'password' && !element.hidden)) {
    cliLog(JSON.stringify({t3Phi: {result: null, context: currentContext(), failure: 'login-required'}}));
    return;
  }
}
let result;
if (op.operation === 'status') {
  result = { context: currentContext(), tabs: await listTabs(),
    ...(request.context.kind === 'agent' ? { space: await spaceStatus(), humanMessages: ctx.pendingUserMessages && request.readHumanMessages ? await readUserMessages() : [] } : {}) };
} else if (op.operation === 'handoff') {
  if (request.context.kind !== 'agent') throw new Error('Handoff requires the Agents lane');
  await handOff(op.message);
  result = {};
} else if (op.operation === 'resume') {
  if (request.context.kind !== 'agent') throw new Error('Resume requires the Agents lane');
  if (await ownership() !== 'agent') throw new Error('Wait for human hand-back before resuming');
  result = {};
} else {
  if (request.targetId) await switchTab(request.targetId);
  // Both lanes handle close above; this switch only operates on a live owned tab.
  switch (op.operation) {
    case 'open': result = await openTab(request.allocationUrl ?? op.url, {reuseBlank: request.context.kind === 'shadow'}); break;
    case 'navigate': result = await goto(op.url, {timeout: op.timeout}); break;
    case 'snapshot': {
      const observed = await observe();
      const text = await snapshotText({maxChars: 20000});
      const file = await screenshot();
      const fs = require('node:fs');
      try {
        const png = fs.readFileSync(file);
        result = { observed, text, screenshot: {mimeType: 'image/png', data: png.toString('base64'),
          width: png.readUInt32BE(16), height: png.readUInt32BE(20)} };
      } finally { fs.unlinkSync(file); }
      break;
    }
    case 'click': result = op.target !== undefined
      ? await click(op.target, {button: op.button, clickCount: op.clickCount})
      : await click(op.x, op.y, {button: op.button, clickCount: op.clickCount}); break;
    case 'type':
      if (op.clear) result = await fillInput(op.target ?? 'loc=css::focus', op.text);
      else {
        if (op.target !== undefined) await click(op.target);
        result = await typeText(op.text);
      }
      break;
    case 'press': result = await pressKey(op.key, {modifiers: op.modifiers}); break;
    case 'scroll': result = await scroll({dx: op.dx, dy: op.dy}); break;
    default: throw new Error('Unsupported Phi operation');
  }
}
cliLog(JSON.stringify({t3Phi: {result: result ?? null, context: currentContext()}}));
`;
