// Fork cases for ServerBrowser live here; upstream's own cases stay in ServerBrowser.test.ts.
import * as NodeEvents from "node:events";
import * as NodeVM from "node:vm";
import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import {
  EnvironmentId,
  PreviewTabId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type PreviewAutomationLoadError,
  type PreviewAutomationStatus,
} from "@t3tools/contracts";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Queue from "effect/Queue";
import * as Stream from "effect/Stream";
import { type BrowserContext, type Page } from "playwright-core";
import { beforeEach, expect, vi } from "vite-plus/test";

import * as ServerConfig from "../config.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import * as Broker from "../mcp/PreviewAutomationBroker.ts";
import * as DesktopChannel from "./DesktopBrowserChannel.ts";
import * as Manager from "./Manager.ts";
import * as PreviewAgentActivity from "./PreviewAgentActivity.ts";
import * as ServerBrowser from "./ServerBrowser.ts";
import * as PreviewBrowser from "./PreviewBrowser.ts";

vi.mock("./ServerBrowserContexts.ts", () => ({
  presentAsChrome: async () => {},
  ServerBrowserContexts: class {
    private readonly onClose: ((context: BrowserContext) => void) | undefined;
    constructor(options: { onContextClose?: (context: BrowserContext) => void }) {
      this.onClose = options.onContextClose;
    }
    async contextFor(profileId: string, isolationKey?: string) {
      if (realContextOverride) return realContextOverride;
      contextRequests.push({ profileId, isolated: isolationKey !== undefined });
      if (contextFailure) throw contextFailure;
      await contextGate?.promise;
      const context = makeContext(this.onClose);
      const setupFailure = pageSetupFailure;
      if (setupFailure) {
        context.newCDPSession = async () => {
          throw setupFailure;
        };
      }
      contexts.push(context);
      return context as unknown as BrowserContext;
    }
    async managedContext(options: { startTimeoutMs?: number } = {}) {
      managedStartTimeouts.push(options.startTimeoutMs);
      if (managedStartFailure) throw managedStartFailure;
      return this.contextFor("default", "managed");
    }
    hold = vi.fn((context: BrowserContext) => {
      heldContexts.set(context, (heldContexts.get(context) ?? 0) + 1);
    });
    release = vi.fn(async (context: BrowserContext) => {
      const holds = heldContexts.get(context);
      if (holds === undefined || holds === 0) return;
      if (holds > 1) {
        heldContexts.set(context, holds - 1);
        return;
      }
      heldContexts.delete(context);
      await context.close();
    });
    async scratchPage() {
      return encoderPageOverride ?? (makeEncoderPage() as unknown as Page);
    }
    async connectDesktopPage(endpoint: string) {
      const context = makeContext(undefined, desktopPageUrl);
      context.page.viewportSize.mockReturnValue(null);
      const browser = { close: vi.fn(async () => {}) };
      desktopConnections.push({ endpoint, context, browser });
      desktopConnectionStarted?.resolve();
      await desktopConnectionGate?.promise;
      return { browser, page: context.page as unknown as Page };
    }
    async close() {
      for (const context of contexts) await context.close();
    }
  },
}));

function makeFrame() {
  const frame = {
    copy: "",
    detached: false,
    isDetached: () => frame.detached,
    recording: Promise.withResolvers<void>(),
  };
  return frame;
}

const PNG_HEADER = (() => {
  const header = Buffer.alloc(24);
  header.write("IHDR", 12);
  header.writeUInt32BE(1280, 16);
  header.writeUInt32BE(800, 20);
  return header.toString("base64");
})();

