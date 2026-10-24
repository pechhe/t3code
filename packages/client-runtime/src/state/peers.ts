import {
  AuthOrchestrationReadScope,
  type EnvironmentId,
  type PeerEnvironment,
  type PeerEnvironmentError,
  type PeersUpdateInput,
  WS_METHODS,
} from "@t3tools/contracts";
import { isLocalLoopbackHost } from "@t3tools/shared/hostClassification";
import * as Data from "effect/Data";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { HttpClient } from "effect/http";
import { Atom, AtomRegistry } from "effect/reactivity";

import * as RemoteEnvironmentAuthorization from "../authorization/service.ts";
import type { EnvironmentRegistry } from "../connection/registry.ts";
import { connectionRoutes, routeHttpBaseUrl } from "../connection/routes.ts";
import type { ConnectionCatalogEntry } from "../connection/catalog.ts";
import * as ManagedRelay from "../relay/managedRelay.ts";
import { executeAuthenticatedEnvironmentHttpRequest } from "./environmentHttpAuth.ts";
import {
  createAtomCommandScheduler,
  createEnvironmentRpcCommand,
  createEnvironmentRpcQueryAtomFamily,
  createRuntimeCommand,
} from "./runtime.ts";
import { createEnvironmentSessionAtoms } from "./session.ts";

const MINT_TIMEOUT_MS = 8_000;

/** The client holds no connection to the environment, so it cannot ask for a code. */
class PeerCodeUnavailable extends Data.TaggedError("PeerCodeUnavailable")<{
  readonly environmentId: EnvironmentId;
}> {}

function isLoopbackUrl(url: string): boolean {
  try {
    return isLocalLoopbackHost(new URL(url).hostname);
  } catch {
    return true;
  }
}

/**
 * The addresses another server can try for an environment: its direct routes,
 * then any extra addresses the environment advertises, with loopback left out
 * because it would make the other server dial itself. T3 Connect and SSH
 * routes only work from this client, so they are never passed on.
 */
export function peerRoutesFor(
  entry: ConnectionCatalogEntry,
  advertised: ReadonlyArray<string> = [],
): ReadonlyArray<string> {
  const urls = [
    ...connectionRoutes(entry).flatMap((route) => routeHttpBaseUrl(route) ?? []),
    ...advertised,
  ].filter((url) => !isLoopbackUrl(url));
  return [...new Set(urls)].slice(0, 8);
}

/** What happened to one direction of a link; the first environment reads the second. */
export type PeerLinkDirection =
  | { readonly status: "linked" }
  | { readonly status: "no-route" }
  | { readonly status: "failed"; readonly cause: unknown };

export interface PeerLinkTarget {
  readonly environmentId: EnvironmentId;
  /** Addresses the other environment can reach this one at. */
  readonly routes: ReadonlyArray<string>;
}

export interface PeerLinkDeps {
  /** Mints a one-time code on an environment that holds `orchestration:read`. */
  readonly mintCode: (environmentId: EnvironmentId) => Promise<string>;
  readonly update: (environmentId: EnvironmentId, input: PeersUpdateInput) => Promise<unknown>;
}

/**
 * Links two environments in both directions. `reader` is the environment that
 * will read `source`; each direction is its own session, so one can succeed
 * while the other has no address to dial or fails. Both outcomes are returned
 * rather than thrown so the caller can say which direction is missing.
 */
async function linkDirection(
  deps: PeerLinkDeps,
  reader: EnvironmentId,
  source: PeerLinkTarget,
): Promise<PeerLinkDirection> {
  if (source.routes.length === 0) return { status: "no-route" };
  try {
    const code = await deps.mintCode(source.environmentId);
    await deps.update(reader, { _tag: "link", code, routes: [...source.routes] });
    return { status: "linked" };
  } catch (cause) {
    return { status: "failed", cause };
  }
}

export async function linkPeerEnvironments(
  deps: PeerLinkDeps,
  a: PeerLinkTarget,
  b: PeerLinkTarget,
): Promise<{ readonly aReadsB: PeerLinkDirection; readonly bReadsA: PeerLinkDirection }> {
  const [aReadsB, bReadsA] = await Promise.all([
    linkDirection(deps, a.environmentId, b),
    linkDirection(deps, b.environmentId, a),
  ]);
  return { aReadsB, bReadsA };
}

/** Drops both directions. An unreachable side is reported, not left half-linked silently. */
export async function unlinkPeerEnvironments(
  deps: Pick<PeerLinkDeps, "update">,
  a: EnvironmentId,
  b: EnvironmentId,
): Promise<ReadonlyArray<{ readonly reader: EnvironmentId; readonly cause: unknown }>> {
  const attempts = await Promise.all(
    [
      [a, b],
      [b, a],
    ].map(async ([reader, source]) => {
      try {
        await deps.update(reader!, { _tag: "unlink", environmentId: source! });
        return null;
      } catch (cause) {
        return { reader: reader!, cause };
      }
    }),
  );
  return attempts.filter((attempt) => attempt !== null);
}

/** Why the Link action is, or is not, offered for one pair. */
export type PeerLinkAvailability =
  | { readonly kind: "link" }
  | { readonly kind: "unlink" }
  | { readonly kind: "disabled"; readonly reason: "offline" | "permission" };

/**
 * Both environments must be connected, because the client asks each for a
 * code, and the viewer needs `access:write` on both because linking hands the
 * other environment read access to every thread. An existing link in either
 * direction is offered for removal instead, which needs the grant on at least one side.
 */
