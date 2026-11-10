// @effect-diagnostics nodeBuiltinImport:off globalDate:off globalTimers:off - Playwright callbacks run outside the Effect runtime.

import {
  type BrowserRecordingFrameRate,
  PROVIDER_SEND_TURN_MAX_FILE_BYTES,
  type PreviewAutomationClickInput,
  type PreviewAutomationConsoleEntry,
  type PreviewAutomationDragInput,
  type PreviewAutomationEvaluateInput,
  type PreviewAutomationHoverInput,
  type PreviewAutomationNetworkEntry,
  type PreviewAutomationPressInput,
  type PreviewAutomationScrollInput,
  type PreviewAutomationSelectInput,
  type PreviewAutomationSelectResult,
  type PreviewAutomationSnapshot,
  type PreviewAutomationTypeInput,
  type PreviewAutomationUploadInput,
  type PreviewAutomationWaitForInput,
} from "@t3tools/contracts";
import { constVoid } from "effect/Function";
import * as Schema from "effect/Schema";
import type {
  CDPSession,
  ConsoleMessage,
  ElementHandle,
  Frame,
  Locator,
  Page,
} from "playwright-core";
import * as NodeCrypto from "node:crypto";
import { BrowserControlInterrupted, BrowserTaskLeaseHeld } from "./SessionControl.ts";

const isBrowserControlInterrupted = Schema.is(BrowserControlInterrupted);
const isBrowserTaskLeaseHeld = Schema.is(BrowserTaskLeaseHeld);

const MAX_EVALUATION_BYTES = 64_000;
const MAX_VISIBLE_TEXT_LENGTH = 20_000;
/** A bounded task reads this in process to prove targets unique; none of it reaches a model. */
export const TASK_SNAPSHOT_TEXT_LENGTH = 1_000_000;
const MAX_SCREENSHOT_WIDTH = 1280;
const WAIT_POLL_MS = 100;
export const DIAGNOSTIC_BUFFER_LIMIT = 200;

export class ServerBrowserOperationError extends Schema.TaggedError<ServerBrowserOperationError>()(
  "ServerBrowserOperationError",
  {
    tag: Schema.String,
    message: Schema.String,
    detail: Schema.optional(Schema.Unknown),
    cause: Schema.optional(Schema.Defect()),
  },
) {}

const isServerBrowserOperationError = Schema.is(ServerBrowserOperationError);

export const toOperationError = (
  cause: unknown,
  timeoutMs?: number,
): ServerBrowserOperationError => {
  if (isBrowserControlInterrupted(cause))
    return new ServerBrowserOperationError({
      tag: "PreviewAutomationControlInterruptedError",
      message: cause.message,
      detail: cause.reason,
    });
  if (isBrowserTaskLeaseHeld(cause))
    return new ServerBrowserOperationError({
      tag: "PreviewAutomationExecutionError",
      message: cause.message,
    });
  if (isServerBrowserOperationError(cause)) return cause;
  const message = cause instanceof Error ? cause.message : String(cause);
  const firstLine = message.split("\n")[0] ?? message;
  if (cause instanceof Error && cause.name === "TimeoutError") {
    return new ServerBrowserOperationError({
      tag: "PreviewAutomationTimeoutError",
      message: firstLine,
      detail: timeoutMs === undefined ? undefined : { timeoutMs },
    });
  }
  if (
    /while parsing selector|Unknown engine|Unexpected token|strict mode violation/i.test(message)
  ) {
    return new ServerBrowserOperationError({
      tag: "PreviewAutomationInvalidSelectorError",
      message: firstLine,
    });
  }
  if (/not an <input>|not editable|not an editable/i.test(message)) {
    return new ServerBrowserOperationError({
      tag: "PreviewAutomationTargetNotEditableError",
      message: firstLine,
    });
  }
  return new ServerBrowserOperationError({
    tag: "PreviewAutomationExecutionError",
    message: firstLine,
  });
};

const DEFAULT_TIMEOUT_MS = 15_000;
const TARGET_COUNT_MS = 250;
const MAX_TARGET_CHARS = 200;

const pageRefs = new WeakMap<Page, { generation: string; refs: Map<string, string> }>();
// A compact runtime namespace prevents old refs from aliasing after a server restart.
const refNamespace = NodeCrypto.randomUUID().slice(0, 8);
let snapshotSequence = 0;
const nextRefGeneration = () => `${refNamespace}-${(++snapshotSequence).toString(36)}`;

/** A takeover revokes previously issued refs even when the document stays unchanged. */
export const invalidateRefs = (page: Page) => {
  const state = pageRefs.get(page);
  if (state) {
    state.generation = nextRefGeneration();
    state.refs.clear();
  }
};

const refsFor = (page: Page) => {
  let state = pageRefs.get(page);
  if (!state) {
    state = { generation: nextRefGeneration(), refs: new Map<string, string>() };
    pageRefs.set(page, state);
    page.on("framenavigated", () => invalidateRefs(page));
    page.on("framedetached", () => invalidateRefs(page));
  }
  return state;
};

const targetLocator = (
  page: Page,
  input: { readonly locator?: string | undefined; readonly selector?: string | undefined },
): Locator | null => {
  const selector = input.locator ?? input.selector;
  if (selector === undefined) return null;
  const engines = selector.replace(
    /\\.|"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`(?:\\.|[^`\\])*`/g,
    " ",
  );
  if (/(?:^|>>)\s*\*?aria-ref\s*=/.test(engines)) {
    const ref = /^\s*aria-ref\s*=\s*(\S+)\s*$/.exec(selector)?.[1];
    const nativeRef = ref === undefined ? undefined : pageRefs.get(page)?.refs.get(ref);
    if (nativeRef === undefined) {
      throw new ServerBrowserOperationError({
        tag: "PreviewAutomationInvalidSelectorError",
        message:
          "This element ref is stale or belongs to another tab. Take a fresh snapshot and use its locator.",
        detail: { staleRef: true },
      });
    }
    return page.locator(`aria-ref=${nativeRef}`);
  }
  // Playwright's strict locators reject ambiguous controls rather than acting on row one.
  return page.locator(selector);
};

export type PointerReporter = (
  point: { readonly x: number; readonly y: number },
  phase: "move" | "click",
) => Promise<void>;
const noPointer: PointerReporter = async () => {};

