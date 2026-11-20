import type {
  ChampionModelDefaults,
  ChampionModelOverrides,
  ChampionModelSlot,
  ChampionNextModels,
  ChampionSummary,
  EnvironmentId,
  ModelSelection,
} from "@t3tools/contracts";
import { SlidersHorizontalIcon } from "lucide-react";
import { useState } from "react";

import { selectionEffort } from "@t3tools/client-runtime/experiments";
import { pooledModelOf, pooledModels } from "@t3tools/shared/accountPools";

import { useClientSettings } from "../../hooks/useSettings";
import { useAllChampions } from "../../state/champions";
import { serverEnvironment } from "../../state/server";
import { selectModelSlotLabels, withPooledModelLabels } from "../chat/modelLabels";
import { useInstanceEntries } from "../settings/useInstanceEntries";
import { useAtomCommand } from "../../state/use-atom-command";
import { ModelLabel } from "../ModelLabel";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Popover, PopoverPopup, PopoverTrigger } from "../ui/popover";
import { Radio, RadioGroup } from "../ui/radio-group";
import { ChampionModelPicker } from "./ChampionModelPicker";
import { ChampionMachineNotice } from "./ChampionMachineNotice";
import {
  useChampionAction,
  useChampionCommandAllowed,
  useChampionMachineConnected,
} from "./useChampionAction";

type Kind = "checks" | "advice";

const KIND_LABELS: Record<Kind, string> = {
  checks: "Checks run on",
  advice: "Advice and setup use",
};

const omitKey = (models: ChampionModelOverrides | undefined, key: Kind): ChampionModelOverrides =>
  key === "checks"
    ? models?.advice === undefined
      ? {}
      : { advice: models.advice }
    : models?.checks === undefined
      ? {}
      : { checks: models.checks };

/** The machine's models for every Champion's own runs, set in one place at the top of the Champions screen. */
export function ChampionModelDefaultsControl(props: {
  readonly environmentId: EnvironmentId;
  /** Named only when Champions run on more than one machine. */
  readonly machineLabel: string | null;
  /** Absent when the machine's build has no Champion models. */
  readonly defaults: ChampionModelDefaults | undefined;
}) {
  const { environmentId, defaults } = props;
  const setModels = useAtomCommand(serverEnvironment.setChampionModels, {
    label: "champion models",
    reportFailure: false,
  });
  const canSave = useChampionCommandAllowed(serverEnvironment.setChampionModels, environmentId);
  const { busy, error, run } = useChampionAction();
  const needsModels = defaults !== undefined && defaults.checks === undefined;
  const connected = useChampionMachineConnected(environmentId);

  const save = (kind: Kind, slot: ChampionModelSlot | undefined) => {
    if (defaults === undefined) return;
    const other = kind === "checks" ? defaults.advice : defaults.checks;
    const otherKey = kind === "checks" ? "advice" : "checks";
    return run(kind, "save", [
      () =>
        setModels({
          environmentId,
          input: {
            ...(other === undefined ? {} : { [otherKey]: other }),
            ...(slot === undefined ? {} : { [kind]: slot }),
          },
        }),
    ]);
  };
  const pick = (kind: Kind, main: ModelSelection | null) => {
    if (main === null) return;
    const backup = defaults?.[kind]?.backup;
    return save(kind, { model: main, ...(backup === undefined ? {} : { backup }) });
  };
  const pickBackup = (kind: Kind, backup: ModelSelection | null) => {
    const main = defaults?.[kind]?.model;
    if (main === undefined) return;
    return save(kind, { model: main, ...(backup === null ? {} : { backup }) });
  };

  const disabled = !canSave || busy !== null;
  return (
    <Popover>
      <PopoverTrigger
        render={
          <Button size="xs" variant="outline">
            <SlidersHorizontalIcon className="size-3" />
            Champion models
            {needsModels ? (
              <span aria-label="Models needed" className="size-1.5 rounded-full bg-warning" />
            ) : null}
          </Button>
        }
      />
      <PopoverPopup align="end" className="w-[22rem] max-w-[calc(100vw-2rem)]">
        <div className="flex flex-col gap-4 p-1">
          {props.machineLabel === null ? null : (
            <p className="text-muted-foreground text-xs">On {props.machineLabel}</p>
          )}
          <ChampionMachineNotice environmentId={environmentId} />
          {defaults === undefined ? (
            connected ? (
              <p className="text-muted-foreground text-xs">
                This machine's server needs updating before you can choose Champion models.
              </p>
            ) : null
          ) : (
            <>
              {(["checks", "advice"] as const).map((kind) => (
                <div key={kind} className="flex flex-col gap-1.5">
                  <span className="font-medium text-xs">{KIND_LABELS[kind]}</span>
                  <ChampionModelPicker
                    environmentId={environmentId}
                    ariaLabel={KIND_LABELS[kind]}
                    selection={defaults[kind]?.model ?? null}
                    disabled={disabled}
                    onChange={(model) => void pick(kind, model)}
                  />
                  <ChampionModelPicker
                    environmentId={environmentId}
                    ariaLabel={`${KIND_LABELS[kind]}, backup`}
                    backup
                    selection={defaults[kind]?.backup ?? null}
                    disabled={disabled || defaults[kind] === undefined}
                    onChange={(backup) => void pickBackup(kind, backup)}
                  />
                </div>
              ))}
              {needsModels ? (
                <p role="status" className="text-warning-foreground text-xs">
                  Choose what checks run on. Until you do, Champions skip their checks.
                </p>
              ) : null}
            </>
          )}
          {error ? (
            <p role="alert" className="text-destructive-foreground text-xs">
              {error}
            </p>
          ) : null}
          <p className="text-muted-foreground text-xs">
            Each opens the same model picker as the composer, pooled models included. A pooled model
            moves between your accounts first; the backup takes over only when every account for the
            main model is at its limit. Changes apply from the next check. Helpers a Champion starts
            (repairs, reviews, browser work) still use your delegation roles.
          </p>
        </div>
      </PopoverPopup>
    </Popover>
  );
}

