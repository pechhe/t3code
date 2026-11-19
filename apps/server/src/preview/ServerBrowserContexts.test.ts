// @effect-diagnostics nodeBuiltinImport:off - Hands a real file on disk to a real desktop browser.
import * as NodeEvents from "node:events";
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import { INCOGNITO_BROWSER_PROFILE_ID } from "@t3tools/contracts";
import * as HostProcess from "@t3tools/shared/HostProcess";
import { it as effectIt } from "@effect/vitest";
import * as Effect from "effect/Effect";
import { chromium, type Browser, type BrowserContext, type BrowserType } from "playwright-core";
import { beforeEach, describe, expect, it, vi } from "vite-plus/test";

import { presentAsChrome, ServerBrowserContexts } from "./ServerBrowserContexts.ts";

const launches = vi.hoisted(() => ({
  launch: vi.fn<BrowserType["launch"]>(),
  persistent: vi.fn<BrowserType["launchPersistentContext"]>(),
  mkdir: vi.fn().mockResolvedValue(undefined),
  rm: vi.fn().mockResolvedValue(undefined),
}));
const launchChromium = chromium.launch.bind(chromium);
const launchPersistentChromium = chromium.launchPersistentContext.bind(chromium);
vi.spyOn(chromium, "launch").mockImplementation(launches.launch);
vi.spyOn(chromium, "launchPersistentContext").mockImplementation(launches.persistent);
vi.mock("node:fs/promises", () => ({ mkdir: launches.mkdir, rm: launches.rm }));

const makeContext = (closeGate?: Promise<void>) => {
  const events = new NodeEvents.EventEmitter();
  let closed = false;
  return {
    on: vi.fn((event: string, listener: () => void) => events.on(event, listener)),
    once: vi.fn((event: string, listener: () => void) => events.once(event, listener)),
    pages: vi.fn(() => []),
    newPage: vi.fn(async () => ({ once: vi.fn() })),
    isClosed: () => closed,
    close: vi.fn(async () => {
      await closeGate;
      if (!closed) {
        closed = true;
        events.emit("close");
      }
    }),
  };
};

const makeBrowser = () => {
  const events = new NodeEvents.EventEmitter();
  const contexts: ReturnType<typeof makeContext>[] = [];
  return {
    created: contexts,
    contexts: () => contexts.filter((context) => !context.isClosed()),
    on: vi.fn((event: string, listener: () => void) => events.on(event, listener)),
    once: vi.fn((event: string, listener: () => void) => events.once(event, listener)),
    newContext: vi.fn(async () => {
      const context = makeContext();
      contexts.push(context);
      return context as unknown as BrowserContext;
    }),
    close: vi.fn(async () => {
      for (const context of contexts) await context.close();
      events.emit("disconnected");
    }),
  };
};

const options = () => ({
  profilesDir: "/test/profiles",
  executable: vi.fn(async () => "/test/chromium"),
  env: {},
  chrome: { version: "157.0.8103.78", platform: "linux" as NodeJS.Platform },
});

const withLauncher = () => {
  const release = vi.fn(async () => {});
  return {
    release,
    configuration: {
      ...options(),
      launcher: vi.fn(async (executable: string) => ({ path: `${executable}-launcher`, release })),
    },
  };
};

beforeEach(() => {
  launches.launch.mockReset();
  launches.persistent.mockReset();
  launches.mkdir.mockClear();
  launches.rm.mockClear();
});

