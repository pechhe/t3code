import { useAtomValue } from "@effect/atom-react";
import {
  canDismissChampionFinding,
  canReopenChampionFinding,
  CHAMPION_FINDING_STATUS_LABELS,
  CHAMPION_STATUS_LABELS,
  type ChampionAction,
  championApprovalAnswer,
  championApprovalWhen,
  championFailureMessage,
  championLoadFailureMessage,
  championReading,
  championReadingLabel,
  championReadingNote,
  championStatus,
  learningNoteProse,
  pendingChampionDecision,
  visibleChampions,
} from "@t3tools/client-runtime/champions";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type {
  ChampionActivity,
  ChampionFinding,
  ChampionRelayedApproval,
  ChampionSummary,
  EnvironmentId,
  ThreadId,
} from "@t3tools/contracts";
import { resolveEnvironmentMachineKind } from "@t3tools/contracts";
import { useFocusEffect, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { AsyncResult, type Atom } from "effect/reactivity";
import { useGT, useMessages } from "gt-react-native";
import { useState } from "react";
import { Platform, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { EnvironmentMachineSymbol } from "../../components/EnvironmentMachineSymbol";
import { m as resolveNow, type MessageResolver } from "../../i18n/messages";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { useEnvironmentPresentation } from "../../state/presentation";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSelectWorkspaceDetail } from "../layout/workspace/useSelectWorkspaceDetail";
import { useSettingsEnvironmentMenu } from "./components/SettingsEnvironmentFilterHeader";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { ChampionLearningsSection, useChampionLearningCount } from "./ChampionLearningsSection";
import { useSettingsEnvironmentFilter, type SettingsTarget } from "./settings-environment-filter";
import { settingsTargetsForProject } from "./settings-environment-filter.logic";

const REASON_MAX_LENGTH = 500;
const ACTIVITY_LIMIT = 50;

/** A session's grant outlives its connection, so the permission alone can allow a doomed command. */
function useCommandAllowed(
  command: { readonly permissionAtom: (environmentId: EnvironmentId) => Atom.Atom<boolean> },
  environmentId: EnvironmentId,
): boolean {
  const granted = useAtomValue(command.permissionAtom(environmentId));
  const { presentation } = useEnvironmentPresentation(environmentId);
  return presentation?.connection.phase === "connected" && granted;
}

function championFailure(
  result: AsyncResult.AsyncResult<unknown, unknown>,
  resolve: MessageResolver,
): string | null {
  return result._tag === "Failure" ? championLoadFailureMessage(result.cause, resolve) : null;
}

function ThreadLinkButton(props: {
  readonly label: string;
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
}) {
  const selectDetail = useSelectWorkspaceDetail();
  return (
    <Button
      label={props.label}
      tone="text"
      onPress={() =>
        selectDetail({
          name: "Thread",
          params: {
            environmentId: String(props.environmentId),
            threadId: String(props.threadId),
          },
        })
      }
    />
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
    <View className="gap-0.5">
      <Text className="text-sm text-foreground-muted">
        <Text className="text-sm font-t3-medium text-foreground">{gt("Approved by you")}</Text>{" "}
        {gt("through")}
      </Text>
      <ThreadLinkButton
        label={approval.threadTitle.trim() || gt("an agent thread")}
        environmentId={approval.sourceEnvironment?.id ?? props.environmentId}
        threadId={approval.threadId}
      />
      <Text className="text-sm text-foreground-muted">
        {approval.sourceEnvironment
          ? gt("On {machine} · ", { machine: approval.sourceEnvironment.label })
          : ""}
        {when ? `${when} · ` : ""}
        <Text className="text-sm italic text-foreground">“{approval.quote}”</Text>
      </Text>
    </View>
  );
}

function useNowMs() {
  const [now, setNow] = useState(Date.now);
  useFocusEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), 60_000);
    return () => clearInterval(timer);
  });
  return now;
}

