import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import {
  type EnvironmentThreadShell,
  threadRuntimeIsActive,
} from "@t3tools/client-runtime/state/models";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { ModelSelection } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { useNavigate } from "@tanstack/react-router";
import {
  ArrowUpIcon,
  CornerDownLeftIcon,
  SquareArrowOutUpRightIcon,
  SquareIcon,
  XIcon,
} from "lucide-react";
import { type KeyboardEvent, useMemo, useState } from "react";

import { observeVisibleAnimation } from "../../lib/visibleAnimation";
import { ActivityShimmerOverlay } from "./ActivityShimmer";
import { resolveProjectSettings } from "@t3tools/shared/projectSettings";
import { AssistantMessageText } from "./AssistantMessageText";
import { ScrollArea } from "../ui/scroll-area";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn, newMessageId, newThreadId } from "~/lib/utils";
import { useEnvironmentSettings } from "../../hooks/useSettings";
import { getAppModelOptionsForInstance } from "../../modelSelection";
import type { ProviderInstanceEntry } from "../../providerInstances";
import { buildThreadRouteParams } from "../../threadRoutes";
import {
  useSideChatThreadId,
  useThreadShell,
  useThreadVisibleTurnItems,
} from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { ProviderModelPicker } from "./ProviderModelPicker";
import { ThreadDetailsControl } from "./ThreadDetailsControl";

/**
 * A side chat: a hidden fork of the thread's latest finished turn, for questions
 * the main agent should not see. It lives in the right-hand column under the
 * thread details. The first message creates the fork; closing deletes it, and
 * "Open as fork" keeps it as an ordinary thread.
 */
