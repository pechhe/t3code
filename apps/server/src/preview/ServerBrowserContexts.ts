// @effect-diagnostics nodeBuiltinImport:off globalTimers:off - Owns Playwright resources outside the Effect runtime.
import { INCOGNITO_BROWSER_PROFILE_ID } from "@t3tools/contracts";
import { constVoid } from "effect/Function";
import * as NodeFSP from "node:fs/promises";
import * as NodeModule from "node:module";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import type { Browser, BrowserContext, CDPSession } from "playwright-core";

import { ManagedBrowserProxy } from "./ManagedBrowserProxy.ts";
import { sandboxDisabled } from "./PreviewBrowserHost.ts";

// Playwright needs its files on disk. createRequire also resolves it from a Node SEA executable.
const requirePlaywright = NodeModule.createRequire(import.meta.url);
const loadPlaywright = () =>
  requirePlaywright("playwright-core") as typeof import("playwright-core");

const managedStart = async <A>(operation: Promise<A>, message: string) => {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      operation,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(new Error(message)), 5_000);
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
};

interface Options {
  readonly profilesDir: string;
  readonly executable: () => Promise<string>;
  /**
   * A path that starts `executable`, such as one that moves Chrome out of the server's cgroup.
   * Released after the whole launch call, since Playwright retries the same path after a glibc race.
   */
  readonly launcher?: (
    executable: string,
  ) => Promise<{ readonly path: string; readonly release: () => Promise<void> } | undefined>;
  readonly diagnose?: (executable: string, cause: unknown) => Promise<unknown>;
  readonly env?: NodeJS.ProcessEnv;
  readonly onContextClose?: (context: BrowserContext) => void;
}

const UA_PLATFORMS: Partial<Record<NodeJS.Platform, string>> = {
  darwin: "macOS",
  linux: "Linux",
  win32: "Windows",
};

/** Change user agent and Sec-CH-UA together; sites block mismatches. */
const chromeIdentity = (
  headlessUserAgent: string,
  host: { readonly platform: NodeJS.Platform; readonly arch: string; readonly release: string },
) => {
  const version = /HeadlessChrome\/((\d+)[\d.]*)/.exec(headlessUserAgent);
  const fullVersion = version?.[1];
  const major = version?.[2];
  if (!version || !fullVersion || !major) return null;
  const brands = (names: (version: string) => string) => [
    { brand: "Chromium", version: names(major) },
    { brand: "Google Chrome", version: names(major) },
    { brand: "Not A(Brand", version: names("99") },
  ];
  return {
    userAgent: headlessUserAgent.replace(version[0], `Chrome/${major}.0.0.0`),
    userAgentMetadata: {
      brands: brands((value) => value),
      fullVersionList: brands((value) => (value === major ? fullVersion : `${value}.0.0.0`)),
      platform: UA_PLATFORMS[host.platform] ?? "Unknown",
      platformVersion: host.platform === "linux" ? host.release : "",
      architecture: host.arch.startsWith("arm") ? "arm" : "x86",
      bitness: host.arch.endsWith("64") ? "64" : "32",
      model: "",
      mobile: false,
      wow64: false,
    },
  };
};

export const presentAsChrome = async (
  cdp: CDPSession,
  host: { readonly platform: NodeJS.Platform; readonly arch: string },
) => {
  const { userAgent } = await cdp.send("Browser.getVersion");
  const identity = chromeIdentity(userAgent, { ...host, release: NodeOS.release() });
  if (identity) await cdp.send("Emulation.setUserAgentOverride", identity);
};

export class ServerBrowserContexts {
  private readonly options: Options;
  private readonly contexts = new Map<string, Promise<BrowserContext>>();
  private readonly clearing = new Map<string, Promise<void>>();
  private browser: Promise<Browser> | undefined;
  private readonly managedContexts = new Set<BrowserContext>();
  private readonly proxies = new Map<BrowserContext, ManagedBrowserProxy>();
  private readonly managedPolicies = new Map<
    BrowserContext,
    { readonly policy: () => Promise<ReadonlyArray<string> | null>; readonly initial: string }
  >();
  private closing: Promise<void> | undefined;

