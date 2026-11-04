import { RegistryContext, useAtomValue } from "@effect/atom-react";
import {
  championLoadFailureMessage,
  championsUnsupportedByServer,
} from "@t3tools/client-runtime/champions";
import type { EnvironmentConnectionPhase } from "@t3tools/client-runtime/connection";
import {
  type ChampionSummary,
  EnvironmentAuthorizationError,
  type EnvironmentId,
} from "@t3tools/contracts";
import * as Cause from "effect/Cause";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import { AsyncResult, Atom } from "effect/reactivity";
import { useContext } from "react";

import {
  type ChampionHistoryPage,
  mergeHistoryPages,
} from "../components/champions/champions.logic";
import { environmentSummaries } from "./presentation";
import { formatEnvironmentQueryError } from "./query";
import { serverEnvironment } from "./server";

export interface EnvironmentChampions {
  readonly environmentId: EnvironmentId;
  readonly champions: ReadonlyArray<ChampionSummary> | null;
  readonly error: string | null;
  readonly unsupported: boolean;
  /** Anything but "connected" means `champions` is the last-known list and commands can't reach it. */
  readonly connection: EnvironmentConnectionPhase;
}

const isAuthorizationError = Schema.is(EnvironmentAuthorizationError);

/** Phases that recover on their own. "available" is a deliberate disconnect; "error" and "unsupported" are blocked, including revoked access. */
const TRACKED_PHASES: ReadonlySet<EnvironmentConnectionPhase> = new Set([
  "connected",
  "connecting",
  "reconnecting",
  "offline",
]);

// The subscription stays mounted through a reconnect, so its last value outlives the session.
export const allChampionsAtom = Atom.make((get): ReadonlyArray<EnvironmentChampions> =>
  get(environmentSummaries.environmentsAtom)
    .filter(
      (environment) => environment.isEnabled && TRACKED_PHASES.has(environment.connectionState),
    )
    .map(({ environmentId, connectionState }) => {
      const result = get(serverEnvironment.championsLive({ environmentId, input: {} }));
      const failure = result._tag === "Failure" ? result.cause : null;
      const revoked =
        failure !== null && isAuthorizationError(Option.getOrNull(Cause.findErrorOption(failure)));
      const value = revoked ? null : Option.getOrNull(AsyncResult.value(result));
      const reportFailure = failure !== null && connectionState === "connected";
      return {
        environmentId,
        champions: value?.champions ?? null,
        error: reportFailure ? championLoadFailureMessage(failure) : null,
        unsupported: reportFailure && championsUnsupportedByServer(failure),
        connection: connectionState,
      };
    }),
).pipe(Atom.withLabel("web-champions:all"));

export function useAllChampions() {
  return useAtomValue(allChampionsAtom);
}

const HISTORY_PAGE_SIZE = 50;

export interface ChampionHistoryView extends ChampionHistoryPage {
  readonly hasOlder: boolean;
  readonly loading: boolean;
  readonly error: string | null;
}

interface HistoryTarget {
  readonly environmentId: EnvironmentId;
  readonly input: {
    readonly id: string;
    readonly limit: number;
    readonly before?: string;
  };
}

const EMPTY_HISTORY: ChampionHistoryPage = {
  findings: [],
  definitions: [],
  activity: [],
  samples: [],
};

/**
 * Each older page follows the live cursor of the one before it. A cursor kept from an earlier
 * read would leave a gap once new entries push older ones off the first page.
 */
const historyAtomFamily = Atom.family((key: string) => {
  const { environmentId, id, pageCount } = JSON.parse(key) as {
    readonly environmentId: EnvironmentId;
    readonly id: string;
    readonly pageCount: number;
  };
  return Atom.make(
    (get): ChampionHistoryView & { readonly targets: ReadonlyArray<HistoryTarget> } => {
      const pages: ChampionHistoryPage[] = [];
      const targets: HistoryTarget[] = [];
      let before: string | undefined;
      let hasOlder = false;
      let pending = false;
      let error: string | null = null;
      for (let index = 0; index < pageCount; index += 1) {
        const target: HistoryTarget = {
          environmentId,
          input: {
            id,
            limit: HISTORY_PAGE_SIZE,
            ...(before === undefined ? {} : { before }),
          },
        };
        targets.push(target);
        const result = get(serverEnvironment.championHistory(target));
        const value = Option.getOrNull(AsyncResult.value(result));
        if (value === null) {
          if (result._tag === "Failure") error = formatEnvironmentQueryError(result.cause);
          else pending = true;
          break;
        }
        pages.push({ ...value, findings: value.findings ?? [] });
        hasOlder = value.nextCursor !== null;
        if (value.nextCursor === null) break;
        before = value.nextCursor;
      }
      const previous = Option.getOrNull(get.self<ChampionHistoryView>());
      if (pending && previous !== null) {
        // A refreshed older page has a new cursor and starts empty; keep what is on screen.
        return { ...previous, targets };
      }
      return {
        ...(pages.length === 0 ? EMPTY_HISTORY : mergeHistoryPages(pages)),
        hasOlder,
        loading: pending && pages.length === 0,
        error,
        targets,
      };
    },
  ).pipe(Atom.withLabel("web-champions:history"));
});

export function useChampionHistory(environmentId: EnvironmentId, id: string, pageCount: number) {
  const registry = useContext(RegistryContext);
  const view = useAtomValue(historyAtomFamily(JSON.stringify({ environmentId, id, pageCount })));
  return {
    ...view,
    refresh: () => {
      for (const target of view.targets) {
        registry.refresh(serverEnvironment.championHistory(target));
      }
    },
  };
}
