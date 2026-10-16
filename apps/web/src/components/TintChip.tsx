import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import type { ProjectIconColor } from "@t3tools/contracts";
import type * as React from "react";

import { cn } from "~/lib/utils";

export interface TintChipProps extends useRender.ComponentProps<"span"> {
  /** The palette colour the chip is tinted with, or any CSS colour, such as a theme's accent. */
  tint: ProjectIconColor | { color: string };
  icon: React.ReactNode;
  label: React.ReactNode;
  /**
   * In a row of choices, `true` marks the chosen chip with a deeper tint and a solid edge and
   * `false` fades the others back. Leave unset for a chip that only labels something.
   */
  selected?: boolean | undefined;
}

/**
 * A small pill tinted with one palette colour, holding an icon and a name, as in peach-pi.
 * Projects and subagent roles wear it. Renders a span by default; render it as a button to
 * make it a choice.
 */
export function TintChip({
  tint,
  icon,
  label,
  selected,
  className,
  style,
  render,
  children,
  ...props
}: TintChipProps) {
  const defaultProps = {
    className: cn(
      "inline-flex h-5 min-w-0 max-w-full shrink items-center gap-1 rounded-md border px-1.5 font-semibold text-2xs leading-none",
      "border-(--tint-chip-border) bg-(--tint-chip-fill) text-(--tint-chip-ink)",
      "[button&]:cursor-pointer [button&]:transition-[filter,opacity,background-color,border-color] [button&]:hover:brightness-95 dark:[button&]:hover:brightness-110 motion-reduce:transition-none",
      "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
      selected === false && "opacity-60 saturate-50 [button&]:hover:opacity-100",
      className,
    ),
    style: {
      "--tint-chip-accent": typeof tint === "string" ? `var(--color-${tint}-500)` : tint.color,
      "--tint-chip-fill": `color-mix(in oklab, var(--tint-chip-accent) ${selected ? 38 : 24}%, transparent)`,
      "--tint-chip-border": `color-mix(in oklab, var(--tint-chip-accent) ${selected ? 90 : 45}%, transparent)`,
      "--tint-chip-ink": "color-mix(in oklab, var(--tint-chip-accent) 35%, var(--foreground))",
      ...style,
    } as React.CSSProperties,
    "data-selected": selected ? "" : undefined,
    children: (
      <>
        {icon}
        <span className="min-w-0 truncate">{label}</span>
        {children}
      </>
    ),
  };
  return useRender({
    defaultTagName: "span",
    props: mergeProps<"span">(defaultProps, props),
    render,
  });
}
