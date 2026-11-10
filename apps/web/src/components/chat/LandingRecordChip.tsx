import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import type { OrchestrationV2Notification, ThreadId } from "@t3tools/contracts";
import { use } from "react";

import { cn } from "~/lib/utils";
import { formatShortTimestamp } from "../../timestampFormat";
import {
  SlipJayMark,
  SlipJaySpecLink,
  SlipJayTicket,
  type SlipJayTicketTone,
  useSlipJaySpec,
} from "../SlipJayTicket";
import { TimelineRowCtx } from "./timelineRowContext";

type Outcome = OrchestrationV2Notification["outcome"];

const PRESENTATION: Record<Outcome, { verb: string; tone: SlipJayTicketTone }> = {
  updated: { verb: "Landing submitted", tone: "waiting" },
  completed: { verb: "Landed", tone: "landed" },
  failed: { verb: "Landing failed", tone: "failed" },
  cancelled: { verb: "Landing cancelled", tone: "ended" },
  unknown: { verb: "Landing ended", tone: "ended" },
};

/** Where the thread submitted a landing, and where it finished; live progress stays in the header. */
export function LandingRecordChip({
  source,
  outcome,
  threadId,
  createdAt,
}: {
  readonly source: Extract<OrchestrationV2Notification["source"], { kind: "landing" }>;
  readonly outcome: Outcome;
  readonly threadId: ThreadId;
  readonly createdAt: string;
}) {
  const ctx = use(TimelineRowCtx);
  const spec = useSlipJaySpec(scopeThreadRef(ctx.activeThreadEnvironmentId, threadId), source.spec);
  const { verb, tone } = PRESENTATION[outcome];
  return (
    <SlipJayTicket
      tone={tone}
      torn={tone === "landed"}
      className="my-0.5 h-6 max-w-full text-xs"
      stub={
        <>
          <SlipJayMark />
          {spec === null ? null : <SlipJaySpecLink spec={spec} />}
        </>
      }
    >
      <span className="flex min-w-0 items-center gap-2 pe-2">
        <span className={cn("shrink-0 font-medium", tone === "failed" && "text-destructive")}>
          {verb}
        </span>
        {spec?.title ? (
          <span className="min-w-0 max-w-72 truncate text-muted-foreground">{spec.title}</span>
        ) : null}
        {source.commitId === undefined ? null : (
          <span className="shrink-0 font-mono text-slipjay-mint-strong dark:text-slipjay-mint">
            {source.commitId.slice(0, 7)}
          </span>
        )}
        <span className="shrink-0 font-mono text-muted-foreground/70 tabular-nums">
          {formatShortTimestamp(createdAt, ctx.timestampFormat)}
        </span>
      </span>
    </SlipJayTicket>
  );
}
