import { EnvironmentId } from "@t3tools/contracts";

import { ProjectSettingsPanel } from "./ProjectSettingsPanel";
import { useSettingsScope } from "./SettingsScopeContext";
import { SettingsScopeNotice } from "./SettingsScopeNotice";
import { SettingsPageContainer } from "./settingsLayout";

export function ProjectsSettings() {
  const { search: value, scope, groups } = useSettingsScope();
  const projectScope =
    scope.kind === "project" ||
    scope.kind === "checkout" ||
    (scope.kind === "unavailable" &&
      (scope.reason === "project-missing" || scope.reason === "checkout-missing"));
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      {value.project && projectScope ? (
        <ProjectSettingsPanel
          projectKey={value.project}
          environmentId={value.machine ? EnvironmentId.make(value.machine) : null}
          checkoutKey={value.checkout ?? null}
        />
      ) : scope.kind === "unavailable" ? (
        <SettingsPageContainer>
          <p className="text-sm text-muted-foreground">{scope.message}</p>
        </SettingsPageContainer>
      ) : groups.length === 0 ? (
        <SettingsPageContainer>
          <p className="text-sm text-muted-foreground">
            Add a project from the sidebar to manage its settings here.
          </p>
        </SettingsPageContainer>
      ) : (
        <SettingsScopeNotice target="project">
          Choose a project to manage its name, icon, checkouts and actions.
        </SettingsScopeNotice>
      )}
    </div>
  );
}
