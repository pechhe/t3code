import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentThreadShell } from "@t3tools/client-runtime/state/shell";
import type {
  DelegationStance,
  DelegationStanceChoice,
  EnvironmentId,
  ModelSelection,
  ThreadId,
} from "@t3tools/contracts";
import { useEffect, useEffectEvent, useRef, useState } from "react";

import { useStableCallback } from "../../hooks/useStableCallback";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { toastManager } from "../ui/toast";
import {
  resolveDraftStance,
  resolveServerThreadStance,
  shouldClearPendingStance,
  touchDraftStance,
} from "./stance.logic";

interface PendingStanceUpdate {
  readonly threadKey: string;
  readonly stance: DelegationStance;
  readonly seq: number;
}

/**
 * Resolves and updates the delegation stance for the active composer target.
 * Drafts follow the selected model's default until touched; existing threads
 * resolve through `delegationStance.resolve` and dispatch `thread.stance.set`.
 */
export function useThreadStance(input: {
  readonly environmentId: EnvironmentId;
  readonly isServerThread: boolean;
  readonly threadId: ThreadId | null;
  readonly threadShell:
    | Pick<EnvironmentThreadShell, "stanceChoice" | "modelSelection" | "arcRun">
    | null
    | undefined;
  readonly selectedModelSelection: ModelSelection;
  readonly draftStanceChoice: DelegationStanceChoice | null;
  readonly onDraftStanceChange: (choice: DelegationStanceChoice) => void;
  readonly canOperateThread: boolean;
}) {
  const hasSetStancePermission = useAtomValue(
    threadEnvironment.setStance.permissionAtom(input.environmentId),
  );
  const disabled = input.isServerThread
    ? !input.canOperateThread || !hasSetStancePermission
    : !input.canOperateThread;
  const resolveInput =
    input.isServerThread && input.threadId !== null
      ? { threadId: input.threadId }
      : input.draftStanceChoice === null
        ? { modelSelection: input.selectedModelSelection }
        : null;
  const resolveQuery = useEnvironmentQuery(
    resolveInput === null
      ? null
      : serverEnvironment.delegationStanceResolve({
          environmentId: input.environmentId,
          input: resolveInput,
        }),
  );

  const refreshSignature =
    input.isServerThread && input.threadId !== null
      ? JSON.stringify([
          input.threadId,
          input.threadShell?.stanceChoice ?? null,
          input.threadShell?.modelSelection ?? null,
          input.threadShell?.arcRun ?? null,
        ])
      : null;
  const previousSignatureRef = useRef<{
    readonly threadId: ThreadId | null;
    readonly signature: string | null;
  }>({ threadId: input.threadId, signature: refreshSignature });
  const refreshResolved = useEffectEvent(() => resolveQuery.refresh());

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- refreshes the server-resolved delegation stance when an existing thread's stanceChoice, modelSelection or arcRun changes
  useEffect(() => {
    const previous = previousSignatureRef.current;
    previousSignatureRef.current = { threadId: input.threadId, signature: refreshSignature };
    if (
      refreshSignature === null ||
      previous.signature === null ||
      previous.threadId !== input.threadId ||
      previous.signature === refreshSignature
    ) {
      return;
    }
    refreshResolved();
  }, [input.threadId, refreshSignature]);

  const threadKey =
    input.isServerThread && input.threadId !== null
      ? `${input.environmentId}:${input.threadId}`
      : "draft";
  const [pending, setPending] = useState<PendingStanceUpdate | null>(null);
  const seqRef = useRef(0);
  const setThreadStance = useOrchestrationCommand(threadEnvironment.setStance, {
    label: "delegation stance",
    reportFailure: false,
  });

  if (
    shouldClearPendingStance({
      pending,
      threadKey,
      serverChoice: input.threadShell?.stanceChoice,
    })
  ) {
    setPending(null);
  }

  const stance = input.isServerThread
    ? resolveServerThreadStance({
        pending,
        threadKey,
        serverResolved: resolveQuery.data,
        serverChoice: input.threadShell?.stanceChoice,
      })
    : resolveDraftStance({
        manualChoice: input.draftStanceChoice,
        modelResolved: resolveQuery.data,
      });

  const onChange = (nextStance: DelegationStance) => {
    if (disabled || nextStance === stance) return;
    if (!input.isServerThread) {
      input.onDraftStanceChange(touchDraftStance(nextStance));
      return;
    }
    if (input.threadId === null) return;
    const seq = ++seqRef.current;
    const targetThreadId = input.threadId;
    setPending({ threadKey, stance: nextStance, seq });
    void setThreadStance({
      environmentId: input.environmentId,
      input: { threadId: targetThreadId, stance: nextStance },
    }).then((result) => {
      if (result._tag === "Failure") {
        setPending((current) => (current?.seq === seq ? null : current));
        const err = squashAtomCommandFailure(result);
        toastManager.add({
          type: "error",
          title: "Could not change delegation stance",
          description: err instanceof Error ? err.message : undefined,
        });
        return;
      }
      refreshResolved();
    });
  };
  const onChangeStable = useStableCallback(onChange);

  return {
    stance,
    disabled,
    onChange: onChangeStable,
  };
}
