import {
  CHAMPION_STATUS_LABELS,
  championReading,
  championReadingLabel,
  championStatus,
} from "@t3tools/client-runtime/champions";
import type { EnvironmentId } from "@t3tools/contracts";
import { useNavigate } from "@tanstack/react-router";
import { ChevronRightIcon, PlusIcon, ShieldCheckIcon } from "lucide-react";
import { useEffect, useState } from "react";

import { isElectron } from "../../env";
import { useEscapeToGoBack } from "../../hooks/useNavigateBack";
import { useMediaQuery } from "../../hooks/useMediaQuery";
import { useNowMinute } from "../../hooks/useNowMinute";
import { cn } from "../../lib/utils";
import { type EnvironmentChampions, useAllChampions } from "../../state/champions";
import { useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { ScheduledRelativeLabel } from "../scheduled/scheduledTaskParts";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { Button } from "../ui/button";
import {
  Empty,
  EmptyContent,
  EmptyDescription,
  EmptyHeader,
  EmptyMedia,
  EmptyTitle,
} from "../ui/empty";
import { Skeleton } from "../ui/skeleton";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../WorkspacePageHeader";
import { ChampionDetailPage } from "./ChampionDetailPage";
import { ChampionForm } from "./ChampionForm";
import { ChampionMetricsEditor } from "./ChampionMetricsEditor";
import {
  type ChampionEntry,
  type ChampionsView,
  championMachineGap,
  orderChampions,
  resolveChampionSelection,
} from "./champions.logic";
import { HEALTH_DOTS } from "./championsPresentation";

const SILENT_SERVER_AFTER_MS = 10_000;

/** A machine that never answers can't be told from a slow one, so loading has to end. */
function useHasWaitedForServers() {
  const [waited, setWaited] = useState(false);
  useEffect(() => {
    const timer = setTimeout(() => setWaited(true), SILENT_SERVER_AFTER_MS);
    return () => clearTimeout(timer);
  }, []);
  return waited;
}

function ChampionListRow(props: {
  readonly entry: ChampionEntry;
  readonly machineLabel: string | null;
  readonly active: boolean;
  readonly onSelect: () => void;
}) {
  const { champion } = props.entry;
  const nowMs = Date.parse(`${useNowMinute()}:00.000Z`);
  const health = championStatus(champion, nowMs);
  const key = champion.latestSamples?.[0];
  const reading = key
    ? championReading(
        { id: key.metricId, seriesId: key.seriesId, unit: key.unit },
        champion.latestSamples,
        nowMs,
      )
    : null;
  return (
    <button
      type="button"
      data-active={props.active || undefined}
      aria-current={props.active ? "page" : undefined}
      onClick={props.onSelect}
      className="flex w-full gap-2 rounded-md p-2 text-start hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring data-active:bg-accent"
    >
      <span
        aria-hidden
        className={cn("mt-1.5 size-2 shrink-0 rounded-full", HEALTH_DOTS[health])}
      />
      <span className="flex min-w-0 flex-1 flex-col gap-0.5">
        <span className="flex items-baseline gap-2">
          <span className="min-w-0 flex-1 truncate font-medium text-sm">{champion.name}</span>
          {reading && key ? (
            <span
              className={cn(
                "shrink-0 text-xs",
                reading.kind === "measured" ? "font-medium" : "text-muted-foreground",
                reading.kind === "measured" &&
                  reading.health === "breached" &&
                  "text-warning-foreground",
              )}
            >
              {championReadingLabel(reading, key.unit)}
            </span>
          ) : null}
        </span>
        <span className="truncate text-muted-foreground text-xs">{champion.purpose}</span>
        <span className="truncate text-xs">
          {CHAMPION_STATUS_LABELS[health]}
          {champion.lastCheckAt !== null ? (
            <>
              {" · checked "}
              <ScheduledRelativeLabel value={champion.lastCheckAt} />
            </>
          ) : null}
          {props.machineLabel ? ` · ${props.machineLabel}` : ""}
        </span>
      </span>
    </button>
  );
}

function MachineNotices(props: {
  readonly sources: ReadonlyArray<EnvironmentChampions>;
  readonly waited: boolean;
  readonly machineLabel: (environmentId: EnvironmentId) => string;
  readonly gapNotice: string | null;
}) {
  const silent = props.waited
    ? props.sources.filter((source) => source.champions === null && source.error === null)
    : [];
  const failed = props.sources.filter((source) => source.error !== null);
  if (failed.length === 0 && silent.length === 0 && props.gapNotice === null) return null;
  return (
    <div className="flex flex-col gap-1 px-2 pb-2 text-xs">
      {props.gapNotice ? (
        <p role="status" className="text-muted-foreground">
          {props.gapNotice}
        </p>
      ) : null}
      {failed.map((source) => (
        <p key={source.environmentId} className="text-muted-foreground">
          {source.unsupported
            ? `Update ${props.machineLabel(source.environmentId)} to use Champions there.`
            : `${props.machineLabel(source.environmentId)}: ${source.error}`}
        </p>
      ))}
      {silent.map((source) => (
        <p key={source.environmentId} className="text-muted-foreground">
          {props.machineLabel(source.environmentId)} isn't answering. It may need updating to use
          Champions.
        </p>
      ))}
    </div>
  );
}

/** The list lags a just-created champion, so only the machine can say it isn't there. */
function UnlistedChampion(props: {
  readonly environmentId: EnvironmentId;
  readonly id: string;
  readonly machineLabel: string;
  readonly onBack: () => void;
}) {
  const query = useEnvironmentQuery(
    serverEnvironment.championDetail({
      environmentId: props.environmentId,
      input: { id: props.id },
    }),
  );
  if (query.data !== null) {
    return (
      <ChampionDetailPage
        key={`${props.environmentId}:${props.id}`}
        environmentId={props.environmentId}
        summary={query.data.champion}
      />
    );
  }
  if (query.error === null) return <ContentSkeleton />;
  return (
    <Empty>
      <EmptyHeader>
        <EmptyTitle>This champion isn't here</EmptyTitle>
        <EmptyDescription>{props.machineLabel} doesn't report this champion.</EmptyDescription>
      </EmptyHeader>
      <EmptyContent>
        <Button size="sm" variant="outline" onClick={props.onBack}>
          All champions
        </Button>
      </EmptyContent>
    </Empty>
  );
}

function ContentSkeleton() {
  return (
    <div className="mx-auto flex w-full max-w-180 flex-col gap-2 p-4 sm:p-6" aria-busy="true">
      <Skeleton className="h-6 w-1/2" />
      <Skeleton className="h-24 w-full" />
    </div>
  );
}

function ChampionMetricsView(props: {
  readonly environmentId: EnvironmentId;
  readonly id: string;
  readonly onDone: () => void;
}) {
  const query = useEnvironmentQuery(
    serverEnvironment.championDetail({
      environmentId: props.environmentId,
      input: { id: props.id },
    }),
  );
  if (query.data === null) {
    return query.error ? (
      <div className="mx-auto max-w-180 p-4 sm:p-6">
        <Alert variant="error">
          <AlertTitle>Metrics couldn't load</AlertTitle>
          <AlertDescription>{query.error}</AlertDescription>
        </Alert>
      </div>
    ) : (
      <ContentSkeleton />
    );
  }
  return (
    <ChampionMetricsEditor
      key={`${props.environmentId}:${props.id}`}
      environmentId={props.environmentId}
      detail={query.data}
      onDone={props.onDone}
    />
  );
}

export function ChampionsPage(props: {
  readonly environmentId?: EnvironmentId | undefined;
  readonly id?: string | undefined;
  readonly view?: ChampionsView | undefined;
}) {
  const navigate = useNavigate();
  const sources = useAllChampions();
  const { environments, isReady } = useEnvironments();
  const wide = useMediaQuery("(min-width: 48rem)");
  const waited = useHasWaitedForServers();
  const explicit = props.environmentId !== undefined && props.id !== undefined;
  // Escape must not discard a form in progress.
  useEscapeToGoBack(explicit || props.view !== undefined ? noop : undefined);

  const nowMs = Date.parse(`${useNowMinute()}:00.000Z`);
  const entries = orderChampions(
    sources.flatMap((source) =>
      (source.champions ?? []).map((champion) => ({
        environmentId: source.environmentId,
        champion,
      })),
    ),
    nowMs,
  );
  const selection = resolveChampionSelection(
    entries,
    { environmentId: props.environmentId, id: props.id },
    { openFirst: wide && props.view === undefined },
  );
  const selected = selection.kind === "found" ? selection.entry : null;
  const machineLabel = (environmentId: EnvironmentId) =>
    environments.find((environment) => environment.environmentId === environmentId)?.label ??
    "This machine";
  const multipleMachines = sources.length > 1;
  const connectedSources = sources.filter((source) => source.connection === "connected");
  const loading =
    !waited &&
    connectedSources.some((source) => source.champions === null && source.error === null);
  const allUnavailable =
    connectedSources.length > 0 &&
    connectedSources.every(
      (source) => source.error !== null || (waited && source.champions === null),
    );
  const showContent = explicit || props.view === "new";
  // Live lists only cover connected machines, so a dropped connection isn't an empty list.
  const gap = championMachineGap(environments, {
    showingLastKnown: sources.some(
      (source) => source.connection !== "connected" && (source.champions?.length ?? 0) > 0,
    ),
  });

  const open = (entry: ChampionEntry) =>
    void navigate({
      to: "/champions",
      search: { environmentId: entry.environmentId, id: entry.champion.id },
    });
  const toList = () => void navigate({ to: "/champions", search: {} });

  const missingMachineConnected =
    selection.kind === "missing" &&
    environments.some(
      (environment) =>
        environment.environmentId === selection.environmentId &&
        environment.connection.phase === "connected",
    );

  let content: React.ReactNode;
  if (props.view === "new") {
    content = (
      <ChampionForm
        key="new"
        existing={null}
        onDone={(target) => {
          if (target === null) {
            toList();
            return;
          }
          void navigate({
            to: "/champions",
            search: {
              environmentId: target.environmentId,
              id: target.id,
              ...(target.view ? { view: target.view } : {}),
            },
            replace: true,
          });
        }}
      />
    );
  } else if (selected !== null && props.view === "edit") {
    content = (
      <ChampionForm
        key={`${selected.environmentId}:${selected.champion.id}`}
        existing={selected}
        onDone={() =>
          void navigate({
            to: "/champions",
            search: { environmentId: selected.environmentId, id: selected.champion.id },
          })
        }
      />
    );
  } else if (props.view === "metrics" && props.environmentId !== undefined && props.id) {
    const target = { environmentId: props.environmentId, id: props.id };
    content = (
      <ChampionMetricsView
        environmentId={target.environmentId}
        id={target.id}
        onDone={() => void navigate({ to: "/champions", search: target })}
      />
    );
  } else if (selected !== null) {
    content = (
      <ChampionDetailPage
        key={`${selected.environmentId}:${selected.champion.id}`}
        environmentId={selected.environmentId}
        summary={selected.champion}
      />
    );
  } else if (selection.kind === "missing" && missingMachineConnected) {
    content = (
      <UnlistedChampion
        environmentId={selection.environmentId}
        id={selection.id}
        machineLabel={machineLabel(selection.environmentId)}
        onBack={toList}
      />
    );
  } else if (selection.kind === "missing") {
    const selectedMachineGap = championMachineGap(
      environments.filter((environment) => environment.environmentId === selection.environmentId),
    );
    content = isReady ? (
      <Empty>
        <EmptyHeader>
          <EmptyTitle>
            {selectedMachineGap?.waiting ? selectedMachineGap.title : "Its machine isn't connected"}
          </EmptyTitle>
          <EmptyDescription>
            {selectedMachineGap?.waiting
              ? "This champion will come back when the machine connects."
              : "Connect the machine it belongs to, then open this link again."}
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button size="sm" variant="outline" onClick={toList}>
            All champions
          </Button>
        </EmptyContent>
      </Empty>
    ) : (
      <ContentSkeleton />
    );
  } else if (loading || !isReady) {
    content = null;
  } else if (allUnavailable) {
    content = (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ShieldCheckIcon />
          </EmptyMedia>
          <EmptyTitle>Champions couldn't load</EmptyTitle>
          <EmptyDescription>
            {connectedSources.every((source) => source.unsupported)
              ? "Update your T3 Code servers to use Champions."
              : "The list says what each machine reported."}
          </EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  } else if (entries.length === 0 && gap !== null) {
    content = (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ShieldCheckIcon />
          </EmptyMedia>
          <EmptyTitle>{gap.title}</EmptyTitle>
          <EmptyDescription>{gap.notice}</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  } else if (sources.length === 0) {
    content = (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ShieldCheckIcon />
          </EmptyMedia>
          <EmptyTitle>No machines connected</EmptyTitle>
          <EmptyDescription>Connect a machine to set up a champion on it.</EmptyDescription>
        </EmptyHeader>
      </Empty>
    );
  } else if (entries.length === 0) {
    content = (
      <Empty>
        <EmptyHeader>
          <EmptyMedia variant="icon">
            <ShieldCheckIcon />
          </EmptyMedia>
          <EmptyTitle>No champions yet</EmptyTitle>
          <EmptyDescription>
            A champion keeps one thing true about a project: it measures it, notices when it slips
            and owns the improvement.
          </EmptyDescription>
        </EmptyHeader>
        <EmptyContent>
          <Button
            size="sm"
            onClick={() => void navigate({ to: "/champions", search: { view: "new" } })}
          >
            <PlusIcon />
            New champion
          </Button>
        </EmptyContent>
      </Empty>
    );
  } else {
    content = null;
  }

  const crumb =
    props.view === "new"
      ? "New champion"
      : selected && (explicit || wide)
        ? selected.champion.name
        : null;

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
      <WorkspacePageHeader electron={isElectron}>
        <WorkspaceBreadcrumb ariaLabel="Champions breadcrumb" className="min-w-0 py-2">
          {crumb ? (
            <>
              <WorkspaceBreadcrumbItem>
                <button
                  type="button"
                  onClick={toList}
                  className="text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
                >
                  Champions
                </button>
              </WorkspaceBreadcrumbItem>
              <ChevronRightIcon aria-hidden className="size-3.5 shrink-0 text-muted-foreground" />
              <WorkspaceBreadcrumbItem>
                <h1 className="truncate">{crumb}</h1>
              </WorkspaceBreadcrumbItem>
            </>
          ) : (
            <WorkspaceBreadcrumbItem>
              <h1>Champions</h1>
            </WorkspaceBreadcrumbItem>
          )}
        </WorkspaceBreadcrumb>
      </WorkspacePageHeader>
      <div className="flex min-h-0 flex-1">
        <aside
          aria-label="Champions"
          className={cn(
            "w-full shrink-0 flex-col md:flex md:w-76 md:border-e",
            showContent ? "hidden" : "flex",
          )}
        >
          <div className="flex items-center justify-between px-3 py-2">
            <span className="text-muted-foreground text-xs">
              {entries.length === 0 && gap !== null
                ? gap.status
                : entries.length === 1
                  ? "1 champion"
                  : `${entries.length} champions`}
            </span>
            <Button
              size="xs"
              variant="ghost-muted"
              onClick={() => void navigate({ to: "/champions", search: { view: "new" } })}
            >
              <PlusIcon className="size-3" />
              New
            </Button>
          </div>
          <div className="min-h-0 flex-1 overflow-y-auto px-2 pb-2">
            <MachineNotices
              sources={connectedSources}
              waited={waited}
              machineLabel={machineLabel}
              gapNotice={gap?.notice ?? null}
            />
            {loading && entries.length === 0 ? (
              <div className="flex flex-col gap-2 p-2" aria-busy="true">
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-3 w-full" />
              </div>
            ) : null}
            {entries.map((entry) => (
              <ChampionListRow
                key={`${entry.environmentId}:${entry.champion.id}`}
                entry={entry}
                machineLabel={multipleMachines ? machineLabel(entry.environmentId) : null}
                active={
                  selected !== null &&
                  selected.environmentId === entry.environmentId &&
                  selected.champion.id === entry.champion.id &&
                  props.view !== "new"
                }
                onSelect={() => open(entry)}
              />
            ))}
          </div>
        </aside>
        <main
          className={cn(
            "min-w-0 flex-1 flex-col overflow-y-auto md:flex",
            showContent ? "flex" : "hidden",
          )}
        >
          {content}
        </main>
      </div>
    </div>
  );
}

function noop() {}
