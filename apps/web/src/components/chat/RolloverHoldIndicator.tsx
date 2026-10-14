import type { OrchestrationV2RolloverHold } from "@t3tools/contracts";
import { useEffect, useState } from "react";

import { activeRolloverHold, describeRolloverHold } from "./rolloverCommand";

/** A dim note by the context window meter while the thread's automatic rollover is held. */
export function RolloverHoldIndicator(props: {
  hold: OrchestrationV2RolloverHold | null | undefined;
}) {
  const { hold } = props;
  const [nowMs, setNowMs] = useState(() => Date.now());
  const until = hold?.kind === "paused" ? Date.parse(hold.until) : null;
  useEffect(() => {
    setNowMs(Date.now());
    if (until === null) return;
    const remaining = until - Date.now();
    if (remaining <= 0) return;
    // setTimeout caps near 24.8 days; a pause lasts at most seven.
    const timer = setTimeout(() => setNowMs(Date.now()), remaining);
    return () => clearTimeout(timer);
  }, [hold, until]);
  const label = describeRolloverHold(activeRolloverHold(hold, nowMs), nowMs);
  if (label === null) return null;
  return <span className="shrink-0 text-muted-foreground/60 text-xs">{label}</span>;
}
