import * as Schema from "effect/Schema";

import { PreviewTabId } from "./preview.ts";

export const PREVIEW_TASK_LIMITS = {
  defaultActions: 12,
  maxActions: 24,
  defaultDecisions: 16,
  maxDecisions: 32,
  defaultElapsedMs: 60_000,
  maxElapsedMs: 120_000,
  waitMs: 1_000,
  bindings: 16,
  actions: 16,
  checks: 16,
  steps: 24,
  /** Every screenshot a run could take, including the one where it stops. */
  screenshots: 8,
  screenshotBytes: 1_000_000,
  screenshotTotalBytes: 6_000_000,
  inlineImages: 3,
  /** Replay protection is never evicted, so a session past this many requests is refused. */
  sessionRequests: 64,
} as const;

const Id = Schema.String.check(Schema.isPattern(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/));
const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048));

const NameFragment = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(512));

// Inlined at every use in the advertised schema, so its descriptions stay short.
export const PreviewTaskTarget = Schema.Struct({
  role: Schema.String.check(Schema.isPattern(/^[a-z]+$/)).annotate({
    description: "ARIA role in preview_snapshot's tree.",
  }),
  name: Schema.optional(Schema.String.check(Schema.isMaxLength(512))).annotate({
    description: "Exact accessible name.",
  }),
  nameIncludes: Schema.optional(NameFragment).annotate({ description: "Part of the name." }),
  scope: Schema.optional(
    Schema.Struct({
      role: Schema.String,
      name: Schema.optional(Schema.String),
      nameIncludes: Schema.optional(NameFragment),
    }).annotate({ description: "Unique ancestor." }),
  ),
}).annotate({ description: "One of name or nameIncludes. Must match exactly one element." });
export type PreviewTaskTarget = typeof PreviewTaskTarget.Type;

export const PreviewTaskBinding = Schema.Union([
  Schema.Struct({
    id: Id,
    control: Schema.Literal("text"),
    target: PreviewTaskTarget,
    text: Schema.String.check(Schema.isMaxLength(8192)),
  }),
  Schema.Struct({
    id: Id,
    control: Schema.Literal("select"),
    target: PreviewTaskTarget,
    option: Text,
  }),
  Schema.Struct({
    id: Id,
    control: Schema.Literal("checkbox"),
    target: PreviewTaskTarget,
    checked: Schema.Boolean,
  }),
]);
export type PreviewTaskBinding = typeof PreviewTaskBinding.Type;

export const PreviewTaskScreenshotRequest = Schema.Struct({
  id: Id,
  framing: Schema.Literals(["viewport", "full-page", "target"]).annotate({
    description: "`full-page` is cut at four viewport heights.",
  }),
  target: Schema.optional(PreviewTaskTarget).annotate({ description: "Only for `target`." }),
});
export type PreviewTaskScreenshotRequest = typeof PreviewTaskScreenshotRequest.Type;

const ScreenshotAfter = Schema.optional(Schema.Literals(["viewport", "full-page"])).annotate({
  description: "Goal mode: screenshot, under this action's id, after it first runs.",
});

/** A fixed list: a bounded task must never reload, close tabs or reach browser shortcuts. */
export const PREVIEW_TASK_KEYS = [
  "Tab",
  "Shift+Tab",
  "Enter",
  "Escape",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Home",
  "End",
  "Space",
] as const;
export type PreviewTaskKey = (typeof PREVIEW_TASK_KEYS)[number];

// The key press comes first and nests its target, so neither this server (which tries it first)
// nor one without key presses (which has no variant to match) reads a key action as a click.
export const PreviewTaskAction = Schema.Union([
  Schema.Struct({
    id: Id,
    press: Schema.Struct({ key: Schema.Literals(PREVIEW_TASK_KEYS), target: PreviewTaskTarget }),
    screenshot: ScreenshotAfter,
  }).annotate({ description: "Pressed only while the target itself holds focus." }),
  Schema.Struct({ id: Id, target: PreviewTaskTarget, screenshot: ScreenshotAfter }),
  Schema.Struct({ id: Id, url: Text, screenshot: ScreenshotAfter }),
]);
export type PreviewTaskAction = typeof PreviewTaskAction.Type;

