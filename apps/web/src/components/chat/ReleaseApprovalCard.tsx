import {
  releaseApprovalFacts,
  releaseApprovalFailureMessage,
  releaseApprovalOutcome,
  releaseApprovalTitle,
  shortCommit,
  type ReleaseApprovalItem,
} from "@t3tools/client-runtime/release-approval";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  EnvironmentId,
  OrchestrationV2ProjectedTurnItem,
  ReleaseApprovalCardSummary,
  ReleaseApprovalDecision,
} from "@t3tools/contracts";
import { CheckIcon, ChevronDownIcon, ChevronRightIcon, MinusIcon, RocketIcon } from "lucide-react";
import * as DateTime from "effect/DateTime";
import { useId, useRef, useState, type ReactNode } from "react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import ChatMarkdown from "../ChatMarkdown";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { WorkLogRow } from "./WorkLog";

/** A release approval in its thread's timeline: open with its details, or what became of it. */
export function ReleaseApprovalTimelineCard(props: {
  readonly environmentId: EnvironmentId;
  readonly item: ReleaseApprovalItem;
  readonly visibility: OrchestrationV2ProjectedTurnItem["visibility"];
}) {
  const { item } = props;
  const outcome = releaseApprovalOutcome(item, props.visibility);
  if (outcome !== null) {
    const Icon = item.approvalStatus === "approved" ? CheckIcon : MinusIcon;
    return (
      <WorkLogRow
        data-v2-item-type={item.type}
        icon={<Icon className="size-3.5 text-icon-muted" aria-hidden />}
        label={
          <>
            {releaseApprovalTitle(item)} · {outcome}
          </>
        }
      />
    );
  }
  return (
    <ReleaseApprovalCard
      environmentId={props.environmentId}
      card={{
        approvalId: item.approvalId,
        repository: item.repository,
        candidate: item.candidate,
        base: item.base,
        summary: item.summary,
        requestedAt: DateTime.formatIso(item.startedAt ?? item.updatedAt),
      }}
      details={item.details}
    />
  );
}

/**
 * The open card itself. Every thread that asked shows the same approval, so answering it here
 * answers it everywhere.
 */
export function ReleaseApprovalCard(props: {
  readonly environmentId: EnvironmentId;
  readonly card: ReleaseApprovalCardSummary;
  readonly details?: string;
  /** Shown under the title, e.g. which threads asked when the card is outside its thread. */
  readonly context?: ReactNode;
}) {
  const { card } = props;
  const noteId = useId();
  const errorId = useId();
  const answer = useAtomCommand(serverEnvironment.answerReleaseApproval, {
    label: "answer release approval",
    reportFailure: false,
  });
  const [note, setNote] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showDetails, setShowDetails] = useState(false);
  // A double click can run twice before a re-render; this guard is synchronous.
  const inFlight = useRef(false);

  const send = async (decision: ReleaseApprovalDecision) => {
    if (inFlight.current) return;
    inFlight.current = true;
    setSubmitting(true);
    setError(null);
    const trimmed = note.trim();
    const result = await answer({
      environmentId: props.environmentId,
      input: {
        approvalId: card.approvalId,
        candidate: card.candidate,
        decision,
        ...(trimmed === "" ? {} : { note: trimmed }),
      },
    }).finally(() => {
      inFlight.current = false;
      setSubmitting(false);
    });
    if (result._tag === "Success") return;
    if (!isAtomCommandInterrupted(result)) {
      setError(releaseApprovalFailureMessage(squashAtomCommandFailure(result)));
    }
  };

  const items = card.summary.items;
  const migrations = card.summary.migrations;
  const details = props.details?.trim() ?? "";

  return (
    <section
      data-v2-item-type="release_approval_request"
      aria-label={releaseApprovalTitle(card)}
      className="flex min-w-0 flex-col gap-3 rounded-xl border border-border/60 bg-card p-4"
    >
      <div className="flex min-w-0 flex-col gap-1">
        <h3 className="flex min-w-0 items-start gap-2 text-sm font-medium text-foreground">
          <RocketIcon className="size-4 shrink-0 text-icon-muted" aria-hidden />
          <span className="min-w-0 break-words">Approve release of {card.repository}</span>
        </h3>
        <p className="font-mono text-xs text-muted-foreground">
          {shortCommit(card.candidate)} onto {shortCommit(card.base)}
        </p>
        {props.context}
      </div>
      <ul className="flex min-w-0 flex-wrap gap-1.5" aria-label="Release summary">
        {releaseApprovalFacts(card.summary).map((fact) => (
          <li key={fact.label}>
            <Badge
              variant={
                fact.tone === "danger" ? "error" : fact.tone === "warning" ? "warning" : "outline"
              }
            >
              {fact.label}
            </Badge>
          </li>
        ))}
      </ul>
      {items.length > 0 || migrations.length > 0 ? (
        <div className="flex min-w-0 flex-col gap-1 text-sm">
          {items.map((item) => (
            <p key={item.ref} className="min-w-0 break-words text-foreground/90">
              <span className="font-mono text-xs text-muted-foreground">{item.ref}</span>{" "}
              {item.title}
              {item.partialBuild ? (
                <span className="text-warning-foreground"> · partly built</span>
              ) : null}
            </p>
          ))}
          {migrations.map((migration) => (
            <p key={migration.name} className="min-w-0 break-words text-foreground/90">
              <span className="font-mono text-xs">{migration.name}</span>
              {migration.nonAdditive ? (
                <span className="text-destructive-foreground"> · non-additive</span>
              ) : null}
            </p>
          ))}
        </div>
      ) : null}
      {details !== "" ? (
        <div className="flex min-w-0 flex-col items-start gap-1">
          <Button
            type="button"
            size="xs"
            variant="ghost-muted"
            aria-expanded={showDetails}
            onClick={() => setShowDetails((open) => !open)}
          >
            {showDetails ? <ChevronDownIcon aria-hidden /> : <ChevronRightIcon aria-hidden />}
            Details
          </Button>
          {showDetails ? (
            <div className="w-full min-w-0 text-sm">
              <ChatMarkdown text={details} cwd={undefined} parseRawHtml={false} />
            </div>
          ) : null}
        </div>
      ) : null}
      <Textarea
        id={noteId}
        aria-label="Note for the agent (optional)"
        placeholder="Note for the agent (optional)"
        value={note}
        disabled={submitting}
        rows={1}
        aria-invalid={error !== null || undefined}
        aria-describedby={error !== null ? errorId : undefined}
        onChange={(event) => setNote(event.currentTarget.value)}
      />
      {error !== null ? (
        <p id={errorId} role="alert" className="text-xs text-destructive">
          {error}
        </p>
      ) : null}
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Button
          type="button"
          size="sm"
          variant="outline"
          disabled={submitting}
          onClick={() => void send("declined")}
        >
          Decline
        </Button>
        <Button type="button" size="sm" disabled={submitting} onClick={() => void send("approved")}>
          Approve
        </Button>
      </div>
    </section>
  );
}
