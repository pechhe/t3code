import {
  formatSlipJayDuration,
  resolveSlipJayLandingTimes,
} from "@t3tools/client-runtime/slipjay-checkout";
import type {
  EnvironmentId,
  VcsSlipJayLandingCheck,
  VcsStatusSlipJayLanding,
} from "@t3tools/contracts";
import { CheckIcon, CircleDashedIcon, XIcon } from "lucide-react";
import type { ReactNode } from "react";

import { cn } from "~/lib/utils";
import { useEnvironmentQuery } from "~/state/query";
import { vcsEnvironment } from "~/state/vcs";
import { formatRelativeTimeLabel } from "~/timestampFormat";
import { Badge } from "./ui/badge";
import { SlipJayMark, SlipJaySpecLink, type SlipJaySpec } from "./SlipJayTicket";

/**
 * One landing as the runner recorded it: the Spec it delivers, how it ended and when, how
 * long it and its checks took, what it published, and each check it ran. Read when shown,
 * and followed until the landing finishes.
 */
export function SlipJayLandingDetails({
  environmentId,
  cwd,
  landing,
  spec,
  label,
  now,
  actions,
}: {
  environmentId: EnvironmentId;
  cwd: string;
  landing: VcsStatusSlipJayLanding;
  spec: SlipJaySpec | null;
  label: string;
  now: number;
  actions: ReactNode;
}) {
  const query = useEnvironmentQuery(
    vcsEnvironment.slipJayLandingDetail({
      environmentId,
      input: { cwd, operationId: landing.operationId },
    }),
  );
  const detail = query.data;
  const times = detail === null ? null : resolveSlipJayLandingTimes(detail, now);
  const finishedAt = detail?.finishedAt;
  const commitId = detail?.commitId ?? landing.commitId;
  const reason = detail?.failure?.reason ?? landing.reason;

  return (
    <div className="flex flex-col gap-3 text-sm">
      <div className="flex min-w-0 items-start gap-2 border-b pb-2">
        <SlipJayMark className="mt-0.5 size-4 text-foreground [--jay-beak:var(--color-slipjay)] [--jay-eye:var(--popover)]" />
        <div className="flex min-w-0 flex-1 flex-col gap-0.5">
          <span className="flex min-w-0 items-center gap-1.5">
            {spec === null ? null : (
              <SlipJaySpecLink spec={spec} className="shrink-0 font-mono text-slipjay text-xs" />
            )}
            <span className="min-w-0 flex-1 truncate font-medium">
              {spec?.title ?? detail?.workspace ?? "Landing"}
            </span>
            {spec?.held ? (
              <Badge size="sm" variant="warning">
                Held
              </Badge>
            ) : spec?.status ? (
              <Badge size="sm" variant="secondary">
                {spec.status}
              </Badge>
            ) : null}
          </span>
          <span
            className={cn(
              "font-mono text-xs",
              landing.status === "failed"
                ? "text-destructive"
                : landing.status === "landed"
                  ? "text-slipjay-mint-strong dark:text-slipjay-mint"
                  : "text-muted-foreground",
            )}
          >
            {label}
            {finishedAt === undefined ? null : ` ${formatRelativeTimeLabel(finishedAt)}`}
          </span>
        </div>
      </div>

      {reason === undefined ? null : (
        <p className="wrap-break-word text-muted-foreground text-xs">{reason}</p>
      )}

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-xs">
        <Fact term="Took">{times?.took}</Fact>
        <Fact term="Checks">
          {times?.checks == null ? undefined : `${times.checks} across ${detail?.checks.length}`}
        </Fact>
        <Fact term="Published" mono>
          {commitId?.slice(0, 12)}
        </Fact>
        <Fact term="Onto" mono>
          {detail?.baseCommitId?.slice(0, 12)}
        </Fact>
        <Fact term="Workspace" mono>
          {detail?.workspace}
        </Fact>
        <Fact term="Operation" mono>
          {landing.operationId}
        </Fact>
      </dl>

      {detail === null ? (
        <p className="text-muted-foreground text-xs">
          {query.error ?? "Reading the landing from the runner…"}
        </p>
      ) : detail.checks.length === 0 ? null : (
        <section className="flex flex-col gap-1">
          <h3 className="font-mono font-semibold text-2xs text-muted-foreground uppercase tracking-widest">
            Checks
          </h3>
          <ul className="flex flex-col gap-1">
            {detail.checks.map((check, index) => (
              // Runs repeat commands across retries, so their order is their identity.
              // oxlint-disable-next-line react/no-array-index-key
              <CheckRow key={index} check={check} />
            ))}
          </ul>
        </section>
      )}

      <div className="flex flex-wrap items-center justify-end gap-1">{actions}</div>
    </div>
  );
}

function Fact({
  term,
  mono = false,
  children,
}: {
  term: string;
  mono?: boolean;
  children: ReactNode;
}) {
  if (children === undefined || children === null) return null;
  return (
    <>
      <dt className="text-muted-foreground">{term}</dt>
      <dd className={cn("min-w-0 truncate select-all", mono && "font-mono")}>{children}</dd>
    </>
  );
}

function CheckRow({ check }: { check: VcsSlipJayLandingCheck }) {
  const passed = check.outcome === "passed";
  const failed = check.outcome === "failed" || check.outcome === "killed";
  const Icon = passed ? CheckIcon : failed ? XIcon : CircleDashedIcon;
  return (
    <li className="flex min-w-0 flex-col gap-0.5">
      <span className="flex min-w-0 items-baseline gap-2 text-xs">
        <Icon
          aria-label={check.outcome}
          className={cn(
            "size-3 shrink-0 self-center",
            passed
              ? "text-slipjay-mint-strong dark:text-slipjay-mint"
              : failed
                ? "text-destructive"
                : "text-muted-foreground",
          )}
        />
        <span className="min-w-0 flex-1 truncate font-mono">{check.command}</span>
        {check.durationMs === undefined ? null : (
          <span className="shrink-0 font-mono text-muted-foreground tabular-nums">
            {formatSlipJayDuration(check.durationMs)}
          </span>
        )}
      </span>
      {check.failingTests.length === 0 ? null : (
        <ul className="ms-5 flex flex-col text-destructive text-xs">
          {check.failingTests.slice(0, 5).map((test) => (
            <li key={test} className="truncate font-mono">
              {test}
            </li>
          ))}
          {check.failingTests.length > 5 ? (
            <li className="text-muted-foreground">
              and {check.failingTests.length - 5} more in the log
            </li>
          ) : null}
        </ul>
      )}
    </li>
  );
}
