import type {
  BuildHomeAcceptanceNeed,
  BuildHomeItem,
  BuildHomeOtherNeed,
  BuildHomeState,
  EnvironmentId,
  ThreadId,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { ExternalLinkIcon } from "lucide-react";
import { useState } from "react";

import { Badge } from "~/components/ui/badge";
import { Button } from "~/components/ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { Textarea } from "~/components/ui/textarea";
import { toastManager } from "~/components/ui/toast";
import { cn } from "~/lib/utils";
import { buildWorkItems, useBuildHome } from "~/state/buildWorkItems";
import { useAtomCommand } from "~/state/use-atom-command";
import { BuildItemLabel } from "./BuildItemLabel";
import {
  buildButtonCount,
  buildDecisionEnabled,
  latestBuildHomeState,
} from "./BuildHomeButton.logic";

const failureMessage = (result: Parameters<typeof squashAtomCommandFailure>[0]) => {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : "Something went wrong.";
};

function SpecName({ spec }: { spec: BuildHomeItem }) {
  return (
    <span className="min-w-0">
      <BuildItemLabel item={spec} className="font-semibold" />{" "}
      <span className="text-muted-foreground">{spec.title}</span>
    </span>
  );
}

function SectionHeading({ children }: { children: string }) {
  return (
    <p className="m-0 text-[11px] font-medium uppercase tracking-wide text-muted-foreground">
      {children}
    </p>
  );
}

const verdictDot = {
  met: "bg-success",
  not_met: "bg-destructive",
  missing: "bg-warning",
  stale: "bg-warning",
};

function AcceptanceCard(props: {
  need: BuildHomeAcceptanceNeed;
  environmentId: EnvironmentId;
  onState: (state: BuildHomeState) => void;
  /** Why the last decision on this Spec did not go through; kept above the card, which a fresh card replaces. */
  notice: string | null;
  onNotice: (message: string | null) => void;
}) {
  const { need, environmentId } = props;
  const decide = useAtomCommand(buildWorkItems.homeDecide, { reportFailure: false });
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const message = props.notice;
  const setMessage = props.onNotice;

  const submit = async (decision: "accept" | "send_back") => {
    if (need.card === null) return;
    setPending(true);
    setMessage(null);
    const result = await decide({
      environmentId,
      input: {
        specId: need.spec.id,
        decision,
        card: need.card,
        ...(decision === "send_back" ? { note: note.trim() } : {}),
      },
    });
    setPending(false);
    if (result._tag !== "Success") return setMessage(failureMessage(result));
    props.onState(result.value.state);
    if (result.value.outcome === "decided") return setNote("");
    setMessage(result.value.message);
  };

  return (
    <div className="flex flex-col gap-2 rounded-lg border p-3 text-xs">
      <div className="flex items-start justify-between gap-2 text-sm">
        <SpecName spec={need.spec} />
        <a
          href={need.url}
          target="_blank"
          rel="noreferrer"
          aria-label="Open in Weave"
          className="shrink-0 text-muted-foreground hover:text-foreground"
        >
          <ExternalLinkIcon className="size-3.5" />
        </a>
      </div>
      {need.repositories.length > 0 ? (
        <p className="m-0 text-muted-foreground">{need.repositories.join(", ")}</p>
      ) : null}
      <div className="flex flex-wrap gap-1">
        {need.checks.map((check) => (
          <Badge
            key={check.label}
            size="sm"
            variant={check.met === null ? "outline" : check.met ? "success" : "warning"}
          >
            {check.label}
          </Badge>
        ))}
      </div>
      {need.reviewSummary ? <p className="m-0">{need.reviewSummary}</p> : null}
      <ul className="m-0 flex list-none flex-col gap-1 p-0">
        {need.rows.map((row) => (
          <li key={row.rowId} className="flex gap-1.5">
            <span
              aria-hidden
              className={cn("mt-1 size-1.5 shrink-0 rounded-full", verdictDot[row.verdict])}
            />
            <span>
              {row.text}
              <span className="text-muted-foreground">
                {" · "}
                {row.verdict.replace("_", " ")}
                {row.evidence ? ` · ${row.evidence}` : ""}
              </span>
            </span>
          </li>
        ))}
      </ul>
      {need.tryIt ? (
        <p className="m-0 rounded-md bg-muted px-2 py-1.5">Try it: {need.tryIt}</p>
      ) : null}
      {need.card === null ? null : (
        <>
          <Textarea
            size="sm"
            aria-label={`Note for ${need.spec.title}`}
            placeholder="Note (needed to send back)"
            value={note}
            onChange={(event) => setNote(event.target.value)}
          />
          <div className="flex gap-2">
            <Button size="xs" disabled={pending} onClick={() => void submit("accept")}>
              Accept
            </Button>
            <Button
              size="xs"
              variant="outline"
              disabled={pending || !buildDecisionEnabled(need, "send_back", note)}
              onClick={() => void submit("send_back")}
            >
              Send back
            </Button>
          </div>
        </>
      )}
      {message ? (
        <p className="m-0 text-warning-foreground" role="status">
          {message}
        </p>
      ) : null}
    </div>
  );
}

const otherLabels = {
  finding: "Review finding needs a decision",
  hold: "On hold",
  decision: "Proposed Decision",
} as const;

function OtherCard({ need }: { need: BuildHomeOtherNeed }) {
  return (
    <a
      href={need.url}
      target="_blank"
      rel="noreferrer"
      className="flex flex-col gap-0.5 rounded-lg border p-2.5 text-xs hover:bg-accent/40"
    >
      <span className="text-sm">
        <SpecName spec={need.spec} />
      </span>
      <span className="text-muted-foreground">
        {otherLabels[need.kind]}
        {need.detail ? `: ${need.detail}` : ""} · decide in Weave
      </span>
    </a>
  );
}

export function BuildHomeButton(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  onOpenThread: (threadId: ThreadId) => void;
}) {
  const { environmentId, threadId } = props;
  const query = useBuildHome(environmentId);
  const [decided, setDecided] = useState<BuildHomeState | null>(null);
  const [notices, setNotices] = useState<Readonly<Record<string, string>>>({});
  const fix = useAtomCommand(buildWorkItems.homeFix, { reportFailure: false });
  const [open, setOpen] = useState(false);
  const [fixing, setFixing] = useState<string | null>(null);
  // A decision's own answer shows at once, until a newer read replaces it.
  const state = latestBuildHomeState(decided, query.data);
  const count = buildButtonCount(state);
  const home = state?.home ?? null;

  const doIt = async (spec: BuildHomeItem, kind: string) => {
    setFixing(`${spec.number}:${kind}`);
    const result = await fix({ environmentId, input: { threadId, specNumber: spec.number, kind } });
    setFixing(null);
    if (result._tag === "Success") {
      setOpen(false);
      return props.onOpenThread(result.value.threadId);
    }
    toastManager.add({
      type: "error",
      title: "Could not start the thread",
      description: failureMessage(result),
    });
    query.refresh();
  };

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setDecided(null);
          setNotices({});
          query.refresh();
        }
      }}
    >
      <PopoverTrigger
        render={
          <Button
            size="xs"
            variant="outline"
            aria-label={count === 0 ? "Build" : `Build, ${count} need you`}
          />
        }
      >
        Build
        {count === 0 ? null : (
          <span className="rounded-full bg-amber-500 px-1.5 text-[11px] font-semibold leading-4 text-black">
            {count}
          </span>
        )}
      </PopoverTrigger>
      <PopoverPopup side="bottom" align="end" width="lg" padding="compact">
        <div className="flex max-h-[70vh] flex-col gap-3 overflow-y-auto text-sm">
          {state === null ? (
            <p className="m-0 text-xs text-muted-foreground">
              {query.error === null ? "Reading Build from HQ…" : "Couldn't read Build from T3."}
            </p>
          ) : state.status === "not_connected" ? (
            <p className="m-0 text-xs text-muted-foreground">
              T3 is not connected to YardSmith HQ. Create a delegation in HQ Settings → Connections
              → T3 agents, then ask any thread to connect T3 to HQ with it.
            </p>
          ) : state.status === "invalid_token" ? (
            <p className="m-0 text-xs text-warning-foreground">
              HQ refused T3's delegation: it expired or was revoked. Create a new one in HQ Settings
              → Connections → T3 agents, then ask any thread to reconnect T3 to HQ with it.
            </p>
          ) : (
            <>
              {state.status === "unavailable" ? (
                <p className="m-0 text-xs text-muted-foreground">
                  HQ could not be reached; this is Build as last read.
                </p>
              ) : null}
              {home === null ? null : (
                <>
                  <SectionHeading>Needs you</SectionHeading>
                  {home.needsYou.length === 0 ? (
                    <p className="m-0 text-xs text-muted-foreground">Nothing is waiting on you.</p>
                  ) : (
                    home.needsYou.map((need) =>
                      need.kind === "acceptance" ? (
                        <AcceptanceCard
                          key={`${need.spec.id}:${need.card?.reviewRunId ?? ""}:${need.card?.bodyRevision ?? ""}`}
                          need={need}
                          environmentId={environmentId}
                          onState={setDecided}
                          notice={notices[need.spec.id] ?? null}
                          onNotice={(message) =>
                            setNotices(({ [need.spec.id]: _previous, ...rest }) =>
                              message === null ? rest : { ...rest, [need.spec.id]: message },
                            )
                          }
                        />
                      ) : (
                        <OtherCard key={`${need.kind}:${need.spec.id}`} need={need} />
                      ),
                    )
                  )}
                  {home.stuck.length === 0 ? null : <SectionHeading>Stuck</SectionHeading>}
                  {home.stuck.map((line) => (
                    <div
                      key={`${line.spec.number}:${line.kind}`}
                      className="flex flex-col gap-1 rounded-lg border border-warning/40 bg-warning/8 p-2.5 text-xs"
                    >
                      <span>
                        <BuildItemLabel item={line.spec} className="font-semibold" /> {line.blocker}
                      </span>
                      <span className="text-muted-foreground">Proposed: {line.fix}</span>
                      <Button
                        size="xs"
                        variant="outline"
                        className="self-start"
                        disabled={fixing !== null}
                        onClick={() => void doIt(line.spec, line.kind)}
                      >
                        Do it
                      </Button>
                    </div>
                  ))}
                  {home.inProgress.length === 0 ? null : (
                    <SectionHeading>In progress</SectionHeading>
                  )}
                  {home.inProgress.map((entry) => (
                    <div
                      key={entry.spec.id}
                      className="flex justify-between gap-2 border-b py-1 text-xs"
                    >
                      <span className="min-w-0 truncate">
                        <SpecName spec={entry.spec} />
                      </span>
                      <span className="shrink-0 text-muted-foreground">
                        {entry.spec.status.replace("_", " ")}
                        {entry.liveLead ? " · lead active" : ""}
                      </span>
                    </div>
                  ))}
                </>
              )}
              {state.buildUrl === null ? null : (
                <a
                  href={state.buildUrl}
                  target="_blank"
                  rel="noreferrer"
                  className="self-end text-xs text-info-foreground hover:underline"
                >
                  Open Build in Weave →
                </a>
              )}
            </>
          )}
        </div>
      </PopoverPopup>
    </Popover>
  );
}
