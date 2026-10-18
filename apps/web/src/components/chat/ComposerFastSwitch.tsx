import type {
  ProviderDriverKind,
  ProviderInstanceId,
  ProviderOptionSelection,
  ScopedThreadRef,
  ServerProviderModel,
} from "@t3tools/contracts";
import { normalizeModelSlug } from "@t3tools/shared/model";
import { ZapIcon } from "lucide-react";
import { memo } from "react";

import { type DraftId, useComposerDraftStore } from "../../composerDraftStore";
import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerControl, ComposerControlIcon, type ComposerControlSize } from "./ComposerControl";
import { getComposerFastSwitch } from "./composerProviderState";
import { DeviceUnit } from "./device/DeviceUnit";

/**
 * Always-visible Fast toggle. A model without a Fast option keeps the switch in place but
 * unavailable; its saved choice stays in the per-model memory and returns with the model.
 */
export const ComposerFastSwitch = memo(function ComposerFastSwitch(props: {
  provider: ProviderDriverKind;
  instanceId: ProviderInstanceId;
  threadRef?: ScopedThreadRef;
  draftId?: DraftId;
  model: string;
  models: ReadonlyArray<ServerProviderModel>;
  modelOptions: ReadonlyArray<ProviderOptionSelection> | undefined;
  planModeEnabled: boolean;
  size?: ComposerControlSize;
  /** Render as the machined composer's round cap with an amber lamp. */
  device?: boolean;
}) {
  const size = props.size ?? "sm";
  const setProviderModelOptions = useComposerDraftStore((store) => store.setProviderModelOptions);
  const fastSwitch = getComposerFastSwitch(props);
  const target = props.threadRef ?? props.draftId;
  const available = fastSwitch !== null && target !== undefined;
  const active = available && fastSwitch.active;
  const modelName =
    props.models.find(
      (candidate) => candidate.slug === normalizeModelSlug(props.model, props.provider),
    )?.name ?? props.model;
  const tooltip = !available
    ? `Fast mode isn't available for ${modelName}`
    : active
      ? "Fast mode on: faster responses at a higher cost. Click to turn off."
      : "Turn on Fast mode: faster responses at a higher cost";

  const toggle = () => {
    if (!available) return;
    setProviderModelOptions(target, props.provider, fastSwitch.modelOptionsWithFast(!active), {
      instanceId: props.instanceId,
      model: props.model,
      persistSticky: true,
    });
  };

  if (props.device) {
    return (
      <DeviceUnit caption="Fast" lit={active}>
        <Tooltip>
          <TooltipTrigger
            render={
              <button
                type="button"
                className="device-cap device-cap--fast"
                aria-pressed={active}
                aria-disabled={!available || undefined}
                aria-label={tooltip}
                onPointerDown={(event) => event.preventDefault()}
                onClick={toggle}
              />
            }
          >
            <span className="device-cap__lamp" aria-hidden="true" />
          </TooltipTrigger>
          <TooltipPopup side="top">{tooltip}</TooltipPopup>
        </Tooltip>
      </DeviceUnit>
    );
  }

  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <ComposerControl
            size={size}
            className={cn("shrink-0 whitespace-nowrap", !available && "cursor-default opacity-50")}
            aria-pressed={active}
            aria-disabled={!available || undefined}
            aria-label={tooltip}
            onClick={toggle}
          />
        }
      >
        <ComposerControlIcon
          icon={ZapIcon}
          size={size}
          className={cn(
            active &&
              cn(
                "fill-current opacity-100",
                props.provider === "claudeAgent" ? "text-[#d97757]" : "text-current",
              ),
          )}
        />
        <span data-composer-control-label className="sr-only sm:not-sr-only">
          Fast
        </span>
      </TooltipTrigger>
      <TooltipPopup side="top">{tooltip}</TooltipPopup>
    </Tooltip>
  );
});
