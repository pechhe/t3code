import { mergeProps } from "@base-ui/react/merge-props";
import { useRender } from "@base-ui/react/use-render";
import type { ProjectIconColor } from "@t3tools/contracts";
import type * as React from "react";

import { cn } from "~/lib/utils";
import { deriveProjectIdentity } from "../projectIdentity";
import { ProjectFavicon, type ProjectFaviconProject } from "./ProjectFavicon";

/** The colour a project wears: its chosen icon colour, else the one its name generates. */
export function projectTintColor(project: ProjectFaviconProject): ProjectIconColor {
  const icon = project.projectIcon;
  if (icon && (icon.kind === "monogram" || icon.kind === "lucide")) return icon.color;
  return deriveProjectIdentity(project.title).color;
}

interface ProjectChipProps extends useRender.ComponentProps<"span"> {
  project: ProjectFaviconProject;
  /** The name to show, such as a logical project's display name. Defaults to the title. */
  label?: string | undefined;
  /** Marks the chosen chip in a row of them with a ring. */
  selected?: boolean | undefined;
}

/**
 * A project shown as a small pill tinted with the project's own colour, with its icon and
 * name, as in peach-pi. Used wherever a project labels something else (a thread row, the
 * header, a palette subtitle) and as the project choices on the new-thread screen.
 *
 * Renders a span by default; render it as a button to make it a choice.
 */
export function ProjectChip({
  project,
  label,
  selected,
  className,
  style,
  render,
  children,
  ...props
}: ProjectChipProps) {
  const defaultProps = {
    className: cn(
      "inline-flex h-5 min-w-0 max-w-full shrink items-center gap-1 rounded-md border px-1.5 font-semibold text-2xs leading-none",
      "border-(--project-chip-border) bg-(--project-chip-fill) text-(--project-chip-ink)",
      "[button&]:cursor-pointer [button&]:transition-[filter,box-shadow] [button&]:hover:brightness-95 dark:[button&]:hover:brightness-110 motion-reduce:transition-none",
      "focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-ring",
      selected && "ring-2 ring-inset ring-foreground/75",
      className,
    ),
    style: {
      "--project-chip-accent": `var(--color-${projectTintColor(project)}-500)`,
      "--project-chip-fill": "color-mix(in oklab, var(--project-chip-accent) 24%, transparent)",
      "--project-chip-border": "color-mix(in oklab, var(--project-chip-accent) 45%, transparent)",
      "--project-chip-ink": "color-mix(in oklab, var(--project-chip-accent) 35%, var(--foreground))",
      ...style,
    } as React.CSSProperties,
    "data-slot": "project-chip",
    "data-selected": selected ? "" : undefined,
    children: (
      <>
        <ProjectFavicon project={project} className="size-3 shrink-0" />
        <span className="min-w-0 truncate">{label ?? project.title}</span>
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
