import type { EnvironmentId, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { MoonIcon, SunIcon } from "lucide-react";
import { useState } from "react";

import { playKeyClick } from "~/lib/interfaceSounds";
import { cn } from "~/lib/utils";
import { useAway } from "~/state/away";
import { useThreadShell } from "~/state/entities";
import { threadEnvironment } from "~/state/threads";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import {
  Menu,
  MenuGroup,
  MenuGroupLabel,
  MenuItem,
  MenuItemDetail,
  MenuPopup,
  MenuRadioGroup,
  MenuRadioItem,
  MenuRadioItemIndicator,
  MenuSeparator,
  MenuTrigger,
} from "../ui/menu";
import { stackedThreadToast, toastManager } from "../ui/toast";

/** How this thread treats the owner's absence: follow global Away, stay attended, or run unattended. */
type ThreadMode = "away" | "attended" | "run";
type RunOp = "start" | "end" | "away-off" | "away-on";

/** The commands that move a thread from one mode to another; ending a run comes first. */
export function threadModeOps(input: {
  readonly from: ThreadMode;
  readonly to: ThreadMode;
  readonly optedOut: boolean;
}): ReadonlyArray<RunOp> {
  if (input.from === input.to) return [];
  if (input.to === "run") return ["start"];
  const ops: Array<RunOp> = input.from === "run" ? ["end"] : [];
  if (input.to === "attended" && !input.optedOut) ops.push("away-off");
  if (input.to === "away" && input.optedOut) ops.push("away-on");
  return ops;
}

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

  const run = shell.arcRun ?? shell.autonomousRun ?? null;
  const awayEnvironment = away.environments.find(
    (environment) => environment.environmentId === props.environmentId,
  );
  const envAway = awayEnvironment?.away === true;
  const optedOut = shell.awayOptOut === true;
  const runHeld = run?.state === "paused" || run?.state === "attention";
  const mode: ThreadMode = run !== null ? "run" : optedOut ? "attended" : "away";
  // What the thread actually does now: Away only acts on it while Away is on.
  const unattendedNow = mode === "run" || (mode === "away" && envAway);
  const settled = shell.archivedAt !== null || shell.settledOverride === "settled";

  const choose = async (to: ThreadMode) => {
    const ops = threadModeOps({ from: mode, to, optedOut });
    if (ops.length === 0) return;
    playKeyClick(to === "attended" ? "up" : "down");
    setBusy(true);
    try {
      for (const op of ops) {
        await setAutonomousRun({
          environmentId: props.environmentId,
          input:
            op === "start"
              ? { threadId: props.threadId, op, label: props.threadTitle.trim() || "Unattended" }
              : { threadId: props.threadId, op },
        });
      }
    } catch (error) {
      toastManager.add(
        stackedThreadToast({
          type: "error",
          title: "Couldn't change this thread",
          description: error instanceof Error ? error.message : "Try again.",
        }),
      );
    }
    setBusy(false);
  };

  const label = runHeld
    ? "Paused"
    : mode === "run"
      ? "Unattended"
      : unattendedNow
        ? "Away"
        : "Attended";

  return (
    <Menu>
      <MenuTrigger
        disabled={busy || !props.canOperate}
        aria-label={`This thread: ${label}`}
        render={<Button type="button" size="xs" variant="outline" />}
        className={cn(
          "shrink-0 gap-1.5 [-webkit-app-region:no-drag]",
          mode === "run" &&
            !runHeld &&
            "border-primary/40 bg-primary/10 text-primary hover:bg-primary/15 hover:text-primary",
          runHeld &&
            "border-amber-500/40 bg-amber-500/10 text-amber-600 hover:bg-amber-500/15 dark:text-amber-400",
          mode === "away" &&
            envAway &&
            "border-primary/30 bg-primary/5 text-primary/80 hover:bg-primary/10 hover:text-primary",
        )}
      >
        {unattendedNow || runHeld ? (
          <MoonIcon className="size-3" aria-hidden="true" />
        ) : (
          <SunIcon className="size-3" aria-hidden="true" />
        )}
        <span className="hidden sm:inline">{label}</span>
        {mode === "run" ? (
          <span
            className={cn("size-1.5 rounded-full", runHeld ? "bg-amber-500" : "bg-primary")}
            aria-hidden="true"
          />
        ) : null}
      </MenuTrigger>
      <MenuPopup align="end" side="bottom" className="w-72">
        <MenuGroup>
          <MenuGroupLabel>This thread</MenuGroupLabel>
          <MenuRadioGroup value={mode} onValueChange={(next) => void choose(next as ThreadMode)}>
            <MenuRadioItem value="away">
              <ModeRow
                icon={<MoonIcon className="size-4" aria-hidden="true" />}
                title="Follow Away"
                detail={
                  envAway
                    ? "Away is on, so this thread works unattended."
                    : "Away is off, so this thread asks you as usual."
                }
              />
            </MenuRadioItem>
            <MenuRadioItem value="attended">
              <ModeRow
                icon={<SunIcon className="size-4" aria-hidden="true" />}
                title="Attended"
                detail="Always asks you, even while Away is on."
              />
            </MenuRadioItem>
            <MenuRadioItem value="run" disabled={settled && mode !== "run"}>
              <ModeRow
                icon={<MoonIcon className="size-4" aria-hidden="true" />}
                title={runHeld ? "Unattended (paused)" : "Unattended until done"}
                detail="Keeps going on its own until it finishes, whether or not Away is on."
              />
            </MenuRadioItem>
          </MenuRadioGroup>
        </MenuGroup>
        {awayEnvironment === undefined ? null : (
          <>
            <MenuSeparator />
            <MenuGroup>
              <MenuGroupLabel>Every thread</MenuGroupLabel>
              <MenuItem
                onClick={() => {
                  playKeyClick(away.next ? "down" : "up");
                  away.toggle();
                }}
              >
                <MoonIcon aria-hidden="true" />
                {away.next ? "Turn Away on" : "Turn Away off"}
                <MenuItemDetail>{envAway ? "On" : "Off"}</MenuItemDetail>
              </MenuItem>
            </MenuGroup>
          </>
        )}
      </MenuPopup>
    </Menu>
  );
}

function ModeRow(props: { icon: React.ReactNode; title: string; detail: string }) {
  return (
    <span className="flex items-start gap-2 py-0.5">
      <span className="mt-0.5 text-muted-foreground">{props.icon}</span>
      <span className="flex min-w-0 flex-1 flex-col">
        <span>{props.title}</span>
        <span className="text-muted-foreground text-xs leading-snug">{props.detail}</span>
      </span>
      <MenuRadioItemIndicator className="mt-0.5" />
    </span>
  );
}