function EnvironmentChampions(props: { readonly environment: SettingsTarget }) {
  const { environmentId } = props.environment;
  const navigation = useNavigation();
  const nowMs = useNowMs();
  const gt = useGT();
  const m = useMessages();
  const [showRetired, setShowRetired] = useState(false);
  const atom = serverEnvironment.championsLive({ environmentId, input: {} });
  const champions = useEnvironmentQuery(atom);
  const failure = championFailure(useAtomValue(atom), m);
  const retiredCount =
    champions.data?.champions.filter((champion) => champion.lifecycle === "retired").length ?? 0;
  return (
    <SettingsSection
      title={props.environment.label}
      titleIcon={
        <EnvironmentMachineSymbol
          kind={resolveEnvironmentMachineKind(props.environment.serverConfig)}
          size={16}
          tintColorClassName={
            Platform.OS === "android" ? "accent-primary" : "accent-foreground-muted"
          }
        />
      }
    >
      {failure ? (
        <Text className="p-4 text-base text-foreground-muted">{failure}</Text>
      ) : !champions.data ? (
        <Text className="p-4 text-base text-foreground-muted">{gt("Loading champions…")}</Text>
      ) : champions.data.champions.length === 0 ? (
        <Text className="p-4 text-base text-foreground-muted">
          {gt("No champions yet. Set one up from the web or desktop app.")}
        </Text>
      ) : (
        <>
          {visibleChampions(champions.data.champions, (champion) => champion, { showRetired }).map(
            (champion, index) => (
              <Pressable
                key={champion.id}
                accessibilityRole="button"
                accessibilityLabel={gt("Open {name}", { name: champion.name })}
                onPress={() =>
                  navigation.navigate("SettingsChampionDetail", { environmentId, id: champion.id })
                }
                className={
                  index === 0
                    ? "gap-1 px-4 py-4 active:opacity-70"
                    : "gap-1 border-t border-border-subtle px-4 py-4 active:opacity-70"
                }
              >
                <Text className="text-lg font-t3-medium text-foreground" numberOfLines={1}>
                  {champion.name}
                </Text>
                <Text className="text-sm text-foreground-muted" numberOfLines={2}>
                  {CHAMPION_STATUS_LABELS[championStatus(champion, nowMs)]} · {champion.purpose}
                </Text>
              </Pressable>
            ),
          )}
          {retiredCount > 0 ? (
            <View className="border-t border-border-subtle px-4 py-2">
              <Button
                label={
                  showRetired
                    ? gt("Hide retired")
                    : gt("Show retired ({count})", { count: retiredCount })
                }
                tone="text"
                size="compact"
                onPress={() => setShowRetired((current) => !current)}
              />
            </View>
          ) : null}
        </>
      )}
    </SettingsSection>
  );
}

export function SettingsChampionsRouteScreen() {
  const { selectedTargets, selectedProjectKey, projectGroups } = useSettingsEnvironmentFilter();
  const selectedGroup = projectGroups.find((group) => group.key === selectedProjectKey);
  const environments = settingsTargetsForProject(
    selectedTargets,
    selectedProjectKey === null ? null : selectedGroup,
  );
  const insets = useSafeAreaInsets();
  const environmentMenu = useSettingsEnvironmentMenu();
  const gt = useGT();
  return (
    <SettingsScreen title={gt("Champions")} menus={[environmentMenu]}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-5 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {environments.length > 0 ? (
          environments.map((environment) => (
            <EnvironmentChampions key={environment.environmentId} environment={environment} />
          ))
        ) : (
          <Text className="text-base text-foreground-muted">
            {gt("Connect a machine to see its champions.")}
          </Text>
        )}
      </ScrollView>
    </SettingsScreen>
  );
}

// Called from command callbacks, outside render, so the message resolves at call time.
function reportFailure(action: ChampionAction, result: AtomCommandResult<unknown, unknown>) {
  if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
    Dialog.alert(championFailureMessage(squashAtomCommandFailure(result), action, resolveNow));
  }
}

function LearningNote(props: {
  readonly environmentId: EnvironmentId;
  readonly championId: string;
  readonly learningRef: NonNullable<ChampionActivity["learningRef"]>;
}) {
  const { learningRef } = props;
  const gt = useGT();
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
  if (!revision) {
    return (
      <Text className="text-sm text-foreground-muted">
        {query.error
          ? gt("Its source couldn't load.")
          : query.data === null
            ? gt("Loading its source…")
            : gt("Its source isn't available on this machine.")}
      </Text>
    );
  }
  return (
    <View className="gap-1">
      {learningNoteProse(revision).map((line) => (
        <Text key={line} className="text-sm text-foreground-muted">
          {line}
        </Text>
      ))}
    </View>
  );
}

