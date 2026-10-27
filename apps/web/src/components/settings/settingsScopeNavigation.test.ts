import { EnvironmentId, ProjectId } from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import { defaultSettingsProjectKey } from "./settingsScopeNavigation";

describe("defaultSettingsProjectKey", () => {
  const local = EnvironmentId.make("local");
  const remote = EnvironmentId.make("remote");
  const groups = [
    {
      projectKey: "alpha",
      memberProjectRefs: [{ environmentId: local, projectId: ProjectId.make("a") }],
    },
    {
      projectKey: "beta",
      memberProjectRefs: [
        { environmentId: local, projectId: ProjectId.make("b") },
        { environmentId: remote, projectId: ProjectId.make("b-remote") },
      ],
    },
  ];

  it("opens the group holding the current project on any of its environments", () => {
    expect(
      defaultSettingsProjectKey(groups, {
        environmentId: remote,
        projectId: ProjectId.make("b-remote"),
      }),
    ).toBe("beta");
  });

  it("falls back to the first project when there is no current one or it is gone", () => {
    expect(defaultSettingsProjectKey(groups, null)).toBe("alpha");
    expect(
      defaultSettingsProjectKey(groups, {
        environmentId: local,
        projectId: ProjectId.make("gone"),
      }),
    ).toBe("alpha");
    expect(defaultSettingsProjectKey([], null)).toBeNull();
  });
});
