import type { ChampionSelectionClass, EnvironmentId, ProjectId } from "@t3tools/contracts";

import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { AgentRoleChip } from "../AgentRoleChip";
import { ModelLabel } from "../ModelLabel";
import { ROLE_DESCRIPTIONS } from "../settings/DelegationSettings.logic";
import { Label } from "../ui/label";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import {
  championClassOptions,
  championRoleTaskClass,
  resolveChampionClass,
} from "./champions.logic";

interface ChampionClassChoicesTarget {
  readonly environmentId: EnvironmentId;
  readonly projectId: ProjectId;
  /** An existing champion resolves against its own thread's ceiling, not a new one's. */
  readonly championId: string | undefined;
  readonly phase: "setup" | "routine";
}

export function useChampionClassChoices(
  target: ChampionClassChoicesTarget | null,
  selected: ChampionSelectionClass | null,
) {
  const atomFor = (taskClass: ChampionSelectionClass["taskClass"]) =>
    target === null
      ? null
      : serverEnvironment.championClassChoices({
          environmentId: target.environmentId,
          input: {
            projectId: target.projectId,
            ...(target.championId === undefined ? {} : { championId: target.championId }),
            taskClass,
            phase: target.phase,
          },
        });
  const nonUi = useEnvironmentQuery(selected === null ? null : atomFor("non-ui"));
  const ui = useEnvironmentQuery(selected === null ? null : atomFor("ui"));
  // Only a choice already saved as mixed asks; no role is offered as mixed.
  const mixed = useEnvironmentQuery(selected?.taskClass === "mixed" ? atomFor("mixed") : null);
  const choices = { "non-ui": nonUi.data, ui: ui.data, mixed: mixed.data };
  const currentQuery = { "non-ui": nonUi, ui, mixed }[selected?.taskClass ?? "non-ui"];
  return {
    choices,
    current: selected === null ? null : resolveChampionClass(selected, choices[selected.taskClass]),
    error: currentQuery.data === null ? currentQuery.error : null,
    refresh: () => {
      nonUi.refresh();
      ui.refresh();
      if (selected?.taskClass === "mixed") mixed.refresh();
    },
  };
}

type ChampionClassChoices = ReturnType<typeof useChampionClassChoices>;

export function ChampionClassField(props: {
  readonly label: string;
  readonly environmentId: EnvironmentId;
  readonly selected: ChampionSelectionClass;
  readonly saved: ChampionSelectionClass | null;
  readonly query: ChampionClassChoices;
  readonly disabled: boolean;
  readonly onChange: (selected: ChampionSelectionClass) => void;
}) {
  const { selected, saved, query } = props;
  const { current } = query;
  const options = championClassOptions(selected, query.choices);
  const pick = (role: ChampionSelectionClass["role"]) =>
    props.onChange(role === saved?.role ? saved : { role, taskClass: championRoleTaskClass(role) });
  return (
    <div className="flex flex-col gap-1.5">
      <Label>{props.label}</Label>
      <Select
        value={selected.role}
        disabled={props.disabled}
        onValueChange={(role) => role && pick(role)}
      >
        <SelectTrigger size="sm" className="w-auto self-start" aria-label={props.label}>
          <SelectValue>
            <AgentRoleChip role={selected.role} />
          </SelectValue>
        </SelectTrigger>
        <SelectPopup>
          {options.map((option) => (
            <SelectItem key={option.role} value={option.role}>
              <span className="flex flex-col items-start gap-0.5">
                <AgentRoleChip role={option.role} />
                <span className="text-muted-foreground text-xs">
                  {ROLE_DESCRIPTIONS[option.role]}
                </span>
              </span>
            </SelectItem>
          ))}
        </SelectPopup>
      </Select>
      {query.error ? (
        <p role="alert" className="text-destructive-foreground text-xs">
          Couldn't check this role on this machine. {query.error}
        </p>
      ) : current === null ? (
        <p role="status" className="text-muted-foreground text-xs">
          Checking your role policy…
        </p>
      ) : current.selection ? (
        <p className="flex flex-wrap items-center gap-x-1 text-muted-foreground text-xs">
          Follows your role policy. Currently
          <ModelLabel
            environmentId={props.environmentId}
            instanceId={current.selection.instanceId}
            model={current.selection.model}
            className="inline-flex"
          />
        </p>
      ) : (
        <p role="alert" className="text-warning-foreground text-xs">
          This role can't run here right now, and nothing switches to another model.{" "}
          {current.refusal}
        </p>
      )}
      {saved !== null && saved.role !== selected.role ? (
        <p className="text-xs">
          Applies from the next attempt. A run already accepted keeps its model.
        </p>
      ) : null}
    </div>
  );
}
