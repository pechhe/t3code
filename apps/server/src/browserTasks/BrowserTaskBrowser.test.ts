// @effect-diagnostics nodeBuiltinImport:off - Real local HTTP fixtures and Chromium verify the lease and capture seams.
import * as NodeFS from "node:fs";
import * as NodeHttp from "node:http";
import type * as NodeNet from "node:net";

import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { expect, it } from "@effect/vitest";
import {
  type DecisionRequest,
  type DecisionResult,
  EnvironmentId,
  type PreviewAutomationSnapshot,
  type PreviewAutomationStatus,
  PreviewTabId,
  type PreviewTaskRequest,
  type PreviewTaskResult,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schedule from "effect/Schedule";
import * as Stream from "effect/Stream";
import { chromium } from "playwright-core";

import * as ServerConfig from "../config.ts";
import * as DecisionService from "../decisions/DecisionService.ts";
import * as ServerEnvironment from "../environment/ServerEnvironment.ts";
import type { McpThreadInvocationScope } from "../mcp/McpInvocationContext.ts";
import * as McpSessionRegistry from "../mcp/McpSessionRegistry.ts";
import * as Broker from "../mcp/PreviewAutomationBroker.ts";
import * as DesktopChannel from "../preview/DesktopBrowserChannel.ts";
import * as Manager from "../preview/Manager.ts";
import * as PreviewAgentActivity from "../preview/PreviewAgentActivity.ts";
import * as PreviewBrowser from "../preview/PreviewBrowser.ts";
import * as ServerBrowser from "../preview/ServerBrowser.ts";
import * as ServerSettings from "../serverSettings.ts";
import * as BrowserTaskService from "./BrowserTaskService.ts";
import { boundedBrowserScope } from "../mcp/ManagedBrowserAccess.ts";

const scope: McpThreadInvocationScope = {
  environmentId: EnvironmentId.make("browser-task"),
  requestNamespace: "browser-task",
  thread: {
    threadId: ThreadId.make("browser-task"),
    providerSessionId: "task-session",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["preview"]),
  issuedAt: 0,
  managedBrowser: true,
  managedProjectId: ProjectId.make("project-browser-task"),
  taskBrowser: { backend: "integrated" },
  browserBackends: { enabled: ["integrated"], default: "integrated" },
};

const answer = (choice: string): DecisionResult => ({
  engine: "jev",
  requestedModel: "jev-1.14.0",
  resolvedModel: "jev-1.14.0",
  adapterVersion: "test",
  rule: { id: "r", version: "1" },
  digest: "d",
  digestVersion: "sha256-canonical-json-v1",
  latencyMs: 1,
  usage: { inputTokens: 1, outputTokens: 1, cachedInputTokens: null, cacheWriteTokens: null },
  cost: { usd: 0.001, status: "estimated", pricingSource: "t", inputUsdPerMillion: 1 },
  answers: [
    {
      id: "next",
      status: "answered",
      type: "choice",
      choice,
      selectedChoiceProbability: 1,
      probabilities: { [choice]: 1 },
    },
  ],
});

const FORM = `<!doctype html><title>Form</title><main>
  <label>Email <input name="email"></label>
  <label>Plan <select name="plan"><option>Basic</option><option>Team</option></select></label>
  <label><input type="checkbox" name="terms"> Accept terms</label>
  <label>Password <input type="password" name="secret"></label>
  <button id="save" onclick="
    const xhr = new XMLHttpRequest(); xhr.open('POST', '/hold', false); xhr.send();
    document.querySelector('output').textContent = 'Saved ' + document.querySelector('[name=email]').value;
  ">Save</button>
  <button id="other" onclick="document.querySelector('output').textContent='Other clicked'">Other</button>
  <output></output>
</main>`;

const DOC = `<!doctype html><title>Doc</title><main>
  <div style="height:1500px">spacer</div>
  <h1 style="width:400px;height:60px;margin:0;background:rgb(200,0,0)">Report</h1>
  <h2 style="display:none">Hidden</h2>
  <h3>Twin</h3><h3>Twin</h3>
  <h4 style="width:300px;height:40px;margin:0">Covered</h4>
  <div style="position:relative;width:300px;height:40px;margin-top:-40px;background:white;z-index:2"></div>
</main>`;

/** The Save button stays in the accessibility tree while a plain overlay covers it. */
const OVERLAY = `<!doctype html><title>Overlay</title><main>
  <button onclick="document.querySelector('output').textContent='Saved'">Save</button>
  <output></output>
  <div id="cover" style="position:fixed;inset:0;background:rgba(0,0,0,.4);z-index:5">
    <button style="margin-top:300px" onclick="document.getElementById('cover').remove()">Dismiss</button>
  </div>
</main>`;

/** Its target arrives with the load event, which a slow image holds back for three seconds. */
const LATE = `<!doctype html><title>Late</title><main><img src="/slow.png" alt="">
  <script>addEventListener("load", () => {
    const go = document.createElement("button");
    go.textContent = "Go";
    go.onclick = () => { document.title = "Gone"; };
    document.querySelector("main").append(go);
  });</script>
</main>`;

const request = (
  change: Partial<PreviewTaskRequest> & Pick<PreviewTaskRequest, "requestId" | "tabId">,
): PreviewTaskRequest => ({
  engine: "jev",
  goal: "Do the job",
  checks: [{ id: "any", kind: "url", includes: "/" }],
  ...change,
});

const dependencies = Layer.mergeAll(
  Broker.layer.pipe(Layer.provideMerge(Manager.layer)),
  Layer.succeed(ServerEnvironment.ServerEnvironment, {
    getEnvironmentId: Effect.succeed(scope.environmentId),
    getDescriptor: Effect.die("unused"),
  }),
  Layer.succeed(PreviewBrowser.PreviewBrowser, {
    executable: Effect.succeed(chromium.executablePath()),
    installed: Effect.succeedSome(chromium.executablePath()),
  }),
  Layer.mock(DesktopChannel.DesktopBrowserChannel)({
    available: false,
    isShown: () => false,
    attached: Stream.empty,
    detached: Stream.empty,
  }),
).pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "t3-browser-task-" })),
  Layer.provideMerge(Layer.mergeAll(NodeServices.layer, NodeCrypto.layer)),
);

