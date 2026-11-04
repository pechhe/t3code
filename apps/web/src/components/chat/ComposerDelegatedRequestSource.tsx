import { agentTaskTopic, type ScopedThreadRef, type ThreadId } from "@t3tools/contracts";
import { useState } from "react";

import { useThreadShell } from "~/state/entities";
import { AgentRoleChip } from "../AgentRoleChip";
import ChatMarkdown from "../ChatMarkdown";
import { Button } from "../ui/button";
import { ComposerBanner } from "./ComposerBanner";

/** A subagent's latest message, opened in place beside what it is asking. */
export function DelegatedRequestContext(props: {
  readonly threadRef: ScopedThreadRef;
  readonly text: string;
  readonly cwd: string | null | undefined;
}) {
  return (
    <ComposerBanner.Scroll className="max-h-[min(16rem,30dvh)]">
      <div className="ps-1.5 pe-1 wrap-anywhere">
        <ChatMarkdown
          text={props.text}
          cwd={props.cwd ?? undefined}
          threadRef={props.threadRef}
          className="font-response text-foreground/85"
        />
      </div>
    </ComposerBanner.Scroll>
  );
}

/** Names the subagent behind a question or permission answered from its parent's composer. */
export function ComposerDelegatedRequestSource(props: {
  readonly threadRef: ScopedThreadRef;
  readonly kind: "approval" | "input";
  readonly onOpenThread: (threadId: ThreadId) => void;
}) {
  const shell = useThreadShell(props.threadRef);
  const [contextOpen, setContextOpen] = useState(false);
  const role = shell?.source.agentTask?.role;
  const title = shell?.title ?? "Subagent";
  const message = shell?.source.latestVisibleMessage;
  const context = message?.role === "assistant" ? message.text.trim() : "";
  return (
    <div className="grid gap-1 pb-1">
      <div className="flex min-w-0 items-center gap-1.5 ps-1.5">
        {role ? <AgentRoleChip role={role} className="flex-none" /> : null}
        <span className="min-w-0 truncate font-medium text-foreground">
          {role ? agentTaskTopic(title, role) : title}
        </span>
        <span className="flex-none text-muted-foreground">
          {props.kind === "approval" ? "needs your permission" : "is asking"}
        </span>
        <span className="ms-auto flex flex-none items-center gap-0.5">
          {context === "" ? null : (
            <Button
              size="xs"
              variant="ghost"
              aria-expanded={contextOpen}
              onClick={() => setContextOpen((open) => !open)}
            >
              {contextOpen ? "Hide context" : "Show context"}
            </Button>
          )}
          <Button
            size="xs"
            variant="ghost"
            onClick={() => props.onOpenThread(props.threadRef.threadId)}
          >
            Open thread
          </Button>
        </span>
      </div>
      {contextOpen ? (
        <DelegatedRequestContext
          threadRef={props.threadRef}
          text={context}
          cwd={shell?.worktreePath}
        />
      ) : null}
    </div>
  );
}
