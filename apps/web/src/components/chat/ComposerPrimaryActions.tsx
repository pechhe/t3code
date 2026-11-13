import {
  memo,
  useEffect,
  useState,
  type MouseEventHandler,
  type PointerEvent as ReactPointerEvent,
  type PointerEventHandler,
  type ReactNode,
  useRef,
} from "react";
import { ArrowRightIcon, CheckIcon, ChevronLeftIcon, Minimize2Icon, PlayIcon } from "lucide-react";
import { CornerUpRightIcon, ListPlusIcon } from "lucide-react";
import { useEnvironmentIdentificationMode } from "~/hooks/useSettings";
import { formatContextWindowTokens } from "~/lib/contextWindow";
import { dialClicks, pressClick } from "~/lib/interfaceSounds";
import { cn, isMacPlatform } from "~/lib/utils";
import { useShortcutModifierState } from "../../shortcutModifierState";
import { StageBackdropButtonArt, useSidebarStageBackdropVariant } from "../SidebarStageBackdrop";
import { Button } from "../ui/button";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

import { DeviceUnit } from "./device/DeviceUnit";
import {
  alternateComposerDispatchAction,
  resolveComposerDispatchMode,
} from "@t3tools/client-runtime/state/composer-dispatch";

interface PendingActionState {
  questionIndex: number;
  isLastQuestion: boolean;
  canAdvance: boolean;
  isResponding: boolean;
  isComplete: boolean;
}

interface ComposerPrimaryActionsProps {
  /** Footer controls (dictation) that always sit right before the primary button. */
  children?: ReactNode;
  compact: boolean;
  canOperateThread: boolean;
  pendingAction: PendingActionState | null;
  isRunning: boolean;
  canInterrupt: boolean;
  runId?: string | null;
  followUpBehavior?: "queue" | "steer";
  canSteer?: boolean;
  alternateShortcutLabel?: string | null;
  /** Dictation is running; Send finishes it and submits once the transcript lands. */
  voiceInputActive?: boolean;
  isSendBusy: boolean;
  sendDisabledReason: string | null;
  isEnvironmentUnavailable: boolean;
  isPreparingWorktree: boolean;
  hasSendableContent: boolean;
  canResume?: boolean;
  preserveComposerFocusOnPointerDown?: boolean;
  isEditingQueuedMessage?: boolean;
  onSubmitMessage?: MouseEventHandler<HTMLButtonElement>;
  onResume?: () => void;
  onPreviousPendingQuestion: () => void;
  onInterrupt: () => void;
  compactBeforeSendTokens?: number | null;
  /** The cheaper model that summarises that history; null when the conversation's own does. */
  compactionModelName?: string | null;
  hideCompactToggle?: boolean;
  keepFullHistory?: boolean;
  onToggleKeepFullHistory?: () => void;
  /** Render send and stop as the composer's machined dial. */
  device?: boolean;
  /** Changes on each keyboard send so the dial visibly presses in. */
  sendPressKey?: number;
}

const formatPendingPrimaryActionLabel = (input: {
  compact: boolean;
  isLastQuestion: boolean;
  isResponding: boolean;
  questionIndex: number;
}) => {
  if (input.isResponding) {
    return "Submitting...";
  }
  if (input.compact) {
    return input.isLastQuestion ? "Submit" : "Next";
  }
  if (!input.isLastQuestion) {
    return "Next question";
  }
  return input.questionIndex > 0 ? "Submit answers" : "Submit answer";
};

const STOP_PENDING_MAX_MS = 10_000;

const messageActionPillClassName =
  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-full bg-message-action font-medium text-base text-message-action-foreground shadow-xs shadow-message-action/24 outline-none hover:bg-message-action-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-64 disabled:shadow-none sm:text-sm";

const preventPointerFocus: PointerEventHandler<HTMLElement> = (event) => {
  event.preventDefault();
};

type StopPhase = "pending" | "timedOut" | "landed" | null;

