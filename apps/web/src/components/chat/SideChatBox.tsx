import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { threadRuntimeIsActive } from "@t3tools/client-runtime/state/models";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { createModelSelection } from "@t3tools/shared/model";
import { useNavigate } from "@tanstack/react-router";
import {
  CornerDownLeftIcon,
  MessagesSquareIcon,
  SquareArrowOutUpRightIcon,
  SquareIcon,
} from "lucide-react";
import { type ComponentProps, type KeyboardEvent, memo, useMemo, useState } from "react";

import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import { Textarea } from "../ui/textarea";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { newMessageId } from "~/lib/utils";
import { buildThreadRouteParams } from "../../threadRoutes";
import { useThreadShell, useThreadVisibleTurnItems } from "../../state/entities";
import { threadEnvironment } from "../../state/threads";
import { useOrchestrationCommand } from "../../state/use-orchestration-command";
import { ComposerBanner } from "./ComposerBanner";
import { ProviderModelPicker } from "./ProviderModelPicker";

type ModelPickerProps = ComponentProps<typeof ProviderModelPicker>;

/**
 * A side chat: a fork of the thread, docked above its composer, for questions
 * the main agent should not see. Closing it deletes the fork; "Open as fork"
 * keeps it as an ordinary thread.
 */
export const SideChatBox = memo(function SideChatBox(props: {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly cwd: string | undefined;
  readonly instanceEntries: ModelPickerProps["instanceEntries"];
  readonly modelOptionsByInstance: ModelPickerProps["modelOptionsByInstance"];
  readonly onUseInMain: (text: string) => void;
}) {
  const { environmentId, threadId } = props;
  const ref = useMemo(() => scopeThreadRef(environmentId, threadId), [environmentId, threadId]);
  const thread = useThreadShell(ref);
  const turnItems = useThreadVisibleTurnItems(ref);
  const navigate = useNavigate();
  const [draft, setDraft] = useState("");
  const [error, setError] = useState<string | null>(null);
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

  // Inherited items are the parent's history; the side chat shows only its own.
  const messages = useMemo(
    () =>
      turnItems.flatMap((projected) =>
        projected.visibility === "local" &&
        (projected.item.type === "user_message" || projected.item.type === "assistant_message")
          ? [projected.item]
          : [],
      ),
    [turnItems],
  );

  if (thread === null) return null;
  // Command failures only reach the console, so the box says what went wrong.
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
  const isRunning = threadRuntimeIsActive(thread.runtime);
  const sendDisabled = draft.trim().length === 0 || isRunning;
  // The box has no approval, question or plan controls; the full thread does.
  const waitingFor = thread.hasPendingApprovals
    ? "your approval"
    : thread.hasPendingUserInput
      ? "your answer"
      : thread.hasActionableProposedPlan
        ? "you to review its plan"
        : null;

  const send = async () => {
    const text = draft.trim();
    if (text.length === 0 || isRunning) return;
    setDraft("");
    const result = await startTurn({
      environmentId,
      input: {
        threadId,
        message: { messageId: newMessageId(), role: "user", text, attachments: [] },
        modelSelection: thread.modelSelection,
        runtimeMode: thread.runtimeMode,
        interactionMode: thread.interactionMode,
      },
    });
    if (!settle(result, "Could not send")) setDraft(text);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key !== "Enter" || event.shiftKey || event.nativeEvent.isComposing) return;
    event.preventDefault();
    void send();
  };

  const close = async () => {
    settle(await deleteThread({ environmentId, input: { threadId } }), "Could not close");
  };

  const openAsFork = async () => {
    const result = await keepSideChat({ environmentId, input: { threadId } });
    if (!settle(result, "Could not open as fork")) return;
    await navigate({ to: "/$environmentId/$threadId", params: buildThreadRouteParams(ref) });
  };

  return (
    <ComposerBanner.Attachment>
      <ComposerBanner.Root density="comfortable" data-chat-side-chat="true">
        <ComposerBanner.Row>
          <ComposerBanner.Icon>
            <MessagesSquareIcon />
          </ComposerBanner.Icon>
          <ComposerBanner.Content>
            <span className="flex-none font-medium text-foreground">Side chat</span>
            <ComposerBanner.Separator />
            <ProviderModelPicker
              environmentId={environmentId}
              activeInstanceId={thread.modelSelection.instanceId}
              model={thread.modelSelection.model}
              lockedProvider={null}
              instanceEntries={props.instanceEntries}
              modelOptionsByInstance={props.modelOptionsByInstance}
              size="xs"
              disabled={isRunning}
              onInstanceModelChange={async (instanceId, model) => {
                const result = await updateMetadata({
                  environmentId,
                  input: { threadId, modelSelection: createModelSelection(instanceId, model) },
                });
                settle(result, "Could not change the model");
              }}
            />
          </ComposerBanner.Content>
          <ComposerBanner.Actions>
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost-muted"
                    aria-label="Open as fork"
                    onClick={() => void openAsFork()}
                  />
                }
              >
                <SquareArrowOutUpRightIcon />
              </TooltipTrigger>
              <TooltipPopup>Open as fork</TooltipPopup>
            </Tooltip>
            <ComposerBanner.Dismiss aria-label="Close side chat" onClick={() => void close()} />
          </ComposerBanner.Actions>
        </ComposerBanner.Row>
        <ComposerBanner.Body className="grid gap-2 pe-1 pb-1">
          {messages.length > 0 ? (
            <ComposerBanner.Scroll>
              <div className="grid gap-2 text-sm">
                {messages.map((message) =>
                  message.type === "user_message" ? (
                    <p key={message.id} className="whitespace-pre-wrap text-muted-foreground">
                      {message.text}
                    </p>
                  ) : (
                    <div key={message.id} className="group/side-answer grid gap-1">
                      <ChatMarkdown
                        text={message.text}
                        cwd={props.cwd}
                        threadRef={ref}
                        isStreaming={message.streaming}
                      />
                      {!message.streaming && message.text.trim().length > 0 ? (
                        <Button
                          size="micro"
                          variant="ghost-muted"
                          className="justify-self-start"
                          onClick={() => props.onUseInMain(message.text)}
                        >
                          <CornerDownLeftIcon />
                          Use in main
                        </Button>
                      ) : null}
                    </div>
                  ),
                )}
              </div>
            </ComposerBanner.Scroll>
          ) : null}
          <div className="flex items-end gap-1.5">
            <Textarea
              size="sm"
              className="min-w-0 flex-1"
              value={draft}
              placeholder="Ask on the side. The main agent won't see this."
              aria-label="Side chat message"
              onChange={(event) => setDraft(event.target.value)}
              onKeyDown={onKeyDown}
            />
            {isRunning ? (
              <Button
                size="icon-sm"
                variant="ghost-muted"
                aria-label="Stop side chat"
                onClick={async () => {
                  const result = await interruptTurn({
                    environmentId,
                    input: {
                      threadId,
                      ...(thread.runtime?.activeRunId == null
                        ? {}
                        : { runId: thread.runtime.activeRunId }),
                    },
                  });
                  settle(result, "Could not stop");
                }}
              >
                <SquareIcon />
              </Button>
            ) : (
              <Button
                size="icon-sm"
                aria-label="Send side chat message"
                disabled={sendDisabled}
                onClick={() => void send()}
              >
                <CornerDownLeftIcon />
              </Button>
            )}
          </div>
          {waitingFor === null ? null : (
            <p className="text-muted-foreground">
              The side chat is waiting for {waitingFor}. Open it as a fork to respond.
            </p>
          )}
          {error === null ? null : <p className="text-destructive-foreground">{error}</p>}
        </ComposerBanner.Body>
      </ComposerBanner.Root>
    </ComposerBanner.Attachment>
  );
});