  constructor(options: Options) {
    this.options = options;
  }

  private async launchOptions() {
    const executable = await this.options.executable();
    const env = this.options.env ?? process.env;
    return {
      executable,
      env,
      args: [
        "--disable-gpu",
        "--force-device-scale-factor=2",
        "--disable-blink-features=AutomationControlled",
      ],
      ignoreDefaultArgs: ["--enable-automation"],
      headless: true,
      // Only an explicit operator opt-out disables sandboxing. Launch errors never do.
      chromiumSandbox: !sandboxDisabled(env),
    };
  }

  private async launch<A>(executable: string, start: (executablePath: string) => Promise<A>) {
    let release: (() => Promise<void>) | undefined;
    try {
      const launcher = await this.options.launcher?.(executable);
      release = launcher?.release;
      return await start(launcher?.path ?? executable);
    } catch (cause) {
      throw (await this.options.diagnose?.(executable, cause)) ?? cause;
    } finally {
      await release?.().catch(constVoid);
    }
  }

  private sharedBrowser() {
    if (!this.browser) {
      const launched = this.launchOptions().then(async ({ executable, ...options }) => {
        const { chromium } = loadPlaywright();
        const browser = await this.launch(executable, (executablePath) =>
          chromium.launch({ ...options, executablePath }),
        );
        browser.on("disconnected", () => {
          if (this.browser === launched) this.browser = undefined;
        });
        return browser;
      });
      this.browser = launched;
      void launched.catch(() => {
        if (this.browser === launched) this.browser = undefined;
      });
    }
    return this.browser;
  }

  contextFor(profileId: string, isolationKey?: string): Promise<BrowserContext> {
    if (this.closing) return Promise.reject(new Error("The preview browser is closed."));
    const key = JSON.stringify([profileId, isolationKey ?? null]);
    const cached = this.contexts.get(key);
    if (cached) return cached;
    const cleared = this.clearing.get(key)?.catch(constVoid) ?? Promise.resolve();
    const pending = cleared
      .then(() => this.createContext(profileId, isolationKey))
      .then(async (context) => {
        context.on("close", () => {
          if (this.contexts.get(key) === pending) this.contexts.delete(key);
          this.options.onContextClose?.(context);
        });
        for (const page of context.pages()) await page.close().catch(constVoid);
        if (this.closing) {
          await context.close().catch(constVoid);
          throw new Error("The preview browser is closed.");
        }
        return context;
      });
    this.contexts.set(key, pending);
    void pending.catch(() => {
      if (this.contexts.get(key) === pending) this.contexts.delete(key);
    });
    return pending;
  }

  private async createContext(profileId: string, isolationKey?: string) {
    const contextOptions = { viewport: { width: 1280, height: 800 }, deviceScaleFactor: 2 };
    if (isolationKey !== undefined || profileId === INCOGNITO_BROWSER_PROFILE_ID) {
      const browser = await this.sharedBrowser();
      return browser.newContext(contextOptions);
    }
    const directory = this.profileDirectory(profileId);
    await NodeFSP.mkdir(directory, { recursive: true });
    const { executable, ...options } = await this.launchOptions();
    const { chromium } = loadPlaywright();
    return this.launch(executable, (executablePath) =>
      chromium.launchPersistentContext(directory, {
        ...options,
        ...contextOptions,
        executablePath,
      }),
    );
  }

