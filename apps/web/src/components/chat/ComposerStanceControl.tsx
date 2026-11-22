import type { DelegationStance } from "@t3tools/contracts";
import { Menu as MenuPrimitive } from "@base-ui/react/menu";
import { memo, useId, useRef, useState } from "react";

import { Menu, MenuPopup, MenuTrigger } from "../ui/menu";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { ComposerControl, ComposerControlIcon } from "./ComposerControl";
import { useComposerMenuProps } from "./composerEventScope";
import { DELEGATION_STANCE_OPTIONS, getDelegationStanceOption } from "./stance.logic";
import { STANCE_ICON } from "./stanceIcons";
import { useComposerMenuState } from "./useComposerMenuState";

/**
 * Non-device composer stance control: a compact chip matching the permissions
 * chip that opens the two-position delegation stance radio menu.
 */
export const ComposerStanceControl = memo(function ComposerStanceControl(props: {
  stance: DelegationStance;
  disabled?: boolean;
  size?: "sm" | "xs";
  hidden?: boolean;
  onChange: (stance: DelegationStance) => void;
}) {
  const size = props.size ?? "sm";
  const composerFloatingLayerProps = useComposerMenuProps();
  const [open, setOpen] = useComposerMenuState(props.hidden);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const activeOption = getDelegationStanceOption(props.stance);
  const StanceIcon = STANCE_ICON[props.stance];
  const tooltip = `Delegation stance: ${activeOption.label}. ${activeOption.tooltip}`;

  return (
    <Menu open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger
          render={
            <MenuTrigger
              render={
                <ComposerControl
                  ref={triggerRef}
                  size={size}
                  disabled={props.disabled}
                  aria-label={`Delegation stance: ${activeOption.label}`}
                />
              }
            />
          }
        >
          <ComposerControlIcon icon={StanceIcon} size={size} />
          <span data-composer-control-label>{activeOption.label}</span>
        </TooltipTrigger>
        <TooltipPopup side="top">{tooltip}</TooltipPopup>
      </Tooltip>
      <MenuPopup align="start" {...composerFloatingLayerProps}>
        <ComposerStanceSection
          stance={props.stance}
          disabled={props.disabled ?? false}
          onChange={props.onChange}
        />
      </MenuPopup>
    </Menu>
  );
});

export function ComposerStanceSection(props: {
  stance: DelegationStance;
  disabled?: boolean;
  onChange: (stance: DelegationStance) => void;
}) {
  const [previewStance, setPreviewStance] = useState<DelegationStance | null>(null);
  const shownStance = previewStance ?? props.stance;
  const shown = getDelegationStanceOption(shownStance);
  const descriptionId = useId();
  return (
    <div data-composer-stance className="grid w-72 gap-1.5 px-2 py-1.5">
      <div className="font-medium text-muted-foreground text-xs">Delegation stance</div>
      <MenuPrimitive.RadioGroup
        aria-label="Delegation stance"
        value={props.stance}
        onValueChange={(value: DelegationStance) => {
          if (!props.disabled && value !== props.stance) props.onChange(value);
        }}
        className="flex rounded-lg bg-input/40 p-0.5"
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return;
          const items = Array.from(
            event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitemradio"]'),
          );
          const index = items.findIndex((item) => item === document.activeElement);
          const next = items[index + (event.key === "ArrowRight" ? 1 : -1)];
          if (index < 0 || !next) return;
          event.preventDefault();
          event.stopPropagation();
          next.focus();
        }}
      >
        {DELEGATION_STANCE_OPTIONS.map((option) => {
          const OptionIcon = STANCE_ICON[option.stance];
          return (
            <MenuPrimitive.RadioItem
              key={option.stance}
              value={option.stance}
              disabled={props.disabled ?? false}
              label={option.label}
              aria-label={option.label}
              aria-describedby={`${descriptionId}-${option.stance}`}
              closeOnClick
              onPointerEnter={() => setPreviewStance(option.stance)}
              onPointerLeave={() => setPreviewStance(null)}
              onFocus={() => setPreviewStance(option.stance)}
              onBlur={() => setPreviewStance(null)}
              className="flex h-6 flex-1 cursor-pointer items-center justify-center gap-1 text-xs text-muted-foreground outline-none first:rounded-l-md last:rounded-r-md data-disabled:cursor-not-allowed data-disabled:opacity-40 data-checked:bg-input/72 data-checked:text-foreground data-highlighted:text-foreground not-data-checked:data-highlighted:bg-accent focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
            >
              <OptionIcon aria-hidden="true" className="size-3.5 shrink-0" />
              <span>{option.label}</span>
            </MenuPrimitive.RadioItem>
          );
        })}
      </MenuPrimitive.RadioGroup>
      {DELEGATION_STANCE_OPTIONS.map((option) => (
        <span key={option.stance} id={`${descriptionId}-${option.stance}`} className="sr-only">
          {option.tooltip}
        </span>
      ))}
      <div className="grid gap-0.5" aria-hidden="true">
        <span
          className={
            shownStance === props.stance
              ? "text-foreground text-sm"
              : "text-muted-foreground text-sm"
          }
        >
          {shown.label}
        </span>
        <span className="min-h-8 text-muted-foreground text-xs leading-4">{shown.tooltip}</span>
      </div>
    </div>
  );
}
