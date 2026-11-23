import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { MoonIcon } from "lucide-react";
import { useState } from "react";

import { playKeyClick } from "~/lib/interfaceSounds";
import { cn } from "~/lib/utils";
import { useAway } from "~/state/away";
import { useThreadShell } from "~/state/entities";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import { stackedThreadToast, toastManager } from "../ui/toast";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export function ThreadUnattendedButton(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  threadRef: ScopedThreadRef;
  threadTitle: string;
  canOperate: boolean;
}) {
  const shell = useThreadShell(props.threadRef);
  const away = useAway();
  const setAutonomousRun = useAtomCommand(threadEnvironment.setAutonomousRun);
  const [busy, setBusy] = useState(false);

  if (shell == null) return null;
  // Delegated subagents and Spec leads cannot own a thread-level autonomous run.
  if (shell.isDelegatedTask === true || shell.lineage.relationshipToParent === "subagent") {
    return null;
  }

  const arcRun = shell.arcRun ?? null;
  const autonomousRun = shell.autonomousRun ?? null;
  const run = arcRun ?? autonomousRun;
  const envAway =
    away.environments.find((environment) => environment.environmentId === props.environmentId)
      ?.away === true;
  const runActive = run?.state === "active";
  const runHeld = run?.state === "paused" || run?.state === "attention";
  const hasRun = run !== null;
  const effectiveOn = hasRun || envAway;
  const disabled =
    busy ||
    !props.canOperate ||
    (!hasRun && (shell.archivedAt !== null || shell.settledOverride === "settled"));

  const runLabel =
    arcRun !== null
      ? (arcRun.arc.ref ?? `#${arcRun.arc.number}`)
      : autonomousRun?.kind === "spec" && autonomousRun.spec !== undefined
        ? (autonomousRun.spec.ref ?? `#${autonomousRun.spec.number}`)
        : (autonomousRun?.label ?? "this thread");

  const tooltip = runActive
    ? arcRun !== null
      ? `Unattended is on via Arc ${runLabel}. Click to end the run.`
      : `Unattended is on for ${runLabel}. Click to turn off.`
    : runHeld
      ? `Unattended is paused (${runLabel}). Click to end it, or reply to resume.`
      : envAway
        ? "Unattended via global Away. Click to also pin this thread unattended after Away turns off."
        : "Run this thread unattended: decides reversible choices, logs assumptions, and keeps going until done.";

  const handleClick = async () => {
    if (disabled) return;
    const turningOn = !hasRun;
    playKeyClick(turningOn ? "down" : "up");
    setBusy(true);
    try {
      await setAutonomousRun({
        environmentId: props.environmentId,
        input: turningOn
          ? {
              threadId: props.threadId,
              op: "start",
              label: props.threadTitle.trim() || "Unattended",
            }
          : {
              threadId: props.threadId,
              op: "end",
            },
      });
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: turningOn ? "Couldn't turn unattended on" : "Couldn't turn unattended off",
          description: error instanceof Error ? error.message : "Try again.",
        }),
      );
    }
    setBusy(false);
  };

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <Button
            type="button"
            size="xs"
            variant="outline"
            disabled={disabled}
            aria-pressed={effectiveOn}
            aria-label={
              runActive
                ? "Unattended on"
                : runHeld
                  ? "Unattended paused"
                  : envAway
                    ? "Unattended via global Away"
                    : "Turn unattended on"
            }
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => void handleClick()}
            className={cn(
              "shrink-0 gap-1.5 [-webkit-app-region:no-drag]",
              runActive &&
                "border-primary/40 bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary",
              runHeld &&
                "border-amber-500/40 bg-amber-500/10 text-amber-600 hover:bg-amber-500/15 dark:text-amber-400",
              !hasRun &&
                envAway &&
                "border-primary/30 bg-primary/5 text-primary/80 hover:bg-primary/10 hover:text-primary",
            )}
          />
        }
      >
        <MoonIcon className="size-3" aria-hidden="true" />
        <span className="hidden sm:inline">
          {runHeld ? "Paused" : !hasRun && envAway ? "Away" : "Unattended"}
        </span>
        {runActive ? (
          <span className="size-1.5 rounded-full bg-primary" aria-hidden="true" />
        ) : runHeld ? (
          <span className="size-1.5 rounded-full bg-amber-500" aria-hidden="true" />
        ) : null}
      </TooltipTrigger>
      <TooltipPopup side="bottom">{tooltip}</TooltipPopup>
    </Tooltip>
  );
}
