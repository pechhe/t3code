import {
  PreviewAutomationClickInput,
  PreviewAutomationHoverInput,
  PreviewAutomationNavigateInput,
  PreviewAutomationOpenInput,
  PreviewAutomationPressInput,
  PreviewAutomationResizeInput,
  PreviewAutomationScrollInput,
  PreviewAutomationSnapshotInput,
  PreviewAutomationTypeInput,
  PreviewAutomationWaitForInput,
  type PreviewAutomationOperation,
  type PreviewViewportSetting,
} from "@t3tools/contracts";
import { normalizePreviewUrl } from "@t3tools/shared/preview";
import { resolvePreviewViewport } from "@t3tools/shared/previewViewport";
import * as Schema from "effect/Schema";

const decodeOpen = Schema.decodeUnknownSync(PreviewAutomationOpenInput);
const decodeNavigate = Schema.decodeUnknownSync(PreviewAutomationNavigateInput);
const decodeClick = Schema.decodeUnknownSync(PreviewAutomationClickInput);
const decodeHover = Schema.decodeUnknownSync(PreviewAutomationHoverInput);
const decodeType = Schema.decodeUnknownSync(PreviewAutomationTypeInput);
const decodePress = Schema.decodeUnknownSync(PreviewAutomationPressInput);
const decodeScroll = Schema.decodeUnknownSync(PreviewAutomationScrollInput);
const decodeWaitFor = Schema.decodeUnknownSync(PreviewAutomationWaitForInput);
const decodeSnapshotInput = Schema.decodeUnknownSync(PreviewAutomationSnapshotInput);
const decodeResize = Schema.decodeUnknownSync(PreviewAutomationResizeInput);

export const PHI_OPERATIONS = [
  "open",
  "status",
  "navigate",
  "snapshot",
  "click",
  "hover",
  "type",
  "press",
  "scroll",
  "waitFor",
  "resize",
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
  readonly textAbsent?: string | undefined;
  readonly absentTarget?: string | undefined;
  readonly urlIncludes?: string | undefined;
  readonly viewport?: PreviewViewportSetting | undefined;
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
      return {
        operation,
        target: target(value, refs),
        timeout: value.timeoutMs === undefined ? undefined : value.timeoutMs / 1000,
        x: value.x,
        y: value.y,
        button: value.button,
        clickCount: value.clickCount,
      };
    }
    case "hover": {
      const value = decodeHover(input);
      return {
        operation,
        target: target(value, refs),
        timeout: value.timeoutMs === undefined ? undefined : value.timeoutMs / 1000,
        x: value.x,
        y: value.y,
      };
    }
    case "type": {
      const value = decodeType(input);
      return {
        operation,
        target: target(value, refs),
        timeout: value.timeoutMs === undefined ? undefined : value.timeoutMs / 1000,
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
      return {
        operation,
        target: target(value, refs),
        dx: value.deltaX ?? 0,
        dy: value.deltaY ?? 0,
      };
    }
    case "waitFor": {
      const value = decodeWaitFor(input);
      const absentTarget = target({ locator: value.locatorAbsent }, refs);
      // Phi's role lookup sees only the first match, which could be hidden while another shows.
      if (absentTarget?.startsWith("loc=role:"))
        throw new PhiBrowserInputError({ reason: "unsupported-option" });
      return {
        operation,
        target: target(value, refs),
        text: value.text,
        textAbsent: value.textAbsent,
        absentTarget,
        urlIncludes: value.urlIncludes,
        timeout: (value.timeoutMs ?? 15_000) / 1000,
      };
    }
    case "resize": {
      const value = decodeResize(input);
      return { operation, viewport: resolvePreviewViewport(value) };
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
    case "snapshot":
      return { operation, target: target(decodeSnapshotInput(input), refs) };
    case "status":
    case "close":
      return { operation };
    default:
      throw new PhiBrowserInputError({ reason: "unsupported-operation" });
  }
}

/**
 * Page function behind a Phi `locatorAbsent`: whether any element matching a CSS selector shows,
 * in the page or in a same-origin frame that itself shows. A bad selector throws, since failing
 * to look is not evidence that the element is gone. Kept as source because it runs in the page.
 */
export const PHI_ANY_VISIBLE_MATCH = String.raw`(selector) => {
  const shown = (element) => {
    const box = element.getBoundingClientRect();
    const style = element.ownerDocument.defaultView.getComputedStyle(element);
    return box.width > 0 && box.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const documents = (root) => [root, ...Array.from(root.querySelectorAll('iframe, frame')).flatMap(frame => {
    try {
      return shown(frame) && frame.contentDocument ? documents(frame.contentDocument) : [];
    } catch {
      return [];
    }
  })];
  return documents(document).some(root => Array.from(root.querySelectorAll(selector)).some(shown));
}`;