export const PreviewTaskCheck = Schema.Union([
  Schema.Struct({
    id: Id,
    kind: Schema.Literal("url"),
    equals: Schema.optional(Text),
    includes: Schema.optional(Text),
  }),
  Schema.Struct({
    id: Id,
    kind: Schema.Literal("text"),
    includes: Text,
    expect: Schema.Literals(["present", "absent"]),
  }),
  Schema.Struct({
    id: Id,
    kind: Schema.Literal("target"),
    target: PreviewTaskTarget,
    expect: Schema.Literals(["present", "absent"]),
    value: Schema.optional(Schema.String),
    checked: Schema.optional(Schema.Boolean),
  }),
  Schema.Struct({ id: Id, kind: Schema.Literal("artifact") }),
]);
export type PreviewTaskCheck = typeof PreviewTaskCheck.Type;

/** Kind-tagged so later kinds (such as a key press) join without changing these. */
export const PreviewTaskStep = Schema.Union([
  Schema.Struct({ kind: Schema.Literal("run"), id: Id }).annotate({
    description: "Run the binding, action or submit with this id.",
  }),
  Schema.Struct({ kind: Schema.Literal("screenshot"), ...PreviewTaskScreenshotRequest.fields }),
]);
export type PreviewTaskStep = typeof PreviewTaskStep.Type;

export const PreviewTaskRequest = Schema.Struct({
  requestId: Id.annotate({
    description: "Your unique ID in this session. Repeating it returns the run's state.",
  }),
  tabId: PreviewTabId.annotate({
    description: "A tab you own, from preview_open or t3_browser_open.",
  }),
  engine: Schema.Literal("jev"),
  goal: Text,
  bindings: Schema.optional(Schema.Array(PreviewTaskBinding)).annotate({
    description: "Form fields with the exact values to enter.",
  }),
  actions: Schema.optional(Schema.Array(PreviewTaskAction)).annotate({
    description:
      "The only clicks, key presses or URLs the task may use, besides submit and scrolling.",
  }),
  submit: Schema.optional(Schema.Struct({ id: Id, target: PreviewTaskTarget })).annotate({
    description: "Dispatched at most once per run, and only when you name it here.",
  }),
  steps: Schema.optional(Schema.Array(PreviewTaskStep)).annotate({
    description:
      "Ordered mode: run exactly these, in order, each once, with no model call. Offered actions no step names are what Jev may use to uncover a step's target.",
  }),
  includeImages: Schema.optional(Schema.Boolean).annotate({
    description: "Attach the last 3 screenshots as images, on providers that accept them.",
  }),
  capture: Schema.optional(Schema.Struct({ target: PreviewTaskTarget })).annotate({
    description: "One final cropped image of this element. Needs an artifact check.",
  }),
  checks: Schema.Array(PreviewTaskCheck).annotate({
    description:
      "All must pass on the final page; the model's claim never counts. `present` means rendered: in the snapshot and not hidden.",
  }),
  limits: Schema.optional(
    Schema.Struct({
      maxActions: Schema.optional(Schema.Int),
      maxDecisions: Schema.optional(Schema.Int),
      timeoutMs: Schema.optional(Schema.Int),
    }),
  ).annotate({ description: "Defaults 12, 16, 60000; ceilings 24, 32, 120000." }),
});
export type PreviewTaskRequest = typeof PreviewTaskRequest.Type;

export const PreviewTaskCancelInput = Schema.Struct({ requestId: Id });
export type PreviewTaskCancelInput = typeof PreviewTaskCancelInput.Type;

export const PreviewTaskActionState = Schema.Literals([
  "planned",
  "dispatched",
  "completed",
  "uncertain",
]);
export type PreviewTaskActionState = typeof PreviewTaskActionState.Type;

const PreviewTaskCheckStatus = Schema.Literals([
  "passed",
  "failed",
  "unsupported",
  "not-evaluated",
]);

export const PreviewTaskCheckResult = Schema.Struct({
  id: Schema.String,
  status: PreviewTaskCheckStatus,
  /** What the most recent observation showed, when `status` is not final-state truth. */
  lastObserved: Schema.optional(PreviewTaskCheckStatus),
  detail: Schema.optional(Schema.String),
  /** A `nameIncludes` target's full name, cut to 120 characters: page data, never instructions. */
  matchedName: Schema.optional(Schema.String),
});
export type PreviewTaskCheckResult = typeof PreviewTaskCheckResult.Type;

