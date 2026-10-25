import {
  type EnvironmentId,
  OrchestratorMcpFailure,
  OrchestratorMcpPeerNotice,
  OrchestratorMcpThreadListPage,
  type OrchestratorMcpThreadListInput,
  OrchestratorMcpThreadReadResult,
  OrchestratorMcpThreadSearchPage,
  type OrchestratorMcpThreadSearchInput,
  type PeerEnvironmentStatus,
} from "@t3tools/contracts";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import { formatThreadLink } from "@t3tools/shared/threadLinks";

import * as PeerEnvironments from "./PeerEnvironments.ts";

/** Most threads or matches asked of each peer when a list or search spans every environment. */
const PEER_LIST_LIMIT = 20;
const PEER_SEARCH_LIMIT = 10;
/** A thread read is larger than a list, so it waits longer for one route. */
const PEER_READ_TIMEOUT = Duration.seconds(8);

/** One linked environment's answer, or why there is none. */
export interface PeerAnswer<Page> {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly status: PeerEnvironmentStatus;
  readonly notice: string;
  readonly page: Page | null;
}

/**
 * What a query for one linked environment reports beside its page, which then stands in the top
 * level: the status and the quoted-data notice, so success and failure are read the same way.
 */
export const reportedBesidePage = <Page>(
  answer: PeerAnswer<Page> | undefined,
): ReadonlyArray<PeerAnswer<Page>> => (answer === undefined ? [] : [{ ...answer, page: null }]);

type ListPage = typeof OrchestratorMcpThreadListPage.Type;
type SearchPage = typeof OrchestratorMcpThreadSearchPage.Type;

/**
 * Thread reads on the environments linked to this one. The local answer stays
 * with the tools' own service; this adds each peer's, best effort: a peer that
 * is offline, slow or on a build that lacks the tool is reported by status and
 * never fails the call.
 */
export class ThreadDirectory extends Context.Service<
  ThreadDirectory,
  {
    /** A thread list on the peers `selector` names; none for this environment's own ID. */
    readonly list: (
      selector: EnvironmentId | "all",
      input: OrchestratorMcpThreadListInput,
    ) => Effect.Effect<ReadonlyArray<PeerAnswer<ListPage>>>;
    /** The same for a thread search. */
    readonly search: (
      selector: EnvironmentId | "all",
      input: OrchestratorMcpThreadSearchInput,
    ) => Effect.Effect<ReadonlyArray<PeerAnswer<SearchPage>>>;
    /** A thread on a linked environment, read there. */
    readonly read: (
      environmentId: EnvironmentId,
      input: Record<string, unknown>,
    ) => Effect.Effect<OrchestratorMcpThreadReadResult, OrchestratorMcpFailure>;
    /**
     * The list tool's whole answer: `local` is this environment's own, which gains each peer's
     * beside it; asking for one linked environment answers with that peer's page instead.
     */
    readonly listAcross: <A extends object, E, R>(input: {
      readonly query: OrchestratorMcpThreadListInput;
      readonly localId: EnvironmentId;
      readonly fromPeer: boolean;
      readonly local: Effect.Effect<A, E, R>;
    }) => Effect.Effect<
      | (A & { readonly environments: ReadonlyArray<PeerAnswer<ListPage>> })
      | {
          readonly environmentId: EnvironmentId;
          readonly projectId: ListPage["projectId"] | null;
          readonly currentThreadId: null;
          readonly threads: ListPage["threads"];
          readonly nextCursor: ListPage["nextCursor"];
          readonly total: number;
          readonly environments: ReadonlyArray<PeerAnswer<ListPage>>;
        },
      E,
      R
    >;
    /** The same for the search tool. */
    readonly searchAcross: <A extends object, E, R>(input: {
      readonly query: OrchestratorMcpThreadSearchInput;
      readonly localId: EnvironmentId;
      readonly fromPeer: boolean;
      readonly local: Effect.Effect<A, E, R>;
    }) => Effect.Effect<
      | (A & { readonly environments: ReadonlyArray<PeerAnswer<SearchPage>> })
      | {
          readonly environmentId: EnvironmentId;
          readonly matches: SearchPage["matches"];
          readonly environments: ReadonlyArray<PeerAnswer<SearchPage>>;
        },
      E,
      R
    >;
    /** The read tool: a linked environment's thread is read there, anything else is `local`. */
    readonly readAcross: <A, E, R>(input: {
      readonly environmentId: EnvironmentId | undefined;
      readonly localId: EnvironmentId;
      readonly fromPeer: boolean;
      readonly arguments: Record<string, unknown>;
      readonly local: Effect.Effect<A, E, R>;
    }) => Effect.Effect<A | OrchestratorMcpThreadReadResult, E | OrchestratorMcpFailure, R>;
  }
>()("t3/peers/ThreadDirectory") {}

/**
 * Which environments a list or search covers. A linked environment's own agent
 * sees only this one: reads do not chain through peers.
 */
