import {
  championFindingIsClosed,
  championNeedsAttention,
  type ChampionReading,
  championStatus,
  type ChampionStatus,
  formatChampionValue,
  pendingChampionDecision,
} from "@t3tools/client-runtime/champions";
import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import {
  EnvironmentId,
  type ChampionActivity,
  type ChampionFinding,
  type ChampionId,
  type ChampionMetric,
  type ChampionMetricInput,
  type ChampionProposal,
  type ChampionSample,
  type ChampionSummary,
  type ModelSelection,
} from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { isProviderUsageExhausted } from "@t3tools/shared/providerPools";

import type { ProviderInstanceEntry } from "../../providerInstances";

export type ChampionsView = "new" | "edit" | "metrics";

export function validateChampionsSearch(raw: Record<string, unknown>) {
  const environmentId =
    typeof raw.environmentId === "string" && raw.environmentId.trim()
      ? EnvironmentId.make(raw.environmentId)
      : undefined;
  const id = typeof raw.id === "string" && raw.id.trim() ? raw.id.trim() : undefined;
  const view: ChampionsView | undefined =
    raw.view === "new"
      ? "new"
      : (raw.view === "edit" || raw.view === "metrics") && environmentId && id
        ? raw.view
        : undefined;
  return {
    ...(environmentId && id ? { environmentId, id } : {}),
    ...(view ? { view } : {}),
  };
}

export interface ChampionEntry {
  readonly environmentId: EnvironmentId;
  readonly champion: ChampionSummary;
}

const HEALTH_RANK: Record<ChampionStatus, number> = {
  review: 0,
  attention: 1,
  "setting-up": 2,
  working: 3,
  checking: 4,
  "off-target": 5,
  unknown: 6,
  stale: 7,
  unmeasured: 8,
  healthy: 9,
  paused: 10,
  retired: 11,
};

export function orderChampions(
  entries: ReadonlyArray<ChampionEntry>,
  nowMs: number,
): ChampionEntry[] {
  return entries.toSorted(
    (a, b) =>
      HEALTH_RANK[championStatus(a.champion, nowMs)] -
        HEALTH_RANK[championStatus(b.champion, nowMs)] ||
      a.champion.name.localeCompare(b.champion.name) ||
      a.environmentId.localeCompare(b.environmentId),
  );
}

export function championsNeedingAttention(entries: ReadonlyArray<ChampionEntry>): number {
  return entries.filter((entry) => championNeedsAttention(entry.champion)).length;
}

export type ChampionSelection =
  | { readonly kind: "none" }
  | { readonly kind: "found"; readonly entry: ChampionEntry }
  | { readonly kind: "missing"; readonly environmentId: EnvironmentId; readonly id: ChampionId };

export function resolveChampionSelection(
  ordered: ReadonlyArray<ChampionEntry>,
  target: { readonly environmentId?: EnvironmentId | undefined; readonly id?: string | undefined },
  options: { readonly openFirst: boolean },
): ChampionSelection {
  if (target.environmentId !== undefined && target.id !== undefined) {
    const entry = ordered.find(
      (candidate) =>
        candidate.environmentId === target.environmentId && candidate.champion.id === target.id,
    );
    return entry
      ? { kind: "found", entry }
      : { kind: "missing", environmentId: target.environmentId, id: target.id };
  }
  const first = options.openFirst ? ordered[0] : undefined;
  return first ? { kind: "found", entry: first } : { kind: "none" };
}

const samplesOf = (metric: ChampionMetric, samples: ReadonlyArray<ChampionSample>) =>
  samples
    .filter(
      (sample) =>
        sample.metricId === metric.id &&
        sample.seriesId === metric.seriesId &&
        sample.unit === metric.unit,
    )
    .toSorted(compareSamples);

const compareSamples = (a: ChampionSample, b: ChampionSample) =>
  a.observedAt.localeCompare(b.observedAt) || a.collectedAt.localeCompare(b.collectedAt);

