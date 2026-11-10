// @effect-diagnostics globalDate:off -- UI snooze presets use local calendar boundaries and Intl labels.
import * as DateTime from "effect/DateTime";
import { DEFAULT_SNOOZE_PRESETS, type SnoozePresetSetting } from "@t3tools/contracts/settings";

import type { OrchestrationV2ParkedWait } from "@t3tools/contracts";

import type { EnvironmentThreadShell, PendingSubagentRequest } from "./models.ts";

interface SettlementRunLike {
  readonly turnId?: unknown;
  readonly assistantMessageId?: unknown;
  readonly status?: string;
  readonly state?: string;
  readonly requestedAt?: string | null;
  readonly startedAt?: string | null;
  readonly completedAt?: string | null;
}

interface SettlementRuntimeLike {
  readonly threadId?: unknown;
  readonly providerName?: unknown;
  readonly runtimeMode?: unknown;
  readonly activeTurnId?: unknown;
  readonly lastError?: unknown;
  readonly status: string;
  readonly updatedAt?: string;
}

interface QueuedThreadShell {
  readonly latestUserMessageAt?: string | null;
  readonly latestTurn?: SettlementRunLike | null;
  readonly latestRun?: SettlementRunLike | null;
  readonly session?: SettlementRuntimeLike | null;
  readonly runtime?: SettlementRuntimeLike | null;
}

/**
 * Failed starts and stale shells from older servers can leave user messages unadopted.
 * Bound the pending window so those threads can eventually settle.
 */
export const QUEUED_TURN_START_GRACE_MS = 2 * 60 * 1_000;
const DAY_MS = 24 * 60 * 60 * 1_000;

export function hasQueuedTurnStart(
  shell: QueuedThreadShell,
  options: { readonly now: string },
): boolean {
  if (
    shell.runtime?.status === "preparing" ||
    shell.runtime?.status === "queued" ||
    shell.runtime?.status === "starting"
  ) {
    return true;
  }
  if (shell.latestUserMessageAt == null) return false;
  if (shell.session?.status === "error") return false;
  const messageAt = Date.parse(shell.latestUserMessageAt);
  if (Number.isNaN(messageAt)) return false;
  const nowMs = Date.parse(options.now);
  if (Number.isNaN(nowMs)) return false;
  // Bounded on both sides: message timestamps originate on whichever device
  // sent the message, so a clock ahead of this one yields a negative age
  // that would otherwise hold the queued state for the whole skew. Mirrors
  // the decider's guard.
  if (Math.abs(nowMs - messageAt) > QUEUED_TURN_START_GRACE_MS) return false;
  const turn = shell.latestRun ?? shell.latestTurn ?? null;
  if (turn === null) return true;
  return [turn.requestedAt, turn.startedAt, turn.completedAt].every(
    (candidate) => candidate == null || Date.parse(candidate) < messageAt,
  );
}

export interface ThreadSnoozeShell extends QueuedThreadShell {
  readonly source?: Pick<EnvironmentThreadShell["source"], "pendingRuntimeRequest">;
  readonly snoozedUntil?: string | null;
  readonly snoozedAt?: string | null;
  readonly hasPendingApprovals: boolean;
  readonly hasPendingUserInput: boolean;
  readonly pendingUserInputAt?: string | null;
  readonly pendingSubagentRequest?: PendingSubagentRequest | null;
  readonly pendingGuestMessageCount?: number;
  /** What the thread is parked on; a seen, parked thread sits in the Snoozed shelf. */
  readonly parkedWaits?: ReadonlyArray<OrchestrationV2ParkedWait> | undefined;
  readonly lastVisitedAt?: string | null | undefined;
}

function pendingQuestionAt(shell: ThreadSnoozeShell): string | null {
  const request = shell.source?.pendingRuntimeRequest;
  return (
    shell.pendingUserInputAt ??
    (request?.kind === "user_input" ? DateTime.formatIso(request.createdAt) : null)
  );
}

/**
 * Only a request for the user or a fresh failure ends a snooze early. Completed runs never do:
 * a snoozed long-running thread keeps waking itself for background work and stays hidden
 * until its timer.
 */