describe("ServerBrowserContexts", () => {
  it("closes the shared browser only after it holds no context for the idle period", async () => {
    vi.useFakeTimers();
    try {
      const first = makeBrowser();
      const second = makeBrowser();
      launches.launch
        .mockResolvedValueOnce(first as unknown as Browser)
        .mockResolvedValueOnce(second as unknown as Browser);
      const pool = new ServerBrowserContexts({ ...options(), idleBrowserMs: 10 });
      const agent = await pool.contextFor("default", "agent");
      await pool.scratchPage();
      await agent.close();
      await vi.advanceTimersByTimeAsync(10);
      expect(first.close).not.toHaveBeenCalled();
      await first.created[1]!.close();
      await vi.advanceTimersByTimeAsync(9);
      const next = await pool.contextFor("default", "next");
      await vi.advanceTimersByTimeAsync(10);
      expect(first.close).not.toHaveBeenCalled();
      await next.close();
      await vi.advanceTimersByTimeAsync(10);
      expect(first.close).toHaveBeenCalledOnce();
      await pool.contextFor("default", "later");
      expect(launches.launch).toHaveBeenCalledTimes(2);
      expect(second.newContext).toHaveBeenCalledOnce();
      await pool.close();
    } finally {
      vi.useRealTimers();
    }
  });

  it("closes a scratch context when creating its page fails", async () => {
    const browser = makeBrowser();
    launches.launch.mockResolvedValue(browser as unknown as Browser);
    const pool = new ServerBrowserContexts(options());
    const peer = await pool.contextFor("default", "peer");
    const context = await browser.newContext();
    const failure = new Error("newPage failed");
    browser.created[1]!.newPage.mockRejectedValueOnce(failure);
    browser.newContext.mockResolvedValueOnce(context);
    try {
      await expect(pool.scratchPage()).rejects.toBe(failure);
      expect(context.close).toHaveBeenCalledOnce();
      expect(browser.contexts()).toEqual([peer]);
      expect(peer.close).not.toHaveBeenCalled();
      expect(browser.close).not.toHaveBeenCalled();
    } finally {
      await pool.close();
    }
  });

  it("lazily shares one browser across concurrent isolated sessions and reuses each context", async () => {
    const browser = makeBrowser();
    const launch = Promise.withResolvers<Browser>();
    const started = Promise.withResolvers<void>();
    launches.launch.mockImplementation(() => {
      started.resolve();
      return launch.promise;
    });
    const { configuration, release } = withLauncher();
    const pool = new ServerBrowserContexts(configuration);
    expect(configuration.executable).not.toHaveBeenCalled();
    const first = pool.contextFor("default", "agent-a");
    const again = pool.contextFor("default", "agent-a");
    const second = pool.contextFor("default", "agent-b");
    const incognito = pool.contextFor(INCOGNITO_BROWSER_PROFILE_ID);
    await started.promise;
    // Playwright may retry the same path until the launch settles.
    expect(release).not.toHaveBeenCalled();
    launch.resolve(browser as unknown as Browser);
    const [a, reused, b, privateContext] = await Promise.all([first, again, second, incognito]);
    expect(release).toHaveBeenCalledTimes(1);
    expect(a).toBe(reused);
    expect(new Set([a, b, privateContext]).size).toBe(3);
    expect(launches.launch).toHaveBeenCalledExactlyOnceWith(
      expect.objectContaining({ executablePath: "/test/chromium-launcher" }),
    );
    expect(launches.persistent).not.toHaveBeenCalled();
    expect(browser.newContext).toHaveBeenCalledWith({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 2,
    });
    await pool.close();
    expect(browser.close).toHaveBeenCalledTimes(1);
    for (const context of browser.created) expect(context.close).toHaveBeenCalled();
  });

  it("closes a profile context when its last holder releases it", async () => {
    const human = makeContext();
    const reopened = makeContext();
    launches.persistent
      .mockResolvedValueOnce(human as unknown as BrowserContext)
      .mockResolvedValueOnce(reopened as unknown as BrowserContext);
    const pool = new ServerBrowserContexts(options());
    const persistent = await pool.contextFor("work/team");
    pool.hold(persistent);
    pool.hold(persistent);
    pool.release(persistent);
    expect(human.close).not.toHaveBeenCalled();
    pool.release(persistent);
    expect(human.close).toHaveBeenCalledTimes(1);
    expect(await pool.contextFor("work/team")).not.toBe(persistent);
    expect(launches.persistent).toHaveBeenCalledTimes(2);
    await pool.close();
  });

  it("waits for a closing profile browser before it clears or reopens the profile", async () => {
    const gate = Promise.withResolvers<void>();
    const human = makeContext(gate.promise);
    const reopened = makeContext();
    launches.persistent
      .mockResolvedValueOnce(human as unknown as BrowserContext)
      .mockResolvedValueOnce(reopened as unknown as BrowserContext);
    const pool = new ServerBrowserContexts(options());
    const persistent = await pool.contextFor("work/team");
    pool.hold(persistent);
    pool.release(persistent);
    const clearing = pool.clearProfile("work/team");
    const reopening = pool.contextFor("work/team");
    await Promise.resolve();
    expect(launches.rm).not.toHaveBeenCalled();
    expect(launches.persistent).toHaveBeenCalledTimes(1);
    gate.resolve();
    await clearing;
    expect(launches.rm).toHaveBeenCalledExactlyOnceWith("/test/profiles/work%2Fteam", {
      recursive: true,
      force: true,
    });
    expect(await reopening).toBe(reopened);
    expect(launches.persistent).toHaveBeenCalledTimes(2);
    await pool.close();
  });

  it("keeps a clear's storage deletion ahead of a reopen that follows its last tab closing", async () => {
    const closeGate = Promise.withResolvers<void>();
    const removing = Promise.withResolvers<void>();
    const removed = Promise.withResolvers<void>();
    const human = makeContext(closeGate.promise);
    const reopened = makeContext();
    launches.persistent
      .mockResolvedValueOnce(human as unknown as BrowserContext)
      .mockResolvedValueOnce(reopened as unknown as BrowserContext);
    launches.rm.mockImplementationOnce(async () => {
      removing.resolve();
      await removed.promise;
    });
    const pool = new ServerBrowserContexts(options());
    const persistent = await pool.contextFor("work/team");
    pool.hold(persistent);
    const clearing = pool.clearProfile("work/team");
    pool.release(persistent);
    const reopening = pool.contextFor("work/team");
    closeGate.resolve();
    await removing.promise;
    // A macrotask lets any reopen that escaped the clear start its launch.
    // oxlint-disable-next-line t3code/no-real-time-wait-in-tests -- no promise marks a launch that should not happen; a macrotask turn lets a stray one start first.
    await new Promise((resolve) => setImmediate(resolve));
    expect(launches.persistent).toHaveBeenCalledTimes(1);
    removed.resolve();
    await clearing;
    expect(await reopening).toBe(reopened);
    expect(launches.persistent).toHaveBeenCalledTimes(2);
    await pool.close();
  });

  it("keeps a reopen already waiting behind a clear when a release follows it", async () => {
    const closeGate = Promise.withResolvers<void>();
    const human = makeContext(closeGate.promise);
    const reopened = makeContext();
    launches.persistent
      .mockResolvedValueOnce(human as unknown as BrowserContext)
      .mockResolvedValueOnce(reopened as unknown as BrowserContext);
    const pool = new ServerBrowserContexts(options());
    const persistent = await pool.contextFor("work/team");
    pool.hold(persistent);
    const clearing = pool.clearProfile("work/team");
    const first = pool.contextFor("work/team");
    pool.release(persistent);
    const second = pool.contextFor("work/team");
    expect(second).toBe(first);
    closeGate.resolve();
    await clearing;
    expect(await first).toBe(reopened);
    expect(await second).toBe(reopened);
    expect(launches.persistent).toHaveBeenCalledTimes(2);
    await pool.close();
  });

  it("keeps human profiles persistent without sharing their storage with agents", async () => {
    const human = makeContext();
    const browser = makeBrowser();
    launches.persistent.mockResolvedValue(human as unknown as BrowserContext);
    launches.launch.mockResolvedValue(browser as unknown as Browser);
    const { configuration, release } = withLauncher();
    const pool = new ServerBrowserContexts(configuration);
    const persistent = await pool.contextFor("work/team");
    expect(await pool.contextFor("work/team")).toBe(persistent);
    expect(await pool.contextFor("work/team", "agent")).not.toBe(persistent);
    expect(launches.persistent).toHaveBeenCalledExactlyOnceWith(
      "/test/profiles/work%2Fteam",
      expect.objectContaining({ chromiumSandbox: true, executablePath: "/test/chromium-launcher" }),
    );
    expect(release).toHaveBeenCalledTimes(2);
    expect(launches.mkdir).toHaveBeenCalledWith("/test/profiles/work%2Fteam", { recursive: true });
    await pool.close();
    expect(human.close).toHaveBeenCalledTimes(1);
  });

  it("diagnoses a launcher failure against the real executable", async () => {
    const diagnosed = new Error("diagnosed");
    const diagnose = vi.fn(async () => diagnosed);
    const pool = new ServerBrowserContexts({
      ...options(),
      diagnose,
      launcher: vi.fn(async () => {
        throw new Error("EACCES");
      }),
    });
    await expect(pool.contextFor("default", "agent")).rejects.toBe(diagnosed);
    expect(diagnose).toHaveBeenCalledExactlyOnceWith("/test/chromium", expect.any(Error));
    expect(launches.launch).not.toHaveBeenCalled();
  });

  it("creates no launcher for a profile whose storage cannot be created", async () => {
    launches.mkdir.mockRejectedValueOnce(new Error("EACCES"));
    const { configuration } = withLauncher();
    const pool = new ServerBrowserContexts(configuration);
    await expect(pool.contextFor("work/team")).rejects.toThrow("EACCES");
    expect(configuration.launcher).not.toHaveBeenCalled();
  });

  it("clears a profile by closing its open context before deleting its storage", async () => {
    const human = makeContext();
    const browser = makeBrowser();
    launches.persistent.mockResolvedValue(human as unknown as BrowserContext);
    launches.launch.mockResolvedValue(browser as unknown as Browser);
    const onContextClose = vi.fn();
    const pool = new ServerBrowserContexts({ ...options(), onContextClose });
    const persistent = await pool.contextFor("work/team");
    const agent = await pool.contextFor("work/team", "agent");
    launches.rm.mockImplementationOnce(async () => {
      expect(human.close).toHaveBeenCalledTimes(1);
    });
    await pool.clearProfile("work/team");
    expect(onContextClose).toHaveBeenCalledExactlyOnceWith(persistent);
    expect(launches.rm).toHaveBeenCalledExactlyOnceWith("/test/profiles/work%2Fteam", {
      recursive: true,
      force: true,
    });
    expect(await pool.contextFor("work/team", "agent")).toBe(agent);
    expect(browser.created[0]?.close).not.toHaveBeenCalled();
    launches.persistent.mockResolvedValue(makeContext() as unknown as BrowserContext);
    expect(await pool.contextFor("work/team")).not.toBe(persistent);
    await pool.clearProfile("never-opened");
    expect(launches.rm).toHaveBeenLastCalledWith("/test/profiles/never-opened", {
      recursive: true,
      force: true,
    });
    await pool.close();
  });

  it("waits for the context to close when the same profile is cleared concurrently", async () => {
    const human = makeContext();
    const closed = Promise.withResolvers<void>();
    human.close.mockImplementation(async () => closed.promise);
    launches.persistent.mockResolvedValue(human as unknown as BrowserContext);
    const pool = new ServerBrowserContexts(options());
    await pool.contextFor("work/team");

    const first = pool.clearProfile("work/team");
    const second = pool.clearProfile("work/team");
    const deletionsBeforeClose = launches.rm.mock.calls.length;
    closed.resolve();
    await Promise.all([first, second]);

    expect(deletionsBeforeClose).toBe(0);
    expect(human.close).toHaveBeenCalledTimes(1);
    expect(launches.rm).toHaveBeenCalledExactlyOnceWith("/test/profiles/work%2Fteam", {
      recursive: true,
      force: true,
    });
    await pool.close();
  });

  it("opens a profile requested during its clear only after the storage is deleted", async () => {
    launches.persistent.mockImplementation(async () => makeContext() as unknown as BrowserContext);
    const configuration = options();
    const pool = new ServerBrowserContexts(configuration);
    await pool.contextFor("work/team");
    const removing = Promise.withResolvers<void>();
    const removed = Promise.withResolvers<void>();
    let deleted = false;
    launches.rm.mockImplementationOnce(async () => {
      removing.resolve();
      await removed.promise;
      deleted = true;
    });
    const launchedAfterDelete: Array<boolean> = [];
    configuration.executable.mockImplementation(async () => {
      launchedAfterDelete.push(deleted);
      return "/test/chromium";
    });
    const clearing = pool.clearProfile("work/team");
    const reopening = pool.contextFor("work/team");
    await removing.promise;
    removed.resolve();
    await Promise.all([clearing, reopening]);
    expect(launchedAfterDelete).toEqual([true]);
    await pool.close();
  });

  it.each([undefined, "default"])(
    "never retries a failed %s launch with the sandbox disabled",
    async (profile) => {
      const launch = profile ? launches.persistent : launches.launch;
      launch.mockRejectedValue(new Error("sandbox unavailable"));
      const pool = new ServerBrowserContexts(options());
      await expect(pool.contextFor(profile ?? INCOGNITO_BROWSER_PROFILE_ID)).rejects.toThrow(
        "sandbox unavailable",
      );
      expect(launch).toHaveBeenCalledTimes(1);
      expect(
        profile ? launches.persistent.mock.calls[0]?.[1] : launches.launch.mock.calls[0]?.[0],
      ).toMatchObject({ chromiumSandbox: true });
      await pool.close();
    },
  );

  it("allows only an explicit sandbox opt-out", async () => {
    const browser = makeBrowser();
    launches.launch.mockResolvedValue(browser as unknown as Browser);
    const pool = new ServerBrowserContexts({
      ...options(),
      env: { T3CODE_SERVER_BROWSER_SANDBOX: "0" },
    });
    await pool.contextFor(INCOGNITO_BROWSER_PROFILE_ID);
    expect(launches.launch).toHaveBeenCalledWith(
      expect.objectContaining({ chromiumSandbox: false }),
    );
    await pool.close();
  });

  it("retries a failed startup on a later request with sandboxing still enabled", async () => {
    const browser = makeBrowser();
    launches.launch
      .mockRejectedValueOnce(new Error("executable unavailable"))
      .mockResolvedValue(browser as unknown as Browser);
    const pool = new ServerBrowserContexts(options());
    await expect(pool.contextFor("default", "agent")).rejects.toThrow("executable unavailable");
    await pool.contextFor("default", "agent");
    expect(launches.launch).toHaveBeenCalledTimes(2);
    expect(launches.launch).toHaveBeenLastCalledWith(
      expect.objectContaining({ chromiumSandbox: true }),
    );
    await pool.close();
  });

  it("cleans up a browser whose launch finishes during shutdown and rejects future work", async () => {
    const browser = makeBrowser();
    const launch = Promise.withResolvers<Browser>();
    launches.launch.mockReturnValue(launch.promise);
    const pool = new ServerBrowserContexts(options());
    const opening = expect(pool.contextFor("default", "agent")).rejects.toThrow("closed");
    const closing = pool.close();
    launch.resolve(browser as unknown as Browser);
    await Promise.all([opening, closing]);
    await expect(pool.contextFor("default", "agent")).rejects.toThrow("closed");
    await pool.close();
    expect(browser.close).toHaveBeenCalledTimes(1);
    expect(browser.created[0]?.close).toHaveBeenCalled();
  });

  it("uploads a file over 50 MB to a desktop tab, which shares the server's filesystem", async () => {
    const directory = NodeFS.mkdtempSync(NodePath.join(NodeOS.tmpdir(), "t3-desktop-upload-"));
    const userDataDir = NodePath.join(directory, "profile");
    const pool = new ServerBrowserContexts(options());
    try {
      const desktop = await launchPersistentChromium(userDataDir, {
        headless: true,
        args: ["--remote-debugging-port=0"],
      });
      try {
        const [port] = NodeFS.readFileSync(
          NodePath.join(userDataDir, "DevToolsActivePort"),
          "utf8",
        ).split("\n");
        const { browser, page } = await pool.connectDesktopPage(`http://127.0.0.1:${port}`);
        try {
          const file = NodePath.join(directory, "large.bin");
          NodeFS.writeFileSync(file, "");
          NodeFS.truncateSync(file, 51 * 1024 * 1024);
          await page.setContent(`<input type="file">`);
          await page.locator("input").setInputFiles(file);
          expect(
            await page.$eval("input", (input) =>
              Array.from(
                (input as unknown as { files: ArrayLike<{ name: string; size: number }> }).files,
                ({ name, size }) => ({ name, size }),
              ),
            ),
          ).toEqual([{ name: "large.bin", size: 51 * 1024 * 1024 }]);
        } finally {
          await browser.close();
        }
      } finally {
        await pool.close();
        await desktop.close();
      }
    } finally {
      NodeFS.rmSync(directory, { recursive: true, force: true });
    }
  });

  const sendsOneChromeIdentity = async (host: {
    readonly platform: NodeJS.Platform;
    readonly arch: string;
  }) => {
    // The pool's own launch options, on the browser Playwright installs for tests.
    launches.launch.mockImplementation((launch = {}) => {
      const { executablePath: _installed, ...bundled } = launch;
      return launchChromium(bundled);
    });
    const server = NodeHttp.createServer((request, response) => {
      const send = (type: string, body: string) =>
        response.writeHead(200, { "content-type": type }).end(body);
      if (request.url === "/worker.js") {
        return send(
          "text/javascript",
          `addEventListener("activate", (event) => event.waitUntil(clients.claim()));
           addEventListener("fetch", (event) => event.respondWith(fetch(event.request)));`,
        );
      }
      if (request.url === "/identity") {
        return send(
          "application/json",
          JSON.stringify({
            userAgent: request.headers["user-agent"],
            brands: request.headers["sec-ch-ua"],
          }),
        );
      }
      return send("text/html", "<!doctype html>");
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    try {
      // What this browser sends on this host without any override, as the oracle.
      const probe = await launchChromium();
      const version = probe.version();
      const major = version.split(".")[0];
      const headless = await (await probe.newPage()).evaluate(() => navigator.userAgent);
      await probe.close();
      const pool = new ServerBrowserContexts({
        ...options(),
        env: { ...process.env, T3CODE_SERVER_BROWSER_SANDBOX: "0" },
        chrome: { version, platform: host.platform },
      });
      try {
        const context = await pool.contextFor(INCOGNITO_BROWSER_PROFILE_ID);
        const page = await context.newPage();
        await presentAsChrome(await context.newCDPSession(page), host);
        await page.goto(`http://127.0.0.1:${(server.address() as NodeNet.AddressInfo).port}/`);
        const [fromPage, throughWorker] = (await page.evaluate(`(async () => {
          const identity = async () => (await fetch("/identity")).json();
          const fromPage = await identity();
          const controlled = new Promise((resolve) =>
            navigator.serviceWorker.addEventListener("controllerchange", resolve, { once: true }),
          );
          await navigator.serviceWorker.register("/worker.js");
          await controlled;
          return [fromPage, await identity()];
        })()`)) as ReadonlyArray<{ readonly userAgent: string; readonly brands: string }>;
        expect(headless).toContain(`HeadlessChrome/${version} `);
        expect(fromPage?.userAgent).toBe(
          headless.replace(`HeadlessChrome/${version}`, `Chrome/${major}.0.0.0`),
        );
        expect(fromPage?.brands).toContain('"Google Chrome"');
        expect(throughWorker?.userAgent).toBe(fromPage?.userAgent);
      } finally {
        await pool.close();
      }
    } finally {
      server.closeAllConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    }
  };

  effectIt.live("sends one Chrome identity from a page and from its service worker", () =>
    Effect.gen(function* () {
      const host = { platform: yield* HostProcess.Platform, arch: yield* HostProcess.Architecture };
      yield* Effect.promise(() => sendsOneChromeIdentity(host));
    }),
  );
});

it("gives each managed context a dedicated proxied launch, credentials and ephemeral storage", async () => {
  const first = makeBrowser();
  const second = makeBrowser();
  launches.launch
    .mockResolvedValueOnce(first as unknown as Browser)
    .mockResolvedValueOnce(second as unknown as Browser);
  const pool = new ServerBrowserContexts(options());
  try {
    const a = await pool.managedContext({ serverPort: 3000, policy: async () => [] });
    const b = await pool.managedContext({ serverPort: 3000, policy: async () => [] });
    expect(a).not.toBe(b);
    expect(launches.persistent).not.toHaveBeenCalled();
    for (const call of launches.launch.mock.calls) {
      expect(call[0]).toMatchObject({
        proxy: { server: "per-context" },
        chromiumSandbox: true,
        timeout: 10_000,
      });
      expect(call[0]?.args).toEqual(
        expect.arrayContaining([
          "--proxy-bypass-list=<-loopback>",
          "--disable-quic",
          "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
        ]),
      );
    }
    expect(first.newContext.mock.calls[0]).toEqual([
      expect.objectContaining({
        serviceWorkers: "block",
        proxy: expect.objectContaining({
          username: expect.any(String),
          password: expect.any(String),
        }),
      }),
    ]);
    await a.close();
    expect(first.close).toHaveBeenCalled();
    expect(second.close).not.toHaveBeenCalled();
  } finally {
    await pool.close();
  }
});

it("refuses a failed managed launch and disposes its proxy without falling back", async () => {
  launches.launch.mockRejectedValueOnce(new Error("fixture launch failed"));
  const pool = new ServerBrowserContexts(options());
  try {
    await expect(pool.managedContext({ serverPort: 3000, policy: async () => [] })).rejects.toThrow(
      "fixture launch failed",
    );
    expect(launches.launch).toHaveBeenCalledTimes(1);
    expect(launches.persistent).not.toHaveBeenCalled();
  } finally {
    await pool.close();
  }
});

it("lets a slow browser start finish inside the caller's own limit", async () => {
  vi.useFakeTimers();
  const browser = makeBrowser();
  const launch = Promise.withResolvers<Browser>();
  launches.launch.mockImplementationOnce(() => launch.promise);
  const pool = new ServerBrowserContexts(options());
  try {
    const opening = pool.managedContext({
      serverPort: 3000,
      policy: async () => [],
      startTimeoutMs: 15_000,
    });
    const failed = vi.fn();
    void opening.catch(failed);
    // Past five seconds the start is still going: the open's own limit is its only cap.
    await vi.advanceTimersByTimeAsync(8_000);
    expect(failed).not.toHaveBeenCalled();
    // Nor does Playwright's own launch timeout cut it short.
    expect(launches.launch.mock.calls.at(-1)?.[0]).toMatchObject({ timeout: 0 });
    launch.resolve(browser as unknown as Browser);
    await vi.advanceTimersByTimeAsync(0);
    await expect(opening).resolves.toBe(browser.created[0]);
    expect(browser.close).not.toHaveBeenCalled();
  } finally {
    await pool.close();
    vi.useRealTimers();
  }
});

it("fails a browser that never starts at the caller's limit and closes it when it arrives", async () => {
  vi.useFakeTimers();
  const started = Promise.withResolvers<void>();
  const launch = Promise.withResolvers<Browser>();
  const browser = makeBrowser();
  launches.launch.mockImplementationOnce(() => {
    started.resolve();
    return launch.promise;
  });
  const pool = new ServerBrowserContexts(options());
  try {
    const opening = expect(
      pool.managedContext({ serverPort: 3000, policy: async () => [], startTimeoutMs: 15_000 }),
    ).rejects.toMatchObject({
      name: "TimeoutError",
      message: "The browser never started before the open's limit passed.",
    });
    await started.promise;
    await vi.advanceTimersByTimeAsync(15_000);
    await opening;
    // The abandoned launch still owns a browser process, so it is closed when it finally resolves.
    launch.resolve(browser as unknown as Browser);
    await vi.advanceTimersByTimeAsync(0);
    expect(browser.close).toHaveBeenCalled();
    expect(browser.newContext).not.toHaveBeenCalled();
  } finally {
    await pool.close();
    vi.useRealTimers();
  }
});

it("refuses a browser whose executable never resolves at the caller's limit", async () => {
  vi.useFakeTimers();
  const started = Promise.withResolvers<void>();
  const pool = new ServerBrowserContexts({
    ...options(),
    executable: () => {
      started.resolve();
      return new Promise<string>(() => {});
    },
  });
  try {
    const opening = expect(
      pool.managedContext({ serverPort: 3000, policy: async () => [], startTimeoutMs: 15_000 }),
    ).rejects.toThrow("never started");
    await started.promise;
    await vi.advanceTimersByTimeAsync(15_000);
    await opening;
    expect(launches.launch).not.toHaveBeenCalled();
  } finally {
    await pool.close();
    vi.useRealTimers();
  }
});

it("closes a managed context whose access is revoked while Chromium starts", async () => {
  const browser = makeBrowser();
  const launch = Promise.withResolvers<Browser>();
  const started = Promise.withResolvers<void>();
  let policy: ReadonlyArray<string> | null = [];
  launches.launch.mockImplementationOnce(() => {
    started.resolve();
    return launch.promise;
  });
  const pool = new ServerBrowserContexts(options());
  try {
    const opening = expect(
      pool.managedContext({ serverPort: 3000, policy: async () => policy }),
    ).rejects.toThrow("revoked");
    await started.promise;
    policy = null;
    launch.resolve(browser as unknown as Browser);
    await opening;
    expect(browser.created[0]?.close).toHaveBeenCalled();
    expect(browser.close).toHaveBeenCalled();
  } finally {
    await pool.close();
  }
});

it("bounds a stalled context start by the caller's limit and closes the managed browser", async () => {
  vi.useFakeTimers();
  const started = Promise.withResolvers<void>();
  const browser = makeBrowser();
  browser.newContext.mockImplementationOnce(() => {
    started.resolve();
    return new Promise<BrowserContext>(() => {});
  });
  launches.launch.mockResolvedValueOnce(browser as unknown as Browser);
  const pool = new ServerBrowserContexts(options());
  try {
    const opening = expect(
      pool.managedContext({ serverPort: 3000, policy: async () => [], startTimeoutMs: 15_000 }),
    ).rejects.toThrow("never started");
    await started.promise;
    await vi.advanceTimersByTimeAsync(15_000);
    await opening;
    expect(browser.close).toHaveBeenCalled();
  } finally {
    await pool.close();
    vi.useRealTimers();
  }
});
