import {
  AgentBrowserBackends,
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ServerSettings,
  ServerSettingsPatch,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { describe, expect, it } from "vite-plus/test";

import { AGENT_BROWSER_BACKEND_CHOICES, agentBrowserBackendChoiceId } from "./browserBackend.ts";
import { resolveProjectSettings } from "./projectSettings.ts";
import { applyServerSettingsPatch } from "./serverSettings.ts";

const decodeSettings = Schema.decodeUnknownSync(ServerSettings);
const decodePatch = Schema.decodeUnknownSync(ServerSettingsPatch);
const isBackends = Schema.is(AgentBrowserBackends);

const projectId = ProjectId.make("phi-project");

describe("agent browser backend settings", () => {
  it("keeps integrated browsing for existing settings documents", () => {
    const settings = decodeSettings({});
    expect(settings.agentBrowserBackends).toEqual({
      enabled: ["integrated"],
      default: "integrated",
    });
    expect(settings.enableAgentBrowserAccess).toBe(true);
    expect(settings.phiBrowserSkillDirectory).toBe("");
  });

  it("rejects a disabled default, empty choices and duplicate backends", () => {
    for (const value of [
      { enabled: ["integrated"], default: "phi" },
      { enabled: [], default: "phi" },
      { enabled: ["phi", "phi"], default: "phi" },
    ])
      expect(isBackends(value)).toBe(false);
    expect(isBackends({ enabled: ["integrated", "phi"], default: "phi" })).toBe(true);
  });

  it("applies and resets one project selection through the existing precedence", () => {
    const patch = decodePatch({
      agentBrowserBackends: { enabled: ["integrated", "phi"], default: "phi" },
      projectSettingsOverrides: {
        [projectId]: { agentBrowserBackends: { enabled: ["integrated"], default: "integrated" } },
      },
    });
    const settings = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, patch);
    const project = resolveProjectSettings(settings, projectId);
    expect(project.settings.agentBrowserBackends.default).toBe("integrated");
    expect(project.sources.agentBrowserBackends).toBe("project");
    expect(resolveProjectSettings(settings, null).settings.agentBrowserBackends.default).toBe(
      "phi",
    );
    const reset = applyServerSettingsPatch(settings, {
      projectSettingsOverrides: { [projectId]: null },
    });
    expect(resolveProjectSettings(reset, projectId).settings.agentBrowserBackends.default).toBe(
      "phi",
    );
  });

  it("does not grant browser access by enabling Phi", () => {
    const settings = applyServerSettingsPatch(DEFAULT_SERVER_SETTINGS, {
      enableAgentBrowserAccess: false,
      agentBrowserBackends: { enabled: ["phi"], default: "phi" },
    });
    expect(resolveProjectSettings(settings, projectId).settings.enableAgentBrowserAccess).toBe(
      false,
    );
  });
});

describe("agent browser backend choices", () => {
  it("round-trips every choice through the contract schema", () => {
    for (const choice of AGENT_BROWSER_BACKEND_CHOICES) {
      expect(isBackends(choice.value)).toBe(true);
      expect(agentBrowserBackendChoiceId(choice.value)).toBe(choice.id);
    }
  });
});