const withFixture = <A, E, R>(
  run: (fixture: {
    readonly origin: string;
    readonly holds: () => number;
    readonly holding: Deferred.Deferred<void>;
    readonly releaseHold: () => void;
    readonly script: Array<string>;
    readonly decisions: Array<DecisionRequest>;
  }) => Effect.Effect<A, E, R>,
) =>
  Effect.gen(function* () {
    let holds = 0;
    const holding = yield* Deferred.make<void>();
    const held: Array<NodeHttp.ServerResponse> = [];
    let holdNext = true;
    const server = NodeHttp.createServer((incoming, response) => {
      if (incoming.url === "/hold") {
        holds += 1;
        Deferred.doneUnsafe(holding, Effect.void);
        if (holdNext) held.push(response);
        else response.end("ok");
        return;
      }
      if (incoming.url === "/slow.png") {
        // @effect-diagnostics-next-line globalTimers:off -- Node's HTTP server holds the response, outside any Effect.
        setTimeout(() => response.end(), 3_000);
        return;
      }
      response.setHeader("Content-Type", "text/html");
      response.end(
        incoming.url === "/overlay"
          ? OVERLAY
          : incoming.url === "/late"
            ? LATE
            : incoming.url === "/doc"
              ? DOC
              : incoming.url === "/long"
                ? `<!doctype html><title>Long</title><main>${Array.from(
                    { length: 900 },
                    (_, index) => `<p><a href="#row-${index}">Row number ${index}</a></p>`,
                  ).join(
                    "",
                  )}<button onclick="document.title='Reached'">Last control</button></main>`
                : FORM,
      );
    });
    yield* Effect.promise(
      () => new Promise<void>((resolve) => void server.listen(0, "127.0.0.1", () => resolve())),
    );
    yield* Effect.addFinalizer(() =>
      Effect.promise(
        () =>
          new Promise<void>((resolve) => {
            server.closeAllConnections();
            server.close(() => resolve());
          }),
      ),
    );
    const port = (server.address() as NodeNet.AddressInfo).port;
    const script: string[] = [];
    const decisions: DecisionRequest[] = [];
    const runtime = BrowserTaskService.layer.pipe(
      Layer.provideMerge(ServerBrowser.layer),
      Layer.provideMerge(dependencies),
      Layer.provideMerge(
        ServerSettings.layerTest({ agentBrowserLoopbackAllow: [`127.0.0.1:${port}`] }),
      ),
      Layer.provideMerge(
        Layer.mock(DecisionService.DecisionService)({
          decide: (input) =>
            Effect.sync(() => {
              decisions.push(input as DecisionRequest);
              return answer(script.shift() ?? "BLOCKED");
            }),
        }),
      ),
      Layer.provideMerge(
        Layer.mock(McpSessionRegistry.McpSessionRegistry)({
          credentialState: () => Effect.succeed("live" as const),
        }),
      ),
    );
    return yield* run({
      origin: `http://127.0.0.1:${port}`,
      holds: () => holds,
      holding,
      releaseHold: () => {
        holdNext = false;
        for (const response of held.splice(0)) response.end("ok");
      },
      script,
      decisions,
    }).pipe(Effect.provide(runtime));
  }).pipe(
    Effect.scoped,
    Effect.provide(
      Layer.mergeAll(NodeServices.layer, NodeCrypto.layer, PreviewAgentActivity.layer),
    ),
  );

