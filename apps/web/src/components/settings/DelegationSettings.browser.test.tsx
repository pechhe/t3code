import { act, type ReactNode } from "react";
import { createRoot, type Root } from "react-dom/client";
import { userEvent } from "vite-plus/test/browser";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import * as Schema from "effect/Schema";
import {
  DEFAULT_SERVER_SETTINGS,
  AgentPolicyManifest,
  AgentPolicySettingsError,
  EnvironmentId,
  type AgentPolicySettings,
} from "@t3tools/contracts";

const state = vi.hoisted(() => ({
  data: null as AgentPolicySettings | null,
  error: null as string | null,
  save: vi.fn(),
  refresh: vi.fn(),
}));
const { passthrough } = vi.hoisted(() => ({
  passthrough: ({ children }: { children?: ReactNode }) => children,
}));
vi.mock(import("@effect/atom-react"), async (original) => ({
  ...(await original()),
  useAtomValue: (() => true) as never,
}));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    configValueAtom: () => ({}),
    agentPolicyRead: () => ({}),
    agentPolicySave: { permissionAtom: () => ({}) },
  },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: state.data,
    isPending: false,
    error: state.error,
    refresh: state.refresh,
  }),
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => state.save,
}));
vi.mock("./SettingsScopeContext", () => ({
  useSettingsScope: () => ({
    environments: [
      { environmentId: "test-env", label: "Test Mac", connection: { phase: "connected" } },
    ],
  }),
}));
vi.mock("./useScopedSettings", () => ({
  useScopedSettings: (select: (settings: typeof DEFAULT_SERVER_SETTINGS) => unknown) =>
    select(DEFAULT_SERVER_SETTINGS),
  useUpdateScopedSettings: () => vi.fn(),
}));
vi.mock("./settingsLayout", () => ({
  SettingsPageContainer: passthrough,
  SettingsSection: passthrough,
  SettingsRow: () => null,
}));
vi.mock("../ui/collapsible", () => ({
  Collapsible: passthrough,
  CollapsibleTrigger: passthrough,
  CollapsiblePanel: passthrough,
}));
vi.mock("../ui/menu", () => ({
  Menu: () => null,
  MenuTrigger: passthrough,
  MenuPopup: passthrough,
  MenuItem: passthrough,
  MenuGroup: passthrough,
  MenuItemLabel: passthrough,
  MenuCheckboxItem: passthrough,
  MenuRadioGroup: passthrough,
  MenuRadioItem: passthrough,
  MenuRadioItemIndicator: passthrough,
  MenuGroupLabel: passthrough,
  MenuSeparator: passthrough,
  MenuShortcut: passthrough,
  MenuSub: passthrough,
  MenuSubTrigger: passthrough,
  MenuSubPopup: passthrough,
}));
// Role briefs render through the full markdown pipeline; these tests cover saving.
vi.mock("../ChatMarkdown", () => ({ default: ({ text }: { text: string }) => text }));
// Model chips and pickers read live provider catalogs; these tests cover saving.
vi.mock("../ModelLabel", () => ({
  ModelLabel: () => null,
}));
vi.mock("./PolicyModelPicker", () => ({
  PolicyModelPicker: () => null,
  PolicyEffortPicker: () => null,
}));
vi.mock("../ui/select", () => ({
  Select: () => null,
  SelectTrigger: passthrough,
  SelectValue: passthrough,
  SelectPopup: passthrough,
  SelectItem: passthrough,
}));

import { DelegationSettings, describeCheckout } from "./DelegationSettings";