/**
 * Page function behind a snapshot's ARIA state: one control's pressed, selected, expanded, checked
 * and current state, from its ARIA attributes and, for a native checkbox or radio, its checked
 * property. It only reads, takes no argument and is called with the control as `this`; Phi's scan
 * records none of this. Kept as source because it runs in the page.
 */
export const PHI_ARIA_STATE = String.raw`function () {
  const states = [];
  for (const name of ['pressed', 'selected', 'expanded', 'checked', 'current']) {
    const value = this.getAttribute('aria-' + name);
    if (value !== null) states.push(name + '=' + value);
  }
  if (this.localName === 'input' && (this.type === 'checkbox' || this.type === 'radio') &&
      this.getAttribute('aria-checked') === null) states.push('checked=' + this.checked);
  return states.join(' ');
}`;

/**
 * Page function behind the check that any control could carry ARIA state, in the page or a
 * same-origin frame, which is as far as Phi's own scan reaches: it lists no control inside a shadow
 * root or a cross-origin frame. Most pages have none, and a snapshot then skips the per-control reads.
 * Kept as source because it runs in the page.
 */
const PHI_HAS_ARIA_STATE = String.raw`() => {
  const documents = (root) => [root, ...Array.from(root.querySelectorAll('iframe, frame')).flatMap(frame => {
    try {
      return frame.contentDocument ? documents(frame.contentDocument) : [];
    } catch {
      return [];
    }
  })];
  const selector = '[aria-pressed],[aria-selected],[aria-expanded],[aria-checked],[aria-current],input[type=checkbox],input[type=radio]';
  return documents(document).some(root => root.querySelector(selector) !== null);
}`;

/**
 * Fixed runner program. Only JSON data is appended by the transport. No tool
 * argument becomes executable code, a shell command, page evaluation or CDP.
 * The runner itself selects the supported local/remote connection route.
 */