export function readingFreshness(
  reading: ChampionReading,
  lifecycle: ChampionSummary["lifecycle"],
): { readonly prefix: string; readonly at: string } | null {
  if (reading.kind === "measured" && reading.observedAt !== null) {
    return {
      prefix: lifecycle === "active" && reading.health !== "stale" ? "" : "As of",
      at: reading.observedAt,
    };
  }
  if (reading.kind === "unmeasured" && reading.observedAt !== null) {
    return { prefix: "Checked", at: reading.observedAt };
  }
  return null;
}

export function metricTargetLabel(metric: ChampionMetricInput): string {
  if (metric.direction === "observe") return "Observed only";
  const { minimum, maximum, unit } = metric;
  if (minimum !== null && maximum !== null) {
    return `${formatChampionValue(minimum, unit)} to ${formatChampionValue(maximum, unit)}`;
  }
  if (maximum !== null) return `≤ ${formatChampionValue(maximum, unit)}`;
  if (minimum !== null) return `≥ ${formatChampionValue(minimum, unit)}`;
  return "No target yet";
}

export function metricIsOffTarget(metric: ChampionMetricInput, value: number): boolean {
  if (metric.direction === "observe") return false;
  return (
    (metric.minimum !== null && value < metric.minimum) ||
    (metric.maximum !== null && value > metric.maximum)
  );
}

export interface MetricTrend {
  readonly direction: "up" | "down" | "steady";
  readonly judgement: "better" | "worse" | null;
}

const TREND_WINDOW = 3;
const STEADY_RATIO = 0.05;

export function metricTrend(
  metric: ChampionMetric,
  samples: ReadonlyArray<ChampionSample>,
): MetricTrend | null {
  const series = samplesOf(metric, samples);
  const latest = series.at(-1);
  if (latest === undefined || latest.value === null || latest.status !== "measured") return null;
  const previous = series
    .slice(0, -1)
    .flatMap((sample) => (sample.status === "measured" && sample.value !== null ? [sample] : []))
    .slice(-TREND_WINDOW);
  if (previous.length < TREND_WINDOW) return null;
  const mean = previous.reduce((sum, sample) => sum + (sample.value ?? 0), 0) / previous.length;
  const change = mean === 0 ? latest.value - mean : (latest.value - mean) / Math.abs(mean);
  if (Math.abs(change) < STEADY_RATIO) return { direction: "steady", judgement: null };
  const direction = change > 0 ? "up" : "down";
  if (metric.direction === "higher") {
    return { direction, judgement: direction === "up" ? "better" : "worse" };
  }
  if (metric.direction === "lower") {
    return { direction, judgement: direction === "down" ? "better" : "worse" };
  }
  return { direction, judgement: null };
}

export interface MetricSeriesView {
  readonly seriesId: string;
  readonly current: boolean;
  readonly definitions: ReadonlyArray<ChampionMetric>;
  readonly samples: ReadonlyArray<ChampionSample>;
}

export function metricSeries(
  metric: ChampionMetric,
  definitions: ReadonlyArray<ChampionMetric>,
  samples: ReadonlyArray<ChampionSample>,
): MetricSeriesView[] {
  const known = new Map<string, ChampionMetric[]>([[metric.seriesId, [metric]]]);
  for (const definition of definitions) {
    if (definition.id !== metric.id) continue;
    const group = known.get(definition.seriesId) ?? [];
    if (!group.some((candidate) => candidate.version === definition.version)) {
      group.push(definition);
    }
    known.set(definition.seriesId, group);
  }
  const sampled = new Map<string, ChampionSample[]>();
  for (const sample of samples) {
    if (sample.metricId !== metric.id) continue;
    sampled.set(sample.seriesId, [...(sampled.get(sample.seriesId) ?? []), sample]);
  }
  const ids = new Set([...known.keys(), ...sampled.keys()]);
  const views = [...ids].map((seriesId) => ({
    seriesId,
    current: seriesId === metric.seriesId,
    definitions: (known.get(seriesId) ?? []).toSorted((a, b) => b.version - a.version),
    samples: (sampled.get(seriesId) ?? []).toSorted(compareSamples),
  }));
  const newest = (view: MetricSeriesView) =>
    view.definitions[0]?.version ?? Number.NEGATIVE_INFINITY;
  return views.toSorted((a, b) => Number(b.current) - Number(a.current) || newest(b) - newest(a));
}