/** Quiescence has no event of its own: a repeated request is how a caller reads it. */
const settledContinuation = (
  tasks: BrowserTaskService.BrowserTaskService["Service"],
  task: PreviewTaskRequest,
  state: PreviewTaskResult["continuation"]["state"],
) =>
  tasks.run({ scope, request: task, authorize: Effect.void }).pipe(
    Effect.repeat({
      // oxlint-disable-next-line t3code/no-real-time-wait-in-tests -- real Chromium's quiescence has no event.
      schedule: Schedule.spaced("50 millis"),
      until: (result) => result.continuation.state === state,
    }),
    Effect.timeout("10 seconds"),
  );

const openTab = (url: string) =>
  Effect.gen(function* () {
    yield* ServerBrowser.ServerBrowser;
    const broker = yield* Broker.PreviewAutomationBroker;
    yield* Effect.yieldNow;
    const opened = yield* broker.invoke<PreviewAutomationStatus>({
      scope,
      operation: "open",
      input: { url },
    });
    return { broker, tabId: PreviewTabId.make(opened.tabId!) };
  });

it.live(
  "excludes every other browser call from a submission whose ack is withheld, then requires inspection",
  () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        const { broker, tabId } = yield* openTab(`${fixture.origin}/form`);
        const tasks = yield* BrowserTaskService.BrowserTaskService;
        const before = yield* broker.invoke<PreviewAutomationSnapshot>({
          scope,
          tabId,
          operation: "snapshot",
          input: {},
        });
        const emailRef = before.interactiveElements.find(
          (entry) => entry.name === "Email",
        )!.selector;
        fixture.script.push("save");
        const task = request({
          requestId: "withheld",
          tabId,
          goal: "Save the form",
          bindings: [
            {
              id: "email",
              control: "text",
              target: { role: "textbox", name: "Email" },
              text: "a@b.c",
            },
          ],
          submit: { id: "save", target: { role: "button", name: "Save" } },
          checks: [{ id: "saved", kind: "text", includes: "Saved a@b.c", expect: "present" }],
        });
        const running = yield* tasks
          .run({ scope, request: task, authorize: Effect.void })
          .pipe(Effect.forkChild);
        yield* Deferred.await(fixture.holding);

        // A mutation, a ref-regenerating snapshot and another session's observer all stop here.
        const refused = "bounded browser task holds this tab";
        const snapshotError: { readonly message: string } = yield* broker
          .invoke<object>({
            scope,
            tabId,
            operation: "snapshot",
            input: {},
            updateCurrentTab: false,
          })
          .pipe(Effect.flip);
        expect(snapshotError.message).toContain(refused);
        const clickError: { readonly message: string } = yield* broker
          .invoke<object>({
            scope,
            tabId,
            operation: "click",
            input: { locator: emailRef },
            updateCurrentTab: false,
          })
          .pipe(Effect.flip);
        expect(clickError.message).toContain(refused);
        const { managedBrowser: _managed, ...ordinary } = scope;
        const observer = {
          ...ordinary,
          thread: { ...scope.thread, providerSessionId: "observer" },
        };
        const observerError: { readonly message: string } = yield* broker
          .invoke<object>({
            scope: observer,
            tabId,
            operation: "snapshot",
            input: {},
            updateCurrentTab: false,
          })
          .pipe(Effect.flip);
        expect(observerError.message).toContain(refused);

        // Passive metadata stays available while the page's main thread is held.
        const passive = yield* broker.invoke<PreviewAutomationStatus>({
          scope,
          tabId,
          operation: "status",
          input: {},
          updateCurrentTab: false,
        });
        expect(passive.tabId).toBe(tabId);

        const duplicate = yield* tasks.run({ scope, request: task, authorize: Effect.void });
        expect(duplicate.replayed).toBe(true);
        expect(duplicate.status).toBe("running");
        expect(duplicate.actions.map((action) => [action.id, action.state])).toEqual([
          ["email", "completed"],
          ["save", "dispatched"],
        ]);

        const cancelled = yield* tasks.cancel({ scope, requestId: "withheld" });
        expect(cancelled.status).toBe("cancelled");
        expect(cancelled.actions.at(-1)).toMatchObject({ id: "save", state: "uncertain" });
        expect(cancelled.continuation.state).toBe("leased");
        yield* Fiber.join(running);

        // Still leased until the in-flight click has quiesced, whatever the caller was told.
        const stillLeased: { readonly message: string } = yield* broker
          .invoke<object>({
            scope,
            tabId,
            operation: "snapshot",
            input: {},
            updateCurrentTab: false,
          })
          .pipe(Effect.flip);
        expect(stillLeased.message).toContain(refused);

        fixture.releaseHold();
        yield* settledContinuation(tasks, task, "inspect-first");

        const inspectFirst: { readonly message: string } = yield* broker
          .invoke<object>({
            scope,
            tabId,
            operation: "click",
            input: { locator: emailRef },
            updateCurrentTab: false,
          })
          .pipe(Effect.flip);
        expect(inspectFirst.message).toContain(
          "Take a snapshot (preview_snapshot or t3_browser_snapshot)",
        );
        const status = yield* broker.invoke<PreviewAutomationStatus>({
          scope,
          tabId,
          operation: "status",
          input: {},
          updateCurrentTab: false,
        });
        expect(status.tabId).toBe(tabId);

        const inspection = yield* broker.invoke<PreviewAutomationSnapshot>({
          scope,
          tabId,
          operation: "snapshot",
          input: {},
        });
        expect(inspection.visibleText).toContain("Saved a@b.c");
        const other = inspection.interactiveElements.find((entry) => entry.name === "Other")!;
        yield* broker.invoke({
          scope,
          tabId,
          operation: "click",
          input: { locator: other.selector },
        });
        expect(fixture.holds()).toBe(1);
        expect(fixture.decisions).toHaveLength(1);
      }),
    ),
);

