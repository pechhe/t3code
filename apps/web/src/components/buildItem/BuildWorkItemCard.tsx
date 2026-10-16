import {
  type BuildStatusTone,
  buildKindGlyph,
  buildSessionLabel,
  buildStatusLabel,
  buildStatusTone,
  describeBuildWait,
  presentSpecTickets,
} from "@t3tools/client-runtime/state/build-work-items";
import type { BuildWorkItemCard as BuildWorkItemCardData } from "@t3tools/contracts";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";
import { formatRelativeTimeLabel } from "~/timestampFormat";

const DOT_CLASSES: Record<BuildStatusTone, string> = {
  "not-started": "border border-muted-foreground/70",
  "in-progress": "bg-amber-500",
  landed: "bg-emerald-500",
  accepted: "bg-emerald-500 ring-2 ring-emerald-500/30",
  dropped: "bg-muted-foreground/50",
  unknown: "bg-muted-foreground/50",
};

const BAR_CLASSES: Record<BuildStatusTone, string> = {
  "not-started": "bg-muted-foreground/45",
  "in-progress": "bg-amber-500",
  landed: "bg-emerald-500",
  accepted: "bg-emerald-500",
  dropped: "bg-muted-foreground/50",
  unknown: "bg-muted-foreground/50",
};

export function BuildStatusDot(props: { tone: BuildStatusTone; className?: string }) {
  return (
    <span
      aria-hidden
      className={cn("size-2 shrink-0 rounded-full", DOT_CLASSES[props.tone], props.className)}
    />
  );
}

function StatusLabel(props: { status: string }) {
  return (
    <span className="inline-flex shrink-0 items-center gap-1.5">
      <BuildStatusDot tone={buildStatusTone({ status: props.status })} />
      {buildStatusLabel(props.status)}
    </span>
  );
}

function Banner(props: { tone: "held" | "blocked" | "accepted"; children: ReactNode }) {
  return (
    <div
      className={cn(
        "mt-2 rounded-md px-2 py-1.5 text-xs leading-snug",
        props.tone === "held" && "bg-warning-surface text-warning-foreground",
        props.tone === "blocked" && "bg-error-surface text-error-foreground",
        props.tone === "accepted" && "bg-success/10 text-success-foreground",
      )}
    >
      {props.children}
    </div>
  );
}

function Row(props: { label: string; children: ReactNode }) {
  return (
    <div className="flex min-w-0 gap-2 text-xs">
      <span className="w-20 shrink-0 text-muted-foreground">{props.label}</span>
      <div className="min-w-0 flex-1 text-foreground">{props.children}</div>
    </div>
  );
}

function ItemLine(props: { number: number; title: string; status: string }) {
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <BuildStatusDot tone={buildStatusTone(props)} />
      <span className="shrink-0 text-muted-foreground">#{props.number}</span>
      <span className="min-w-0 truncate">{props.title}</span>
    </div>
  );
}

/**
 * A Build Spec's or Ticket's card, as read by the server. Shown on hover of a header segment;
 * everything here comes from Build, so it never offers to change the item.
 */