function makeSession(
  frame: ReturnType<typeof makeFrame> | undefined,
  viewport: { width: number; height: number },
) {
  const events = new NodeEvents.EventEmitter();
  return {
    on: vi.fn((name: string, callback: (...args: unknown[]) => void) => events.on(name, callback)),
    emit: (name: string, ...args: unknown[]) => events.emit(name, ...args),
    emitAsync: (name: string, ...args: unknown[]) =>
      Promise.all(events.listeners(name).map((listener) => listener(...args))),
    detach: vi.fn(async () => {}),
    send: vi.fn(async (method: string, input?: unknown): Promise<Record<string, unknown>> => {
      if (method === "Page.getNavigationHistory") return { currentIndex: 0, entries: [{}] };
      if (method === "Page.getLayoutMetrics") return { cssVisualViewport: { pageX: 0, pageY: 0 } };
      if (method === "Page.captureScreenshot") {
        if ((input as { format: string }).format === "jpeg" && heldStill) await heldStill();
        // A snapshot sizes its screenshot from the PNG header; viewers get JPEG frames as-is.
        return { data: (input as { format: string }).format === "png" ? PNG_HEADER : "ZnJhbWU=" };
      }
      // Snapshots shrink their screenshot in the page; the header stands in for the result.
      if (method === "Runtime.callFunctionOn") return { result: { value: PNG_HEADER } };
      if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
      if (method === "Page.createIsolatedWorld") {
        const worldContexts: Record<string, number> = {
          "t3-preview-viewport": 9,
          "t3-preview-title": 11,
          "t3-preview": 1,
        };
        return {
          executionContextId: worldContexts[(input as { worldName: string }).worldName] ?? 7,
        };
      }
      // A title watch settles only when the document's title changes.
      if (method === "Runtime.evaluate" && (input as { contextId?: number }).contextId === 11)
        return new Promise(() => {});
      if (method === "Runtime.evaluate" && (input as { contextId?: number }).contextId === 1) {
        return { result: { value: [] } };
      }
      if (method === "Page.addScriptToEvaluateOnNewDocument") frame?.recording.resolve();
      // The recorder drops its last copy on every copy or cut key it sees.
      if (
        method === "Input.dispatchKeyEvent" &&
        ["copy", "cut"].includes((input as { commands?: Array<string> }).commands?.[0] ?? "")
      ) {
        if (focusedFrame) focusedFrame.copy = keyCopy;
        else pageCopy = keyCopy;
      }
      if (method === "Runtime.evaluate" && (input as { contextId?: number }).contextId === 7) {
        const value = frame ? frame.copy : pageCopy;
        if (frame) frame.copy = "";
        else pageCopy = "";
        return { result: { value } };
      }
      if (method === "Runtime.evaluate" && (input as { contextId?: number }).contextId === 9)
        return desktopSizeAnswer?.() ?? { result: { value: { ...viewport } } };
      return { result: { value: "evaluated" } };
    }),
  };
}

function fileChooserElement(accept: string) {
  return {
    getAttribute: async () => accept,
    evaluate: (probe: (element: { ownerDocument: unknown }) => boolean) =>
      Promise.resolve(
        probe({
          ownerDocument: (globalThis as typeof globalThis & { document?: unknown }).document,
        }),
      ),
  };
}