export function threadRaisedHandWhileSnoozed(shell: ThreadSnoozeShell): boolean {
  const request = shell.source?.pendingRuntimeRequest;
  if (shell.hasPendingApprovals || (request != null && request.kind !== "user_input")) return true;
  const questionAt = pendingQuestionAt(shell);
  // Snoozing an existing question means "ask me later". Only a new question
  // wakes it early; missing or invalid timestamps keep the request visible.
  if (
    (shell.hasPendingUserInput || request?.kind === "user_input") &&
    (shell.snoozedAt == null ||
      questionAt == null ||
      !(Date.parse(questionAt) <= Date.parse(shell.snoozedAt)))
  ) {
    return true;
  }
  if (shell.pendingSubagentRequest != null) return true;
  if ((shell.pendingGuestMessageCount ?? 0) > 0) return true;
  const failedAt = failureEdgeAt(shell);
  return (
    failedAt !== undefined &&
    (shell.snoozedAt == null ||
      (failedAt != null && Date.parse(failedAt) > Date.parse(shell.snoozedAt)))
  );
}

// V2 runtime.updatedAt includes metadata writes, not just failures.
// Legacy sessions only expose the runtime timestamp.
function failureEdgeAt(shell: ThreadSnoozeShell): string | null | undefined {
  const runtime = shell.runtime ?? shell.session ?? null;
  if (runtime?.status !== "error" && runtime?.status !== "failed") return undefined;
  const latestRun = shell.latestRun ?? shell.latestTurn ?? null;
  if (latestRun?.status === "failed") {
    return latestRun.completedAt ?? null;
  }
  return runtime.updatedAt ?? null;
}

export function canSnooze(
  shell: Pick<
    ThreadSnoozeShell,
    | "hasPendingApprovals"
    | "hasPendingUserInput"
    | "pendingSubagentRequest"
    | "pendingGuestMessageCount"
    | "latestUserMessageAt"
    | "latestTurn"
    | "latestRun"
    | "session"
    | "runtime"
    | "source"
  >,
  options: { readonly now: string },
): boolean {
  if (shell.hasPendingApprovals) return false;
  const request = shell.source?.pendingRuntimeRequest;
  if (request != null && request.kind !== "user_input") return false;
  if (shell.pendingSubagentRequest != null) return false;
  // A waiting guest message would wake it at once.
  if ((shell.pendingGuestMessageCount ?? 0) > 0) return false;
  if (hasQueuedTurnStart(shell, options)) return false;
  return true;
}

const ACTIVE_RUN_STATUSES = new Set(["preparing", "queued", "starting", "running", "waiting"]);

/**
 * A parked thread reads Done until it is opened, then joins the Snoozed shelf until its wait ends.
 * Derived from the server's `parkedWaits`, never by writing `snoozedUntil`. A request for the
 * person, a fresh failure or a running turn keeps it where it is.
 */
export function threadParkedOnShelf(shell: ThreadSnoozeShell): boolean {
  if ((shell.parkedWaits?.length ?? 0) === 0) return false;
  const runtime = shell.runtime ?? shell.session ?? null;
  if (runtime !== null && ACTIVE_RUN_STATUSES.has(runtime.status)) return false;
  if (shell.lastVisitedAt == null) return false;
  const completedAt = Date.parse((shell.latestRun ?? shell.latestTurn)?.completedAt ?? "");
  const visitedAt = Date.parse(shell.lastVisitedAt);
  if (Number.isNaN(visitedAt) || (!Number.isNaN(completedAt) && completedAt > visitedAt)) {
    return false;
  }
  return !threadRaisedHandWhileSnoozed(shell);
}

export function effectiveSnoozed(
  shell: ThreadSnoozeShell,
  options: { readonly now: string },
): boolean {
  if (threadParkedOnShelf(shell)) return true;
  if (shell.snoozedUntil == null) return false;
  const wakeAtMs = Date.parse(shell.snoozedUntil);
  if (Number.isNaN(wakeAtMs)) return false;
  if (wakeAtMs <= Date.parse(options.now)) return false;
  return !threadRaisedHandWhileSnoozed(shell);
}

