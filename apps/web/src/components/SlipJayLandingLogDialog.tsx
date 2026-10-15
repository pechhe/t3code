import type { EnvironmentId, VcsStatusSlipJayLanding } from "@t3tools/contracts";

import { useEnvironmentQuery } from "~/state/query";
import { vcsEnvironment } from "~/state/vcs";
import { resolveSlipJayLandingLabel } from "@t3tools/client-runtime/slipjay-checkout";
import {
  Dialog,
  DialogDescription,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";

/** The runner log of one SlipJay landing, read through `slipjay runner log` when opened. */
export function SlipJayLandingLogDialog({
  environmentId,
  cwd,
  landing,
  open,
  onOpenChange,
}: {
  environmentId: EnvironmentId;
  cwd: string;
  landing: VcsStatusSlipJayLanding;
  open: boolean;
  onOpenChange: (open: boolean) => void;
}) {
  const logQuery = useEnvironmentQuery(
    open
      ? vcsEnvironment.slipJayLandingLog({
          environmentId,
          input: { cwd, operationId: landing.operationId },
        })
      : null,
  );
  const log = logQuery.data;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogPopup className="max-w-3xl">
        <DialogHeader>
          <DialogTitle>{resolveSlipJayLandingLabel(landing)}</DialogTitle>
          <DialogDescription>
            {landing.reason ?? `SlipJay runner log for ${landing.operationId}.`}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          {log !== null ? (
            <pre className="max-h-[60vh] overflow-auto whitespace-pre-wrap wrap-break-word rounded-md border border-border/70 bg-background/70 p-3 font-mono text-2xs leading-relaxed text-muted-foreground/90">
              {log.log}
              {log.truncated
                ? `\n… The log continues; run \`slipjay runner log ${landing.operationId}\` for the rest.`
                : null}
            </pre>
          ) : (
            <p className="text-muted-foreground text-xs">
              {logQuery.error ?? "Reading the runner log…"}
            </p>
          )}
        </DialogPanel>
      </DialogPopup>
    </Dialog>
  );
}