function useStopPhase(input: {
  runId: string | null;
  canInterrupt: boolean;
  canOperateThread: boolean;
}) {
  const { runId, canInterrupt, canOperateThread } = input;
  const [stopPhase, setStopPhase] = useState<StopPhase>(null);
  const [stopRunId, setStopRunId] = useState(runId);
  if (runId !== null && stopRunId !== runId) {
    setStopRunId(runId);
    setStopPhase(null);
  } else if (canOperateThread) {
    // Losing permission also clears canInterrupt; it does not acknowledge the stop.
    if ((stopPhase === "pending" || stopPhase === "timedOut") && !canInterrupt)
      setStopPhase("landed");
    else if (stopPhase === "landed" && canInterrupt) setStopPhase(null);
  }
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- timer that re-enables Stop if the interrupt never settles
  useEffect(() => {
    if (stopPhase !== "pending") return;
    const timeout = setTimeout(() => setStopPhase("timedOut"), STOP_PENDING_MAX_MS);
    return () => clearTimeout(timeout);
  }, [stopPhase]);
  return [stopPhase, setStopPhase] as const;
}

function StopGenerationButton({
  stopPhase,
  canOperateThread,
  insidePendingAction,
  preserveComposerFocusOnPointerDown,
  onStopRequested,
  onInterrupt,
}: {
  stopPhase: StopPhase;
  canOperateThread: boolean;
  insidePendingAction: boolean;
  preserveComposerFocusOnPointerDown: boolean;
  onStopRequested: () => void;
  onInterrupt: () => void;
}) {
  const isStopDisabled = stopPhase === "pending" || stopPhase === "landed";
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <button
            type="button"
            className={cn(
              "flex shrink-0 cursor-pointer items-center justify-center rounded-full bg-destructive/90 text-white shadow-xs shadow-destructive/24 inset-shadow-control-highlight transition-colors duration-150 hover:bg-destructive active:inset-shadow-control-pressed active:shadow-none disabled:cursor-default disabled:opacity-64 disabled:hover:bg-destructive/90 [&_svg]:pointer-events-none",
              insidePendingAction ? "size-8 sm:size-7" : "size-8 sm:h-8 sm:w-8",
            )}
            onPointerDown={preserveComposerFocusOnPointerDown ? preventPointerFocus : undefined}
            disabled={!canOperateThread || isStopDisabled}
            onClick={() => {
              if (!canOperateThread || isStopDisabled) return;
              onStopRequested();
              onInterrupt();
            }}
            aria-label={
              stopPhase === "landed"
                ? "Stopped"
                : stopPhase === "pending"
                  ? "Stopping"
                  : "Stop generation"
            }
          />
        }
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
          <rect x="2" y="2" width="8" height="8" rx="1.5" />
        </svg>
      </TooltipTrigger>
      <TooltipPopup>
        {stopPhase === "pending" ? "Stopping…" : stopPhase === "landed" ? "Stopped" : "Interrupt"}
      </TooltipPopup>
    </Tooltip>
  );
}

/** The collapsed mobile composer's Stop, shown in place of `children` while a turn can be stopped. */
export function CollapsedComposerStopAction({
  children,
  canOperateThread,
  canInterrupt,
  runId,
  hasSendableContent,
  isEditingQueuedMessage,
  onInterrupt,
}: {
  children: ReactNode;
  canOperateThread: boolean;
  canInterrupt: boolean;
  runId: string | null;
  hasSendableContent: boolean;
  isEditingQueuedMessage: boolean;
  onInterrupt: () => void;
}) {
  const [stopPhase, setStopPhase] = useStopPhase({ runId, canInterrupt, canOperateThread });
  if (
    !(canInterrupt || stopPhase === "pending" || stopPhase === "timedOut") ||
    hasSendableContent ||
    isEditingQueuedMessage
  ) {
    return children;
  }
  return (
    <span
      data-chat-composer-transition-actions="true"
      data-chat-composer-collapsed-controls="true"
      className="flex shrink-0"
    >
      <StopGenerationButton
        stopPhase={stopPhase}
        canOperateThread={canOperateThread}
        insidePendingAction={false}
        preserveComposerFocusOnPointerDown
        onStopRequested={() => setStopPhase("pending")}
        onInterrupt={onInterrupt}
      />
    </span>
  );
}

