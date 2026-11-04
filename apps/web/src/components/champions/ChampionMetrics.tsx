import {
  CHAMPION_READING_STATUS_LABELS,
  championReading,
  championReadingLabel,
  championStaleAfterMs,
  formatChampionDuration,
  formatChampionValue,
} from "@t3tools/client-runtime/champions";
import type {
  ChampionLatestSample,
  ChampionMetric,
  ChampionSample,
  ChampionSummary,
  EnvironmentId,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { ChevronDownIcon, ChevronRightIcon } from "lucide-react";
import { useState } from "react";

import { cn } from "../../lib/utils";
import { ScheduledRelativeLabel } from "../scheduled/scheduledTaskParts";
import { useNowMinute } from "../../hooks/useNowMinute";
import { Badge } from "../ui/badge";
import {
  metricSeries,
  metricTargetLabel,
  metricTrend,
  readingFreshness,
  sparklineGeometry,
  type MetricTrend,
} from "./champions.logic";

const SPARK_WIDTH = 120;
const SPARK_HEIGHT = 30;
const READINGS_SHOWN = 5;

function ChampionSparkline(props: {
  readonly samples: ReadonlyArray<ChampionSample>;
  readonly label: string;
}) {
  const points = props.samples.map((sample) =>
    sample.status === "measured" ? sample.value : null,
  );
  const { segments, end } = sparklineGeometry(points, SPARK_WIDTH, SPARK_HEIGHT);
  return (
    <svg
      viewBox={`0 0 ${SPARK_WIDTH} ${SPARK_HEIGHT}`}
      role="img"
      aria-label={segments.length === 0 ? `${props.label}: no readings` : props.label}
      className="block h-auto w-full max-w-30"
    >
      {segments.length === 0 ? (
        <line
          x1={2}
          x2={SPARK_WIDTH - 2}
          y1={SPARK_HEIGHT / 2}
          y2={SPARK_HEIGHT / 2}
          className="stroke-muted-foreground/50"
          strokeDasharray="3 3"
        />
      ) : null}
      {segments.map((segment) => (
        <path
          key={segment}
          d={segment}
          className="fill-none stroke-foreground"
          strokeWidth={1.5}
          vectorEffect="non-scaling-stroke"
        />
      ))}
      {end ? <circle cx={end.x} cy={end.y} r={2.2} className="fill-foreground" /> : null}
    </svg>
  );
}

function TrendLabel(props: { readonly trend: MetricTrend | null }) {
  const { trend } = props;
  if (trend === null) return null;
  if (trend.direction === "steady") {
    return <span className="text-muted-foreground text-xs">→ steady</span>;
  }
  const arrow = trend.direction === "up" ? "↗" : "↘";
  return (
    <span
      className={cn(
        "text-xs",
        trend.judgement === "better" && "text-success-foreground",
        trend.judgement === "worse" && "text-warning-foreground",
        trend.judgement === null && "text-muted-foreground",
      )}
    >
      {arrow} {trend.judgement ?? (trend.direction === "up" ? "rising" : "falling")}
    </span>
  );
}

function DetailRow(props: { readonly label: string; readonly children: React.ReactNode }) {
  return (
    <>
      <dt className="text-muted-foreground">{props.label}</dt>
      <dd className="min-w-0 wrap-break-word">{props.children}</dd>
    </>
  );
}

function readingText(sample: ChampionSample): string {
  if (sample.status === "measured" && sample.value !== null) {
    return formatChampionValue(sample.value, sample.unit);
  }
  return CHAMPION_READING_STATUS_LABELS[sample.status === "measured" ? "unknown" : sample.status];
}

function MetricDetail(props: {
  readonly environmentId: EnvironmentId;
  readonly metric: ChampionMetric;
  readonly definitions: ReadonlyArray<ChampionMetric>;
  readonly samples: ReadonlyArray<ChampionSample>;
  readonly schedule: ChampionSummary["schedule"];
  readonly hasOlder: boolean;
}) {
  const { metric } = props;
  const series = metricSeries(metric, props.definitions, props.samples);
  const current = series.find((view) => view.current);
  const recent = (current?.samples ?? []).slice(-READINGS_SHOWN).toReversed();
  const latest = recent[0];
  const earlier = series.filter((view) => !view.current);
  return (
    <div className="flex flex-col gap-3 px-3 pt-1 pb-3 text-sm">
      <dl className="grid grid-cols-[88px_minmax(0,1fr)] gap-x-3 gap-y-1">
        {metric.description ? <DetailRow label="Means">{metric.description}</DetailRow> : null}
        <DetailRow label="Source">{metric.source}</DetailRow>
        {metric.context ? <DetailRow label="Context">{metric.context}</DetailRow> : null}
        <DetailRow label="Better when">
          {
            {
              higher: "Higher",
              lower: "Lower",
              range: "Inside the range",
              observe: "No better direction",
            }[metric.direction]
          }
        </DetailRow>
        <DetailRow label="Target">{metricTargetLabel(metric)}</DetailRow>
        <DetailRow label="Baseline">
          {metric.baseline == null
            ? "No baseline yet"
            : formatChampionValue(metric.baseline, metric.unit)}
        </DetailRow>
        <DetailRow label="Counts as">
          {(metric.required ?? true)
            ? "Required: without a current reading the champion can't be called healthy"
            : "Optional: a missing reading doesn't affect the champion's status"}
        </DetailRow>
        <DetailRow label="Out of date">
          After {formatChampionDuration(championStaleAfterMs(metric, props.schedule))} without a new
          reading
          {metric.staleAfterMs === undefined ? ", twice the check cadence" : ""}
        </DetailRow>
        <DetailRow label="Version">
          Version {metric.version}. {metric.reason}
        </DetailRow>
        {latest ? (
          <>
            <DetailRow label="Evidence">{latest.evidence || "None reported"}</DetailRow>
            <DetailRow label="Reported by">
              <span>The agent that ran the check</span>
              {latest.revision ? (
                <span className="text-muted-foreground"> at {latest.revision}</span>
              ) : null}
              {" · "}
              <Link
                to="/$environmentId/$threadId"
                params={{ environmentId: props.environmentId, threadId: latest.threadId }}
                className="underline-offset-2 hover:underline"
              >
                Open check
              </Link>
            </DetailRow>
          </>
        ) : null}
        <DetailRow label="Readings">
          {recent.length > 0 ? (
            <span className="flex flex-wrap gap-x-3.5 gap-y-1 text-xs">
              {recent.map((sample, index) => (
                <span key={`${sample.checkId}:${sample.metricId}`}>
                  <span className="text-muted-foreground">
                    {index === 0 ? "Latest" : `${index} back`}
                  </span>{" "}
                  {readingText(sample)}
                </span>
              ))}
            </span>
          ) : (
            <span className="text-muted-foreground">
              {props.hasOlder ? "None in loaded history" : "None yet"}
            </span>
          )}
        </DetailRow>
      </dl>
      {earlier.length > 0 ? (
        <div className="flex flex-col">
          <p className="text-muted-foreground text-xs">
            These measure something different, so their readings aren't joined to the current ones.
          </p>
          {earlier.map((view) => {
            const newest = view.definitions[0];
            return (
              <div
                key={view.seriesId}
                className="grid grid-cols-[minmax(0,1fr)_120px] items-center gap-3 border-t py-2 first:border-t-0"
              >
                <div className="flex min-w-0 flex-col gap-0.5 text-xs">
                  <span className="font-medium">
                    {newest ? `Version ${newest.version}, in ${newest.unit}` : "Earlier definition"}
                  </span>
                  {newest?.source ? <span>{newest.source}</span> : null}
                  {newest?.reason ? (
                    <span className="text-muted-foreground">{newest.reason}</span>
                  ) : null}
                  <span className="text-muted-foreground">
                    {view.samples.length === 1 ? "1 reading" : `${view.samples.length} readings`}
                  </span>
                </div>
                <ChampionSparkline
                  samples={view.samples}
                  label={`${metric.name}, earlier definition`}
                />
              </div>
            );
          })}
        </div>
      ) : null}
    </div>
  );
}

export function ChampionMetricRow(props: {
  readonly environmentId: EnvironmentId;
  readonly metric: ChampionMetric;
  readonly lifecycle: ChampionSummary["lifecycle"];
  readonly schedule: ChampionSummary["schedule"];
  /** Null for a metric no longer tracked, which has no current reading to show. */
  readonly latestSamples: ReadonlyArray<ChampionLatestSample> | undefined | null;
  readonly definitions: ReadonlyArray<ChampionMetric>;
  readonly samples: ReadonlyArray<ChampionSample>;
  readonly hasOlder: boolean;
}) {
  const { metric, samples } = props;
  const [open, setOpen] = useState(false);
  const nowMs = Date.parse(`${useNowMinute()}:00.000Z`);
  const reading =
    props.latestSamples === null ? null : championReading(metric, props.latestSamples, nowMs);
  const freshness = reading === null ? null : readingFreshness(reading, props.lifecycle);
  const trend = metricTrend(metric, samples);
  const off = reading?.kind === "measured" && reading.health === "breached";
  const stale = reading?.kind === "measured" && reading.health === "stale";
  const current = metricSeries(metric, [], samples).find((view) => view.current)?.samples ?? [];
  const Chevron = open ? ChevronDownIcon : ChevronRightIcon;
  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="grid w-full grid-cols-[minmax(0,1fr)_auto_14px] items-center gap-3 px-3 py-2.5 text-start hover:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring sm:grid-cols-[minmax(0,1fr)_120px_128px_14px]"
      >
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="flex flex-wrap items-baseline gap-x-2">
            <span className="font-medium text-sm">{metric.name}</span>
            <TrendLabel trend={trend} />
            {(metric.required ?? true) ? null : <Badge variant="outline">Optional</Badge>}
            {stale ? <Badge variant="warning">Out of date</Badge> : null}
          </span>
          {metric.description ? (
            <span className="line-clamp-2 text-muted-foreground text-xs">{metric.description}</span>
          ) : null}
        </span>
        <span className="col-span-full row-start-2 max-w-45 sm:col-span-1 sm:row-start-auto">
          <ChampionSparkline samples={current} label={metric.name} />
        </span>
        <span className="flex flex-col items-end gap-0.5 text-end">
          <span
            className={cn(
              reading?.kind === "measured"
                ? "font-semibold text-base leading-tight"
                : "font-medium text-muted-foreground text-sm",
              off && "text-warning-foreground",
              stale && "text-muted-foreground",
            )}
          >
            {reading === null ? "No longer tracked" : championReadingLabel(reading, metric.unit)}
          </span>
          {freshness ? (
            <span className="text-muted-foreground text-xs">
              {freshness.prefix ? `${freshness.prefix} ` : ""}
              <ScheduledRelativeLabel value={freshness.at} />
            </span>
          ) : null}
          <span className="text-muted-foreground text-xs">{metricTargetLabel(metric)}</span>
        </span>
        <Chevron aria-hidden className="size-3.5 text-muted-foreground" />
      </button>
      {open ? (
        <MetricDetail
          environmentId={props.environmentId}
          metric={metric}
          definitions={props.definitions}
          samples={samples}
          schedule={props.schedule}
          hasOlder={props.hasOlder}
        />
      ) : null}
    </div>
  );
}
