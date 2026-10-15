import { createFileRoute, redirect } from "@tanstack/react-router";

import { ScheduledTasksSettings } from "../components/settings/ScheduledTasksSettings";
import { SettingsScopeProvider } from "../components/settings/SettingsScopeContext";
import { validateScheduledTasksSearch } from "../components/settings/scheduledTasksSettings.logic";
import { validateSettingsRouteSearch } from "../components/settings/settingsScopeNavigation";
import { SidebarInset } from "../components/ui/sidebar";
import { WorkspaceBreadcrumb, WorkspaceBreadcrumbItem } from "../components/WorkspaceBreadcrumb";
import { WorkspacePageHeader } from "../components/WorkspacePageHeader";
import { isElectron } from "../env";
import { useEscapeToGoBack } from "../hooks/useNavigateBack";

/**
 * Scheduled tasks across every connected machine. It lives beside Usage and Pull requests
 * rather than in Settings because tasks run and produce threads; they are not preferences.
 * The project and machine filters reuse the settings scope.
 */
function ScheduledRoute() {
  useEscapeToGoBack();
  const search = Route.useSearch();
  const navigate = Route.useNavigate();
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
        <SettingsScopeProvider
          search={search}
          // A new filter drops the linked task, which may not be in it.
          onChange={(next) =>
            void navigate({
              search: () => ({
                project: next.project,
                machine: next.machine,
                checkout: next.checkout,
              }),
              resetScroll: false,
            })
          }
        >
          <div className="min-h-0 flex flex-1 flex-col">
            <ScheduledTasksSettings
              {...(search.environmentId ? { environmentId: search.environmentId } : {})}
              taskId={search.taskId}
            />
          </div>
        </SettingsScopeProvider>
      </div>
    </SidebarInset>
  );
}

export const Route = createFileRoute("/scheduled")({
  validateSearch: (raw: Record<string, unknown>) => ({
    ...validateSettingsRouteSearch(raw),
    ...validateScheduledTasksSearch(raw),
  }),
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
