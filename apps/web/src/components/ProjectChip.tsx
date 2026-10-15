import type { ProjectIconColor } from "@t3tools/contracts";

import { deriveProjectIdentity } from "../projectIdentity";
import { ProjectFavicon, type ProjectFaviconProject } from "./ProjectFavicon";
import { TintChip, type TintChipProps } from "./TintChip";

/** The colour a project wears: its chosen icon colour, else the one its name generates. */
export function projectTintColor(project: ProjectFaviconProject): ProjectIconColor {
  const icon = project.projectIcon;
  if (icon && (icon.kind === "monogram" || icon.kind === "lucide")) return icon.color;
  return deriveProjectIdentity(project.title).color;
}

interface ProjectChipProps extends Omit<TintChipProps, "tint" | "icon" | "label"> {
  project: ProjectFaviconProject;
  /** The name to show, such as a logical project's display name. Defaults to the title. */
  label?: string | undefined;
}

/**
 * A project shown as a chip in its own colour. Used wherever a project labels something
 * else (a thread row, the header, a palette subtitle) and as the project choices on the
 * new-thread screen.
 */
export function ProjectChip({ project, label, ...props }: ProjectChipProps) {
  return (
    <TintChip
      data-slot="project-chip"
      tint={projectTintColor(project)}
      icon={<ProjectFavicon project={project} className="size-3 shrink-0" />}
      label={label ?? project.title}
      {...props}
    />
  );
}