export function threadWokeAt(
  shell: ThreadSnoozeShell,
  options: { readonly now: string },
): string | null {
  if (shell.snoozedUntil == null) return null;
  const wakeAtMs = Date.parse(shell.snoozedUntil);
  if (Number.isNaN(wakeAtMs)) return null;
  // An early hand-raise wake stays authoritative even after the scheduled
  // wake time passes: reporting snoozedUntil then would resurface a Woke
  // indicator the user already cleared by visiting (snoozedUntil is newer
  // than that visit's lastVisitedAt).
  if (threadRaisedHandWhileSnoozed(shell)) {
    const failedAt = failureEdgeAt(shell);
    const questionAt = pendingQuestionAt(shell);
    const freshFailure =
      failedAt != null &&
      (shell.snoozedAt == null || Date.parse(failedAt) > Date.parse(shell.snoozedAt));
    const freshQuestion =
      questionAt != null &&
      shell.snoozedAt != null &&
      Date.parse(questionAt) > Date.parse(shell.snoozedAt);
    if (freshFailure && (!freshQuestion || Date.parse(failedAt) >= Date.parse(questionAt))) {
      return failedAt;
    }
    if (freshQuestion) return questionAt;
    const runtime = shell.runtime ?? shell.session ?? null;
    return runtime?.updatedAt ?? shell.snoozedAt ?? null;
  }
  return wakeAtMs <= Date.parse(options.now) ? shell.snoozedUntil : null;
}

const HOUR_MS = 60 * 60 * 1_000;

/** When a parked wait ends by itself: it gives up, or a time wait wakes. */
function parkedWaitEndsAt(wait: OrchestrationV2ParkedWait): string | null {
  return wait.givesUpAt ?? (wait.target.kind === "time" ? wait.target.at : null);
}

/** The wait that ends first: what the shelf and the sort show for a thread parked on several. */
function nextParkedWait(
  waits: ReadonlyArray<OrchestrationV2ParkedWait> | undefined,
): OrchestrationV2ParkedWait | null {
  let next: OrchestrationV2ParkedWait | null = null;
  let nextMs = Number.POSITIVE_INFINITY;
  for (const wait of waits ?? []) {
    const endsAt = parkedWaitEndsAt(wait);
    const endsMs = endsAt === null ? Number.POSITIVE_INFINITY : Date.parse(endsAt);
    if (next === null || endsMs < nextMs) {
      next = wait;
      nextMs = Number.isNaN(endsMs) ? Number.POSITIVE_INFINITY : endsMs;
    }
  }
  return next;
}