function LearningRow(props: {
  readonly environmentId: EnvironmentId;
  readonly championId: string;
  readonly event: ChampionActivity;
  readonly bordered: boolean;
}) {
  const { event } = props;
  const gt = useGT();
  const [open, setOpen] = useState(false);
  const body = (
    <>
      <Text className="text-base font-t3-medium text-foreground">{gt("Learned")}</Text>
      <Text className="text-sm text-foreground-muted">
        {new Date(event.at).toLocaleDateString()} · {event.text}
      </Text>
    </>
  );
  const className = props.bordered
    ? "gap-1 border-t border-border-subtle px-4 py-3"
    : "gap-1 px-4 py-3";
  if (!event.learningRef) return <View className={className}>{body}</View>;
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
      onPress={() => setOpen((value) => !value)}
      className={className}
    >
      {body}
      {open ? (
        <LearningNote
          environmentId={props.environmentId}
          championId={props.championId}
          learningRef={event.learningRef}
        />
      ) : null}
    </Pressable>
  );
}

function FindingActions(props: {
  readonly environmentId: EnvironmentId;
  readonly championId: string;
  readonly finding: ChampionFinding;
}) {
  const { environmentId, championId, finding } = props;
  const gt = useGT();
  const [busy, setBusy] = useState(false);
  // Survives a refused answer, so a failed send doesn't cost what was written.
  const [draft, setDraft] = useState("");
  const act = useAtomCommand(serverEnvironment.championFindingAction, {
    label: "champion finding action",
    reportFailure: false,
  });
  const canAct = useCommandAllowed(serverEnvironment.championFindingAction, environmentId);
  const pending = pendingChampionDecision(finding);
  const send = (
    failure: ChampionAction,
    action:
      | { readonly action: "dismiss" | "reopen" }
      | { readonly action: "resolve_decision"; readonly decisionId: string },
    text: string,
  ) => {
    const reason = text.trim();
    if (!reason) return;
    if (reason.length > REASON_MAX_LENGTH) {
      Dialog.alert(gt("Keep this to {count} characters.", { count: REASON_MAX_LENGTH }));
      return;
    }
    setBusy(true);
    void act({
      environmentId,
      input: { id: championId, findingId: finding.id, reason, ...action },
    }).then((result) => {
      setBusy(false);
      reportFailure(failure, result);
      if (failure === "decision") setDraft(result._tag === "Failure" ? reason : "");
    });
  };
  const ask = (
    title: string,
    message: string,
    confirmText: string,
    onConfirm: (value: string) => void,
    initialValue = "",
  ) => Dialog.prompt({ title, message, initialValue, confirmText, onConfirm });
  return (
    <View className="flex-row flex-wrap gap-2">
      {pending?.proposal ? (
        <Button
          label={gt("Approve proposed")}
          disabled={!canAct || busy}
          onPress={() =>
            send(
              "decision",
              {
                action: "resolve_decision",
                decisionId: pending.id,
              },
              championApprovalAnswer(pending.proposal!.action),
            )
          }
        />
      ) : null}
      {pending ? (
        <Button
          label={pending.proposal ? gt("Answer differently") : gt("Answer", { $context: "verb" })}
          disabled={!canAct || busy}
          onPress={() =>
            ask(
              gt("Answer", { $context: "verb" }),
              pending.question,
              gt("Send"),
              (answer) =>
                send(
                  "decision",
                  {
                    action: "resolve_decision",
                    decisionId: pending.id,
                  },
                  answer,
                ),
              draft,
            )
          }
        />
      ) : null}
      {canDismissChampionFinding(finding) ? (
        <Button
          label={gt("Dismiss")}
          tone="text"
          disabled={!canAct || busy}
          onPress={() =>
            ask(gt("Dismiss finding"), gt("Why doesn't this need work?"), gt("Dismiss"), (reason) =>
              send("finding", { action: "dismiss" }, reason),
            )
          }
        />
      ) : null}
      {canReopenChampionFinding(finding) ? (
        <Button
          label={gt("Reopen")}
          tone="text"
          disabled={!canAct || busy}
          onPress={() =>
            ask(
              gt("Reopen finding"),
              gt("Why does this need another look?"),
              gt("Reopen"),
              (reason) => send("finding", { action: "reopen" }, reason),
            )
          }
        />
      ) : null}
    </View>
  );
}

