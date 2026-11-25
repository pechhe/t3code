import {
  canDismissChampionFinding,
  canReopenChampionFinding,
  CHAMPION_FINDING_STATUS_LABELS,
  championApprovalAnswer,
  championApprovalWhen,
  championFailureMessage,
  championFindingIsClosed,
  learningNoteProse,
  pendingChampionDecision,
} from "@t3tools/client-runtime/champions";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  ChampionError,
  type ChampionActivity,
  type ChampionFinding,
  type ChampionRelayedApproval,
  type ChampionRuntimeState,
  type EnvironmentId,
  type ModelSelection,
  type ThreadId,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { msg, T, useGT, useMessages, Var } from "gt-react";
import * as Schema from "effect/Schema";
import { ChevronDownIcon, ChevronRightIcon, ExternalLinkIcon } from "lucide-react";
import { useState } from "react";

import { readLocalApi } from "../../localApi";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { AgentRoleChip } from "../AgentRoleChip";
import { ModelLabel } from "../ModelLabel";
import { ScheduledRelativeLabel } from "../scheduled/scheduledTaskParts";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Textarea } from "../ui/textarea";
import {
  activityTitle,
  type ChampionActivityView,
  championRecentRuns,
  safeExternalUrl,
  sameChampionModel,
} from "./champions.logic";
import { FINDING_VARIANTS } from "./championsPresentation";
import { useChampionCommandAllowed } from "./useChampionAction";

const QUIET_SHOWN = 5;
const ENTRIES_SHOWN = 3;
const DECISION_ANSWER_MAX_LENGTH = 500;
const RUNS_SHOWN = 10;
const RUN_KIND_LABELS = {
  readings: msg("Readings", { $context: "a Champion run that takes readings" }),
  review: msg("Goal review"),
  setup: msg("Metric setup"),
} as const;
const isChampionError = Schema.is(ChampionError);

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

/** An approval an agent completed with the person's own words, and where they typed them. */
function RelayedApproval(props: {
  readonly environmentId: EnvironmentId;
  readonly approval: ChampionRelayedApproval;
}) {
  const { approval } = props;
  const gt = useGT();
  const when = championApprovalWhen(approval.approvedAt);
  return (
    <p className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 text-muted-foreground text-xs">
      <Badge variant="success" size="sm">
        <T>Approved by you</T>
      </Badge>
      <span>
        <T>through</T>
      </span>
      <ThreadLink
        environmentId={approval.sourceEnvironment?.id ?? props.environmentId}
        threadId={approval.threadId}
        label={approval.threadTitle.trim() || gt("an agent thread")}
      />
      {approval.sourceEnvironment ? (
        <span>
          <T>
            on <Var>{approval.sourceEnvironment.label}</Var>
          </T>
        </span>
      ) : null}
      {when ? (
        <>
          <span aria-hidden>·</span>
          <span>{when}</span>
        </>
      ) : null}
      <span aria-hidden>·</span>
      <q className="text-foreground italic">{approval.quote}</q>
    </p>
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
          <T>Spec</T>
          <ExternalLinkIcon aria-hidden className="size-3" />
        </a>
      ) : null}
      {props.revision !== null ? (
        <span className="text-muted-foreground">
          <T>
            Revision{" "}
            <Var>
              <span className="font-mono">{props.revision}</span>
            </Var>
          </T>
        </span>
      ) : null}
    </div>
  );
}

