import { useAtomValue } from "@effect/atom-react";
import { createAwayPress, shownAway, summarizeAway } from "@t3tools/client-runtime/away";
import { Atom } from "effect/reactivity";
import { useEffect, useState } from "react";

import { stackedThreadToast, toastManager } from "../components/ui/toast";
import { environmentSummaries } from "./presentation";
import { serverEnvironment } from "./server";
import { useAtomCommand } from "./use-atom-command";

const awayEnvironmentsAtom = Atom.make((get) => {
  const identities = get(environmentSummaries.identitiesAtom);
  return get(environmentSummaries.connectedEnvironmentIdsAtom).flatMap((environmentId) => {
    const settings = get(serverEnvironment.settingsValueAtom(environmentId));
    const permitted = get(serverEnvironment.setAway.permissionAtom(environmentId));
    return settings && permitted
      ? [
          {
            environmentId,
            label:
              identities.find((entry) => entry.environmentId === environmentId)?.label ??
              environmentId,
            away: settings.away,
          },
        ]
      : [];
  });
}).pipe(Atom.withLabel("web:away-environments"));

export function useAway() {
  const environments = useAtomValue(awayEnvironmentsAtom);
  const server = summarizeAway(environments.map((environment) => environment.away));
  const setAway = useAtomCommand(serverEnvironment.setAway);
  const [pending, setPending] = useState<boolean | null>(null);
  const [press] = useState(() =>
    createAwayPress({
      set: (environment: (typeof environments)[number], away) =>
        setAway({ environmentId: environment.environmentId, input: { away } }),
      changed: setPending,
      failed: (failed) => {
        const names = failed.map((environment) => environment.label).join(", ");
        toastManager.add(
          stackedThreadToast({
            type: "error",
            title: "Couldn't change Away",
            description: `${names} didn't change. Try again.`,
          }),
        );
      },
    }),
  );
  useEffect(() => press.observe(server.state), [press, server.state]);
  const shown = shownAway(server, pending);
  const toggle = () => press.press(shown.next, environments);
  return { ...shown, environments, toggle };
}