const decodeManifest = Schema.decodeUnknownSync(AgentPolicyManifest);
function fixture(): AgentPolicySettings {
  const role = (name: string, list: string, extra: object = {}) => ({
    list,
    brief: `roles/${name}.md`,
    sourceAccess: "read-only",
    toolProfile: "source-reader",
    taskClasses: ["non-ui"],
    ...extra,
  });
  const writer = { sourceAccess: "scoped-write", toolProfile: "implementation" };
  const manifest = decodeManifest({
    version: 2,
    revision: "fixture.1",
    models: {
      sol: { driverKind: "codex", model: "gpt-test", effortOption: "reasoning" },
      opus: { driverKind: "claudeAgent", model: "claude-test", effortOption: "effort" },
    },
    lists: {
      workhorse: [
        { model: "sol", effort: "medium" },
        { model: "opus", effort: "high" },
      ],
      fast: [{ model: "sol", effort: "low" }],
    },
    roles: {
      "chore-worker": role("chore-worker", "fast", writer),
      "implementation-worker": role("implementation-worker", "workhorse", writer),
      "ui-worker": role("ui-worker", "workhorse", { ...writer, taskClasses: ["ui"] }),
      browser: role("browser", "fast", { toolProfile: "phi" }),
      "ui-verifier": role("ui-verifier", "fast", { toolProfile: "phi" }),
      advisor: role("advisor", "workhorse"),
      "ticket-reviewer": role("ticket-reviewer", "workhorse"),
      "spec-reviewer": role("spec-reviewer", "workhorse"),
    },
  });
  return {
    snapshot: {
      hash: "a".repeat(64),
      sourceRevision: manifest.revision,
      manifest,
      briefs: Object.fromEntries(
        Object.keys(manifest.roles).map((name) => [name, { hash: "b".repeat(64), text: "Brief" }]),
      ) as AgentPolicySettings["snapshot"]["briefs"],
    },
    sourceRoot: "/policy-fixture",
    uncommitted: false,
    providers: [],
  };
}

let root: Root;
let container: HTMLDivElement;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  state.data = fixture();
  state.error = null;
  state.save.mockReset();
  state.refresh.mockReset();
  state.save.mockResolvedValue(AsyncResult.success(state.data));
});
afterEach(async () => {
  await act(async () => root.unmount());
  container.remove();
  vi.unstubAllGlobals();
});
const mount = () => act(async () => root.render(<DelegationSettings />));
const buttons = (label: string) =>
  [...container.querySelectorAll("button")].filter(
    (button) => button.getAttribute("aria-label") === label || button.textContent === label,
  );
const button = (label: string) => buttons(label)[0]!;
const click = (label: string) => act(async () => userEvent.click(button(label)));
const text = () => container.textContent ?? "";

it("saves a reordered list against the loaded revision without touching the loaded policy", async () => {
  await mount();
  await click("Move claude-test up");
  await click("Save");
  expect(state.save).toHaveBeenCalledWith({
    environmentId: EnvironmentId.make("test-env"),
    input: {
      expectedHash: "a".repeat(64),
      manifest: expect.objectContaining({
        lists: expect.objectContaining({
          workhorse: [
            { model: "opus", effort: "high" },
            { model: "sol", effort: "medium" },
          ],
        }),
      }),
    },
  });
  expect(state.data!.snapshot.manifest.lists["workhorse"]?.[0]?.model).toBe("sol");
  expect(state.refresh).toHaveBeenCalledOnce();
});

it("reports a stale save, reloads the current policy and does not retry", async () => {
  state.save.mockResolvedValue(
    AsyncResult.failure(Cause.fail(new AgentPolicySettingsError({ reason: "stale" }))),
  );
  await mount();
  await click("Move claude-test up");
  await click("Save");
  expect(text()).toContain("policy changed on disk");
  expect(state.refresh).toHaveBeenCalledOnce();
  expect(state.save).toHaveBeenCalledOnce();
});

it("a job without models cannot be saved, and discarding restores it", async () => {
  await mount();
  // The chore job's list holds only gpt-test; the shared workhorse list keeps a model.
  await act(async () => userEvent.click(buttons("Remove gpt-test").at(-1)!));
  expect(button("Save").disabled).toBe(true);
  await click("Discard");
  expect(buttons("Save")).toHaveLength(0);
});

it("describes an unreadable agent-config checkout as unknown, never up to date", () => {
  expect(describeCheckout({ revision: null, hasLocalChanges: null, behindMain: null })).toBe(
    "agent-config unknown · unlanded changes unknown · behind main unknown",
  );
  expect(
    describeCheckout({ revision: "286cf1056a2b9f00", hasLocalChanges: true, behindMain: 3 }),
  ).toBe("agent-config 286cf1056a2b · unlanded changes · 3 behind main");
});

it("shows the checkout as unknown when the policy cannot be read", async () => {
  state.data = null;
  state.error = "Could not read the delegation policy.";
  await mount();
  expect(text()).toContain("agent-config unknown");
  expect(text()).not.toContain("up to date");
});