export function retiredMetrics(
  metrics: ReadonlyArray<ChampionMetric>,
  definitions: ReadonlyArray<ChampionMetric>,
): ChampionMetric[] {
  const live = new Set(metrics.map((metric) => metric.id));
  const newestById = new Map<string, ChampionMetric>();
  for (const definition of definitions) {
    if (live.has(definition.id)) continue;
    const seen = newestById.get(definition.id);
    if (seen === undefined || seen.version < definition.version) {
      newestById.set(definition.id, definition);
    }
  }
  return [...newestById.values()].toSorted((a, b) => a.name.localeCompare(b.name));
}

export interface SparklineGeometry {
  readonly segments: ReadonlyArray<string>;
  readonly end: { readonly x: number; readonly y: number } | null;
}

export function sparklineGeometry(
  points: ReadonlyArray<number | null>,
  width: number,
  height: number,
): SparklineGeometry {
  const values = points.filter((point): point is number => point !== null);
  if (values.length === 0) return { segments: [], end: null };
  const low = Math.min(...values);
  const span = Math.max(...values) - low || 1;
  const steps = Math.max(points.length - 1, 1);
  const pad = 3;
  const xOf = (index: number) => pad + ((width - pad * 2) * index) / steps;
  const yOf = (value: number) => pad + (height - pad * 2) * (1 - (value - low) / span);
  const segments: string[] = [];
  let current: string[] = [];
  points.forEach((point, index) => {
    if (point === null) {
      if (current.length > 0) segments.push(current.join(" "));
      current = [];
      return;
    }
    const prefix = current.length === 0 ? "M" : "L";
    current.push(`${prefix}${xOf(index).toFixed(1)} ${yOf(point).toFixed(1)}`);
  });
  if (current.length > 0) segments.push(current.join(" "));
  const last = points.at(-1);
  return {
    segments,
    end: last === null || last === undefined ? null : { x: xOf(points.length - 1), y: yOf(last) },
  };
}

export interface ChampionHistoryPage {
  readonly findings: ReadonlyArray<ChampionFinding>;
  readonly definitions: ReadonlyArray<ChampionMetric>;
  readonly activity: ReadonlyArray<ChampionActivity>;
  readonly samples: ReadonlyArray<ChampionSample>;
}

export function mergeHistoryPages(pages: ReadonlyArray<ChampionHistoryPage>): ChampionHistoryPage {
  const activity = new Map<string, ChampionActivity>();
  const samples = new Map<string, ChampionSample>();
  const definitions = new Map<string, ChampionMetric>();
  const findings = new Map<string, ChampionFinding>();
  for (const page of pages) {
    for (const finding of page.findings) findings.set(finding.id, finding);
    for (const entry of page.activity) activity.set(entry.id, entry);
    for (const sample of page.samples) samples.set(`${sample.checkId}:${sample.metricId}`, sample);
    for (const definition of page.definitions) {
      definitions.set(`${definition.id}:${definition.version}`, definition);
    }
  }
  return {
    findings: [...findings.values()],
    activity: [...activity.values()].toSorted((a, b) => b.at.localeCompare(a.at)),
    samples: [...samples.values()],
    definitions: [...definitions.values()],
  };
}

export type ChampionActivityEntry =
  | {
      readonly kind: "finding";
      readonly finding: ChampionFinding;
      readonly events: ReadonlyArray<ChampionActivity>;
      /** Paged out of the champion's document, so the server can no longer act on it. */
      readonly archived: boolean;
    }
  | { readonly kind: "event"; readonly event: ChampionActivity };