export const ComposerPrimaryActions = memo(function ComposerPrimaryActions({
  children,
  compact,
  canOperateThread,
  pendingAction,
  isRunning,
  canInterrupt,
  runId = null,
  followUpBehavior = "steer",
  canSteer = true,
  alternateShortcutLabel = null,
  voiceInputActive = false,
  isSendBusy,
  sendDisabledReason,
  isEnvironmentUnavailable,
  isPreparingWorktree,
  hasSendableContent,
  canResume = false,
  preserveComposerFocusOnPointerDown = false,
  isEditingQueuedMessage = false,
  onSubmitMessage,
  onResume,
  onPreviousPendingQuestion,
  onInterrupt,
  compactBeforeSendTokens = null,
  compactionModelName = null,
  hideCompactToggle = false,
  keepFullHistory = false,
  onToggleKeepFullHistory,
  device = false,
  sendPressKey = 0,
}: ComposerPrimaryActionsProps) {
  // The device dial clicks down on press and up on release, like peach-pi's.
  const releaseDialRef = useRef<(() => void) | null>(null);
  const releaseDial = () => {
    releaseDialRef.current?.();
    releaseDialRef.current = null;
  };
  // A send or queue cue stands in for the dial's click, so a dial that sends asks at each press whether to click.
  const pointerPropsFor = (clicks: () => boolean) =>
    device
      ? {
          onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
            if (preserveComposerFocusOnPointerDown) event.preventDefault();
            if (event.button === 0 && !event.currentTarget.matches(":disabled") && clicks()) {
              releaseDialRef.current = pressClick();
            }
          },
          onPointerUp: releaseDial,
          onPointerLeave: releaseDial,
          onPointerCancel: () => {
            releaseDialRef.current = null;
          },
        }
      : preserveComposerFocusOnPointerDown
        ? { onPointerDown: preventPointerFocus }
        : undefined;
  const pointerFocusProps = pointerPropsFor(() => true);
  const [stopPhase, setStopPhase] = useState<"pending" | "timedOut" | "landed" | null>(null);
  const [stopRunId, setStopRunId] = useState(runId);
  if (runId !== null && stopRunId !== runId) {
    setStopRunId(runId);
    setStopPhase(null);
  } else if (canOperateThread) {
    // Losing permission also clears canInterrupt; it does not acknowledge the stop.
    if ((stopPhase === "pending" || stopPhase === "timedOut") && !canInterrupt)
      setStopPhase("landed");
    else if (stopPhase === "landed" && canInterrupt) setStopPhase(null);
  }
  const isStopDisabled = stopPhase === "pending" || stopPhase === "landed";
  const stopLabel =
    stopPhase === "landed" ? "Stopped" : stopPhase === "pending" ? "Stopping" : "Stop generation";
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- timer that re-enables Stop if the interrupt never settles
  useEffect(() => {
    if (stopPhase !== "pending") return;
    const timeout = setTimeout(() => setStopPhase("timedOut"), STOP_PENDING_MAX_MS);
    return () => clearTimeout(timeout);
  }, [stopPhase]);
  const environmentIdentificationMode = useEnvironmentIdentificationMode();
  const shortcutModifiers = useShortcutModifierState();
  // What a send would do even while editing a queued message, whose label stays "Update".
  const dispatchesQueued =
    resolveComposerDispatchMode({
      running: isRunning,
      activeTurnDefault: followUpBehavior,
      canSteer,
      alternateModifier: shortcutModifiers.metaKey || shortcutModifiers.ctrlKey,
    }) === "queue";
  const isQueuing = !isEditingQueuedMessage && dispatchesQueued;
  const alternateAction = alternateComposerDispatchAction(followUpBehavior);
  const isSendDisabled = !canOperateThread || sendDisabledReason !== null;
  const stageBackdropVariant = useSidebarStageBackdropVariant(environmentIdentificationMode);

  const renderStopGenerationButton = (insidePendingAction: boolean) => (
    <Tooltip key="interrupt">
      <TooltipTrigger
        render={
          <button
            type="button"
            className={
              device
                ? insidePendingAction
                  ? "device-cap device-cap--stop"
                  : "send-dial send-dial--stop"
                : cn(
                    "flex shrink-0 cursor-pointer items-center justify-center rounded-full bg-destructive/90 text-white shadow-xs shadow-destructive/24 inset-shadow-control-highlight transition-colors duration-150 hover:bg-destructive active:inset-shadow-control-pressed active:shadow-none [&_svg]:pointer-events-none",
                    insidePendingAction ? "size-8 sm:size-7" : "size-8 sm:h-8 sm:w-8",
                  )
            }
            {...pointerFocusProps}
            disabled={!canOperateThread || isStopDisabled}
            onClick={() => {
              if (!canOperateThread || isStopDisabled) return;
              setStopPhase("pending");
              onInterrupt();
            }}
            aria-label={stopLabel}
          />
        }
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
          <rect x="2" y="2" width="8" height="8" rx="1.5" />
        </svg>
      </TooltipTrigger>
      <TooltipPopup>
        {stopPhase === "pending" ? "Stopping…" : stopPhase === "landed" ? "Stopped" : "Interrupt"}
      </TooltipPopup>
    </Tooltip>
  );

  // Keep the clicked target at the right edge even if typing changes the primary action.
  const withStopButton = (action: ReactNode) => (
    <>
      {action}
      {stopPhase === null ? null : renderStopGenerationButton(false)}
    </>
  );

  if (pendingAction) {
    if (device) {
      const submitDisabled =
        !canOperateThread ||
        isEnvironmentUnavailable ||
        pendingAction.isResponding ||
        (pendingAction.isLastQuestion ? !pendingAction.isComplete : !pendingAction.canAdvance);
      return (
        <div className="device-actions">
          {canInterrupt ? (
            <DeviceUnit caption="Stop" lit>
              {renderStopGenerationButton(true)}
            </DeviceUnit>
          ) : null}
          {pendingAction.questionIndex > 0 ? (
            <DeviceUnit caption="Prev">
              <button
                type="button"
                className="device-cap"
                {...pointerFocusProps}
                onClick={onPreviousPendingQuestion}
                disabled={pendingAction.isResponding}
                aria-label="Previous question"
              >
                <ChevronLeftIcon aria-hidden="true" />
              </button>
            </DeviceUnit>
          ) : null}
          <DeviceUnit
            caption={
              pendingAction.isResponding
                ? "Sending"
                : pendingAction.isLastQuestion
                  ? "Submit"
                  : `Next · ${pendingAction.questionIndex + 1}`
            }
            lit
          >
            <button
              type="submit"
              className="send-dial"
              data-has-input={submitDisabled ? undefined : ""}
              {...pointerPropsFor(() => dialClicks(false))}
              disabled={submitDisabled}
              aria-label={formatPendingPrimaryActionLabel({
                compact: false,
                isLastQuestion: pendingAction.isLastQuestion,
                isResponding: pendingAction.isResponding,
                questionIndex: pendingAction.questionIndex,
              })}
            >
              {pendingAction.isResponding ? (
                <Spinner size="sm" aria-hidden="true" />
              ) : pendingAction.isLastQuestion ? (
                <CheckIcon aria-hidden="true" />
              ) : (
                <ArrowRightIcon aria-hidden="true" />
              )}
            </button>
          </DeviceUnit>
        </div>
      );
    }
    return (
      <div className={cn("flex items-center justify-end", compact ? "gap-1.5" : "gap-2")}>
        {pendingAction.questionIndex > 0 ? (
          compact ? (
            <Button
              size="icon-sm"
              variant="outline"
              {...pointerFocusProps}
              onClick={onPreviousPendingQuestion}
              disabled={pendingAction.isResponding}
              aria-label="Previous question"
            >
              <ChevronLeftIcon className="size-3.5" />
            </Button>
          ) : (
            <Button
              size="sm"
              variant="outline"
              {...pointerFocusProps}
              onClick={onPreviousPendingQuestion}
              disabled={pendingAction.isResponding}
            >
              Previous
            </Button>
          )
        ) : null}
        {children}
        <button
          type="submit"
          className={cn(messageActionPillClassName, "h-8 sm:h-7", compact ? "px-3" : "px-4")}
          {...pointerPropsFor(() => dialClicks(false))}
          disabled={
            !canOperateThread ||
            isEnvironmentUnavailable ||
            isSendDisabled ||
            pendingAction.isResponding ||
            (!voiceInputActive &&
              (pendingAction.isLastQuestion
                ? !pendingAction.isComplete
                : !pendingAction.canAdvance))
          }
        >
          {formatPendingPrimaryActionLabel({
            compact,
            isLastQuestion: pendingAction.isLastQuestion,
            isResponding: pendingAction.isResponding,
            questionIndex: pendingAction.questionIndex,
          })}
        </button>
        {canInterrupt || stopPhase !== null ? renderStopGenerationButton(true) : null}
      </div>
    );
  }

  if (
    (canInterrupt || stopPhase === "pending" || stopPhase === "timedOut") &&
    !hasSendableContent &&
    !isEditingQueuedMessage
  ) {
    return (
      <>
        {children}
        {renderStopGenerationButton(false)}
      </>
    );
  }

  const showResume = canResume && !hasSendableContent && !isEditingQueuedMessage;

  const compactTokens =
    compactBeforeSendTokens !== null && !showResume && !isEditingQueuedMessage
      ? formatContextWindowTokens(compactBeforeSendTokens)
      : null;
  const compactsBeforeSend = compactTokens !== null && !keepFullHistory;

  const submitLabel = showResume
    ? "Resume thread"
    : isEditingQueuedMessage
      ? "Update queued message"
      : compactsBeforeSend
        ? "Compact and send"
        : isQueuing
          ? "Queue message"
          : isRunning
            ? "Steer message"
            : "Submit message";
  const submitStatus = isEnvironmentUnavailable
    ? "Environment disconnected"
    : (sendDisabledReason ??
      (isPreparingWorktree
        ? "Preparing worktree"
        : isSendBusy
          ? isEditingQueuedMessage
            ? "Updating queued message"
            : "Submitting message"
          : null));
  const submitTooltip =
    submitStatus ??
    (compactsBeforeSend
      ? `Summarize ${compactTokens} tokens of history${compactionModelName ? ` with ${compactionModelName}` : ""}, then send`
      : isRunning && !isEditingQueuedMessage && canSteer
        ? `Click to ${followUpBehavior}, ${isMacPlatform(navigator.platform) ? "⌘" : "Ctrl"}-click${alternateShortcutLabel ? ` or ${alternateShortcutLabel}` : ""} to ${alternateAction}`
        : submitLabel);

  const deviceCaption = isEnvironmentUnavailable
    ? "Offline"
    : isPreparingWorktree
      ? "Worktree"
      : isSendBusy
        ? "Sending"
        : showResume
          ? "Resume"
          : isEditingQueuedMessage
            ? "Update"
            : compactsBeforeSend
              ? "Compact + send"
              : isQueuing
                ? "Queue"
                : isRunning
                  ? "Steer"
                  : "Send";

  const sendButton = (
    <button
      key={device ? sendPressKey : undefined}
      type={showResume ? "button" : "submit"}
      data-has-input={device && (hasSendableContent || showResume || isRunning) ? "" : undefined}
      className={
        device
          ? cn(
              "send-dial",
              sendPressKey > 0 && "send-dial--pressed",
              compactsBeforeSend && submitStatus === null && "send-dial--compact",
            )
          : cn(
              "relative isolate flex h-9 w-9 items-center justify-center overflow-hidden rounded-full shadow-xs transition-all duration-150 enabled:cursor-pointer enabled:inset-shadow-control-highlight hover:scale-105 active:inset-shadow-control-pressed active:shadow-none disabled:pointer-events-none disabled:opacity-64 disabled:shadow-none disabled:hover:scale-100 sm:h-8 sm:w-8 [&_svg]:pointer-events-none",
              stageBackdropVariant
                ? "bg-transparent text-white enabled:shadow-black/24 enabled:hover:brightness-110"
                : "bg-message-action text-message-action-foreground enabled:shadow-message-action/24 hover:bg-message-action-hover",
            )
      }
      {...pointerPropsFor(() => showResume || dialClicks(dispatchesQueued))}
      onClick={showResume ? onResume : onSubmitMessage}
      disabled={
        isSendBusy ||
        isSendDisabled ||
        isEnvironmentUnavailable ||
        (!hasSendableContent && !showResume)
      }
      aria-label={submitStatus ?? submitLabel}
    >
      {stageBackdropVariant && !device ? (
        <span className="pointer-events-none absolute inset-0 -z-10" aria-hidden="true">
          <StageBackdropButtonArt variant={stageBackdropVariant} />
        </span>
      ) : null}
      {isSendBusy ? (
        <Spinner size="sm" aria-hidden="true" />
      ) : showResume ? (
        <PlayIcon className="size-4 fill-current" aria-hidden="true" />
      ) : isEditingQueuedMessage ? (
        <CheckIcon className="size-4" aria-hidden="true" />
      ) : isRunning && isQueuing ? (
        <ListPlusIcon className="size-4" aria-hidden="true" />
      ) : isRunning ? (
        <CornerUpRightIcon className="size-4" aria-hidden="true" />
      ) : device && compactsBeforeSend && submitStatus === null ? (
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <path
            d="M7 12.5V5.5M7 5.5L3.5 9M7 5.5L10.5 9M2.5 2h9"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      ) : (
        <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true">
          <path
            d="M7 11.5V2.5M7 2.5L3 6.5M7 2.5L11 6.5"
            stroke="currentColor"
            strokeWidth="1.8"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      )}
    </button>
  );

  const submit = (
    <Tooltip key="submit">
      <TooltipTrigger render={<span className="inline-flex" />}>{sendButton}</TooltipTrigger>
      <TooltipPopup>{submitTooltip}</TooltipPopup>
    </Tooltip>
  );
  // The device shows compact-on-send as a flag on its screen, so the dial only mirrors it.
  if (device) {
    return (
      <DeviceUnit
        caption={deviceCaption}
        lit={deviceCaption !== "Send" && deviceCaption !== "Offline"}
      >
        {submit}
      </DeviceUnit>
    );
  }
  if (compactTokens === null || hideCompactToggle) {
    return withStopButton(
      <>
        {children}
        {submit}
      </>,
    );
  }

  return withStopButton(
    <div data-chat-composer-compact-send="true" className="flex items-center gap-2">
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              className="flex h-7 shrink-0 cursor-pointer items-center gap-1.5 rounded-(--control-radius) px-2 font-medium text-base text-foreground/80 tabular-nums outline-none hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-64 sm:text-sm aria-pressed:bg-accent/60 aria-pressed:text-foreground [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:text-muted-foreground"
              {...pointerFocusProps}
              aria-pressed={!keepFullHistory}
              aria-label={`Compact ${compactTokens} tokens of history${compactionModelName ? ` with ${compactionModelName}` : ""} before sending`}
              disabled={!canOperateThread}
              onClick={onToggleKeepFullHistory}
            />
          }
        >
          <Minimize2Icon aria-hidden="true" />
          {keepFullHistory ? "Full" : "Compact"}
          {!keepFullHistory && compactionModelName ? (
            <span className="max-w-24 truncate">{compactionModelName}</span>
          ) : null}
          <span>{compactTokens}</span>
        </TooltipTrigger>
        <TooltipPopup>
          <div>
            {keepFullHistory
              ? `Next send keeps all ${compactTokens} tokens.`
              : `Next send compacts ${compactTokens} tokens first${compactionModelName ? ` with ${compactionModelName}` : ""}.`}
          </div>
          <div>{keepFullHistory ? "Click to compact first" : "Click to keep full history"}</div>
        </TooltipPopup>
      </Tooltip>
      {children}
      {submit}
    </div>,
  );
});
