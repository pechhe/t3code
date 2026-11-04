import {
  canDismissChampionFinding,
  canReopenChampionFinding,
  CHAMPION_FINDING_STATUS_LABELS,
  championFailureMessage,
  championFindingIsClosed,
  pendingChampionDecision,
} from "@t3tools/client-runtime/champions";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  ChampionActivity,
  ChampionFinding,
  EnvironmentId,
  ThreadId,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { ChevronDownIcon, ChevronRightIcon, ExternalLinkIcon } from "lucide-react";
import { useState } from "react";

import { readLocalApi } from "../../localApi";
import { cn } from "../../lib/utils";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { ScheduledRelativeLabel } from "../scheduled/scheduledTaskParts";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import { activityTitle, type ChampionActivityView, safeExternalUrl } from "./champions.logic";
import { FINDING_VARIANTS } from "./championsPresentation";
import { useChampionCommandAllowed } from "./useChampionAction";

const QUIET_SHOWN = 5;
const DECISION_ANSWER_MAX_LENGTH = 500;

function ThreadLink(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly label: string;
}) {
  return (
    <Link
      to="/$environmentId/$threadId"
      params={{ environmentId: props.environmentId, threadId: props.threadId }}
      className="underline-offset-2 hover:underline"
    >
      {props.label}
    </Link>
  );
}

function WorkLinks(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId | null;
  readonly threadLabel: string;
  readonly specUrl: string | null;
  readonly revision: string | null;
}) {
  const specUrl = safeExternalUrl(props.specUrl);
  if (props.threadId === null && specUrl === null && props.revision === null) return null;
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-1 text-xs">
      {props.threadId !== null ? (
        <ThreadLink
          environmentId={props.environmentId}
          threadId={props.threadId}
          label={props.threadLabel}
        />
      ) : null}
      {specUrl !== null ? (
        <a
          href={specUrl}
          target="_blank"
          rel="noreferrer"
          className="inline-flex items-center gap-1 underline-offset-2 hover:underline"
          onClick={(event) => {
            const api = readLocalApi();
            if (!api) return;
            event.preventDefault();
            void api.shell.openExternal(specUrl);
          }}
        >
          Spec
          <ExternalLinkIcon aria-hidden className="size-3" />
        </a>
      ) : null}
      {props.revision !== null ? (
        <span className="text-muted-foreground">
          Revision <span className="font-mono">{props.revision}</span>
        </span>
      ) : null}
    </div>
  );
}

function DecisionAnswer(props: {
  readonly environmentId: EnvironmentId;
  readonly championId: string;
  readonly findingId: string;
  readonly decision: NonNullable<ChampionFinding["decision"]>;
}) {
  const { decision } = props;
  const act = useAtomCommand(serverEnvironment.championFindingAction, {
    label: "champion decision answer",
    reportFailure: false,
  });
  const canAct = useChampionCommandAllowed(
    serverEnvironment.championFindingAction,
    props.environmentId,
  );
  const [answer, setAnswer] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (decision.status === "resolved") {
    return (
      <div className="flex flex-col gap-0.5 text-sm">
        <p className="text-muted-foreground">{decision.question}</p>
        <p>Answered: {decision.answer}</p>
      </div>
    );
  }
  const submit = async () => {
    if (busy || !answer.trim()) return;
    setBusy(true);
    setError(null);
    const result = await act({
      environmentId: props.environmentId,
      input: {
        id: props.championId,
        findingId: props.findingId,
        action: "resolve_decision",
        decisionId: decision.id,
        reason: answer.trim(),
      },
    });
    setBusy(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      setError(championFailureMessage(squashAtomCommandFailure(result), "decision"));
    }
  };
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        void submit();
      }}
    >
      <p className="font-medium">{decision.question}</p>
      <Textarea
        aria-label="Your answer"
        placeholder="Your answer goes to the champion's owner."
        maxLength={DECISION_ANSWER_MAX_LENGTH}
        value={answer}
        onChange={(event) => setAnswer(event.target.value)}
      />
      <Button
        size="sm"
        type="submit"
        className="self-start"
        disabled={!canAct || busy || !answer.trim()}
      >
        {busy ? "Sending…" : "Answer and continue"}
      </Button>
      {error ? (
        <p role="alert" className="text-destructive-foreground text-xs">
          {error}
        </p>
      ) : null}
    </form>
  );
}