function makeContext(onClose?: (context: BrowserContext) => void, initialUrl = "about:blank") {
  const events = new NodeEvents.EventEmitter();
  const nativeFileChooser = vi.fn();
  const setChooserFiles = vi.fn(async (_files: unknown) => {});
  const sessions: ReturnType<typeof makeSession>[] = [];
  let url = initialUrl;
  let viewport: ReturnType<Page["viewportSize"]> = { width: 1280, height: 800 };
  const cssViewport = { width: 1920, height: 1080 };
  let closed = false;
  let contextClosed = false;
  const page = {
    on: (name: string, callback: (...args: unknown[]) => void) => events.on(name, callback),
    once: (name: string, callback: (...args: unknown[]) => void) => events.once(name, callback),
    off: (name: string, callback: (...args: unknown[]) => void) => events.off(name, callback),
    emit: (name: string, ...args: unknown[]) => events.emit(name, ...args),
    nativeFileChooser,
    setChooserFiles,
    openFileChooser: () => {
      if (
        !events.emit("filechooser", {
          isMultiple: () => false,
          element: () => fileChooserElement(".csv"),
          setFiles: setChooserFiles,
        })
      ) {
        nativeFileChooser();
      }
    },
    emitAsync: (name: string, ...args: unknown[]) =>
      Promise.all(events.listeners(name).map((listener) => listener(...args))),
    setDefaultTimeout: vi.fn(),
    setDefaultNavigationTimeout: vi.fn(),
    context: () => context,
    mainFrame: () => page,
    frames: () => [page],
    url: () => url,
    commit: (next: string) => {
      url = next;
    },
    title: vi.fn(async () => "test page"),
    viewportSize: vi.fn(() => viewport),
    setViewportSize: vi.fn(async (size: typeof viewport) => {
      viewport = size;
    }),
    goto: vi.fn(async (next: string, _options?: { timeout?: number; waitUntil?: string }) => {
      const pending = initialNavigation;
      initialNavigation = null;
      await pending?.();
      url = next;
      events.emit("load");
    }),
    goBack: vi.fn(async () => {}),
    goForward: vi.fn(async () => {}),
    reload: vi.fn(async () => {}),
    emulateMedia: vi.fn(async () => {}),
    waitForLoadState: vi.fn(async (_state?: string, _options?: { timeout?: number }) => {}),
    evaluate: vi.fn(async () => ({
      url,
      title: "test page",
      loading: false,
      visibleText: "delete",
    })),
    ariaSnapshot: vi.fn(async () => '- button "delete" [ref=e1]'),
    locator: vi.fn((): unknown => {
      throw new Error("Unexpected locator action");
    }),
    isClosed: () => closed,
    // Models Playwright: unload handlers always run, but `beforeunload` only with
    // `runBeforeUnload`, and a guarding page stays open behind a `beforeunload` dialog.
    beforeUnload: "none" as "none" | "listen" | "guard",
    unloadEvents: [] as string[],
    beforeUnloadDialog: null as null | {
      accept: ReturnType<typeof vi.fn>;
      dismiss: ReturnType<typeof vi.fn>;
    },
    // Set to hold the page open after `beforeunload` until resolved, as Playwright's
    // `runBeforeUnload` close resolves before the page actually closes.
    unloadGate: null as PromiseWithResolvers<void> | null,
    removed: false,
    pagehideBinding: null as (() => void) | null,
    pagehideWatched: Promise.withResolvers<void>(),
    exposeFunction: vi.fn(async (_name: string, callback: () => void) => {
      page.pagehideBinding = callback;
      page.pagehideWatched.resolve();
    }),
    close: vi.fn(async (options?: { runBeforeUnload?: boolean }) => {
      if (closed) return;
      const finish = () => {
        if (closed || page.removed) return;
        page.unloadEvents.push("pagehide");
        page.pagehideBinding?.();
        page.unloadEvents.push("visibilitychange");
        closed = true;
        events.emit("close");
      };
      if (!options?.runBeforeUnload || page.beforeUnload === "none") return finish();
      page.unloadEvents.push("beforeunload");
      if (page.beforeUnload === "listen" && page.unloadGate) {
        void page.unloadGate.promise.then(finish);
        return;
      }
      if (page.beforeUnload === "listen") return finish();
      const dialog = {
        type: () => "beforeunload",
        message: () => "",
        defaultValue: () => "",
        accept: vi.fn(async () => finish()),
        dismiss: vi.fn(async () => {}),
      };
      page.beforeUnloadDialog = dialog;
      events.emit("dialog", dialog);
    }),
  };
  const context = {
    page,
    sessions,
    cssViewport,
    newPage: async () => page as unknown as Page,
    grantPermissions: vi.fn(async () => {}),
    newCDPSession: async (target: unknown) => {
      const session = makeSession(
        target === page ? undefined : (target as ReturnType<typeof makeFrame>),
        cssViewport,
      );
      sessions.push(session);
      return session;
    },
    closing: Promise.withResolvers<void>(),
    close: vi.fn(async () => {
      if (contextClosed) return;
      contextClosed = true;
      context.closing.resolve();
      await page.close();
      onClose?.(context as unknown as BrowserContext);
    }),
  };
  return context;
}