const targetPoint = async (
  page: Page,
  locator: Locator | null,
  input: { readonly x?: number | undefined; readonly y?: number | undefined },
  timeout: number,
) => {
  if (locator === null) return { x: input.x ?? 0, y: input.y ?? 0 };
  await locator.scrollIntoViewIfNeeded({ timeout });
  const box = await locator.boundingBox({ timeout });
  if (box) return { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const viewport = page.viewportSize();
  return { x: (viewport?.width ?? 0) / 2, y: (viewport?.height ?? 0) / 2 };
};

const SNAPSHOT_SCRIPT = `(() => {
  return {
    url: location.href,
    title: document.title,
    loading: document.readyState !== "complete",
    visibleText: document.body?.innerText || "",
    interactiveElements: [],
  };
})()`;

const MASKED_VALUE = "••••••••";

/**
 * A `data:` URL carries its content, which can be a whole file, and URLs and diagnostics
 * reach tool results and provider logs. Keeps only the media type: the payload can hold any
 * character and parameters are page-chosen too.
 */
export const withoutDataPayload = (url: string) => {
  // Read the scheme as a browser would: it ignores leading controls and spaces, and tabs and
  // newlines anywhere. A snapshot's YAML value may be quoted and escaped; an escape that isn't a
  // tab or newline still decodes to something that can't start a scheme.
  const value = url
    .replace(/^["']/, "")
    .replace(/\\(x[\da-f]{2}|u[\da-f]{4}|.)/gi, (_escape, code: string) =>
      code.length > 1
        ? String.fromCharCode(Number.parseInt(code.slice(1), 16))
        : ({ t: "\t", n: "\n", r: "\r", '"': '"', "\\": "\\" }[code] ?? "\u0001"),
    )
    .replace(/[\t\n\r]/g, "")
    .replace(/^[\u0000-\u0020]+/, "");
  const parsed = /^data:([^,;]*)/i.exec(value);
  if (!parsed) return url;
  const type = parsed[1]!.trim();
  const mediaType = /^[\w.+-]{1,64}\/[\w.+-]{1,64}$/.test(type) ? type : "";
  return `data:${mediaType},…`;
};

/**
 * Chromium's own console messages, which carry no arguments, quote `data:` URLs whole, as in a
 * blocked navigation or a CSP violation. Everything after the first one goes, since Chromium
 * accepts any type and a payload can hold any character. What a page logs itself is its own
 * text, like anything else it shows, so it stays.
 */
export const consoleText = (message: ConsoleMessage) =>
  message.args().length > 0
    ? message.text()
    : message.text().replace(/(?<![a-z\d])data:[^,;]*[,;][\s\S]*/i, withoutDataPayload);

// Split on LF alone: a value keeps any U+2028 that a multiline regex would treat as a line end.
const withoutTreeDataPayloads = (tree: string) =>
  tree
    .split("\n")
    .map((line) => {
      const url = /^(\s*- \/url: )(.*)$/s.exec(line);
      return url ? url[1] + withoutDataPayload(url[2]!) : line;
    })
    .join("\n");

// The broker waits 15s for the host; a snapshot, retry included, answers well before.
const SNAPSHOT_TIMEOUT_MS = 10_000;
const FRAME_ANSWER_MS = 1_000;

// Include password and CSS-masked text in open shadow roots, normalized like accessible text.
const DOTTED_SCRIPT = `(() => {
  const values = [];
  const visit = (root) => {
    for (const element of root.querySelectorAll("*")) {
      if (element.shadowRoot) visit(element.shadowRoot);
      const field = element.localName === "input" || element.localName === "textarea";
      if (!field && !element.isContentEditable) continue;
      const dots = getComputedStyle(element).getPropertyValue("-webkit-text-security");
      if (element.type !== "password" && (dots === "none" || dots === "")) continue;
      // Raw as page text shows it, and normalized as the tree does.
      for (const value of field ? [element.value, element.defaultValue] : [element.textContent ?? ""])
        values.push(value, value.replace(/[\\u200b\\u00ad]/g, "").trim().replace(/\\s+/g, " "));
    }
  };
  visit(document);
  return [...new Set(values.filter((value) => value.trim()))];
})()`;

const pageChanged = () =>
  new ServerBrowserOperationError({
    tag: "PreviewAutomationExecutionError",
    message: "The page changed while capturing its snapshot. Take another snapshot.",
  });

const tooBusy = () =>
  new ServerBrowserOperationError({
    tag: "PreviewAutomationTimeoutError",
    message:
      "The page was too busy to capture a snapshot in time. Wait for it to settle and take another snapshot.",
  });

const VALUE_TOO_LONG = "A password field holds a value too long to hide, so no snapshot was taken.";

/** Reuse one CDP session per out-of-process frame across snapshots. */
const frameSessions = new WeakMap<Frame, Promise<CDPSession>>();

/** Returns undefined on failure or frame timeout. */
const answered = <A>(promise: Promise<A>) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<undefined>((resolve) => {
    timer = setTimeout(() => resolve(undefined), FRAME_ANSWER_MS);
  });
  return Promise.race([promise.catch(() => undefined), late]).finally(() => clearTimeout(timer));
};

/** Isolated worlds prevent spoofing; desktop out-of-process frames use page worlds. Missing own-frame reads or changed frames fail; other missing reads return undefined. */
const openReaders = async (page: Page, cdp: CDPSession, expression: string = DOTTED_SCRIPT) => {
  const frames = page.frames();
  const owners = new Map<Frame, CDPSession | null | undefined>(
    await Promise.all(
      frames.map(async (frame) => {
        if (frame === page.mainFrame()) return [frame, cdp] as const;
        const session = frameSessions.get(frame) ?? page.context().newCDPSession(frame);
        frameSessions.set(frame, session);
        try {
          return [frame, await session] as const;
        } catch (cause) {
          frameSessions.delete(frame);
          // CdpRelay supports only the page; other refusals fall back to the parent session, failing if the frame is absent.
          const desktop = String(cause).includes("Only this preview tab's page can be attached");
          return [frame, desktop ? null : undefined] as const;
        }
      }),
    ),
  );
  const ownerOf = (frame: Frame): CDPSession | null => {
    const owner = owners.get(frame);
    if (owner !== undefined) return owner;
    const parent = frame.parentFrame();
    return parent ? ownerOf(parent) : null;
  };
  const sessionReader = (frame: Frame, session: CDPSession) => {
    const owned = frames.filter((each) => ownerOf(each) === session);
    const open = async () => {
      const { frameTree } = await session.send("Page.getFrameTree");
      const ids = (node: typeof frameTree): Array<string> => [
        node.frame.id,
        ...(node.childFrames ?? []).flatMap(ids),
      ];
      // A frame Playwright knows but this session doesn't would go unread.
      if (ids(frameTree).length !== owned.length) throw pageChanged();
      return Promise.all(
        ids(frameTree).map(async (frameId) => {
          const world = await session.send("Page.createIsolatedWorld", {
            frameId,
            worldName: "t3-preview",
          });
          return world.executionContextId;
        }),
      );
    };
    let contexts: ReturnType<typeof open> | undefined;
    const read = async () => {
      const values = (contexts ??= open()).then((ids) =>
        Promise.all(
          ids.map(async (contextId) => {
            const { result, exceptionDetails } = await session.send("Runtime.evaluate", {
              contextId,
              expression,
              returnByValue: true,
            });
            if (exceptionDetails) throw pageChanged();
            return result.value as Array<string>;
          }),
        ),
      );
      try {
        return (await values).flat();
      } catch (cause) {
        // The frame may have moved to another process; the next snapshot opens a new session.
        if (session !== cdp) {
          frameSessions.delete(frame);
          void session.detach().catch(constVoid);
        }
        throw cause;
      }
    };
    return { frames: owned, read };
  };
  const readers = [
    sessionReader(page.mainFrame(), cdp),
    ...frames.flatMap((frame) => {
      const owner = owners.get(frame);
      if (owner) return owner === cdp ? [] : [sessionReader(frame, owner)];
      // A page-world read would hand the expression's data to the frame's own script.
      const own = () =>
        expression === DOTTED_SCRIPT
          ? (frame.evaluate(DOTTED_SCRIPT) as Promise<Array<string>>)
          : Promise.reject(new Error("This frame has no isolated reader."));
      return ownerOf(frame) === null ? [{ frames: [frame], read: own }] : [];
    }),
  ];
  return {
    readers,
    read: async (before?: ReadonlyArray<unknown>) => {
      const now = page.frames();
      if (now.length !== frames.length || now.some((frame, i) => frame !== frames[i])) {
        throw pageChanged();
      }
      return Promise.all(
        readers.map((reader, i) => {
          if (i === 0) return reader.read().catch(() => Promise.reject(pageChanged()));
          return before && !before[i] ? undefined : answered(reader.read());
        }),
      );
    },
  };
};

/** Every frame's answer, true or false: does a value show in its text, attributes or a non-password field? */
const secretShownScript = (values: ReadonlyArray<string>) => `((values) => {
  const seen = (text) => typeof text === "string" && values.some((value) => text.includes(value));
  const visit = (root) => {
    // A document's own textContent is null; its root element's holds the page's text.
    if (seen((root.documentElement ?? root).textContent)) return true;
    for (const element of root.querySelectorAll("*")) {
      if (element.shadowRoot && visit(element.shadowRoot)) return true;
      const password = element.localName === "input" && element.type === "password";
      for (const attribute of element.attributes)
        if (!(password && attribute.name === "value") && seen(attribute.value)) return true;
      const field = ["input", "textarea", "select"].includes(element.localName);
      if (field && !password && seen(element.value)) return true;
    }
    return false;
  };
  return [visit(document)];
})(${JSON.stringify([...new Set(values.flatMap((value) => [value, value.replace(/\s+/g, " ").trim()]))].filter((value) => value.length > 0))})`;

/**
 * Asked of every frame in an isolated world, so page script never sees the values. A frame that
 * cannot answer counts as showing them.
 */
const secretShown = async (
  page: Page,
  cdp: CDPSession,
  values: ReadonlyArray<string>,
): Promise<boolean> => {
  if (values.length === 0) return false;
  try {
    const { read } = await openReaders(page, cdp, secretShownScript(values));
    const answers = (await read()) as ReadonlyArray<ReadonlyArray<unknown> | undefined>;
    return answers.some(
      (answer) =>
        answer === undefined || answer.length === 0 || answer.some((shown) => shown !== false),
    );
  } catch {
    return true;
  }
};

/** A screenshot refused because a saved login's value may show on the page. */
export const SECRET_VISIBLE_TAG = "TaskSecretVisible";

const secretVisible = () =>
  new ServerBrowserOperationError({
    tag: SECRET_VISIBLE_TAG,
    message:
      "A saved login's value may show on the page, so the screenshot was refused (secret-visible).",
  });

/** Short values need word boundaries to avoid masking unrelated text. */
const dottedPattern = (values: ReadonlyArray<string>) => {
  const sources = values
    .flatMap((value) => {
      const json = JSON.stringify(value).slice(1, -1);
      // Playwright writes control characters like JSON does, with \xNN for the unnamed ones.
      const quoted = value.replace(/[\\"\p{Cc}]/gu, (char) =>
        '\\"\b\f\n\r\t'.includes(char)
          ? JSON.stringify(char).slice(1, -1)
          : `\\x${char.charCodeAt(0).toString(16).padStart(2, "0")}`,
      );
      const forms = [value, json, quoted].flatMap((form) => [form, form.replaceAll("'", "''")]);
      return [...new Set(forms)].map((form) => ({ form, word: value.length < 4 }));
    })
    // Longest first, so a form inside another never leaves the rest showing.
    .toSorted((a, b) => b.form.length - a.form.length)
    .map(({ form, word }) => {
      const literal = form.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      return word ? `(?<![\\p{L}\\p{N}_])${literal}(?![\\p{L}\\p{N}_])` : literal;
    });
  if (sources.length === 0) return undefined;
  const pattern = new RegExp(sources.join("|"), "gu");
  try {
    // Force regex compilation for one-byte and two-byte strings now; size errors name every value.
    pattern.test("");
    pattern.test("\u2022");
  } catch {
    throw new ServerBrowserOperationError({
      tag: "PreviewAutomationExecutionError",
      message: VALUE_TOO_LONG,
    });
  }
  return pattern;
};

// Playwright single-quotes keys containing ': ' and leaves /.../ names unquoted. Recognize only its attributes so name text cannot spoof them.
const TREE_LINE =
  /^(\s*- '?[^\s"':]+)( "(?:[^"\\]|\\.)*"| \/(?:.*?\/)?)?((?: \[(?:active|checked(?:=mixed)?|disabled|expanded|level=\d+|pressed(?:=mixed)?|selected|ref=(?:f\d+)?e\d+|cursor=pointer|box=-?\d+,-?\d+,\d+,\d+)\])*'?)(:.*)?$/;

/** Preserve roles and attributes so refs work; unquoted /.../ names can make matches cross boundaries. */
const maskTree = (tree: string, dotted: RegExp) =>
  tree
    .split("\n")
    .map((line) => {
      const node = TREE_LINE.exec(line);
      const name = node?.[1]?.length ?? 0;
      const attributes = name + (node?.[2]?.length ?? 0);
      const end = attributes + (node?.[3]?.length ?? 0);
      const kept = (from: number, to: number) => to <= name || (from >= attributes && to <= end);
      return line.replace(dotted, (match: string, offset: number) =>
        kept(offset, offset + match.length) ? match : MASKED_VALUE,
      );
    })
    .join("\n");

/** Chromium sizes the capture, so the reported size is read from the PNG header. */
const pngSize = (base64: string) => {
  const header = Buffer.from(base64.slice(0, 32), "base64");
  return { width: header.readUInt32BE(16), height: header.readUInt32BE(20) };
};

/**
 * A page's display ratio and CSS viewport, read in an isolated world since page script can
 * reassign `devicePixelRatio`, `innerWidth`, and `innerHeight` in its own, and its page zoom.
 */
const readPageMetrics = async (cdp: CDPSession) => {
  const { frameTree } = await cdp.send("Page.getFrameTree");
  const { executionContextId } = await cdp.send("Page.createIsolatedWorld", {
    frameId: frameTree.frame.id,
    worldName: "t3-preview-metrics",
  });
  let { cssVisualViewport } = await cdp.send("Page.getLayoutMetrics");
  // Desktop zoom applies asynchronously; bracket the CSS metrics to reject a torn read.
  for (let attempt = 0; attempt < 3; attempt += 1) {
    const zoom = cssVisualViewport.zoom ?? 1;
    const { result } = await cdp.send("Runtime.evaluate", {
      expression: "({ ratio: devicePixelRatio, width: innerWidth, height: innerHeight })",
      contextId: executionContextId,
      returnByValue: true,
    });
    ({ cssVisualViewport } = await cdp.send("Page.getLayoutMetrics"));
    if ((cssVisualViewport.zoom ?? 1) === zoom) {
      const { ratio, width, height } = result.value as {
        readonly ratio: number;
        readonly width: number;
        readonly height: number;
      };
      return { ratio, width, height, zoom };
    }
  }
  throw new Error(
    "The page's zoom kept changing while the snapshot read its size. Try the snapshot again.",
  );
};

// Never pass a clip scale: Chromium mirrors the top-left of the page into a `backdrop-filter`
// in any capture it shrinks.
export const captureViewport = async (
  cdp: CDPSession,
  options: { readonly format: "png" | "jpeg"; readonly quality?: number },
) => {
  const { data } = await cdp.send("Page.captureScreenshot", {
    format: options.format,
    ...(options.quality === undefined ? {} : { quality: options.quality }),
  });
  return data;
};

/** Runs in the page's own isolated world, as the server has no image library. */
const SHRINK_PNG = `async function (png, width, height) {
  const bytes = Uint8Array.from(atob(png), (char) => char.charCodeAt(0));
  const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
  // Namespaced, as an XML document's createElement makes a plain element with no getContext.
  const canvas = document.createElementNS("http://www.w3.org/1999/xhtml", "canvas");
  canvas.width = width;
  canvas.height = height;
  const context = canvas.getContext("2d");
  context.imageSmoothingQuality = "high";
  context.drawImage(bitmap, 0, 0, width, height);
  bitmap.close();
  return canvas.toDataURL("image/png").slice("data:image/png;base64,".length);
}`;

const shrinkPng = async (cdp: CDPSession, png: string, scale: number) => {
  const size = pngSize(png);
  const { frameTree } = await cdp.send("Page.getFrameTree");
  const { executionContextId } = await cdp.send("Page.createIsolatedWorld", {
    frameId: frameTree.frame.id,
    worldName: "t3-preview-screenshot",
  });
  const { result, exceptionDetails } = await cdp.send("Runtime.callFunctionOn", {
    functionDeclaration: SHRINK_PNG,
    executionContextId,
    arguments: [
      { value: png },
      { value: Math.round(size.width * scale) },
      { value: Math.round(size.height * scale) },
    ],
    awaitPromise: true,
    returnByValue: true,
  });
  if (exceptionDetails) throw new Error("The snapshot could not shrink its screenshot.");
  return result.value as string;
};

type SnapshotInput = {
  readonly locator?: string | undefined;
  readonly textLength?: number | undefined;
  readonly page: Page;
  readonly cdp: CDPSession;
  /** Headless pages render at the scale the server set; a desktop page at its display's. */
  readonly renderScale: number | "display";
  readonly fullScreenshot?: boolean | undefined;
  readonly consoleEntries: ReadonlyArray<PreviewAutomationConsoleEntry>;
  readonly networkEntries: ReadonlyArray<PreviewAutomationNetworkEntry>;
  readonly actionTimeline: PreviewAutomationSnapshot["actionTimeline"];
  /** Saved login values held for this tab: the screenshot is refused while any may show. */
  readonly secrets?: ReadonlyArray<string> | undefined;
};

/** The scale a page renders at and its viewport in device-independent pixels. */
const renderingOf = async (input: SnapshotInput) => {
  if (input.renderScale !== "display") {
    const viewport = input.page.viewportSize() ?? { width: 1280, height: 800 };
    return { renderScale: input.renderScale, viewport };
  }
  // The display ratio a desktop page reports includes its page zoom, and its sizes are CSS pixels.
  const page = await readPageMetrics(input.cdp);
  return {
    renderScale: page.ratio / page.zoom,
    viewport: {
      width: Math.round(page.width * page.zoom),
      height: Math.round(page.height * page.zoom),
    },
  };
};

const capture = async (
  input: SnapshotInput,
  scope: Locator | null,
  deadline: number,
): Promise<PreviewAutomationSnapshot> => {
  const { renderScale, viewport } = await renderingOf(input);
  // A late metrics reply must not begin a capture after viewers have resumed.
  if (Date.now() >= deadline) throw tooBusy();
  const scale = Math.min(1, MAX_SCREENSHOT_WIDTH / (viewport.width * renderScale));
  const state = refsFor(input.page);
  invalidateRefs(input.page);
  const generation = state.generation;
  const { readers, read } = await openReaders(input.page, input.cdp);
  const before = await read();
  const secrets = input.secrets ?? [];
  // Checked on both sides of the image, so a value revealed meanwhile is caught too.
  const shownBefore = await secretShown(input.page, input.cdp, secrets);
  // Bracket the tree with value reads to detect changes; await tree completion before retrying failed captures.
  const pageAndScreenshot = Promise.all([
    input.page.evaluate(SNAPSHOT_SCRIPT) as Promise<
      Pick<
        PreviewAutomationSnapshot,
        "url" | "title" | "loading" | "visibleText" | "interactiveElements"
      >
    >,
    shownBefore
      ? Promise.resolve(undefined)
      : captureViewport(input.cdp, { format: "png" }).then(async (full) =>
          scale < 1
            ? {
                data: await shrinkPng(input.cdp, full, scale),
                full: input.fullScreenshot ? full : undefined,
              }
            : { data: full, full: undefined },
        ),
  ]);
  void pageAndScreenshot.catch(constVoid);
  // Leaves time for the second read; a frame that never loads holds the tree until then.
  const tree = await (scope ?? input.page).ariaSnapshot({
    mode: "ai",
    boxes: true,
    timeout: Math.max(1, deadline - Date.now() - 2_000),
  });
  const after = await read(before);
  // A value that changed meanwhile may be in the tree under neither reading.
  if (after.some((values, i) => values && JSON.stringify(values) !== JSON.stringify(before[i])))
    throw pageChanged();
  const dotted = dottedPattern(after.flatMap((values) => values ?? []));
  // Unread frames can expose values only if their content appears in the tree.
  const unread = readers.flatMap((reader, i) => (after[i] ? [] : reader.frames));
  const filled = /^\s*- iframe (?:\[active\] )?\[ref=(\S+?)\].*:$/gm;
  for (const [, ref] of unread.length ? tree.matchAll(filled) : []) {
    const iframe = await input.page.locator(`aria-ref=${ref}`).elementHandle({ timeout: 2_000 });
    if (!iframe) throw pageChanged();
    const frame = await iframe.contentFrame();
    void iframe.dispose().catch(constVoid);
    if (frame && unread.includes(frame)) throw tooBusy();
  }
  const [page, image] = await pageAndScreenshot;
  const data = image?.data;
  const full = image?.full;
  const shown = shownBefore || (await secretShown(input.page, input.cdp, secrets));
  const visibleText =
    scope === null
      ? page.visibleText
      : await scope.innerText({ timeout: Math.max(1, deadline - Date.now()) });
  if (state.generation !== generation) throw pageChanged();
  const mask = (text: string) => (dotted ? text.replace(dotted, MASKED_VALUE) : text);
  // Redacted before the cut, so a payload crossing it can't leave its start showing, and before
  // masking, which could hide the `data:` scheme behind a password value's dots.
  const redacted = withoutTreeDataPayloads(tree);
  const textLength = input.textLength ?? MAX_VISIBLE_TEXT_LENGTH;
  const accessibilityTree = (dotted ? maskTree(redacted, dotted) : redacted)
    .slice(0, textLength)
    .replace(/\[ref=((?:f\d+)?e\d+)\]/g, (_match, nativeRef: string) => {
      const ref = `t3-${generation}-${nativeRef}`;
      state.refs.set(ref, nativeRef);
      return `[ref=${ref}]`;
    });
  return {
    ...page,
    url: withoutDataPayload(page.url),
    // Mask text before truncating so a value crossing the cut cannot leak its prefix.
    visibleText: mask(visibleText).slice(0, textLength),
    accessibilityTree,
    interactiveElements: accessibilityTree.split("\n").flatMap((line) => {
      const role =
        /^\s*- (button|link|textbox|searchbox|checkbox|radio|combobox|spinbutton|menuitem|option|switch|slider|tab|treeitem)\b/.exec(
          line,
        )?.[1];
      const ref = /\[ref=([^\]]+)\]/.exec(line)?.[1];
      const box = /\[box=(-?\d+),(-?\d+),(\d+),(\d+)\]/.exec(line);
      if (!role || !ref || !box) return [];
      const quotedName = /^\s*- \w+ ("(?:[^"\\]|\\.)*")/.exec(line)?.[1];
      const name = quotedName === undefined ? "" : (JSON.parse(quotedName) as string);
      return [
        {
          tag: "unknown",
          role,
          name,
          selector: `aria-ref=${ref}`,
          x: Number(box[1]),
          y: Number(box[2]),
          width: Number(box[3]),
          height: Number(box[4]),
        },
      ];
    }),
    captureStatus: { console: true, network: true, actionTimeline: true },
    consoleEntries: [...input.consoleEntries],
    networkEntries: [...input.networkEntries],
    actionTimeline: [...input.actionTimeline],
    viewport,
    ...(shown || data === undefined
      ? { screenshotRefused: "secret-visible" as const }
      : { screenshot: { mimeType: "image/png" as const, data, ...pngSize(data) } }),
    ...(shown || full === undefined ? {} : { fullScreenshot: { data: full, ...pngSize(full) } }),
  };
};

