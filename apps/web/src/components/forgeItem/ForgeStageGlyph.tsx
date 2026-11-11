import type { ForgeHomeLandingStage } from "@t3tools/contracts";

import { cn } from "~/lib/utils";
import { forgeStageGlyph } from "./ForgeHomeButton.logic";

const TONE = {
  teal: "text-teal-600 dark:text-teal-300/90",
  amber: "text-warning",
  green: "text-success",
} as const;

/** The inner disc's slice from twelve o'clock, clockwise, for a part fill. */
const slice = (fill: number) => {
  const angle = fill * 2 * Math.PI;
  const x = 8 + 3.5 * Math.sin(angle);
  const y = 8 - 3.5 * Math.cos(angle);
  return `M8 8 L8 4.5 A3.5 3.5 0 ${fill > 0.5 ? 1 : 0} 1 ${x.toFixed(3)} ${y.toFixed(3)} Z`;
};

/**
 * A delivery stage as Weave's Forge draws it (`BuildStatusIcon`): a ring whose inner disc fills as
 * work moves on. Decorative: the stage's label is printed beside it.
 */
export function ForgeStageGlyph({
  stage,
  className,
}: {
  stage: ForgeHomeLandingStage;
  className?: string;
}) {
  const glyph = forgeStageGlyph(stage);
  const tick = glyph.tick ? (
    <path
      d={glyph.ring === "halo" ? "M6.05 8.1 7.4 9.4 9.95 6.7" : "M5 8.25 7.1 10.25 11 6"}
      fill="none"
      className="stroke-background"
      strokeWidth={glyph.ring === "halo" ? 1.4 : 1.6}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  ) : null;
  return (
    <svg
      viewBox="0 0 16 16"
      aria-hidden
      data-stage={stage}
      className={cn("size-3.5 shrink-0", TONE[glyph.tone], className)}
    >
      {glyph.ring === "halo" ? (
        <>
          <circle cx="8" cy="8" r="7.1" fill="none" stroke="currentColor" strokeWidth="1.3" />
          <circle cx="8" cy="8" r="4.6" fill="currentColor" />
          {tick}
        </>
      ) : glyph.fill === 1 ? (
        <>
          <circle cx="8" cy="8" r="7" fill="currentColor" />
          {tick}
        </>
      ) : (
        <>
          <circle cx="8" cy="8" r="6.25" fill="none" stroke="currentColor" strokeWidth="1.5" />
          <path d={slice(glyph.fill)} fill="currentColor" />
        </>
      )}
    </svg>
  );
}
