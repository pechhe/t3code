import type {
  BuildHome,
  BuildHomeAcceptanceNeed,
  BuildHomeHoldNeed,
  BuildHomeNeed,
  BuildHomeOtherNeed,
  BuildHomeRow,
  BuildHomeState,
  EnvironmentId,
  ThreadId,
} from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { CheckIcon, ChevronRightIcon, ExternalLinkIcon, MinusIcon, XIcon } from "lucide-react";
import { type KeyboardEvent, type Ref, useImperativeHandle, useRef, useState } from "react";

import { Button } from "~/components/ui/button";
import { Kbd } from "~/components/ui/kbd";
import { Popover, PopoverPopup, PopoverTrigger } from "~/components/ui/popover";
import { Textarea } from "~/components/ui/textarea";
import { cn } from "~/lib/utils";
import { buildWorkItems, useBuildHome } from "~/state/buildWorkItems";
import { useAtomCommand } from "~/state/use-atom-command";
import { BuildItemLabel } from "./BuildItemLabel";
import {
  buildButtonCount,
  buildInboxEntries,
  buildInboxGroupOf,
  buildInboxGroups,
  buildInboxKey,
  buildInboxReason,
  buildInboxSelection,
  latestBuildHomeState,
} from "./BuildHomeButton.logic";

/**
 * T3's Build button (YS-260): the Inbox Weave's Build shows, in a popover. A narrow list of what
 * needs the person (To accept, then Waiting on you) beside the selected item: a Spec's acceptance,
 * or an agent's question, decided in one composer. ↑ ↓ move, ⌘↵ submits, O opens it in Weave.
 */

const failureMessage = (result: Parameters<typeof squashAtomCommandFailure>[0]) => {
  const error = squashAtomCommandFailure(result);
  return error instanceof Error ? error.message : "Something went wrong.";
};

type Submittable = { submit: () => void };

/**
 * Build's one note box, as in Weave: a growing textarea, its hint, and one action whose label follows
 * whether anything is written. ⌘↵ submits. `onSubmit` returns why it did not go through, or null.
 */
function Composer({
  ref,
  ...props
}: {
  ref?: Ref<Submittable>;
  label: string;
  placeholder: string;
  hint: string;
  /** The action with nothing written, or null when a note is required. */
  emptyAction: string | null;
  textAction: string;
  onSubmit: (note: string) => Promise<string | null>;
}) {
  const [note, setNote] = useState("");
  const [pending, setPending] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const written = note.trim() !== "";
  const action = written ? props.textAction : props.emptyAction;
  const submit = async () => {
    if (pending || action === null) return;
    setPending(true);
    setProblem(null);
    const refused = await props.onSubmit(note.trim());
    setPending(false);
    if (refused === null) setNote("");
    else setProblem(refused);
  };
  useImperativeHandle(ref, () => ({ submit: () => void submit() }));

  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-col rounded-lg border bg-background shadow-xs/5 has-focus-visible:border-ring">
        <Textarea
          unstyled
          size="sm"
          aria-label={props.label}
          placeholder={props.placeholder}
          value={note}
          disabled={pending}
          onChange={(event) => setNote(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              event.stopPropagation();
              void submit();
            }
          }}
        />
        <div className="flex items-center gap-2 px-2.5 pb-2">
          <span className="min-w-0 flex-1 truncate text-2xs text-muted-foreground">
            {props.hint}
          </span>
          <Button
            size="xs"
            variant={written ? "outline" : "default"}
            disabled={pending || action === null}
            onClick={() => void submit()}
          >
            {action ?? props.textAction}
            <Kbd>⌘↵</Kbd>
          </Button>
        </div>
      </div>
      {problem === null ? null : (
        <p className="m-0 text-xs text-warning-foreground" role="status">
          {problem}
        </p>
      )}
    </div>
  );
}

function Mark({ met }: { met: boolean | null }) {
  return (
    <span
      aria-hidden
      className={cn(
        "flex size-4 shrink-0 items-center justify-center rounded-full",
        met === null
          ? "bg-muted text-muted-foreground"
          : met
            ? "bg-success/16 text-success-foreground"
            : "bg-destructive/16 text-destructive-foreground",
      )}
    >
      {met === null ? (
        <MinusIcon className="size-3" />
      ) : met ? (
        <CheckIcon className="size-3" />
      ) : (
        <XIcon className="size-3" />
      )}
    </span>
  );
}