/** Snapshots begun per page; observers' snapshots aren't queued, so two can overlap. */
const snapshotTurns = new WeakMap<Page, number>();

export const snapshot = async (input: SnapshotInput): Promise<PreviewAutomationSnapshot> => {
  // Resolved before the first capture revokes refs, so an aria-ref from the previous
  // snapshot still works, and on the retry too. It throws on a stale ref, so it runs before
  // the timer: an armed timer whose rejection nobody awaits would kill the server.
  const scope = targetLocator(input.page, input);
  const deadline = Date.now() + SNAPSHOT_TIMEOUT_MS;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(tooBusy()), SNAPSHOT_TIMEOUT_MS);
  });
  const turn = (snapshotTurns.get(input.page) ?? 0) + 1;
  snapshotTurns.set(input.page, turn);
  // Retry only before the deadline and the next snapshot, whose refs a later retry would revoke.
  const captured = capture(input, scope, deadline).catch((cause: unknown) =>
    Date.now() < deadline &&
    snapshotTurns.get(input.page) === turn &&
    !(cause instanceof Error && cause.message === VALUE_TOO_LONG)
      ? capture(input, scope, deadline)
      : Promise.reject(cause),
  );
  try {
    return await Promise.race([captured, expired]);
  } catch (cause) {
    throw cause instanceof Error && cause.name === "TimeoutError" ? tooBusy() : cause;
  } finally {
    clearTimeout(timer);
  }
};