function Disclosure(props: {
  readonly label: string;
  readonly openLabel?: string;
  readonly children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const Chevron = open ? ChevronDownIcon : ChevronRightIcon;
  return (
    <div className="flex flex-col gap-1.5">
      <Button
        size="xs"
        variant="ghost-muted"
        className="self-start"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <Chevron aria-hidden />
        {open ? (props.openLabel ?? props.label) : props.label}
      </Button>
      {open ? props.children : null}
    </div>
  );
}

function DecisionAnswer(props: {
  readonly environmentId: EnvironmentId;
  readonly championId: string;
  readonly findingId: string;
  readonly decision: NonNullable<ChampionFinding["decision"]>;
  readonly onChanged: () => void;
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
  const gt = useGT();
  const m = useMessages();
  const [answer, setAnswer] = useState("");
  const [writing, setWriting] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (decision.status === "resolved") {
    return (
      <div className="flex flex-col gap-0.5 text-sm">
        <p className="text-muted-foreground">{decision.question}</p>
        <p>
          <T>
            Answered: <Var>{decision.answer}</Var>
          </T>
        </p>
        {decision.approval ? (
          <RelayedApproval environmentId={props.environmentId} approval={decision.approval} />
        ) : null}
      </div>
    );
  }
  const proposal = decision.proposal;
  const edit = (value: string) => {
    setAnswer(value);
    setError(null);
  };
  const submit = async (text: string) => {
    if (busy || !text.trim()) return;
    setBusy(true);
    setError(null);
    const result = await act({
      environmentId: props.environmentId,
      input: {
        id: props.championId,
        findingId: props.findingId,
        action: "resolve_decision",
        decisionId: decision.id,
        reason: text.trim(),
      },
    });
    setBusy(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      const conflict = isChampionError(failure) && failure.reason === "conflict";
      setError(
        conflict
          ? gt("This changed before your answer arrived, so it wasn't sent. It's still here.")
          : championFailureMessage(failure, "decision", m),
      );
      if (conflict) props.onChanged();
    }
  };
  return (
    <form
      className="flex flex-col gap-2"
      onSubmit={(event) => {
        event.preventDefault();
        void submit(answer);
      }}
    >
      {proposal ? (
        <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
          <dt className="text-muted-foreground">
            <T>Proposed</T>
          </dt>
          <dd className="font-medium">{proposal.action}</dd>
          <dt className="text-muted-foreground">
            <T>Why</T>
          </dt>
          <dd className="text-muted-foreground">{proposal.why}</dd>
        </dl>
      ) : null}
      {writing ? (
        <Textarea
          aria-label={gt("Your answer")}
          placeholder={gt("Your answer goes to this finding's case.")}
          maxLength={DECISION_ANSWER_MAX_LENGTH}
          value={answer}
          autoFocus
          onChange={(event) => edit(event.target.value)}
        />
      ) : null}
      <div className="flex flex-wrap gap-2">
        {writing ? (
          <>
            <Button size="sm" type="submit" disabled={!canAct || busy || !answer.trim()}>
              {busy ? gt("Sending…") : gt("Send my answer")}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setWriting(false)}>
              <T>Cancel</T>
            </Button>
          </>
        ) : (
          <>
            {proposal ? (
              <Button
                size="sm"
                disabled={!canAct || busy}
                onClick={() => void submit(championApprovalAnswer(proposal.action))}
              >
                {busy ? gt("Sending…") : gt("Approve proposed")}
              </Button>
            ) : null}
            <Button
              size="sm"
              variant={proposal ? "outline" : "default"}
              disabled={!canAct || busy}
              onClick={() => setWriting(true)}
            >
              {proposal ? gt("Answer differently") : gt("Answer", { $context: "verb" })}
            </Button>
          </>
        )}
      </div>
      {error ? (
        <p role="alert" className="text-destructive-foreground text-xs">
          {error}
        </p>
      ) : null}
    </form>
  );
}

function HowItGotHere(props: { readonly events: ReadonlyArray<ChampionActivity> }) {
  const gt = useGT();
  const m = useMessages();
  if (props.events.length === 0) return null;
  return (
    <Disclosure label={gt("How it got here")}>
      <div className="flex flex-col gap-2 text-xs">
        {props.events.length > 0 ? (
          <ol className="flex flex-col gap-1">
            {props.events.map((event) => (
              <li key={event.id} className="flex flex-wrap gap-x-2">
                <span className="w-24 shrink-0 text-muted-foreground">
                  <ScheduledRelativeLabel value={event.at} />
                </span>
                <span className="min-w-0 flex-1">
                  {activityTitle(event.kind, m)}
                  {event.text ? (
                    <span className="text-muted-foreground"> · {event.text}</span>
                  ) : null}
                </span>
              </li>
            ))}
          </ol>
        ) : null}
      </div>
    </Disclosure>
  );
}

function FindingControls(props: {
  readonly environmentId: EnvironmentId;
  readonly championId: string;
  readonly finding: ChampionFinding;
}) {
  const { finding } = props;
  const gt = useGT();
  const m = useMessages();
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
        setError(championFailureMessage(squashAtomCommandFailure(result), "finding", m));
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
              <T>Dismiss</T>
            </Button>
          ) : null}
          {canReopenChampionFinding(finding) ? (
            <Button
              size="xs"
              variant="outline"
              disabled={!canAct}
              onClick={() => setAsking("reopen")}
            >
              <T>Reopen</T>
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
            aria-label={asking === "dismiss" ? gt("Why dismiss this?") : gt("Why reopen this?")}
            placeholder={asking === "dismiss" ? gt("Why dismiss this?") : gt("Why reopen this?")}
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
          <Button size="xs" type="submit" disabled={!canAct || busy || !reason.trim()}>
            {asking === "dismiss" ? gt("Dismiss") : gt("Reopen")}
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
            <T>Cancel</T>
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
  readonly children: React.ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const Chevron = open ? ChevronDownIcon : ChevronRightIcon;
  return (
    <div>
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
  readonly onChanged: () => void;
}) {
  const { finding } = props;
  const gt = useGT();
  const pending = pendingChampionDecision(finding);
  const closed = championFindingIsClosed(finding);
  const follow = (
    <>
      <WorkLinks
        environmentId={props.environmentId}
        threadId={finding.escalationThreadId ?? null}
        threadLabel={closed ? gt("Case", { $context: "an Inbox case thread" }) : gt("Open case")}
        specUrl={null}
        revision={finding.revision}
      />
      {props.archived ? (
        <p className="text-muted-foreground text-xs">
          <T>Older settled finding, kept for reference. It can&apos;t be changed from here.</T>
        </p>
      ) : (
        <FindingControls
          environmentId={props.environmentId}
          championId={props.championId}
          finding={finding}
        />
      )}
      <HowItGotHere events={props.events} />
    </>
  );
  const decisionAnswer = finding.decision ? (
    <DecisionAnswer
      environmentId={props.environmentId}
      championId={props.championId}
      findingId={finding.id}
      decision={finding.decision}
      onChanged={props.onChanged}
    />
  ) : null;
  if (pending) {
    return (
      <div className="flex flex-col gap-2.5 p-3 text-sm">
        <div className="flex items-start justify-between gap-3">
          <p className="min-w-0 wrap-break-word whitespace-pre-wrap font-medium">
            {pending.question}
          </p>
          <span className="shrink-0 text-muted-foreground text-xs">
            <ScheduledRelativeLabel value={pending.requestedAt} />
          </span>
        </div>
        {decisionAnswer}
        <Disclosure label={gt("Details")}>
          <div className="flex flex-col gap-3 text-xs">
            <p>
              <T>
                <span className="text-muted-foreground">Found:</span> <Var>{finding.title}</Var>
              </T>
            </p>
            {pending.proposal?.otherOptions ? (
              <p>
                <T>
                  <span className="text-muted-foreground">Other options:</span>{" "}
                  <Var>{pending.proposal.otherOptions}</Var>
                </T>
              </p>
            ) : null}
            {finding.evidence ? <p className="whitespace-pre-wrap">{finding.evidence}</p> : null}
            {follow}
          </div>
        </Disclosure>
      </div>
    );
  }
  return (
    <EntryRow
      title={finding.title}
      subtitle={finding.evidence}
      badge={{
        label: CHAMPION_FINDING_STATUS_LABELS[finding.status],
        variant: FINDING_VARIANTS[finding.status],
      }}
      at={finding.updatedAt}
    >
      {finding.evidence ? <p className="whitespace-pre-wrap">{finding.evidence}</p> : null}
      {decisionAnswer}
      {follow}
    </EntryRow>
  );
}

function LearningDetail(props: {
  readonly environmentId: EnvironmentId;
  readonly championId: string;
  readonly learningRef: NonNullable<ChampionActivity["learningRef"]>;
}) {
  const { learningRef } = props;
  const query = useEnvironmentQuery(
    serverEnvironment.championLearning({
      environmentId: props.environmentId,
      input: {
        id: props.championId,
        topic: learningRef.topic,
        revisionId: learningRef.revisionId,
        observations: [],
      },
    }),
  );
  // An older server ignores the revision filter and answers with other revisions of the topic.
  const revision = query.data?.revisions.find(
    (candidate) =>
      candidate.id === learningRef.revisionId && candidate.learningId === learningRef.learningId,
  );
  if (revision) {
    return (
      <div className="flex flex-col gap-1 text-muted-foreground text-xs">
        {learningNoteProse(revision).map((line) => (
          <p key={line}>{line}</p>
        ))}
      </div>
    );
  }
  if (query.error) {
    return (
      <div className="flex flex-wrap items-center gap-2 text-muted-foreground text-xs">
        <p>
          <T>Its source couldn&apos;t load.</T>
        </p>
        <Button size="xs" variant="ghost-muted" onClick={() => query.refresh()}>
          <T>Try again</T>
        </Button>
      </div>
    );
  }
  return (
    <p role="status" className="text-muted-foreground text-xs">
      {query.data === null ? (
        <T>Loading its source…</T>
      ) : (
        <T>Its source isn&apos;t available on this machine.</T>
      )}
    </p>
  );
}

function RunModel(props: {
  readonly environmentId: EnvironmentId;
  readonly selection: ModelSelection;
}) {
  return (
    <ModelLabel
      environmentId={props.environmentId}
      instanceId={props.selection.instanceId}
      model={props.selection.model}
      className="inline-flex"
    />
  );
}

function RecentRuns(props: {
  readonly environmentId: EnvironmentId;
  readonly state: ChampionRuntimeState | null;
}) {
  const [all, setAll] = useState(false);
  const gt = useGT();
  const m = useMessages();
  if (props.state === null) return null;
  const runs = championRecentRuns(props.state);
  if (runs.length === 0) return null;
  return (
    <Disclosure label={gt("Recent runs and models")}>
      <p className="text-muted-foreground text-xs">
        <T>
          Each run keeps the model it started with. Changing Champion models only affects later
          runs.
        </T>
      </p>
      <ul className="flex flex-col divide-y overflow-hidden rounded-lg border bg-card text-xs">
        {(all ? runs : runs.slice(0, RUNS_SHOWN)).map((run) => (
          <li key={run.key} className="flex flex-col gap-1 px-3 py-2">
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="text-muted-foreground">
                <ScheduledRelativeLabel value={run.at} />
              </span>
              <span>{m(RUN_KIND_LABELS[run.kind])}</span>
              {run.role ? (
                <AgentRoleChip role={run.role} />
              ) : (
                <Badge variant="outline">
                  <T>Fixed model</T>
                </Badge>
              )}
              <span className="flex-1" />
              <ThreadLink
                environmentId={props.environmentId}
                threadId={run.threadId}
                label={gt("Open", { $context: "verb, opens a thread" })}
              />
            </span>
            <span className="flex flex-wrap items-center gap-x-1 text-muted-foreground">
              {run.actual !== null && sameChampionModel(run.resolved, run.actual) ? (
                <T>
                  Started and ran on{" "}
                  <Var>
                    <RunModel environmentId={props.environmentId} selection={run.resolved} />
                  </Var>
                </T>
              ) : run.actual === null ? (
                <T>
                  Started on{" "}
                  <Var>
                    <RunModel environmentId={props.environmentId} selection={run.resolved} />
                  </Var>{" "}
                  · Ran on not confirmed
                </T>
              ) : (
                <T>
                  Started on{" "}
                  <Var>
                    <RunModel environmentId={props.environmentId} selection={run.resolved} />
                  </Var>{" "}
                  · Ran on{" "}
                  <Var>
                    <RunModel environmentId={props.environmentId} selection={run.actual} />
                  </Var>
                </T>
              )}
            </span>
          </li>
        ))}
      </ul>
      {!all && runs.length > RUNS_SHOWN ? (
        <Button size="xs" variant="ghost-muted" className="self-start" onClick={() => setAll(true)}>
          <T>
            Show <Var>{runs.length - RUNS_SHOWN}</Var> more
          </T>
        </Button>
      ) : null}
    </Disclosure>
  );
}

function EventEntry(props: {
  readonly environmentId: EnvironmentId;
  readonly championId: string;
  readonly event: ChampionActivity;
}) {
  const { event } = props;
  const gt = useGT();
  const m = useMessages();
  return (
    <EntryRow title={activityTitle(event.kind, m)} subtitle={event.text} at={event.at}>
      {event.text ? <p className="whitespace-pre-wrap">{event.text}</p> : null}
      {event.learningRef ? (
        <LearningDetail
          environmentId={props.environmentId}
          championId={props.championId}
          learningRef={event.learningRef}
        />
      ) : null}
      {event.approval ? (
        <RelayedApproval environmentId={props.environmentId} approval={event.approval} />
      ) : (
        <WorkLinks
          environmentId={props.environmentId}
          threadId={event.threadId}
          threadLabel={gt("Open thread")}
          specUrl={event.specUrl}
          revision={event.revision}
        />
      )}
    </EntryRow>
  );
}

type ActivityListProps = {
  readonly environmentId: EnvironmentId;
  readonly championId: string;
  readonly view: ChampionActivityView;
  readonly loading: boolean;
  readonly runtimeState: ChampionRuntimeState | null;
  readonly onChanged: () => void;
};

const needsAnswer = (entry: ChampionActivityView["entries"][number]) =>
  entry.kind === "finding" && pendingChampionDecision(entry.finding) !== null;

function Entry(
  props: ActivityListProps & { readonly entry: ChampionActivityView["entries"][number] },
) {
  const { entry } = props;
  return entry.kind === "finding" ? (
    <FindingEntry
      environmentId={props.environmentId}
      championId={props.championId}
      finding={entry.finding}
      events={entry.events}
      archived={entry.archived}
      onChanged={props.onChanged}
    />
  ) : (
    <EventEntry
      environmentId={props.environmentId}
      championId={props.championId}
      event={entry.event}
    />
  );
}

/** The decisions waiting on the person, as cards they can answer in place. */
export function ChampionDecisionList(props: ActivityListProps) {
  const pending = props.view.entries.filter(needsAnswer);
  if (pending.length === 0) return null;
  return (
    <div className="flex flex-col divide-y overflow-hidden rounded-lg border border-warning/40 bg-warning/6">
      {pending.map((entry) => (
        <Entry
          key={entry.kind === "finding" ? entry.finding.id : entry.event.id}
          {...props}
          entry={entry}
        />
      ))}
    </div>
  );
}

export function ChampionActivityList(props: ActivityListProps) {
  const { view } = props;
  const entries = view.entries.filter((entry) => !needsAnswer(entry));
  const [allShown, setAllShown] = useState(false);
  const shown = allShown ? entries : entries.slice(0, ENTRIES_SHOWN);
  const [quietOpen, setQuietOpen] = useState(false);
  const gt = useGT();
  const QuietChevron = quietOpen ? ChevronDownIcon : ChevronRightIcon;
  return (
    <>
      <div className="flex flex-col divide-y overflow-hidden rounded-lg border bg-card">
        {shown.map((entry) => (
          <Entry
            key={entry.kind === "finding" ? entry.finding.id : entry.event.id}
            {...props}
            entry={entry}
          />
        ))}
        {entries.length === 0 ? (
          <p className="px-3 py-2.5 text-muted-foreground text-sm">
            {props.loading ? <T>Loading activity…</T> : <T>Nothing else has happened yet.</T>}
          </p>
        ) : null}
      </div>
      {entries.length > shown.length ? (
        <Button
          size="xs"
          variant="ghost-muted"
          className="self-start"
          onClick={() => setAllShown(true)}
        >
          <ChevronRightIcon aria-hidden />
          {gt("{count} older", { count: entries.length - shown.length })}
        </Button>
      ) : null}
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
            {gt("{count, plural, =1 {1 quiet check} other {{count} quiet checks}}", {
              count: view.quiet.length,
            })}
          </Button>
          {quietOpen ? (
            <ul className="flex flex-col gap-1 text-xs">
              {view.quiet.slice(0, QUIET_SHOWN).map((event) => (
                <li key={event.id} className="flex flex-wrap gap-x-2">
                  <span className="w-24 shrink-0 text-muted-foreground">
                    <ScheduledRelativeLabel value={event.at} />
                  </span>
                  <span className="min-w-0 flex-1">{event.text || gt("Check reported.")}</span>
                  {event.threadId !== null ? (
                    <ThreadLink
                      environmentId={props.environmentId}
                      threadId={event.threadId}
                      label={gt("Open", { $context: "verb, opens a thread" })}
                    />
                  ) : null}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
      <RecentRuns environmentId={props.environmentId} state={props.runtimeState} />
    </>
  );
}