const verdictLabels: Record<BuildHomeRow["verdict"], string> = {
  met: "met",
  not_met: "not met",
  missing: "not judged",
  stale: "judged on an older body",
};

/** A Landed Spec's acceptance, as Weave's acceptance section shows it, with the composer. */
function AcceptanceView({
  ref,
  ...props
}: {
  ref: Ref<Submittable>;
  need: BuildHomeAcceptanceNeed;
  environmentId: EnvironmentId;
  onState: (state: BuildHomeState) => void;
}) {
  const { need, environmentId } = props;
  const decide = useAtomCommand(buildWorkItems.homeDecide, { reportFailure: false });
  const met = need.rows.filter((row) => row.verdict === "met").length;

  const submit = async (note: string): Promise<string | null> => {
    if (need.card === null) return "There is no judged review to decide on yet.";
    const result = await decide({
      environmentId,
      input: {
        specId: need.spec.id,
        decision: note ? "send_back" : "accept",
        card: need.card,
        ...(note ? { note } : {}),
      },
    });
    if (result._tag !== "Success") return failureMessage(result);
    props.onState(result.value.state);
    return result.value.outcome === "decided" ? null : result.value.message;
  };

  return (
    <div className="flex flex-col gap-5">
      <p className="m-0 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
        {need.checks.map((check) => (
          <span key={check.label} className="flex items-center gap-1.5">
            <Mark met={check.met} />
            {check.label}
          </span>
        ))}
      </p>
      {need.reviewSummary ? (
        <p className="m-0 text-sm leading-relaxed whitespace-pre-line">{need.reviewSummary}</p>
      ) : null}
      <section className="flex flex-col gap-1.5">
        <h3 className="m-0 flex items-baseline gap-2 text-xs font-semibold">
          Acceptance rows
          <span className="font-normal text-muted-foreground tabular-nums">
            {met} of {need.rows.length} met
          </span>
        </h3>
        {need.rows.length === 0 ? (
          <p className="m-0 text-xs text-muted-foreground">This Spec has no acceptance rows.</p>
        ) : (
          <ul className="m-0 flex list-none flex-col divide-y overflow-hidden rounded-lg border p-0">
            {need.rows.map((row) => (
              <li key={row.rowId}>
                <details className="group">
                  <summary className="flex cursor-pointer list-none items-start gap-2.5 px-3 py-2 text-xs hover:bg-accent/40 [&::-webkit-details-marker]:hidden">
                    <span className="mt-px">
                      <Mark
                        met={
                          row.verdict === "met" ? true : row.verdict === "not_met" ? false : null
                        }
                      />
                    </span>
                    <span className="flex-1 leading-relaxed">
                      {row.text}
                      {row.verdict === "met" ? null : (
                        <span className="text-muted-foreground">
                          {" "}
                          · {verdictLabels[row.verdict]}
                        </span>
                      )}
                    </span>
                    {row.evidence ? (
                      <ChevronRightIcon className="mt-0.5 size-3.5 shrink-0 text-muted-foreground transition-transform group-open:rotate-90" />
                    ) : null}
                  </summary>
                  {row.evidence ? (
                    <p className="m-0 ms-9 me-3 mb-2.5 border-s-2 ps-2.5 text-xs leading-relaxed whitespace-pre-line text-muted-foreground">
                      {row.evidence}
                    </p>
                  ) : null}
                </details>
              </li>
            ))}
          </ul>
        )}
      </section>
      {need.tryIt ? (
        <section className="flex flex-col gap-1.5">
          <h3 className="m-0 text-xs font-semibold">Try it</h3>
          <p className="m-0 rounded-lg bg-muted px-3 py-2 font-mono text-2xs leading-relaxed whitespace-pre-line">
            {need.tryIt}
          </p>
        </section>
      ) : null}
      {need.resolvedFindings.length === 0 ? null : (
        <details className="group rounded-lg border px-3 py-2 text-xs">
          <summary className="flex cursor-pointer list-none items-center gap-2 text-muted-foreground [&::-webkit-details-marker]:hidden">
            <Mark met />
            {need.resolvedFindings.length === 1
              ? "1 review finding was fixed before landing"
              : `${need.resolvedFindings.length} review findings were fixed before landing`}
            <ChevronRightIcon className="ms-auto size-3.5 transition-transform group-open:rotate-90" />
          </summary>
          <ul className="m-0 mt-1.5 ms-6 flex list-disc flex-col gap-1 text-muted-foreground">
            {need.resolvedFindings.map((finding, index) => (
              // oxlint-disable-next-line no-array-index-key -- findings carry no id over T3's contract
              <li key={index}>{finding.title}</li>
            ))}
          </ul>
        </details>
      )}
      {need.card === null ? (
        <p className="m-0 text-xs text-muted-foreground">
          There is no judged review to decide on yet. Open it in Weave to accept with readiness
          open.
        </p>
      ) : (
        <Composer
          ref={ref}
          label={`Note for ${need.spec.title}`}
          placeholder="Accept, or write what to change and send it back to the lead…"
          hint="A note goes to the lead's thread"
          emptyAction="Accept"
          textAction="Send back to lead"
          onSubmit={submit}
        />
      )}
    </div>
  );
}