/** Return when a dialog opens; waiting for the action to finish would block until dialog resolution. */
export const click = async (
  page: Page,
  input: PreviewAutomationClickInput,
  pointer: PointerReporter = noPointer,
): Promise<{ readonly x: number; readonly y: number }> => {
  const timeout = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const locator = targetLocator(page, input);
  try {
    return await clickTarget(page, locator, input, timeout, pointer);
  } catch (cause) {
    throw locator === null ? cause : await namedTargetTimeout(locator, input, cause);
  }
};

/**
 * Playwright's timeout names neither the target nor why it waited. Counting only after the
 * wait failed keeps auto-wait intact, but the count describes the page after the timeout, not
 * what the click did: Playwright can dispatch the click and then time out waiting for the
 * navigation it started.
 */
const namedTargetTimeout = async (
  locator: Locator,
  input: { readonly locator?: string | undefined; readonly selector?: string | undefined },
  cause: unknown,
) => {
  if (!(cause instanceof Error && cause.name === "TimeoutError")) return cause;
  const selector = JSON.stringify(input.locator ?? input.selector);
  // The warning leads and the target is capped, so a reply cut short still carries the warning.
  const target =
    selector.length > MAX_TARGET_CHARS ? `${selector.slice(0, MAX_TARGET_CHARS)}...` : selector;
  // The host's reply must still beat the broker's short grace after the operation timeout.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const matches = await Promise.race([
    locator.count().catch(() => undefined),
    new Promise<undefined>((resolve) => {
      timer = setTimeout(() => resolve(undefined), TARGET_COUNT_MS);
    }),
  ]).finally(() => clearTimeout(timer));
  const reason =
    matches === undefined
      ? `The click may have happened; check the page before retrying. Whether ${target} still matches an element is unknown.`
      : matches === 0
        ? `The click may have happened and removed its target or navigated; check the page before retrying. No element matches ${target} after the timeout; take a fresh snapshot and use its locator.`
        : `The click may have happened; check the page before retrying. ${target} still matches an element after the timeout.`;
  return new ServerBrowserOperationError({
    tag: "PreviewAutomationTimeoutError",
    message: reason,
    detail: { reason },
    cause,
  });
};

const clickTarget = async (
  page: Page,
  locator: Locator | null,
  input: PreviewAutomationClickInput,
  timeout: number,
  pointer: PointerReporter,
) => {
  const point = await targetPoint(page, locator, input, timeout);
  await pointer(point, "click");
  const options = { button: input.button ?? "left", clickCount: input.clickCount ?? 1 } as const;
  const clicked =
    locator === null
      ? page.mouse.click(point.x, point.y, options)
      : locator.click({ ...options, timeout });
  let onDialog = constVoid;
  const dialogOpened = new Promise<"dialog">((resolve) => {
    onDialog = () => resolve("dialog");
    page.once("dialog", onDialog);
  });
  try {
    if ((await Promise.race([clicked, dialogOpened])) === "dialog") void clicked.catch(constVoid);
  } finally {
    page.off("dialog", onDialog);
  }
  return point;
};

