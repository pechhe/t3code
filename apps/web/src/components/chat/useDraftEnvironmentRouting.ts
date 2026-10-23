import { useLoadBalancedEnvironment } from "../../hooks/useLoadBalancedEnvironment";
import { useLogicalProjectEnvironments } from "../../hooks/useLogicalProjectEnvironments";
import { useScratchProject } from "../../hooks/useScratchProject";
import { useStableCallback } from "../../hooks/useStableCallback";
import {
  type EnvironmentId,
  type ProviderDriverKind,
  ProviderInstanceId,
  resolveProjectProviderInstanceEnabled,
  type ThreadContextRecord,
} from "@t3tools/contracts";
import { scopeProjectRef } from "@t3tools/client-runtime/environment";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { toastManager } from "../ui/toast";
import {
  deriveLogicalProjectKeyFromSettings,
  selectProjectGroupingSettings,
} from "../../logicalProject";
import { useComposerDraftStore, DraftId } from "../../composerDraftStore";
import { type EnvironmentPresentation, useEnvironmentProviders } from "../../state/environments";
import { useProjects } from "../../state/entities";
import { useUiStateStore } from "../../uiStateStore";
import type { DraftSessionState } from "../../composerDraftStore";

interface DraftEnvironmentRoutingInput {
  readonly draftId: DraftId | null;
  readonly draftThread: DraftSessionState | null;
  readonly envLocked: boolean;
  readonly automaticEnvironment: boolean;
  readonly logicalProjectEnvironments: ReturnType<typeof useLogicalProjectEnvironments>;
  readonly environmentById: ReadonlyMap<
    EnvironmentId,
    Pick<EnvironmentPresentation, "connection" | "serverConfig">
  >;
  readonly providersByEnvironment: ReturnType<typeof useEnvironmentProviders>;
  readonly loadBalancingSettings: {
    readonly loadBalancingEnabled: boolean;
    readonly loadBalancingWeights: Readonly<Record<string, number>>;
  };
  readonly referencedThreadContexts: ReadonlyArray<ThreadContextRecord>;
  readonly activeProviderInstanceId: ProviderInstanceId | null;
  readonly selectedProvider: ProviderDriverKind;
  readonly composerHasAttachments: boolean;
  readonly activeProjectKey: string | null;
  readonly activeProjectIsScratch: boolean;
  readonly projectGroupingSettings: ReturnType<typeof selectProjectGroupingSettings>;
  readonly sendInFlightRef: { readonly current: boolean };
}

export function isAutomaticDraftEnvironment(
  input: Pick<
    DraftEnvironmentRoutingInput,
    "draftId" | "draftThread" | "envLocked" | "composerHasAttachments"
  > & {
    readonly clientSettingsHydrated: boolean;
    readonly canAutoBalanceEnvironments: boolean;
    readonly loadBalancingEnabled: boolean;
  },
) {
  return Boolean(
    input.clientSettingsHydrated &&
    input.draftId &&
    !input.envLocked &&
    input.canAutoBalanceEnvironments &&
    input.loadBalancingEnabled &&
    input.draftThread?.environmentSelection !== "manual" &&
    !input.composerHasAttachments &&
    (!input.draftThread?.branch || input.draftThread.environmentSelection === "auto") &&
    !input.draftThread?.worktreePath,
  );
}

/**
 * Which machine an unsent draft runs on: automatic load balancing across the
 * project's machines, or a manual switch, which may first open a scratch
 * project on the target machine.
 */