it.live("resolves a target beyond the size a worker's own snapshot shows", () =>
  withFixture((fixture) =>
    Effect.gen(function* () {
      const { broker, tabId } = yield* openTab(`${fixture.origin}/long`);
      const tasks = yield* BrowserTaskService.BrowserTaskService;
      const page = yield* broker.invoke<PreviewAutomationSnapshot>({
        scope,
        tabId,
        operation: "snapshot",
        input: {},
      });
      expect(page.accessibilityTree).not.toContain("Last control");
      fixture.script.push("last");
      const result = yield* tasks.run({
        scope,
        authorize: Effect.void,
        request: request({
          requestId: "long",
          tabId,
          actions: [{ id: "last", target: { role: "button", name: "Last control" } }],
          checks: [
            {
              id: "reached",
              kind: "target",
              target: { role: "button", name: "Row 1" },
              expect: "absent",
            },
            { id: "text", kind: "text", includes: "Row number 899", expect: "present" },
          ],
        }),
      });
      expect(result.status).toBe("passed");
      expect(result.evidence.truncated).toBe(false);
    }),
  ),
);

it.live("refuses a tab that no longer exists, with no decision and guidance on what to do", () =>
  withFixture((fixture) =>
    Effect.gen(function* () {
      yield* openTab(`${fixture.origin}/form`);
      const tasks = yield* BrowserTaskService.BrowserTaskService;
      const refused = yield* tasks
        .run({
          scope,
          request: request({
            requestId: "after-restart",
            tabId: PreviewTabId.make("tab_1_00000000-0000-4000-8000-000000000000"),
            checks: [{ id: "saved", kind: "text", includes: "Saved", expect: "present" }],
          }),
          authorize: Effect.void,
        })
        .pipe(Effect.flip);
      expect(refused.code).toBe("capability_denied");
      expect(refused.message).toContain("under a new requestId");
      expect(fixture.decisions).toHaveLength(0);
    }),
  ),
);