export const type = async (page: Page, input: PreviewAutomationTypeInput) => {
  const timeout = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const locator = targetLocator(page, input);
  if (locator !== null && input.clear) {
    await locator.fill(input.text, { timeout });
    return;
  }
  // A shadow host also matches :focus; use its innermost focused descendant.
  const target = locator ?? page.locator("*:focus").last();
  const focused =
    (locator !== null || (await target.count()) > 0) &&
    (await target.evaluate(
      (element) => {
        // Require an enabled, focused text target to avoid losing input or sending it to the previous field.
        const control = element as unknown as {
          readonly type?: string;
          readonly disabled?: boolean;
          readonly readOnly?: boolean;
          readonly isContentEditable?: boolean;
          readonly focus?: () => void;
        };
        const nonText = [
          "button",
          "checkbox",
          "color",
          "file",
          "hidden",
          "image",
          "radio",
          "range",
          "reset",
          "submit",
        ];
        const textControl =
          element.tagName === "TEXTAREA" ||
          (element.tagName === "INPUT" && !nonText.includes(control.type ?? "text"));
        if (!(textControl || control.isContentEditable) || control.disabled || control.readOnly) {
          return false;
        }
        control.focus?.();
        const root = element.getRootNode() as { readonly activeElement?: typeof element | null };
        const active = root.activeElement;
        return active != null && (active === element || element.contains(active));
      },
      undefined,
      { timeout },
    ));
  if (focused !== true) {
    throw new ServerBrowserOperationError({
      tag: "PreviewAutomationTargetNotEditableError",
      message: "The target is not an enabled text field, so no text was typed.",
    });
  }
  if (input.clear) {
    await page.keyboard.press("ControlOrMeta+A");
    await page.keyboard.press("Delete");
  }
  await page.keyboard.insertText(input.text);
};

const SECRET_AUTOCOMPLETE = ["current-password", "new-password", "one-time-code"];

/** A bounded task enters only supplied ordinary text, never an authentication secret. */
export const refuseSecretField = async (page: Page, input: PreviewAutomationTypeInput) => {
  const locator = targetLocator(page, input);
  if (locator === null) return;
  const secret = await locator.evaluate(
    (element, autocomplete) => {
      const field = element as unknown as {
        readonly type?: string;
        readonly autocomplete?: string;
      };
      return field.type === "password" || autocomplete.includes(field.autocomplete ?? "");
    },
    SECRET_AUTOCOMPLETE,
    { timeout: input.timeoutMs ?? DEFAULT_TIMEOUT_MS },
  );
  if (secret)
    throw new ServerBrowserOperationError({
      tag: "PreviewAutomationTargetNotEditableError",
      message: "The target is a password or secret field, and agents never type into one.",
      detail: { secretField: true },
    });
};

export const hover = async (
  page: Page,
  input: PreviewAutomationHoverInput,
  pointer: PointerReporter = noPointer,
) => {
  const timeout = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const locator = targetLocator(page, input);
  await pointer(await targetPoint(page, locator, input, timeout), "move");
  if (locator === null) {
    await page.mouse.move(input.x ?? 0, input.y ?? 0);
    return;
  }
  await locator.hover({ timeout });
};

export const select = async (
  page: Page,
  input: PreviewAutomationSelectInput,
): Promise<PreviewAutomationSelectResult> => {
  const locator = targetLocator(page, input)!;
  const timeout = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const options = await locator.evaluate(
    (element) =>
      element.tagName === "SELECT"
        ? Array.from(
            (element as unknown as { options: ArrayLike<{ value: string; label: string }> })
              .options,
            ({ value, label }) => ({ value, label: label.trim() }),
          )
        : null,
    undefined,
    { timeout },
  );
  const values =
    options &&
    input.values.map(
      (entry) =>
        (
          options.find((option) => option.value === entry) ??
          options.find((option) => option.label === entry.trim())
        )?.value ?? entry,
    );
  if (values === null)
    throw new ServerBrowserOperationError({
      tag: "PreviewAutomationTargetNotEditableError",
      message: "This element is not a <select>. Click a custom dropdown, then click its option.",
    });
  return { selected: await locator.selectOption(values, { timeout }) };
};

export const drag = async (
  page: Page,
  input: PreviewAutomationDragInput,
  pointer: PointerReporter = noPointer,
) => {
  const timeout = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const source = targetLocator(page, { locator: input.source })!;
  const target = targetLocator(page, { locator: input.target })!;
  await pointer(await targetPoint(page, source, {}, timeout), "move");
  // Observe drag rejection immediately; an unhandled rejection during cursor movement exits the server.
  const dragFailure = source.dragTo(target, { timeout }).then(
    () => null,
    (error: unknown) => ({ error }),
  );
  const end = await target.boundingBox({ timeout }).catch(() => null);
  if (end) await pointer({ x: end.x + end.width / 2, y: end.y + end.height / 2 }, "move");
  const failure = await dragFailure;
  if (failure) throw failure.error;
};

export const setInputFiles = async (page: Page, input: PreviewAutomationUploadInput) => {
  const locator = targetLocator(page, input);
  if (locator === null) return false;
  await locator.setInputFiles([...input.paths], { timeout: input.timeoutMs ?? DEFAULT_TIMEOUT_MS });
  return true;
};

export const press = async (page: Page, input: PreviewAutomationPressInput) => {
  await page.keyboard.press([...(input.modifiers ?? []), input.key].join("+"));
};

export const scroll = async (page: Page, input: PreviewAutomationScrollInput) => {
  const delta = [input.deltaX ?? 0, input.deltaY ?? 0] as const;
  const locator = targetLocator(page, input);
  if (locator === null) {
    // Page-side code is passed as source: the server compiles without DOM types.
    await page.evaluate(`scrollBy(${delta[0]}, ${delta[1]})`);
    return;
  }
  await locator.evaluate((element, [x, y]) => element.scrollBy(x, y), delta);
};

/** Terminate expired page scripts so a hung expression cannot block the tab's control queue. */
export const evaluate = async (
  cdp: CDPSession,
  input: PreviewAutomationEvaluateInput,
  timeoutMs: number,
) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const expired = new Promise<never>((_, reject) => {
    timer = setTimeout(() => {
      timedOut = true;
      // Stops a busy script; an awaited promise is abandoned and settles unread.
      void cdp.send("Runtime.terminateExecution").catch(constVoid);
      reject(
        new ServerBrowserOperationError({
          tag: "PreviewAutomationTimeoutError",
          message: `Evaluation did not finish within ${timeoutMs}ms and was stopped.`,
        }),
      );
    }, timeoutMs);
  });
  const params = {
    expression: input.expression,
    awaitPromise: input.awaitPromise ?? true,
    returnByValue: input.returnByValue ?? true,
  };
  // The devtools console's replMode allows top-level await but returns a trailing promise unawaited,
  // so it only retries what the page's parser rejected. A parse error has a scriptId but no stack and
  // ran nothing; a browser-internal rejection has neither.
  const evaluation = cdp.send("Runtime.evaluate", params).then((classic) => {
    const failure = classic.exceptionDetails;
    const unparsed =
      failure?.exception?.className === "SyntaxError" &&
      failure.scriptId !== undefined &&
      failure.stackTrace === undefined;
    return unparsed && !timedOut && input.expression.includes("await")
      ? cdp.send("Runtime.evaluate", { ...params, replMode: true })
      : classic;
  });
  void evaluation.catch(constVoid);
  const result = await Promise.race([evaluation, expired]).finally(() => clearTimeout(timer));
  if (result.exceptionDetails) {
    throw new ServerBrowserOperationError({
      tag: "PreviewAutomationExecutionError",
      message: result.exceptionDetails.exception?.description ?? result.exceptionDetails.text,
    });
  }
  const value =
    "value" in result.result ? result.result.value : (result.result.description ?? null);
  const actualBytes = Buffer.byteLength(JSON.stringify(value ?? null), "utf8");
  if (actualBytes > MAX_EVALUATION_BYTES) {
    throw new ServerBrowserOperationError({
      tag: "PreviewAutomationResultTooLargeError",
      message: `Evaluation result is ${actualBytes} bytes; the limit is ${MAX_EVALUATION_BYTES}.`,
      detail: { maximumBytes: MAX_EVALUATION_BYTES },
    });
  }
  return value;
};

