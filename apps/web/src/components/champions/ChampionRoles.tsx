import type { ChampionSelectionClass, ChampionSummary, EnvironmentId } from "@t3tools/contracts";
import { Link } from "@tanstack/react-router";
import { SlidersHorizontalIcon } from "lucide-react";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { ChampionClassField, useChampionClassChoices } from "./ChampionClassField";
import { useChampionAction, useChampionCommandAllowed } from "./useChampionAction";

type Phase = "setup" | "routine";

/** Saves a role change straight away: the model follows the role policy, so the role is the whole choice. */
export function ChampionRoleControls(props: {
  readonly environmentId: EnvironmentId;
  readonly champion: ChampionSummary;
}) {
  const { champion, environmentId } = props;
  const { classes } = champion;
  const upsert = useAtomCommand(serverEnvironment.upsertChampion, {
    label: "champion save",
    reportFailure: false,
  });
  const canSave = useChampionCommandAllowed(serverEnvironment.upsertChampion, environmentId);
  const { busy, error, run } = useChampionAction();
  const target = (phase: Phase) => ({
    environmentId,
    projectId: champion.projectId,
    championId: champion.id,
    phase,
  });
  const routineChoices = useChampionClassChoices(target("routine"), classes?.routine ?? null);
  const setupChoices = useChampionClassChoices(target("setup"), classes?.setup ?? null);
  if (classes === undefined) return null;

  const change = (phase: Phase, selected: ChampionSelectionClass) =>
    run(phase, "save", [
      () =>
        upsert({
          environmentId,
          input: {
            id: champion.id,
            projectId: champion.projectId,
            name: champion.name,
            purpose: champion.purpose,
            schedule: champion.schedule,
            classes: { ...classes, [phase]: selected },
            setupModelSelection: champion.setupModelSelection,
            routineModelSelection: champion.routineModelSelection,
            charter: champion.charter,
            ...(champion.journeys === undefined ? {} : { journeys: champion.journeys }),
            ...(champion.repairsVia === undefined ? {} : { repairsVia: champion.repairsVia }),
          },
        }),
    ]);

  const disabled = !canSave || busy !== null;
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button size="xs" variant="ghost-muted">
            <SlidersHorizontalIcon className="size-3" />
            Change models
          </Button>
        }
      />
      <PopoverPopup align="start" className="w-80">
        <div className="flex flex-col gap-4 p-1">
          <ChampionClassField
            label="Checks use"
            environmentId={environmentId}
            selected={classes.routine}
            saved={classes.routine}
            query={routineChoices}
            disabled={disabled}
            onChange={(selected) => void change("routine", selected)}
          />
          <ChampionClassField
            label="Harder work uses"
            environmentId={environmentId}
            selected={classes.setup}
            saved={classes.setup}
            query={setupChoices}
            disabled={disabled}
            onChange={(selected) => void change("setup", selected)}
          />
          {error ? (
            <p role="alert" className="text-destructive-foreground text-xs">
              {error}
            </p>
          ) : null}
          <p className="text-muted-foreground text-xs">
            A role's model comes from your role policy.{" "}
            <Link to="/settings/delegation" className="underline underline-offset-2">
              Change what each role uses
            </Link>
            . A change applies from the next attempt.
          </p>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
