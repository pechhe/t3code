#!/usr/bin/env node
// @effect-diagnostics nodeBuiltinImport:off globalTimers:off globalDate:off globalConsole:off - A measurement script: pacing and wall-clock timing are the point, and it runs outside the server runtime.
// Live paired evaluation of bounded decision engines against the managed headless browser.
// Usage: node scripts/evaluate-browser-decisions.ts --out <dir> [--engines jev,luna] [--repeats 1]
//   [--journeys id,id] [--revision <commit>] [--concurrency 1]
// Provider keys come from TYPESAFE_API_KEY / OPENAI_API_KEY in the environment (DecisionService).
import * as NodeCrypto from "node:crypto";
import * as NodeFS from "node:fs";
import * as NodePath from "node:path";
import * as NodeUtil from "node:util";
import * as PlatformCrypto from "@effect/platform-node/NodeCrypto";
import * as PreviewAgentActivity from "../src/preview/PreviewAgentActivity.ts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { chromium } from "playwright-core";
import {
  EnvironmentId,
  PreviewTabId,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
  type PreviewAutomationSnapshot,
  type PreviewAutomationStatus,
} from "@t3tools/contracts";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Stream from "effect/Stream";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as ServerSecretStore from "../src/auth/ServerSecretStore.ts";
import * as ServerConfig from "../src/config.ts";
import * as DecisionService from "../src/decisions/DecisionService.ts";
import * as ServerEnvironment from "../src/environment/ServerEnvironment.ts";
import * as Broker from "../src/mcp/PreviewAutomationBroker.ts";
import * as DesktopChannel from "../src/preview/DesktopBrowserChannel.ts";
import * as Manager from "../src/preview/Manager.ts";
import * as PreviewBrowser from "../src/preview/PreviewBrowser.ts";
import * as ServerBrowser from "../src/preview/ServerBrowser.ts";
import * as ServerSettings from "../src/serverSettings.ts";
import {
  BROWSER_RULE,
  makeServiceEngine,
  type DecisionClient,
} from "../src/browserDecisionEval/serviceEngine.ts";
import { observationFromSnapshot } from "../src/browserDecisionEval/observation.ts";
import { FIXTURE_VERSION, JOURNEYS, startFixture } from "../src/browserDecisionEval/journeys.ts";
import {
  grade,
  runDecisionJourney,
  type BrowserDriver,
  type JourneyDefinition,
} from "../src/browserDecisionEval/journeyRunner.ts";
import type { McpThreadInvocationScope } from "../src/mcp/McpInvocationContext.ts";

/** Digests of every harness source file, so a result is tied to the exact code that produced it. */
const sourceDigests = () => {
  const root = new URL("../", import.meta.url);
  const files = [
    ...NodeFS.readdirSync(new URL("src/browserDecisionEval/", root))
      .filter((name) => name.endsWith(".ts"))
      .map((name) => `src/browserDecisionEval/${name}`),
    "scripts/evaluate-browser-decisions.ts",
    "scripts/serve-browser-fixtures.ts",
  ].toSorted();
  const hash = NodeCrypto.createHash("sha256");
  const perFile: Record<string, string> = {};
  for (const file of files) {
    const bytes = NodeFS.readFileSync(new URL(file, root));
    hash.update(`${file}\0`).update(bytes);
    perFile[file] = NodeCrypto.createHash("sha256").update(bytes).digest("hex");
  }
  return { tree: hash.digest("hex"), perFile };
};

const { values } = NodeUtil.parseArgs({
  options: {
    out: { type: "string" },
    engines: { type: "string", default: "jev,luna" },
    repeats: { type: "string", default: "1" },
    journeys: { type: "string" },
    revision: { type: "string", default: "unrecorded" },
    concurrency: { type: "string", default: "1" },
    "max-steps": { type: "string", default: "12" },
    "cancel-after-decisions": { type: "string" },
  },
});
if (!values.out) throw new Error("Use --out <directory>.");
NodeFS.mkdirSync(values.out, { recursive: true });
const engines = values.engines.split(",") as ("jev" | "luna")[];
const selected = values.journeys
  ? JOURNEYS.filter((journey) => values.journeys!.split(",").includes(journey.id))
  : JOURNEYS;