export const PHI_RUNNER_PROGRAM = String.raw`
const userSpaceUnavailable = () =>
  Object.assign(new Error('The user Space is unavailable'), {t3Failure: 'user-space-unavailable'});
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
if (request.context.kind === 'user') {
  if (request.context.window === undefined) {
    // Open works where the user is looking now; every later round stays pinned to that window.
    const focus = await userFocus();
    if (focus.isAgentSpace || focus.isIncognito || focus.windowId === undefined ||
        (request.attachFocusedTab && !focus.tab?.targetId)) throw userSpaceUnavailable();
    request.context = {kind: 'user', window: focus.windowId};
    if (request.attachFocusedTab) request.targetId = focus.tab.targetId;
  }
  if (request.action.operation === 'close') {
    // T3 closes only a tab the agent opened here; the user's own tabs are released, never closed.
    await enterContext(request.context);
    if ((await listTabs()).some(tab => tab.targetId === request.targetId)) await closeTab(request.targetId);
    cliLog(JSON.stringify({t3Phi: {result: {}, context: null}}));
    return;
  }
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
  if (!tabs.some(tab => tab.targetId === request.targetId))
    throw request.context.kind === 'user' ? userSpaceUnavailable() : new Error('Phi tab was lost');
}
const op = request.action;
// Phi's scan treats an element without a box as invisible and skips everything inside it. A
// display:contents wrapper never has a box, so a SvelteKit app (rooted in one) scans as empty.
// Also scan the boxed children of such wrappers; refs are node ids, so the scans merge cleanly.
// Runs in the page: XPaths of the boxed children of display:contents wrappers, and the visible
// text sitting directly inside those wrappers, which no scan root reaches.
const contentsRoots = (root) => {
  const path = (el) => {
    const steps = [];
    for (; el && el.nodeType === 1; el = el.parentElement) {
      let index = 1;
      for (let sibling = el.previousElementSibling; sibling; sibling = sibling.previousElementSibling)
        if (sibling.tagName === el.tagName) index++;
      steps.unshift(el.localName + '[' + index + ']');
    }
    return '/' + steps.join('/');
  };
  const roots = [];
  const texts = [];
  for (const wrapper of root.querySelectorAll('*')) {
    if (getComputedStyle(wrapper).display !== 'contents') continue;
    for (const node of wrapper.childNodes) {
      if (node.nodeType === 3) {
        const text = node.textContent.trim();
        const range = document.createRange();
        range.selectNodeContents(node);
        const box = range.getBoundingClientRect();
        if (text && (box.width || box.height)) texts.push(text);
      } else if (node.nodeType === 1 && getComputedStyle(node).display !== 'contents') {
        const box = node.getBoundingClientRect();
        // A hidden root would make Phi scan its subtree as hidden, controls and prose included.
        if ((box.width || box.height) && getComputedStyle(node).visibility !== 'hidden') roots.push(path(node));
      }
    }
    if (roots.length >= 50) break;
  }
  return {roots, texts};
};
// The server cuts long names, then bounds the text, so the scan must not cut it first: a cut
// could take the later controls' refs with it.
const MAX_SCAN_CHARS = 200000;
const MAX_STATE_READS = 100;
// Each read is a round trip to the browser; the snapshot itself still has to finish in time.
const STATE_READ_BUDGET_MS = 4000;
const hasAriaState = ${PHI_HAS_ARIA_STATE};
const ariaState = ${JSON.stringify(PHI_ARIA_STATE)};
const scanPage = async (withText, within) => {
  const observed = await observe({within});
  const parts = withText ? [await snapshotText({within, maxChars: MAX_SCAN_CHARS})] : [];
  if (observed.dialog) return {observed, text: parts[0] ?? '', omitted: 0};
  // The wrappers inside the scope: a scoped scan skips them just as a full one does.
  const {roots, texts} = within === undefined
    ? await js('(' + contentsRoots + ')(document.body)')
    : await callOnElement(within, 'function () { return (' + contentsRoots + ')(this); }');
  observed.elements = observed.elements ?? [];
  for (const root of roots) {
    const scope = 'xpath=' + root;
    observed.elements.push(...((await observe({within: scope})).elements ?? []));
    if (withText) parts.push(await snapshotText({within: scope, maxChars: MAX_SCAN_CHARS}));
  }
  if (!withText) return {observed, text: '', omitted: 0};
  // Hidden and zero-size controls are left out of every scan; this says how many, so an agent
  // can tell a page that is empty from one whose controls are not showing. A control under a
  // boxless wrapper is flagged hidden but was recovered above, so it does not count.
  const shown = new Set(observed.elements.map(element => element.ref));
  const omitted = ((await observe({within, showHidden: true})).elements ?? [])
    .filter(element => element.hidden && !shown.has(element.ref)).length;
  // Each part arrives in the untrusted-content envelope; keep one around the merged body.
  const lines = parts[0].split('\n');
  // Raw wrapper text gets the skill's envelope-marker neutralising, as its own text does.
  const neutral = texts.map(text => text.replace(/^(\s*)--- (BEGIN|END) UNTRUSTED/gm, '$1~~~ $2 UNTRUSTED'));
  const body = [...parts.map(part => part.split('\n').slice(1, -1).join('\n')), ...neutral]
    .filter(Boolean).join('\n').slice(0, MAX_SCAN_CHARS);
  return {observed, omitted, text: [lines[0], body, lines.at(-1)].join('\n')};
};
if (request.context.kind === 'shadow' && ['click', 'type', 'press', 'scroll'].includes(op.operation)) {
  const page = (await scanPage(false)).observed;
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
  // The skill's viewport override lasts one round, so a resized tab is re-sized every round.
  const viewport = op.operation === 'resize' ? op.viewport : request.viewport;
  const rendered = viewport && viewport._tag !== 'fill'
    ? await setViewport({width: viewport.width, height: viewport.height})
    : op.operation === 'resize' ? await setViewport() : undefined;
  // Both lanes handle close above; this switch only operates on a live owned tab.
  try {
    // A requested timeout bounds the wait for the target to appear; the helpers then act on it.
    if (['click', 'hover', 'type'].includes(op.operation) && op.target !== undefined && op.timeout !== undefined)
      await waitForElement(op.target, {timeout: op.timeout});
    switch (op.operation) {
      case 'open': result = request.attachFocusedTab
        ? {targetId: request.targetId}
        : await openTab(request.allocationUrl ?? op.url, {reuseBlank: request.context.kind === 'shadow'}); break;
      case 'navigate': result = await goto(op.url, {timeout: op.timeout}); break;
      case 'snapshot': {
        const {observed, text, omitted} = await scanPage(true, op.target);
        // Phi's scan carries no ARIA state, so ask each control, up to a bound and a time budget.
        // A control that has since gone away is skipped: its absence from the list is not a state.
        const states = {};
        const controls = (observed.elements ?? []).filter(element =>
          element.ref !== null && element.role !== 'iframe' && element.role !== 'editable');
        const asked = controls.slice(0, MAX_STATE_READS);
        const stateDeadline = Date.now() + STATE_READ_BUDGET_MS;
        let read = 0;
        if (asked.length && await js('(' + hasAriaState + ')()')) {
          for (; read < asked.length && Date.now() < stateDeadline; read++) {
            try {
              const state = await callOnElement('@' + asked[read].ref, ariaState);
              if (state) states[asked[read].ref] = state;
            } catch (error) {
              if (!/target not found/.test(error?.message ?? '')) throw error;
            }
          }
        } else read = controls.length;
        const file = await screenshot();
        const fs = require('node:fs');
        try {
          const png = fs.readFileSync(file);
          result = { observed, text, omitted, states, statesSkipped: controls.length - read, screenshot: {mimeType: 'image/png', data: png.toString('base64'),
            width: png.readUInt32BE(16), height: png.readUInt32BE(20)} };
        } finally { fs.unlinkSync(file); }
        break;
      }
      case 'hover': result = op.target !== undefined ? await hover(op.target) : await hover(op.x, op.y); break;
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
      case 'scroll': {
        // A target scrolls whatever container sits under its centre, without clicking it.
        const at = op.target === undefined ? {} : await waitForElement(op.target, {timeout: 5});
        result = await scroll({dx: op.dx, dy: op.dy, x: at.x, y: at.y});
        break;
      }
      case 'waitFor': {
        // The text and URL arrive as JSON string literals inside a fixed condition: data, not code.
        const pageText = '(document.body ? document.body.innerText : "")';
        const conditions = [];
        if (op.text !== undefined) conditions.push([pageText + '.includes(' + JSON.stringify(op.text) + ')', 'text']);
        if (op.textAbsent !== undefined) conditions.push(['!' + pageText + '.includes(' + JSON.stringify(op.textAbsent) + ')', 'textAbsent']);
        if (op.urlIncludes !== undefined) conditions.push(['location.href.includes(' + JSON.stringify(op.urlIncludes) + ')', 'urlIncludes']);
        // One probe: true when met, false on the helper's timeout. A dialog stops the wait.
        const holds = async (probe) => {
          try {
            if ((await probe)?.dialog) throw new Error('A JavaScript dialog interrupted the wait');
            return true;
          } catch (error) {
            if (/timed out/.test(error?.message ?? '')) return false;
            throw error;
          }
        };
        // A CSS selector can match several elements, and Phi's own lookup sees only the first, which
        // may be hidden while a later one still shows. The selector arrives as a JSON string literal.
        const anyVisibleMatch = ${PHI_ANY_VISIBLE_MATCH};
        const stillShown = (target) => target.startsWith('loc=css:')
          ? js('(' + anyVisibleMatch + ')(' + JSON.stringify(target.slice(8)) + ')')
          : holds(waitForElement(target, {timeout: 0.25}));
        const deadline = Date.now() + op.timeout * 1000;
        // Every condition is checked again on each poll, so they hold at the same moment.
        for (;;) {
          const failing = [];
          if (op.target !== undefined && !await holds(waitForElement(op.target, {timeout: 0.25}))) failing.push('locator');
          // Hidden counts as gone, as for a missing element: waitForElement looks for a visible one.
          if (op.absentTarget !== undefined && await stillShown(op.absentTarget)) failing.push('locatorAbsent');
          for (const [expression, name] of conditions)
            if (!await holds(waitForFunction(expression, {timeout: 0}))) failing.push(name);
          if (!failing.length) break;
          if (Date.now() >= deadline) {
            cliLog(JSON.stringify({t3Phi: {result: null, context: currentContext(), failure: 'action-failed',
              unmet: failing}}));
            return;
          }
          await wait(0.25);
        }
        result = {};
        break;
      }
      case 'resize': result = {width: rendered.width, height: rendered.height}; break;
      default: throw new Error('Unsupported Phi operation');
    }
  } catch (error) {
    // The skill's own page-level refusals and timeouts. Anything else, such as a lost connection
    // or a human takeover, keeps its own meaning.
    if (!/timed out|target not found|not human-operable|target moved|navigation to .* failed|dialog (is open|interrupted)/.test(error?.message ?? '')) throw error;
    cliLog(JSON.stringify({t3Phi: {result: null, context: currentContext(), failure: 'action-failed'}}));
    return;
  }
}
cliLog(JSON.stringify({t3Phi: {result: result ?? null, context: currentContext()}}));
`;