  async managedContext(options: {
    readonly serverPort: number;
    readonly policy: () => Promise<ReadonlyArray<string> | null>;
  }) {
    if (this.closing) throw new Error("The preview browser is closed.");
    const initial = await options.policy();
    if (initial === null) throw new Error("Managed browser access was revoked for this project.");
    const proxy = await ManagedBrowserProxy.start(options);
    let browser: Browser | undefined;
    try {
      const launch = await managedStart(
        this.launchOptions(),
        "Managed browser not ready within 5 seconds. Run t3 browser setup.",
      );
      const { chromium } = loadPlaywright();
      const { executable, ...launchOptions } = launch;
      browser = await this.launch(executable, (executablePath) =>
        chromium.launch({
          ...launchOptions,
          executablePath,
          timeout: 10_000,
          proxy: { server: "per-context" },
          args: [
            ...launch.args,
            "--proxy-bypass-list=<-loopback>",
            "--disable-quic",
            "--force-webrtc-ip-handling-policy=disable_non_proxied_udp",
          ],
        }),
      );
      const context = await managedStart(
        browser.newContext({
          viewport: { width: 1280, height: 800 },
          deviceScaleFactor: 2,
          proxy: { ...proxy.configuration, bypass: "<-loopback>" },
          serviceWorkers: "block",
        }),
        "Managed browser context could not start within 5 seconds.",
      );
      this.managedContexts.add(context);
      this.proxies.set(context, proxy);
      this.managedPolicies.set(context, {
        policy: options.policy,
        initial: JSON.stringify(initial),
      });
      const managedBrowser = browser;
      context.once("close", () => {
        this.managedContexts.delete(context);
        this.proxies.delete(context);
        this.managedPolicies.delete(context);
        void proxy.close();
        void managedBrowser.close();
        this.options.onContextClose?.(context);
      });
      browser.once("disconnected", () => {
        void context.close();
        void proxy.close();
      });
      const current = await options.policy();
      if (this.closing || current === null || JSON.stringify(current) !== JSON.stringify(initial)) {
        await context.close();
        throw new Error(
          this.closing
            ? "The preview browser is closed."
            : "Managed browser access was revoked while the browser started.",
        );
      }
      return context;
    } catch (error) {
      await browser?.close();
      await proxy.close();
      throw error;
    }
  }

  async refreshManagedPolicies() {
    await Promise.all(
      [...this.managedPolicies].map(async ([context, entry]) => {
        const current = await entry.policy();
        if (current === null || JSON.stringify(current) !== entry.initial) await context.close();
      }),
    );
  }

  networkRefusalCount(context: BrowserContext) {
    return this.proxies.get(context)?.refusalCount ?? 0;
  }

  networkRefusals(context: BrowserContext) {
    return this.proxies.get(context)?.refusals ?? [];
  }

  private profileDirectory(profileId: string) {
    const encoded = encodeURIComponent(profileId);
    return NodePath.join(
      this.options.profilesDir,
      profileId === "." || profileId === ".." ? encoded.replaceAll(".", "%2E") : encoded,
    );
  }

  async scratchPage() {
    if (this.closing) throw new Error("The preview browser is closed.");
    const context = await (await this.sharedBrowser()).newContext();
    const page = await context.newPage();
    page.once("close", () => void context.close().catch(constVoid));
    return page;
  }

  async connectDesktopPage(endpoint: string) {
    const { chromium } = loadPlaywright();
    const browser = await chromium.connectOverCDP(endpoint, { timeout: 15_000 });
    const page = browser.contexts().flatMap((context) => context.pages())[0];
    if (!page) {
      await browser.close().catch(constVoid);
      throw new Error("The desktop tab has no page.");
    }
    return { browser, page };
  }

  async clearProfile(profileId: string) {
    if (profileId === INCOGNITO_BROWSER_PROFILE_ID) return;
    const key = JSON.stringify([profileId, null]);
    const existing = this.clearing.get(key);
    if (existing) return existing;
    const clearing = (async () => {
      const pending = this.contexts.get(key);
      if (pending) {
        this.contexts.delete(key);
        const context = await pending.catch(() => undefined);
        await context?.close();
      }
      await NodeFSP.rm(this.profileDirectory(profileId), { recursive: true, force: true });
    })();
    this.clearing.set(key, clearing);
    try {
      await clearing;
    } finally {
      if (this.clearing.get(key) === clearing) this.clearing.delete(key);
    }
  }

  close() {
    this.closing ??= this.dispose();
    return this.closing;
  }

  private async dispose() {
    await Promise.allSettled(
      [
        ...this.contexts.values(),
        ...[...this.managedContexts].map((context) => Promise.resolve(context)),
      ].map(async (pending) => (await pending).close()),
    );
    const browser = await this.browser?.catch(() => undefined);
    await browser?.close().catch(constVoid);
    this.contexts.clear();
  }
}