function ChampionControls(props: {
  readonly environmentId: EnvironmentId;
  readonly champion: ChampionSummary;
  readonly hasMetrics: boolean;
}) {
  const { environmentId, champion } = props;
  const { id } = champion;
  const gt = useGT();
  const [busy, setBusy] = useState(false);
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
  const startLead = useAtomCommand(serverEnvironment.startChampionMetricsLead, {
    label: "champion metrics lead",
    reportFailure: false,
  });
  const selectDetail = useSelectWorkspaceDetail();
  const canStartLead = useCommandAllowed(serverEnvironment.startChampionMetricsLead, environmentId);
  const canSetup = useCommandAllowed(serverEnvironment.setupChampion, environmentId);
  const canCancelSetup = useCommandAllowed(serverEnvironment.cancelChampionSetup, environmentId);
  const canSetLifecycle = useCommandAllowed(serverEnvironment.setChampionLifecycle, environmentId);
  const canRunCheck = useCommandAllowed(serverEnvironment.runChampionCheck, environmentId);
  const act = async (
    action: ChampionAction,
    steps: ReadonlyArray<() => Promise<AtomCommandResult<unknown, unknown>>>,
  ) => {
    if (busy) return;
    setBusy(true);
    for (const step of steps) {
      const result = await step();
      reportFailure(action, result);
      if (result._tag === "Failure") break;
    }
    setBusy(false);
  };
  const lifecycleStep = (lifecycle: ChampionSummary["lifecycle"]) => () =>
    setLifecycle({ environmentId, input: { id, lifecycle } });

  if (champion.lifecycle === "retired") {
    return (
      <Button
        label={gt("Restore")}
        tone="secondary"
        disabled={!canSetLifecycle || busy}
        onPress={() => void act("lifecycle", [lifecycleStep("paused")])}
      />
    );
  }
  const setupRunning = (champion.outstandingSetupId ?? null) !== null;
  return (
    <View className="flex-row flex-wrap gap-2">
      {setupRunning ? (
        <Button
          label={gt("Cancel setup")}
          tone="secondary"
          disabled={!canCancelSetup || busy}
          onPress={() =>
            void act("cancel-setup", [() => cancelSetup({ environmentId, input: { id } })])
          }
        />
      ) : (
        <Button
          label={props.hasMetrics ? gt("Ask AI to review metrics") : gt("Ask AI to set up metrics")}
          tone="secondary"
          disabled={!canSetup || busy}
          onPress={() => void act("setup", [() => setup({ environmentId, input: { id } })])}
        />
      )}
      {props.hasMetrics ? (
        <Button
          label={gt("Fix with a lead")}
          accessibilityHint={gt(
            "Starts a Spec lead thread that plans and builds a fix for these metrics.",
          )}
          tone="secondary"
          disabled={!canStartLead || busy}
          onPress={() =>
            void act("setup", [
              async () => {
                const result = await startLead({ environmentId, input: { id } });
                if (result._tag === "Success")
                  selectDetail({
                    name: "Thread",
                    params: {
                      environmentId: String(environmentId),
                      threadId: String(result.value.threadId),
                    },
                  });
                return result;
              },
            ])
          }
        />
      ) : null}
      {props.hasMetrics ? (
        <Button
          label={champion.lifecycle === "active" ? gt("Pause") : gt("Resume")}
          tone="secondary"
          disabled={!canSetLifecycle || busy}
          onPress={() =>
            void act("lifecycle", [
              lifecycleStep(champion.lifecycle === "active" ? "paused" : "active"),
            ])
          }
        />
      ) : null}
      {props.hasMetrics ? (
        <Button
          label={champion.outstandingCheckId !== null ? gt("Checking…") : gt("Check now")}
          {...(champion.lifecycle === "paused"
            ? { accessibilityHint: gt("Paused, so this only measures and reports.") }
            : {})}
          tone="secondary"
          disabled={!canRunCheck || busy}
          onPress={() => void act("check", [() => runCheck({ environmentId, input: { id } })])}
        />
      ) : null}
      <Button
        label={gt("Retire")}
        tone="text"
        disabled={!canSetLifecycle || busy}
        onPress={() =>
          Dialog.confirm({
            title: gt("Retire {name}?", { name: champion.name }),
            message: gt("Checks stop. Its metrics and history stay, and you can restore it later."),
            confirmText: gt("Retire"),
            destructive: true,
            onConfirm: () => void act("lifecycle", [lifecycleStep("retired")]),
          })
        }
      />
    </View>
  );
}

