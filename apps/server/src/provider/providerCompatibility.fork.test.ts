import { assert, describe, it } from "@effect/vitest";
import { ProviderDriverKind, ProviderInstanceId, type ServerProvider } from "@t3tools/contracts";

import {
  applyProviderCompatibility,
  type ProviderCompatibilityPolicy,
} from "./providerCompatibility.ts";

const driver = ProviderDriverKind.make("pi");
const policy: ProviderCompatibilityPolicy = {
  driver,
  t3CodeRange: ">=0.0.0",
  ranges: [
    { range: "<1.4.0", status: "broken" },
    { range: ">=1.4.0", status: "supported" },
  ],
};
// Pi-Bolt 1.3.0 bundles Pi core 1.5.2; its 1.3.1 release says nothing about the core it carries.
const provider: ServerProvider = {
  driver,
  instanceId: ProviderInstanceId.make("pi"),
  enabled: true,
  installed: true,
  version: "1.5.2",
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-11-22T00:00:00Z",
  models: [],
  slashCommands: [],
  skills: [],
  versionAdvisory: {
    status: "behind_latest",
    currentVersion: "1.3.0",
    latestVersion: "1.3.1",
    updateCommand: "pi-bolt update --all",
    canUpdate: true,
    checkedAt: null,
    message: null,
  },
};

describe("applyProviderCompatibility with a wrapper's versions", () => {
  it("rates the latest release only when the advisory tracks the runtime", () => {
    const rated = applyProviderCompatibility(provider, [], [policy]);
    assert.strictEqual(rated.compatibilityAdvisory?.latestVersionStatus, "broken");

    const wrapper = applyProviderCompatibility(
      { ...provider, versionAdvisory: { ...provider.versionAdvisory!, tracksRuntime: false } },
      [],
      [policy],
    );
    assert.strictEqual(wrapper.compatibilityAdvisory?.status, "supported");
    assert.isUndefined(wrapper.compatibilityAdvisory?.latestVersionStatus);
  });
});
