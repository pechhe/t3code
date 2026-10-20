import {
  memo,
  type MouseEventHandler,
  type PointerEvent as ReactPointerEvent,
  type PointerEventHandler,
  useRef,
} from "react";
import {
  ArrowRightIcon,
  CheckIcon,
  ChevronDownIcon,
  ChevronLeftIcon,
  ChevronsRightIcon,
  MessageSquarePlusIcon,
  Minimize2Icon,
  PencilIcon,
  PlayIcon,
} from "lucide-react";
import { CornerUpRight, ListPlus } from "lucide";
import { MorphIcon } from "~/components/MorphIcon";
import { useEnvironmentIdentificationMode } from "~/hooks/useSettings";
import { formatContextWindowTokens } from "~/lib/contextWindow";
import { dialClicks, pressClick } from "~/lib/interfaceSounds";
import { cn } from "~/lib/utils";
import { useShortcutModifierState } from "../../shortcutModifierState";
import { StageBackdropButtonArt, useSidebarStageBackdropVariant } from "../SidebarStageBackdrop";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuPopup, MenuTrigger } from "../ui/menu";
import { Spinner } from "../ui/spinner";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { composerFloatingLayerProps } from "./composerEventScope";
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
  compact: boolean;
  canOperateThread: boolean;
  pendingAction: PendingActionState | null;
  isRunning: boolean;
  canInterrupt: boolean;
  followUpBehavior?: "queue" | "steer";
  canSteer?: boolean;
  alternateShortcutLabel?: string | null;
  showPlanFollowUpPrompt: boolean;
  promptHasText: boolean;
  isSendBusy: boolean;
  sendDisabledReason: string | null;
  isConnecting: boolean;
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
  onImplementPlanInNewThread: () => void;
  compactBeforeSendTokens?: number | null;
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

const messageActionPillClassName =
  "inline-flex shrink-0 cursor-pointer items-center justify-center gap-1.5 whitespace-nowrap rounded-full bg-message-action font-medium text-base text-message-action-foreground shadow-xs shadow-message-action/24 outline-none hover:bg-message-action-hover focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring focus-visible:ring-offset-1 focus-visible:ring-offset-background disabled:pointer-events-none disabled:opacity-64 disabled:shadow-none sm:text-sm";

const preventPointerFocus: PointerEventHandler<HTMLElement> = (event) => {
  event.preventDefault();
};

