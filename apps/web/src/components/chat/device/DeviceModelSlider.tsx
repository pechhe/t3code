import type { EnvironmentId, ProviderDriverKind, ProviderInstanceId } from "@t3tools/contracts";
import { type CSSProperties, Fragment, type ReactElement, type ReactNode, useMemo } from "react";

import { useEnvironmentModelPreferences } from "~/hooks/useSettings";
import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../../ui/tooltip";
import { providerModelKey } from "../../../modelOrdering";
import type { ProviderInstanceEntry } from "../../../providerInstances";
import { resolveModelPickerSelectedModel } from "../ModelPickerContent";
import { getTriggerDisplayModelName, type ModelEsque } from "../providerIconUtils";

/** Favourite slots before the overflow detent. */
const FAVORITE_SLOTS = 4;
const DETENTS = FAVORITE_SLOTS + 1;

interface Slot {
  readonly instanceId: ProviderInstanceId;
  readonly model: string;
  readonly label: string;
  readonly disabledReason: string | null;
}

/**
 * The model slider: the first four favourite models as detents, and the
 * overflow detent opening the full picker. A model chosen from the picker that
 * is not a favourite parks the thumb on the overflow detent under its own name.
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
}) {
  const { favorites } = useEnvironmentModelPreferences(props.environmentId);
  const {
    activeInstanceId,
    instanceEntries,
    modelOptionsByInstance,
    lockedProvider,
    lockedContinuationGroupKey,
    getModelDisabledReason,
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
        return {
          instanceId,
          model: option?.slug ?? model,
          label: option ? getTriggerDisplayModelName(option) : model,
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
  const activeKey = active ? providerModelKey(active.instanceId, active.model) : null;
  const activeIndex = slots.findIndex(
    (slot) => providerModelKey(slot.instanceId, slot.model) === activeKey,
  );
  const position = activeIndex >= 0 ? activeIndex : FAVORITE_SLOTS;
  const overflowLabel = activeIndex < 0 && active ? active.label : null;

  return (
    <div
      className="device-slider"
      role="group"
      aria-label="Model"
      style={{ "--slider-position": position, "--slider-detents": DETENTS } as CSSProperties}
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
      {slots.map((slot, index) => {
        const label = (
          <button
            type="button"
            className="device-slider__label"
            style={{ "--slot": index } as CSSProperties}
            disabled={props.disabled}
            aria-disabled={slot.disabledReason !== null || undefined}
            aria-pressed={index === activeIndex}
            onPointerDown={(event) => event.preventDefault()}
            onClick={() => {
              if (slot.disabledReason === null) props.onSelect(slot.instanceId, slot.model);
            }}
          >
            {slot.label}
          </button>
        );
        return slot.disabledReason === null ? (
          <Fragment key={providerModelKey(slot.instanceId, slot.model)}>{label}</Fragment>
        ) : (
          <Tooltip key={providerModelKey(slot.instanceId, slot.model)}>
            <TooltipTrigger render={label} />
            <TooltipPopup side="top">{slot.disabledReason}</TooltipPopup>
          </Tooltip>
        );
      })}
      {props.renderOverflow(
        <button
          type="button"
          className={cn(
            "device-slider__label",
            overflowLabel === null && "device-slider__label--menu",
          )}
          style={{ "--slot": FAVORITE_SLOTS } as CSSProperties}
          disabled={props.disabled}
          aria-label={overflowLabel === null ? "All models" : `${overflowLabel}, all models`}
        >
          {overflowLabel ?? "•••"}
        </button>,
      )}
    </div>
  );
}