/** A model as the picker names it: a pooled model by its own name and "Any account", with its effort. */
function ChampionModelName(props: {
  readonly environmentId: EnvironmentId;
  readonly selection: ModelSelection;
}) {
  const { settings, providers } = useInstanceEntries(props.environmentId);
  const slotLabels = useClientSettings(selectModelSlotLabels);
  const { selection } = props;
  const pool =
    selection.pinned === true
      ? undefined
      : pooledModelOf(
          withPooledModelLabels(pooledModels(providers, settings), slotLabels),
          selection,
        );
  const effort = selectionEffort(selection);
  return (
    <span className="inline-flex min-w-0 items-center gap-1.5">
      <ModelLabel
        environmentId={props.environmentId}
        instanceId={selection.instanceId}
        model={selection.model}
        className="inline-flex"
        {...(pool === undefined ? {} : { name: pool.displayName, hideSource: true })}
      />
      {pool === undefined ? null : <span className="text-muted-foreground">Any account</span>}
      {effort === null || effort === undefined ? null : (
        <span className="text-muted-foreground">{effort}</span>
      )}
    </span>
  );
}

function NextModel(props: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly next: ChampionNextModels[Kind];
}) {
  const { next } = props;
  return (
    <span className="inline-flex items-center gap-1.5">
      <span className="text-muted-foreground">{props.label}</span>
      {next === undefined ? (
        <span className="text-warning-foreground">Not set</span>
      ) : (
        <ChampionModelName environmentId={props.environmentId} selection={next.model} />
      )}
    </span>
  );
}

/** The models this Champion's next check and advice will use, and whether they are its own. */
export function ChampionModelStrip(props: {
  readonly environmentId: EnvironmentId;
  readonly champion: ChampionSummary;
  readonly changeControl: React.ReactNode;
}) {
  const next = props.champion.nextModels;
  const own = next?.checks?.source === "champion" || next?.advice?.source === "champion";
  return (
    <>
      <NextModel environmentId={props.environmentId} label="Checks" next={next?.checks} />
      <NextModel environmentId={props.environmentId} label="Advice" next={next?.advice} />
      {own ? (
        <Badge variant="secondary" size="sm">
          This Champion only
        </Badge>
      ) : null}
      {props.changeControl}
    </>
  );
}