it.live("closing the tab interrupts a stuck task and leaves no way to continue", () =>
  withFixture((fixture) =>
    Effect.gen(function* () {
      const { broker, tabId } = yield* openTab(`${fixture.origin}/form`);
      const tasks = yield* BrowserTaskService.BrowserTaskService;
      fixture.script.push("save");
      const task = request({
        requestId: "stuck",
        tabId,
        submit: { id: "save", target: { role: "button", name: "Save" } },
        checks: [{ id: "saved", kind: "text", includes: "Saved", expect: "present" }],
      });
      const running = yield* tasks
        .run({ scope, request: task, authorize: Effect.void })
        .pipe(Effect.forkChild);
      yield* Deferred.await(fixture.holding);
      yield* broker.close({ scope, tabId });
      const finished = yield* Fiber.join(running);
      expect(finished.status).toBe("blocked");
      expect(finished.actions.at(-1)).toMatchObject({ id: "save", state: "uncertain" });
      yield* settledContinuation(tasks, task, "unavailable");
      expect(fixture.holds()).toBe(1);
      fixture.releaseHold();
    }),
  ),
);

it.live("fills a real form with supplied values, submits once and verifies the page", () =>
  withFixture((fixture) =>
    Effect.gen(function* () {
      const { tabId } = yield* openTab(`${fixture.origin}/form`);
      const tasks = yield* BrowserTaskService.BrowserTaskService;
      fixture.script.push("save");
      fixture.releaseHold();
      const result = yield* tasks.run({
        scope,
        authorize: Effect.void,
        request: request({
          requestId: "form",
          tabId,
          bindings: [
            {
              id: "email",
              control: "text",
              target: { role: "textbox", name: "Email" },
              text: "a@b.c",
            },
            {
              id: "plan",
              control: "select",
              target: { role: "combobox", name: "Plan" },
              option: "Team",
            },
            {
              id: "terms",
              control: "checkbox",
              target: { role: "checkbox", name: "Accept terms" },
              checked: true,
            },
          ],
          submit: { id: "save", target: { role: "button", name: "Save" } },
          checks: [
            { id: "saved", kind: "text", includes: "Saved a@b.c", expect: "present" },
            {
              id: "email-value",
              kind: "target",
              target: { role: "textbox", name: "Email" },
              expect: "present",
              value: "a@b.c",
            },
            {
              id: "plan-value",
              kind: "target",
              target: { role: "combobox", name: "Plan" },
              expect: "present",
              value: "Team",
            },
            {
              id: "terms-checked",
              kind: "target",
              target: { role: "checkbox", name: "Accept terms" },
              expect: "present",
              checked: true,
            },
          ],
        }),
      });
      expect(result).toMatchObject({ status: "passed", checksFinal: true });
      expect(result.checks.map((check) => check.status)).toEqual([
        "passed",
        "passed",
        "passed",
        "passed",
      ]);
      expect(result.continuation.state).toBe("ready");
      expect(fixture.holds()).toBe(1);
      expect(JSON.stringify(fixture.decisions)).not.toContain("a@b.c");
    }),
  ),
);

