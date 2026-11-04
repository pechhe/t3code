import type { EnvironmentId } from "@t3tools/contracts";

import { useEnvironment } from "../../state/environments";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import { championMachineGap } from "./champions.logic";

export function ChampionMachineNotice(props: {
  readonly environmentId: EnvironmentId;
  readonly draft?: boolean;
}) {
  const machine = useEnvironment(props.environmentId);
  if (machine === null || machine.connection.phase === "connected") return null;
  const gap = championMachineGap([machine]);
  return (
    <Alert variant="warning">
      <AlertTitle>{gap?.title ?? `${machine.label} isn't connected`}</AlertTitle>
      <AlertDescription>
        {props.draft
          ? "Saving is off until it connects. Your draft stays here."
          : "Showing the last known state. Changes are off until it connects."}
      </AlertDescription>
    </Alert>
  );
}