function makeEncoderPage() {
  let paintedFrame = "";
  const canvas = {
    width: 0,
    height: 0,
    getContext: () => ({
      drawImage(bitmap: { pixels: string }) {
        paintedFrame = bitmap.pixels;
      },
      fillRect() {},
    }),
    captureStream: (frameRate?: number) => ({
      frameRate,
      getTracks: () => [],
      getVideoTracks: () => [{ requestFrame() {} }],
    }),
  };
  const video = {
    play: async () => {},
    pause() {},
    requestVideoFrameCallback: (callback: () => void) => queueMicrotask(callback),
  };
  class FakeMediaRecorder {
    static isTypeSupported = (type: string) => type === "video/webm";
    mimeType = "video/webm";
    state = "inactive";
    onstart: (() => void) | null = null;
    onstop: (() => void) | null = null;
    ondataavailable: ((event: { data: Blob }) => void) | null = null;
    readonly stream: { frameRate?: number };
    constructor(stream: { frameRate?: number }, options: { videoBitsPerSecond: number }) {
      this.stream = stream;
      encoderStreams.push({
        frameRate: stream.frameRate,
        bitsPerSecond: options.videoBitsPerSecond,
      });
    }
    start() {
      this.state = "recording";
      this.onstart?.();
    }
    stop() {
      this.state = "inactive";
      this.ondataavailable?.({ data: new Blob([paintedFrame]) });
      this.onstop?.();
    }
  }
  const sandbox: Record<string, unknown> = {
    document: { createElement: (tag: string) => (tag === "video" ? video : canvas) },
    Path2D: function Path2D() {},
    MediaRecorder: FakeMediaRecorder,
    createImageBitmap: async (blob: Blob) => {
      await decodeGate?.promise;
      return { width: 1280, height: 800, pixels: await blob.text(), close() {} };
    },
    atob,
    btoa,
    Blob,
    performance,
  };
  sandbox.window = sandbox;
  const context = NodeVM.createContext(sandbox);
  return {
    ...makeContext().page,
    evaluate: vi.fn(async (script: string | ((arg: unknown) => unknown), arg?: unknown) =>
      typeof script === "string"
        ? NodeVM.runInContext(script, context)
        : NodeVM.runInContext(`(${script.toString()})`, context)(arg),
    ),
  };
}

