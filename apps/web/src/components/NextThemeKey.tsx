import { useNavigate } from "@tanstack/react-router";
import { PaletteIcon } from "lucide-react";

import { useNextRotationTheme } from "~/hooks/useTheme";
import { playKeyClick } from "~/lib/interfaceSounds";

import { themeRotationLabel } from "./settings/ThemeModeSetting";
import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

/**
 * The sidebar header's key that moves a daily rotation on to its next favourite for today.
 * Without a rotation of two or more favourites it opens Appearance, where they are chosen.
 */
export function NextThemeKey() {
  const { next, cycle } = useNextRotationTheme();
  const navigate = useNavigate();
  const label = next === null ? null : themeRotationLabel(next);
  const tip = label === null ? "Choose favourite themes to cycle through" : `Next theme: ${label}`;
  return (
    <span className="app-away-key ml-3 flex items-center [-webkit-app-region:no-drag]">
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              className="device-key"
              aria-label={tip}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => {
                playKeyClick("down");
                if (next === null) void navigate({ to: "/settings/appearance" });
                else cycle();
              }}
            />
          }
        >
          <PaletteIcon aria-hidden="true" />
        </TooltipTrigger>
        <TooltipPopup side="bottom">{tip}</TooltipPopup>
      </Tooltip>
    </span>
  );
}
