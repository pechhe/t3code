import {
  DEFAULT_SERVER_SETTINGS,
  ProjectId,
  ServerSettings,
  ServerSettingsPatch,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { expect, it } from "vite-plus/test";
import { resolveProjectSettings } from "./projectSettings.ts";
import { applyServerSettingsPatch } from "./serverSettings.ts";

const decode = Schema.decodeUnknownSync(ServerSettings);
const decodePatch = Schema.decodeUnknownSync(ServerSettingsPatch);
const project = ProjectId.make("configured-preview");
const other = ProjectId.make("other-preview");
const signIn = { path: "/dev/agent-login?as={persona}&next={next}", defaultPersona: "admin" };

it("inherits, overrides and disables automatic sign-in per project without changing the environment default", () => {
  expect(decode({}).agentBrowserSignIn).toBeNull();
  const environment = applyServerSettingsPatch(
    DEFAULT_SERVER_SETTINGS,
    decodePatch({ agentBrowserSignIn: signIn }),
  );
  const overridden = applyServerSettingsPatch(
    environment,
    decodePatch({
      projectSettingsOverrides: {
        [project]: { agentBrowserSignIn: { ...signIn, defaultPersona: " planner " } },
        [other]: { agentBrowserSignIn: null },
      },
    }),
  );
  const settings = decode(Schema.encodeSync(ServerSettings)(overridden));
  expect(resolveProjectSettings(settings, project).settings.agentBrowserSignIn).toEqual({
    ...signIn,
    defaultPersona: "planner",
  });
  expect(resolveProjectSettings(settings, other).settings.agentBrowserSignIn).toBeNull();
  expect(
    resolveProjectSettings(settings, ProjectId.make("unconfigured")).settings.agentBrowserSignIn,
  ).toEqual(signIn);
});

it.each(["https://example.com/", "//example.com/", "/\\example.com/", "dev/login"])(
  "rejects a non-local sign-in path %s",
  (path) => expect(() => decodePatch({ agentBrowserSignIn: { ...signIn, path } })).toThrow(),
);
