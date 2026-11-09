import {
  canDismissChampionFinding,
  canReopenChampionFinding,
  CHAMPION_FINDING_STATUS_LABELS,
  championApprovalAnswer,
  championApprovalWhen,
  championFailureMessage,
  championFindingIsClosed,
  type ChampionFindingRuntime,
  championFindingRuntime,
  type ChampionResearchTone,
  type ChampionResearchView,
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
import * as Schema from "effect/Schema";
import { ChevronDownIcon, ChevronRightIcon, ExternalLinkIcon } from "lucide-react";
import { useState } from "react";

import { readLocalApi } from "../../localApi";
import { cn, randomUUID } from "../../lib/utils";
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
  championDecisionBinding,
  type ChampionDecisionBinding,
  championDecisionBindingChanged,
  championRecentRuns,
  recommendationSupport,
  safeExternalUrl,
  sameChampionModel,
} from "./champions.logic";
import { FINDING_VARIANTS } from "./championsPresentation";
import { useChampionCommandAllowed } from "./useChampionAction";

const QUIET_SHOWN = 5;
const ENTRIES_SHOWN = 3;
const DECISION_ANSWER_MAX_LENGTH = 500;
const CANCEL_REASON_MAX_LENGTH = 500;
const RUNS_SHOWN = 10;
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
  const when = championApprovalWhen(approval.approvedAt);
  return (
    <p className="flex flex-wrap items-baseline gap-x-1.5 gap-y-0.5 text-muted-foreground text-xs">
      <Badge variant="success" size="sm">
        Approved by you
      </Badge>
      <span>through</span>
      <ThreadLink
        environmentId={props.environmentId}
        threadId={approval.threadId}
        label={approval.threadTitle.trim() || "an agent thread"}
      />
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
  /** Off while the recommendation this decision is about can't be read. */
  readonly readable: boolean;
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
  const [answer, setAnswer] = useState("");
  const [writing, setWriting] = useState(false);
  // What the person was reading when they started writing. An answer is only ever about that.
  const [drafted, setDrafted] = useState<ChampionDecisionBinding | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  if (decision.status === "resolved") {
    return (
      <div className="flex flex-col gap-0.5 text-sm">
        <p className="text-muted-foreground">{decision.question}</p>
        <p>Answered: {decision.answer}</p>
        {decision.approval ? (
          <RelayedApproval environmentId={props.environmentId} approval={decision.approval} />
        ) : null}
      </div>
    );
  }
  const proposal = decision.proposal;
  const current = championDecisionBinding(decision);
  const changed = championDecisionBindingChanged(drafted, current);
  const edit = (value: string) => {
    setAnswer(value);
    setError(null);
    if (!value.trim()) setDrafted(null);
    else if (drafted === null) setDrafted(current);
  };
  const submit = async (text: string) => {
    if (busy || !text.trim() || changed || !props.readable) return;
    setBusy(true);
    setError(null);
    const result = await act({
      environmentId: props.environmentId,
      input: {
        id: props.championId,
        findingId: props.findingId,
        action: "resolve_decision",
        decisionId: current.decisionId,
        ...(current.recommendationId === undefined
          ? {}
          : { recommendationId: current.recommendationId }),
        reason: text.trim(),
      },
    });
    setBusy(false);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      const conflict = isChampionError(failure) && failure.reason === "conflict";
      setError(
        conflict
          ? "This changed before your answer arrived, so it wasn't sent. It's still here."
          : championFailureMessage(failure, "decision"),
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
          <dt className="text-muted-foreground">Proposed</dt>
          <dd className="font-medium">{proposal.action}</dd>
          <dt className="text-muted-foreground">Why</dt>
          <dd className="text-muted-foreground">{proposal.why}</dd>
        </dl>
      ) : null}
      {changed ? (
        <div
          role="alert"
          className="flex flex-col items-start gap-1.5 text-warning-foreground text-xs"
        >
          <p>
            The recommendation changed while you were writing, so your answer wasn't sent. It's
            still here. Check it still fits what's above.
          </p>
          <Button size="xs" variant="outline" onClick={() => setDrafted(current)}>
            Keep my answer for this version
          </Button>
        </div>
      ) : null}
      {writing ? (
        <Textarea
          aria-label="Your answer"
          placeholder="Your answer goes to the champion's owner."
          maxLength={DECISION_ANSWER_MAX_LENGTH}
          value={answer}
          autoFocus
          onChange={(event) => edit(event.target.value)}
        />
      ) : null}
      <div className="flex flex-wrap gap-2">
        {writing ? (
          <>
            <Button
              size="sm"
              type="submit"
              disabled={!canAct || busy || !answer.trim() || changed || !props.readable}
            >
              {busy ? "Sending…" : "Send my answer"}
            </Button>
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => setWriting(false)}>
              Cancel
            </Button>
          </>
        ) : (
          <>
            {proposal ? (
              <Button
                size="sm"
                disabled={!canAct || busy || changed || !props.readable}
                onClick={() => void submit(championApprovalAnswer(proposal.action))}
              >
                {busy ? "Sending…" : "Approve proposed"}
              </Button>
            ) : null}
            <Button
              size="sm"
              variant={proposal ? "outline" : "default"}
              disabled={!canAct || busy || changed || !props.readable}
              onClick={() => setWriting(true)}
            >
              {proposal ? "Answer differently" : "Answer"}
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

const RESEARCH_DOTS: Record<ChampionResearchTone, string> = {
  running: "bg-info",
  done: "bg-success",
  warning: "bg-warning",
  failed: "bg-destructive",
  idle: "bg-muted-foreground/50",
};

function ResearchList(props: { readonly research: ChampionResearchView }) {
  return (
    <ul className="flex flex-col gap-1 text-xs">
      {props.research.branches.map((branch) => (
        <li key={branch.id} className="flex flex-wrap items-baseline gap-x-2">
          <span className="flex w-28 shrink-0 items-center gap-1.5">
            <span aria-hidden className={cn("size-1.5 rounded-full", RESEARCH_DOTS[branch.tone])} />
            {branch.status}
          </span>
          <span className="min-w-0 flex-1 basis-48">
            {branch.hypothesis}
            {branch.result ? (
              <span className="text-muted-foreground"> · {branch.result}</span>
            ) : null}
          </span>
        </li>
      ))}
    </ul>
  );
}

function ResearchControls(props: {
  readonly environmentId: EnvironmentId;
  readonly championId: string;
  readonly research: ChampionResearchView;
  readonly paused: boolean;
  readonly onChanged: () => void;
}) {
  const { research } = props;
  const cancel = useAtomCommand(serverEnvironment.cancelChampionInvestigation, {
    label: "champion cancel investigation",
    reportFailure: false,
  });
  const canCancel = useChampionCommandAllowed(
    serverEnvironment.cancelChampionInvestigation,
    props.environmentId,
  );
  // Kept across a failed send, so retrying is the same request rather than a second one.
  const [requestId, setRequestId] = useState<string | null>(null);
  const [reason, setReason] = useState("");
  const [sent, setSent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = async () => {
    if (busy || requestId === null || !reason.trim()) return;
    setBusy(true);
    setError(null);
    const result = await cancel({
      environmentId: props.environmentId,
      input: {
        id: props.championId,
        investigationId: research.investigationId,
        requestId,
        reason: reason.trim(),
      },
    });
    setBusy(false);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        setError(championFailureMessage(squashAtomCommandFailure(result), "investigation"));
      }
      return;
    }
    setSent(true);
    setRequestId(null);
    setReason("");
    props.onChanged();
  };
  return (
    <div className="flex flex-col gap-2">
      {research.attention ? <p className="text-warning-foreground">{research.attention}</p> : null}
      {props.paused && research.live ? (
        <p className="text-muted-foreground text-xs">
          Paused, so no new research starts. Anything already running carries on.
        </p>
      ) : null}
      {requestId !== null ? (
        <form
          className="flex flex-wrap items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <Input
            className="min-w-48 flex-1"
            nativeInput
            size="sm"
            autoFocus
            maxLength={CANCEL_REASON_MAX_LENGTH}
            aria-label="Why cancel this?"
            placeholder="Why cancel this?"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
          <Button size="xs" type="submit" disabled={!canCancel || busy || !reason.trim()}>
            {busy ? "Requesting…" : "Request cancel"}
          </Button>
          <Button
            size="xs"
            variant="ghost-muted"
            disabled={busy}
            onClick={() => {
              setRequestId(null);
              setError(null);
            }}
          >
            Keep running
          </Button>
        </form>
      ) : (
        <div className="flex flex-col gap-1.5">
          <Disclosure label="See research" openLabel="Hide research">
            <ResearchList research={research} />
          </Disclosure>
          {research.cancellable && !sent ? (
            <Button
              size="xs"
              variant="ghost-muted"
              className="self-start"
              disabled={!canCancel}
              onClick={() => setRequestId(randomUUID())}
            >
              Cancel research
            </Button>
          ) : null}
        </div>
      )}
      {research.cancelRequested || (sent && research.cancellable) ? (
        <p role="status" className="text-muted-foreground text-xs">
          Cancel requested. It stays this way until every task is confirmed stopped.
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="text-destructive-foreground text-xs">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function HowItGotHere(props: {
  readonly runtime: ChampionFindingRuntime;
  readonly events: ReadonlyArray<ChampionActivity>;
}) {
  const { recommendation, earlier, research } = props.runtime;
  const support = recommendation ? recommendationSupport(recommendation) : [];
  // Live or cancelled research already has its own "See research" beside the finding.
  const researchHere = research !== null && !research.live && research.summary === null;
  if (support.length === 0 && earlier.length === 0 && !researchHere && props.events.length === 0) {
    return null;
  }
  return (
    <Disclosure label="How it got here">
      <div className="flex flex-col gap-2 text-xs">
        {support.map((text) => (
          <p key={text} className="whitespace-pre-wrap">
            {text}
          </p>
        ))}
        {earlier.map((previous) => (
          <p key={previous.recommendationId} className="text-muted-foreground">
            Earlier, <ScheduledRelativeLabel value={previous.recordedAt} />:{" "}
            {previous.recommendation}
          </p>
        ))}
        {researchHere ? <ResearchList research={research} /> : null}
        {props.events.length > 0 ? (
          <ol className="flex flex-col gap-1">
            {props.events.map((event) => (
              <li key={event.id} className="flex flex-wrap gap-x-2">
                <span className="w-24 shrink-0 text-muted-foreground">
                  <ScheduledRelativeLabel value={event.at} />
                </span>
                <span className="min-w-0 flex-1">
                  {activityTitle(event.kind)}
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
  readonly runtimeState: ChampionRuntimeState | null;
  readonly runtimeFailed: boolean;
  readonly paused: boolean;
  readonly onChanged: () => void;
}) {
  const { finding } = props;
  const pending = pendingChampionDecision(finding);
  const closed = championFindingIsClosed(finding);
  const recent = championFindingRuntime(finding, props.runtimeState);
  const exact = useEnvironmentQuery(
    recent.recommendationMissing && finding.decision?.recommendationId !== undefined
      ? serverEnvironment.championRecommendation({
          environmentId: props.environmentId,
          input: {
            id: props.championId,
            findingId: finding.id,
            findingAttemptId: finding.attemptId,
            recommendationId: finding.decision.recommendationId,
          },
        })
      : null,
  );
  const runtime = championFindingRuntime(finding, props.runtimeState, exact.data);
  const { recommendation, research } = runtime;
  const live = research?.live === true;
  const changedRecommendation = recommendation !== null && runtime.earlier.length > 0;
  const follow = (
    <>
      {research !== null && (live || research.summary !== null) ? (
        <ResearchControls
          environmentId={props.environmentId}
          championId={props.championId}
          research={research}
          paused={props.paused}
          onChanged={props.onChanged}
        />
      ) : null}
      {finding.repairAttention ? (
        <p className="text-warning-foreground">{finding.repairAttention}</p>
      ) : null}
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
      ) : live ? null : (
        <FindingControls
          environmentId={props.environmentId}
          championId={props.championId}
          finding={finding}
        />
      )}
      <HowItGotHere runtime={runtime} events={props.events} />
    </>
  );
  const decisionAnswer = finding.decision ? (
    <DecisionAnswer
      environmentId={props.environmentId}
      championId={props.championId}
      findingId={finding.id}
      decision={finding.decision}
      readable={!runtime.recommendationMissing}
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
        {recommendation ? (
          <div className="flex flex-col gap-0.5">
            <p className="wrap-break-word whitespace-pre-wrap">{recommendation.recommendation}</p>
            <p className="text-muted-foreground text-xs">
              {changedRecommendation ? "Changed" : "Recommended"}{" "}
              <ScheduledRelativeLabel value={recommendation.recordedAt} />
            </p>
          </div>
        ) : runtime.recommendationMissing ? (
          <p role="status" className="text-muted-foreground text-xs">
            {props.runtimeFailed || exact.error !== null
              ? "Its recommendation couldn't load, so answering is off until it does."
              : "Loading its recommendation…"}
          </p>
        ) : null}
        {decisionAnswer}
        <Disclosure label="Details">
          <div className="flex flex-col gap-3 text-xs">
            <p>
              <span className="text-muted-foreground">Found: </span>
              {finding.title}
            </p>
            {pending.proposal?.otherOptions ? (
              <p>
                <span className="text-muted-foreground">Other options: </span>
                {pending.proposal.otherOptions}
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
      subtitle={research?.summary ?? finding.evidence}
      badge={
        research?.cancelRequested
          ? { label: "Cancel requested", variant: "info" }
          : research?.cannotConfirm
            ? { label: "Can't confirm", variant: "warning" }
            : live
              ? { label: "Investigating", variant: "info" }
              : {
                  label: CHAMPION_FINDING_STATUS_LABELS[finding.status],
                  variant: FINDING_VARIANTS[finding.status],
                }
      }
      at={finding.updatedAt}
    >
      {finding.evidence ? <p className="whitespace-pre-wrap">{finding.evidence}</p> : null}
      {decisionAnswer}
      {finding.decision?.status === "resolved" && recommendation ? (
        <Disclosure label="What it recommended">
          <p className="whitespace-pre-wrap text-xs">{recommendation.recommendation}</p>
          <p className="text-muted-foreground text-xs">
            Your answer was about the version from{" "}
            <ScheduledRelativeLabel value={recommendation.recordedAt} />
          </p>
        </Disclosure>
      ) : null}
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
        <p>Its source couldn't load.</p>
        <Button size="xs" variant="ghost-muted" onClick={() => query.refresh()}>
          Try again
        </Button>
      </div>
    );
  }
  return (
    <p role="status" className="text-muted-foreground text-xs">
      {query.data === null ? "Loading its source…" : "Its source isn't available on this machine."}
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
  if (props.state === null) return null;
  const runs = championRecentRuns(props.state);
  if (runs.length === 0) return null;
  return (
    <Disclosure label="Recent runs and models">
      <p className="text-muted-foreground text-xs">
        Each run keeps the role and model it started with. Changing a role or your role policy only
        affects later runs.
      </p>
      <ul className="flex flex-col divide-y overflow-hidden rounded-lg border bg-card text-xs">
        {(all ? runs : runs.slice(0, RUNS_SHOWN)).map((run) => (
          <li key={run.key} className="flex flex-col gap-1 px-3 py-2">
            <span className="flex flex-wrap items-center gap-x-2 gap-y-1">
              <span className="text-muted-foreground">
                <ScheduledRelativeLabel value={run.at} />
              </span>
              <span>{run.kind}</span>
              {run.role ? (
                <AgentRoleChip role={run.role} />
              ) : (
                <Badge variant="outline">Fixed model</Badge>
              )}
              <span className="flex-1" />
              <ThreadLink
                environmentId={props.environmentId}
                threadId={run.threadId}
                label="Open"
              />
            </span>
            <span className="flex flex-wrap items-center gap-x-1 text-muted-foreground">
              {run.actual !== null && sameChampionModel(run.resolved, run.actual) ? (
                <>
                  Started and ran on
                  <RunModel environmentId={props.environmentId} selection={run.resolved} />
                </>
              ) : (
                <>
                  Started on
                  <RunModel environmentId={props.environmentId} selection={run.resolved} />
                  {" · Ran on "}
                  {run.actual === null ? (
                    "not confirmed"
                  ) : (
                    <RunModel environmentId={props.environmentId} selection={run.actual} />
                  )}
                </>
              )}
            </span>
          </li>
        ))}
      </ul>
      {!all && runs.length > RUNS_SHOWN ? (
        <Button size="xs" variant="ghost-muted" className="self-start" onClick={() => setAll(true)}>
          Show {runs.length - RUNS_SHOWN} more
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
  return (
    <EntryRow title={activityTitle(event.kind)} subtitle={event.text} at={event.at}>
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
          threadLabel="Open thread"
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
  readonly runtimeFailed: boolean;
  readonly paused: boolean;
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
      runtimeState={props.runtimeState}
      runtimeFailed={props.runtimeFailed}
      paused={props.paused}
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
            {props.loading ? "Loading activity…" : "Nothing else has happened yet."}
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
          {`${entries.length - shown.length} older`}
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
      <RecentRuns environmentId={props.environmentId} state={props.runtimeState} />
    </>
  );
}