const contexts: ReturnType<typeof makeContext>[] = [];
const heldContexts = new Map<BrowserContext, number>();
let encoderPageOverride: Page | undefined;
let realContextOverride: BrowserContext | undefined;
const encoderStreams: Array<{ frameRate: number | undefined; bitsPerSecond: number }> = [];
let decodeGate: PromiseWithResolvers<void> | null = null;
const contextRequests: Array<{ profileId: string; isolated: boolean }> = [];
let contextGate: PromiseWithResolvers<void> | null = null;
let heldStill: (() => Promise<void>) | null = null;
let pageCopy = "";
let keyCopy = "";
let focusedFrame: ReturnType<typeof makeFrame> | null = null;
let contextFailure: Error | null = null;
let pageSetupFailure: Error | null = null;
let managedStartFailure: Error | null = null;
/** The part of its open's limit each managed start was given. */
const managedStartTimeouts: Array<number | undefined> = [];
let initialNavigation: (() => Promise<void>) | null = null;
let desktopRendersNext = false;
let desktopPageUrl = "about:blank";
let desktopConnectionGate: PromiseWithResolvers<void> | null = null;
let desktopConnectionStarted: PromiseWithResolvers<void> | null = null;
/** Replaces the answer to the desktop page's size reads. */
let desktopSizeAnswer: (() => Promise<Record<string, unknown>>) | null = null;
const desktopDetaches = new NodeEvents.EventEmitter();
let desktopDetachReady = Promise.withResolvers<void>();
let desktopReleased = Promise.withResolvers<void>();
const desktopTabs = new Set<string>();
const desktopRenders = (tabId: string) => {
  if (desktopRendersNext) {
    desktopRendersNext = false;
    desktopTabs.add(tabId);
  }
  return desktopTabs.has(tabId);
};
/** When set, a desktop that has not attached a tab waits for it the way the real channel does. */
let desktopAttachesLate = false;
let desktopAttachWaiting = Promise.withResolvers<void>();
const shownDesktopTabs = new (class extends Set<string> {
  override add(tabId: string) {
    super.add(tabId);
    desktopDetaches.emit("shown", tabId);
    return this;
  }
})();
const releasedDesktopTabs: Array<string> = [];
const desktopLoadFailures = new Map<string, PreviewAutomationLoadError>();
const desktopTurns = new NodeEvents.EventEmitter();
const desktopConnections: Array<{
  endpoint: string;
  context: ReturnType<typeof makeContext>;
  browser: { close: ReturnType<typeof vi.fn> };
}> = [];
const testThread = {
  threadId: ThreadId.make("browser-test-thread"),
  providerSessionId: "agent-a",
  providerInstanceId: ProviderInstanceId.make("codex"),
};
const scope = {
  environmentId: EnvironmentId.make("browser-test-environment"),
  thread: testThread,
  client: undefined,
  requestNamespace: "browser-test",
  capabilities: new Set(["preview"] as const),
  issuedAt: 1,
};
const asSession = (providerSessionId: string) => ({
  ...scope,
  thread: { ...testThread, providerSessionId },
});
const dependencies = Layer.mergeAll(
  Broker.layer,
  Manager.layer,
  Layer.succeed(ServerEnvironment.ServerEnvironment, {
    getEnvironmentId: Effect.succeed(scope.environmentId),
    getDescriptor: Effect.die("unused descriptor"),
  }),
  Layer.succeed(PreviewBrowser.PreviewBrowser, {
    executable: Effect.die("mock Chromium does not need an executable"),
    installed: Effect.die("mock Chromium does not need an executable"),
  }),
  Layer.succeed(DesktopChannel.DesktopBrowserChannel, {
    available: true,
    awaitAttached: (key, timeout) =>
      !desktopAttachesLate || desktopRenders(key.tabId)
        ? Effect.sync(() => desktopRenders(key.tabId))
        : Effect.raceFirst(
            Stream.callback<string>((queue) =>
              Effect.acquireRelease(
                Effect.sync(() => {
                  const onAttach = (attached: { tabId: string }) =>
                    Queue.offerUnsafe(queue, attached.tabId);
                  desktopDetaches.on("attach", onAttach);
                  return onAttach;
                }),
                (onAttach) => Effect.sync(() => desktopDetaches.off("attach", onAttach)),
              ),
            ).pipe(
              Stream.filter((tabId) => tabId === key.tabId),
              Stream.runHead,
              Effect.as(true),
            ),
            Effect.sync(() => desktopAttachWaiting.resolve()).pipe(
              // oxlint-disable-next-line t3code/no-real-time-wait-in-tests -- the copied desktop channel mock's own timeout; this file's tests are it.live, so it is wall-clock here.
              Effect.andThen(Effect.sleep(timeout)),
              Effect.as(false),
            ),
          ),
    detached: Stream.callback<{ threadId: string; tabId: string }>((queue) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const onDetach = (key: { threadId: string; tabId: string }) =>
            Queue.offerUnsafe(queue, key);
          desktopDetaches.on("detach", onDetach);
          desktopDetachReady.resolve();
          return onDetach;
        }),
        (onDetach) => Effect.sync(() => desktopDetaches.off("detach", onDetach)),
      ),
    ),
    attached: Stream.callback<{ threadId: string; tabId: string }>((queue) =>
      Effect.acquireRelease(
        Effect.sync(() => {
          const onAttach = (key: { threadId: string; tabId: string }) =>
            Queue.offerUnsafe(queue, key);
          desktopDetaches.on("attach", onAttach);
          return onAttach;
        }),
        (onAttach) => Effect.sync(() => desktopDetaches.off("attach", onAttach)),
      ),
    ),
    isAttached: (key) => Effect.sync(() => desktopRenders(key.tabId)),
    isShown: (key) => shownDesktopTabs.has(key.tabId),
    awaitShown: (key, timeout) =>
      shownDesktopTabs.has(key.tabId)
        ? Effect.succeed(true)
        : Effect.callback<boolean>((resume) => {
            const onShown = (tabId: string) => {
              if (tabId === key.tabId) resume(Effect.succeed(true));
            };
            desktopDetaches.on("shown", onShown);
            return Effect.sync(() => desktopDetaches.off("shown", onShown));
          }).pipe(Effect.timeoutOrElse({ duration: timeout, orElse: () => Effect.succeed(false) })),
    loadFailure: (key) => desktopLoadFailures.get(key.tabId),
    endpoint: (key) =>
      Effect.acquireRelease(Effect.succeed(`ws://desktop/${key.tabId}`), () =>
        Effect.sync(() => {
          releasedDesktopTabs.push(key.tabId);
          desktopDetaches.emit("release", key.tabId);
          desktopReleased.resolve();
        }),
      ),
    pointer: () => Effect.void,
    turn: (threadId, active) => Effect.sync(() => desktopTurns.emit("turn", threadId, active)),
  }),
  PreviewAgentActivity.layer,
).pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-server-browser-" })),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);
const layer = ServerBrowser.layer.pipe(Layer.provideMerge(dependencies));
const ready = Effect.gen(function* () {
  const browser = yield* ServerBrowser.ServerBrowser;
  const broker = yield* Broker.PreviewAutomationBroker;
  yield* Effect.yieldNow;
  const opened = yield* broker.invoke<PreviewAutomationStatus>({
    scope,
    operation: "open",
    input: { reuseExistingTab: false, show: false },
  });
  const tabId = PreviewTabId.make(opened.tabId!);
  return { browser, broker, tabId };
});