/** Whole minutes, hours or days, rounded up to the unit a person reads: "20m", "2h", "3d". */
function formatParkedSpan(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.round(hours / 24)}d`;
}

function formatParkedSpanLong(ms: number): string {
  const minutes = Math.max(1, Math.round(ms / 60_000));
  if (minutes < 60) return minutes === 1 ? "1 minute" : `${minutes} minutes`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return hours === 1 ? "1 hour" : `${hours} hours`;
  const days = Math.round(hours / 24);
  return days === 1 ? "1 day" : `${days} days`;
}

/** "Thu 14:00" within the coming week, a date beyond it. */
function formatParkedMoment(iso: string, nowMs: number): string {
  const atMs = Date.parse(iso);
  if (Number.isNaN(atMs)) return iso;
  const time = { hour: "2-digit", minute: "2-digit", hour12: false } as const;
  const options: Intl.DateTimeFormatOptions =
    Math.abs(atMs - nowMs) < 6 * DAY_MS
      ? { weekday: "short", ...time }
      : { month: "short", day: "numeric", ...time };
  return new Intl.DateTimeFormat(undefined, options).format(atMs);
}

export type ParkedWaitKindLabel = "Release" | "Time" | "Thread" | "Forge" | "Landing";

export function parkedWaitKindLabel(wait: OrchestrationV2ParkedWait): ParkedWaitKindLabel {
  switch (wait.target.kind) {
    case "production":
      return "Release";
    case "time":
      return "Time";
    case "thread":
      return "Thread";
    case "build_item":
      return "Forge";
    case "landing":
      return "Landing";
  }
}

/**
 * What the wait wakes on, in a sentence. `title` names the subject (such as a ticket key or
 * a build number); a time wait names its moment and what to do then.
 */
export function parkedWaitWakesOn(wait: OrchestrationV2ParkedWait, nowMs: number): string {
  switch (wait.target.kind) {
    case "production":
      return `Wakes when ${wait.title} reaches Production`;
    case "time":
      return `Wakes ${formatParkedMoment(wait.target.at, nowMs)} to ${wait.title}`;
    case "thread":
      return `Wakes when ${wait.title} finishes`;
    case "build_item":
      return wait.target.until === "unblocked"
        ? `Wakes when ${wait.title} is unblocked`
        : `Wakes when ${wait.title} is landed or accepted`;
    case "landing":
      return `Wakes when the landing of ${wait.title} has an outcome`;
  }
}

/** The panel's quiet facts: "Parked 2h", "expected within 1 day", "gives up Thu 14:00". */
export function parkedWaitFacts(wait: OrchestrationV2ParkedWait, nowMs: number): string[] {
  const startedMs = Date.parse(wait.startedAt);
  const facts = [`Parked ${formatParkedSpan(Math.max(0, nowMs - startedMs))}`];
  if (wait.target.kind === "time") {
    const atMs = Date.parse(wait.target.at);
    facts.push(atMs > nowMs ? `in ${formatParkedSpan(atMs - nowMs)}` : "waking now");
    return facts;
  }
  if (wait.expectedAt !== undefined) {
    facts.push(`expected within ${formatParkedSpanLong(Date.parse(wait.expectedAt) - startedMs)}`);
  }
  if (wait.givesUpAt !== undefined) {
    facts.push(`gives up ${formatParkedMoment(wait.givesUpAt, nowMs)}`);
  }
  return facts;
}

/** The sidebar's time slot for a parked thread: "gives up in 22h", or "in 18h" for a time wait. */
export function parkedWaitTimeLeft(
  waits: ReadonlyArray<OrchestrationV2ParkedWait> | undefined,
  nowMs: number,
): string | null {
  const wait = nextParkedWait(waits);
  const endsAt = wait === null ? null : parkedWaitEndsAt(wait);
  if (wait === null || endsAt === null) return null;
  const left = Date.parse(endsAt) - nowMs;
  if (Number.isNaN(left)) return null;
  const span = left <= 0 ? "now" : `in ${formatParkedSpan(left)}`;
  return wait.target.kind === "time" ? span : `gives up ${span}`;
}

const WEEKDAY_INDEX = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
} as const;

export interface SnoozePreset {
  readonly id: string;
  readonly label: string;
  readonly whenLabel: string;
  readonly snoozedUntil: string;
}

export interface SnoozePresetOptions {
  readonly presets?: ReadonlyArray<SnoozePresetSetting>;
  readonly formatTime?: (date: Date) => string;
}

function snoozeTimeOfDayLabel(date: Date): string {
  return date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
}

// Calendar-day advance instead of adding DAY_MS: fixed millisecond offsets
// land on the wrong local day across DST transitions (a spring-forward day
// is 23 hours, so 23:30 + 24h skips the whole next day).
function addSnoozeDays(base: Date, days: number): Date {
  const next = DateTime.toDate(DateTime.makeUnsafe(base));
  next.setDate(next.getDate() + days);
  return next;
}

function pluralize(count: number, unit: string): string {
  return `${count} ${unit}${count === 1 ? "" : "s"}`;
}

/** "3 hours", "90 minutes", "2 days": the largest unit that divides evenly. */
function formatSnoozeDuration(minutes: number): string {
  if (minutes % (24 * 60) === 0) return pluralize(minutes / (24 * 60), "day");
  if (minutes % 60 === 0) return pluralize(minutes / 60, "hour");
  return pluralize(minutes, "minute");
}

function capitalize(word: string): string {
  return word[0]!.toUpperCase() + word.slice(1);
}

function snoozePresetDaysAhead(
  setting: Extract<SnoozePresetSetting, { kind: "at" }>,
  now: Date,
): number {
  if (setting.day === "today") return 0;
  if (setting.day === "tomorrow") return 1;
  return (WEEKDAY_INDEX[setting.day] - now.getDay() + 7) % 7 || 7;
}

/** Labels follow the actual day gap, so a Monday option on a Sunday reads "Tomorrow". */
function snoozePresetLabel(setting: SnoozePresetSetting, daysAhead: number): string {
  if (setting.kind === "after") return `In ${formatSnoozeDuration(setting.minutes)}`;
  if (daysAhead === 0) {
    const hour = Number(setting.time.slice(0, 2));
    return hour < 12 ? "This morning" : hour < 17 ? "This afternoon" : "This evening";
  }
  if (daysAhead === 1) return "Tomorrow";
  if (setting.day === "monday") return "Next week";
  return daysAhead === 7 ? `Next ${capitalize(setting.day)}` : capitalize(setting.day);
}

export function snoozePresetId(setting: SnoozePresetSetting): string {
  return setting.kind === "after"
    ? `after:${setting.minutes}`
    : `at:${setting.day}:${setting.time}`;
}

export function resolveSnoozePreset(
  setting: SnoozePresetSetting,
  now: Date,
  formatTime: (date: Date) => string = snoozeTimeOfDayLabel,
): SnoozePreset | null {
  let wake: Date;
  let daysAhead = 0;
  if (setting.kind === "after") {
    wake = DateTime.toDate(DateTime.makeUnsafe(now.getTime() + setting.minutes * 60_000));
  } else {
    daysAhead = snoozePresetDaysAhead(setting, now);
    wake = addSnoozeDays(now, daysAhead);
    wake.setHours(Number(setting.time.slice(0, 2)), Number(setting.time.slice(3)), 0, 0);
    // A today option whose time has passed is left out until tomorrow.
    if (wake.getTime() <= now.getTime()) return null;
  }
  const label = snoozePresetLabel(setting, daysAhead);
  // Durations and "Next week" don't name the wake day, so a wake on another day shows it.
  const labelNamesDay = setting.kind === "at" && label !== "Next week";
  const time = formatTime(wake);
  return {
    id: snoozePresetId(setting),
    label,
    whenLabel:
      labelNamesDay || wake.toDateString() === now.toDateString()
        ? time
        : `${wake.toLocaleDateString(undefined, { weekday: "short" })} ${time}`,
    snoozedUntil: wake.toISOString(),
  };
}

/** The snooze menu: soonest first, one row per wake minute. */
export function resolveSnoozePresets(
  now: Date,
  options: SnoozePresetOptions = {},
): ReadonlyArray<SnoozePreset> {
  // By minute, so a duration (which keeps the clock's seconds) and a set time in the same
  // minute tie, and the stable sort keeps whichever comes first in settings.
  const wakeMinute = (preset: SnoozePreset) => Math.floor(Date.parse(preset.snoozedUntil) / 60_000);
  const seen = new Set<number>();
  return (
    (options.presets ?? DEFAULT_SNOOZE_PRESETS)
      .flatMap((setting) => resolveSnoozePreset(setting, now, options.formatTime) ?? [])
      // flatMap returned a new array; Hermes has no `toSorted`.
      .sort((a, b) => wakeMinute(a) - wakeMinute(b))
      .filter((preset) => {
        if (seen.has(wakeMinute(preset))) return false;
        seen.add(wakeMinute(preset));
        return true;
      })
  );
}

/**
 * A menu choice as picked. A duration re-resolves from its setting (not the deduped menu) so it
 * starts at selection. A set time keeps the shown wake, which a day change would otherwise shift.
 */
export function pickSnoozePreset(input: {
  readonly shown: ReadonlyArray<SnoozePreset>;
  readonly id: string;
  readonly now: Date;
  readonly presets?: ReadonlyArray<SnoozePresetSetting>;
  readonly formatTime?: (date: Date) => string;
}): SnoozePreset | undefined {
  const original = input.shown.find((preset) => preset.id === input.id);
  const ahead =
    original && Date.parse(original.snoozedUntil) > input.now.getTime() ? original : undefined;
  const setting = (input.presets ?? DEFAULT_SNOOZE_PRESETS).find(
    (candidate) => candidate.kind === "after" && snoozePresetId(candidate) === input.id,
  );
  return (setting && resolveSnoozePreset(setting, input.now, input.formatTime)) ?? ahead;
}

export function snoozeWakeLabel(snoozedUntil: string, options: { readonly now: string }): string {
  const wakeMs = Date.parse(snoozedUntil);
  const nowMs = Date.parse(options.now);
  if (Number.isNaN(wakeMs) || Number.isNaN(nowMs)) return "now";
  const remainingMs = wakeMs - nowMs;
  if (remainingMs <= 0) return "now";
  if (remainingMs < HOUR_MS) return `${Math.max(1, Math.ceil(remainingMs / 60_000))}m`;
  if (remainingMs < DAY_MS) return `${Math.ceil(remainingMs / HOUR_MS)}h`;
  return `${Math.ceil(remainingMs / DAY_MS)}d`;
}

export type CustomSnoozeInput =
  | { readonly mode: "date"; readonly date: string; readonly time: string }
  | {
      readonly mode: "duration";
      readonly amount: string;
      readonly unit: "minutes" | "hours" | "days";
    };

export function resolveCustomSnooze(input: CustomSnoozeInput, now: Date): string | null {
  let wake: Date;
  if (input.mode === "duration") {
    const amount = Number(input.amount);
    if (!Number.isFinite(amount) || amount <= 0) return null;
    const unitMs = { minutes: 60_000, hours: HOUR_MS, days: 24 * HOUR_MS }[input.unit];
    wake = new Date(now.getTime() + amount * unitMs);
  } else {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(input.date) || !/^\d{2}:\d{2}$/.test(input.time)) return null;
    wake = new Date(`${input.date}T${input.time}:00`);
    // Reject rolled-over dates and nonexistent local times during DST changes.
    if (localSnoozeDate(wake) !== input.date || localSnoozeTime(wake) !== input.time) return null;
  }
  return Number.isFinite(wake.getTime()) && wake.getTime() > now.getTime()
    ? wake.toISOString()
    : null;
}

export function localSnoozeDate(date: Date): string {
  return `${String(date.getFullYear()).padStart(4, "0")}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
}

