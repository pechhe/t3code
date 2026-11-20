import type {
  DelegationStanceChoice,
  ModelSelection,
  RuntimeMode,
  ThreadId,
} from "@t3tools/contracts";
import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect, useEffectEvent } from "react";

import type { DraftId, DraftThreadState } from "../../composerDraftStore";
import {
  hasAttemptedWarmLaunch,
  launchWarmThread,
  noteWarmThreadSeen,
  renewDraftThreadIfGone,
} from "../../draftWarmThread";
import { m } from "../../i18n/messages";
import { msg } from "gt-react";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { DEFAULT_INTERACTION_MODE } from "../../types";
import { isUnstartedThreadShell, shouldLaunchWarmThread } from "./draftWarmThread.logic";

/**
 * Launches the server thread of a draft once its project is chosen, so the workspace is being
 * prepared while the user types and Send only dispatches the first message. The draft keeps its
 * screen; the thread is an empty server thread behind it.
 */
export function useWarmDraftThread(input: {
  readonly enabled: boolean;
  readonly environmentId: EnvironmentId;
  readonly draftId: DraftId | null;
  readonly threadId: ThreadId;
  readonly draftThread: DraftThreadState | null;
  readonly projectId: DraftThreadState["projectId"] | null;
  readonly projectUnchosen: boolean;
  readonly shell: {
    readonly latestRun: unknown;
    readonly latestUserMessageAt?: string | null;
    readonly stanceChoice?: DelegationStanceChoice | null | undefined;
  } | null;
  readonly modelSelection: ModelSelection | null;
  readonly runtimeMode: RuntimeMode;
  readonly stanceChoice: DelegationStanceChoice | null;
  readonly canOperate: boolean;
}) {
  const { draftThread, shell } = input;
  const setThreadStance = useOrchestrationCommand(threadEnvironment.setStance, {
    label: "delegation stance",
    reportFailure: false,
  });
  const shouldLaunch =
    input.enabled &&
    input.modelSelection !== null &&
    shouldLaunchWarmThread({
      hasDraftSession: draftThread !== null,
      promoted: draftThread?.promotedTo != null,
      projectChosen: !input.projectUnchosen,
      hasProject: input.projectId !== null,
      shellExists: shell !== null,
      alreadyAttempted: hasAttemptedWarmLaunch(input.environmentId, input.threadId),
      canOperate: input.canOperate,
      environmentResolved: !(
        draftThread?.environmentSelection === "auto" &&
        (draftThread.loadBalancedEnvironmentId ?? null) === null
      ),
    });
  const launch = useEffectEvent(() => {
    if (
      draftThread === null ||
      input.draftId === null ||
      input.projectId === null ||
      input.modelSelection === null
    ) {
      return;
    }
    const checkedOut = draftThread.worktreePath !== null || draftThread.envMode === "local";
    void launchWarmThread(input.environmentId, input.draftId, {
      threadId: input.threadId,
      projectId: input.projectId,
      title: m(msg("New thread")),
      modelSelection: input.modelSelection,
      runtimeMode: input.runtimeMode,
      interactionMode: DEFAULT_INTERACTION_MODE,
      ...(input.stanceChoice ? { stanceChoice: input.stanceChoice } : {}),
      branch: checkedOut ? draftThread.branch : null,
      worktreePath: draftThread.worktreePath,
    });
  });
  const launchKey = shouldLaunch ? `${input.environmentId}:${input.threadId}` : null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- launches the draft's server thread once its project is chosen
  useEffect(() => {
    if (launchKey !== null) launch();
  }, [launchKey]);

  // A launched thread can expire or be deleted while the draft sits; its id is then taken.
  const shellPresent = shell !== null;
  const syncLaunchedShell = useEffectEvent(() => {
    if (shellPresent) noteWarmThreadSeen(input.environmentId, input.threadId);
    else if (input.draftId !== null) renewDraftThreadIfGone(input.draftId);
  });
  const shellKey = input.enabled
    ? `${input.environmentId}:${input.threadId}:${shellPresent}`
    : null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- follows the launched thread's server shell appearing and disappearing
  useEffect(() => {
    if (shellKey !== null) syncLaunchedShell();
  }, [shellKey]);

  // The stance picked after launch is the thread's stance when the first message goes out.
  const stance = input.stanceChoice;
  const stanceDiffers =
    stance !== null &&
    isUnstartedThreadShell(shell) &&
    shell.stanceChoice?.stance !== stance.stance;
  const syncStance = useEffectEvent(() => {
    if (stance === null) return;
    void setThreadStance({
      environmentId: input.environmentId,
      input: { threadId: input.threadId, stance: stance.stance },
    });
  });
  const stanceKey =
    input.enabled && stanceDiffers && stance !== null
      ? `${input.environmentId}:${input.threadId}:${stance.stance}`
      : null;
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- keeps the launched thread's stance in step with the draft's pick
  useEffect(() => {
    if (stanceKey !== null) syncStance();
  }, [stanceKey]);
}