export const waitFor = async (page: Page, input: PreviewAutomationWaitForInput) => {
  const timeoutMs = input.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const deadline = Date.now() + timeoutMs;
  const locator = targetLocator(page, input);
  const absentLocator = targetLocator(page, { locator: input.locatorAbsent });
  const { text, textAbsent, urlIncludes } = input;
  // A navigation can destroy the context mid-check; that counts as not yet.
  const pageText = (needle: string) =>
    page
      .evaluate(`(document.body?.innerText ?? "").includes(${JSON.stringify(needle)})`)
      .then((found) => found === true)
      .catch(() => null);
  const checks: Array<readonly [name: string, check: () => Promise<boolean>]> = [];
  if (locator !== null) {
    checks.push([
      input.locator === undefined ? "selector" : "locator",
      async () => (await locator.count()) > 0,
    ]);
  }
  if (text !== undefined) checks.push(["text", async () => (await pageText(text)) === true]);
  if (textAbsent !== undefined) {
    checks.push(["textAbsent", async () => (await pageText(textAbsent)) === false]);
  }
  if (absentLocator !== null) {
    // Hidden counts as gone, but any visible match means it is still there. A failure to look
    // (a bad selector, a stale ref) must not read as absence, so it is not caught here.
    checks.push([
      "locatorAbsent",
      async () => (await absentLocator.filter({ visible: true }).count()) === 0,
    ]);
  }
  if (urlIncludes !== undefined)
    checks.push(["urlIncludes", async () => page.url().includes(urlIncludes)]);
  for (;;) {
    const results = await Promise.all(checks.map(([, check]) => check()));
    if (results.every(Boolean)) return;
    if (Date.now() >= deadline) {
      const failing = checks.filter((_, index) => !results[index]).map(([name]) => name);
      throw new ServerBrowserOperationError({
        tag: "PreviewAutomationTimeoutError",
        message: `Waited ${timeoutMs}ms; still not holding: ${failing.join(", ")}.`,
      });
    }
    await new Promise((resolve) => setTimeout(resolve, WAIT_POLL_MS));
  }
};

const NET_ERROR_CODES: Readonly<Record<string, number>> = {
  ERR_FAILED: -2,
  ERR_TIMED_OUT: -7,
  ERR_CONNECTION_CLOSED: -100,
  ERR_CONNECTION_RESET: -101,
  ERR_CONNECTION_REFUSED: -102,
  ERR_NAME_NOT_RESOLVED: -105,
  ERR_INTERNET_DISCONNECTED: -106,
  ERR_ADDRESS_UNREACHABLE: -109,
  ERR_CERT_AUTHORITY_INVALID: -202,
  ERR_EMPTY_RESPONSE: -324,
};

export const parseNetError = (errorText: string) => {
  // Names can hold digits, as in ERR_HTTP2_PROTOCOL_ERROR.
  const description = /ERR_[A-Z\d_]+/.exec(errorText)?.[0] ?? errorText;
  return { description, code: NET_ERROR_CODES[description] ?? -2 };
};

export const recordingEncoderScript = (frameRate: BrowserRecordingFrameRate) => `(() => {
  const canvas = document.createElement("canvas");
  const context = canvas.getContext("2d");
  const chunks = [];
  let recorder = null;
  let started = null;
  let stopped = null;
  let sizeBytes = 0;
  let tooLarge = false;
  let frame = null;
  let cursor = null;
  let ring = null;
  const AGENT_CURSOR_PATH = new Path2D("M4.037 4.688a.495.495 0 0 1 .651-.651l16 6.5a.5.5 0 0 1-.063.947l-6.124 1.58a2 2 0 0 0-1.438 1.435l-1.579 6.126a.5.5 0 0 1-.947.063z");
  let ringTimer = null;
  let scale = 1;
  let offsetX = 0;
  let offsetY = 0;
  const paint = () => {
    if (!frame) return;
    const fit = Math.min(canvas.width / frame.width, canvas.height / frame.height);
    const width = frame.width * fit;
    const height = frame.height * fit;
    offsetX = (canvas.width - width) / 2;
    offsetY = (canvas.height - height) / 2;
    if (width < canvas.width || height < canvas.height) {
      context.fillStyle = "#000";
      context.fillRect(0, 0, canvas.width, canvas.height);
    }
    context.drawImage(frame, offsetX, offsetY, width, height);
    scale = (width / frame.width) * frame.cssScale;
    if (ring) {
      const age = (performance.now() - ring.at) / 400;
      if (age < 1) {
        context.beginPath();
        context.arc(offsetX + ring.x * scale, offsetY + ring.y * scale, (8 + 18 * age) * scale, 0, Math.PI * 2);
        context.strokeStyle = "rgba(59,130,246," + (0.9 * (1 - age)) + ")";
        context.lineWidth = 3 * scale;
        context.stroke();
      }
    }
    if (cursor) {
      // The agent cursor (lucide MousePointer2, as in the live panel), never the human arrow.
      const s = 20 / 24 * scale;
      context.save();
      context.translate(offsetX + cursor.x * scale - 2 * scale, offsetY + cursor.y * scale - 2 * scale);
      context.scale(s, s);
      context.lineWidth = 2;
      context.lineJoin = "round";
      context.lineCap = "round";
      context.fillStyle = "#fff";
      context.strokeStyle = "#2563eb";
      context.shadowColor = "rgba(0,0,0,0.25)";
      context.shadowBlur = 2;
      context.fill(AGENT_CURSOR_PATH);
      context.shadowColor = "transparent";
      context.stroke(AGENT_CURSOR_PATH);
      context.restore();
    }
  };
  window.__t3Recorder = {
    async frame(base64, cssWidth) {
      if (tooLarge) return false;
      const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
      if (tooLarge) { bitmap.close(); return false; }
      if (!recorder) {
        canvas.width = bitmap.width;
        canvas.height = bitmap.height;
        const mimeType = ["video/mp4;codecs=avc1.640033", "video/webm;codecs=vp9", "video/webm"].find((type) => MediaRecorder.isTypeSupported(type));
        const bitsPerSecond = Math.min(50e6, Math.max(2.5e6, bitmap.width * bitmap.height * ${frameRate} * 0.05));
        recorder = new MediaRecorder(canvas.captureStream(${frameRate}), { mimeType, videoBitsPerSecond: bitsPerSecond });
        started = new Promise((resolve, reject) => {
          recorder.onstart = resolve;
          recorder.onerror = (event) => reject(event.error);
        });
        stopped = new Promise((resolve) => { recorder.onstop = resolve; });
        recorder.ondataavailable = (event) => {
          if (tooLarge || event.data.size === 0) return;
          sizeBytes += event.data.size;
          if (sizeBytes > ${PROVIDER_SEND_TURN_MAX_FILE_BYTES}) {
            tooLarge = true;
            chunks.length = 0;
            clearInterval(ringTimer);
            frame?.close();
            frame = null;
            if (recorder.state !== "inactive") recorder.stop();
            for (const track of recorder.stream.getTracks()) track.stop();
            return;
          }
          chunks.push(event.data);
        };
        recorder.start(1000);
      }
      // Frame px per page CSS px, before fitting into the canvas.
      bitmap.cssScale = bitmap.width / cssWidth;
      frame?.close();
      frame = bitmap;
      paint();
      await started;
      return true;
    },
    cursor(x, y, click) {
      if (tooLarge) return;
      cursor = { x, y };
      if (click) {
        ring = { x, y, at: performance.now() };
        clearInterval(ringTimer);
        ringTimer = setInterval(() => {
          paint();
          if (performance.now() - ring.at > 400) { ring = null; clearInterval(ringTimer); paint(); }
        }, 33);
      }
      paint();
    },
    async stop() {
      if (!recorder) return { mimeType: null, count: 0, bytes: 0 };
      if (recorder.state !== "inactive") {
        // Consume the cached frame, then wait for the final paint to reach the
        // capture stream. Animation ticks alone can stop before it is delivered.
        const video = document.createElement("video");
        video.muted = true;
        video.srcObject = recorder.stream;
        const nextFrame = () => Promise.race([
          new Promise(resolve => video.requestVideoFrameCallback(resolve)),
          stopped,
        ]);
        const initial = nextFrame();
        void video.play().catch(() => {});
        await initial;
        if (recorder.state !== "inactive") {
          const delivered = nextFrame();
          recorder.stream.getVideoTracks()[0].requestFrame();
          paint();
          await delivered;
        }
        video.pause();
        video.srcObject = null;
        if (recorder.state !== "inactive") recorder.stop();
      }
      await stopped;
      return { mimeType: recorder.mimeType, count: chunks.length, bytes: sizeBytes };
    },
    async chunk(index) {
      const bytes = new Uint8Array(await chunks[index].arrayBuffer());
      let binary = "";
      for (let offset = 0; offset < bytes.length; offset += 0x8000) {
        binary += String.fromCharCode(...bytes.subarray(offset, offset + 0x8000));
      }
      return btoa(binary);
    },
  };
})()`;

export interface TaskTargetCapture {
  /** Base64 PNG of exactly the element, taken with no capture scale. */
  readonly data: string;
  readonly width: number;
  readonly height: number;
  /** CSS pixels, relative to the viewport, after scrolling the element into view. */
  readonly box: {
    readonly x: number;
    readonly y: number;
    readonly width: number;
    readonly height: number;
  };
  readonly viewport: { readonly width: number; readonly height: number };
  readonly url: string;
  /** False when something else paints over the element's centre; null when the centre is off-screen. */
  readonly centreVisible: boolean | null;
}