/** An agent's question: answering clears the hold and sends the answer to the Spec's agent thread. */
function QuestionView({
  ref,
  ...props
}: {
  ref: Ref<Submittable>;
  need: BuildHomeHoldNeed;
  canAnswer: boolean;
  environmentId: EnvironmentId;
  onState: (state: BuildHomeState) => void;
}) {
  const { need, environmentId } = props;
  const answer = useAtomCommand(buildWorkItems.homeAnswer, { reportFailure: false });
  const holdId = need.holdId;

  const submit = async (text: string): Promise<string | null> => {
    if (holdId === null) return "This question can only be answered in Weave.";
    const result = await answer({
      environmentId,
      input: { itemId: need.spec.id, holdId, answer: text },
    });
    if (result._tag !== "Success") return failureMessage(result);
    props.onState(result.value.state);
    return result.value.outcome === "decided" ? null : result.value.message;
  };

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-1.5 rounded-lg border border-warning/32 bg-warning/8 px-3 py-2.5">
        <span className="text-2xs font-medium text-muted-foreground">
          {need.holdKind === "decision" ? "Needs your decision" : "Needs information"}
          {need.since ? ` · since ${new Date(need.since).toLocaleDateString()}` : ""}
        </span>
        <p className="m-0 text-sm leading-relaxed whitespace-pre-line">{need.question}</p>
      </div>
      {props.canAnswer && holdId !== null ? (
        <Composer
          ref={ref}
          label={`Answer for ${need.spec.title}`}
          placeholder="Answer in your own words…"
          hint="Your answer goes to the Spec's agent thread"
          emptyAction={null}
          textAction="Answer"
          onSubmit={submit}
        />
      ) : (
        <p className="m-0 text-xs text-muted-foreground">
          Answering from T3 needs a newer Weave. Open the Spec in Weave to answer.
        </p>
      )}
    </div>
  );
}

/** A Proposed Decision or an Arc's prompt: its actions stay on its page in Weave. */
function OtherView({ need }: { need: BuildHomeOtherNeed }) {
  const actions =
    need.kind === "arc_review"
      ? [
          { label: "Continue", act: "continue" },
          { label: "Close", act: "close" },
        ]
      : need.kind === "arc_check_in"
        ? [{ label: "Check in", act: "check-in" }]
        : [{ label: "Accept or supersede", act: null }];
  return (
    <div className="flex flex-wrap gap-2">
      {actions.map(({ label, act }, index) => (
        <Button
          key={label}
          size="xs"
          variant={index === 0 ? "default" : "outline"}
          render={
            <a href={act ? `${need.url}?act=${act}` : need.url} target="_blank" rel="noreferrer" />
          }
        >
          {label}
          <ExternalLinkIcon className="size-3" />
        </Button>
      ))}
    </div>
  );
}

