import { useAtomValue } from "@effect/atom-react";
import {
  canDismissChampionFinding,
  canReopenChampionFinding,
  CHAMPION_FINDING_STATUS_LABELS,
  CHAMPION_STATUS_LABELS,
  type ChampionAction,
  championFailureMessage,
  championLoadFailureMessage,
  championReading,
  championReadingLabel,
  championStatus,
  pendingChampionDecision,
} from "@t3tools/client-runtime/champions";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ChampionFinding, ChampionSummary, EnvironmentId, ThreadId } from "@t3tools/contracts";
import { resolveEnvironmentMachineKind } from "@t3tools/contracts";
import { useFocusEffect, useNavigation, type StaticScreenProps } from "@react-navigation/native";
import { AsyncResult } from "effect/reactivity";
import { useState } from "react";
import { Platform, Pressable, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";

import { EnvironmentMachineSymbol } from "../../components/EnvironmentMachineSymbol";
import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import * as Dialog from "../../components/ui/Dialog";
import { ScreenScrollView as ScrollView } from "../../components/ui/ScreenScrollView";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { useSelectWorkspaceDetail } from "../workspace/useSelectWorkspaceDetail";
import {
  SettingsEnvironmentFilterHeader,
  useSettingsEnvironmentMenu,
} from "./components/SettingsEnvironmentFilterHeader";
import { SettingsScreen } from "./components/SettingsScreen";
import { SettingsSection } from "./components/SettingsSection";
import { useSettingsEnvironmentFilter, type SettingsTarget } from "./settings-environment-filter";
import { settingsTargetsForProject } from "./settings-environment-filter.logic";

const REASON_MAX_LENGTH = 500;

function championFailure(result: AsyncResult.AsyncResult<unknown, unknown>): string | null {
  return result._tag === "Failure" ? championLoadFailureMessage(result.cause) : null;
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
  const atom = serverEnvironment.championsLive({ environmentId, input: {} });
  const champions = useEnvironmentQuery(atom);
  const failure = championFailure(useAtomValue(atom));
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
        <Text className="p-4 text-base text-foreground-muted">Loading champions…</Text>
      ) : champions.data.champions.length === 0 ? (
        <Text className="p-4 text-base text-foreground-muted">
          No champions yet. Set one up from the web or desktop app.
        </Text>
      ) : (
        champions.data.champions.map((champion, index) => (
          <Pressable
            key={champion.id}
            accessibilityRole="button"
            accessibilityLabel={`Open ${champion.name}`}
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
        ))
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
  return (
    <>
      <SettingsEnvironmentFilterHeader />
      <SettingsScreen title="Champions" menus={[useSettingsEnvironmentMenu()]}>
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
              Connect a machine to see its champions.
            </Text>
          )}
        </ScrollView>
      </SettingsScreen>
    </>
  );
}

function reportFailure(action: ChampionAction, result: AtomCommandResult<unknown, unknown>) {
  if (result._tag === "Failure" && !isAtomCommandInterrupted(result)) {
    Dialog.alert(championFailureMessage(squashAtomCommandFailure(result), action));
  }
}