function FindingRow(props: {
  readonly environmentId: EnvironmentId;
  readonly championId: string;
  readonly finding: ChampionFinding;
  readonly bordered: boolean;
}) {
  const { finding } = props;
  const gt = useGT();
  const [detailsOpen, setDetailsOpen] = useState(false);
  return (
    <View
      className={
        props.bordered ? "gap-1 border-t border-border-subtle px-4 py-3" : "gap-1 px-4 py-3"
      }
    >
      <Text className="text-base font-t3-medium text-foreground">{finding.title}</Text>
      <Text className="text-sm text-foreground-muted">
        {pendingChampionDecision(finding)
          ? gt("Needs you")
          : CHAMPION_FINDING_STATUS_LABELS[finding.status]}
        {finding.evidence && !pendingChampionDecision(finding)?.proposal
          ? ` · ${finding.evidence}`
          : ""}
      </Text>
      {finding.decision ? (
        <Text className="text-sm text-foreground">
          {finding.decision.status === "resolved"
            ? gt("{question} Answered: {answer}", {
                question: finding.decision.question,
                answer: finding.decision.answer ?? "",
              })
            : finding.decision.question}
        </Text>
      ) : null}
      {finding.decision?.status === "resolved" && finding.decision.approval ? (
        <RelayedApproval environmentId={props.environmentId} approval={finding.decision.approval} />
      ) : null}
      {finding.decision?.status === "requested" && finding.decision.proposal ? (
        <View className="gap-0.5">
          <Text className="text-sm font-t3-medium text-foreground">
            {gt("Proposed: {action}", { action: finding.decision.proposal.action })}
          </Text>
          <Text className="text-sm text-foreground">
            {gt("Why: {why}", { why: finding.decision.proposal.why })}
          </Text>
          <Button
            label={detailsOpen ? gt("Hide details") : gt("Details")}
            tone="text"
            onPress={() => setDetailsOpen((open) => !open)}
          />
          {detailsOpen && finding.decision.proposal.otherOptions ? (
            <Text className="text-sm text-foreground-muted">
              {gt("Other options: {options}", {
                options: finding.decision.proposal.otherOptions,
              })}
            </Text>
          ) : null}
          {detailsOpen && finding.evidence ? (
            <Text className="text-sm text-foreground-muted">{finding.evidence}</Text>
          ) : null}
        </View>
      ) : null}
      <FindingActions
        environmentId={props.environmentId}
        championId={props.championId}
        finding={finding}
      />
      {finding.escalationThreadId != null ? (
        <ThreadLinkButton
          label={gt("Open case")}
          environmentId={props.environmentId}
          threadId={finding.escalationThreadId}
        />
      ) : null}
    </View>
  );
}