function InboxPane({
  ref,
  ...props
}: {
  ref: Ref<Submittable>;
  need: BuildHomeNeed;
  home: BuildHome;
  environmentId: EnvironmentId;
  onState: (state: BuildHomeState) => void;
}) {
  const { need } = props;
  return (
    <article className="flex flex-col gap-4 px-5 pt-4 pb-6" aria-label={need.spec.title}>
      <header className="flex flex-col gap-1.5">
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <BuildItemLabel item={need.spec} className="tabular-nums" />
          {need.kind === "acceptance" && need.repositories.length > 0 ? (
            <span className="truncate">{need.repositories.join(", ")}</span>
          ) : null}
          <Button
            size="xs"
            variant="ghost"
            className="ms-auto"
            render={<a href={need.url} target="_blank" rel="noreferrer" />}
          >
            Open in Weave
            <ExternalLinkIcon className="size-3" />
            <Kbd>O</Kbd>
          </Button>
        </div>
        <h2 className="m-0 text-base leading-snug font-semibold text-balance">{need.spec.title}</h2>
        <p className="m-0 text-xs text-muted-foreground">{buildInboxReason(need).detail}</p>
      </header>
      {need.kind === "acceptance" ? (
        <AcceptanceView
          ref={ref}
          need={need}
          environmentId={props.environmentId}
          onState={props.onState}
        />
      ) : need.kind === "hold" ? (
        <QuestionView
          ref={ref}
          need={need}
          canAnswer={props.home.capabilities.answer}
          environmentId={props.environmentId}
          onState={props.onState}
        />
      ) : (
        <OtherView need={need} />
      )}
    </article>
  );
}

function Inbox(props: {
  home: BuildHome;
  buildUrl: string | null;
  unavailable: boolean;
  environmentId: EnvironmentId;
  onState: (state: BuildHomeState) => void;
}) {
  const { home } = props;
  const entries = buildInboxEntries(home);
  const [chosen, setChosen] = useState<{ key: string; index: number } | null>(null);
  const selected = buildInboxSelection(entries, chosen);
  const pane = useRef<Submittable>(null);
  const list = useRef<HTMLDivElement>(null);
  const selectedKey = selected === null ? null : buildInboxKey(selected);

  const choose = (need: BuildHomeNeed) => {
    const key = buildInboxKey(need);
    setChosen({ key, index: entries.indexOf(need) });
    // Keeps a row moved to by ↑ ↓ in view once it has drawn as current.
    requestAnimationFrame(() =>
      list.current
        ?.querySelector(`[data-inbox-item="${CSS.escape(key)}"]`)
        ?.scrollIntoView({ block: "nearest" }),
    );
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (selected === null || event.defaultPrevented) return;
    const target = event.target as HTMLElement;
    if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
      event.preventDefault();
      pane.current?.submit();
      return;
    }
    if (event.metaKey || event.ctrlKey || event.altKey) return;
    if (target.closest("input, textarea, [contenteditable='true']")) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const at = entries.indexOf(selected) + (event.key === "ArrowDown" ? 1 : -1);
      const next = entries[Math.min(Math.max(at, 0), entries.length - 1)];
      if (next !== undefined) choose(next);
    } else if (event.key === "o" || event.key === "O") {
      event.preventDefault();
      window.open(selected.url, "_blank", "noreferrer");
    }
  };

  const notices = [
    props.unavailable ? "Weave could not be reached; this is Build as last read." : null,
    home.capabilities.notes ? null : "Notes sent from Weave reach T3 once Weave is updated.",
  ].filter((notice) => notice !== null);

  return (
    <div
      className="flex h-[min(36rem,75vh)] w-[min(52rem,calc(100vw-2rem))] text-sm"
      onKeyDown={onKeyDown}
      // The popover's own focus lands here, so the keys work as soon as it opens.
      tabIndex={-1}
    >
      <nav aria-label="Inbox" className="flex w-64 shrink-0 flex-col border-e bg-muted/32">
        <header className="flex items-baseline justify-between px-3 pt-3 pb-1.5">
          <h2 className="m-0 text-sm font-semibold">Inbox</h2>
          <span className="text-xs text-muted-foreground tabular-nums">{entries.length}</span>
        </header>
        <div ref={list} className="flex min-h-0 flex-1 flex-col overflow-y-auto px-1.5 pb-2">
          {entries.length === 0 ? (
            <p className="m-0 px-1.5 py-2 text-xs text-muted-foreground">Nothing needs you.</p>
          ) : (
            buildInboxGroups.map((group) => {
              const shown = entries.filter((need) => buildInboxGroupOf(need) === group.key);
              if (shown.length === 0) return null;
              return (
                <section key={group.key} className="flex flex-col">
                  <h3 className="m-0 flex justify-between px-1.5 pt-2.5 pb-1 text-2xs font-medium text-muted-foreground">
                    {group.label}
                    <span className="tabular-nums">{shown.length}</span>
                  </h3>
                  {shown.map((need) => {
                    const key = buildInboxKey(need);
                    const current = key === selectedKey;
                    return (
                      <button
                        key={key}
                        type="button"
                        data-inbox-item={key}
                        aria-current={current ? "true" : undefined}
                        onClick={() => choose(need)}
                        className={cn(
                          "flex w-full items-baseline gap-2 rounded-md px-1.5 py-1.5 text-start text-xs hover:bg-accent/60",
                          current && "bg-accent text-accent-foreground",
                        )}
                      >
                        <BuildItemLabel
                          item={need.spec}
                          className="shrink-0 text-muted-foreground tabular-nums"
                        />
                        <span className="min-w-0 flex-1 truncate">{need.spec.title}</span>
                        {group.key === "waiting" ? (
                          <span className="shrink-0 text-2xs text-muted-foreground">
                            {buildInboxReason(need).label}
                          </span>
                        ) : null}
                      </button>
                    );
                  })}
                </section>
              );
            })
          )}
        </div>
        <footer className="flex flex-col gap-1.5 border-t px-3 py-2 text-2xs text-muted-foreground">
          {notices.map((notice) => (
            <p key={notice} className="m-0">
              {notice}
            </p>
          ))}
          <span className="flex items-center gap-2.5">
            <span>
              <Kbd>↑</Kbd>
              <Kbd>↓</Kbd> move
            </span>
            <span>
              <Kbd>⌘↵</Kbd> submit
            </span>
            {props.buildUrl === null ? null : (
              <a
                href={props.buildUrl}
                target="_blank"
                rel="noreferrer"
                className="ms-auto hover:text-foreground hover:underline"
              >
                Build ↗
              </a>
            )}
          </span>
        </footer>
      </nav>
      <div className="min-w-0 flex-1 overflow-y-auto">
        {selected === null ? (
          <div className="flex h-full flex-col items-center justify-center gap-1 p-6 text-center">
            <p className="m-0 text-sm font-medium">Nothing needs you</p>
            <p className="m-0 text-xs text-muted-foreground">
              Specs to accept and agents' questions arrive here.
            </p>
          </div>
        ) : (
          <InboxPane
            // A fresh pane per entry, so a half-written note never carries to the next one.
            key={selectedKey}
            ref={pane}
            need={selected}
            home={home}
            environmentId={props.environmentId}
            onState={props.onState}
          />
        )}
      </div>
    </div>
  );
}