const scopeFor = (name: string): McpThreadInvocationScope => ({
  environmentId: EnvironmentId.make("browser-decision-eval"),
  requestNamespace: name,
  thread: {
    threadId: ThreadId.make(name),
    providerSessionId: name,
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["preview"]),
  issuedAt: 0,
  managedBrowser: true,
  managedProjectId: ProjectId.make("browser-decision-eval"),
  taskBrowser: { backend: "integrated" },
  browserBackends: { enabled: ["integrated"], default: "integrated" },
});

const dependencies = Layer.mergeAll(
  Broker.layer.pipe(Layer.provideMerge(Manager.layer)),
  Layer.succeed(ServerEnvironment.ServerEnvironment, {
    getEnvironmentId: Effect.succeed(EnvironmentId.make("browser-decision-eval")),
    getDescriptor: Effect.die("unused"),
  } as never),
  Layer.succeed(PreviewBrowser.PreviewBrowser, {
    executable: Effect.succeed(chromium.executablePath()),
    installed: Effect.succeedSome(chromium.executablePath()),
  } as never),
  Layer.mock(DesktopChannel.DesktopBrowserChannel)({
    available: false,
    attached: Stream.empty,
    detached: Stream.empty,
  }),
).pipe(
  Layer.provideMerge(
    ServerConfig.layerTest(process.cwd(), { prefix: "t3-browser-decision-eval-" }),
  ),
  Layer.provideMerge(
    Layer.mergeAll(NodeServices.layer, PlatformCrypto.layer, PreviewAgentActivity.layer),
  ),
);
const decisions = DecisionService.layer.pipe(
  Layer.provide(
    Layer.mergeAll(
      FetchHttpClient.layer,
      Layer.mock(ServerSecretStore.ServerSecretStore)({ get: () => Effect.succeedNone }),
      NodeServices.layer,
      PlatformCrypto.layer,
      ConfigProvider.layer(ConfigProvider.fromEnv()),
    ),
  ),
);
// Same loopback allow-list entry the installed server already carries for previews.
const runtime = ServerBrowser.layer.pipe(
  Layer.provideMerge(dependencies),
  Layer.provideMerge(
    ServerSettings.layerTest({ agentBrowserLoopbackAllow: ["localhost:3100-3199"] }),
  ),
  Layer.provideMerge(decisions),
);