export function useDraftEnvironmentRouting(input: DraftEnvironmentRoutingInput) {
  const {
    draftId,
    draftThread,
    envLocked,
    automaticEnvironment,
    logicalProjectEnvironments,
    environmentById,
    providersByEnvironment,
    loadBalancingSettings,
    referencedThreadContexts,
    activeProviderInstanceId,
    selectedProvider,
    composerHasAttachments,
    activeProjectKey,
    activeProjectIsScratch,
    projectGroupingSettings,
    sendInFlightRef,
  } = input;
  const setDraftThreadContext = useComposerDraftStore((store) => store.setDraftThreadContext);
  const setNewThreadEnvironmentId = useUiStateStore((store) => store.setNewThreadEnvironmentId);
  const getDraftSession = useComposerDraftStore((store) => store.getDraftSession);
  const setLogicalProjectDraftThreadId = useComposerDraftStore(
    (store) => store.setLogicalProjectDraftThreadId,
  );
  const allProjects = useProjects();
  const { openScratchProject } = useScratchProject();
  const balancingEnabled =
    !!draftId &&
    !envLocked &&
    !activeProjectIsScratch &&
    loadBalancingSettings.loadBalancingEnabled &&
    logicalProjectEnvironments.length > 0;
  // Live eligibility governs new picks and automatic moves; a connection blip
  // must not replace an existing recommendation or erase a manual override.
  const eligibleEnvironments = balancingEnabled
    ? logicalProjectEnvironments.filter((candidate) => {
        const environment = environmentById.get(candidate.environmentId);
        return (
          environment?.connection.phase === "connected" &&
          (loadBalancingSettings.loadBalancingWeights[candidate.environmentId] ?? 50) > 0 &&
          referencedThreadContexts.every(
            (record) => record.environmentId === candidate.environmentId,
          ) &&
          providersByEnvironment
            .get(candidate.environmentId)
            ?.some(
              (provider) =>
                (activeProviderInstanceId === null ||
                  provider.instanceId === activeProviderInstanceId) &&
                provider.driver === selectedProvider &&
                (environment.serverConfig?.settings
                  ? resolveProjectProviderInstanceEnabled(
                      environment.serverConfig.settings,
                      candidate.projectId,
                      provider.instanceId,
                    )
                  : provider.enabled) &&
                provider.installed &&
                provider.status !== "error" &&
                provider.auth.status !== "unauthenticated" &&
                provider.availability !== "unavailable",
            )
        );
      })
    : [];
  const balanceTarget = logicalProjectEnvironments.find(
    (environment) => environment.environmentId === draftThread?.loadBalancedEnvironmentId,
  );
  const applicableTarget = eligibleEnvironments.find(
    (environment) => environment.environmentId === balanceTarget?.environmentId,
  );
  const needsRecommendation = balancingEnabled && !composerHasAttachments && !balanceTarget;
  const resources = useLoadBalancedEnvironment(
    needsRecommendation ? eligibleEnvironments.map((environment) => environment.environmentId) : [],
    loadBalancingSettings.loadBalancingWeights,
  );
  const applyingRecommendation =
    automaticEnvironment &&
    !!applicableTarget &&
    draftThread?.environmentId !== applicableTarget.environmentId;
  const needsLoadBalancing =
    automaticEnvironment &&
    (!balanceTarget ||
      !applicableTarget ||
      draftThread?.environmentId !== balanceTarget.environmentId);
  const loadBalancing = {
    ...resources,
    pending: resources.pending || applyingRecommendation,
  };
  useEffect(() => {
    if (!needsRecommendation || resources.pending || !draftId || sendInFlightRef.current) return;
    const target = eligibleEnvironments.find(
      (environment) => environment.environmentId === resources.environmentId,
    );
    if (!target?.projectId) return;
    setDraftThreadContext(draftId, {
      loadBalancedEnvironmentId: target.environmentId,
    });
  }, [
    needsRecommendation,
    resources.pending,
    resources.environmentId,
    draftId,
    eligibleEnvironments,
    sendInFlightRef,
    setDraftThreadContext,
  ]);
  // A recommendation can outlive a machine-local pin. Apply it only after that
  // pin is removed; caching the recommendation never grants permission to move.
  useEffect(() => {
    if (
      !automaticEnvironment ||
      composerHasAttachments ||
      draftThread?.worktreePath ||
      !draftId ||
      !applicableTarget?.projectId ||
      sendInFlightRef.current ||
      (draftThread?.branch && draftThread.environmentSelection !== "auto") ||
      (draftThread?.environmentId === applicableTarget.environmentId &&
        draftThread.environmentSelection === "auto")
    )
      return;
    setDraftThreadContext(draftId, {
      projectRef: scopeProjectRef(applicableTarget.environmentId, applicableTarget.projectId),
      environmentSelection: "auto",
      loadBalancedEnvironmentId: applicableTarget.environmentId,
    });
  }, [
    automaticEnvironment,
    composerHasAttachments,
    draftThread,
    draftId,
    applicableTarget,
    sendInFlightRef,
    setDraftThreadContext,
  ]);
  const onAutoEnvironment = () => {
    if (envLocked || !draftId) return;
    if (composerHasAttachments) {
      toastManager.add({
        type: "warning",
        id: "load-balancing-attachments",
        title: "Keep attachments on this machine",
        description:
          "Remove attachments before choosing automatic routing, then attach them on the selected machine.",
      });
      return;
    }
    // Automatic routing picks a machine each time, so it stops the switch's position from
    // carrying into the next new thread.
    setNewThreadEnvironmentId(null);
    loadBalancing.refresh(
      logicalProjectEnvironments.map((environment) => environment.environmentId),
    );
    setDraftThreadContext(draftId, {
      environmentSelection: "auto",
      loadBalancedEnvironmentId: null,
      branch: null,
      worktreePath: null,
    });
  };
  const onAutoEnvironmentStable = useStableCallback(onAutoEnvironment);
  const autoEnvironmentLabel = automaticEnvironment
    ? !needsLoadBalancing
      ? "Auto balance"
      : loadBalancing.pending
        ? "Checking machines…"
        : "Auto balance unavailable"
    : undefined;

  // A change in flight belongs to the draft and project it started on.
  const environmentChangeScope = `${draftId ?? ""}:${activeProjectKey ?? ""}`;
  const environmentChangeRef = useRef<{
    readonly environmentId: EnvironmentId;
    readonly scope: string;
  } | null>(null);
  const environmentChangeScopeRef = useRef("");
  useLayoutEffect(() => {
    environmentChangeScopeRef.current = environmentChangeScope;
  });
  // Leaving the scope, or unmounting, abandons a change still in flight.
  useLayoutEffect(
    () => () => {
      if (environmentChangeRef.current?.scope === environmentChangeScope) {
        environmentChangeRef.current = null;
      }
    },
    [environmentChangeScope],
  );
  const readPendingEnvironmentChange = () => {
    const pending = environmentChangeRef.current;
    return pending !== null && pending.scope === environmentChangeScopeRef.current ? pending : null;
  };
  // The busy state belongs to the request that set it, so an older request settling late
  // (abandoned, or superseded by a newer switch) can never clear a newer one's.
  const [busyEnvironmentChange, setBusyEnvironmentChange] = useState<{
    readonly environmentId: EnvironmentId;
    readonly scope: string;
  } | null>(null);
  const isEnvironmentChanging = busyEnvironmentChange?.scope === environmentChangeScope;

  const onEnvironmentChange = (nextEnvironmentId: EnvironmentId) => {
    if (envLocked || !draftId || sendInFlightRef.current) return;
    const originalDraft = getDraftSession(draftId);
    if (!originalDraft || originalDraft.promotedTo) return;
    const target = logicalProjectEnvironments.find(
      (env) => env.environmentId === nextEnvironmentId,
    );
    if (!target) return;
    const request = { environmentId: target.environmentId, scope: environmentChangeScope };
    environmentChangeRef.current = request;
    setBusyEnvironmentChange(null);
    const retarget = (project: (typeof allProjects)[number]) => {
      const currentDraft = getDraftSession(draftId);
      if (
        environmentChangeRef.current !== request ||
        environmentChangeScopeRef.current !== request.scope ||
        sendInFlightRef.current ||
        !currentDraft ||
        currentDraft.promotedTo ||
        currentDraft.environmentId !== originalDraft.environmentId ||
        currentDraft.projectId !== originalDraft.projectId
      )
        return;
      const projectRef = scopeProjectRef(target.environmentId, project.id);
      const balancedEnvironmentId =
        logicalProjectEnvironments.find(
          (environment) => environment.environmentId === currentDraft.loadBalancedEnvironmentId,
        )?.environmentId ?? null;
      const selection = {
        environmentSelection:
          loadBalancingSettings.loadBalancingEnabled &&
          !activeProjectIsScratch &&
          target.environmentId === balancedEnvironmentId
            ? ("auto" as const)
            : ("manual" as const),
        loadBalancedEnvironmentId: balancedEnvironmentId,
      };
      setNewThreadEnvironmentId(
        selection.environmentSelection === "auto" ? null : target.environmentId,
      );
      if (activeProjectIsScratch) {
        setLogicalProjectDraftThreadId(
          deriveLogicalProjectKeyFromSettings(project, projectGroupingSettings),
          projectRef,
          draftId,
          selection,
        );
      } else {
        setDraftThreadContext(draftId, {
          projectRef,
          ...selection,
        });
      }
    };
    const finish = () => {
      if (environmentChangeRef.current === request) environmentChangeRef.current = null;
      setBusyEnvironmentChange((busy) => (busy === request ? null : busy));
    };
    if (target.projectId !== null) {
      const project = allProjects.find(
        (project) =>
          project.environmentId === target.environmentId && project.id === target.projectId,
      );
      if (project) retarget(project);
      finish();
      return;
    }
    setBusyEnvironmentChange(request);
    void openScratchProject(target.environmentId, "Could not switch machine")
      .then((project) => {
        if (project) retarget(project);
      })
      .finally(finish);
  };
  const onEnvironmentChangeStable = useStableCallback(onEnvironmentChange);
  const balanceState = balancingEnabled
    ? balanceTarget
      ? draftThread?.environmentId === balanceTarget.environmentId
        ? ("auto" as const)
        : draftThread?.environmentSelection === "manual"
          ? ("override" as const)
          : automaticEnvironment
            ? loadBalancing.pending
              ? ("checking" as const)
              : ("unavailable" as const)
            : undefined
      : automaticEnvironment
        ? loadBalancing.pending
          ? ("checking" as const)
          : ("unavailable" as const)
        : undefined
    : undefined;

  return {
    balanceState,
    balancedEnvironmentId: balanceTarget?.environmentId ?? null,
    needsLoadBalancing,
    loadBalancing,
    onAutoEnvironmentStable,
    autoEnvironmentLabel,
    isEnvironmentChanging,
    readPendingEnvironmentChange,
    onEnvironmentChangeStable,
  };
}