it.live("refuses a password field and leaves a blocked form for the same worker to finish", () =>
  withFixture((fixture) =>
    Effect.gen(function* () {
      const { broker, tabId } = yield* openTab(`${fixture.origin}/form`);
      const tasks = yield* BrowserTaskService.BrowserTaskService;
      fixture.releaseHold();
      const secret = yield* tasks.run({
        scope,
        authorize: Effect.void,
        request: request({
          requestId: "secret",
          tabId,
          bindings: [
            {
              id: "secret",
              control: "text",
              target: { role: "textbox", name: "Password" },
              text: "hunter2",
            },
          ],
          checks: [{ id: "never", kind: "text", includes: "Never", expect: "present" }],
        }),
      });
      expect(secret.reason).toBe("target-refused");
      expect(secret.actions[0]).toMatchObject({ id: "secret", state: "planned" });

      fixture.script.push("BLOCKED");
      const partial = yield* tasks.run({
        scope,
        authorize: Effect.void,
        request: request({
          requestId: "partial",
          tabId,
          goal: "Save the form; the plan value is not known",
          bindings: [
            {
              id: "email",
              control: "text",
              target: { role: "textbox", name: "Email" },
              text: "a@b.c",
            },
          ],
          submit: { id: "save", target: { role: "button", name: "Save" } },
          checks: [{ id: "saved", kind: "text", includes: "Saved a@b.c", expect: "present" }],
        }),
      });
      expect(partial).toMatchObject({ status: "blocked", reason: "model-blocked" });
      expect(partial.actions).toEqual([{ id: "email", kind: "binding", state: "completed" }]);
      expect(partial.continuation.state).toBe("ready");
      expect(fixture.holds()).toBe(0);

      const page = yield* broker.invoke<PreviewAutomationSnapshot>({
        scope,
        tabId,
        operation: "snapshot",
        input: {},
      });
      const save = page.interactiveElements.find((entry) => entry.name === "Save")!;
      yield* broker.invoke({ scope, tabId, operation: "click", input: { locator: save.selector } });
      yield* broker.invoke({ scope, tabId, operation: "waitFor", input: { text: "Saved a@b.c" } });
      expect(fixture.holds()).toBe(1);
    }),
  ),
);

it.live(
  "captures a real crop of a noninteractive target below the fold, and refuses bad targets",
  () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        const { tabId } = yield* openTab(`${fixture.origin}/doc`);
        const tasks = yield* BrowserTaskService.BrowserTaskService;
        const capture = (requestId: string, name: string, role = "heading") =>
          tasks.run({
            scope,
            authorize: Effect.void,
            request: request({
              requestId,
              tabId,
              capture: { target: { role, name } },
              checks: [{ id: "image", kind: "artifact" }],
            }),
          });
        const captured = yield* capture("report", "Report");
        expect(captured.status).toBe("passed");
        expect(captured.decisions).toBe(0);
        const artifact = captured.artifact!;
        expect(artifact.framing.kind).toBe("element-crop");
        expect(artifact.framing.targetBox).toMatchObject({ width: 400, height: 60 });
        expect(artifact.framing.targetBox.y).toBeGreaterThanOrEqual(0);
        expect(artifact.framing.targetBox.y + 60).toBeLessThanOrEqual(
          artifact.framing.viewport.height,
        );
        expect(artifact.framing.centreVisible).toBe(true);
        expect(artifact.width / artifact.height).toBeCloseTo(400 / 60, 1);
        const bytes = NodeFS.readFileSync(artifact.path);
        expect(bytes.subarray(1, 4).toString()).toBe("PNG");
        expect(bytes.readUInt32BE(16)).toBe(artifact.width);
        expect(bytes.readUInt32BE(20)).toBe(artifact.height);

        fixture.script.push("DONE");
        const hidden = yield* capture("hidden", "Hidden");
        expect(hidden.status).toBe("failed");
        expect(hidden.artifact).toBeUndefined();
        expect(hidden.checks[0]?.status).toBe("failed");

        fixture.script.push("DONE");
        const twin = yield* capture("twin", "Twin");
        expect(twin).toMatchObject({ status: "blocked", reason: "ambiguous-target" });
        expect(twin.artifact).toBeUndefined();

        const covered = yield* capture("covered", "Covered");
        expect(covered).toMatchObject({ status: "failed", reason: "capture-failed" });
        expect(covered.detail).toContain("covers the capture target");
        expect(covered.artifact).toBeUndefined();
      }),
    ),
);

