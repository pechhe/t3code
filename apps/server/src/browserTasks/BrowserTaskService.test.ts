import * as NodeCrypto from "@effect/platform-node/NodeCrypto";
import { assert, describe, it } from "@effect/vitest";
import {
  type DecisionRequest,
  type DecisionResult,
  DecisionError,
  EnvironmentId,
  OrchestratorMcpFailure,
  type PreviewAutomationSnapshot,
  PreviewTabId,
  type PreviewTaskRequest,
  type PreviewTaskResult,
  ProjectId,
  ProviderInstanceId,
  ThreadId,
} from "@t3tools/contracts";
import * as Deferred from "effect/Deferred";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as TestClock from "effect/testing/TestClock";

import type { McpThreadInvocationScope } from "../mcp/McpInvocationContext.ts";
import { TASK_SNAPSHOT_TEXT_LENGTH } from "../preview/ServerBrowserPage.ts";
import type { BrowserTaskPort } from "./BrowserTaskRunner.ts";
import { makeService, requestProblem, type TaskBackend } from "./BrowserTaskService.ts";

const tabId = PreviewTabId.make("tab-1");
const scope: McpThreadInvocationScope = {
  environmentId: EnvironmentId.make("env"),
  requestNamespace: "thread:task",
  thread: {
    threadId: ThreadId.make("task"),
    providerSessionId: "session-1",
    providerInstanceId: ProviderInstanceId.make("codex"),
  },
  client: undefined,
  capabilities: new Set(["preview"]),
  issuedAt: 0,
  managedBrowser: true,
  managedProjectId: ProjectId.make("project"),
  taskBrowser: { backend: "integrated" },
  browserBackends: { enabled: ["integrated"], default: "integrated" },
};

const answered = (choice: string, cost: number | null = 0.001): DecisionResult => ({
  engine: "jev",
  requestedModel: "jev-1.14.0",
  resolvedModel: "jev-1.14.0",
  adapterVersion: "test",
  rule: { id: "r", version: "1" },
  digest: "d",
  digestVersion: "sha256-canonical-json-v1",
  latencyMs: 1,
  usage: { inputTokens: 10, outputTokens: 1, cachedInputTokens: null, cacheWriteTokens: null },
  cost: {
    usd: cost,
    status: cost === null ? "unknown" : "estimated",
    pricingSource: "t",
    inputUsdPerMillion: 1,
  },
  answers: [
    {
      id: "next",
      status: "answered",
      type: "choice",
      choice,
      selectedChoiceProbability: 0.9,
      probabilities: { [choice]: 0.9 },
    },
  ],
});

/** A little form page: fields, a submit button, and a result that appears once submitted. */
interface FakePage {
  url: string;
  email: string;
  submits: number;
  /** Models a submission that navigates to a page without the form. */
  leavesFormOnSubmit?: boolean;
  tree?: string;
  text?: string;
}

const pageSnapshot = (page: FakePage, generation: number): PreviewAutomationSnapshot => {
  const ref = (name: string) => `[ref=t3-${generation}-${name}]`;
  const tree =
    page.tree ??
    (page.leavesFormOnSubmit === true && page.submits > 0
      ? `- heading "Saved" ${ref("saved")}`
      : undefined) ??
    [
      `- main ${ref("main")}:`,
      `  - textbox "Email" ${ref("email")}${page.email ? `: ${page.email}` : ""}`,
      `  - button "Save" ${ref("save")}`,
      ...(page.submits > 0 ? [`  - heading "Saved" ${ref("saved")}`] : []),
    ].join("\n");
  return {
    url: page.url,
    title: "Form",
    loading: false,
    visibleText: page.text ?? (page.submits > 0 ? "Saved" : "Fill the form"),
    interactiveElements: [],
    accessibilityTree: tree,
    consoleEntries: [],
    networkEntries: [],
    actionTimeline: [],
    screenshot: { mimeType: "image/png", data: "", width: 1, height: 1 },
  };
};

const FORM_REQUEST: PreviewTaskRequest = {
  requestId: "form-1",
  tabId,
  engine: "jev",
  goal: "Save the email",
  bindings: [
    { id: "email", control: "text", target: { role: "textbox", name: "Email" }, text: "a@b.c" },
  ],
  submit: { id: "save", target: { role: "button", name: "Save" } },
  checks: [{ id: "saved", kind: "text", includes: "Saved", expect: "present" }],
};

const harness = Effect.fn("harness")(function* (options: {
  readonly choices?: ReadonlyArray<string | DecisionError>;
  readonly page?: Partial<FakePage>;
  /** Blocks the act matching this until `ack` is completed; never answered otherwise. */
  readonly withhold?: (operation: string, input: Record<string, unknown>) => boolean;
  readonly refuse?: { readonly operation: string; readonly tag: string };
  readonly credential?: () => "live" | "expired" | "revoked";
  readonly unreadable?: () => boolean;
  readonly readHangs?: boolean;
  /** Whether the element behind a locator is painted over. */
  readonly covered?: (locator: string) => boolean;
  /** Replaces the default effects of an act on the fake page. */
  readonly onAct?: (operation: string, input: Record<string, unknown>, page: FakePage) => void;
  readonly loading?: () => boolean;
  readonly onSettle?: (page: FakePage) => void;
}) {
  const page: FakePage = { url: "http://site.test/form", email: "", submits: 0, ...options.page };
  const acts: Array<{ operation: string; input: Record<string, unknown> }> = [];
  const decisions: DecisionRequest[] = [];
  const queue = [...(options.choices ?? [])];
  const inFlight = yield* Deferred.make<void>();
  const ack = yield* Deferred.make<void>();
  const quiesced = yield* Deferred.make<void>();
  const stopped = yield* Deferred.make<void>();
  const released: Array<{ leased: boolean; inspectFirst: boolean }> = [];
  const shots: Array<{ framing: string; locator?: string; maxBytes: number }> = [];
  const coverChecks: string[] = [];
  let settles = 0;
  let generation = 0;

  const backend: TaskBackend = {
    credentialState: () => Effect.sync(() => options.credential?.() ?? "live"),
    assertOwnedTab: (_scope, id) =>
      id === tabId
        ? Effect.void
        : Effect.fail(
            new OrchestratorMcpFailure({ code: "capability_denied", message: "not yours" }),
          ),
    port: () => ({
      acquire: () => Effect.void,
      snapshot: () =>
        options.readHangs === true
          ? Effect.never
          : options.unreadable?.() === true
            ? Effect.fail({ message: "The page changed while capturing its snapshot." })
            : Effect.sync(() => {
                generation += 1;
                return {
                  ...pageSnapshot(page, generation),
                  loading: options.loading?.() ?? false,
                };
              }),
      act: (operation, input) =>
        Effect.gen(function* () {
          acts.push({ operation, input });
          if (options.refuse?.operation === operation)
            return yield* Effect.fail({ _tag: options.refuse.tag, message: "refused" });
          if (options.withhold?.(operation, input) === true) {
            yield* Deferred.succeed(inFlight, undefined);
            yield* Deferred.await(ack);
          }
          if (options.onAct !== undefined) options.onAct(operation, input, page);
          else {
            if (operation === "type") page.email = String(input.text);
            if (operation === "click") page.submits += 1;
          }
          return {};
        }),
      capture: () => Effect.fail({ message: "unused" }),
      settle: () =>
        Effect.sync(() => {
          settles += 1;
          options.onSettle?.(page);
        }),
      covered: (locator) =>
        Effect.sync(() => {
          coverChecks.push(locator);
          return options.covered?.(locator) ?? false;
        }),
      screenshot: (input) =>
        Effect.sync(() => {
          shots.push(input);
          return {
            path: `/artifacts/shot-${shots.length}.png`,
            mimeType: "image/png" as const,
            width: 1280,
            height: 720,
            bytes: 120_000,
            cut: false,
            url: page.url,
            title: "Form",
            capturedAt: "2026-11-06T12:00:00.000Z",
          };
        }),
      decide: (request) =>
        Effect.suspend(() => {
          decisions.push(request);
          const next = queue.shift();
          if (next === undefined) return Effect.fail(new DecisionError({ code: "unavailable" }));
          return typeof next === "string" ? Effect.succeed(answered(next)) : Effect.fail(next);
        }),
    }),
    release: (_scope, _tab, _lease, options) =>
      Effect.gen(function* () {
        released.push(options);
        yield* Deferred.succeed(stopped, undefined);
        yield* Deferred.await(quiesced);
        return "released" as const;
      }),
  };
  const service = yield* makeService(backend);
  return {
    service,
    page,
    acts,
    decisions,
    inFlight,
    ack,
    quiesced,
    stopped,
    released,
    shots,
    coverChecks,
    settles: () => settles,
  };
});