export const ComposerPrimaryActions = memo(function ComposerPrimaryActions({
  compact,
  canOperateThread,
  pendingAction,
  isRunning,
  canInterrupt,
  followUpBehavior = "steer",
  canSteer = true,
  alternateShortcutLabel = null,
  showPlanFollowUpPrompt,
  promptHasText,
  isSendBusy,
  sendDisabledReason,
  isConnecting,
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
  onImplementPlanInNewThread,
  compactBeforeSendTokens = null,
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
  const stageBackdropVariant = useSidebarStageBackdropVariant(
    environmentIdentificationMode === "artwork",
  );

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
            disabled={!canOperateThread}
            onClick={() => {
              if (canOperateThread) onInterrupt();
            }}
            aria-label="Stop generation"
          />
        }
      >
        <svg width="12" height="12" viewBox="0 0 12 12" fill="currentColor" aria-hidden="true">
          <rect x="2" y="2" width="8" height="8" rx="1.5" />
        </svg>
      </TooltipTrigger>
      <TooltipPopup>Interrupt</TooltipPopup>
    </Tooltip>
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
        {canInterrupt ? renderStopGenerationButton(true) : null}
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
        <button
          type="submit"
          className={cn(messageActionPillClassName, "h-8 sm:h-7", compact ? "px-3" : "px-4")}
          {...pointerPropsFor(() => dialClicks(false))}
          disabled={
            !canOperateThread ||
            isEnvironmentUnavailable ||
            pendingAction.isResponding ||
            (pendingAction.isLastQuestion ? !pendingAction.isComplete : !pendingAction.canAdvance)
          }
        >
          {formatPendingPrimaryActionLabel({
            compact,
            isLastQuestion: pendingAction.isLastQuestion,
            isResponding: pendingAction.isResponding,
            questionIndex: pendingAction.questionIndex,
          })}
        </button>
      </div>
    );
  }

  if (showPlanFollowUpPrompt && (promptHasText || !canResume)) {
    const planDisabled = isSendBusy || isSendDisabled || isConnecting || isEnvironmentUnavailable;
    if (device) {
      const sending = isConnecting || isSendBusy;
      const dial = (
        <button
          type="submit"
          className="send-dial"
          data-has-input={planDisabled ? undefined : ""}
          {...pointerPropsFor(() => dialClicks(false))}
          disabled={planDisabled}
          aria-label={promptHasText ? "Refine plan" : "Implement plan"}
        >
          {sending ? (
            <Spinner size="sm" aria-hidden="true" />
          ) : promptHasText ? (
            <PencilIcon aria-hidden="true" />
          ) : (
            <ChevronsRightIcon aria-hidden="true" />
          )}
        </button>
      );
      return (
        <div className="device-actions">
          {promptHasText ? null : (
            <DeviceUnit caption="New thread">
              <Tooltip>
                <TooltipTrigger
                  render={
                    <button
                      type="button"
                      className="device-cap"
                      {...pointerFocusProps}
                      disabled={planDisabled}
                      onClick={() => {
                        if (canOperateThread) onImplementPlanInNewThread();
                      }}
                      aria-label="Implement in a new thread"
                    />
                  }
                >
                  <MessageSquarePlusIcon aria-hidden="true" />
                </TooltipTrigger>
                <TooltipPopup>Implement in a new thread</TooltipPopup>
              </Tooltip>
            </DeviceUnit>
          )}
          <DeviceUnit
            caption={sending ? "Sending" : promptHasText ? "Refine" : "Implement"}
            lit={!planDisabled}
          >
            {dial}
          </DeviceUnit>
        </div>
      );
    }
    if (promptHasText) {
      return (
        <button
          type="submit"
          className={cn(messageActionPillClassName, "h-9 sm:h-8", compact ? "px-3" : "px-4")}
          {...pointerPropsFor(() => dialClicks(false))}
          disabled={planDisabled}
        >
          {isConnecting || isSendBusy ? "Sending..." : "Refine"}
        </button>
      );
    }

    return (
      <div data-chat-composer-implement-actions="true" className="flex items-center justify-end">
        <button
          type="submit"
          className={cn(messageActionPillClassName, "h-9 rounded-r-none px-4 sm:h-8")}
          {...pointerPropsFor(() => dialClicks(false))}
          disabled={planDisabled}
        >
          {isConnecting || isSendBusy ? "Sending..." : "Implement"}
        </button>
        <Menu>
          <MenuTrigger
            render={
              <button
                type="button"
                className={cn(
                  messageActionPillClassName,
                  "h-9 rounded-l-none border-l border-message-action-foreground/20 px-2 sm:h-8",
                )}
                aria-label="Implementation actions"
                onMouseDown={
                  preserveComposerFocusOnPointerDown ? (event) => event.preventDefault() : undefined
                }
                disabled={planDisabled}
              />
            }
          >
            <ChevronDownIcon className="size-3.5" />
          </MenuTrigger>
          <MenuPopup align="end" side="top" {...composerFloatingLayerProps}>
            <MenuItem
              disabled={planDisabled}
              onClick={() => {
                if (canOperateThread) onImplementPlanInNewThread();
              }}
            >
              Implement in a new thread
            </MenuItem>
          </MenuPopup>
        </Menu>
      </div>
    );
  }

  if (canInterrupt && !hasSendableContent && !isEditingQueuedMessage) {
    return device ? (
      <DeviceUnit caption="Stop" lit>
        {renderStopGenerationButton(false)}
      </DeviceUnit>
    ) : (
      renderStopGenerationButton(false)
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
      (isConnecting
        ? "Connecting"
        : isPreparingWorktree
          ? "Preparing worktree"
          : isSendBusy
            ? isEditingQueuedMessage
              ? "Updating queued message"
              : "Submitting message"
            : null));
  const submitTooltip =
    submitStatus ??
    (compactsBeforeSend
      ? `Summarize ${compactTokens} tokens of history, then send`
      : isRunning && !isEditingQueuedMessage && canSteer
        ? `Click to ${followUpBehavior}, Ctrl/⌘-click${alternateShortcutLabel ? ` or ${alternateShortcutLabel}` : ""} to ${alternateAction}`
        : submitLabel);

  const deviceCaption = isEnvironmentUnavailable
    ? "Offline"
    : isConnecting
      ? "Connecting"
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
        isConnecting ||
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
      {isConnecting || isSendBusy ? (
        <Spinner size="sm" aria-hidden="true" />
      ) : showResume ? (
        <PlayIcon className="size-4 fill-current" aria-hidden="true" />
      ) : isEditingQueuedMessage ? (
        <CheckIcon className="size-4" aria-hidden="true" />
      ) : isRunning ? (
        <MorphIcon className="size-4" icon={isQueuing ? ListPlus : CornerUpRight} />
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
  if (compactTokens === null) return submit;

  return (
    <div data-chat-composer-compact-send="true" className="flex items-center gap-2">
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              className={cn(
                "flex h-9 shrink-0 cursor-pointer items-center gap-1.5 rounded-full border px-2.5 text-xs tabular-nums outline-none transition-colors focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-64 sm:h-8 [&_svg]:pointer-events-none [&_svg]:size-3.5",
                keepFullHistory
                  ? "border-border text-muted-foreground hover:text-foreground"
                  : "border-warning/40 text-warning hover:bg-warning/8",
              )}
              {...pointerFocusProps}
              aria-pressed={!keepFullHistory}
              aria-label={`Compact ${compactTokens} tokens of history before sending`}
              disabled={!canOperateThread}
              onClick={onToggleKeepFullHistory}
            />
          }
        >
          <Minimize2Icon aria-hidden="true" />
          {keepFullHistory ? "Full" : "Compact"}
          <span>{compactTokens}</span>
        </TooltipTrigger>
        <TooltipPopup>
          <div>
            {keepFullHistory
              ? `Next send keeps all ${compactTokens} tokens.`
              : `Next send compacts ${compactTokens} tokens first.`}
          </div>
          <div>{keepFullHistory ? "Click to compact first" : "Click to keep full history"}</div>
        </TooltipPopup>
      </Tooltip>
      {submit}
    </div>
  );
});