export interface ChampionActivityView {
  readonly entries: ReadonlyArray<ChampionActivityEntry>;
  readonly quiet: ReadonlyArray<ChampionActivity>;
}

export function championActivityView(
  current: ReadonlyArray<ChampionFinding>,
  activity: ReadonlyArray<ChampionActivity>,
  paged: ReadonlyArray<ChampionFinding> = [],
): ChampionActivityView {
  const currentIds = new Set(current.map((finding) => finding.id));
  const archived = paged.filter((finding) => !currentIds.has(finding.id));
  const findingIds = new Set([...currentIds, ...archived.map((finding) => finding.id)]);
  const eventsByFinding = new Map<string, ChampionActivity[]>();
  const events: ChampionActivity[] = [];
  const quiet: ChampionActivity[] = [];
  for (const event of activity) {
    if (event.findingId !== null && findingIds.has(event.findingId)) {
      eventsByFinding.set(event.findingId, [
        ...(eventsByFinding.get(event.findingId) ?? []),
        event,
      ]);
    } else if (event.kind === "check-reported") {
      quiet.push(event);
    } else if (event.kind !== "check-started") {
      events.push(event);
    }
  }
  const findingEntry = (finding: ChampionFinding, isArchived: boolean) => ({
    at: finding.updatedAt,
    entry: {
      kind: "finding" as const,
      finding,
      archived: isArchived,
      events: (eventsByFinding.get(finding.id) ?? []).toSorted((a, b) => b.at.localeCompare(a.at)),
    },
  });
  const timed: Array<{ readonly at: string; readonly entry: ChampionActivityEntry }> = [
    ...current.map((finding) => findingEntry(finding, false)),
    ...archived.map((finding) => findingEntry(finding, true)),
    ...events.map((event) => ({ at: event.at, entry: { kind: "event" as const, event } })),
  ];
  const rank = (entry: ChampionActivityEntry) => {
    if (entry.kind !== "finding") return 0;
    if (pendingChampionDecision(entry.finding) !== null) return 2;
    return championFindingIsClosed(entry.finding) ? 0 : 1;
  };
  return {
    entries: timed
      .toSorted((a, b) => rank(b.entry) - rank(a.entry) || b.at.localeCompare(a.at))
      .map((item) => item.entry),
    quiet: quiet.toSorted((a, b) => b.at.localeCompare(a.at)),
  };
}

const ACTIVITY_TITLES: Readonly<Record<string, string>> = {
  configuration: "Settings changed",
  lifecycle: "Status changed",
  "check-retry": "Check retried",
  "dispatch-unavailable": "A run couldn't start",
  "metric-proposal": "Metrics proposed",
  "metrics-accepted": "Metrics accepted",
  dismiss: "Finding dismissed",
  reopen: "Finding reopened",
  decision: "Decision requested",
  resolve_decision: "Decision answered",
  "proposal-discarded": "Proposal discarded",
  "setup-cancelled": "Setup cancelled",
  "setup-completed": "Metrics reviewed, no change",
  "repair-phase-reserved": "Repair reserved",
  "finding-handed_back": "Ready to integrate",
  "finding-opened": "Finding opened",
  "finding-working": "Repair running",
  "finding-delivered": "Repair delivered",
  "finding-verified": "Verified",
  "finding-inconclusive": "Inconclusive",
  "finding-open": "Finding reopened",
  "finding-dismissed": "Finding dismissed",
};

export function activityTitle(kind: string): string {
  const known = ACTIVITY_TITLES[kind];
  if (known) return known;
  const words = kind.replace(/[-_]+/g, " ").trim();
  return words ? `${words.charAt(0).toUpperCase()}${words.slice(1)}` : "Activity";
}