function ChampionDetailContent(props: {
  readonly environmentId: EnvironmentId;
  readonly id: string;
}) {
  const { environmentId, id } = props;
  const insets = useSafeAreaInsets();
  const nowMs = useNowMs();
  const gt = useGT();
  const m = useMessages();
  const detailAtom = serverEnvironment.championDetail({ environmentId, input: { id } });
  const detail = useEnvironmentQuery(detailAtom);
  const failure = championFailure(useAtomValue(detailAtom), m);
  const data = detail.data;
  const history = useEnvironmentQuery(
    serverEnvironment.championHistory({ environmentId, input: { id, limit: ACTIVITY_LIMIT } }),
  );
  const notes = (history.data?.activity ?? []).filter(
    (event) => event.kind === "learning-recorded",
  );
  const relayedAcceptances = (history.data?.activity ?? []).flatMap((event) =>
    event.kind === "metrics-accepted" && event.approval !== undefined
      ? [{ ...event, approval: event.approval }]
      : [],
  );
  const [tab, setTab] = useState<"dashboard" | "learnings">("dashboard");
  const learningCount = useChampionLearningCount(environmentId, id);
  return (
    <SettingsScreen title={data?.champion.name ?? gt("Champion")}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-5 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {data === null ? (
          <Text className="text-base text-foreground-muted">{failure ?? gt("Loading…")}</Text>
        ) : (
          <>
            <View className="gap-2">
              <Text className="text-sm font-t3-medium text-foreground-muted">
                {CHAMPION_STATUS_LABELS[championStatus(data.champion, nowMs)]}
              </Text>
              <Text className="text-base text-foreground">
                {gt("Goal: {goal}", { goal: data.champion.purpose })}
              </Text>
              {data.champion.attention.map((line) => (
                <Text key={line} className="text-sm text-foreground-muted">
                  {line}
                </Text>
              ))}
              <ChampionControls
                environmentId={environmentId}
                champion={data.champion}
                hasMetrics={data.metrics.length > 0}
              />
              <View className="flex-row flex-wrap gap-2">
                {data.champion.lastCheckAt !== null || data.champion.outstandingCheckId !== null ? (
                  <ThreadLinkButton
                    label={gt("Open owner thread")}
                    environmentId={environmentId}
                    threadId={data.champion.ownerThreadId}
                  />
                ) : null}
                {data.champion.setupThreadId !== null ? (
                  <ThreadLinkButton
                    label={gt("Open setup thread")}
                    environmentId={environmentId}
                    threadId={data.champion.setupThreadId}
                  />
                ) : null}
              </View>
            </View>
            <SegmentedControl
              role="tab"
              options={[
                { value: "dashboard", label: gt("Dashboard") },
                {
                  value: "learnings",
                  label:
                    learningCount === undefined
                      ? gt("Learnings")
                      : gt("Learnings · {count}", { count: learningCount }),
                },
              ]}
              selected={tab}
              onSelect={setTab}
            />
            {tab === "learnings" ? (
              <ChampionLearningsSection environmentId={environmentId} championId={id} />
            ) : null}
            {tab === "dashboard" ? (
              <SettingsSection title={gt("Metrics")}>
                {data.metrics.length === 0 ? (
                  <Text className="p-4 text-base text-foreground-muted">
                    {gt("No metrics yet.")}
                  </Text>
                ) : (
                  data.metrics.map((metric, index) => (
                    <View
                      key={metric.id}
                      className={
                        index === 0
                          ? "flex-row items-baseline gap-3 px-4 py-3"
                          : "flex-row items-baseline gap-3 border-t border-border-subtle px-4 py-3"
                      }
                    >
                      <Text className="min-w-0 flex-1 text-base text-foreground" numberOfLines={2}>
                        {metric.name}
                      </Text>
                      <View className="items-end">
                        <Text className="text-base font-t3-medium text-foreground">
                          {championReadingLabel(
                            championReading(metric, data.latestSamples, nowMs),
                            metric.unit,
                            m,
                          )}
                        </Text>
                        {championReadingNote(
                          championReading(metric, data.latestSamples, nowMs),
                          m,
                        ) ? (
                          <Text className="text-sm text-foreground-muted">
                            {championReadingNote(
                              championReading(metric, data.latestSamples, nowMs),
                              m,
                            )}
                          </Text>
                        ) : null}
                      </View>
                    </View>
                  ))
                )}
              </SettingsSection>
            ) : null}
            {tab === "dashboard" &&
            (data.findings.length > 0 || notes.length > 0 || relayedAcceptances.length > 0) ? (
              <SettingsSection title={gt("Activity", { $context: "a Champion's activity feed" })}>
                {data.findings.map((finding, index) => (
                  <FindingRow
                    key={finding.id}
                    environmentId={environmentId}
                    championId={id}
                    finding={finding}
                    bordered={index > 0}
                  />
                ))}
                {notes.map((event, index) => (
                  <LearningRow
                    key={event.id}
                    environmentId={environmentId}
                    championId={id}
                    event={event}
                    bordered={index > 0 || data.findings.length > 0}
                  />
                ))}
                {relayedAcceptances.map((event, index) => (
                  <View
                    key={event.id}
                    className={
                      index > 0 || data.findings.length > 0 || notes.length > 0
                        ? "gap-1 border-t border-border-subtle px-4 py-3"
                        : "gap-1 px-4 py-3"
                    }
                  >
                    <Text className="text-base font-t3-medium text-foreground">
                      {gt("Metrics accepted")}
                    </Text>
                    <Text className="text-sm text-foreground-muted">{event.text}</Text>
                    <RelayedApproval environmentId={environmentId} approval={event.approval} />
                  </View>
                ))}
              </SettingsSection>
            ) : null}
            <Text className="text-sm text-foreground-muted">
              {gt(
                "Create and edit champions, change their models, edit metrics, see which model each run used and read older activity from the web or desktop app.",
              )}
            </Text>
          </>
        )}
      </ScrollView>
    </SettingsScreen>
  );
}

export function SettingsChampionDetailRouteScreen({
  route,
}: StaticScreenProps<{
  readonly environmentId: EnvironmentId;
  readonly id: string;
}>) {
  return (
    <ChampionDetailContent
      key={`${route.params.environmentId}:${route.params.id}`}
      environmentId={route.params.environmentId}
      id={route.params.id}
    />
  );
}
