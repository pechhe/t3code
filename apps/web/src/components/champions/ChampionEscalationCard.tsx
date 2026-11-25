import { championApprovalAnswer, championFailureMessage } from "@t3tools/client-runtime/champions";
import {
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import {
  ChampionError,
  type EnvironmentId,
  type OrchestrationV2ThreadChampion,
} from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import * as Schema from "effect/Schema";
import {
  CheckCircle2Icon,
  ChevronDownIcon,
  ChevronUpIcon,
  ExternalLinkIcon,
  ShieldCheckIcon,
} from "lucide-react";
import { T, useGT } from "gt-react";
import { useState } from "react";

import { cn } from "../../lib/utils";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { ModelLabel } from "../ModelLabel";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { championDecisionBinding } from "./champions.logic";
import {
  resolveEscalationCardState,
  selectEscalationFinding,
  selectEscalationMetricStrip,
} from "./championEscalationCard.logic";
import { useChampionCommandAllowed } from "./useChampionAction";

const EVIDENCE_COLLAPSE_THRESHOLD = 220;
const isChampionError = Schema.is(ChampionError);

export function ChampionEscalationCard(props: {
  readonly environmentId: EnvironmentId;
  readonly champion: OrchestrationV2ThreadChampion;
  readonly canInvestigate: boolean;
  readonly onInvestigate: (prompt: string) => Promise<void>;
}) {
  const gt = useGT();
  const detailQuery = useEnvironmentQuery(
    serverEnvironment.championDetail({
      environmentId: props.environmentId,
      input: { id: props.champion.id },
    }),
  );
  const act = useAtomCommand(serverEnvironment.championFindingAction, {
    label: "champion finding action",
    reportFailure: false,
  });
  const canAct = useChampionCommandAllowed(
    serverEnvironment.championFindingAction,
    props.environmentId,
  );

  const [evidenceExpanded, setEvidenceExpanded] = useState(false);
  const [asking, setAsking] = useState<"dismiss" | "reopen" | null>(null);
  const [reason, setReason] = useState("");
  const [busy, setBusy] = useState<"approve" | "dismiss" | "reopen" | "investigate" | null>(null);
  const [error, setError] = useState<string | null>(null);

  const detail = detailQuery.data ?? null;
  const finding = selectEscalationFinding(detail, props.champion.findingId);
  const metricStrip = selectEscalationMetricStrip(detail, finding);
  const state = resolveEscalationCardState({
    champion: props.champion,
    detail,
    finding,
  });

  const championName = detail?.champion.name ?? props.champion.name ?? gt("Champion");
  const checkModel = detail?.champion.nextModels?.checks?.model ?? null;
  const decision = finding?.decision?.status === "requested" ? finding.decision : null;
  const proposal = decision?.proposal ?? null;
  const evidenceText = finding?.evidence ?? null;
  const isLongEvidence =
    evidenceText !== null &&
    (evidenceText.length > EVIDENCE_COLLAPSE_THRESHOLD || evidenceText.includes("\n"));

  const handleApproveProposal = async () => {
    if (!finding || !decision || !proposal || busy !== null) return;
    setBusy("approve");
    setError(null);
    const binding = championDecisionBinding(decision);
    const result = await act({
      environmentId: props.environmentId,
      input: {
        id: props.champion.id,
        findingId: finding.id,
        action: "resolve_decision",
        decisionId: binding.decisionId,
        ...(binding.recommendationId === undefined
          ? {}
          : { recommendationId: binding.recommendationId }),
        reason: championApprovalAnswer(proposal.action),
      },
    });
    setBusy(null);
    if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
      const failure = squashAtomCommandFailure(result);
      const conflict = isChampionError(failure) && failure.reason === "conflict";
      setError(
        conflict
          ? gt("This changed before your approval arrived, so it wasn't sent.")
          : championFailureMessage(failure, "decision"),
      );
    }
  };

  const handleFindingReasonSubmit = async (action: "dismiss" | "reopen") => {
    if (!finding || busy !== null || !reason.trim()) return;
    setBusy(action);
    setError(null);
    const result = await act({
      environmentId: props.environmentId,
      input: {
        id: props.champion.id,
        findingId: finding.id,
        action,
        reason: reason.trim(),
      },
    });
    setBusy(null);
    if (result._tag === "Failure") {
      if (!isAtomCommandInterrupted(result)) {
        setError(championFailureMessage(squashAtomCommandFailure(result), "finding"));
      }
      return;
    }
    setAsking(null);
    setReason("");
  };

  const handleInvestigate = async () => {
    if (busy !== null || !props.canInvestigate) return;
    setBusy("investigate");
    setError(null);
    try {
      await props.onInvestigate(
        finding !== null
          ? gt("Investigate this finding and propose or implement a fix.")
          : gt(
              "Investigate why this Champion's checks are failing and propose or implement a fix.",
            ),
      );
    } catch (err) {
      setError(err instanceof Error ? err.message : gt("Could not start investigation."));
    } finally {
      setBusy(null);
    }
  };

  const resolvedLabel =
    state.resolution === "approved"
      ? gt("Approved")
      : state.resolution === "dismissed"
        ? gt("Dismissed")
        : state.resolution === "verified"
          ? gt("Verified")
          : gt("Resolved");

  return (
    <section
      aria-label={gt("Champion escalation")}
      className={cn(
        "chat-composer-lane shrink-0 border-b py-3",
        state.resolution !== null
          ? "border-border/70 bg-muted/25"
          : state.severity === "incident"
            ? "border-destructive/20 bg-destructive/4"
            : "border-warning/25 bg-warning/4",
      )}
    >
      <div className="mx-auto flex w-full min-w-0 max-w-(--chat-content-max-width) flex-col gap-2.5">
        <div className="flex flex-wrap items-center gap-x-2.5 gap-y-1">
          <span
            aria-hidden
            className={cn(
              "inline-flex size-5 shrink-0 items-center justify-center rounded",
              state.resolution !== null
                ? "bg-success/12 text-success-foreground"
                : state.severity === "incident"
                  ? "bg-destructive/14 text-destructive-foreground"
                  : "bg-warning/15 text-warning-foreground",
            )}
          >
            <ShieldCheckIcon className="size-3.5" />
          </span>
          <span className="font-medium text-sm text-foreground">{championName}</span>
          {props.champion.trigger ? (
            <span className="min-w-0 truncate text-xs text-muted-foreground">
              {props.champion.trigger}
            </span>
          ) : null}
          {checkModel ? (
            <span className="hidden items-center gap-1 text-xs text-muted-foreground sm:inline-flex">
              <ModelLabel
                environmentId={props.environmentId}
                instanceId={checkModel.instanceId}
                model={checkModel.model}
                className="inline-flex"
              />
            </span>
          ) : null}
          <div className="ml-auto flex shrink-0 items-center gap-2">
            {state.resolution !== null ? (
              <Badge variant={state.resolution === "dismissed" ? "outline" : "success"} size="sm">
                <CheckCircle2Icon aria-hidden />
                {resolvedLabel}
              </Badge>
            ) : null}
            <Link
              to="/champions"
              search={{ environmentId: props.environmentId, id: props.champion.id }}
              className="inline-flex items-center gap-1 text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline"
            >
              <T>Open in Champions</T>
              <ExternalLinkIcon aria-hidden className="size-3" />
            </Link>
          </div>
        </div>

        {evidenceText ? (
          <div className="flex flex-col gap-1">
            <p
              className={cn(
                "whitespace-pre-wrap text-sm text-foreground/90",
                !evidenceExpanded && isLongEvidence && "line-clamp-3",
              )}
            >
              {evidenceText}
            </p>
            {isLongEvidence ? (
              <button
                type="button"
                className="inline-flex w-fit items-center gap-1 text-xs text-muted-foreground hover:text-foreground"
                onClick={() => setEvidenceExpanded((value) => !value)}
              >
                {evidenceExpanded ? (
                  <>
                    <ChevronUpIcon aria-hidden className="size-3" />
                    <T>Show less</T>
                  </>
                ) : (
                  <>
                    <ChevronDownIcon aria-hidden className="size-3" />
                    <T>Show more</T>
                  </>
                )}
              </button>
            ) : null}
          </div>
        ) : null}

        {metricStrip ? (
          <div className="flex flex-wrap items-baseline gap-x-4 gap-y-1 rounded-md border border-border/60 bg-background/60 px-2.5 py-1.5 text-xs tabular-nums">
            <span className="font-medium text-foreground">{metricStrip.name}</span>
            {metricStrip.reading ? (
              <span className="text-foreground">
                <span className="text-muted-foreground">{gt("Reading")}: </span>
                {metricStrip.reading}
              </span>
            ) : null}
            {metricStrip.target ? (
              <span className="text-muted-foreground">
                {gt("Target")}: {metricStrip.target}
              </span>
            ) : null}
            {metricStrip.baseline ? (
              <span className="text-muted-foreground">
                {gt("Baseline")}: {metricStrip.baseline}
              </span>
            ) : null}
          </div>
        ) : null}

        {props.champion.findingId == null && detail ? (
          <div className="flex flex-col gap-1 text-xs text-foreground/90">
            {(detail.champion.consecutiveCheckFailures ?? 0) > 0 ? (
              <p className="font-medium text-warning-foreground tabular-nums">
                {gt(
                  "{count, plural, one {{count} consecutive check failure} other {{count} consecutive check failures}}",
                  { count: detail.champion.consecutiveCheckFailures ?? 0 },
                )}
              </p>
            ) : null}
            {detail.champion.attention.length > 0 ? (
              <ul className="flex flex-col gap-0.5 text-muted-foreground">
                {detail.champion.attention.map((line) => (
                  <li key={line}>{line}</li>
                ))}
              </ul>
            ) : null}
          </div>
        ) : null}

        {decision ? (
          <div className="flex flex-col gap-1.5 rounded-md border border-border/60 bg-background/70 px-3 py-2 text-xs">
            <p className="font-medium text-foreground">{decision.question}</p>
            {proposal ? (
              <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1">
                <dt className="text-muted-foreground">
                  <T>Proposed</T>
                </dt>
                <dd className="font-medium text-foreground">{proposal.action}</dd>
                <dt className="text-muted-foreground">
                  <T>Why</T>
                </dt>
                <dd className="text-muted-foreground">{proposal.why}</dd>
                {proposal.otherOptions ? (
                  <>
                    <dt className="text-muted-foreground">
                      <T>Other options</T>
                    </dt>
                    <dd className="text-muted-foreground">{proposal.otherOptions}</dd>
                  </>
                ) : null}
              </dl>
            ) : null}
          </div>
        ) : null}

        {asking !== null ? (
          <form
            className="flex flex-wrap items-center gap-2"
            onSubmit={(event) => {
              event.preventDefault();
              void handleFindingReasonSubmit(asking);
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
            <Button size="xs" type="submit" disabled={!canAct || busy !== null || !reason.trim()}>
              {asking === "dismiss" ? gt("Confirm dismiss") : gt("Confirm reopen")}
            </Button>
            <Button
              size="xs"
              variant="ghost-muted"
              disabled={busy !== null}
              onClick={() => {
                setAsking(null);
                setError(null);
              }}
            >
              <T>Cancel</T>
            </Button>
          </form>
        ) : (
          <div className="flex flex-wrap items-center gap-2">
            {state.canApproveProposal ? (
              <Button
                size="xs"
                disabled={!canAct || busy !== null}
                onClick={() => void handleApproveProposal()}
              >
                {busy === "approve" ? gt("Approving…") : gt("Approve proposal")}
              </Button>
            ) : null}
            {state.canInvestigate ? (
              <Button
                size="xs"
                disabled={!props.canInvestigate || busy !== null}
                onClick={() => void handleInvestigate()}
              >
                {busy === "investigate" ? gt("Starting…") : gt("Investigate & fix here")}
              </Button>
            ) : null}
            {state.canDismiss ? (
              <Button
                size="xs"
                variant="ghost-muted"
                disabled={!canAct || busy !== null}
                onClick={() => setAsking("dismiss")}
              >
                <T>Dismiss</T>
              </Button>
            ) : null}
            {state.canReopen ? (
              <Button
                size="xs"
                variant="outline"
                disabled={!canAct || busy !== null}
                onClick={() => setAsking("reopen")}
              >
                <T>Reopen</T>
              </Button>
            ) : null}
          </div>
        )}

        {error ? (
          <p role="alert" className="text-xs text-destructive-foreground">
            {error}
          </p>
        ) : null}

        {state.resolution === null ? (
          <p className="text-xs text-muted-foreground">
            <T>
              Replying runs on this thread's model with Champion context attached; background checks
              stay separate.
            </T>
          </p>
        ) : null}
      </div>
    </section>
  );
}