const allow: BrowserTaskPort["authorize"] = Effect.void;

const passGrace = TestClock.adjust(Duration.seconds(1));

/** Runs to the report, letting the quiescence grace elapse without the lease being released. */
const report = (effect: Effect.Effect<PreviewTaskResult, OrchestratorMcpFailure>) =>
  Effect.gen(function* () {
    const fiber = yield* effect.pipe(Effect.forkChild);
    yield* Effect.yieldNow;
    yield* passGrace;
    return yield* Fiber.join(fiber);
  });

const statesOf = (result: PreviewTaskResult) =>
  result.actions.map(({ id, state }) => `${id}:${state}`);

describe("BrowserTaskService", () => {
  it.effect("keeps a submission with a withheld ack uncertain through duplicates and cancel", () =>
    Effect.gen(function* () {
      const task = yield* harness({
        choices: ["save", "DONE"],
        withhold: (operation) => operation === "click",
      });
      const fiber = yield* task.service
        .run({ scope, request: FORM_REQUEST, authorize: allow })
        .pipe(Effect.forkChild);
      yield* Deferred.await(task.inFlight);

      const duplicate = yield* task.service.run({ scope, request: FORM_REQUEST, authorize: allow });
      assert.strictEqual(duplicate.replayed, true);
      assert.strictEqual(duplicate.status, "running");
      assert.deepStrictEqual(statesOf(duplicate), ["email:completed", "save:dispatched"]);

      const changed = yield* task.service
        .run({ scope, request: { ...FORM_REQUEST, goal: "Something else" }, authorize: allow })
        .pipe(Effect.flip);
      assert.include(changed.message, "different inputs");

      const cancelling = yield* task.service
        .cancel({ scope, requestId: "form-1" })
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* passGrace;
      const cancelled = yield* Fiber.join(cancelling);
      assert.strictEqual(cancelled.status, "cancelled");
      assert.deepStrictEqual(statesOf(cancelled), ["email:completed", "save:uncertain"]);
      assert.strictEqual(cancelled.continuation.state, "leased");
      assert.strictEqual(cancelled.checksFinal, false);
      assert.deepStrictEqual(task.released, [{ leased: true, inspectFirst: true }]);

      const first = yield* Fiber.join(fiber);
      assert.strictEqual(first.status, "cancelled");

      yield* Deferred.succeed(task.quiesced, undefined);
      yield* Effect.yieldNow;
      const after = yield* task.service.run({ scope, request: FORM_REQUEST, authorize: allow });
      assert.strictEqual(after.continuation.state, "inspect-first");
      // One submission dispatch, and nothing after it, whatever came back later.
      assert.deepStrictEqual(
        task.acts.map((act) => act.operation),
        ["type", "click"],
      );
      assert.strictEqual(task.decisions.length, 1);
    }).pipe(Effect.scoped, Effect.provide(NodeCrypto.layer)),
  );

  it.effect("stops at the next dispatch once authority is revoked mid-run", () =>
    Effect.gen(function* () {
      let allowed = true;
      const task = yield* harness({ choices: ["save"] });
      const authorize = Effect.suspend(() =>
        allowed ? Effect.void : Effect.fail({ message: "Agent browser access was turned off." }),
      );
      const original = task.decisions;
      const fiber = yield* task.service
        .run({
          scope,
          request: FORM_REQUEST,
          authorize: authorize.pipe(
            Effect.tap(() =>
              Effect.sync(() => {
                if (original.length >= 1 && task.page.email !== "") allowed = false;
              }),
            ),
          ),
        })
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* passGrace;
      const result = yield* Fiber.join(fiber);
      assert.strictEqual(result.status, "blocked");
      assert.strictEqual(result.reason, "authority-revoked");
      assert.deepStrictEqual(
        task.acts.map((act) => act.operation),
        ["type"],
      );
    }).pipe(Effect.scoped, Effect.provide(NodeCrypto.layer)),
  );

  it.effect("treats a revoked credential as loss of authority", () =>
    Effect.gen(function* () {
      const task = yield* harness({ credential: () => "revoked" });
      const result = yield* report(
        task.service.run({ scope, request: FORM_REQUEST, authorize: allow }),
      );
      assert.strictEqual(result.reason, "authority-revoked");
      assert.strictEqual(task.decisions.length, 0);
      assert.strictEqual(task.acts.length, 0);
    }).pipe(Effect.scoped, Effect.provide(NodeCrypto.layer)),
  );

  it.effect("reads again when a navigating page refuses a read, without spending a decision", () =>
    Effect.gen(function* () {
      let reads = 0;
      const task = yield* harness({
        choices: ["save"],
        unreadable: () => ++reads <= 2,
      });
      const fiber = yield* task.service
        .run({ scope, request: FORM_REQUEST, authorize: allow })
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.seconds(3));
      const result = yield* Fiber.join(fiber);
      assert.strictEqual(result.status, "passed");
      assert.strictEqual(task.page.submits, 1);
      assert.strictEqual(task.decisions.length, 1);
      assert.strictEqual(result.timings.waitMs, 2_000);
    }).pipe(Effect.scoped, Effect.provide(NodeCrypto.layer)),
  );

  it.effect("gives up on a page that stays unreadable, having touched nothing", () =>
    Effect.gen(function* () {
      let reads = 0;
      const task = yield* harness({
        choices: ["save"],
        unreadable: () => {
          reads += 1;
          return true;
        },
      });
      const fiber = yield* task.service
        .run({ scope, request: FORM_REQUEST, authorize: allow })
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.seconds(3));
      const result = yield* Fiber.join(fiber);
      assert.strictEqual(result.status, "blocked");
      assert.strictEqual(result.reason, "observation-failed");
      assert.strictEqual(reads, 3);
      assert.strictEqual(task.decisions.length, 0);
      assert.strictEqual(task.acts.length, 0);
    }).pipe(Effect.scoped, Effect.provide(NodeCrypto.layer)),
  );

  it.effect("bounds page reads by the run's time even when a read never answers", () =>
    Effect.gen(function* () {
      const task = yield* harness({ readHangs: true });
      const fiber = yield* task.service
        .run({
          scope,
          request: { ...FORM_REQUEST, limits: { timeoutMs: 2_000 } },
          authorize: allow,
        })
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.seconds(3));
      const result = yield* Fiber.join(fiber);
      assert.strictEqual(result.status, "blocked");
      assert.strictEqual(result.reason, "deadline");
      assert.strictEqual(task.decisions.length, 0);
      assert.strictEqual(task.acts.length, 0);
    }).pipe(Effect.scoped, Effect.provide(NodeCrypto.layer)),
  );

  it.effect("refuses a retry after a restart, since the journal and the tab are both gone", () =>
    Effect.gen(function* () {
      const before = yield* harness({ choices: ["save"] });
      yield* report(before.service.run({ scope, request: FORM_REQUEST, authorize: allow }));
      assert.strictEqual(before.page.submits, 1);
      const restarted = yield* harness({ choices: ["save"], page: before.page });
      const refused = yield* restarted.service
        .run({
          scope,
          request: { ...FORM_REQUEST, tabId: PreviewTabId.make("tab_from_before_the_restart") },
          authorize: allow,
        })
        .pipe(Effect.flip);
      assert.strictEqual(refused.code, "capability_denied");
      assert.strictEqual(before.page.submits, 1);
      assert.strictEqual(restarted.decisions.length, 0);
      assert.strictEqual(restarted.acts.length, 0);
    }).pipe(Effect.scoped, Effect.provide(NodeCrypto.layer)),
  );

  it.effect("rejects DONE when the independent checks do not hold", () =>
    Effect.gen(function* () {
      const task = yield* harness({ choices: ["DONE"], page: { email: "a@b.c" } });
      const result = yield* report(
        task.service.run({ scope, request: FORM_REQUEST, authorize: allow }),
      );
      assert.strictEqual(result.status, "failed");
      assert.strictEqual(result.reason, "false-done");
      assert.strictEqual(result.checksFinal, true);
      assert.deepStrictEqual(
        result.checks.map((check) => check.status),
        ["failed"],
      );
    }).pipe(Effect.scoped, Effect.provide(NodeCrypto.layer)),
  );

  it.effect("passes on the page's own evidence, after one submission", () =>
    Effect.gen(function* () {
      const task = yield* harness({ choices: ["save"] });
      const result = yield* report(
        task.service.run({ scope, request: FORM_REQUEST, authorize: allow }),
      );
      assert.strictEqual(result.status, "passed");
      assert.strictEqual(result.checksFinal, true);
      assert.strictEqual(result.continuation.state, "leased");
      assert.strictEqual(task.page.submits, 1);
      // The supplied value never reaches the decision provider.
      assert.notInclude(JSON.stringify(task.decisions), "a@b.c");
      assert.strictEqual(result.usage.unreportedCalls, 0);
    }).pipe(Effect.scoped, Effect.provide(NodeCrypto.layer)),
  );

  it.effect("finishes when the submission leaves the page holding the filled fields", () =>
    Effect.gen(function* () {
      const task = yield* harness({ choices: ["save"], page: { leavesFormOnSubmit: true } });
      const result = yield* report(
        task.service.run({ scope, request: FORM_REQUEST, authorize: allow }),
      );
      assert.strictEqual(result.status, "passed");
      assert.strictEqual(task.decisions.length, 1);
    }).pipe(Effect.scoped, Effect.provide(NodeCrypto.layer)),
  );

  it.effect("tells the model which offered steps are on the page but not yet taken", () =>
    Effect.gen(function* () {
      const task = yield* harness({ choices: ["BLOCKED"], page: { text: "Icons" } });
      yield* report(task.service.run({ scope, request: FORM_REQUEST, authorize: allow }));
      const available = task.decisions.map(
        (decision) => (decision.evidence as { available_now: unknown }).available_now,
      );
      assert.deepStrictEqual(available[0], ["save"]);
    }).pipe(Effect.scoped, Effect.provide(NodeCrypto.layer)),
  );

  it.effect("tells the model what the caller expects but the page does not show yet", () =>
    Effect.gen(function* () {
      const task = yield* harness({ choices: ["BLOCKED"], page: { tree: `- main [ref=m]` } });
      yield* report(task.service.run({ scope, request: FORM_REQUEST, authorize: allow }));
      assert.deepStrictEqual(
        (task.decisions[0]!.evidence as { readonly not_on_page_yet: unknown }).not_on_page_yet,
        ['textbox "Email"', 'button "Save"'],
      );
    }).pipe(Effect.scoped, Effect.provide(NodeCrypto.layer)),
  );

  it.effect(
    "fills supplied fields without asking the model, and offers submission only after",
    () =>
      Effect.gen(function* () {
        const task = yield* harness({ choices: ["BLOCKED"] });
        const result = yield* report(
          task.service.run({ scope, request: FORM_REQUEST, authorize: allow }),
        );
        assert.strictEqual(result.reason, "model-blocked");
        assert.deepStrictEqual(statesOf(result), ["email:completed"]);
        assert.deepStrictEqual(
          task.acts.map((act) => act.operation),
          ["type"],
        );
        const [decision] = task.decisions;
        const labels =
          decision?.questions[0]?.type === "choice"
            ? decision.questions[0].choices.map((choice) => choice.label)
            : [];
        assert.deepStrictEqual(labels, ["save", "SCROLL_DOWN", "WAIT", "DONE", "BLOCKED"]);
      }).pipe(Effect.scoped, Effect.provide(NodeCrypto.layer)),
  );

  it.effect("reports a failed decision with unknown cost, and does not retry it", () =>
    Effect.gen(function* () {
      const task = yield* harness({
        choices: [new DecisionError({ code: "rate-limited" })],
        page: { email: "a@b.c" },
      });
      const result = yield* report(
        task.service.run({ scope, request: FORM_REQUEST, authorize: allow }),
      );
      assert.strictEqual(result.status, "blocked");
      assert.strictEqual(result.reason, "decision-rate-limited");
      assert.strictEqual(result.usage.unreportedCalls, 1);
      assert.strictEqual(task.decisions.length, 1);
      assert.strictEqual(result.evidence.url, "http://site.test/form");
      assert.isNotNull(result.evidence.ageMs);
      assert.deepStrictEqual(
        result.checks.map((check) => [check.status, check.lastObserved]),
        [["not-evaluated", "failed"]],
      );
    }).pipe(Effect.scoped, Effect.provide(NodeCrypto.layer)),
  );

  it.effect("holds a run to its decision and action limits", () =>
    Effect.gen(function* () {
      const decisions = yield* harness({
        choices: ["WAIT", "WAIT", "WAIT"],
        page: { email: "a@b.c" },
      });
      const fiber = yield* decisions.service
        .run({
          scope,
          request: { ...FORM_REQUEST, limits: { maxDecisions: 2 } },
          authorize: allow,
        })
        .pipe(Effect.forkChild);
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.seconds(1));
      yield* Effect.yieldNow;
      yield* TestClock.adjust(Duration.seconds(1));
      yield* Effect.yieldNow;
      yield* passGrace;
      const limited = yield* Fiber.join(fiber);
      assert.strictEqual(limited.reason, "decision-limit");
      assert.strictEqual(decisions.decisions.length, 2);
      assert.strictEqual(limited.timings.waitMs, 2_000);

      const actions = yield* harness({
        choices: ["SCROLL_DOWN", "SCROLL_DOWN"],
        page: { email: "a@b.c" },
      });
      const acted = yield* report(
        actions.service.run({
          scope,
          request: { ...FORM_REQUEST, limits: { maxActions: 1 } },
          authorize: allow,
        }),
      );
      assert.strictEqual(acted.reason, "action-limit");
      assert.strictEqual(actions.acts.length, 1);
    }).pipe(Effect.scoped, Effect.provide(NodeCrypto.layer)),
  );

  it.effect("stops at the run deadline rather than dispatching late", () =>
    Effect.gen(function* () {
      const task = yield* harness({
        choices: ["save"],
        withhold: (operation) => operation === "type",
      });
      const fiber = yield* task.service
        .run({
          scope,
          request: { ...FORM_REQUEST, limits: { timeoutMs: 2_000 } },
          authorize: allow,
        })
        .pipe(Effect.forkChild);
      yield* Deferred.await(task.inFlight);
      yield* TestClock.adjust(Duration.seconds(3));
      yield* Effect.yieldNow;
      yield* passGrace;
      const result = yield* Fiber.join(fiber);
      assert.strictEqual(result.reason, "uncertain-mutation");
      assert.deepStrictEqual(statesOf(result), ["email:uncertain"]);
      assert.strictEqual(task.acts.length, 1);
    }).pipe(Effect.scoped, Effect.provide(NodeCrypto.layer)),
  );

  it.effect("blocks when a chosen target goes stale, and reports it as never dispatched", () =>
    Effect.gen(function* () {
      const task = yield* harness({
        refuse: { operation: "type", tag: "PreviewAutomationInvalidSelectorError" },
      });
      const result = yield* report(
        task.service.run({ scope, request: FORM_REQUEST, authorize: allow }),
      );
      assert.strictEqual(result.reason, "stale-target");
      assert.deepStrictEqual(statesOf(result), ["email:planned"]);
      assert.strictEqual(task.acts.length, 1);
    }).pipe(Effect.scoped, Effect.provide(NodeCrypto.layer)),
  );

  it.effect("refuses an ambiguous submit target before filling anything", () =>
    Effect.gen(function* () {
      const task = yield* harness({
        page: {
          tree: [
            '- textbox "Email" [ref=t3-1-email]',
            '- button "Save" [ref=t3-1-a]',
            '- button "Save" [ref=t3-1-b]',
          ].join("\n"),
        },
      });
      const result = yield* report(
        task.service.run({ scope, request: FORM_REQUEST, authorize: allow }),
      );
      assert.strictEqual(result.status, "blocked");
      assert.strictEqual(result.reason, "ambiguous-target");
      assert.strictEqual(task.acts.length, 0);
      assert.strictEqual(task.decisions.length, 0);
    }).pipe(Effect.scoped, Effect.provide(NodeCrypto.layer)),
  );

  it.effect("refuses an ambiguous capture target before filling anything", () =>
    Effect.gen(function* () {
      const task = yield* harness({
        page: {
          tree: [
            '- textbox "Email" [ref=t3-1-email]',
            '- button "Save" [ref=t3-1-save]',
            '- heading "Chart" [ref=t3-1-a]',
            '- heading "Chart" [ref=t3-1-b]',
          ].join("\n"),
        },
      });
      const result = yield* report(
        task.service.run({
          scope,
          request: {
            ...FORM_REQUEST,
            capture: { target: { role: "heading", name: "Chart" } },
            checks: [{ id: "image", kind: "artifact" }],
          },
          authorize: allow,
        }),
      );
      assert.strictEqual(result.reason, "ambiguous-target");
      assert.strictEqual(task.acts.length, 0);
    }).pipe(Effect.scoped, Effect.provide(NodeCrypto.layer)),
  );

  it.effect("refuses an ambiguous target before spending a decision or touching the page", () =>
    Effect.gen(function* () {
      const task = yield* harness({
        page: {
          tree: `- textbox "Email" [ref=a]\n- textbox "Email" [ref=b]\n- button "Save" [ref=c]`,
        },
      });
      const result = yield* report(
        task.service.run({ scope, request: FORM_REQUEST, authorize: allow }),
      );
      assert.strictEqual(result.reason, "ambiguous-target");
      assert.strictEqual(task.decisions.length, 0);
      assert.strictEqual(task.acts.length, 0);
    }).pipe(Effect.scoped, Effect.provide(NodeCrypto.layer)),
  );

  it.effect("does not let a cut snapshot establish absence", () =>
    Effect.gen(function* () {
      const task = yield* harness({
        choices: ["DONE"],
        page: { text: "x".repeat(TASK_SNAPSHOT_TEXT_LENGTH) },
      });
      const result = yield* report(
        task.service.run({
          scope,
          request: {
            requestId: "absent",
            tabId,
            engine: "jev",
            goal: "Confirm the banner left",
            checks: [{ id: "gone", kind: "text", includes: "Banner", expect: "absent" }],
          },
          authorize: allow,
        }),
      );
      assert.strictEqual(result.status, "failed");
      assert.deepStrictEqual(
        result.checks.map((check) => check.status),
        ["not-evaluated"],
      );
    }).pipe(Effect.scoped, Effect.provide(NodeCrypto.layer)),
  );

  it.effect("causes no effect or provider call for unauthorized or unsupported requests", () =>
    Effect.gen(function* () {
      const task = yield* harness({ choices: ["DONE"] });
      const phi = yield* task.service
        .run({
          scope: { ...scope, taskBrowser: { backend: "phi" } },
          request: FORM_REQUEST,
          authorize: allow,
        })
        .pipe(Effect.flip);
      assert.include(phi.message, "integrated browser only");
      const revoked = yield* task.service
        .run({
          scope,
          request: FORM_REQUEST,
          authorize: Effect.fail({ message: "turned off" }),
        })
        .pipe(Effect.flip);
      assert.strictEqual(revoked.code, "capability_denied");
      const foreign = yield* task.service
        .run({
          scope,
          request: { ...FORM_REQUEST, tabId: PreviewTabId.make("tab-other") },
          authorize: allow,
        })
        .pipe(Effect.flip);
      assert.strictEqual(foreign.code, "capability_denied");
      assert.strictEqual(task.decisions.length, 0);
      assert.strictEqual(task.acts.length, 0);
      assert.strictEqual(task.released.length, 0);
    }).pipe(Effect.scoped, Effect.provide(NodeCrypto.layer)),
  );

  it.effect("refuses new work when the journal is full, keeping replay of what it holds", () =>
    Effect.gen(function* () {
      const task = yield* harness({});
      const run = (requestId: string) =>
        report(
          task.service.run({
            scope,
            request: { ...FORM_REQUEST, requestId },
            authorize: allow,
          }),
        );
      for (let index = 0; index < 64; index += 1) yield* run(`request-${index}`);
      const full = yield* task.service
        .run({ scope, request: { ...FORM_REQUEST, requestId: "one-more" }, authorize: allow })
        .pipe(Effect.flip);
      assert.include(full.message, "replay protection");
      const replay = yield* task.service.run({
        scope,
        request: { ...FORM_REQUEST, requestId: "request-0" },
        authorize: allow,
      });
      assert.strictEqual(replay.replayed, true);
    }).pipe(Effect.scoped, Effect.provide(NodeCrypto.layer)),
  );

  it.effect("keeps replay protection through expiry, and drops it only on revocation", () =>
    Effect.gen(function* () {
      let state: "live" | "expired" | "revoked" = "live";
      const task = yield* harness({ credential: () => state });
      yield* report(task.service.run({ scope, request: FORM_REQUEST, authorize: allow }));
      state = "expired";
      const other = { ...scope, thread: { ...scope.thread, providerSessionId: "session-2" } };
      yield* report(
        task.service.run({
          scope: other,
          request: { ...FORM_REQUEST, requestId: "elsewhere" },
          authorize: allow,
        }),
      );
      const retained = yield* task.service.run({ scope, request: FORM_REQUEST, authorize: allow });
      assert.strictEqual(retained.replayed, true);
    }).pipe(Effect.scoped, Effect.provide(NodeCrypto.layer)),
  );

  it.effect("drops a session's journal once its credential is revoked", () =>
    Effect.gen(function* () {
      let state: "live" | "expired" | "revoked" = "live";
      const task = yield* harness({ credential: () => state });
      const first = yield* report(
        task.service.run({ scope, request: FORM_REQUEST, authorize: allow }),
      );
      assert.notStrictEqual(first.replayed, true);
      state = "revoked";
      const other = { ...scope, thread: { ...scope.thread, providerSessionId: "session-2" } };
      yield* report(
        task.service.run({
          scope: other,
          request: { ...FORM_REQUEST, requestId: "sweeps" },
          authorize: allow,
        }),
      );
      const forgotten = yield* task.service
        .cancel({ scope, requestId: "form-1" })
        .pipe(Effect.flip);
      assert.include(forgotten.message, "No task");
    }).pipe(Effect.scoped, Effect.provide(NodeCrypto.layer)),
  );

  it.effect("stops dispatching when the caller stops waiting, as a turn interrupt does", () =>
    Effect.gen(function* () {
      const task = yield* harness({
        choices: ["save"],
        withhold: (operation) => operation === "type",
      });
      const fiber = yield* task.service
        .run({ scope, request: FORM_REQUEST, authorize: allow })
        .pipe(Effect.forkChild);
      yield* Deferred.await(task.inFlight);
      yield* Fiber.interrupt(fiber);
      yield* Deferred.await(task.stopped);
      const state = yield* task.service.run({ scope, request: FORM_REQUEST, authorize: allow });
      assert.strictEqual(state.status, "cancelled");
      assert.deepStrictEqual(statesOf(state), ["email:uncertain"]);
      assert.strictEqual(task.acts.length, 1);
    }).pipe(Effect.scoped, Effect.provide(NodeCrypto.layer)),
  );

  it.effect("keeps a bounded caller's runs apart and guides it with its own tools", () =>
    Effect.gen(function* () {
      const task = yield* harness({ choices: ["save"] });
      const bounded: McpThreadInvocationScope = { ...scope, browserLane: "bounded" };
      const first = yield* report(
        task.service.run({ scope: bounded, request: FORM_REQUEST, authorize: allow }),
      );
      assert.strictEqual(first.status, "passed");
      yield* Deferred.succeed(task.quiesced, undefined);
      yield* Effect.yieldNow;
      const replay = yield* task.service.run({
        scope: bounded,
        request: FORM_REQUEST,
        authorize: allow,
      });
      assert.strictEqual(replay.replayed, true);
      assert.include(replay.continuation.guidance, "t3_browser_snapshot");
      assert.notInclude(replay.continuation.guidance, "preview tools");
      // The same session's own preview lane holds a separate journal, so it cannot replay this run.
      const other = yield* task.service
        .cancel({ scope, requestId: FORM_REQUEST.requestId })
        .pipe(Effect.flip);
      assert.include(other.message, "No task");
      // Nor can another provider session of the same thread.
      const sibling = yield* task.service
        .cancel({
          scope: { ...bounded, thread: { ...bounded.thread, providerSessionId: "session-2" } },
          requestId: FORM_REQUEST.requestId,
        })
        .pipe(Effect.flip);
      assert.include(sibling.message, "No task");
    }).pipe(Effect.scoped, Effect.provide(NodeCrypto.layer)),
  );

  it("names what is wrong with a malformed request before anything runs", () => {
    const base = FORM_REQUEST;
    const problem = (change: Partial<PreviewTaskRequest>) => requestProblem({ ...base, ...change });
    assert.isUndefined(problem({}));
    assert.include(problem({ checks: [] }), "at least one check");
    assert.include(problem({ submit: { id: "email", target: base.submit!.target } }), "used twice");
    assert.include(problem({ submit: { id: "DONE", target: base.submit!.target } }), "reserved");
    assert.include(
      problem({ checks: [{ id: "a", kind: "artifact" }] }),
      "capture and an artifact check",
    );
    assert.include(problem({ limits: { maxActions: 25 } }), "maxActions");
    assert.include(problem({ limits: { timeoutMs: 120_001 } }), "timeoutMs");
    assert.include(problem({ checks: [{ id: "u", kind: "url" }] }), "equals or includes");
  });
});