beforeEach(() => {
  contexts.length = 0;
  heldContexts.clear();
  encoderPageOverride = undefined;
  realContextOverride = undefined;
  encoderStreams.length = 0;
  decodeGate = null;
  contextRequests.length = 0;
  contextGate = null;
  heldStill = null;
  contextFailure = null;
  pageSetupFailure = null;
  managedStartFailure = null;
  managedStartTimeouts.length = 0;
  initialNavigation = null;
  pageCopy = "";
  keyCopy = "";
  focusedFrame = null;
  desktopTabs.clear();
  shownDesktopTabs.clear();
  desktopLoadFailures.clear();
  desktopRendersNext = false;
  desktopAttachesLate = false;
  desktopAttachWaiting = Promise.withResolvers<void>();
  desktopPageUrl = "about:blank";
  desktopConnectionGate = null;
  desktopConnectionStarted = null;
  desktopSizeAnswer = null;
  desktopDetachReady = Promise.withResolvers<void>();
  desktopReleased = Promise.withResolvers<void>();
  releasedDesktopTabs.length = 0;
  desktopConnections.length = 0;
});

it.live("reports a managed browser crash as a refusal and releases its context", () =>
  Effect.scoped(
    Effect.gen(function* () {
      const { broker } = yield* ready;
      const manager = yield* Manager.PreviewManager;
      const managed = {
        ...asSession("managed-crash"),
        managedBrowser: true as const,
        managedProjectId: ProjectId.make("managed-crash-project"),
      };
      const opened = yield* broker.invoke<PreviewAutomationStatus>({
        scope: managed,
        operation: "open",
        input: {},
      });
      const tabId = PreviewTabId.make(opened.tabId!);
      const events = yield* manager.subscribeEvents;
      const crashed = contexts.at(-1)!;
      yield* Effect.promise(() => crashed.page.emitAsync("crash"));
      yield* Stream.fromSubscription(events).pipe(
        Stream.filter((event) => event.type === "closed" && event.tabId === tabId),
        Stream.take(1),
        Stream.runDrain,
      );
      const refused = yield* broker
        .invoke<PreviewAutomationStatus>({ scope: managed, tabId, operation: "status", input: {} })
        .pipe(Effect.flip);
      expect(refused.message).toContain("crashed or disconnected");
      expect(crashed.close).toHaveBeenCalled();
    }),
  ).pipe(Effect.provide(layer)),
);