it.live(
  "gives a bounded caller its own fresh tab that its session's other tools and sessions cannot use",
  () =>
    withFixture((fixture) =>
      Effect.gen(function* () {
        yield* ServerBrowser.ServerBrowser;
        const broker = yield* Broker.PreviewAutomationBroker;
        const tasks = yield* BrowserTaskService.BrowserTaskService;
        yield* Effect.yieldNow;
        // An ordinary thread whose own browser default is Phi still gets an integrated tab.
        const { managedBrowser: _managed, taskBrowser: _task, ...unmanaged } = scope;
        const ordinary: McpThreadInvocationScope = {
          ...unmanaged,
          browserBackends: { enabled: ["phi", "integrated"], default: "phi" },
          boundedBrowser: true,
        };
        const bounded = boundedBrowserScope(ordinary, ProjectId.make("project-browser-task"));
        const opened = yield* broker.invoke<PreviewAutomationStatus>({
          scope: bounded,
          operation: "open",
          input: { url: `${fixture.origin}/doc`, reuseExistingTab: false, open: false },
        });
        const tabId = PreviewTabId.make(opened.tabId!);
        expect(opened.profiles).toBeUndefined();

        // The same session's preview lane, and a sibling provider session's bounded lane, cannot act.
        const { browserLane: _lane, ...previewLane } = bounded;
        const sibling: McpThreadInvocationScope = {
          ...bounded,
          thread: { ...bounded.thread, providerSessionId: "sibling-session" },
        };
        for (const other of [previewLane, sibling] as const) {
          const refused = yield* broker
            .invoke<object>({
              scope: other,
              tabId,
              operation: "scroll",
              input: { direction: "down" },
            })
            .pipe(Effect.flip);
          expect(refused.message).toMatch(/another|belongs|conflict|keeps its/i);
          const misuse = yield* tasks
            .run({
              scope: other,
              authorize: Effect.void,
              request: request({ requestId: "other", tabId }),
            })
            .pipe(Effect.flip);
          expect(misuse.message).toMatch(/own|another|belongs|conflict|keeps its/i);
        }
        // Raw page execution stays refused on the bounded lane.
        const evaluated = yield* broker
          .invoke<object>({
            scope: bounded,
            tabId,
            operation: "evaluate",
            input: { expression: "1" },
          })
          .pipe(Effect.flip);
        expect(evaluated.message).toMatch(/not available|unsupported|control changed/i);

        // The seeded defect, a red heading, is captured as a readable crop on the bounded lane.
        const captured = yield* tasks.run({
          scope: bounded,
          authorize: Effect.void,
          request: request({
            requestId: "seeded",
            tabId,
            capture: { target: { role: "heading", name: "Report" } },
            checks: [{ id: "image", kind: "artifact" }],
          }),
        });
        expect(captured.status).toBe("passed");
        expect(captured.continuation.guidance).toContain("t3_browser_");
        const bytes = NodeFS.readFileSync(captured.artifact!.path);
        expect(bytes.subarray(1, 4).toString()).toBe("PNG");
        expect(fixture.decisions).toHaveLength(0);
      }),
    ),
);

const PNG_SIGNATURE = [0x89, 0x50, 0x4e, 0x47];

it.live("runs ordered steps with no decision and saves a real screenshot for each", () =>
  withFixture((fixture) =>
    Effect.gen(function* () {
      const { tabId } = yield* openTab(`${fixture.origin}/form`);
      const tasks = yield* BrowserTaskService.BrowserTaskService;
      fixture.releaseHold();
      const email = { role: "textbox", name: "Email" };
      const result = yield* tasks.run({
        scope,
        authorize: Effect.void,
        request: request({
          requestId: "ordered",
          tabId,
          bindings: [{ id: "email", control: "text", target: email, text: "a@b.c" }],
          submit: { id: "save", target: { role: "button", name: "Save" } },
          steps: [
            { kind: "screenshot", id: "before", framing: "viewport" },
            { kind: "run", id: "email" },
            { kind: "screenshot", id: "filled", framing: "target", target: email },
            { kind: "run", id: "save" },
            { kind: "screenshot", id: "after", framing: "full-page" },
          ],
          checks: [{ id: "saved", kind: "text", includes: "Saved a@b.c", expect: "present" }],
        }),
      });
      expect(result).toMatchObject({ status: "passed", decisions: 0 });
      expect(
        result.screenshots?.map(({ id, afterStep, framing, url }) => [
          id,
          afterStep,
          framing,
          url.endsWith("/form"),
        ]),
      ).toEqual([
        ["before", null, "viewport", true],
        ["filled", "email", "target", true],
        ["after", "save", "full-page", true],
      ]);
      for (const shot of result.screenshots ?? []) {
        const bytes = NodeFS.readFileSync(shot.path);
        expect([...bytes.subarray(0, 4)]).toEqual(PNG_SIGNATURE);
        expect(bytes.length).toBe(shot.bytes);
        expect(shot.bytes).toBeLessThanOrEqual(1_000_000);
      }
      expect(fixture.decisions).toEqual([]);
    }),
  ),
);

