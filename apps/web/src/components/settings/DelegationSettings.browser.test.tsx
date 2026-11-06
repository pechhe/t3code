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
  // Other environments' policies, by id; each reads as `data` unless listed here.
  extra: {} as Record<string, AgentPolicySettings>,
  unreadable: new Set<string>(),
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
vi.mock("./useAgentPolicies", () => ({
  useAgentPolicies: (ids: string[]) => ({
    policies: ids.map((environmentId) => ({
      environmentId,
      canEdit: true,
      data: state.unreadable.has(environmentId)
        ? null
        : environmentId === "test-env"
          ? state.data
          : (state.extra[environmentId] ?? state.data),
      error: state.unreadable.has(environmentId) ? "Could not read the policy." : state.error,
      isPending: false,
    })),
    reload: state.refresh,
  }),
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: () => state.save,
}));
const scope = vi.hoisted(() => ({
  environments: [
    { environmentId: "test-env", label: "Test Mac", connection: { phase: "connected" } },
  ],
}));
vi.mock("./SettingsScopeContext", () => ({
  useSettingsScope: () => ({
    environments: scope.environments,
    environment: scope.environments[0],
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
      reviewer: { ...role("reviewer", "workhorse"), specList: "workhorse" },
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
  state.extra = {};
  state.unreadable.clear();
  scope.environments.length = 1;
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

const addEnvironment = (policy: AgentPolicySettings) => {
  scope.environments.push({
    environmentId: "other-env",
    label: "Other Box",
    connection: { phase: "connected" },
  });
  state.extra["other-env"] = policy;
};

it("saves one policy to every selected environment against each one's own revision", async () => {
  const base = fixture();
  addEnvironment({ ...base, snapshot: { ...base.snapshot, hash: "c".repeat(64) } });
  await mount();
  expect(text().match(/Implementer/g)).toHaveLength(1);
  await click("Move claude-test up");
  await click("Save");
  expect(
    state.save.mock.calls.map(([call]) => [call.environmentId, call.input.expectedHash]),
  ).toEqual([
    [EnvironmentId.make("test-env"), "a".repeat(64)],
    [EnvironmentId.make("other-env"), "c".repeat(64)],
  ]);
});

it("says when the selected environments hold different policies", async () => {
  const base = fixture();
  addEnvironment({
    ...base,
    snapshot: {
      ...base.snapshot,
      manifest: decodeManifest({ ...base.snapshot.manifest, revision: "fixture.2" }),
    },
  });
  await mount();
  expect(text()).toContain("Policies differ across Test Mac, Other Box");
});

it("names the environment whose save failed", async () => {
  addEnvironment(fixture());
  state.save
    .mockResolvedValueOnce(AsyncResult.success(state.data))
    .mockResolvedValueOnce(
      AsyncResult.failure(Cause.fail(new AgentPolicySettingsError({ reason: "stale" }))),
    );
  await mount();
  await click("Move claude-test up");
  await click("Save");
  expect(text()).toContain("Other Box:");
});

it("cannot save to all environments while one has no readable policy", async () => {
  addEnvironment(fixture());
  state.unreadable.add("other-env");
  await mount();
  expect(text()).toContain("Other Box: Could not read");
  await click("Move claude-test up");
  expect(button("Save").disabled).toBe(true);
});

const separateReviewerLists = () => {
  const policy = fixture();
  const manifest = policy.snapshot.manifest;
  state.data = {
    ...policy,
    snapshot: {
      ...policy.snapshot,
      manifest: {
        ...manifest,
        lists: {
          ...manifest.lists,
          "reviewer-spec": [
            { model: "sol", effort: "low" },
            { model: "opus", effort: "low" },
          ],
        },
        roles: {
          ...manifest.roles,
          reviewer: { ...manifest.roles.reviewer, specList: "reviewer-spec" },
        },
      },
    },
  };
  return manifest;
};

it("shows the Reviewer with a change list and a Spec list, each editable", async () => {
  separateReviewerLists();
  await mount();
  for (const phrase of [
    "Change reviews",
    "A chore or other work with no Spec",
    "Spec reviews",
    "The integrated outcome of a Spec",
    "The lead states on each review task whether it is reviewing a change or a Spec.",
  ]) {
    expect(text().split(phrase)).toHaveLength(phrase.endsWith("reviews") ? 3 : 2);
  }
  expect(text().match(/Prefer a\s*different provider/g)).toHaveLength(1);
  expect(text()).not.toContain("Different model for large tasks");
});

it("saves a Spec list edit without touching the change list", async () => {
  const manifest = separateReviewerLists();
  await mount();
  // Shared job, then the Reviewer's change list and Spec list.
  await act(async () => userEvent.click(buttons("Move gpt-test down")[2]!));
  await click("Save");
  expect(state.save).toHaveBeenCalledWith(
    expect.objectContaining({
      input: expect.objectContaining({
        manifest: expect.objectContaining({
          lists: expect.objectContaining({
            "reviewer-spec": [
              { model: "opus", effort: "low" },
              { model: "sol", effort: "low" },
            ],
            workhorse: manifest.lists["workhorse"],
          }),
        }),
      }),
    }),
  );
});

it("does not warn when a first choice is unavailable", async () => {
  await mount();
  expect(text()).not.toContain("will be refused");
  expect(text()).not.toContain("will use");
});

const councilSwitch = () =>
  container.querySelector<HTMLElement>('[aria-label="Council for Spec reviews"]')!;

it("shows the council Off for a policy without it, and turning it On saves council true", async () => {
  separateReviewerLists();
  await mount();
  expect(councilSwitch().getAttribute("aria-checked")).toBe("false");
  expect(text()).not.toContain("council on");
  await act(async () => councilSwitch().click());
  expect(councilSwitch().getAttribute("aria-checked")).toBe("true");
  expect(text()).toContain("council on");
  expect(text()).toMatch(/makers? can sit now/);
  expect(text()).toContain("OpenAI");
  expect(text()).toContain("Anthropic");
  await click("Save");
  expect(state.save).toHaveBeenCalledWith(
    expect.objectContaining({
      input: expect.objectContaining({
        manifest: expect.objectContaining({
          roles: expect.objectContaining({
            reviewer: expect.objectContaining({ council: true }),
          }),
        }),
      }),
    }),
  );
});

it("cannot save a council whose Spec list has fewer than two makers", async () => {
  separateReviewerLists();
  await mount();
  await act(async () => councilSwitch().click());
  await act(async () => userEvent.click(buttons("Remove claude-test").at(-1)!));
  expect(text()).toContain("at least two makers");
  expect(button("Save").disabled).toBe(true);
  await act(async () => councilSwitch().click());
  expect(text()).not.toContain("at least two makers");
  expect(button("Save").disabled).toBe(false);
});

it("turning the council Off removes the key from what is saved", async () => {
  separateReviewerLists();
  const policy = state.data!;
  const manifest = policy.snapshot.manifest;
  state.data = {
    ...policy,
    snapshot: {
      ...policy.snapshot,
      manifest: {
        ...manifest,
        roles: { ...manifest.roles, reviewer: { ...manifest.roles.reviewer, council: true } },
      },
    },
  };
  await mount();
  expect(councilSwitch().getAttribute("aria-checked")).toBe("true");
  await act(async () => councilSwitch().click());
  await click("Save");
  const saved = state.save.mock.calls[0]![0].input.manifest;
  expect("council" in saved.roles.reviewer).toBe(false);
});