function FindingControls(props: {
  readonly environmentId: EnvironmentId;
  readonly championId: string;
  readonly finding: ChampionFinding;
}) {
  const { finding } = props;
  const act = useAtomCommand(serverEnvironment.championFindingAction, {
    label: "champion finding action",
    reportFailure: false,
  });
  const canAct = useChampionCommandAllowed(
    serverEnvironment.championFindingAction,
    props.environmentId,
  );
  const [asking, setAsking] = useState<"dismiss" | "reopen" | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const submit = async (action: "dismiss" | "reopen") => {
    if (busy || !reason.trim()) return;
    setBusy(true);
    setError(null);
    const result = await act({
      environmentId: props.environmentId,
      input: {
        id: props.championId,
        findingId: finding.id,
        action,
        reason: reason.trim(),
      },
    });
    setBusy(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        setError(championFailureMessage(squashAtomCommandFailure(result), "finding"));
      }
      return;
    }
    setAsking(null);
    setReason("");
  };

  return (
    <div className="flex flex-col gap-2">
      {asking === null ? (
        <div className="flex flex-wrap gap-2">
          {canDismissChampionFinding(finding) ? (
            <Button
              size="xs"
              variant="ghost-muted"
              disabled={!canAct}
              onClick={() => setAsking("dismiss")}
            >
              Dismiss
            </Button>
          ) : null}
          {canReopenChampionFinding(finding) ? (
            <Button
              size="xs"
              variant="outline"
              disabled={!canAct}
              onClick={() => setAsking("reopen")}
            >
              Reopen
            </Button>
          ) : null}
        </div>
      ) : (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void submit(asking);
          }}
        >
          <Input
            className="min-w-48 flex-1"
            nativeInput
            size="sm"
            autoFocus
            aria-label={asking === "dismiss" ? "Why dismiss this?" : "Why reopen this?"}
            placeholder={asking === "dismiss" ? "Why dismiss this?" : "Why reopen this?"}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
          <Button size="xs" type="submit" disabled={!canAct || busy || !reason.trim()}>
            {asking === "dismiss" ? "Dismiss" : "Reopen"}
          </Button>
          <Button
            size="xs"
            variant="ghost-muted"
            disabled={busy}
            onClick={() => {
              setAsking(null);
              setError(null);
            }}
          >
            Cancel
          </Button>
        </form>
      )}
      {error ? (
        <p role="alert" className="text-destructive-foreground text-xs">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function EntryRow(props: {
  readonly title: string;
  readonly subtitle?: string | undefined;
  readonly badge?:
    | { readonly label: string; readonly variant: "warning" | "info" | "success" | "outline" }
    | undefined;
  readonly at: string;
  readonly highlighted?: boolean;
  readonly defaultOpen?: boolean;
  readonly children: React.ReactNode;
}) {
  const [open, setOpen] = useState(props.defaultOpen ?? false);
  const Chevron = open ? ChevronDownIcon : ChevronRightIcon;
  return (
    <div className={cn(props.highlighted && "bg-warning/6")}>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
        className="grid w-full grid-cols-[minmax(0,1fr)_auto_14px] items-center gap-2.5 px-3 py-2.5 text-start hover:bg-accent focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring"
      >
        <span className="flex min-w-0 flex-col gap-0.5">
          <span className="font-medium text-sm">{props.title}</span>
          {props.subtitle ? (
            <span className="line-clamp-2 text-muted-foreground text-xs">{props.subtitle}</span>
          ) : null}
        </span>
        <span className="flex flex-wrap items-center justify-end gap-2">
          {props.badge ? <Badge variant={props.badge.variant}>{props.badge.label}</Badge> : null}
          <span className="text-muted-foreground text-xs">
            <ScheduledRelativeLabel value={props.at} />
          </span>
        </span>
        <Chevron aria-hidden className="size-3.5 text-muted-foreground" />
      </button>
      {open ? (
        <div className="flex flex-col gap-3 px-3 pt-1 pb-3 text-sm">{props.children}</div>
      ) : null}
    </div>
  );
}

function FindingEntry(props: {
  readonly environmentId: EnvironmentId;
  readonly championId: string;
  readonly finding: ChampionFinding;
  readonly events: ReadonlyArray<ChampionActivity>;
  readonly archived: boolean;
}) {
  const { finding } = props;
  const pending = pendingChampionDecision(finding);
  const closed = championFindingIsClosed(finding);
  return (
    <EntryRow
      title={finding.title}
      subtitle={finding.evidence}
      badge={
        pending
          ? { label: "Needs you", variant: "warning" }
          : {
              label: CHAMPION_FINDING_STATUS_LABELS[finding.status],
              variant: FINDING_VARIANTS[finding.status],
            }
      }
      at={finding.updatedAt}
      highlighted={pending !== null}
      defaultOpen={pending !== null}
    >
      {finding.decision ? (
        <DecisionAnswer
          environmentId={props.environmentId}
          championId={props.championId}
          findingId={finding.id}
          decision={finding.decision}
        />
      ) : null}
      {finding.repairAttention ? (
        <p className="text-warning-foreground">{finding.repairAttention}</p>
      ) : null}
      {finding.evidence ? <p className="whitespace-pre-wrap">{finding.evidence}</p> : null}
      <WorkLinks
        environmentId={props.environmentId}
        threadId={finding.childThreadId}
        threadLabel={closed ? "Repair thread" : "Open repair thread"}
        specUrl={finding.specUrl}
        revision={finding.revision}
      />
      {finding.delivery ? (
        <p className="text-muted-foreground text-xs">
          Landed at <span className="font-mono">{finding.delivery.revision}</span>, confirmed by the
          landing runner <ScheduledRelativeLabel value={finding.delivery.confirmedAt} />
        </p>
      ) : finding.status === "handed_back" ? (
        <p className="text-muted-foreground text-xs">
          The worker handed this back. It hasn't landed yet.
        </p>
      ) : null}
      {props.archived ? (
        <p className="text-muted-foreground text-xs">
          Older settled finding, kept for reference. It can't be changed from here.
        </p>
      ) : (
        <FindingControls
          environmentId={props.environmentId}
          championId={props.championId}
          finding={finding}
        />
      )}
      {props.events.length > 0 ? (
        <ol className="flex flex-col gap-1 text-xs">
          {props.events.map((event) => (
            <li key={event.id} className="flex flex-wrap gap-x-2">
              <span className="w-24 shrink-0 text-muted-foreground">
                <ScheduledRelativeLabel value={event.at} />
              </span>
              <span className="min-w-0 flex-1">
                {activityTitle(event.kind)}
                {event.text ? <span className="text-muted-foreground"> · {event.text}</span> : null}
              </span>
            </li>
          ))}
        </ol>
      ) : null}
    </EntryRow>
  );
}

function EventEntry(props: {
  readonly environmentId: EnvironmentId;
  readonly event: ChampionActivity;
}) {
  const { event } = props;
  return (
    <EntryRow title={activityTitle(event.kind)} subtitle={event.text} at={event.at}>
      {event.text ? <p className="whitespace-pre-wrap">{event.text}</p> : null}
      <WorkLinks
        environmentId={props.environmentId}
        threadId={event.threadId}
        threadLabel="Open thread"
        specUrl={event.specUrl}
        revision={event.revision}
      />
    </EntryRow>
  );
}

export function ChampionActivityList(props: {
  readonly environmentId: EnvironmentId;
  readonly championId: string;
  readonly view: ChampionActivityView;
  readonly loading: boolean;
}) {
  const { view } = props;
  const [quietOpen, setQuietOpen] = useState(false);
  const QuietChevron = quietOpen ? ChevronDownIcon : ChevronRightIcon;
  return (
    <>
      <div className="flex flex-col divide-y overflow-hidden rounded-lg border bg-card">
        {view.entries.map((entry) =>
          entry.kind === "finding" ? (
            <FindingEntry
              key={entry.finding.id}
              environmentId={props.environmentId}
              championId={props.championId}
              finding={entry.finding}
              events={entry.events}
              archived={entry.archived}
            />
          ) : (
            <EventEntry
              key={entry.event.id}
              environmentId={props.environmentId}
              event={entry.event}
            />
          ),
        )}
        {view.entries.length === 0 ? (
          <p className="px-3 py-2.5 text-muted-foreground text-sm">
            {props.loading ? "Loading activity…" : "Nothing has happened yet."}
          </p>
        ) : null}
      </div>
      {view.quiet.length > 0 ? (
        <div className="flex flex-col gap-1.5">
          <Button
            size="xs"
            variant="ghost-muted"
            className="self-start"
            aria-expanded={quietOpen}
            onClick={() => setQuietOpen((value) => !value)}
          >
            <QuietChevron aria-hidden />
            {view.quiet.length === 1 ? "1 quiet check" : `${view.quiet.length} quiet checks`}
          </Button>
          {quietOpen ? (
            <ul className="flex flex-col gap-1 text-xs">
              {view.quiet.slice(0, QUIET_SHOWN).map((event) => (
                <li key={event.id} className="flex flex-wrap gap-x-2">
                  <span className="w-24 shrink-0 text-muted-foreground">
                    <ScheduledRelativeLabel value={event.at} />
                  </span>
                  <span className="min-w-0 flex-1">{event.text || "Check reported."}</span>
                  {event.threadId !== null ? (
                    <ThreadLink
                      environmentId={props.environmentId}
                      threadId={event.threadId}
                      label="Open"
                    />
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </>
  );
}
