import {
  championLearningAuthor,
  championLearningHeadline,
  championLearningRecordedBy,
  championLearningReview,
} from "@t3tools/client-runtime/champions";
import type {
  ChampionLearningEntry,
  ChampionLearningFilter,
  EnvironmentId,
} from "@t3tools/contracts";
import { ChevronDownIcon, ChevronRightIcon, SearchIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { Alert, AlertAction, AlertDescription, AlertTitle } from "../ui/alert";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { InputGroup, InputGroupAddon, InputGroupInput } from "../ui/input-group";
import { Skeleton } from "../ui/skeleton";
import { Toggle, ToggleGroup } from "../ui/toggle-group";

const PAGE_SIZE = 20;
const SEARCH_DELAY_MS = 250;
const OUTCOME_BADGE = {
  improved: "success",
  failed: "error",
  inconclusive: "secondary",
} as const;

const shortDate = (at: string) =>
  new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "short" });

/** How many current learnings a Champion holds, for its tab label. */
export function useChampionLearningCount(environmentId: EnvironmentId, championId: string) {
  return useEnvironmentQuery(
    serverEnvironment.championLearningSearch({
      environmentId,
      input: { championId, limit: 1 },
    }),
  ).data?.total;
}

export function ChampionLearnings(props: {
  readonly environmentId: EnvironmentId;
  readonly championId: string;
}) {
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ChampionLearningFilter>("all");
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- debounce timer: one search per pause in typing
  useEffect(() => {
    const timer = setTimeout(() => setQuery(text.trim()), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [text]);

  return (
    <section className="flex flex-col gap-3" aria-label="Learnings">
      <div className="flex flex-wrap items-center gap-2">
        <InputGroup className="min-w-40 flex-1 basis-64">
          <InputGroupAddon>
            <SearchIcon aria-hidden />
          </InputGroupAddon>
          <InputGroupInput
            type="search"
            aria-label="Search learnings"
            placeholder="Search what it has learned"
            value={text}
            onChange={(event) => setText(event.target.value)}
          />
        </InputGroup>
        <ToggleGroup
          aria-label="Which learnings to show"
          value={[filter]}
          onValueChange={(values) => {
            const next = values[0] as ChampionLearningFilter | undefined;
            if (next !== undefined) setFilter(next);
          }}
        >
          <Toggle value="all">All</Toggle>
          <Toggle value="due">Due for review</Toggle>
        </ToggleGroup>
      </div>
      <LearningsList
        key={`${filter}:${query}`}
        environmentId={props.environmentId}
        championId={props.championId}
        query={query}
        filter={filter}
      />
    </section>
  );
}

function LearningsList(props: {
  readonly environmentId: EnvironmentId;
  readonly championId: string;
  readonly query: string;
  readonly filter: ChampionLearningFilter;
}) {
  const [cursors, setCursors] = useState<ReadonlyArray<string | undefined>>([undefined]);
  return (
    <div className="overflow-hidden rounded-lg border">
      {cursors.map((cursor, index) => (
        <LearningsPage
          key={cursor ?? "first"}
          {...props}
          cursor={cursor}
          first={index === 0}
          onMore={
            index === cursors.length - 1
              ? (next) => setCursors((current) => [...current, next])
              : undefined
          }
        />
      ))}
    </div>
  );
}

function LearningsPage(props: {
  readonly environmentId: EnvironmentId;
  readonly championId: string;
  readonly query: string;
  readonly filter: ChampionLearningFilter;
  readonly cursor: string | undefined;
  readonly first: boolean;
  readonly onMore: ((cursor: string) => void) | undefined;
}) {
  const page = useEnvironmentQuery(
    serverEnvironment.championLearningSearch({
      environmentId: props.environmentId,
      input: {
        championId: props.championId,
        filter: props.filter,
        limit: PAGE_SIZE,
        ...(props.query === "" ? {} : { query: props.query }),
        ...(props.cursor === undefined ? {} : { cursor: props.cursor }),
      },
    }),
  );
  if (page.data === null && page.error !== null)
    return (
      <div className="p-2">
        <Alert variant="error">
          <AlertTitle>Learnings couldn't load</AlertTitle>
          <AlertDescription>This doesn't mean there are none.</AlertDescription>
          <AlertAction>
            <Button size="xs" variant="outline" onClick={() => page.refresh()}>
              Try again
            </Button>
          </AlertAction>
        </Alert>
      </div>
    );
  if (page.data === null)
    return (
      <div className="flex flex-col gap-2 p-3">
        <Skeleton className="h-4 w-3/4" />
        <Skeleton className="h-3 w-1/3" />
      </div>
    );
  const { learnings, nextCursor } = page.data;
  return (
    <>
      {props.first && learnings.length === 0 ? (
        <p className="p-3 text-muted-foreground text-sm">
          {props.query !== "" || props.filter !== "all"
            ? "Nothing matches."
            : "Nothing learned yet. Learnings appear here as the Champion and other agents record them."}
        </p>
      ) : null}
      {learnings.map((entry, index) => (
        <LearningRow
          key={entry.revision.id}
          environmentId={props.environmentId}
          entry={entry}
          divided={!props.first || index > 0}
        />
      ))}
      {nextCursor !== null && props.onMore ? (
        <div className="border-t p-2">
          <Button size="xs" variant="ghost-muted" onClick={() => props.onMore?.(nextCursor)}>
            Show more
          </Button>
        </div>
      ) : null}
    </>
  );
}

function LearningRow(props: {
  readonly environmentId: EnvironmentId;
  readonly entry: ChampionLearningEntry;
  readonly divided: boolean;
}) {
  const { entry } = props;
  const [open, setOpen] = useState(false);
  const Chevron = open ? ChevronDownIcon : ChevronRightIcon;
  return (
    <div className={props.divided ? "border-t" : undefined}>
      <button
        type="button"
        aria-expanded={open}
        className="grid w-full cursor-pointer grid-cols-[auto_minmax(0,1fr)_auto] items-start gap-2 px-3 py-2.5 text-left hover:bg-accent"
        onClick={() => setOpen((value) => !value)}
      >
        <Chevron aria-hidden className="mt-0.5 size-3.5 text-muted-foreground" />
        <div className="flex min-w-0 flex-col gap-1">
          <span className="font-medium text-sm leading-snug">
            {championLearningHeadline(entry)}
          </span>
          <span className="flex flex-wrap items-center gap-1.5 text-muted-foreground text-xs">
            <span>{entry.revision.topic}</span>
            {entry.due ? (
              <Badge size="sm" variant="warning">
                Due for review
              </Badge>
            ) : entry.revision.reviewAt !== null ? (
              <span>review {shortDate(entry.revision.reviewAt)}</span>
            ) : null}
          </span>
        </div>
        <span className="whitespace-nowrap text-muted-foreground text-xs">
          {shortDate(entry.revision.recordedAt)}
        </span>
      </button>
      {open ? <LearningDetail environmentId={props.environmentId} entry={entry} /> : null}
    </div>
  );
}

function LearningDetail(props: {
  readonly environmentId: EnvironmentId;
  readonly entry: ChampionLearningEntry;
}) {
  const { revision } = props.entry;
  const history = useEnvironmentQuery(
    props.entry.earlierRevisions === 0
      ? null
      : serverEnvironment.championLearningRead({
          environmentId: props.environmentId,
          input: { id: revision.championId, learningId: revision.learningId },
        }),
  );
  const earlier = (history.data?.history ?? []).filter((item) => item.id !== revision.id);
  const review = championLearningReview(props.entry);
  return (
    <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-3 gap-y-1.5 px-3 pb-3 pl-8.5 text-xs leading-relaxed">
      <dt className="text-muted-foreground">Recorded by</dt>
      <dd>{championLearningRecordedBy(revision)}</dd>
      <dt className="text-muted-foreground">Question</dt>
      <dd>{revision.question}</dd>
      <dt className="text-muted-foreground">Conclusion</dt>
      <dd className="whitespace-pre-wrap">{revision.conclusion}</dd>
      {revision.attempts.length > 0 ? (
        <>
          <dt className="text-muted-foreground">Tried</dt>
          <dd className="flex flex-col gap-1">
            {revision.attempts.map((attempt) => (
              <span key={attempt.attemptId}>
                <Badge size="sm" variant={OUTCOME_BADGE[attempt.outcome]}>
                  {attempt.outcome}
                </Badge>{" "}
                {attempt.evidence}
              </span>
            ))}
          </dd>
        </>
      ) : null}
      <dt className="text-muted-foreground">Sources</dt>
      <dd>
        <ul className="list-disc pl-4">
          {revision.evidence.map((item) => (
            <li key={`${item.source}:${item.observedAt}:${item.evidence}`}>
              {item.source}: {item.evidence}{" "}
              <span className="text-muted-foreground">· observed {shortDate(item.observedAt)}</span>
            </li>
          ))}
        </ul>
      </dd>
      {revision.applicability.trim() !== "" ? (
        <>
          <dt className="text-muted-foreground">Applies to</dt>
          <dd>{revision.applicability}</dd>
        </>
      ) : null}
      {props.entry.earlierRevisions > 0 ? (
        <>
          <dt className="text-muted-foreground">Earlier</dt>
          <dd className="flex flex-col gap-1">
            {history.data === null ? (
              <span className="text-muted-foreground">
                {history.error === null ? "Loading…" : "Earlier versions couldn't load."}
              </span>
            ) : (
              earlier.map((item) => (
                <span key={item.id}>
                  {shortDate(item.recordedAt)}: “{item.plainSummary ?? item.conclusion}”
                  <span className="text-muted-foreground"> ({championLearningAuthor(item)})</span>
                </span>
              ))
            )}
            <span className="text-muted-foreground">Replaced because: {revision.reason}</span>
          </dd>
        </>
      ) : null}
      {review === null ? null : (
        <>
          <dt className="text-muted-foreground">Status</dt>
          <dd>{review}</dd>
        </>
      )}
    </dl>
  );
}