export function localSnoozeTime(date: Date): string {
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/**
 * Whether a woken thread woke after the user last saw it. A run that completed
 * after the last visit counts as seeing it, since the user watched it finish.
 */
export function isThreadWokeUnseen(input: {
  readonly wokeAt: string | null;
  readonly settled: boolean;
  readonly lastVisitedAt: string | null | undefined;
  readonly latestRunCompletedAt: string | null;
}): boolean {
  if (input.wokeAt === null || input.settled) return false;
  const wokeAtMs = Date.parse(input.wokeAt);
  if (Number.isNaN(wokeAtMs)) return false;
  const seenAt = [input.lastVisitedAt, input.latestRunCompletedAt]
    .map((value) => (value ? Date.parse(value) : NaN))
    .filter((ms) => !Number.isNaN(ms));
  return seenAt.every((ms) => ms < wokeAtMs);
}

/** The line under a parked thread's title: what it wakes on, for the soonest-ending wait. */
export function parkedThreadSubtitle(
  waits: ReadonlyArray<OrchestrationV2ParkedWait> | undefined,
  nowMs: number,
): string | null {
  const wait = nextParkedWait(waits);
  return wait === null ? null : parkedWaitWakesOn(wait, nowMs);
}

/** When a thread leaves the Snoozed shelf by itself: its snooze ends, or its parked wait does. */
export function snoozeShelfEndsAt(shell: ThreadSnoozeShell): string | null {
  const parked = nextParkedWait(shell.parkedWaits);
  return parked === null ? (shell.snoozedUntil ?? null) : parkedWaitEndsAt(parked);
}
