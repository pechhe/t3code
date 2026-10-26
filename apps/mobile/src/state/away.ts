import { useAtomValue } from "@effect/atom-react";
import { createAwayPress, shownAway, summarizeAway } from "@t3tools/client-runtime/away";
import { Atom } from "effect/reactivity";
import { useEffect, useState } from "react";

import * as Dialog from "../components/ui/Dialog";
import { serverEnvironment } from "./server";
import { useAtomCommand } from "./use-atom-command";
import { workspaceConnections } from "./workspace";

const awayEnvironmentsAtom = Atom.make((get) =>
  get(workspaceConnections.environmentsAtom).flatMap((environment) => {
    if (!environment.isEnabled || environment.connectionState !== "connected") return [];
    const environmentId = environment.environmentId;
    const settings = get(serverEnvironment.settingsValueAtom(environmentId));
    const permitted = get(serverEnvironment.setAway.permissionAtom(environmentId));
    return settings && permitted
      ? [{ environmentId, label: environment.environmentLabel, away: settings.away }]
      : [];
  }),
).pipe(Atom.withLabel("mobile:away-environments"));

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
        Dialog.alert("Couldn't change Away", `${names} didn't change. Try again.`);
      },
    }),
  );
  useEffect(() => press.observe(server.state), [press, server.state]);
  const shown = shownAway(server, pending);
  const toggle = () => press.press(shown.next, environments);
  return { ...shown, toggle };
}