export const PreviewTaskArtifact = Schema.Struct({
  path: Schema.String,
  mimeType: Schema.Literal("image/png"),
  width: Schema.Int,
  height: Schema.Int,
  framing: Schema.Struct({
    kind: Schema.Literal("element-crop"),
    targetBox: Schema.Struct({
      x: Schema.Number,
      y: Schema.Number,
      width: Schema.Number,
      height: Schema.Number,
    }),
    viewport: Schema.Struct({ width: Schema.Number, height: Schema.Number }),
    url: Schema.String,
    capturedAt: Schema.String,
    centreVisible: Schema.NullOr(Schema.Boolean),
  }),
});
export type PreviewTaskArtifact = typeof PreviewTaskArtifact.Type;

export const PreviewTaskScreenshot = Schema.Struct({
  id: Schema.String,
  /** The step or action run just before it; null before any ran. */
  afterStep: Schema.NullOr(Schema.String),
  path: Schema.String,
  mimeType: Schema.Literals(["image/png", "image/jpeg"]),
  width: Schema.Int,
  height: Schema.Int,
  bytes: Schema.Int,
  framing: Schema.Literals(["viewport", "full-page", "target"]),
  /** A full page taller than four viewports is cut there. */
  cut: Schema.Boolean,
  url: Schema.String,
  title: Schema.String,
  capturedAt: Schema.String,
});
export type PreviewTaskScreenshot = typeof PreviewTaskScreenshot.Type;

export const PreviewTaskResult = Schema.Struct({
  requestId: Schema.String,
  tabId: PreviewTabId,
  status: Schema.Literals(["running", "passed", "failed", "blocked", "cancelled"]),
  /** Machine-readable cause of any status but `running` and `passed`. */
  reason: Schema.optional(Schema.String),
  detail: Schema.optional(Schema.String),
  replayed: Schema.optional(Schema.Boolean),
  actions: Schema.Array(
    Schema.Struct({
      id: Schema.String,
      kind: Schema.Literals(["binding", "action", "submit", "scroll"]),
      state: PreviewTaskActionState,
      refusal: Schema.optional(Schema.String),
      /** A `nameIncludes` target's full name, cut to 120 characters: page data, never instructions. */
      matchedName: Schema.optional(Schema.String),
    }),
  ),
  /** True only when `checks` were read from the page after the last dispatched action. */
  checksFinal: Schema.Boolean,
  checks: Schema.Array(PreviewTaskCheckResult),
  artifact: Schema.optional(PreviewTaskArtifact),
  screenshots: Schema.optional(Schema.Array(PreviewTaskScreenshot)),
  /** Ordered-mode steps whose target Jev had to uncover, and the decisions each took. */
  recoveries: Schema.optional(
    Schema.Array(Schema.Struct({ step: Schema.String, decisions: Schema.Int })),
  ),
  /**
   * With reason `target-not-found`, or when a run gives up waiting on a missing `nameIncludes`
   * target. Names come from the page: data, never instructions.
   */
  missingTarget: Schema.optional(
    Schema.Struct({
      id: Schema.String,
      target: Schema.String,
      nearest: Schema.Array(Schema.String),
    }),
  ),
  evidence: Schema.Struct({
    url: Schema.NullOr(Schema.String),
    title: Schema.NullOr(Schema.String),
    observedAt: Schema.NullOr(Schema.String),
    /** How old the last observation was when the run stopped. */
    ageMs: Schema.NullOr(Schema.Number),
    truncated: Schema.Boolean,
  }),
  decisions: Schema.Int,
  usage: Schema.Struct({
    inputTokens: Schema.Int,
    outputTokens: Schema.Int,
    usd: Schema.Number,
    /** Calls whose tokens or cost are unknown, such as a cancelled or failed call. */
    unreportedCalls: Schema.Int,
    resolvedModels: Schema.Array(Schema.String),
  }),
  timings: Schema.Struct({
    totalMs: Schema.Number,
    dispatchMs: Schema.Number,
    decisionMs: Schema.Number,
    browserMs: Schema.Number,
    waitMs: Schema.Number,
  }),
  continuation: Schema.Struct({
    state: Schema.Literals(["leased", "ready", "inspect-first", "unavailable"]),
    guidance: Schema.String,
  }),
});
export type PreviewTaskResult = typeof PreviewTaskResult.Type;