/** A genuine web link from a report, or null: agent-reported text must not become a script URL. */
export function safeExternalUrl(value: string | null): string | null {
  if (value === null) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

export interface MetricDraft {
  readonly key: string;
  /** Empty until first saved; an accepted metric keeps its id so its series can continue. */
  readonly id: string;
  readonly name: string;
  readonly description: string;
  readonly unit: string;
  readonly source: string;
  readonly context: string;
  readonly direction: ChampionMetricInput["direction"];
  readonly minimum: string;
  readonly maximum: string;
  readonly required: boolean;
  readonly baseline: string;
  readonly staleAfterHours: string;
}

const HOUR_MS = 60 * 60 * 1000;

export function metricDraftOf(metric: ChampionMetricInput): MetricDraft {
  return {
    key: metric.id,
    id: metric.id,
    name: metric.name,
    description: metric.description,
    unit: metric.unit,
    source: metric.source,
    context: metric.context,
    direction: metric.direction,
    minimum: metric.minimum === null ? "" : String(metric.minimum),
    maximum: metric.maximum === null ? "" : String(metric.maximum),
    required: metric.required ?? true,
    baseline: metric.baseline == null ? "" : String(metric.baseline),
    staleAfterHours: metric.staleAfterMs === undefined ? "" : String(metric.staleAfterMs / HOUR_MS),
  };
}

export const emptyMetricDraft = (key: string): MetricDraft => ({
  key,
  id: "",
  name: "",
  description: "",
  unit: "",
  source: "",
  context: "",
  direction: "lower",
  minimum: "",
  maximum: "",
  required: true,
  baseline: "",
  staleAfterHours: "",
});

const parseBound = (value: string): number | null | "invalid" => {
  const trimmed = value.trim();
  if (trimmed === "") return null;
  const parsed = Number(trimmed);
  return Number.isFinite(parsed) ? parsed : "invalid";
};

const slugOf = (value: string) =>
  value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "") || "metric";

export type ParsedMetricDrafts =
  | { readonly ok: true; readonly metrics: ReadonlyArray<ChampionMetricInput> }
  | { readonly ok: false; readonly errors: Readonly<Record<string, string>> };

const MAX_METRICS = 32;

export function parseMetricDrafts(drafts: ReadonlyArray<MetricDraft>): ParsedMetricDrafts {
  const errors: Record<string, string> = {};
  const used = new Set(drafts.flatMap((draft) => (draft.id ? [draft.id] : [])));
  const metrics: ChampionMetricInput[] = [];
  for (const draft of drafts) {
    const minimum = parseBound(draft.minimum);
    const maximum = parseBound(draft.maximum);
    const baseline = parseBound(draft.baseline);
    const staleAfterHours = parseBound(draft.staleAfterHours);
    const staleAfterMs =
      typeof staleAfterHours === "number" ? Math.round(staleAfterHours * HOUR_MS) : null;
    if (!draft.name.trim()) errors[draft.key] = "Name this metric.";
    else if (!draft.unit.trim()) errors[draft.key] = "Give it a unit, such as ms or %.";
    else if (!draft.source.trim()) errors[draft.key] = "Say where the reading comes from.";
    else if (minimum === "invalid" || maximum === "invalid") {
      errors[draft.key] = "Targets must be numbers.";
    } else if (minimum !== null && maximum !== null && minimum > maximum) {
      errors[draft.key] = "The lower target is above the upper one.";
    } else if (baseline === "invalid") {
      errors[draft.key] = "The baseline must be a number.";
    } else if (staleAfterHours === "invalid" || (staleAfterMs !== null && staleAfterMs <= 0)) {
      errors[draft.key] = "Out of date after must be a number of hours above zero.";
    }
    if (
      errors[draft.key] !== undefined ||
      minimum === "invalid" ||
      maximum === "invalid" ||
      baseline === "invalid"
    ) {
      continue;
    }
    let id = draft.id;
    if (!id) {
      const base = slugOf(draft.name);
      id = base;
      for (let suffix = 2; used.has(id); suffix += 1) id = `${base}-${suffix}`;
      used.add(id);
    }
    metrics.push({
      id,
      name: draft.name.trim(),
      description: draft.description,
      unit: draft.unit.trim(),
      source: draft.source.trim(),
      context: draft.context,
      direction: draft.direction,
      minimum,
      maximum,
      required: draft.required,
      baseline,
      ...(staleAfterMs === null ? {} : { staleAfterMs }),
    });
  }
  if (Object.keys(errors).length > 0) return { ok: false, errors };
  if (metrics.length === 0) return { ok: false, errors: { "": "Add at least one metric." } };
  if (metrics.length > MAX_METRICS) {
    return { ok: false, errors: { "": `Keep it to ${MAX_METRICS} metrics or fewer.` } };
  }
  return { ok: true, metrics };
}