export function BuildHomeButton(props: {
  environmentId: EnvironmentId;
  threadId: ThreadId;
  onOpenThread: (threadId: ThreadId) => void;
}) {
  const { environmentId } = props;
  const query = useBuildHome(environmentId);
  const [decided, setDecided] = useState<BuildHomeState | null>(null);
  const [open, setOpen] = useState(false);
  // A decision's own answer shows at once, until a newer read replaces it.
  const state = latestBuildHomeState(decided, query.data);
  const count = buildButtonCount(state);
  const home = state?.home ?? null;

  return (
    <Popover
      open={open}
      onOpenChange={(next) => {
        setOpen(next);
        if (next) {
          setDecided(null);
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
          <span className="rounded-full bg-warning px-1.5 text-2xs font-semibold leading-4 text-black">
            {count}
          </span>
        )}
      </PopoverTrigger>
      <PopoverPopup side="bottom" align="end" padding="none">
        {state !== null &&
        (state.status === "ready" || state.status === "unavailable") &&
        home !== null ? (
          <Inbox
            home={home}
            buildUrl={state.buildUrl}
            unavailable={state.status === "unavailable"}
            environmentId={environmentId}
            onState={setDecided}
          />
        ) : (
          <p className="m-0 w-80 p-3 text-xs text-muted-foreground">
            {state === null
              ? query.error === null
                ? "Reading Build from Weave…"
                : "Couldn't read Build from T3."
              : state.status === "not_connected"
                ? "T3 is not connected to Weave. Connect it in Settings → Integrations → Weave → Connect to Weave."
                : state.status === "invalid_token"
                  ? "Weave refused T3's delegation: it expired or was revoked. Reconnect it in Settings → Integrations → Weave → Connect to Weave."
                  : "Weave could not be reached, and Build has not been read yet."}
          </p>
        )}
      </PopoverPopup>
    </Popover>
  );
}