/** Lets one Champion follow the machine default or run on a model of its own, for checks and for advice. */
export function ChampionModelControls(props: {
  readonly environmentId: EnvironmentId;
  readonly champion: ChampionSummary;
}) {
  const { champion, environmentId } = props;
  const upsert = useAtomCommand(serverEnvironment.upsertChampion, {
    label: "champion save",
    reportFailure: false,
  });
  const canSave = useChampionCommandAllowed(serverEnvironment.upsertChampion, environmentId);
  const { busy, error, run } = useChampionAction();
  const defaults = useAllChampions().find(
    (source) => source.environmentId === environmentId,
  )?.modelDefaults;
  // Choosing "a model for this Champion" waits for a model; until then the saved override stands.
  const [choosing, setChoosing] = useState<Partial<Record<Kind, true>>>({});

  const change = (overrides: ChampionModelOverrides) =>
    run("models", "save", [
      () =>
        upsert({
          environmentId,
          input: {
            id: champion.id,
            projectId: champion.projectId,
            name: champion.name,
            purpose: champion.purpose,
            schedule: champion.schedule,
            models: overrides,
            charter: champion.charter,
            ...(champion.journeys === undefined ? {} : { journeys: champion.journeys }),
            ...(champion.repairsVia === undefined ? {} : { repairsVia: champion.repairsVia }),
          },
        }),
    ]);

  const disabled = !canSave || busy !== null;
  const section = (kind: Kind, label: string) => {
    const own = champion.models?.[kind];
    const isOwn = own !== undefined || choosing[kind] === true;
    const defaultModel = defaults?.[kind]?.model ?? null;
    return (
      <div key={kind} className="flex flex-col gap-1.5">
        <span className="font-medium text-xs">{label}</span>
        <RadioGroup
          value={isOwn ? "own" : "default"}
          onValueChange={(value) => {
            if (value === "default") {
              setChoosing((current) => ({ ...current, [kind]: undefined }) as typeof current);
              if (own !== undefined) {
                void change(
                  kind === "checks"
                    ? omitKey(champion.models, "checks")
                    : omitKey(champion.models, "advice"),
                );
              }
            } else setChoosing((current) => ({ ...current, [kind]: true }));
          }}
        >
          <label className="flex items-center gap-2">
            <Radio value="default" disabled={disabled} />
            <span className="inline-flex flex-wrap items-center gap-1">
              Champion default
              {defaultModel === null ? null : (
                <ChampionModelName environmentId={environmentId} selection={defaultModel} />
              )}
            </span>
          </label>
          <label className="flex items-center gap-2">
            <Radio value="own" disabled={disabled} />
            Choose a model for this Champion
          </label>
        </RadioGroup>
        {isOwn ? (
          <ChampionModelPicker
            environmentId={environmentId}
            ariaLabel={label}
            selection={own ?? null}
            disabled={disabled}
            onChange={(model) => {
              if (model === null) return;
              void change({ ...champion.models, [kind]: model } as ChampionModelOverrides).then(
                (saved) => {
                  if (saved)
                    setChoosing((current) => ({ ...current, [kind]: undefined }) as typeof current);
                },
              );
            }}
          />
        ) : null}
      </div>
    );
  };

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
      <PopoverPopup align="start" className="w-[22rem] max-w-[calc(100vw-2rem)]">
        <div className="flex flex-col gap-4 p-1">
          {section("checks", "Checks")}
          {section("advice", "Advice and setup")}
          {error ? (
            <p role="alert" className="text-destructive-foreground text-xs">
              {error}
            </p>
          ) : null}
          <p className="text-muted-foreground text-xs">
            The default's backup still applies when this model is at its limit.
          </p>
        </div>
      </PopoverPopup>
    </Popover>
  );
}
