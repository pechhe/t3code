import {
  type ArcRunPresentation,
  type ArcRunRow,
  buildStatusLabel,
  buildStatusTone,
  forgeItemLabel,
  presentArcRun,
} from "@t3tools/client-runtime/state/forge-work-items";
import type { OrchestrationV2ThreadArcRun, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { useState } from "react";

import { cn } from "~/lib/utils";
import { useThreadArcRunDetail } from "~/state/forgeWorkItems";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { ARC_RUN_STATE_LABEL, ArcRunStateDot, ArcSpecGlyph } from "./ArcRunGlyphs";

const BAR_TONE = {
  "not-started": "bg-muted-foreground/25",
  "in-progress": "bg-amber-500",
  landed: "bg-emerald-500/70",
  accepted: "bg-emerald-500",
  dropped: "bg-muted-foreground/15",
  unknown: "bg-muted-foreground/15",
} as const;

const PILL_TONE = {
  running: "bg-success/12 text-success-foreground",
  paused: "bg-muted text-muted-foreground",
  attention: "bg-warning-surface text-warning-foreground",
} as const;

const isDone = (row: ArcRunRow) => row.spec?.status === "landed" || row.spec?.status === "accepted";

/**
 * The Arc a thread's run serves, its plan and where each Spec stands. Reads the whole Arc only
 * while open (`opening` names this opening); the run's own plan shows before Forge answers.
 */
export function ArcRunView(props: {
  threadRef: ScopedThreadRef;
  arcRun: OrchestrationV2ThreadArcRun;
  opening: string;
  onOpenThread: (threadId: ThreadId) => void;
}) {
  const { arcRun } = props;
  const detailQuery = useThreadArcRunDetail(props.threadRef, props.opening);
  const detail = detailQuery.data ?? null;
  const shown = presentArcRun(arcRun, detail);
  const [elsewhereOpen, setElsewhereOpen] = useState(true);
  const arcTitle = detail?.arc.title ?? null;
  const runSize = shown.run.length;

  return (
    <div className="flex min-w-0 flex-col text-sm">
      <div className="flex min-w-0 items-start gap-2">
        <div className="min-w-0 flex-1">
          <p className="text-xs font-medium text-muted-foreground">
            {shown.arcLabel}
            {shown.namedSpecs ? `, a run of ${runSize} of its Specs` : ", the whole Arc"}
          </p>
          {detail ? (
            <a
              href={detail.arc.url}
              target="_blank"
              rel="noreferrer"
              className="mt-0.5 block text-base font-semibold leading-snug text-foreground text-pretty hover:underline hover:underline-offset-3"
            >
              {arcTitle}
            </a>
          ) : (
            <p className="mt-0.5 text-base font-semibold leading-snug text-muted-foreground">
              Arc {shown.arcLabel}
            </p>
          )}
        </div>
        <span
          className={cn(
            "inline-flex h-5 shrink-0 items-center gap-1.5 rounded-full px-2 text-2xs font-medium",
            PILL_TONE[shown.state],
          )}
        >
          <ArcRunStateDot state={shown.state} />
          {ARC_RUN_STATE_LABEL[shown.state]}
        </span>
      </div>
      {detail?.goal ? (
        <p className="mt-1.5 line-clamp-3 text-xs leading-relaxed text-muted-foreground">
          {detail.goal}
        </p>
      ) : null}

      {detail ? <ArcBar shown={shown} /> : null}

      <NowLine shown={shown} />

      {detailQuery.error !== null && detail === null ? (
        <p className="mt-2 text-xs text-muted-foreground">Forge couldn't be reached.</p>
      ) : detail !== null && !detail.complete ? (
        <p className="mt-2 text-xs text-muted-foreground">Some of the Arc could not be read.</p>
      ) : null}

      <SectionHead
        title={shown.namedSpecs ? "This run" : "The Arc"}
        hint={
          shown.planned
            ? "in the order the lead plans to take them"
            : "no plan recorded yet, so not in order"
        }
      />
      <ol className="flex flex-col">
        {shown.run.map((row) => (
          <SpecRow key={row.number} row={row} onOpenThread={props.onOpenThread} />
        ))}
      </ol>

      {shown.elsewhere.length > 0 ? (
        <>
          <SectionHead
            title="Elsewhere in this Arc"
            hint="not this thread's"
            toggle={{ open: elsewhereOpen, onToggle: () => setElsewhereOpen(!elsewhereOpen) }}
          />
          {elsewhereOpen ? (
            <ul className="flex flex-col">
              {shown.elsewhere.map((row) => (
                <SpecRow key={row.number} row={row} onOpenThread={props.onOpenThread} dimmed />
              ))}
            </ul>
          ) : null}
        </>
      ) : null}

      {shown.notPlanned.length > 0 ? (
        <>
          <SectionHead title="Not in the plan yet" hint="not in the lead's order" />
          <ul className="flex flex-col">
            {shown.notPlanned.map((row) => (
              <SpecRow key={row.number} row={row} onOpenThread={props.onOpenThread} dimmed />
            ))}
          </ul>
        </>
      ) : null}

      {detail ? (
        <div className="mt-3 border-t border-border pt-2 text-xs">
          <a
            href={detail.arc.url}
            target="_blank"
            rel="noreferrer"
            className="text-muted-foreground hover:text-foreground"
          >
            Open the Arc in Forge
          </a>
        </div>
      ) : null}
    </div>
  );
}

function ArcBar(props: { shown: ArcRunPresentation }) {
  const { shown } = props;
  const bar = shown.bar;
  const first = bar.findIndex((row) => !row.outsideRun);
  const last = bar.length - 1 - [...bar].reverse().findIndex((row) => !row.outsideRun);
  const bracketed = shown.namedSpecs && first !== -1;
  const runDone = shown.run.filter(isDone).length;
  const arcDone = bar.filter(isDone).length;
  return (
    <div className="mt-3">
      {bracketed ? (
        <div className="relative h-4 text-2xs text-foreground">
          <div
            aria-hidden
            className="absolute bottom-0.5 h-1.5 rounded-t-sm border border-b-0 border-foreground/50"
            style={{
              left: `calc(${(first / bar.length) * 100}% + 1px)`,
              width: `calc(${((last - first + 1) / bar.length) * 100}% - 4px)`,
            }}
          />
          <span
            className="absolute bottom-2 -translate-x-1/2 whitespace-nowrap font-medium"
            style={{ left: `${((first + last + 1) / 2 / bar.length) * 100}%` }}
          >
            This thread's run
          </span>
        </div>
      ) : null}
      <div
        className="flex h-2.5 gap-0.75"
        role="img"
        aria-label={`${arcDone} of ${bar.length} Specs landed`}
      >
        {bar.map((row) => (
          <span
            key={row.number}
            className={cn(
              "flex-1 rounded-xs",
              BAR_TONE[buildStatusTone(row.spec)],
              row.spec?.status === "shaping" &&
                "bg-transparent ring-1 ring-inset ring-muted-foreground/30",
              row.outsideRun && "opacity-35",
              row.current && "ring-2 ring-primary ring-offset-1 ring-offset-popover",
            )}
          />
        ))}
      </div>
      <div className="mt-1.5 flex justify-between text-2xs tabular-nums text-muted-foreground">
        {shown.namedSpecs ? (
          <>
            <span>
              {runDone} of {shown.run.length} in this run landed
            </span>
            <span>
              {arcDone} of {bar.length} across the Arc
            </span>
          </>
        ) : (
          <span>
            {arcDone} of {bar.length} landed
          </span>
        )}
      </div>
    </div>
  );
}

function NowLine(props: { shown: ArcRunPresentation }) {
  const { shown } = props;
  const checkpoint = shown.checkpoint;
  const current = shown.run.find((row) => row.current);
  const what = checkpoint
    ? `${checkpoint.phase}${checkpoint.note ? `: ${checkpoint.note}` : ""}`
    : null;
  const when = checkpoint ? formatRelativeTimeLabel(checkpoint.at) : "";
  if (shown.state === "attention") {
    return (
      <div className="mt-3 rounded-md bg-warning-surface px-3 py-2 text-xs leading-relaxed text-foreground">
        <span className="text-warning-foreground">Waiting for you. </span>
        T3 stopped waking this thread until you reply.
        {what ? ` Last checkpoint: ${what}` : ""}
        {when ? <span className="text-muted-foreground"> {when}</span> : null}
      </div>
    );
  }
  return (
    <div className="mt-3 rounded-md bg-muted px-3 py-2 text-xs leading-relaxed text-foreground">
      <span className="text-muted-foreground">
        {shown.state === "paused" ? "Paused. " : "Now: "}
      </span>
      {what ? `${what}.` : "No checkpoint recorded yet."}
      {current ? (
        <span className="text-muted-foreground">
          {" "}
          On {forgeItemLabel({ number: current.number, ref: current.spec?.ref })}.
        </span>
      ) : null}
      {when ? <span className="text-muted-foreground"> {when}</span> : null}
    </div>
  );
}

function SectionHead(props: {
  title: string;
  hint: string;
  toggle?: { open: boolean; onToggle: () => void };
}) {
  return (
    <div className="mt-4 mb-1 flex items-baseline gap-2">
      <span className="text-xs font-semibold text-foreground">{props.title}</span>
      <span className="min-w-0 truncate text-2xs text-muted-foreground">{props.hint}</span>
      {props.toggle ? (
        <button
          type="button"
          onClick={props.toggle.onToggle}
          className="ms-auto shrink-0 cursor-pointer text-2xs text-muted-foreground hover:text-foreground"
        >
          {props.toggle.open ? "Hide" : "Show"}
        </button>
      ) : null}
    </div>
  );
}

function SpecRow(props: {
  row: ArcRunRow;
  dimmed?: boolean;
  onOpenThread: (threadId: ThreadId) => void;
}) {
  const { row } = props;
  const spec = row.spec;
  const tone = buildStatusTone(spec);
  const thread = spec?.thread ?? null;
  const notes: Array<{ text: string; className?: string }> = [];
  if (row.current) notes.push({ text: "Working on now", className: "font-semibold text-primary" });
  if (spec) notes.push({ text: buildStatusLabel(spec.status) });
  for (const wait of spec?.waits ?? []) {
    notes.push({
      text: `Waits on ${forgeItemLabel(wait)}`,
      className: "text-destructive-foreground",
    });
  }
  for (const hold of spec?.holds ?? []) {
    notes.push({
      text: `Held${hold.note ? `: ${hold.note}` : ""}`,
      className: "line-clamp-2 basis-full text-warning-foreground",
    });
  }
  if (spec && !spec.inArc)
    notes.push({ text: "No longer in this Arc", className: "text-warning-foreground" });
  if (row.outsideRun && thread?.relation === "other-run")
    notes.push({ text: "In another thread's run" });
  if (row.outsideRun && thread === null && spec && spec.status !== "accepted") {
    notes.push({ text: "Not in any run" });
  }
  const content = (
    <>
      {row.position !== null ? (
        <span className="w-4 shrink-0 pt-px text-right text-2xs tabular-nums text-muted-foreground">
          {row.position}
        </span>
      ) : null}
      <ArcSpecGlyph tone={tone} shaping={spec?.status === "shaping"} className="mt-0.5" />
      <span className="min-w-0 flex-1">
        <span className="flex min-w-0 items-baseline gap-1.5">
          <span className="shrink-0 text-2xs font-medium tabular-nums text-muted-foreground">
            {row.label}
          </span>
          <span
            className={cn(
              "min-w-0 leading-snug text-pretty",
              tone === "accepted" ? "text-muted-foreground" : "text-foreground",
            )}
          >
            {spec?.title ?? "Reading from Forge…"}
          </span>
        </span>
        {notes.length > 0 ? (
          <span className="mt-0.5 flex flex-wrap gap-x-2.5 gap-y-0.5 text-2xs text-muted-foreground">
            {notes.map((note) => (
              <span key={note.text} className={note.className}>
                {note.text}
              </span>
            ))}
          </span>
        ) : null}
      </span>
    </>
  );
  return (
    <li
      className={cn(
        "group/arc-spec -mx-2 flex min-w-0 items-start gap-2 rounded-md px-2 py-1.5",
        row.current ? "bg-primary/10" : "hover:bg-accent",
        props.dimmed && "opacity-70 hover:opacity-100",
      )}
    >
      {spec ? (
        <a
          href={spec.url}
          target="_blank"
          rel="noreferrer"
          aria-label={`Open ${row.label} in Forge`}
          className="flex min-w-0 flex-1 items-start gap-2 rounded-sm focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          {content}
        </a>
      ) : (
        <span className="flex min-w-0 flex-1 items-start gap-2">{content}</span>
      )}
      {thread ? (
        <button
          type="button"
          onClick={() => props.onOpenThread(thread.threadId)}
          aria-label={`Open ${thread.title}`}
          className="shrink-0 cursor-pointer self-center rounded-sm border border-border px-1.5 py-px text-2xs text-muted-foreground hover:bg-background hover:text-foreground focus-visible:outline-hidden focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
        >
          {thread.relation === "spec-lead" ? "Spec lead" : "Its run"}
        </button>
      ) : null}
    </li>
  );
}