export function peerLinkAvailability(input: {
  readonly connected: boolean;
  readonly primaryAllowed: boolean;
  readonly peerAllowed: boolean;
  readonly linked: boolean;
}): PeerLinkAvailability {
  // Either side can drop its half, so one grant is enough to offer removal.
  if (input.linked) {
    return input.primaryAllowed || input.peerAllowed
      ? { kind: "unlink" }
      : { kind: "disabled", reason: "permission" };
  }
  if (!input.connected) return { kind: "disabled", reason: "offline" };
  if (!input.primaryAllowed || !input.peerAllowed) {
    return { kind: "disabled", reason: "permission" };
  }
  return { kind: "link" };
}

/**
 * Threads an agent on `composerEnvironmentId` cannot read: those on neither its own environment
 * nor one linked to it. Linked environments may be offline; the read then reports that.
 */
export function unreadableThreadRefs<Ref extends { readonly environmentId: EnvironmentId }>(
  refs: ReadonlyArray<Ref>,
  composerEnvironmentId: EnvironmentId,
  linked: ReadonlyArray<Pick<PeerEnvironment, "environmentId">>,
): ReadonlyArray<Ref> {
  return refs.filter(
    (ref) =>
      ref.environmentId !== composerEnvironmentId &&
      !linked.some((peer) => peer.environmentId === ref.environmentId),
  );
}

function peerStatusLabel(status: NonNullable<PeerEnvironment["status"]>): string {
  switch (status) {
    case "ok":
      return "Linked";
    case "offline":
      return "Linked, not reachable";
    case "timeout":
      return "Linked, not answering";
    case "unauthorized":
      return "Link was revoked on the other side";
    case "unsupported":
      return "Linked, needs a newer version";
  }
}

/** The row's note on a link: both directions, or the worse one's status. */
export function peerLinkSubtitle(
  readsThem: Pick<PeerEnvironment, "status"> | null,
  readsUs: Pick<PeerEnvironment, "status"> | null,
): string | null {
  const directions = [readsThem, readsUs].filter((peer) => peer !== null);
  // A link nobody has checked yet has no status; only a known failure is worth a word.
  const problem = directions.find((peer) => peer.status !== undefined && peer.status !== "ok");
  if (problem?.status) return peerStatusLabel(problem.status);
  if (directions.length === 0) return null;
  return directions.length === 2 ? "Threads linked" : "Threads linked one way";
}

export function peerErrorMessage(cause: unknown): string {
  const error = cause as Partial<PeerEnvironmentError> | null;
  if (error !== null && typeof error === "object" && error._tag === "PeerEnvironmentError") {
    return (error as PeerEnvironmentError).message;
  }
  return cause instanceof Error ? cause.message : "The request failed.";
}

export function createPeerEnvironmentAtoms<R, E>(
  runtime: Atom.AtomRuntime<EnvironmentRegistry | R, E>,
) {
  const session = createEnvironmentSessionAtoms(runtime);
  /** Environments the given environment reads threads from, with their last known status. */
  const list = createEnvironmentRpcQueryAtomFamily(runtime, {
    label: "environment-data:peers:list",
    tag: WS_METHODS.peersList,
    staleTimeMs: 15_000,
  });
  return {
    list,
    update: createEnvironmentRpcCommand(runtime, {
      label: "environment-data:peers:update",
      tag: WS_METHODS.peersUpdate,
      scheduler: createAtomCommandScheduler(),
      concurrency: {
        mode: "serial" as const,
        key: ({ environmentId }: { environmentId: string }) => environmentId,
      },
      // Both views of the list, the probed one in Settings and the stored one in composers,
      // must show a link as soon as it is made or removed.
      onSettled: ({ environmentId }, registry) =>
        Effect.sync(() => {
          registry.refresh(list({ environmentId, input: {} }));
          registry.refresh(list({ environmentId, input: { probe: false } }));
        }),
    }),
    /**
     * A one-time code that lets another environment read this one's threads.
     * It travels over the same HTTP path the connection uses for its own
     * requests, so relay and bearer credentials both work.
     */
    mintCode: createRuntimeCommand(runtime, {
      label: "environment-data:peers:mint-code",
      execute: Effect.fn("peers.mintCode")(function* (
        { environmentId }: { readonly environmentId: EnvironmentId },
        registry: AtomRegistry.AtomRegistry,
      ) {
        const prepared = Option.getOrNull(
          registry.get(session.preparedConnectionValueAtom(environmentId)),
        );
        if (prepared === null) return yield* new PeerCodeUnavailable({ environmentId });
        const signer = yield* Effect.serviceOption(ManagedRelay.ManagedRelayDpopSigner);
        const remoteAuthorization = yield* Effect.serviceOption(
          RemoteEnvironmentAuthorization.RemoteEnvironmentAuthorization,
        );
        const client = yield* Effect.serviceOption(HttpClient.HttpClient);
        if (Option.isNone(client)) return yield* new PeerCodeUnavailable({ environmentId });
        const credential = yield* executeAuthenticatedEnvironmentHttpRequest({
          prepared,
          signer,
          remoteAuthorization,
          group: "auth",
          method: "POST",
          url: (urls) => urls.pairingCredential(),
          timeoutMs: MINT_TIMEOUT_MS,
          request: ({ client: api, headers }) =>
            api.pairingCredential({
              headers,
              payload: { label: "Linked environment", scopes: [AuthOrchestrationReadScope] },
            }),
        }).pipe(Effect.provideService(HttpClient.HttpClient, client.value));
        return credential.credential;
      }),
    }),
  };
}
