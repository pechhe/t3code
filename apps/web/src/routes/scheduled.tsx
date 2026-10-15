import { createFileRoute, redirect } from "@tanstack/react-router";

import { ScheduledTasksPage } from "../components/scheduled/ScheduledTasksPage";
import { validateScheduledTasksSearch } from "../components/scheduled/scheduledTasks.logic";
import { SidebarInset } from "../components/ui/sidebar";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../components/WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { isElectron } from "../env";
import { useEscapeToGoBack } from "../hooks/useNavigateBack";

/**
 * Scheduled tasks across every connected machine. It lives beside Usage and Pull requests
 * rather than in Settings because tasks run and produce threads; they are not preferences.
 */
function ScheduledRoute() {
  useEscapeToGoBack();
  const search = Route.useSearch();
  return (
    <SidebarInset className="h-dvh min-h-0 overflow-hidden overscroll-y-none isolate">
      <div className="flex min-h-0 min-w-0 flex-1 flex-col bg-background text-foreground">
        <WorkspacePageHeader electron={isElectron}>
          <WorkspaceBreadcrumb ariaLabel="Scheduled breadcrumb" className="min-w-0 py-2">
            <WorkspaceBreadcrumbItem>
              <h1>Scheduled</h1>
            </WorkspaceBreadcrumbItem>
          </WorkspaceBreadcrumb>
        </WorkspacePageHeader>
        <ScheduledTasksPage environmentId={search.environmentId} taskId={search.taskId} />
      </div>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/scheduled")({
  validateSearch: (raw: Record<string, unknown>) => validateScheduledTasksSearch(raw),
  beforeLoad: async ({ context }) => {
    if (
      context.authGateState.status !== "authenticated" &&
      context.authGateState.status !== "hosted-static"
    ) {
      throw redirect({ to: "/pair", replace: true });
    }
  },
  component: ScheduledRoute,
});