export type MetricChange = "new" | "new-series" | "same-series";

/** Mirrors what accepting a proposal does to a series, so the editor can say so beforehand. */
export function metricChange(
  draft: ChampionMetricInput,
  current: ReadonlyArray<ChampionMetric>,
): MetricChange {
  const old = current.find((metric) => metric.id === draft.id);
  if (old === undefined) return "new";
  return old.unit === draft.unit &&
    old.source === draft.source &&
    old.context === draft.context &&
    old.direction === draft.direction
    ? "same-series"
    : "new-series";
}

const inputOf = (metric: ChampionMetricInput): ChampionMetricInput => ({
  id: metric.id,
  name: metric.name,
  description: metric.description,
  unit: metric.unit,
  source: metric.source,
  context: metric.context,
  direction: metric.direction,
  minimum: metric.minimum,
  maximum: metric.maximum,
  required: metric.required ?? true,
  baseline: metric.baseline ?? null,
  ...(metric.staleAfterMs === undefined ? {} : { staleAfterMs: metric.staleAfterMs }),
});

const metricsKey = (metrics: ReadonlyArray<ChampionMetricInput>) =>
  JSON.stringify(metrics.map(inputOf));

export function metricsMatchProposal(
  metrics: ReadonlyArray<ChampionMetricInput>,
  proposal: ChampionProposal | null,
): boolean {
  return proposal !== null && metricsKey(metrics) === metricsKey(proposal.metrics);
}

export const metricInputsOf = (metrics: ReadonlyArray<ChampionMetric>) => metrics.map(inputOf);

function entryIsUsable(entry: ProviderInstanceEntry, nowMs: number): boolean {
  return (
    entry.enabled &&
    entry.installed &&
    entry.isAvailable &&
    entry.status !== "error" &&
    entry.status !== "disabled" &&
    entry.snapshot.availability !== "unavailable" &&
    !isProviderUsageExhausted(entry.snapshot, nowMs) &&
    entry.models.length > 0
  );
}

const defaultModelOf = (entry: ProviderInstanceEntry) =>
  entry.models.find((model) => model.isDefault && !model.isLegacy) ??
  entry.models.find((model) => !model.isLegacy) ??
  entry.models[0];

function suggestModel(
  usable: ReadonlyArray<ProviderInstanceEntry>,
  preferred: RegExp,
): ModelSelection | null {
  for (const entry of usable) {
    const match = entry.models.find(
      (model) => !model.isLegacy && (preferred.test(model.slug) || preferred.test(model.name)),
    );
    if (match) return createModelSelection(entry.instanceId, match.slug);
  }
  const first = usable[0];
  const fallback = first && defaultModelOf(first);
  return first && fallback ? createModelSelection(first.instanceId, fallback.slug) : null;
}

export interface SuggestedChampionModels {
  readonly setup: ModelSelection | null;
  readonly routine: ModelSelection | null;
}

