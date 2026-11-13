import { arcRunChip } from "@t3tools/client-runtime/state/forge-work-items";
import type { OrchestrationV2ThreadArcRun, ScopedThreadRef, ThreadId } from "@t3tools/contracts";
import { useState } from "react";

import { randomUUID } from "~/lib/utils";
import { useThreadArcRunSummary } from "~/state/forgeWorkItems";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { ARC_RUN_STATE_LABEL, ArcRunProgressRing, ArcRunStateDot } from "./ArcRunGlyphs";
import { ArcRunView } from "./ArcRunView";

/**
 * The header chip of a thread that holds an Arc run: its Arc, how much of the run has landed and
 * its state. Opening it shows the run's plan and the whole Arc; a closed chip reads only counts.
 */
export function ArcRunChip(props: {
  threadRef: ScopedThreadRef;
  arcRun: OrchestrationV2ThreadArcRun;
  onOpenThread: (threadId: ThreadId) => void;
}) {
  const summary = useThreadArcRunSummary(props.threadRef).data ?? null;
  const chip = arcRunChip(props.arcRun, summary);
  const [opening, setOpening] = useState<string | null>(null);
  const progress = chip.progress;
  const fill =
    progress === null || progress.total === 0 || !chip.complete
      ? null
      : progress.landed / progress.total;
  return (
    <Popover
      open={opening !== null}
      onOpenChange={(open) => setOpening(open ? randomUUID() : null)}
    >
      <PopoverTrigger
        render={
          <Button
            size="xs"
            variant="outline"
            className="shrink-0 [-webkit-app-region:no-drag]"
            aria-label={`Arc run ${chip.label}${progress === null ? "" : `, ${progress.landed} of ${progress.total} landed${chip.complete ? "" : " so far; Forge was only partly read"}`}, ${ARC_RUN_STATE_LABEL[chip.state]}`}
          />
        }
      >
        <ArcRunProgressRing fill={fill} className="text-primary" />
        <span>{chip.label}</span>
        {progress === null ? null : (
          <span className="tabular-nums text-muted-foreground">
            {progress.landed}/{progress.total}
            {chip.complete ? null : "?"}
          </span>
        )}
        <ArcRunStateDot state={chip.state} />
      </PopoverTrigger>
      <PopoverPopup side="bottom" align="end" width="lg" padding="compact" className="w-[25rem]">
        {opening === null ? null : (
          <ArcRunView
            threadRef={props.threadRef}
            arcRun={props.arcRun}
            opening={opening}
            onOpenThread={(threadId) => {
              setOpening(null);
              props.onOpenThread(threadId);
            }}
          />
        )}
      </PopoverPopup>
    </Popover>
  );
}
