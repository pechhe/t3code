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
import { useEffect, useRef, useState } from "react";
import { Pressable, type TextInputInstance, View } from "react-native";

import { AppText as Text } from "../../components/ui/AppText";
import { Button } from "../../components/ui/Button";
import { SearchField } from "../../components/ui/SearchField";
import { SegmentedControl } from "../../components/ui/SegmentedControl";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { SettingsSection } from "./components/SettingsSection";

const PAGE_SIZE = 20;
const SEARCH_DELAY_MS = 300;
const FILTERS = [
  { value: "all", label: "All" },
  { value: "due", label: "Due for review" },
] as const satisfies ReadonlyArray<{ value: ChampionLearningFilter; label: string }>;

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

export function ChampionLearningsSection(props: {
  readonly environmentId: EnvironmentId;
  readonly championId: string;
}) {
  const inputRef = useRef<TextInputInstance | null>(null);
  const [text, setText] = useState("");
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState<ChampionLearningFilter>("all");
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- debounce timer: one search per pause in typing
  useEffect(() => {
    const timer = setTimeout(() => setQuery(text.trim()), SEARCH_DELAY_MS);
    return () => clearTimeout(timer);
  }, [text]);
  return (
    <View className="gap-3">
      <SearchField
        inputRef={inputRef}
        autoFocus={false}
        accessibilityLabel="Search learnings"
        clearAccessibilityLabel="Clear learnings search"
        placeholder="Search what it has learned"
        value={text}
        onChangeText={setText}
      />
      <SegmentedControl options={FILTERS} selected={filter} onSelect={setFilter} size="compact" />
      <LearningsList
        key={`${filter}:${query}`}
        environmentId={props.environmentId}
        championId={props.championId}
        query={query}
        filter={filter}
      />
    </View>
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
    <SettingsSection title="Learnings">
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
    </SettingsSection>
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
  const { query, filter } = props;
  const page = useEnvironmentQuery(
    serverEnvironment.championLearningSearch({
      environmentId: props.environmentId,
      input: {
        championId: props.championId,
        filter,
        limit: PAGE_SIZE,
        ...(query === "" ? {} : { query }),
        ...(props.cursor === undefined ? {} : { cursor: props.cursor }),
      },
    }),
  );
  if (page.data === null)
    return (
      <Text className="p-4 text-base text-foreground-muted">
        {page.error ? "Learnings couldn't load. This doesn't mean there are none." : "Loading…"}
      </Text>
    );
  const { learnings, nextCursor } = page.data;
  return (
    <>
      {props.first && learnings.length === 0 ? (
        <Text className="p-4 text-base text-foreground-muted">
          {query !== "" || filter !== "all" ? "Nothing matches." : "Nothing learned yet."}
        </Text>
      ) : null}
      {learnings.map((entry, index) => (
        <LearningEntryRow
          key={entry.revision.id}
          environmentId={props.environmentId}
          entry={entry}
          bordered={!props.first || index > 0}
        />
      ))}
      {nextCursor !== null && props.onMore ? (
        <View className="border-t border-border-subtle p-3">
          <Button
            label="Show more"
            tone="secondary"
            size="compact"
            onPress={() => props.onMore?.(nextCursor)}
          />
        </View>
      ) : null}
    </>
  );
}

function LearningEntryRow(props: {
  readonly environmentId: EnvironmentId;
  readonly entry: ChampionLearningEntry;
  readonly bordered: boolean;
}) {
  const { entry } = props;
  const [open, setOpen] = useState(false);
  const meta = [
    entry.revision.topic,
    entry.due
      ? "Due for review"
      : entry.revision.reviewAt === null
        ? null
        : `review ${shortDate(entry.revision.reviewAt)}`,
    shortDate(entry.revision.recordedAt),
  ].filter((part) => part !== null);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityState={{ expanded: open }}
      onPress={() => setOpen((value) => !value)}
      className={
        props.bordered ? "gap-1 border-t border-border-subtle px-4 py-3" : "gap-1 px-4 py-3"
      }
    >
      <Text className="text-base font-t3-medium text-foreground">
        {championLearningHeadline(entry)}
      </Text>
      <Text className="text-sm text-foreground-muted">{meta.join(" · ")}</Text>
      {open ? <LearningEntryDetail environmentId={props.environmentId} entry={entry} /> : null}
    </Pressable>
  );
}

function LearningEntryDetail(props: {
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
  const line = (label: string, value: string) => (
    <Text key={`${label}:${value}`} className="text-sm text-foreground-muted">
      <Text className="text-sm font-t3-medium text-foreground">{label}: </Text>
      {value}
    </Text>
  );
  return (
    <View className="gap-1.5 pt-2">
      {line("Recorded by", championLearningRecordedBy(revision))}
      {line("Question", revision.question)}
      {line("Conclusion", revision.conclusion)}
      {revision.attempts.map((attempt) => line(`Tried (${attempt.outcome})`, attempt.evidence))}
      {revision.evidence.map((item) =>
        line("Source", `${item.source}: ${item.evidence} · observed ${shortDate(item.observedAt)}`),
      )}
      {props.entry.earlierRevisions > 0
        ? history.data === null
          ? line("Earlier", history.error ? "Couldn't load." : "Loading…")
          : earlier.map((item) =>
              line(
                `Earlier, ${shortDate(item.recordedAt)}`,
                `${item.plainSummary ?? item.conclusion} (${championLearningAuthor(item)})`,
              ),
            )
        : null}
      {props.entry.earlierRevisions > 0 ? line("Replaced because", revision.reason) : null}
      {review === null ? null : line("Status", review)}
    </View>
  );
}