function FindingActions(props: {
  readonly environmentId: EnvironmentId;
  readonly championId: string;
  readonly finding: ChampionFinding;
}) {
  const { environmentId, championId, finding } = props;
  const [busy, setBusy] = useState(false);
  const act = useAtomCommand(serverEnvironment.championFindingAction, {
    label: "champion finding action",
    reportFailure: false,
  });
  const canAct = useAtomValue(
    serverEnvironment.championFindingAction.permissionAtom(environmentId),
  );
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
      Dialog.alert(`Keep this to ${REASON_MAX_LENGTH} characters.`);
      return;
    }
    setBusy(true);
    void act({
      environmentId,
      input: { id: championId, findingId: finding.id, reason, ...action },
    }).then((result) => {
      setBusy(false);
      reportFailure(failure, result);
    });
  };
  const ask = (
    title: string,
    message: string,
    confirmText: string,
    onConfirm: (value: string) => void,
  ) => Dialog.prompt({ title, message, initialValue: "", confirmText, onConfirm });
  return (
    <View className="flex-row flex-wrap gap-2">
      {pending ? (
        <Button
          label="Answer"
          disabled={!canAct || busy}
          onPress={() =>
            ask("Answer", pending.question, "Send", (answer) =>
              send("decision", { action: "resolve_decision", decisionId: pending.id }, answer),
            )
          }
        />
      ) : null}
      {canDismissChampionFinding(finding) ? (
        <Button
          label="Dismiss"
          tone="text"
          disabled={!canAct || busy}
          onPress={() =>
            ask("Dismiss finding", "Why doesn't this need work?", "Dismiss", (reason) =>
              send("finding", { action: "dismiss" }, reason),
            )
          }
        />
      ) : null}
      {canReopenChampionFinding(finding) ? (
        <Button
          label="Reopen"
          tone="text"
          disabled={!canAct || busy}
          onPress={() =>
            ask("Reopen finding", "Why does this need another look?", "Reopen", (reason) =>
              send("finding", { action: "reopen" }, reason),
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
  readonly hasProposal: boolean;
}) {
  const { environmentId, champion } = props;
  const { id } = champion;
  const [busy, setBusy] = useState(false);
  const setLifecycle = useAtomCommand(serverEnvironment.setChampionLifecycle, {
    label: "champion lifecycle",
    reportFailure: false,
  });
  const runCheck = useAtomCommand(serverEnvironment.runChampionCheck, {
    label: "champion check",
    reportFailure: false,
  });
  const accept = useAtomCommand(serverEnvironment.acceptChampionMetrics, {
    label: "champion accept metrics",
    reportFailure: false,
  });
  const discard = useAtomCommand(serverEnvironment.discardChampionProposal, {
    label: "champion discard proposal",
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
  const canDiscard = useAtomValue(
    serverEnvironment.discardChampionProposal.permissionAtom(environmentId),
  );
  const canSetup = useAtomValue(serverEnvironment.setupChampion.permissionAtom(environmentId));
  const canCancelSetup = useAtomValue(
    serverEnvironment.cancelChampionSetup.permissionAtom(environmentId),
  );
  const canSetLifecycle = useAtomValue(
    serverEnvironment.setChampionLifecycle.permissionAtom(environmentId),
  );
  const canRunCheck = useAtomValue(
    serverEnvironment.runChampionCheck.permissionAtom(environmentId),
  );
  const canAccept = useAtomValue(
    serverEnvironment.acceptChampionMetrics.permissionAtom(environmentId),
  );
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
        label="Restore"
        tone="secondary"
        disabled={!canSetLifecycle || busy}
        onPress={() => void act("lifecycle", [lifecycleStep("paused")])}
      />
    );
  }
  const initial = props.hasProposal && !props.hasMetrics;
  const setupRunning = (champion.outstandingSetupId ?? null) !== null;
  return (
    <View className="flex-row flex-wrap gap-2">
      {props.hasProposal ? (
        <Button
          label={initial ? "Accept and start" : "Accept changes"}
          disabled={!canAccept || busy || (initial && !canSetLifecycle)}
          onPress={() =>
            void act("metrics", [
              () => accept({ environmentId, input: { id } }),
              ...(initial ? [lifecycleStep("active")] : []),
            ])
          }
        />
      ) : null}
      {props.hasProposal ? (
        <Button
          label={initial ? "Discard proposal" : "Keep current metrics"}
          tone="secondary"
          disabled={!canDiscard || busy}
          onPress={() => void act("discard", [() => discard({ environmentId, input: { id } })])}
        />
      ) : null}
      {setupRunning ? (
        <Button
          label="Cancel setup"
          tone="secondary"
          disabled={!canCancelSetup || busy}
          onPress={() =>
            void act("cancel-setup", [() => cancelSetup({ environmentId, input: { id } })])
          }
        />
      ) : (
        <Button
          label={
            props.hasProposal
              ? "Ask AI to propose again"
              : props.hasMetrics
                ? "Ask AI to review metrics"
                : "Ask AI to propose metrics"
          }
          tone="secondary"
          disabled={!canSetup || busy}
          onPress={() => void act("setup", [() => setup({ environmentId, input: { id } })])}
        />
      )}
      {props.hasMetrics ? (
        <Button
          label={champion.lifecycle === "active" ? "Pause" : "Resume"}
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
          label={
            champion.outstandingCheckId !== null
              ? "Checking…"
              : champion.lifecycle === "paused"
                ? "Measure only"
                : "Run check"
          }
          {...(champion.lifecycle === "paused"
            ? {
                accessibilityHint:
                  "Paused, so this only measures and reports. It starts no repairs.",
              }
            : {})}
          tone="secondary"
          disabled={!canRunCheck || busy}
          onPress={() => void act("check", [() => runCheck({ environmentId, input: { id } })])}
        />
      ) : null}
      <Button
        label="Retire"
        tone="text"
        disabled={!canSetLifecycle || busy}
        onPress={() =>
          Dialog.confirm({
            title: `Retire ${champion.name}?`,
            message: "Checks stop. Its metrics and history stay, and you can restore it later.",
            confirmText: "Retire",
            destructive: true,
            onConfirm: () => void act("lifecycle", [lifecycleStep("retired")]),
          })
        }
      />
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
  const detailAtom = serverEnvironment.championDetail({ environmentId, input: { id } });
  const detail = useEnvironmentQuery(detailAtom);
  const failure = championFailure(useAtomValue(detailAtom));
  const data = detail.data;
  return (
    <SettingsScreen title={data?.champion.name ?? "Champion"}>
      <ScrollView
        contentInsetAdjustmentBehavior="automatic"
        showsVerticalScrollIndicator={false}
        className="flex-1"
        contentContainerClassName="gap-5 px-5 pt-4"
        contentContainerStyle={{ paddingBottom: Math.max(insets.bottom, 18) + 18 }}
      >
        {data === null ? (
          <Text className="text-base text-foreground-muted">{failure ?? "Loading…"}</Text>
        ) : (
          <>
            <View className="gap-2">
              <Text className="text-sm font-t3-medium text-foreground-muted">
                {CHAMPION_STATUS_LABELS[championStatus(data.champion, nowMs)]}
              </Text>
              <Text className="text-base text-foreground">{data.champion.purpose}</Text>
              {data.champion.attention.map((line) => (
                <Text key={line} className="text-sm text-foreground-muted">
                  {line}
                </Text>
              ))}
              <ChampionControls
                environmentId={environmentId}
                champion={data.champion}
                hasMetrics={data.metrics.length > 0}
                hasProposal={data.proposal !== null}
              />
              <View className="flex-row flex-wrap gap-2">
                {data.champion.lastCheckAt !== null || data.champion.outstandingCheckId !== null ? (
                  <ThreadLinkButton
                    label="Open owner thread"
                    environmentId={environmentId}
                    threadId={data.champion.ownerThreadId}
                  />
                ) : null}
                {data.champion.setupThreadId !== null ? (
                  <ThreadLinkButton
                    label="Open setup thread"
                    environmentId={environmentId}
                    threadId={data.champion.setupThreadId}
                  />
                ) : null}
              </View>
            </View>
            {data.proposal ? (
              <SettingsSection title="Proposed metrics">
                <Text className="px-4 pt-4 text-sm text-foreground-muted">
                  {data.proposal.reason}
                </Text>
                {data.proposal.metrics.map((metric) => (
                  <View key={metric.id} className="gap-1 px-4 py-3">
                    <Text className="text-base font-t3-medium text-foreground">{metric.name}</Text>
                    <Text className="text-sm text-foreground-muted">
                      {metric.unit} · {metric.source}
                      {(metric.required ?? true) ? "" : " · Optional"}
                    </Text>
                  </View>
                ))}
              </SettingsSection>
            ) : null}
            <SettingsSection title="Metrics">
              {data.metrics.length === 0 ? (
                <Text className="p-4 text-base text-foreground-muted">No metrics yet.</Text>
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
                    <Text className="text-base font-t3-medium text-foreground">
                      {championReadingLabel(
                        championReading(metric, data.latestSamples, nowMs),
                        metric.unit,
                      )}
                    </Text>
                  </View>
                ))
              )}
            </SettingsSection>
            {data.findings.length > 0 ? (
              <SettingsSection title="Activity">
                {data.findings.map((finding, index) => (
                  <View
                    key={finding.id}
                    className={
                      index === 0
                        ? "gap-1 px-4 py-3"
                        : "gap-1 border-t border-border-subtle px-4 py-3"
                    }
                  >
                    <Text className="text-base font-t3-medium text-foreground">
                      {finding.title}
                    </Text>
                    <Text className="text-sm text-foreground-muted">
                      {pendingChampionDecision(finding)
                        ? "Needs you"
                        : CHAMPION_FINDING_STATUS_LABELS[finding.status]}
                      {finding.evidence ? ` · ${finding.evidence}` : ""}
                    </Text>
                    {finding.decision ? (
                      <Text className="text-sm text-foreground">
                        {finding.decision.status === "resolved"
                          ? `${finding.decision.question} Answered: ${finding.decision.answer}`
                          : finding.decision.question}
                      </Text>
                    ) : null}
                    {finding.repairAttention ? (
                      <Text className="text-sm text-foreground-muted">
                        {finding.repairAttention}
                      </Text>
                    ) : null}
                    <FindingActions
                      environmentId={environmentId}
                      championId={id}
                      finding={finding}
                    />
                    {finding.childThreadId !== null ? (
                      <ThreadLinkButton
                        label="Open repair thread"
                        environmentId={environmentId}
                        threadId={finding.childThreadId}
                      />
                    ) : null}
                  </View>
                ))}
              </SettingsSection>
            ) : null}
            <Text className="text-sm text-foreground-muted">
              Create and edit champions, edit metrics and read older activity from the web or
              desktop app.
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
