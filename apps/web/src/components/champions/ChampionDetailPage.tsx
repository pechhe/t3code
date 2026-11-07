import { useAtomValue } from "@effect/atom-react";
import { championStatus, pendingChampionDecision } from "@t3tools/client-runtime/champions";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import type { ChampionDetail, ChampionSummary, EnvironmentId } from "@t3tools/contracts";
import { Link, useNavigate } from "@tanstack/react-router";
import {
  ArchiveIcon,
  ArchiveRestoreIcon,
  ChevronDownIcon,
  ChevronRightIcon,
  PencilIcon,
  PlayIcon,
} from "lucide-react";
import { useState } from "react";

import { requestConfirmDialog } from "../../confirmDialog";
import { useNowMinute } from "../../hooks/useNowMinute";
import { useChampionHistory } from "../../state/champions";
import { useProjects, useQuietThreadShell } from "../../state/entities";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { AGENT_ROLE_PRESENTATION } from "../AgentRoleChip";
import { ModelLabel } from "../ModelLabel";
import { ScheduledRelativeLabel } from "../scheduled/scheduledTaskParts";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Skeleton } from "../ui/skeleton";
import { Spinner } from "../ui/spinner";
import { Switch } from "../ui/switch";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ChampionActivityList, ChampionDecisionList } from "./ChampionActivityList";
import { ChampionLearnings, useChampionLearningCount } from "./ChampionLearnings";
import { Toggle, ToggleGroup } from "../ui/toggle-group";
import { ChampionRunStrip } from "./ChampionHowItWorks";
import { ClampedText } from "./ClampedText";
import { ChampionMetricRow } from "./ChampionMetrics";
import {
  championActivityView,
  latestGoalProgress,
  metricChange,
  metricTargetLabel,
  retiredMetrics,
} from "./champions.logic";
import { statusBadge } from "./championsPresentation";
import { ChampionMachineNotice } from "./ChampionMachineNotice";
import {
  useChampionAction,
  useChampionCommandAllowed,
  useChampionMachineConnected,
} from "./useChampionAction";

const MACHINE_NOT_CONNECTED = "This machine isn't connected right now.";
const SETUP_DISPATCH_FAILED_PREFIX = "Setup dispatch unavailable.";
const STAGE_ATTENTION: ReadonlySet<string> = new Set([
  "Accept metric definitions before enabling checks.",
  "Metric proposal awaits acceptance.",
]);

function SectionHeading(props: { readonly title: string; readonly children?: React.ReactNode }) {
  return (
    <div className="flex min-h-6.5 items-center justify-between gap-2">
      <h3 className="font-medium text-sm">{props.title}</h3>
      {props.children}
    </div>
  );
}

function ReasonedTooltip(props: {
  readonly reason: string | null;
  readonly children: React.ReactElement;
}) {
  if (props.reason === null) return props.children;
  return (
    <Tooltip>
      <TooltipTrigger render={<span className="inline-flex" />}>{props.children}</TooltipTrigger>
      <TooltipPopup side="top">{props.reason}</TooltipPopup>
    </Tooltip>
  );
}