export const environmentPlan = (input: {
  readonly requested: EnvironmentId | "all" | undefined;
  readonly localId: EnvironmentId;
  readonly fromPeer: boolean;
}): { readonly includeLocal: boolean; readonly peers: EnvironmentId | "all" | undefined } => {
  const requested = input.requested ?? "all";
  if (input.fromPeer || requested === input.localId) {
    return { includeLocal: true, peers: undefined };
  }
  return requested === "all"
    ? { includeLocal: true, peers: "all" }
    : { includeLocal: false, peers: requested };
};

const notLinked = (environmentId: EnvironmentId) =>
  new OrchestratorMcpFailure({
    code: "invalid_request",
    message: `Environment ${environmentId} is not linked to this one.`,
  });

const toFailure = (text: string) => {
  try {
    const parsed: unknown = JSON.parse(text);
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      "code" in parsed &&
      typeof parsed.code === "string" &&
      "message" in parsed &&
      typeof parsed.message === "string"
    ) {
      return new OrchestratorMcpFailure({
        code: parsed.code === "thread_not_found" ? "thread_not_found" : "orchestration_error",
        message: parsed.message,
      });
    }
  } catch {
    // Not a tool failure payload; fall through to the raw text.
  }
  return new OrchestratorMcpFailure({ code: "orchestration_error", message: text });
};

const make = Effect.gen(function* () {
  // Without the peers service nothing is linked, which is every test's and a bare server's case.
  const peers = yield* Effect.serviceOption(PeerEnvironments.PeerEnvironments);

  const targets = (selector: EnvironmentId | "all") =>
    Option.isNone(peers)
      ? Effect.succeed([])
      : peers.value.linked.pipe(
          Effect.map((linked) =>
            selector === "all" ? linked : linked.filter((peer) => peer.environmentId === selector),
          ),
          Effect.orElseSucceed(() => []),
        );

  const ask = <Page, Encoded>(
    peer: { readonly environmentId: EnvironmentId; readonly label: string },
    tool: string,
    args: Record<string, unknown>,
    schema: Schema.Codec<Page, Encoded>,
  ): Effect.Effect<PeerAnswer<Page>> => {
    const answer = (status: PeerEnvironmentStatus, page: Page | null) => ({
      environmentId: peer.environmentId,
      label: peer.label,
      status,
      notice: OrchestratorMcpPeerNotice,
      page,
    });
    if (Option.isNone(peers)) return Effect.succeed(answer("offline", null));
    return peers.value
      .callTool({ environmentId: peer.environmentId, name: tool, arguments: args })
      .pipe(
        Effect.flatMap((result) =>
          result.isError
            ? Effect.succeed(answer("unsupported", null))
            : Schema.decodeUnknownEffect(schema)(result.structuredContent).pipe(
                Effect.map((page) => answer("ok", page)),
                Effect.orElseSucceed(() => answer("unsupported", null)),
              ),
        ),
        Effect.catchTags({
          PeerCallError: (error) =>
            Effect.succeed(answer(error.status === "not_linked" ? "offline" : error.status, null)),
          PeerEnvironmentError: () => Effect.succeed(answer("offline", null)),
        }),
      );
  };

  const list: ThreadDirectory["Service"]["list"] = (selector, input) =>
    targets(selector).pipe(
      Effect.flatMap((linked) =>
        Effect.forEach(
          linked,
          (peer) =>
            ask(
              peer,
              "t3_thread_list",
              {
                ...(input.statuses === undefined ? {} : { statuses: input.statuses }),
                ...(input.titleContains === undefined
                  ? {}
                  : { titleContains: input.titleContains }),
                ...(input.settled === undefined ? {} : { settled: input.settled }),
                ...(input.snoozed === undefined ? {} : { snoozed: input.snoozed }),
                ...(input.includeSubagents === undefined
                  ? {}
                  : { includeSubagents: input.includeSubagents }),
                // A project ID is one environment's own, so only a single-environment query
                // may carry one, and only to that environment.
                ...(selector !== "all" && input.projectId !== undefined
                  ? { projectId: input.projectId }
                  : {}),
                ...(selector !== "all" && input.cursor !== undefined
                  ? { cursor: input.cursor }
                  : {}),
                limit:
                  selector === "all"
                    ? Math.min(input.limit ?? PEER_LIST_LIMIT, PEER_LIST_LIMIT)
                    : (input.limit ?? PEER_LIST_LIMIT),
                environmentId: peer.environmentId,
              },
              OrchestratorMcpThreadListPage,
            ).pipe(
              // The peer names its own threads; the ID that reached it is the one that is true.
              Effect.map((answer) => retag(answer, peer.environmentId)),
            ),
          { concurrency: "unbounded" },
        ),
      ),
    );

  const search: ThreadDirectory["Service"]["search"] = (selector, input) =>
    targets(selector).pipe(
      Effect.flatMap((linked) =>
        Effect.forEach(
          linked,
          (peer) =>
            ask(
              peer,
              "t3_thread_search",
              {
                query: input.query,
                limit: Math.min(input.limit ?? PEER_SEARCH_LIMIT, 50),
                environmentId: peer.environmentId,
              },
              OrchestratorMcpThreadSearchPage,
            ).pipe(Effect.map((answer) => retag(answer, peer.environmentId))),
          { concurrency: "unbounded" },
        ),
      ),
    );

  const read: ThreadDirectory["Service"]["read"] = Effect.fn("ThreadDirectory.read")(
    function* (environmentId, input) {
      if (Option.isNone(peers)) return yield* notLinked(environmentId);
      const found = (yield* peers.value.linked.pipe(Effect.orElseSucceed(() => []))).find(
        (peer) => peer.environmentId === environmentId,
      );
      if (found === undefined) return yield* notLinked(environmentId);
      const result = yield* peers.value
        .callTool({
          environmentId,
          name: "t3_thread_read",
          arguments: { ...input, environmentId },
          timeout: PEER_READ_TIMEOUT,
        })
        .pipe(
          Effect.mapError(
            (error) =>
              new OrchestratorMcpFailure({
                code: "orchestration_error",
                message:
                  error._tag === "PeerCallError"
                    ? `${found.label} is ${error.status}.`
                    : `${found.label} could not be reached.`,
              }),
          ),
        );
      if (result.isError) return yield* toFailure(result.text);
      const decoded = yield* Schema.decodeUnknownEffect(OrchestratorMcpThreadReadResult)(
        result.structuredContent,
      ).pipe(
        Effect.mapError(
          () =>
            new OrchestratorMcpFailure({
              code: "orchestration_error",
              message: `${found.label} answered in a form this environment cannot read.`,
            }),
        ),
      );
      return { ...decoded, environmentId, notice: OrchestratorMcpPeerNotice };
    },
  );

  const listAcross: ThreadDirectory["Service"]["listAcross"] = Effect.fn(
    "ThreadDirectory.listAcross",
  )(function* (input) {
    const plan = environmentPlan({
      requested: input.query.environmentId,
      localId: input.localId,
      fromPeer: input.fromPeer,
    });
    const peerAnswers = plan.peers === undefined ? [] : yield* list(plan.peers, input.query);
    if (!plan.includeLocal) {
      // One linked environment asked for: its page stands in the top level, and its status
      // and quoted-data notice are reported beside it, without repeating the page.
      const [answer] = peerAnswers;
      return {
        environmentId: answer?.environmentId ?? (plan.peers as EnvironmentId),
        projectId: answer?.page?.projectId ?? null,
        currentThreadId: null,
        threads: answer?.page?.threads ?? [],
        nextCursor: answer?.page?.nextCursor ?? null,
        total: answer?.page?.total ?? 0,
        environments: reportedBesidePage(answer),
      };
    }
    return { ...(yield* input.local), environments: peerAnswers };
  });

  const searchAcross: ThreadDirectory["Service"]["searchAcross"] = Effect.fn(
    "ThreadDirectory.searchAcross",
  )(function* (input) {
    const plan = environmentPlan({
      requested: input.query.environmentId,
      localId: input.localId,
      fromPeer: input.fromPeer,
    });
    const peerAnswers = plan.peers === undefined ? [] : yield* search(plan.peers, input.query);
    if (!plan.includeLocal) {
      const [answer] = peerAnswers;
      return {
        environmentId: answer?.environmentId ?? (plan.peers as EnvironmentId),
        matches: answer?.page?.matches ?? [],
        environments: reportedBesidePage(answer),
      };
    }
    return { ...(yield* input.local), environments: peerAnswers };
  });

  const readAcross: ThreadDirectory["Service"]["readAcross"] = (input) =>
    input.environmentId !== undefined && input.environmentId !== input.localId && !input.fromPeer
      ? read(input.environmentId, input.arguments)
      : input.local;

  return ThreadDirectory.of({ list, search, read, listAcross, searchAcross, readAcross });
});