const OVERLAY_TREE = [
  `- main [ref=m]:`,
  `  - button "Save" [ref=save]`,
  `  - button "Dismiss" [ref=dismiss]`,
].join("\n");

const ORDERED_REQUEST: PreviewTaskRequest = {
  requestId: "ordered-1",
  tabId,
  engine: "jev",
  goal: "Save the email",
  bindings: FORM_REQUEST.bindings!,
  submit: FORM_REQUEST.submit!,
  steps: [
    { kind: "screenshot", id: "before", framing: "viewport" },
    { kind: "run", id: "email" },
    {
      kind: "screenshot",
      id: "filled",
      framing: "target",
      target: FORM_REQUEST.bindings![0]!.target,
    },
    { kind: "run", id: "save" },
    { kind: "screenshot", id: "after", framing: "full-page" },
  ],
  checks: FORM_REQUEST.checks,
};

describe("BrowserTaskService ordered steps", () => {
  const KEY_TARGET = { role: "textbox", name: "Email" } as const;
  const choicesOf = (decision: DecisionRequest) =>
    decision.questions[0]!.type === "choice"
      ? decision.questions[0]!.choices.map((choice) => choice.label)
      : [];

  it.effect("presses a key on its target without the click occlusion test", () =>
    Effect.gen(function* () {
      const task = yield* harness({ covered: () => true, onAct: () => {} });
      const result = yield* report(
        task.service.run({
          scope,
          request: {
            requestId: "key",
            tabId,
            engine: "jev",
            goal: "Accept the suggestion",
            actions: [{ id: "accept", press: { key: "Tab", target: KEY_TARGET } }],
            steps: [{ kind: "run", id: "accept" }],
            checks: [{ id: "here", kind: "url", includes: "/form" }],
          },
          authorize: allow,
        }),
      );
      assert.strictEqual(result.status, "passed");
      assert.strictEqual(result.decisions, 0);
      assert.deepStrictEqual(statesOf(result), ["accept:completed"]);
      assert.deepStrictEqual(task.coverChecks, []);
      assert.deepStrictEqual(
        task.acts.map(({ operation, input }) => [operation, input.locator, input.key]),
        [["press", "aria-ref=t3-1-email", "Tab"]],
      );
    }).pipe(Effect.scoped, Effect.provide(NodeCrypto.layer)),
  );

  it.effect("stops unpressed when the key's target does not hold focus", () =>
    Effect.gen(function* () {
      const task = yield* harness({
        refuse: { operation: "press", tag: "TaskTargetNotFocusable" },
      });
      const result = yield* report(
        task.service.run({
          scope,
          request: {
            requestId: "unfocusable",
            tabId,
            engine: "jev",
            goal: "Accept the suggestion",
            actions: [{ id: "accept", press: { key: "Enter", target: KEY_TARGET } }],
            steps: [{ kind: "run", id: "accept" }],
            checks: [{ id: "here", kind: "url", includes: "/form" }],
          },
          authorize: allow,
        }),
      );
      assert.strictEqual(result.status, "blocked");
      assert.strictEqual(result.reason, "target-not-focusable");
      assert.strictEqual(result.actions[0]?.state, "planned");
      assert.isDefined(result.actions[0]?.refusal);
    }).pipe(Effect.scoped, Effect.provide(NodeCrypto.layer)),
  );

  it("refuses an unstepped key recovery could never use, and keeps an unstepped Escape", () => {
    const dismiss = { role: "button", name: "Dismiss" } as const;
    const withKey = (key: "Enter" | "Space" | "Escape") =>
      requestProblem({
        ...ORDERED_REQUEST,
        actions: [{ id: "key", press: { key, target: dismiss } }],
      });
    assert.include(withKey("Enter"), "key needs a step");
    assert.include(withKey("Space"), "key needs a step");
    assert.isUndefined(withKey("Escape"));
  });

  it.effect("a key whose target went stale is refused unpressed, not left uncertain", () =>
    Effect.gen(function* () {
      const task = yield* harness({
        refuse: { operation: "press", tag: "PreviewAutomationInvalidSelectorError" },
      });
      const result = yield* report(
        task.service.run({
          scope,
          request: {
            requestId: "stale-key",
            tabId,
            engine: "jev",
            goal: "Accept the suggestion",
            actions: [{ id: "accept", press: { key: "Tab", target: KEY_TARGET } }],
            steps: [{ kind: "run", id: "accept" }],
            checks: [{ id: "here", kind: "url", includes: "/form" }],
          },
          authorize: allow,
        }),
      );
      assert.strictEqual(result.reason, "stale-target");
      assert.strictEqual(result.actions[0]?.state, "planned");
    }).pipe(Effect.scoped, Effect.provide(NodeCrypto.layer)),
  );

  it.effect("recovery offers an unstepped Escape key", () =>
    Effect.gen(function* () {
      let overlay = true;
      const task = yield* harness({
        choices: ["escape"],
        page: { tree: OVERLAY_TREE },
        covered: (locator) => overlay && locator === "aria-ref=save",
        onAct: (operation, input, page) => {
          if (operation === "press" && input.key === "Escape") overlay = false;
          if (operation === "click" && input.locator === "aria-ref=save") page.submits += 1;
        },
      });
      const dismiss = { role: "button", name: "Dismiss" } as const;
      const result = yield* report(
        task.service.run({
          scope,
          request: {
            requestId: "recover-key",
            tabId,
            engine: "jev",
            goal: "Save",
            actions: [{ id: "escape", press: { key: "Escape", target: dismiss } }],
            submit: { id: "save", target: { role: "button", name: "Save" } },
            steps: [{ kind: "run", id: "save" }],
            checks: [{ id: "here", kind: "url", includes: "/form" }],
          },
          authorize: allow,
        }),
      );
      assert.strictEqual(result.status, "passed");
      assert.deepStrictEqual(statesOf(result), ["escape:completed", "save:completed"]);
      assert.deepStrictEqual(choicesOf(task.decisions[0]!), [
        "escape",
        "SCROLL_DOWN",
        "WAIT",
        "BLOCKED",
      ]);
    }).pipe(Effect.scoped, Effect.provide(NodeCrypto.layer)),
  );

  it.effect("never clicks a covered target; Jev uncovers it with an unstepped control", () =>
    Effect.gen(function* () {
      let overlay = true;
      const clickedWhileCovered: string[] = [];
      const task = yield* harness({
        choices: ["dismiss"],
        page: { tree: OVERLAY_TREE },
        covered: (locator) => overlay && locator === "aria-ref=save",
        onAct: (operation, input, page) => {
          if (operation !== "click") return;
          if (overlay && input.locator === "aria-ref=save") clickedWhileCovered.push("save");
          if (input.locator === "aria-ref=dismiss") overlay = false;
          if (input.locator === "aria-ref=save") {
            page.submits += 1;
            page.tree = `${OVERLAY_TREE}\n  - heading "Saved" [ref=saved]`;
          }
        },
      });
      const result = yield* report(
        task.service.run({
          scope,
          request: {
            requestId: "overlay",
            tabId,
            engine: "jev",
            goal: "Save",
            actions: [{ id: "dismiss", target: { role: "button", name: "Dismiss" } }],
            submit: { id: "save", target: { role: "button", name: "Save" } },
            steps: [{ kind: "run", id: "save" }],
            checks: [{ id: "saved", kind: "text", includes: "Saved", expect: "present" }],
          },
          authorize: allow,
        }),
      );
      assert.strictEqual(result.status, "passed");
      assert.deepStrictEqual(clickedWhileCovered, []);
      assert.deepStrictEqual(statesOf(result), ["dismiss:completed", "save:completed"]);
      assert.deepStrictEqual(result.recoveries, [{ step: "save", decisions: 1 }]);
      assert.strictEqual(result.decisions, 1);
      assert.strictEqual(task.decisions[0]!.rule.id, "bounded-browser-task-recover-step");
      assert.deepStrictEqual(
        task.decisions[0]!.questions[0]!.type === "choice"
          ? task.decisions[0]!.questions[0]!.choices.map((choice) => choice.label)
          : [],
        ["dismiss", "SCROLL_DOWN", "WAIT", "BLOCKED"],
      );
      assert.strictEqual(task.page.submits, 1);
    }).pipe(Effect.scoped, Effect.provide(NodeCrypto.layer)),
  );

  it.effect("runs every step in order with no decision and returns screenshots in step order", () =>
    Effect.gen(function* () {
      const task = yield* harness({});
      const result = yield* report(
        task.service.run({ scope, request: ORDERED_REQUEST, authorize: allow }),
      );
      assert.strictEqual(result.status, "passed");
      assert.strictEqual(result.decisions, 0);
      assert.deepStrictEqual(result.recoveries, []);
      assert.deepStrictEqual(statesOf(result), ["email:completed", "save:completed"]);
      assert.deepStrictEqual(
        result.screenshots?.map(({ id, afterStep, framing }) => [id, afterStep, framing]),
        [
          ["before", null, "viewport"],
          ["filled", "email", "target"],
          ["after", "save", "full-page"],
        ],
      );
      assert.strictEqual(task.shots[1]!.locator, "aria-ref=t3-2-email");
      // Three planned plus the one a failed run takes: 6 MB shared four ways, 1 MB at most.
      assert.strictEqual(task.shots[0]!.maxBytes, 1_000_000);
      assert.isAtLeast(task.settles(), 2);
    }).pipe(Effect.scoped, Effect.provide(NodeCrypto.layer)),
  );

  it.effect("does not end early when the checks already pass", () =>
    Effect.gen(function* () {
      const task = yield* harness({ page: { submits: 1 } });
      const result = yield* report(
        task.service.run({ scope, request: ORDERED_REQUEST, authorize: allow }),
      );
      assert.strictEqual(result.status, "passed");
      assert.deepStrictEqual(statesOf(result), ["email:completed", "save:completed"]);
      assert.strictEqual(task.page.submits, 2);
    }).pipe(Effect.scoped, Effect.provide(NodeCrypto.layer)),
  );

  it.effect("stops at once on a landmark the page lacks, naming the nearest match", () =>
    Effect.gen(function* () {
      const task = yield* harness({
        page: { tree: `- main [ref=m]:\n  - link "new" [ref=new]\n  - link "past" [ref=past]` },
      });
      const result = yield* report(
        task.service.run({
          scope,
          request: {
            requestId: "scope",
            tabId,
            engine: "jev",
            goal: "Open new",
            actions: [
              {
                id: "new",
                target: { role: "link", name: "new", scope: { role: "navigation", name: "" } },
              },
            ],
            steps: [{ kind: "run", id: "new" }],
            checks: [{ id: "u", kind: "url", includes: "newest" }],
          },
          authorize: allow,
        }),
      );
      assert.strictEqual(result.status, "blocked");
      assert.strictEqual(result.reason, "target-not-found");
      assert.strictEqual(result.decisions, 0);
      assert.deepStrictEqual(result.missingTarget, {
        id: "new",
        target: 'link "new" in navigation ""',
        nearest: ['link "new"'],
      });
      assert.deepStrictEqual(task.acts, []);
    }).pipe(Effect.scoped, Effect.provide(NodeCrypto.layer)),
  );

  it.effect(
    "stops a goal-mode run on a stale name once Jev keeps waiting, naming the near match",
    () =>
      Effect.gen(function* () {
        const task = yield* harness({
          choices: ["SCROLL_DOWN", "WAIT", "WAIT"],
          page: { tree: `- main [ref=m]:\n  - link "83 comments" [ref=c]` },
        });
        const result = yield* report(
          task.service.run({
            scope,
            request: {
              requestId: "stale",
              tabId,
              engine: "jev",
              goal: "Open the comments",
              actions: [{ id: "comments", target: { role: "link", name: "81 comments" } }],
              checks: [{ id: "u", kind: "url", includes: "item" }],
            },
            authorize: allow,
          }),
        );
        assert.strictEqual(result.reason, "target-not-found");
        assert.strictEqual(result.decisions, 2);
        assert.deepStrictEqual(result.missingTarget?.nearest, ['link "83 comments"']);
      }).pipe(Effect.scoped, Effect.provide(NodeCrypto.layer)),
  );

  it.effect("waits for a loading page rather than calling its target absent", () =>
    Effect.gen(function* () {
      let loading = true;
      const task = yield* harness({
        page: { tree: `- main [ref=m]:\n  - button "Sav" [ref=x]` },
        loading: () => loading,
        onSettle: (page) => {
          loading = false;
          if (page.submits === 0) page.tree = `- main [ref=m]:\n  - button "Save" [ref=save]`;
        },
      });
      const result = yield* report(
        task.service.run({
          scope,
          request: {
            requestId: "loading",
            tabId,
            engine: "jev",
            goal: "Save",
            submit: { id: "save", target: { role: "button", name: "Save" } },
            steps: [{ kind: "run", id: "save" }],
            checks: [{ id: "u", kind: "url", includes: "form" }],
          },
          authorize: allow,
        }),
      );
      assert.strictEqual(result.status, "passed");
      assert.strictEqual(result.decisions, 0);
    }).pipe(Effect.scoped, Effect.provide(NodeCrypto.layer)),
  );

  it.effect("screenshots after a goal-mode action runs, and where a failed run stopped", () =>
    Effect.gen(function* () {
      const task = yield* harness({ choices: ["open", "BLOCKED"], page: { email: "a@b.c" } });
      const result = yield* report(
        task.service.run({
          scope,
          request: {
            ...FORM_REQUEST,
            requestId: "goal-shot",
            actions: [
              {
                id: "open",
                url: "http://site.test/form",
                screenshot: "viewport",
              },
            ],
          },
          authorize: allow,
        }),
      );
      assert.strictEqual(result.reason, "model-blocked");
      assert.deepStrictEqual(
        result.screenshots?.map(({ id, afterStep }) => [id, afterStep]),
        [
          ["open", "open"],
          ["stopped", "open"],
        ],
      );
    }).pipe(Effect.scoped, Effect.provide(NodeCrypto.layer)),
  );

  it.effect("never replays image bytes, and keeps only paths in its record", () =>
    Effect.gen(function* () {
      const task = yield* harness({});
      const request = { ...ORDERED_REQUEST, includeImages: true };
      yield* report(task.service.run({ scope, request, authorize: allow }));
      const replay = yield* task.service.run({ scope, request, authorize: allow });
      assert.strictEqual(replay.replayed, true);
      assert.notInclude(JSON.stringify(replay), "base64");
      assert.deepStrictEqual(
        replay.screenshots?.map((shot) => shot.path),
        ["/artifacts/shot-1.png", "/artifacts/shot-2.png", "/artifacts/shot-3.png"],
      );
    }).pipe(Effect.scoped, Effect.provide(NodeCrypto.layer)),
  );

  it.effect("keeps a result at the screenshot cap within its size bound", () =>
    Effect.gen(function* () {
      const task = yield* harness({});
      const shots = Array.from({ length: 7 }, (_, index) => ({
        kind: "screenshot" as const,
        id: `shot-${index}`,
        framing: "viewport" as const,
      }));
      const result = yield* report(
        task.service.run({
          scope,
          request: {
            ...ORDERED_REQUEST,
            requestId: "cap",
            steps: [
              ...shots.slice(0, 4),
              { kind: "run", id: "email" },
              { kind: "run", id: "save" },
              ...shots.slice(4),
            ],
          },
          authorize: allow,
        }),
      );
      assert.strictEqual(result.screenshots?.length, 7);
      // Seven of eight planned share the 6 MB total.
      assert.strictEqual(task.shots[0]!.maxBytes, 750_000);
      assert.isBelow(JSON.stringify(result).length, 6_000);
    }).pipe(Effect.scoped, Effect.provide(NodeCrypto.layer)),
  );

  it("refuses an ordered or screenshot request that could break its rules before anything runs", () => {
    const problem = (change: Partial<PreviewTaskRequest>) =>
      requestProblem({ ...ORDERED_REQUEST, ...change });
    assert.isUndefined(problem({}));
    const shot = (id: string) => ({
      kind: "screenshot" as const,
      id,
      framing: "viewport" as const,
    });
    assert.include(
      problem({ steps: [...ORDERED_REQUEST.steps!, ...["a", "b", "c", "d", "e"].map(shot)] }),
      "at most 8 screenshots",
    );
    assert.include(problem({ steps: [{ kind: "run", id: "nope" }] }), "names no binding");
    assert.include(
      problem({
        steps: [
          { kind: "run", id: "email" },
          { kind: "run", id: "email" },
        ],
      }),
      "at most once",
    );
    assert.include(problem({ steps: [{ kind: "run", id: "save" }] }), "email needs a step");
    assert.include(problem({ steps: [...ORDERED_REQUEST.steps!, shot("stopped")] }), "reserved");
    assert.include(
      problem({ steps: [{ kind: "screenshot", id: "t", framing: "target" }] }),
      "only with target framing",
    );
    assert.include(problem({ steps: [] }), "at least one step");
    assert.include(problem({ limits: { maxActions: 1 } }), "raise maxActions");
    assert.include(
      problem({
        actions: [{ id: "go", url: "http://x.test", screenshot: "viewport" }],
      }),
      "go needs a step",
    );
  });
  it.effect("leaves goal mode alone when only a step already taken has a near match", () =>
    Effect.gen(function* () {
      const task = yield* harness({
        choices: ["next", "SCROLL_DOWN", "SCROLL_DOWN", "BLOCKED"],
        page: { tree: `- main [ref=m]:\n  - link "Next" [ref=n]` },
        onAct: (operation, _input, page) => {
          if (operation === "click") page.tree = `- main [ref=m]:\n  - link "NEXT" [ref=n2]`;
        },
      });
      const result = yield* report(
        task.service.run({
          scope,
          request: {
            requestId: "taken",
            tabId,
            engine: "jev",
            goal: "Page on, then finish",
            actions: [
              { id: "next", target: { role: "link", name: "Next" } },
              { id: "finish", target: { role: "button", name: "Finish" } },
            ],
            checks: [{ id: "u", kind: "url", includes: "done" }],
          },
          authorize: allow,
        }),
      );
      assert.strictEqual(result.reason, "model-blocked");
      assert.strictEqual(result.decisions, 4);
    }).pipe(Effect.scoped, Effect.provide(NodeCrypto.layer)),
  );

  it.effect("never offers recovery a control that is itself covered", () =>
    Effect.gen(function* () {
      const task = yield* harness({
        choices: ["BLOCKED"],
        page: { tree: OVERLAY_TREE },
        covered: () => true,
      });
      const result = yield* report(
        task.service.run({
          scope,
          request: {
            requestId: "stacked",
            tabId,
            engine: "jev",
            goal: "Save",
            actions: [{ id: "dismiss", target: { role: "button", name: "Dismiss" } }],
            submit: { id: "save", target: { role: "button", name: "Save" } },
            steps: [{ kind: "run", id: "save" }],
            checks: [{ id: "saved", kind: "text", includes: "Saved", expect: "present" }],
          },
          authorize: allow,
        }),
      );
      assert.strictEqual(result.reason, "model-blocked");
      const question = task.decisions[0]!.questions[0]!;
      assert.deepStrictEqual(
        question.type === "choice" ? question.choices.map((choice) => choice.label) : [],
        ["SCROLL_DOWN", "WAIT", "BLOCKED"],
      );
      assert.deepStrictEqual(task.acts, []);
    }).pipe(Effect.scoped, Effect.provide(NodeCrypto.layer)),
  );

  it.effect("stops a target screenshot on a stale name as target-not-found", () =>
    Effect.gen(function* () {
      const task = yield* harness({});
      const result = yield* report(
        task.service.run({
          scope,
          request: {
            ...ORDERED_REQUEST,
            requestId: "stale-shot",
            steps: [
              { kind: "run", id: "email" },
              {
                kind: "screenshot",
                id: "shot",
                framing: "target",
                target: { role: "button", name: "save" },
              },
              { kind: "run", id: "save" },
            ],
          },
          authorize: allow,
        }),
      );
      assert.strictEqual(result.reason, "target-not-found");
      assert.deepStrictEqual(result.missingTarget?.nearest, ['button "Save"']);
      assert.strictEqual(result.decisions, 0);
    }).pipe(Effect.scoped, Effect.provide(NodeCrypto.layer)),
  );

  it.effect("ties a screenshot to the step before it even when that step dispatched nothing", () =>
    Effect.gen(function* () {
      const task = yield* harness({
        page: { tree: `- main [ref=m]:\n  - checkbox "Terms" [checked] [ref=t]` },
      });
      const result = yield* report(
        task.service.run({
          scope,
          request: {
            requestId: "satisfied",
            tabId,
            engine: "jev",
            goal: "Accept terms",
            bindings: [
              {
                id: "terms",
                control: "checkbox",
                target: { role: "checkbox", name: "Terms" },
                checked: true,
              },
            ],
            steps: [
              { kind: "run", id: "terms" },
              { kind: "screenshot", id: "after", framing: "viewport" },
            ],
            checks: [{ id: "u", kind: "url", includes: "form" }],
          },
          authorize: allow,
        }),
      );
      assert.strictEqual(result.status, "passed");
      assert.strictEqual(result.screenshots?.[0]?.afterStep, "terms");
      assert.deepStrictEqual(task.acts, []);
    }).pipe(Effect.scoped, Effect.provide(NodeCrypto.layer)),
  );
});