/** False when something else paints over the element's centre; null when the centre is off-screen. */
const centreVisibility = (target: Locator) =>
  target.evaluate((element) => {
    // Runs in the page, whose DOM types this package does not compile against.
    const page = globalThis as unknown as {
      readonly innerWidth: number;
      readonly innerHeight: number;
    };
    const rect = element.getBoundingClientRect();
    const x = rect.left + rect.width / 2;
    const y = rect.top + rect.height / 2;
    if (x < 0 || y < 0 || x >= page.innerWidth || y >= page.innerHeight) return null;
    const root = element.getRootNode() as unknown as {
      elementFromPoint(x: number, y: number): typeof element | null;
    };
    const hit = root.elementFromPoint(x, y);
    return hit !== null && (element === hit || element.contains(hit) || hit.contains(element));
  });

const taskCaptureError = (message: string) =>
  new ServerBrowserOperationError({ tag: "PreviewAutomationExecutionError", message: message });

/** A real crop of one uniquely resolved element, refused rather than framed by luck. */
export const captureTaskTarget = async (input: {
  readonly page: Page;
  readonly cdp: CDPSession;
  readonly locator: string;
  readonly timeoutMs: number;
  readonly secrets: ReadonlyArray<string>;
}): Promise<TaskTargetCapture> => {
  const timeout = input.timeoutMs;
  if (await secretShown(input.page, input.cdp, input.secrets)) throw secretVisible();
  const target = targetLocator(input.page, { locator: input.locator })!;
  const count = await target.count();
  if (count !== 1)
    throw taskCaptureError(
      count === 0 ? "The capture target is gone." : "The capture target is ambiguous.",
    );
  if (!(await target.isVisible())) throw taskCaptureError("The capture target is hidden.");
  await target.scrollIntoViewIfNeeded({ timeout });
  const box = await target.boundingBox({ timeout });
  if (box === null || box.width <= 0 || box.height <= 0)
    throw taskCaptureError("The capture target has no rendered size.");
  const centreVisible = await centreVisibility(target);
  if (centreVisible === false) throw taskCaptureError("Another element covers the capture target.");
  const png = await target.screenshot({ type: "png", timeout });
  if (await secretShown(input.page, input.cdp, input.secrets)) throw secretVisible();
  const data = png.toString("base64");
  const { width, height } = pngSize(data);
  const scale = width / box.width;
  if (scale <= 0 || Math.abs(height - box.height * scale) > Math.max(2, 2 * scale))
    throw taskCaptureError("The captured image does not match the target's framing.");
  return {
    data,
    width,
    height,
    box,
    viewport: input.page.viewportSize() ?? { width: 0, height: 0 },
    url: withoutDataPayload(input.page.url()),
    centreVisible,
  };
};

/** Load, then network quiet, each within what is left of the bound; an unsettled page is not an error. */
export const settleTaskPage = async (input: {
  readonly page: Page;
  readonly timeoutMs: number;
}) => {
  const deadline = performance.now() + input.timeoutMs;
  for (const state of ["load", "networkidle"] as const) {
    const timeout = deadline - performance.now();
    if (timeout <= 0) return;
    await input.page.waitForLoadState(state, { timeout }).catch(() => undefined);
  }
};

/** The same occlusion test as a target capture, after scrolling the element into view. */
export const taskTargetCovered = async (input: {
  readonly page: Page;
  readonly locator: string;
  readonly timeoutMs: number;
}) => {
  const target = targetLocator(input.page, { locator: input.locator })!;
  if ((await target.count()) !== 1) throw taskCaptureError("The target is gone or ambiguous.");
  await target.scrollIntoViewIfNeeded({ timeout: input.timeoutMs });
  return (await centreVisibility(target)) === false;
};

/** Probes are reads, so one that fails or outlives this leaves its element out, never in. */
const FACT_MS = 2_000;

/**
 * Which of the refs sit inside a `position: fixed` element, and each iframe ref's document URL,
 * for page reach. Stale refs are left out.
 */
export const taskPageFacts = async (input: {
  readonly page: Page;
  readonly fixed: readonly string[];
  readonly frames: readonly string[];
  readonly timeoutMs: number;
}) => {
  const timeout = Math.min(input.timeoutMs, FACT_MS);
  const locate = (ref: string) => {
    try {
      return targetLocator(input.page, { locator: `aria-ref=${ref}` })!;
    } catch {
      return undefined;
    }
  };
  const fixed = await Promise.all(
    input.fixed.map(async (ref) => {
      // Page-side code: the server compiles without DOM types.
      const inLayer = await locate(ref)
        ?.evaluate(
          (element) => {
            interface Node {
              readonly parentElement: Node | null;
              readonly getRootNode: () => { readonly host?: Node };
              readonly ownerDocument: {
                readonly defaultView: {
                  readonly getComputedStyle: (node: Node) => { readonly position: string };
                } | null;
              };
            }
            const start = element as unknown as Node;
            const view = start.ownerDocument.defaultView;
            for (let node: Node | null = start; node !== null;) {
              if (view?.getComputedStyle(node).position === "fixed") return true;
              node = node.parentElement ?? node.getRootNode().host ?? null;
            }
            return false;
          },
          undefined,
          { timeout },
        )
        .catch(() => false);
      return inLayer === true ? [ref] : [];
    }),
  );
  const frames = await Promise.all(
    input.frames.map(async (ref) => {
      const handle = await locate(ref)
        ?.elementHandle({ timeout })
        .catch(() => null);
      if (!handle) return [];
      const frame = await handle.contentFrame().catch(() => null);
      void handle.dispose().catch(constVoid);
      return frame ? [[ref, frame.url()] as const] : [];
    }),
  );
  return { fixed: fixed.flat(), frames: Object.fromEntries(frames.flat()) };
};

/**
 * Focuses the target and presses the key only if the target itself then holds focus, through
 * shadow roots and, inside a frame, only while that frame's document has focus. With no
 * locator the key goes to whatever holds focus, as a person's Tab-spelled key would.
 */
export const pressTaskTarget = async (input: {
  readonly page: Page;
  readonly locator?: string | undefined;
  readonly key: string;
  readonly timeoutMs: number;
}): Promise<"pressed" | "not-focusable" | "stale"> => {
  if (input.locator === undefined) {
    await input.page.keyboard.press(input.key);
    return "pressed";
  }
  const target = targetLocator(input.page, { locator: input.locator })!;
  if ((await target.count()) !== 1) return "stale";
  // Page-side code: the server compiles without DOM types.
  const focused = await target.evaluate(
    (element) => {
      (element as unknown as { readonly focus?: () => void }).focus?.();
      const doc = element.ownerDocument as unknown as {
        readonly activeElement: unknown;
        readonly hasFocus: () => boolean;
        readonly defaultView: { readonly top: unknown } | null;
      };
      if (doc.defaultView !== null && doc.defaultView.top !== doc.defaultView && !doc.hasFocus())
        return false;
      let active = doc.activeElement as {
        readonly shadowRoot?: { readonly activeElement: unknown } | null;
      } | null;
      while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement as never;
      return active === (element as unknown);
    },
    undefined,
    { timeout: input.timeoutMs },
  );
  if (!focused) return "not-focusable";
  await input.page.keyboard.press(input.key);
  return "pressed";
};

/**
 * A bounded task's drag: real mouse input, centre to centre, with intermediate moves so
 * pointer-event handlers with a movement threshold see them. Rejects rather than faking it
 * where the page cannot produce a mouse.
 */
export const dragTask = async (input: {
  readonly page: Page;
  readonly fromLocator: string;
  readonly toLocator: string;
  readonly timeoutMs: number;
}): Promise<"dragged" | "stale"> => {
  if (typeof input.page.mouse?.move !== "function")
    throw new ServerBrowserOperationError({
      tag: "PreviewAutomationExecutionError",
      message: "This backend cannot drag: it has no mouse to move.",
    });
  const from = targetLocator(input.page, { locator: input.fromLocator })!;
  const to = targetLocator(input.page, { locator: input.toLocator })!;
  if ((await from.count()) !== 1 || (await to.count()) !== 1) return "stale";
  const start = await targetPoint(input.page, from, {}, input.timeoutMs);
  const end = await targetPoint(input.page, to, {}, input.timeoutMs);
  const mouse = input.page.mouse;
  await mouse.move(start.x, start.y);
  await mouse.down();
  const steps = 24;
  for (let step = 1; step <= steps; step += 1) {
    const fraction = step / steps;
    await mouse.move(
      start.x + (end.x - start.x) * fraction,
      start.y + (end.y - start.y) * fraction,
    );
  }
  await mouse.up();
  return "dragged";
};

/** A full page is cut at this many viewport heights. */
const FULL_PAGE_VIEWPORTS = 4;
const JPEG_QUALITIES = [70, 40] as const;

export interface TaskScreenshot {
  readonly data: Buffer;
  readonly mimeType: "image/png" | "image/jpeg";
  readonly width: number;
  readonly height: number;
  readonly cut: boolean;
  readonly url: string;
  readonly title: string;
}

