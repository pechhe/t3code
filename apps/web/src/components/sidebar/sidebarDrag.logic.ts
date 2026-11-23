import type { SidebarSection } from "../Sidebar.logic";

// Working rows have no lifecycle drop; they only drag out as context.
export function isWorkingRowDrag(section: SidebarSection | undefined) {
  return section === "working" || section === "landing";
}
