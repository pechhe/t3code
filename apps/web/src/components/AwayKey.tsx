import { MoonIcon } from "lucide-react";

import { playKeyClick } from "~/lib/interfaceSounds";
import { useAway } from "~/state/away";

import { Tooltip, TooltipPopup, TooltipTrigger } from "./ui/tooltip";

export function AwayKey() {
  const away = useAway();
  const on = away.state !== "off";
  const tooltip =
    away.state === "mixed"
      ? `Away is on for ${away.environments
          .filter((environment) => environment.away)
          .map((environment) => environment.label)
          .join(", ")} but not ${away.environments
          .filter((environment) => !environment.away)
          .map((environment) => environment.label)
          .join(", ")}. Click to turn it on everywhere.`
      : on
        ? "Away: every thread keeps working and answers its own questions. Click when you're back."
        : "Going away? Every thread keeps working and answers its own questions.";
  return (
    <span className="app-away-key ml-3 flex items-center gap-1.5 [-webkit-app-region:no-drag]">
      <Tooltip>
        <TooltipTrigger
          render={
            <button
              type="button"
              className="device-key"
              aria-pressed={on}
              aria-label={
                away.state === "mixed"
                  ? `Away on for ${away.on} of ${away.total}`
                  : on
                    ? "Away on"
                    : "Away off"
              }
              disabled={away.total === 0}
              onPointerDown={(event) => event.preventDefault()}
              onClick={() => {
                playKeyClick(away.next ? "down" : "up");
                away.toggle();
              }}
            />
          }
        >
          <MoonIcon aria-hidden="true" />
        </TooltipTrigger>
        <TooltipPopup side="bottom">{tooltip}</TooltipPopup>
      </Tooltip>
      {away.state === "mixed" ? (
        <span className="app-away-key__count" aria-hidden="true">
          {away.on}/{away.total}
        </span>
      ) : null}
    </span>
  );
}