/** A PNG, or a JPEG when the PNG is over budget; refused when neither fits. */
export const captureTaskScreenshot = async (input: {
  readonly page: Page;
  readonly cdp: CDPSession;
  readonly framing: "viewport" | "full-page" | "target";
  readonly locator?: string | undefined;
  readonly maxBytes: number;
  readonly timeoutMs: number;
  readonly secrets: ReadonlyArray<string>;
}): Promise<TaskScreenshot> => {
  const { page, timeoutMs: timeout } = input;
  if (await secretShown(page, input.cdp, input.secrets)) throw secretVisible();
  let shoot: (options: { type: "png" } | { type: "jpeg"; quality: number }) => Promise<Buffer>;
  let cut = false;
  if (input.framing === "target") {
    const crop = await captureTaskTarget({
      page,
      cdp: input.cdp,
      locator: input.locator!,
      timeoutMs: timeout,
      secrets: input.secrets,
    });
    const target = targetLocator(page, { locator: input.locator! })!;
    const png = Buffer.from(crop.data, "base64");
    shoot = (options) =>
      options.type === "png" ? Promise.resolve(png) : target.screenshot({ ...options, timeout });
  } else if (input.framing === "full-page") {
    const viewport = page.viewportSize() ?? { width: 0, height: 0 };
    const limit = viewport.height * FULL_PAGE_VIEWPORTS;
    const height = await page.evaluate(
      () =>
        (globalThis as unknown as { document: { documentElement: { scrollHeight: number } } })
          .document.documentElement.scrollHeight,
    );
    cut = height > limit;
    const clip = cut ? { x: 0, y: 0, width: viewport.width, height: limit } : undefined;
    shoot = (options) =>
      page.screenshot({ ...options, fullPage: true, timeout, ...(clip ? { clip } : {}) });
  } else {
    shoot = (options) => page.screenshot({ ...options, timeout });
  }
  const png = await shoot({ type: "png" });
  const { width, height } = pngSize(png.subarray(0, 24).toString("base64"));
  let data = png;
  let mimeType: TaskScreenshot["mimeType"] = "image/png";
  for (const quality of JPEG_QUALITIES) {
    if (data.length <= input.maxBytes) break;
    data = await shoot({ type: "jpeg", quality });
    mimeType = "image/jpeg";
  }
  if (data.length > input.maxBytes)
    throw taskCaptureError(`The screenshot is larger than its ${input.maxBytes}-byte budget.`);
  if (await secretShown(page, input.cdp, input.secrets)) throw secretVisible();
  return {
    data,
    mimeType,
    width,
    height,
    cut,
    url: withoutDataPayload(page.url()),
    title: (await page.title()).slice(0, 512),
  };
};

export type LoginFill = "filled" | "stale" | "origin" | "not-password" | "not-focused";

const originOfUrl = (url: string) => {
  try {
    const { origin } = new URL(url);
    return origin === "null" ? undefined : origin;
  } catch {
    return undefined;
  }
};

/**
 * Types a saved login into one password field. The server first checks the field's frame and the
 * top page against the bound origins; the page then rechecks both, the field's type and focus,
 * and sets the value, all in one synchronous step, so a navigation cannot slip in between.
 */
export const fillLogin = async (input: {
  readonly page: Page;
  readonly locator: string;
  readonly value: string;
  readonly origins: ReadonlyArray<string>;
  readonly timeoutMs: number;
}): Promise<LoginFill> => {
  const target = targetLocator(input.page, { locator: input.locator })!;
  if ((await target.count()) !== 1) return "stale";
  const handle = await target.elementHandle({ timeout: input.timeoutMs });
  if (handle === null) return "stale";
  try {
    const frame = await handle.ownerFrame();
    const bound = (url: string | undefined) => {
      const origin = url === undefined ? undefined : originOfUrl(url);
      return origin !== undefined && input.origins.includes(origin);
    };
    if (!bound(frame?.url()) || !bound(input.page.url())) return "origin";
    return await typeLogin(handle, input.value, input.origins);
  } finally {
    void handle.dispose().catch(constVoid);
  }
};

/**
 * The page-side half of a login fill, in one synchronous step. A handle whose document has gone,
 * as after a navigation since the server's checks, cannot run it, so nothing is typed.
 */
export const typeLogin = async (
  handle: ElementHandle,
  value: string,
  origins: ReadonlyArray<string>,
): Promise<LoginFill> => {
  try {
    // Page-side code: the server compiles without DOM types.
    return (await handle.evaluate(
      (element, { value, origins }) => {
        type Field = {
          readonly localName: string;
          readonly type?: string;
          readonly focus?: () => void;
          readonly dispatchEvent: (event: unknown) => boolean;
          readonly ownerDocument: {
            readonly activeElement: unknown;
            readonly hasFocus: () => boolean;
            readonly defaultView: {
              readonly top: { readonly location: { readonly origin: string } };
              readonly location: { readonly origin: string };
              readonly HTMLInputElement: { readonly prototype: object };
              readonly Event: new (type: string, init: { bubbles: boolean }) => unknown;
            } | null;
          };
        };
        const field = element as unknown as Field;
        const view = field.ownerDocument.defaultView;
        if (view === null) return "origin";
        let top: string;
        try {
          top = view.top.location.origin;
        } catch {
          return "origin";
        }
        if (!origins.includes(view.location.origin) || !origins.includes(top)) return "origin";
        if (field.localName !== "input" || field.type !== "password") return "not-password";
        field.focus?.();
        const doc = field.ownerDocument;
        if ((view.top as unknown) !== view && !doc.hasFocus()) return "not-focused";
        let active = doc.activeElement as {
          readonly shadowRoot?: { readonly activeElement: unknown } | null;
        } | null;
        while (active?.shadowRoot?.activeElement) active = active.shadowRoot.activeElement as never;
        if (active !== (element as unknown)) return "not-focused";
        const setter = Object.getOwnPropertyDescriptor(
          view.HTMLInputElement.prototype,
          "value",
        )?.set;
        if (setter === undefined) return "not-password";
        setter.call(element, value);
        field.dispatchEvent(new view.Event("input", { bubbles: true }));
        field.dispatchEvent(new view.Event("change", { bubbles: true }));
        return "filled";
      },
      { value, origins: [...origins] },
    )) as LoginFill;
  } catch {
    return "stale";
  }
};

/** Only true or false leaves the page: whether the bound field holds the value. */
export const loginApplied = async (input: {
  readonly page: Page;
  readonly locator: string;
  readonly value: string;
  readonly origins: ReadonlyArray<string>;
  readonly timeoutMs: number;
}): Promise<boolean> => {
  const target = targetLocator(input.page, { locator: input.locator })!;
  if ((await target.count()) !== 1) return false;
  const handle = await target.elementHandle({ timeout: input.timeoutMs });
  if (handle === null) return false;
  try {
    const frame = await handle.ownerFrame();
    const origin = frame === null ? undefined : originOfUrl(frame.url());
    if (origin === undefined || !input.origins.includes(origin)) return false;
    return await handle.evaluate(
      (element, value) => (element as unknown as { readonly value?: unknown }).value === value,
      input.value,
    );
  } finally {
    void handle.dispose().catch(constVoid);
  }
};

/** Empties every field still holding a value, in frames bound to that value only. */
export const clearLogins = async (input: {
  readonly page: Page;
  readonly logins: ReadonlyArray<{
    readonly value: string;
    readonly origins: ReadonlyArray<string>;
  }>;
}) => {
  await Promise.all(
    input.page.frames().map(async (frame) => {
      const origin = originOfUrl(frame.url());
      const values = input.logins
        .filter((login) => origin !== undefined && login.origins.includes(origin))
        .map((login) => login.value);
      if (values.length === 0) return;
      await frame
        .evaluate((held) => {
          type Root = { querySelectorAll: (selector: string) => Iterable<unknown> };
          type Field = {
            readonly localName: string;
            readonly value?: string;
            readonly shadowRoot?: Root | null;
            readonly dispatchEvent: (event: unknown) => boolean;
          };
          const view = globalThis as unknown as {
            readonly document: Root;
            readonly HTMLInputElement: { readonly prototype: object };
            readonly Event: new (type: string, init: { bubbles: boolean }) => unknown;
          };
          const setter = Object.getOwnPropertyDescriptor(
            view.HTMLInputElement.prototype,
            "value",
          )?.set;
          const visit = (root: Root) => {
            for (const node of root.querySelectorAll("*")) {
              const field = node as Field;
              if (field.shadowRoot) visit(field.shadowRoot);
              // A shown password is a text field, so any input holding the value is emptied.
              if (field.localName !== "input") continue;
              if (!held.includes(field.value ?? "") || setter === undefined) continue;
              setter.call(field, "");
              field.dispatchEvent(new view.Event("input", { bubbles: true }));
              field.dispatchEvent(new view.Event("change", { bubbles: true }));
            }
          };
          visit(view.document);
        }, values)
        .catch(constVoid);
    }),
  );
};