export function suggestChampionModels(
  entries: ReadonlyArray<ProviderInstanceEntry>,
  nowMs: number,
): SuggestedChampionModels {
  const usable = entries.filter((entry) => entryIsUsable(entry, nowMs));
  return { setup: suggestModel(usable, /opus/i), routine: suggestModel(usable, /sonnet/i) };
}

export function modelSelectionProblem(
  selection: ModelSelection | null,
  entries: ReadonlyArray<ProviderInstanceEntry>,
  nowMs: number,
): string | null {
  if (selection === null) return "Choose a model.";
  const entry = entries.find((candidate) => candidate.instanceId === selection.instanceId);
  if (entry === undefined) return "This provider isn't on this machine any more.";
  if (!entry.models.some((model) => model.slug === selection.model)) {
    return "This provider no longer lists the chosen model.";
  }
  if (isProviderUsageExhausted(entry.snapshot, nowMs)) return "This provider is out of usage.";
  return entryIsUsable(entry, nowMs) ? null : "This provider isn't available right now.";
}

export interface PickedChampionModel {
  readonly environmentId: EnvironmentId;
  readonly selection: ModelSelection;
}

/**
 * Instance ids repeat across machines, so a pick made for one must not pass as valid on another.
 * It stays visible and flagged until replaced; only a suggestion follows the machine.
 */
export function resolveChampionModel(input: {
  readonly picked: PickedChampionModel | null;
  readonly suggested: ModelSelection | null;
  readonly environmentId: EnvironmentId;
}): { readonly selection: ModelSelection | null; readonly fromOtherMachine: boolean } {
  if (input.picked === null) return { selection: input.suggested, fromOtherMachine: false };
  return {
    selection: input.picked.selection,
    fromOtherMachine: input.picked.environmentId !== input.environmentId,
  };
}

const WORDS_IN_DERIVED_NAME = 5;

export function deriveChampionName(purpose: string): string {
  const words = purpose.trim().split(/\s+/).filter(Boolean);
  if (words.length === 0) return "";
  const name = words
    .slice(0, WORDS_IN_DERIVED_NAME)
    .join(" ")
    .replace(/[.,;:!?]+$/, "");
  return words.length > WORDS_IN_DERIVED_NAME ? `${name}…` : name;
}

export interface ChampionMachineGap {
  /** Still trying on its own, as opposed to needing the person to reconnect it. */
  readonly waiting: boolean;
  readonly status: string;
  readonly title: string;
  readonly notice: string;
}

/** Saved machines that should report champions but can't right now. "available" was never joined. */
export function championMachineGap(
  environments: ReadonlyArray<{
    readonly label: string;
    readonly connection: { readonly phase: EnvironmentConnectionPhase };
  }>,
  options?: { readonly showingLastKnown?: boolean },
): ChampionMachineGap | null {
  const named = (machines: ReadonlyArray<{ readonly label: string }>) =>
    machines.length === 1 ? machines[0]!.label : `${machines.length} machines`;
  const connecting = environments.filter(({ connection }) => connection.phase === "connecting");
  const reconnecting = environments.filter(
    ({ connection }) => connection.phase === "reconnecting" || connection.phase === "offline",
  );
  const waiting = [...reconnecting, ...connecting];
  if (waiting.length > 0) {
    const verb = reconnecting.length > 0 ? "Reconnecting" : "Connecting";
    return {
      waiting: true,
      status: `${verb}…`,
      title: `${verb} to ${named(waiting)}`,
      notice: options?.showingLastKnown
        ? `${verb} to ${named(waiting)}. Showing its last known champions; changes are off until it's back.`
        : `${verb} to ${named(waiting)}. Champions there aren't shown until the connection returns.`,
    };
  }
  const unreachable = environments.filter(({ connection }) =>
    ["error", "unsupported"].includes(connection.phase),
  );
  if (unreachable.length === 0) return null;
  return {
    waiting: false,
    status: "Not connected",
    title: `Can't reach ${named(unreachable)}`,
    notice: `Can't reach ${named(unreachable)}, so champions there aren't shown.`,
  };
}
