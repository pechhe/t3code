import { constVoid } from "effect/Function";
import type { CDPSession, Page, Route } from "playwright-core";

/**
 * Chromium reports a pop-up's target before the pop-up sends anything, so a new page's first
 * request waits this long for its opener to be known; another tab's then goes on.
 */
const POPUP_ATTRIBUTION_MS = 250;
/** A refused pop-up may fail one first request this soon after it opened, never later. */
const POPUP_CREDIT_MS = 1_000;

export const originOf = (url: string) => {
  try {
    return new URL(url).origin;
  } catch {
    return "null";
  }
};

/**
 * Fails each main-frame request leaving `origins`, redirect hops included, before it is sent.
 * A pop-up is another target this page's session never sees: a browser session closes it, and a
 * context route fails its frameless first request. Without a browser session it will not start.
 */
export async function installTaskFence(input: {
  readonly page: Page;
  readonly origins: readonly string[];
  readonly onBreach: (detail: string) => void;
}): Promise<() => Promise<void>> {
  const allowed = new Set(input.origins);
  const context = input.page.context();
  const browser = context.browser();
  if (browser === null)
    throw new Error("This tab's browser cannot report pop-ups, so page reach cannot fence it.");
  const sessions: CDPSession[] = [];
  /** When each pop-up this page opened was refused; spent by the first request it sends. */
  const credits: number[] = [];
  const waiting = new Set<() => void>();
  const fresh = () => {
    while (credits.length > 0 && performance.now() - credits[0]! > POPUP_CREDIT_MS) credits.shift();
    return credits.length > 0;
  };
  const popups = async (route: Route) => {
    const request = route.request();
    let framed = true;
    try {
      request.frame();
    } catch {
      framed = false;
    }
    if (framed || !request.isNavigationRequest()) return route.fallback().catch(constVoid);
    if (!fresh())
      await new Promise<void>((resolve) => {
        const wake = () => {
          waiting.delete(wake);
          clearTimeout(timer);
          resolve();
        };
        // @effect-diagnostics-next-line globalTimers:off -- Playwright's route callback runs outside any Effect.
        const timer = setTimeout(wake, POPUP_ATTRIBUTION_MS);
        waiting.add(wake);
      });
    if (!fresh()) return route.fallback().catch(constVoid);
    credits.shift();
    return route.abort("aborted").catch(constVoid);
  };
  let routed = false;
  let stopped = false;
  const stop = async () => {
    if (stopped) return;
    stopped = true;
    if (routed) await context.unroute("**/*", popups).catch(constVoid);
    for (const session of sessions) await session.detach().catch(constVoid);
  };
  try {
    const cdp = await context.newCDPSession(input.page);
    sessions.push(cdp);
    const { frameTree } = await cdp.send("Page.getFrameTree");
    const { targetInfo } = await cdp.send("Target.getTargetInfo");
    cdp.on("Fetch.requestPaused", (event) => {
      const origin = originOf(event.request.url);
      const leaving = event.frameId === frameTree.frame.id && !allowed.has(origin);
      if (leaving) input.onBreach(`A navigation to ${origin} was refused: it is outside origins.`);
      void (
        leaving
          ? // Aborted keeps the current page; any other reason commits Chrome's error page.
            cdp.send("Fetch.failRequest", { requestId: event.requestId, errorReason: "Aborted" })
          : cdp.send("Fetch.continueRequest", { requestId: event.requestId })
      ).catch(constVoid);
    });
    await cdp.send("Fetch.enable", {
      patterns: [{ urlPattern: "*", resourceType: "Document", requestStage: "Request" }],
    });
    const watcher = await browser.newBrowserCDPSession();
    sessions.push(watcher);
    watcher.on("Target.targetCreated", ({ targetInfo: created }) => {
      if (created.type !== "page" || created.openerId !== targetInfo.targetId) return;
      input.onBreach("A pop-up was refused: page reach keeps to its own tab.");
      credits.push(performance.now());
      for (const wake of waiting) wake();
      void watcher.send("Target.closeTarget", { targetId: created.targetId }).catch(constVoid);
    });
    await watcher.send("Target.setDiscoverTargets", { discover: true });
    await context.route("**/*", popups);
    routed = true;
  } catch (cause) {
    await stop();
    throw cause;
  }
  input.page.once("close", () => void stop());
  return stop;
}