export function SideChatCard(props: {
  readonly parent: EnvironmentThreadShell;
  readonly cwd: string | undefined;
  readonly instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  readonly onUseInMain: (text: string) => void;
}) {
  const { parent } = props;
  const parentRef = useMemo(
    () => scopeThreadRef(parent.environmentId, parent.id),
    [parent.environmentId, parent.id],
  );
  const sideChatId = useSideChatThreadId(parentRef);
  const sideChatRef = useMemo(
    () => (sideChatId === null ? null : scopeThreadRef(parent.environmentId, sideChatId)),
    [parent.environmentId, sideChatId],
  );
  const sideChat = useThreadShell(sideChatRef);
  const turnItems = useThreadVisibleTurnItems(sideChatRef);
  const settings = useEnvironmentSettings(parent.environmentId);
  const navigate = useNavigate();
  // Before the fork exists, the picker holds the model the first message starts it with.
  const [pendingModel, setPendingModel] = useState<ModelSelection | null>(null);
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [isOpening, setIsOpening] = useState(false);
  const openSideChat = useOrchestrationCommand(threadEnvironment.openSideChat, {
    label: "open side chat",
  });
  const startTurn = useOrchestrationCommand(threadEnvironment.startTurn, {
    label: "send side chat message",
  });
  const interruptTurn = useOrchestrationCommand(threadEnvironment.interruptTurn, {
    label: "stop side chat",
  });
  const updateMetadata = useOrchestrationCommand(threadEnvironment.updateMetadata, {
    label: "change side chat model",
  });
  const deleteThread = useOrchestrationCommand(threadEnvironment.delete, {
    label: "close side chat",
  });
  const keepSideChat = useOrchestrationCommand(threadEnvironment.keepSideChat, {
    label: "open side chat as fork",
  });
  const modelOptionsByInstance = useMemo(
    () =>
      new Map(
        props.instanceEntries.map((entry) => [
          entry.instanceId,
          getAppModelOptionsForInstance(settings, entry, null),
        ]),
      ),
    [props.instanceEntries, settings],
  );

  // Inherited items are the parent's history; the side chat shows only its own.
  const items = useMemo(
    () =>
      turnItems.flatMap((projected) =>
        projected.visibility === "local" &&
        (projected.item.type === "user_message" ||
          projected.item.type === "assistant_message" ||
          projected.item.type === "error")
          ? [projected.item]
          : [],
      ),
    [turnItems],
  );

  const modelSelection = sideChat?.modelSelection ?? pendingModel ?? parent.modelSelection;
  const isRunning = sideChat !== null && threadRuntimeIsActive(sideChat.runtime);
  const canStart = parent.latestRun !== null;
  const busy = isRunning || isOpening;
  const lastItem = items.at(-1);
  // Shimmer from send until the answer's first words stream in. An error or a
  // finished answer ends it, even while the run is still settling.
  const showThinking =
    error === null &&
    (isOpening ||
      (sideChat !== null && items.length === 0) ||
      (isRunning && lastItem?.type === "user_message"));
  // The card has no approval, question or plan controls; the full thread does.
  const waitingFor =
    sideChat === null
      ? null
      : sideChat.hasPendingApprovals
        ? "your approval"
        : sideChat.hasPendingUserInput
          ? "your answer"
          : sideChat.hasActionableProposedPlan
            ? "you to review its plan"
            : null;

  // Command failures only reach the console, so the card says what went wrong.
  const settle = <A, E>(result: AtomCommandResult<A, E>, message: string): boolean => {
    if (result._tag !== "Failure") {
      setError(null);
      return true;
    }
    if (!isAtomCommandInterrupted(result)) {
      const cause = squashAtomCommandFailure(result);
      setError(cause instanceof Error ? `${message}: ${cause.message}` : message);
    }
    return false;
  };

  const send = async () => {
    const text = draft.trim();
    if (text.length === 0 || busy || !canStart) return;
    setDraft("");
    let threadId = sideChat?.id ?? null;
    if (threadId === null) {
      setIsOpening(true);
      const targetThreadId = newThreadId();
      const opened = await openSideChat({
        environmentId: parent.environmentId,
        input: {
          sourceThreadId: parent.id,
          targetThreadId,
          title: `${parent.title} side chat`,
        },
      });
      setIsOpening(false);
      if (!settle(opened, "Could not open a side chat")) {
        setDraft(text);
        return;
      }
      threadId = targetThreadId;
    }
    const result = await startTurn({
      environmentId: parent.environmentId,
      input: {
        threadId,
        message: { messageId: newMessageId(), role: "user", text, attachments: [] },
        modelSelection,
        runtimeMode: sideChat?.runtimeMode ?? parent.runtimeMode,
        interactionMode: sideChat?.interactionMode ?? parent.interactionMode,
      },
    });
    if (!settle(result, "Could not send")) setDraft(text);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void send();
  };

  const stop = async () => {
    if (sideChat === null) return;
    const result = await interruptTurn({
      environmentId: parent.environmentId,
      input: {
        threadId: sideChat.id,
        ...(sideChat.runtime?.activeRunId == null ? {} : { runId: sideChat.runtime.activeRunId }),
      },
    });
    settle(result, "Could not stop");
  };

  const close = async () => {
    if (sideChat === null) return;
    const result = await deleteThread({
      environmentId: parent.environmentId,
      input: { threadId: sideChat.id },
    });
    if (settle(result, "Could not close")) setPendingModel(null);
  };

  const openAsFork = async () => {
    if (sideChatRef === null) return;
    const result = await keepSideChat({
      environmentId: parent.environmentId,
      input: { threadId: sideChatRef.threadId },
    });
    if (!settle(result, "Could not open as fork")) return;
    await navigate({
      to: "/$environmentId/$threadId",
      params: buildThreadRouteParams(sideChatRef),
    });
  };

  const changeModel = async (selection: ModelSelection) => {
    if (sideChat === null) {
      setPendingModel(selection);
      return;
    }
    const result = await updateMetadata({
      environmentId: parent.environmentId,
      input: { threadId: sideChat.id, modelSelection: selection },
    });
    settle(result, "Could not change the model");
  };

  const active = sideChat !== null;
  return (
    <section
      aria-label="Side chat"
      className={cn(
        "dropdown-glass pointer-events-auto flex min-h-0 flex-col overflow-hidden rounded-3xl text-xs",
        active && "flex-1",
      )}
      data-side-chat-card
    >
      <header className="flex min-h-8 items-center gap-1 px-3.5 pt-2">
        <h3 className="flex-none text-2xs font-medium text-muted-foreground select-none">
          Side chat
        </h3>
        <div className="min-w-0 flex-1">
          <ProviderModelPicker
            environmentId={parent.environmentId}
            activeInstanceId={modelSelection.instanceId}
            model={modelSelection.model}
            lockedProvider={null}
            instanceEntries={props.instanceEntries}
            modelOptionsByInstance={modelOptionsByInstance}
            size="xs"
            disabled={busy}
            onInstanceModelChange={(instanceId, model) =>
              void changeModel(createModelSelection(instanceId, model))
            }
          />
        </div>
        {active ? (
          <>
            <Tooltip>
              <TooltipTrigger
                render={
                  <ThreadDetailsControl
                    part="icon"
                    aria-label="Open as fork"
                    onClick={() => void openAsFork()}
                  />
                }
              >
                <SquareArrowOutUpRightIcon className="size-3.5 text-muted-foreground" />
              </TooltipTrigger>
              <TooltipPopup>Open as fork</TooltipPopup>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger
                render={
                  <ThreadDetailsControl
                    part="icon"
                    aria-label="Close side chat"
                    onClick={() => void close()}
                  />
                }
              >
                <XIcon className="size-3.5 text-muted-foreground" />
              </TooltipTrigger>
              <TooltipPopup>Close and delete</TooltipPopup>
            </Tooltip>
          </>
        ) : null}
      </header>

      {active || isOpening ? (
        <ScrollArea scrollFade className="min-h-0 flex-1">
          <div className="grid gap-3 px-3.5 py-2">
            {items.map((item) =>
              item.type === "user_message" ? (
                <p
                  key={item.id}
                  className="justify-self-end rounded-2xl bg-muted/60 px-2.5 py-1.5 whitespace-pre-wrap text-foreground"
                >
                  {item.text}
                </p>
              ) : item.type === "error" ? (
                <p key={item.id} className="text-destructive-foreground">
                  {item.title ?? "The side chat failed"}: {item.failure.message}
                </p>
              ) : (
                <div key={item.id} className="grid gap-1">
                  <AssistantMessageText
                    text={item.text}
                    cwd={props.cwd}
                    threadRef={sideChatRef ?? parentRef}
                    streaming={item.streaming}
                    calm={
                      resolveProjectSettings(settings, parent.projectId).settings
                        .responseStreamingMode === "live"
                    }
                  />
                  {!item.streaming && item.text.trim().length > 0 ? (
                    <ThreadDetailsControl
                      part="meta"
                      tone="muted"
                      className="justify-self-start"
                      onClick={() => props.onUseInMain(item.text)}
                    >
                      <CornerDownLeftIcon className="size-3" />
                      Use in main
                    </ThreadDetailsControl>
                  ) : null}
                </div>
              ),
            )}
            {showThinking && waitingFor === null ? (
              <span
                ref={observeVisibleAnimation}
                className="relative justify-self-start overflow-hidden whitespace-nowrap text-muted-foreground"
              >
                Thinking…
                <ActivityShimmerOverlay>Thinking…</ActivityShimmerOverlay>
              </span>
            ) : null}
            {waitingFor === null ? null : (
              <p className="text-muted-foreground">
                Waiting for {waitingFor}. Open it as a fork to respond.
              </p>
            )}
          </div>
        </ScrollArea>
      ) : null}

      <div className="p-2 pt-1">
        <div className="flex items-end gap-1 rounded-2xl border border-border/65 bg-background/60 p-1 ps-2.5 focus-within:border-ring/60">
          <textarea
            className="field-sizing-content max-h-32 min-h-7 min-w-0 flex-1 resize-none bg-transparent py-1 text-xs text-foreground outline-none placeholder:text-muted-foreground/70"
            rows={1}
            value={draft}
            disabled={!canStart}
            placeholder={
              canStart
                ? active
                  ? "Ask a follow-up"
                  : "Ask on the side. The main agent won't see it."
                : "Opens after the first reply"
            }
            aria-label="Side chat message"
            onChange={(event) => setDraft(event.target.value)}
            onKeyDown={onKeyDown}
          />
          {isRunning ? (
            <ThreadDetailsControl
              part="icon"
              aria-label="Stop side chat"
              onClick={() => void stop()}
            >
              <SquareIcon className="size-3" />
            </ThreadDetailsControl>
          ) : (
            <ThreadDetailsControl
              part="icon"
              tone="primary"
              aria-label="Send side chat message"
              disabled={draft.trim().length === 0 || busy || !canStart}
              onClick={() => void send()}
            >
              <ArrowUpIcon className="size-3.5" />
            </ThreadDetailsControl>
          )}
        </div>
        {error === null ? null : <p className="px-1.5 pt-1 text-destructive-foreground">{error}</p>}
      </div>
    </section>
  );
}