export function BuildWorkItemCard(props: { card: BuildWorkItemCardData }) {
  const { card } = props;
  const { item, detail } = card;
  const waits = item.waits.map(describeBuildWait);
  const session = detail.kind === "spec" ? detail.lead : detail.worker;

  return (
    <div className="min-w-0">
      <div className="flex min-w-0 items-center gap-1.5 text-2xs text-muted-foreground">
        <span className="min-w-0 truncate">
          {detail.kind === "spec"
            ? [`${buildKindGlyph("spec")} Spec`, detail.specKind, detail.horizon]
                .filter(Boolean)
                .join(" · ")
            : `${buildKindGlyph("ticket")} Ticket${detail.spec ? ` in ${buildKindGlyph("spec")} ${detail.spec.title}` : ""}`}
        </span>
        <span className="ms-auto">
          <StatusLabel status={item.status} />
        </span>
      </div>
      <p className="mt-1 text-sm font-medium leading-snug text-foreground text-pretty">
        <span className="text-muted-foreground">#{card.number}</span> {item.title}
      </p>
      {card.summary ? (
        <p className="mt-1 line-clamp-3 text-xs leading-snug text-muted-foreground">
          {card.summary}
        </p>
      ) : null}

      {item.holds.map((hold) => (
        <Banner key={`${hold.kind}:${hold.note}`} tone="held">
          ⏸ Held · {hold.kind}
          {hold.note ? `: ${hold.note}` : ""}
        </Banner>
      ))}
      {waits.map((wait) => (
        <Banner key={wait.blocker} tone="blocked">
          ⛓ Blocked by {wait.blocker} ({wait.status}). {wait.startsWhen}
        </Banner>
      ))}
      {detail.kind === "spec" && detail.acceptedAt ? (
        <Banner tone="accepted">Accepted {formatRelativeTimeLabel(detail.acceptedAt)}</Banner>
      ) : null}

      {detail.kind === "spec" ? <SpecDetail detail={detail} /> : <TicketDetail card={card} />}

      <div className="mt-3 flex min-w-0 items-center gap-1.5 border-t pt-2 text-2xs text-muted-foreground">
        <span className="min-w-0 truncate">
          {session
            ? `${detail.kind === "spec" ? "Lead" : "Worker"}: ${buildSessionLabel(session)}`
            : detail.kind === "spec"
              ? "No lead thread"
              : "No thread working on it"}
        </span>
        <span className="ms-auto shrink-0">
          {card.unavailable
            ? `Build couldn't be reached · updated ${formatRelativeTimeLabel(card.readAt)}`
            : `Updated ${formatRelativeTimeLabel(card.updatedAt)}`}
        </span>
      </div>
    </div>
  );
}

function SpecDetail(props: { detail: Extract<BuildWorkItemCardData["detail"], { kind: "spec" }> }) {
  const { detail } = props;
  const tickets = presentSpecTickets(detail);
  return (
    <div className="mt-3 space-y-2">
      {tickets.total > 0 ? (
        <div>
          <div className="flex h-1.5 overflow-hidden rounded-full bg-muted">
            {tickets.segments.map((segment) => (
              <span
                key={segment.status}
                className={BAR_CLASSES[segment.tone]}
                style={{ width: `${(segment.count / tickets.total) * 100}%` }}
              />
            ))}
          </div>
          <div className="mt-1 flex flex-wrap gap-x-2.5 text-2xs text-muted-foreground">
            {tickets.segments.map((segment) => (
              <span key={segment.status}>
                {segment.count} {segment.label.toLowerCase()}
              </span>
            ))}
          </div>
          <div className="mt-1.5 space-y-0.5 text-xs">
            {detail.tickets.map((ticket) => (
              <ItemLine key={ticket.number} {...ticket} />
            ))}
            {tickets.more > 0 ? (
              <div className="text-2xs text-muted-foreground">+{tickets.more} more</div>
            ) : null}
          </div>
        </div>
      ) : (
        <p className="text-xs text-muted-foreground">No Tickets</p>
      )}
      {detail.governedBy.length > 0 ? (
        <Row label="Decisions">
          {detail.governedBy.map((decision) => (
            <ItemLine key={decision.number} {...decision} />
          ))}
        </Row>
      ) : null}
    </div>
  );
}

function TicketDetail(props: { card: BuildWorkItemCardData }) {
  const { card } = props;
  if (card.detail.kind !== "ticket") return null;
  const { detail } = card;
  return (
    <div className="mt-3 space-y-1.5">
      {card.item.waits.length > 0 ? (
        <Row label="Blocked by">
          {card.item.waits.map((wait) => (
            <ItemLine key={wait.number} {...wait} />
          ))}
        </Row>
      ) : null}
      <Row label="Delivery">
        {detail.latestAttempt
          ? `${detail.attempts} ${detail.attempts === 1 ? "attempt" : "attempts"} · latest ${detail.latestAttempt.status} ${formatRelativeTimeLabel(detail.latestAttempt.at)}`
          : "No attempts yet"}
      </Row>
      {detail.lastFailure ? (
        <Row label="Last failure">
          <span className="line-clamp-2">
            {detail.lastFailure.stage}: {detail.lastFailure.cause}
          </span>
        </Row>
      ) : null}
    </div>
  );
}
