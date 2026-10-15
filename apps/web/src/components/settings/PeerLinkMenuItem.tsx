import { useAtomValue } from "@effect/atom-react";
import {
  linkPeerEnvironments,
  peerErrorMessage,
  peerLinkAvailability,
  peerRoutesFor,
  unlinkPeerEnvironments,
  type PeerLinkDirection,
} from "@t3tools/client-runtime/state/peers";
import {
  type AtomCommandResult,
  isAtomCommandInterrupted,
  squashAtomCommandFailure,
} from "@t3tools/client-runtime/state/runtime";
import type { EnvironmentId, PeersUpdateInput } from "@t3tools/contracts";
import { LinkIcon, UnlinkIcon } from "lucide-react";
import { useCallback, useMemo } from "react";

import { requestConfirmDialog } from "~/confirmDialog";
import { type EnvironmentPresentation, usePrimaryEnvironment } from "~/state/environments";
import { peerEnvironments } from "~/state/peers";
import { useAtomCommand } from "../../state/use-atom-command";
import { useEnvironmentQuery } from "~/state/query";
import { MenuItem } from "../ui/menu";
import { stackedThreadToast, toastManager } from "../ui/toast";

/** Whether either environment already reads the other's threads. */
export function usePeerLinked(environmentId: EnvironmentId, primaryId: EnvironmentId | null) {
  const own = useEnvironmentQuery(
    primaryId === null ? null : peerEnvironments.list({ environmentId: primaryId, input: {} }),
  );
  const theirs = useEnvironmentQuery(peerEnvironments.list({ environmentId, input: {} }));
  const readsThem = own.data?.find((peer) => peer.environmentId === environmentId) ?? null;
  const readsUs = theirs.data?.find((peer) => peer.environmentId === primaryId) ?? null;
  return { readsThem, readsUs, refresh: () => (own.refresh(), theirs.refresh()) };
}

/** A settled command's value, or its failure thrown for the link flow to report. */
function unwrap<A, E>(result: AtomCommandResult<A, E>): A {
  if (result._tag === "Success") return result.value;
  throw isAtomCommandInterrupted(result)
    ? new Error("Cancelled.")
    : squashAtomCommandFailure(result);
}

function directionProblem(label: string, direction: PeerLinkDirection): string | null {
  if (direction.status === "linked") return null;
  return direction.status === "no-route"
    ? `${label} has no address the other machine can reach.`
    : `${label}: ${peerErrorMessage(direction.cause)}`;
}

/**
 * Links this environment (the one the client is viewing) with a saved one in
 * both directions, or removes the link. Agents on either side can then read
 * the other's threads; nothing can be written.
 */
export function PeerLinkMenuItem({
  environment,
  advertisedUrls,
}: {
  readonly environment: EnvironmentPresentation;
  /** Extra addresses the primary environment can be reached at, from desktop network access. */
  readonly advertisedUrls: ReadonlyArray<string>;
}) {
  const primary = usePrimaryEnvironment();
  const primaryId = primary?.environmentId ?? null;
  const { readsThem, readsUs, refresh } = usePeerLinked(environment.environmentId, primaryId);
  const mintCode = useAtomCommand(peerEnvironments.mintCode, { reportFailure: false });
  const update = useAtomCommand(peerEnvironments.update, { reportFailure: false });
  const primaryAllowed = useAtomValue(
    useMemo(() => peerEnvironments.update.permissionAtom(primaryId), [primaryId]),
  );
  const peerAllowed = useAtomValue(
    peerEnvironments.update.permissionAtom(environment.environmentId),
  );

  const availability = peerLinkAvailability({
    connected: environment.connection.phase === "connected",
    primaryAllowed: primaryAllowed === true,
    peerAllowed: peerAllowed === true,
    linked: readsThem !== null || readsUs !== null,
  });

  const deps = useMemo(
    () => ({
      mintCode: async (environmentId: EnvironmentId) => unwrap(await mintCode({ environmentId })),
      update: async (environmentId: EnvironmentId, input: PeersUpdateInput) =>
        unwrap(await update({ environmentId, input })),
    }),
    [mintCode, update],
  );

  const link = useCallback(async () => {
    if (primary === null) return;
    const confirmed = await requestConfirmDialog(
      `Link ${primary.label} and ${environment.label}?\nAgents on each machine will be able to list, search and read the other's threads, titles and messages. They cannot send, edit or run anything there. Either side can unlink at any time.`,
    );
    if (confirmed !== true) return;
    const result = await linkPeerEnvironments(
      deps,
      {
        environmentId: primary.environmentId,
        routes: peerRoutesFor(primary.entry, advertisedUrls),
      },
      { environmentId: environment.environmentId, routes: peerRoutesFor(environment.entry) },
    );
    refresh();
    const problems = [
      directionProblem(`${primary.label} reading ${environment.label}`, result.aReadsB),
      directionProblem(`${environment.label} reading ${primary.label}`, result.bReadsA),
    ].filter((problem): problem is string => problem !== null);
    toastManager.add(
      problems.length === 0
        ? {
            type: "success",
            title: "Environments linked",
            description: `Agents on ${primary.label} and ${environment.label} can now read each other's threads.`,
          }
        : stackedThreadToast({
            type: "error",
            title: "Link incomplete",
            description: problems.join("\n"),
          }),
    );
  }, [advertisedUrls, deps, environment, primary, refresh]);

  const unlink = useCallback(async () => {
    if (primary === null) return;
    const confirmed = await requestConfirmDialog(
      `Unlink ${primary.label} and ${environment.label}?\nAgents will stop reading each other's threads straight away.`,
      { variant: "destructive" },
    );
    if (confirmed !== true) return;
    const failures = await unlinkPeerEnvironments(
      deps,
      primary.environmentId,
      environment.environmentId,
    );
    refresh();
    toastManager.add(
      failures.length === 0
        ? { type: "success", title: "Environments unlinked" }
        : stackedThreadToast({
            type: "error",
            title: "Unlinked on one side only",
            description: failures.map((failure) => peerErrorMessage(failure.cause)).join("\n"),
          }),
    );
  }, [deps, environment, primary, refresh]);

  if (primary === null || primary.environmentId === environment.environmentId) return null;
  if (availability.kind === "unlink") {
    return (
      <MenuItem onClick={() => void unlink()}>
        <UnlinkIcon />
        Unlink threads…
      </MenuItem>
    );
  }
  return (
    <MenuItem disabled={availability.kind === "disabled"} onClick={() => void link()}>
      <LinkIcon />
      {availability.kind === "disabled" && availability.reason === "permission"
        ? "Link threads (needs access:write)"
        : "Link threads…"}
    </MenuItem>
  );
}
