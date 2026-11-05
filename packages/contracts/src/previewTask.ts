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
  /** Replay protection is never evicted, so a session past this many requests is refused. */
  sessionRequests: 64,
} as const;

const Id = Schema.String.check(Schema.isPattern(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/));
const Text = Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(2048));

export const PreviewTaskTarget = Schema.Struct({
  role: Schema.String.check(Schema.isPattern(/^[a-z]+$/)).annotate({
    description: "ARIA role in preview_snapshot's tree, such as textbox, button or heading.",
  }),
  name: Schema.String.check(Schema.isMaxLength(512)).annotate({
    description: "Exact accessible name.",
  }),
  scope: Schema.optional(
    Schema.Struct({ role: Schema.String, name: Schema.String }).annotate({
      description: "Unique ancestor the target must sit inside.",
    }),
  ),
}).annotate({ description: "Must resolve to exactly one rendered element; otherwise it blocks." });
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

export const PreviewTaskAction = Schema.Union([
  Schema.Struct({ id: Id, target: PreviewTaskTarget }),
  Schema.Struct({ id: Id, url: Text }),
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
    description: "The only clicks or URLs the task may use, besides submit and scrolling.",
  }),
  submit: Schema.optional(Schema.Struct({ id: Id, target: PreviewTaskTarget })).annotate({
    description: "Dispatched at most once per run, and only when you name it here.",
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
    }),
  ),
  /** True only when `checks` were read from the page after the last dispatched action. */
  checksFinal: Schema.Boolean,
  checks: Schema.Array(PreviewTaskCheckResult),
  artifact: Schema.optional(PreviewTaskArtifact),
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