const program = Effect.gen(function* () {
  yield* ServerBrowser.ServerBrowser;
  const broker = yield* Broker.PreviewAutomationBroker;
  const decisionService = yield* DecisionService.DecisionService;
  yield* Effect.yieldNow;
  const run = Effect.runPromiseWith(yield* Effect.context<never>());
  const client: DecisionClient = (input, options) =>
    run(decisionService.decide(input, options)) as never;

  const attemptDriver = async (
    scope: McpThreadInvocationScope,
    url: string,
  ): Promise<{ driver: BrowserDriver; close: () => Promise<void> }> => {
    const opened = await run(
      broker.invoke<PreviewAutomationStatus>({ scope, operation: "open", input: { url } }),
    );
    const tabId = PreviewTabId.make(opened.tabId!);
    const invoke = <A>(
      operation: Parameters<typeof broker.invoke>[0]["operation"],
      input: unknown = {},
    ) => run(broker.invoke<A>({ scope, tabId, operation, input }));
    return {
      driver: {
        observe: async () =>
          observationFromSnapshot(await invoke<PreviewAutomationSnapshot>("snapshot")),
        click: async (element) => void (await invoke("click", { locator: element.locator })),
        type: async (element, text) =>
          void (await invoke("type", { locator: element.locator, text, clear: true })),
        select: async (element, label) =>
          void (await invoke("select", { locator: element.locator, values: [label] })),
        scrollDown: async () => void (await invoke("scroll", { deltaY: 600 })),
        settle: () => new Promise((resolve) => setTimeout(resolve, 150)),
      },
      close: async () => {
        await run(broker.close({ scope, tabId }).pipe(Effect.ignore));
      },
    };
  };

  // DecisionService admits 60 calls a minute per environment; spacing calls stays inside that bound.
  let nextSlot = 0;
  const pace = async () => {
    const wait = Math.max(0, nextSlot - Date.now());
    nextSlot = Math.max(nextSlot, Date.now()) + 1100;
    if (wait > 0) await new Promise((resolve) => setTimeout(resolve, wait));
    return wait;
  };
  const attempts: unknown[] = [];
  const isolation: unknown[] = [];
  const queue = selected.flatMap((journey) =>
    Array.from({ length: Number(values.repeats) }, (_, repeat) =>
      engines.map((engine) => ({ journey, engine, repeat })),
    ).flat(),
  );
  const one = async ({
    journey,
    engine,
    repeat,
  }: {
    journey: JourneyDefinition;
    engine: "jev" | "luna";
    repeat: number;
  }) => {
    const fixture = await startFixture(journey);
    const scope = scopeFor(`${engine}-${journey.id}-${repeat}`);
    let driver: Awaited<ReturnType<typeof attemptDriver>> | undefined;
    try {
      driver = await attemptDriver(scope, `${fixture.origin}${journey.startPath}`);
      const cancelAfter = values["cancel-after-decisions"]
        ? Number(values["cancel-after-decisions"])
        : undefined;
      const controller = new AbortController();
      const inner = makeServiceEngine(engine, client);
      let decisions = 0;
      const engineUnderTest = {
        ...inner,
        decide: async (...args: Parameters<typeof inner.decide>) => {
          const result = await inner.decide(args[0], controller.signal);
          decisions += 1;
          if (cancelAfter !== undefined && decisions >= cancelAfter) controller.abort();
          return result;
        },
      };
      const attempt = await runDecisionJourney(engineUnderTest, driver.driver, journey, {
        maxSteps: Number(values["max-steps"]),
        maxStaleRetries: 2,
        beforeDecision: pace,
        signal: controller.signal,
      });
      const outcome = fixture.outcome();
      attempts.push({
        ...attempt,
        repeat,
        fixtureOutcome: outcome,
        grade: grade(attempt, journey, outcome),
      });
    } catch (cause) {
      // A browser that cannot open or a harness fault is a failed attempt, kept in the results.
      attempts.push({
        engine,
        requestedModel: engine === "jev" ? "jev-1.14.0" : "gpt-6-luna",
        resolvedModels: [],
        journey: journey.id,
        repeat,
        status: "error",
        stage: driver === undefined ? "browser-open" : "run",
        detail: cause instanceof Error ? `${cause.name}: ${cause.message}` : String(cause),
        steps: 0,
        staleRejections: 0,
        refusals: 0,
        timings: { totalMs: 0, modelMs: 0, observeMs: 0, freshnessMs: 0, actionMs: 0, pacingMs: 0 },
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          cachedInputTokens: 0,
          costUsd: 0,
          unreported: 0,
          requests: 0,
        },
        requestDigests: [],
        fixtureOutcome: fixture.outcome(),
        grade: { verifiedSuccess: false, falseCompletion: false, forbiddenEffect: false },
      });
    } finally {
      await driver?.close();
      const tabsLeft = await run(broker.list({ scope }))
        .then((tabs) => tabs.sessions.length)
        .catch(() => -1);
      isolation.push({ scope: scope.thread.threadId, tabsLeftAfterClose: tabsLeft });
      await fixture.close();
    }
  };
  const width = Number(values.concurrency);
  const pending = [...queue];
  yield* Effect.promise(() =>
    Promise.all(
      Array.from({ length: width }, async () => {
        for (let next = pending.shift(); next; next = pending.shift()) await one(next);
      }),
    ),
  );
  return { attempts, isolation };
});

const { attempts, isolation } = await Effect.runPromise(
  Effect.scoped(program.pipe(Effect.provide(runtime))),
);
const report = {
  generatedFor: "T3-348",
  sourceRevision: values.revision,
  fixtureVersion: FIXTURE_VERSION,
  sourceTreeDigest: sourceDigests().tree,
  sourceFileDigests: sourceDigests().perFile,
  ruleIdentity: BROWSER_RULE,
  journeys: selected.map((journey) => ({
    id: journey.id,
    category: journey.category,
    goal: journey.goal,
    expected: journey.expected,
  })),
  typingBoundary:
    "Typed values are fixed per journey and equal across arms; no model writes field text.",
  concurrency: Number(values.concurrency),
  cancelAfterDecisions: values["cancel-after-decisions"] ?? null,
  isolation,
  attempts,
};
NodeFS.writeFileSync(
  NodePath.join(values.out, "report.json"),
  `${JSON.stringify(report, null, 2)}\n`,
  { mode: 0o600 },
);
console.log(`Wrote ${attempts.length} attempts to ${values.out}`);
process.exit(0);