it.live("never clicks a covered button: Jev dismisses the overlay and the step runs once", () =>
  withFixture((fixture) =>
    Effect.gen(function* () {
      const { tabId } = yield* openTab(`${fixture.origin}/overlay`);
      const tasks = yield* BrowserTaskService.BrowserTaskService;
      fixture.script.push("dismiss");
      const result = yield* tasks.run({
        scope,
        authorize: Effect.void,
        request: request({
          requestId: "overlay",
          tabId,
          actions: [{ id: "dismiss", target: { role: "button", name: "Dismiss" } }],
          submit: { id: "save", target: { role: "button", name: "Save" } },
          steps: [{ kind: "run", id: "save" }],
          checks: [{ id: "saved", kind: "text", includes: "Saved", expect: "present" }],
        }),
      });
      expect(result).toMatchObject({
        status: "passed",
        decisions: 1,
        recoveries: [{ step: "save", decisions: 1 }],
      });
      expect(result.actions.map(({ id, state }) => `${id}:${state}`)).toEqual([
        "dismiss:completed",
        "save:completed",
      ]);
      expect(fixture.decisions[0]?.rule.id).toBe("bounded-browser-task-recover-step");
    }),
  ),
);

it.live("waits for a target that arrives after three seconds of loading", () =>
  withFixture((fixture) =>
    Effect.gen(function* () {
      const { broker, tabId } = yield* openTab(`${fixture.origin}/form`);
      yield* broker.invoke({
        scope,
        tabId,
        operation: "navigate",
        input: { url: `${fixture.origin}/late`, readiness: "commit" },
      });
      const tasks = yield* BrowserTaskService.BrowserTaskService;
      const result = yield* tasks.run({
        scope,
        authorize: Effect.void,
        request: request({
          requestId: "late",
          tabId,
          actions: [{ id: "go", target: { role: "button", name: "Go" } }],
          steps: [{ kind: "run", id: "go" }],
          checks: [{ id: "gone", kind: "url", includes: "/late" }],
        }),
      });
      expect(result.reason).not.toBe("target-not-found");
      expect(result).toMatchObject({ status: "passed", decisions: 0 });
    }),
  ),
);

it.live("stops at once on a landmark the page lacks", () =>
  withFixture((fixture) =>
    Effect.gen(function* () {
      const { tabId } = yield* openTab(`${fixture.origin}/form`);
      const tasks = yield* BrowserTaskService.BrowserTaskService;
      const result = yield* tasks.run({
        scope,
        authorize: Effect.void,
        request: request({
          requestId: "landmark",
          tabId,
          actions: [
            {
              id: "save",
              target: { role: "button", name: "Save", scope: { role: "navigation", name: "" } },
            },
          ],
          steps: [
            { kind: "run", id: "save" },
            { kind: "screenshot", id: "done", framing: "viewport" },
          ],
        }),
      });
      expect(result).toMatchObject({ status: "blocked", reason: "target-not-found", decisions: 0 });
      expect(result.missingTarget?.nearest).toEqual(['button "Save"']);
      // No wait or decision preceded the stop, so it is well within the 5 s the Spec allows.
      expect(result.timings.waitMs).toBe(0);
      // A run that blocks after screenshots were asked for shows where it stopped.
      expect(result.screenshots?.map((shot) => shot.id)).toEqual(["stopped"]);
    }),
  ),
);