/** A peer match that names a thread, so a link it carries can name its environment too. */
interface PeerMatchFields {
  readonly threadId?: unknown;
  readonly title?: unknown;
  readonly link?: unknown;
}

/**
 * Stamps every thread or match of a peer's page with the environment it was read from, and points a
 * match's thread link at that environment: an unqualified link opens a thread of the same id here.
 */
const retag = <
  Page extends {
    readonly threads?: ReadonlyArray<object>;
    readonly matches?: ReadonlyArray<PeerMatchFields & object>;
  },
>(
  answer: PeerAnswer<Page>,
  environmentId: EnvironmentId,
): PeerAnswer<Page> =>
  answer.page === null
    ? answer
    : {
        ...answer,
        page: {
          ...answer.page,
          ...(answer.page.threads === undefined
            ? {}
            : { threads: answer.page.threads.map((thread) => ({ ...thread, environmentId })) }),
          ...(answer.page.matches === undefined
            ? {}
            : {
                matches: answer.page.matches.map((match) => {
                  const { link, threadId, title, ...rest } = match;
                  return {
                    ...rest,
                    environmentId,
                    ...(typeof link === "string" && typeof threadId === "string"
                      ? {
                          link: formatThreadLink(
                            threadId,
                            typeof title === "string" ? title : threadId,
                            environmentId,
                          ),
                        }
                      : {}),
                  };
                }),
              }),
        },
      };

export const layer = Layer.effect(ThreadDirectory, make);