function ProposalCard(props: {
  readonly environmentId: EnvironmentId;
  readonly detail: ChampionDetail;
  readonly setupRunning: boolean;
  readonly onEdit: () => void;
}) {
  const { environmentId, detail } = props;
  const { champion, proposal, metrics } = detail;
  const { busy, error, run } = useChampionAction();
  const accept = useAtomCommand(serverEnvironment.acceptChampionMetrics, {
    label: "champion accept metrics",
    reportFailure: false,
  });
  const setup = useAtomCommand(serverEnvironment.setupChampion, {
    label: "champion setup",
    reportFailure: false,
  });
  const discard = useAtomCommand(serverEnvironment.discardChampionProposal, {
    label: "champion discard proposal",
    reportFailure: false,
  });
  const setLifecycle = useAtomCommand(serverEnvironment.setChampionLifecycle, {
    label: "champion lifecycle",
    reportFailure: false,
  });
  const canDiscard = useChampionCommandAllowed(
    serverEnvironment.discardChampionProposal,
    environmentId,
  );
  const canAccept = useChampionCommandAllowed(
    serverEnvironment.acceptChampionMetrics,
    environmentId,
  );
  const canSetup = useChampionCommandAllowed(serverEnvironment.setupChampion, environmentId);
  const canSetLifecycle = useChampionCommandAllowed(
    serverEnvironment.setChampionLifecycle,
    environmentId,
  );
  if (proposal === null) return null;
  const initial = metrics.length === 0;
  const { id } = champion;
  const acceptStep = () =>
    accept({
      environmentId,
      input: { id, ...(proposal.id === undefined ? {} : { proposalId: proposal.id }) },
    });
  return (
    <div className="flex flex-col gap-3 rounded-lg border p-3 text-sm">
      <div className="flex flex-col gap-1">
        <p className="font-medium">
          {initial ? "Proposed metrics" : "Proposed changes to these metrics"}
        </p>
        <p className="text-muted-foreground text-xs">{proposal.reason}</p>
      </div>
      <ul className="flex flex-col gap-2">
        {proposal.metrics.map((metric) => {
          const change = metricChange(metric, metrics);
          return (
            <li key={metric.id} className="flex flex-col gap-0.5">
              <span className="flex flex-wrap items-baseline gap-x-2">
                <span className="font-medium">{metric.name}</span>
                <span className="text-muted-foreground text-xs">
                  {metric.unit} · {metricTargetLabel(metric)}
                  {(metric.required ?? true) ? "" : " · Optional"}
                </span>
                {initial ? null : change === "new" ? (
                  <Badge variant="info">New</Badge>
                ) : change === "new-series" ? (
                  <Badge variant="warning">New series</Badge>
                ) : null}
              </span>
              {metric.description ? (
                <span className="text-muted-foreground text-xs">{metric.description}</span>
              ) : null}
              <span className="text-muted-foreground text-xs">Source: {metric.source}</span>
            </li>
          );
        })}
      </ul>
      {!initial &&
      proposal.metrics.some((metric) => metricChange(metric, metrics) === "new-series") ? (
        <p className="text-muted-foreground text-xs">
          A new series measures something different. Current readings stay as history and aren't
          joined to it.
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        {initial ? (
          <>
            <Button
              size="sm"
              disabled={busy !== null || !canAccept || !canSetLifecycle}
              onClick={() =>
                void run("start", "metrics", [
                  acceptStep,
                  () => setLifecycle({ environmentId, input: { id, lifecycle: "active" } }),
                ])
              }
            >
              Accept and start
            </Button>
            <Button
              size="sm"
              variant="outline"
              disabled={busy !== null || !canAccept}
              onClick={() => void run("accept", "metrics", [acceptStep])}
            >
              Accept, stay paused
            </Button>
          </>
        ) : (
          <Button
            size="sm"
            disabled={busy !== null || !canAccept}
            onClick={() => void run("accept", "metrics", [acceptStep])}
          >
            Accept changes
          </Button>
        )}
        <Button size="sm" variant="ghost" disabled={busy !== null} onClick={props.onEdit}>
          Edit metrics
        </Button>
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="sm"
                variant="ghost"
                disabled={busy !== null || !canSetup || props.setupRunning}
                onClick={() =>
                  void run("propose", "setup", [() => setup({ environmentId, input: { id } })])
                }
              >
                {busy === "propose" ? "Starting…" : "Ask AI to propose again"}
              </Button>
            }
          />
          <TooltipPopup side="top">
            {props.setupRunning
              ? "A new proposal is already being prepared."
              : "Runs metric setup again. Its proposal replaces this one, and nothing changes until you accept."}
          </TooltipPopup>
        </Tooltip>
        <Button
          size="sm"
          variant="ghost"
          disabled={busy !== null || !canDiscard}
          onClick={() =>
            void run("discard", "discard", [() => discard({ environmentId, input: { id } })])
          }
        >
          {initial ? "Discard proposal" : "Keep current metrics"}
        </Button>
      </div>
      {error ? (
        <p role="alert" className="text-destructive-foreground text-xs">
          {error}
        </p>
      ) : null}
    </div>
  );
}

function SetupStatus(props: {
  readonly environmentId: EnvironmentId;
  readonly champion: ChampionSummary;
  readonly hasMetrics: boolean;
  readonly onRetry: () => void;
  readonly retryDisabled: boolean;
  readonly onCancel: () => void;
  readonly cancelDisabled: boolean;
}) {
  const { champion } = props;
  const thread = useQuietThreadShell(
    champion.setupThreadId === null
      ? null
      : scopeThreadRef(props.environmentId, champion.setupThreadId),
  );
  const notStarted =
    thread === null &&
    champion.attention.some((line) => line.startsWith(SETUP_DISPATCH_FAILED_PREFIX));
  const stopped = thread !== null && !threadRuntimeIsActive(thread.runtime);
  return (
    <div role="status" className="flex flex-col gap-2 rounded-lg border p-3 text-sm">
      <div className="flex flex-wrap items-center gap-1.5">
        {notStarted || stopped ? null : <Spinner aria-hidden className="size-3.5" />}
        {champion.classes ? (
          <span>{AGENT_ROLE_PRESENTATION[champion.classes.setup.role].label}</span>
        ) : (
          <ModelLabel
            environmentId={props.environmentId}
            instanceId={champion.setupModelSelection.instanceId}
            model={champion.setupModelSelection.model}
          />
        )}
        <span>
          {notStarted
            ? "couldn't start. Nothing was switched to another model."
            : stopped
              ? "stopped before proposing metrics."
              : "is reading the remit and the evidence available."}
        </span>
      </div>
      {props.hasMetrics ? (
        <p className="text-muted-foreground text-xs">
          Routine checks carry on, and your metrics stay as they are until you accept a change.
        </p>
      ) : null}
      <div className="flex flex-wrap items-center gap-2">
        {champion.setupThreadId !== null ? (
          <Button
            size="xs"
            variant="outline"
            render={
              <Link
                to="/$environmentId/$threadId"
                params={{
                  environmentId: props.environmentId,
                  threadId: champion.setupThreadId,
                }}
              />
            }
          >
            Open its thread
          </Button>
        ) : null}
        <ReasonedTooltip reason="Runs metric setup again. Metric definitions stay as they are until you accept a change.">
          <Button
            size="xs"
            variant="ghost-muted"
            disabled={props.retryDisabled}
            onClick={props.onRetry}
          >
            {notStarted || stopped ? "Ask AI to try again" : "Run again if it stopped"}
          </Button>
        </ReasonedTooltip>
        <Button
          size="xs"
          variant="ghost-muted"
          disabled={props.cancelDisabled}
          onClick={props.onCancel}
        >
          Cancel
        </Button>
      </div>
    </div>
  );
}

function RetiredMetrics(props: {
  readonly environmentId: EnvironmentId;
  readonly metrics: ReadonlyArray<ChampionDetail["metrics"][number]>;
  readonly definitions: ReadonlyArray<ChampionDetail["metrics"][number]>;
  readonly samples: Parameters<typeof ChampionMetricRow>[0]["samples"];
  readonly hasOlder: boolean;
  readonly schedule: ChampionSummary["schedule"];
}) {
  const [open, setOpen] = useState(false);
  const Chevron = open ? ChevronDownIcon : ChevronRightIcon;
  if (props.metrics.length === 0) return null;
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
        {props.metrics.length === 1
          ? "1 metric no longer tracked"
          : `${props.metrics.length} metrics no longer tracked`}
      </Button>
      {open ? (
        <div className="flex flex-col divide-y overflow-hidden rounded-lg border bg-card">
          {props.metrics.map((metric) => (
            <ChampionMetricRow
              key={metric.id}
              environmentId={props.environmentId}
              metric={metric}
              lifecycle="retired"
              schedule={props.schedule}
              latestSamples={null}
              definitions={props.definitions}
              samples={props.samples}
              hasOlder={props.hasOlder}
            />
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function ChampionDetailPage(props: {
  readonly environmentId: EnvironmentId;
  readonly summary: ChampionSummary;
}) {
  const { environmentId, summary } = props;
  const { id } = summary;
  const navigate = useNavigate();
  const detailQuery = useEnvironmentQuery(
    serverEnvironment.championDetail({ environmentId, input: { id } }),
  );
  const runtimeQuery = useEnvironmentQuery(
    serverEnvironment.championRuntimeState({ environmentId, input: { id } }),
  );
  const [pageCount, setPageCount] = useState(1);
  const [tab, setTab] = useState<"dashboard" | "learnings">("dashboard");
  const learningCount = useChampionLearningCount(environmentId, id);
  const history = useChampionHistory(environmentId, id, pageCount);
  const projects = useProjects();
  const { environments } = useEnvironments();
  const { busy, error, run } = useChampionAction();
  const setLifecycle = useAtomCommand(serverEnvironment.setChampionLifecycle, {
    label: "champion lifecycle",
    reportFailure: false,
  });
  const runCheck = useAtomCommand(serverEnvironment.runChampionCheck, {
    label: "champion check",
    reportFailure: false,
  });
  const setup = useAtomCommand(serverEnvironment.setupChampion, {
    label: "champion setup",
    reportFailure: false,
  });
  const cancelSetup = useAtomCommand(serverEnvironment.cancelChampionSetup, {
    label: "champion cancel setup",
    reportFailure: false,
  });
  const canCancelSetup = useChampionCommandAllowed(
    serverEnvironment.cancelChampionSetup,
    environmentId,
  );
  const canSetLifecycle = useChampionCommandAllowed(
    serverEnvironment.setChampionLifecycle,
    environmentId,
  );
  const canRunCheck = useChampionCommandAllowed(serverEnvironment.runChampionCheck, environmentId);
  const startLead = useAtomCommand(serverEnvironment.startChampionMetricsLead, {
    label: "champion metrics lead",
    reportFailure: false,
  });
  const canStartLead = useChampionCommandAllowed(
    serverEnvironment.startChampionMetricsLead,
    environmentId,
  );
  const canSetup = useChampionCommandAllowed(serverEnvironment.setupChampion, environmentId);
  const machineConnected = useChampionMachineConnected(environmentId);
  // Editing only opens a draft, which is kept until the machine can take it.
  const canEdit = useAtomValue(serverEnvironment.upsertChampion.permissionAtom(environmentId));

  const detail = detailQuery.data;
  const champion: ChampionSummary = summary;
  const metrics = detail?.metrics ?? [];
  const proposal = detail?.proposal ?? null;
  const retired = champion.lifecycle === "retired";
  const hasMetrics = metrics.length > 0;
  const setupRunning = (champion.outstandingSetupId ?? null) !== null;
  const nowMs = Date.parse(`${useNowMinute()}:00.000Z`);
  const checkRunning = champion.outstandingCheckId !== null;
  const project = projects.find(
    (candidate) => candidate.environmentId === environmentId && candidate.id === champion.projectId,
  );
  const machines = new Set(projects.map((candidate) => candidate.environmentId));
  const machine = environments.find((candidate) => candidate.environmentId === environmentId);
  // Decisions show as their own cards, so their attention lines would only repeat them.
  const attention = retired
    ? []
    : champion.attention.filter(
        (line) => !STAGE_ATTENTION.has(line) && !line.startsWith("Decision: "),
      );
  const activity = championActivityView(detail?.findings ?? [], history.activity, history.findings);
  const pendingDecisions = (detail?.findings ?? []).filter(
    (finding) => pendingChampionDecision(finding) !== null,
  ).length;
  const noLongerTracked = retiredMetrics(metrics, history.definitions);
  const ownerThreadExists = champion.lastCheckAt !== null || checkRunning;
  const goalProgress = latestGoalProgress(history.activity);
  const badge = statusBadge(championStatus(champion, nowMs));
  const paused = champion.lifecycle === "paused";

  const switchLifecycle = (lifecycle: "active" | "paused" | "retired") =>
    run(`lifecycle:${lifecycle}`, "lifecycle", [
      () => setLifecycle({ environmentId, input: { id, lifecycle } }),
    ]);
  const startSetup = () => run("setup", "setup", [() => setup({ environmentId, input: { id } })]);
  const startLeadFix = () =>
    run("lead", "setup", [
      async () => {
        const result = await startLead({ environmentId, input: { id } });
        if (result._tag === "Success")
          void navigate({
            to: "/$environmentId/$threadId",
            params: { environmentId, threadId: result.value.threadId },
          });
        return result;
      },
    ]);
  const startCheck = () =>
    run("check", "check", [() => runCheck({ environmentId, input: { id } })]);
  const openMetricsEditor = () =>
    void navigate({
      to: "/champions",
      search: { environmentId, id, view: "metrics" },
    });

  const retire = async () => {
    const message = `Retire ${champion.name}?\nChecks stop. Its metrics and history stay, and you can restore it later.`;
    const confirmed =
      (await requestConfirmDialog(message, { variant: "destructive" })) ?? window.confirm(message);
    if (confirmed) await switchLifecycle("retired");
  };

  const switchDisabledReason = !hasMetrics
    ? "Accept metrics first"
    : !machineConnected
      ? MACHINE_NOT_CONNECTED
      : !canSetLifecycle
        ? "This device can't change champions on this machine"
        : null;
  const runDisabledReason = !hasMetrics
    ? "Accept metrics first"
    : !machineConnected
      ? MACHINE_NOT_CONNECTED
      : !canRunCheck
        ? "This device can't run checks on this machine"
        : null;
  const askReviewReason = !machineConnected
    ? MACHINE_NOT_CONNECTED
    : !canSetup
      ? "This device can't start metric reviews on this machine"
      : setupRunning
        ? "A metric review is already running."
        : proposal !== null
          ? "Accept or discard the current proposal first."
          : "Runs this champion's metric setup to suggest changes. Your metric definitions stay as they are until you accept.";

  const decisionsSection = (
    <section className="flex flex-col gap-2" aria-label="Your decisions">
      <SectionHeading
        title={
          pendingDecisions === 1 ? "1 decision for you" : `${pendingDecisions} decisions for you`
        }
      />
      <ChampionDecisionList
        environmentId={environmentId}
        championId={id}
        view={activity}
        loading={history.loading || detail === null}
        runtimeState={runtimeQuery.data}
        runtimeFailed={runtimeQuery.error !== null}
        paused={paused}
        onChanged={() => {
          detailQuery.refresh();
          runtimeQuery.refresh();
        }}
      />
    </section>
  );
  const metricsSection = (
    <section className="flex flex-col gap-2" aria-label="Metrics">
      <SectionHeading title="Metrics">
        {hasMetrics && !retired ? (
          <div className="flex flex-wrap items-center justify-end gap-1">
            <Button size="xs" variant="ghost-muted" onClick={openMetricsEditor}>
              Edit metrics
            </Button>
            <ReasonedTooltip reason={askReviewReason}>
              <Button
                size="xs"
                variant="ghost-muted"
                disabled={!canSetup || setupRunning || proposal !== null || busy !== null}
                onClick={() => void startSetup()}
              >
                {busy === "setup" ? "Starting…" : "Ask AI to review metrics"}
              </Button>
            </ReasonedTooltip>
            <ReasonedTooltip
              reason={
                !machineConnected
                  ? MACHINE_NOT_CONNECTED
                  : !canStartLead
                    ? "This device can't start threads on this machine"
                    : "Starts a Spec lead thread that works out what's wrong with these metrics, plans a fix and builds it. You accept any new metrics here."
              }
            >
              <Button
                size="xs"
                variant="ghost-muted"
                disabled={!machineConnected || !canStartLead || busy !== null}
                onClick={() => void startLeadFix()}
              >
                {busy === "lead" ? "Starting…" : "Fix with a lead"}
              </Button>
            </ReasonedTooltip>
          </div>
        ) : null}
      </SectionHeading>
      {attention.length > 0 ? (
        <ul className="flex flex-col gap-0.5 text-warning-foreground text-xs">
          {attention.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}
      {setupRunning && !retired ? (
        <SetupStatus
          environmentId={environmentId}
          champion={champion}
          hasMetrics={hasMetrics}
          retryDisabled={!canSetup || busy !== null}
          onRetry={() => void startSetup()}
          cancelDisabled={!canCancelSetup || busy !== null}
          onCancel={() =>
            void run("cancel-setup", "cancel-setup", [
              () => cancelSetup({ environmentId, input: { id } }),
            ])
          }
        />
      ) : null}
      {detail && !retired ? (
        <ProposalCard
          environmentId={environmentId}
          detail={detail}
          setupRunning={setupRunning}
          onEdit={openMetricsEditor}
        />
      ) : null}
      {detailQuery.error && detail === null ? (
        <Alert variant="error">
          <AlertTitle>Metrics couldn't load</AlertTitle>
          <AlertDescription>{detailQuery.error}</AlertDescription>
          <AlertAction>
            <Button size="xs" variant="outline" onClick={() => detailQuery.refresh()}>
              Try again
            </Button>
          </AlertAction>
        </Alert>
      ) : detail === null ? (
        <div className="flex flex-col gap-2 rounded-lg border p-3" aria-busy="true">
          <Skeleton className="h-4 w-3/5" />
          <Skeleton className="h-4 w-4/5" />
        </div>
      ) : hasMetrics ? (
        <div className="flex flex-col divide-y overflow-hidden rounded-lg border bg-card">
          {metrics.map((metric) => (
            <ChampionMetricRow
              key={metric.id}
              environmentId={environmentId}
              metric={metric}
              lifecycle={champion.lifecycle}
              schedule={champion.schedule}
              latestSamples={detail.latestSamples ?? champion.latestSamples}
              definitions={history.definitions}
              samples={history.samples}
              hasOlder={history.hasOlder}
            />
          ))}
        </div>
      ) : proposal === null && !setupRunning && !retired ? (
        <div className="flex flex-col gap-2 rounded-lg border p-3 text-sm">
          <p className="text-muted-foreground">No metrics yet.</p>
          <div className="flex flex-wrap gap-2">
            <ReasonedTooltip reason="Runs this champion's metric setup. Nothing starts until you accept its proposal.">
              <Button
                size="sm"
                disabled={!canSetup || busy !== null}
                onClick={() => void startSetup()}
              >
                {busy === "setup" ? "Starting…" : "Ask AI to propose metrics"}
              </Button>
            </ReasonedTooltip>
            <Button size="sm" variant="ghost" onClick={openMetricsEditor}>
              Add metrics myself
            </Button>
          </div>
        </div>
      ) : null}
      {detail !== null ? (
        <RetiredMetrics
          environmentId={environmentId}
          metrics={noLongerTracked}
          definitions={history.definitions}
          samples={history.samples}
          hasOlder={history.hasOlder}
          schedule={champion.schedule}
        />
      ) : null}
    </section>
  );
  const activitySection = (
    <section className="flex flex-col gap-2" aria-label="Activity">
      <SectionHeading title="Activity" />
      <ChampionActivityList
        environmentId={environmentId}
        championId={id}
        view={activity}
        loading={history.loading || detail === null}
        runtimeState={runtimeQuery.data}
        runtimeFailed={runtimeQuery.error !== null}
        paused={paused}
        onChanged={() => {
          detailQuery.refresh();
          runtimeQuery.refresh();
        }}
      />
      {runtimeQuery.error && runtimeQuery.data === null ? (
        <Alert variant="error">
          <AlertTitle>Research and recommendations couldn't load</AlertTitle>
          <AlertDescription>
            Findings above may be missing them. This doesn't mean there are none.
          </AlertDescription>
          <AlertAction>
            <Button size="xs" variant="outline" onClick={() => runtimeQuery.refresh()}>
              Try again
            </Button>
          </AlertAction>
        </Alert>
      ) : null}
      {history.error ? (
        <Alert variant="error">
          <AlertTitle>History couldn't load</AlertTitle>
          <AlertDescription>
            Readings and activity below this point are unavailable, not empty.
          </AlertDescription>
          <AlertAction>
            <Button size="xs" variant="outline" onClick={() => history.refresh()}>
              Try again
            </Button>
          </AlertAction>
        </Alert>
      ) : null}
      {history.hasOlder ? (
        <Button
          size="xs"
          variant="ghost-muted"
          className="self-start"
          onClick={() => setPageCount((count) => count + 1)}
        >
          Load older readings and activity
        </Button>
      ) : null}
    </section>
  );

  return (
    <div className="@container/champion mx-auto flex w-full max-w-300 flex-col gap-4 p-4 sm:p-6">
      <div className="flex flex-col gap-2">
        {/* Wraps on available width, not the viewport: the list pane and Browser panel narrow it. */}
        <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
          <div className="flex min-w-0 grow basis-64 items-center gap-2">
            {retired ? null : (
              <ReasonedTooltip reason={switchDisabledReason}>
                <Switch
                  checked={champion.lifecycle === "active"}
                  aria-label={
                    champion.lifecycle === "active"
                      ? `Pause ${champion.name}`
                      : `Resume ${champion.name}`
                  }
                  disabled={switchDisabledReason !== null || busy !== null}
                  onCheckedChange={(active) => void switchLifecycle(active ? "active" : "paused")}
                />
              </ReasonedTooltip>
            )}
            <h2 className="min-w-0 flex-1 wrap-break-word font-semibold text-lg">
              {champion.name}
            </h2>
            <Badge variant={badge.variant}>{badge.label}</Badge>
          </div>
          <div className="flex flex-wrap items-center gap-2">
            {retired ? (
              <Button
                size="sm"
                variant="outline"
                disabled={!canSetLifecycle || busy !== null}
                onClick={() => void switchLifecycle("paused")}
              >
                <ArchiveRestoreIcon />
                Restore
              </Button>
            ) : (
              <>
                <ReasonedTooltip
                  reason={
                    runDisabledReason ??
                    (checkRunning
                      ? "A check is running. Running again retries it if it stopped without reporting."
                      : paused
                        ? "Runs a check now. Paused, so it only measures and reports, and starts no fixes."
                        : "Runs a check now instead of waiting for the next scheduled one.")
                  }
                >
                  <Button
                    size="sm"
                    variant="outline"
                    disabled={runDisabledReason !== null || busy !== null}
                    onClick={() => void startCheck()}
                  >
                    {checkRunning ? <Spinner aria-hidden className="size-3.5" /> : <PlayIcon />}
                    {checkRunning ? "Checking…" : "Check now"}
                  </Button>
                </ReasonedTooltip>
                <Button
                  size="sm"
                  variant="ghost"
                  disabled={!canEdit}
                  onClick={() =>
                    void navigate({ to: "/champions", search: { environmentId, id, view: "edit" } })
                  }
                >
                  <PencilIcon />
                  Edit
                </Button>
                <Tooltip>
                  <TooltipTrigger
                    render={
                      <Button
                        size="icon-sm"
                        variant="ghost"
                        aria-label={`Retire ${champion.name}`}
                        disabled={!canSetLifecycle || busy !== null}
                        onClick={() => void retire()}
                      >
                        <ArchiveIcon />
                      </Button>
                    }
                  />
                  <TooltipPopup side="top">Retire</TooltipPopup>
                </Tooltip>
              </>
            )}
          </div>
        </div>
        <ChampionMachineNotice environmentId={environmentId} />
        <div className="flex flex-col gap-1">
          <p className="text-sm">
            <span className="text-muted-foreground">Goal: </span>
            {champion.purpose}
          </p>
          {goalProgress ? (
            <ClampedText
              className="line-clamp-1 text-muted-foreground text-sm"
              text={goalProgress.text}
            >
              <span className="text-foreground">Latest: </span>
              {goalProgress.text}{" "}
              <span className="text-xs">
                (<ScheduledRelativeLabel value={goalProgress.at} />)
              </span>
            </ClampedText>
          ) : null}
        </div>
        <ChampionRunStrip
          environmentId={environmentId}
          champion={champion}
          runtimeState={runtimeQuery.data}
          projectTitle={project?.title ?? null}
          machineLabel={machines.size > 1 && machine ? machine.label : null}
          ownerThreadExists={ownerThreadExists}
        />
        {retired ? (
          <p className="text-muted-foreground text-xs">
            Retired. Checks and repairs don't run; history stays here. Restoring leaves it paused.
          </p>
        ) : null}
        {error ? (
          <p role="alert" className="text-destructive-foreground text-sm">
            {error}
          </p>
        ) : null}
      </div>

      <ToggleGroup
        aria-label="Champion view"
        value={[tab]}
        onValueChange={(values) => {
          if (values[0] === "dashboard" || values[0] === "learnings") setTab(values[0]);
        }}
      >
        <Toggle value="dashboard">Dashboard</Toggle>
        <Toggle value="learnings">
          {learningCount === undefined ? "Learnings" : `Learnings · ${learningCount}`}
        </Toggle>
      </ToggleGroup>
      {tab === "learnings" ? (
        <ChampionLearnings environmentId={environmentId} championId={id} />
      ) : (
        <div className="grid gap-5 @2xl/champion:grid-cols-[minmax(0,1fr)_minmax(0,1fr)] @2xl/champion:items-start">
          <div className="flex flex-col gap-5">
            {pendingDecisions > 0 ? decisionsSection : metricsSection}
          </div>
          <div className="flex flex-col gap-5">
            {pendingDecisions > 0 ? metricsSection : null}
            {activitySection}
          </div>
        </div>
      )}
    </div>
  );
}
