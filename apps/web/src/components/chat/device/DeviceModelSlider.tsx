import type { EnvironmentId, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import type { ClientSettings } from "@t3tools/contracts/settings";
import {
  type CSSProperties,
  type ReactElement,
  type ReactNode,
  type Ref,
  useImperativeHandle,
  useMemo,
  useState,
} from "react";

import {
  useClientSettings,
  useEnvironmentModelPreferences,
  updateClientSettings,
} from "~/hooks/useSettings";
import { playRotary } from "~/lib/interfaceSounds";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import { providerModelKey } from "../../../modelOrdering";
import type { ProviderInstanceEntry } from "../../../providerInstances";
import { resolveModelPickerSelectedModel } from "../ModelPickerContent";
import { getTriggerDisplayModelName, type ModelEsque } from "../providerIconUtils";

/** Favourite slots before the overflow detent. */
const FAVORITE_SLOTS = 4;
const DETENTS = FAVORITE_SLOTS + 1;

/**
 * The light under the thumb takes the provider's colour, so the rail shows which
 * provider is on at a glance. A provider's accent colour from Settings wins.
 */
const PROVIDER_LIGHTS: Readonly<Record<string, string>> = {
  claudeAgent: "oklch(0.7 0.17 42)",
  claude: "oklch(0.7 0.17 42)",
  codex: "oklch(0.72 0.14 165)",
  cursor: "oklch(0.66 0.19 290)",
  grok: "oklch(0.66 0.2 15)",
  opencode: "oklch(0.74 0.16 115)",
  antigravity: "oklch(0.66 0.17 255)",
};

const selectModelSlotLabels = (settings: ClientSettings) => settings.modelSlotLabels;

export interface DeviceModelSliderHandle {
  /** Picks the favourite in slot `index` (0-based), as clicking its label would. */
  selectSlot: (index: number) => void;
}

interface Slot {
  readonly key: string;
  readonly instanceId: ProviderInstanceId;
  readonly model: string;
  /** The user's name for the slot, else the model's own. */
  readonly label: string;
  readonly modelName: string;
  readonly disabledReason: string | null;
}

/**
 * The model slider: the first four favourite models as detents, and the
 * overflow detent opening the full picker. A model chosen from the picker that
 * is not a favourite parks the thumb on the overflow detent under its own name.
 * Double-clicking a favourite's name renames it; an empty name restores the model's.
 */
export function DeviceModelSlider(props: {
  environmentId: EnvironmentId | null;
  activeInstanceId: ProviderInstanceId;
  model: string;
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
  lockedProvider: ProviderDriverKind | null;
  lockedContinuationGroupKey: string | null;
  disabled: boolean;
  getModelDisabledReason: (instanceId: ProviderInstanceId, model: string) => string | null;
  onSelect: (instanceId: ProviderInstanceId, model: string) => void;
  /** Wraps the overflow trigger in the full model picker. */
  renderOverflow: (trigger: ReactElement) => ReactNode;
  /** Overrides the provider's light, as an account pool does with the account it will use. */
  lightColor?: string | undefined;
  ref?: Ref<DeviceModelSliderHandle>;
}) {
  const { favorites } = useEnvironmentModelPreferences(props.environmentId);
  const slotLabels = useClientSettings(selectModelSlotLabels);
  const [renamingKey, setRenamingKey] = useState<string | null>(null);
  const {
    activeInstanceId,
    instanceEntries,
    modelOptionsByInstance,
    lockedProvider,
    lockedContinuationGroupKey,
    getModelDisabledReason,
    lightColor,
  } = props;

  const resolveSlot = useMemo(
    () =>
      (instanceId: ProviderInstanceId, model: string): Slot | null => {
        const entry = instanceEntries.find((candidate) => candidate.instanceId === instanceId);
        if (!entry || !entry.enabled) return null;
        const option = resolveModelPickerSelectedModel({
          driverKind: entry.driverKind,
          model,
          options: modelOptionsByInstance.get(instanceId) ?? [],
        });
        const locked =
          lockedProvider !== null &&
          (entry.driverKind !== lockedProvider ||
            (lockedContinuationGroupKey !== null &&
              entry.continuationGroupKey !== lockedContinuationGroupKey));
        const slug = option?.slug ?? model;
        const key = providerModelKey(instanceId, slug);
        const modelName = option ? getTriggerDisplayModelName(option) : model;
        return {
          key,
          instanceId,
          model: slug,
          label: slotLabels[key] ?? modelName,
          modelName,
          disabledReason: locked
            ? "This thread can't switch to another provider"
            : getModelDisabledReason(instanceId, model),
        };
      },
    [
      getModelDisabledReason,
      instanceEntries,
      lockedContinuationGroupKey,
      lockedProvider,
      modelOptionsByInstance,
      slotLabels,
    ],
  );

  const slots = useMemo(
    () =>
      favorites
        .map((favorite) => resolveSlot(favorite.provider, favorite.model))
        .filter((slot): slot is Slot => slot !== null)
        .slice(0, FAVORITE_SLOTS),
    [favorites, resolveSlot],
  );
  const active = resolveSlot(activeInstanceId, props.model);
  const activeIndex = slots.findIndex((slot) => slot.key === active?.key);

  const selectSlot = (index: number) => {
    const slot = slots[index];
    if (!slot || props.disabled || slot.disabledReason !== null || index === activeIndex) return;
    playRotary();
    props.onSelect(slot.instanceId, slot.model);
  };
  useImperativeHandle(props.ref, () => ({ selectSlot }));

  const rename = (slot: Slot, name: string) => {
    setRenamingKey(null);
    const label = name.trim();
    const { [slot.key]: _previous, ...others } = slotLabels;
    const next = label && label !== slot.modelName ? { ...others, [slot.key]: label } : others;
    if (next[slot.key] !== slotLabels[slot.key]) {
      void updateClientSettings({ modelSlotLabels: next });
    }
  };
  const position = activeIndex >= 0 ? activeIndex : FAVORITE_SLOTS;
  const overflowLabel = activeIndex < 0 && active ? active.label : null;
  const activeEntry = instanceEntries.find((entry) => entry.instanceId === activeInstanceId);
  const providerLight =
    lightColor ??
    (activeEntry
      ? (activeEntry.accentColor ?? PROVIDER_LIGHTS[activeEntry.driverKind])
      : undefined);

  return (
    <div
      className="device-slider"
      role="group"
      aria-label="Model"
      style={
        {
          "--slider-position": position,
          "--slider-detents": DETENTS,
          ...(providerLight ? { "--provider-light": providerLight } : {}),
        } as CSSProperties
      }
    >
      <span className="device-slider__ticks" aria-hidden="true">
        {Array.from({ length: DETENTS }, (_, index) => (
          <span key={index} className="device-slider__tick" />
        ))}
      </span>
      <span className="device-slider__track" aria-hidden="true">
        <span className="device-slider__glow" />
      </span>
      <span className="device-slider__thumb" aria-hidden="true" />
      {slots.map((slot, index) =>
        slot.key === renamingKey ? (
          <input
            key={slot.key}
            className="device-slider__label device-slider__rename"
            style={{ "--slot": index } as CSSProperties}
            aria-label={`Name for ${slot.modelName}`}
            placeholder={slot.modelName}
            defaultValue={slot.label}
            autoFocus
            onFocus={(event) => event.currentTarget.select()}
            onBlur={(event) => rename(slot, event.currentTarget.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") event.currentTarget.blur();
              if (event.key === "Escape") setRenamingKey(null);
            }}
          />
        ) : (
          <Tooltip key={slot.key}>
            <TooltipTrigger
              render={
                <button
                  type="button"
                  className="device-slider__label"
                  style={{ "--slot": index } as CSSProperties}
                  disabled={props.disabled}
                  aria-disabled={slot.disabledReason !== null || undefined}
                  aria-pressed={index === activeIndex}
                  onPointerDown={(event) => event.preventDefault()}
                  onClick={() => selectSlot(index)}
                  onDoubleClick={() => setRenamingKey(slot.key)}
                />
              }
            >
              {slot.label}
            </TooltipTrigger>
            <TooltipPopup side="top">
              {slot.disabledReason ??
                (slot.label === slot.modelName
                  ? "Double-click to rename"
                  : `${slot.modelName} · Double-click to rename`)}
            </TooltipPopup>
          </Tooltip>
        ),
      )}
      {props.renderOverflow(
        <button
          type="button"
          className="device-slider__label device-slider__label--menu"
          style={{ "--slot": FAVORITE_SLOTS } as CSSProperties}
          disabled={props.disabled}
          aria-label={overflowLabel === null ? "All models" : `${overflowLabel}, all models`}
          aria-pressed={overflowLabel !== null}
        >
          <span className="device-slider__menu-tag">{overflowLabel ?? "More"} ▾</span>
        </button>,
      )}
    </div>
  );
}
