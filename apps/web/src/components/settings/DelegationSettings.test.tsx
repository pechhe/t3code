import { act, type ReactNode } from "react";
import { create, type ReactTestRenderer } from "react-test-renderer";
import { afterEach, beforeEach, expect, it, vi } from "vite-plus/test";
import * as Cause from "effect/Cause";
import { AsyncResult } from "effect/reactivity";
import * as Schema from "effect/Schema";
import {
  AgentPolicyManifest,
  AgentPolicySettingsError,
  EnvironmentId,
  ServerProvider,
  type AgentPolicySettings,
} from "@t3tools/contracts";

const state = vi.hoisted(() => ({
  data: null as AgentPolicySettings | null,
  save: vi.fn(),
  preview: vi.fn(),
  refresh: vi.fn(),
  canEdit: true,
}));
vi.mock("@effect/atom-react", () => ({ useAtomValue: () => state.canEdit }));
vi.mock("../../state/server", () => ({
  serverEnvironment: {
    configValueAtom: () => ({}),
    agentPolicyRead: () => ({}),
    agentPolicySave: { kind: "save", permissionAtom: () => ({}) },
    agentPolicyPreview: { kind: "preview" },
  },
}));
vi.mock("../../state/query", () => ({
  useEnvironmentQuery: () => ({
    data: state.data,
    isPending: false,
    error: null,
    refresh: state.refresh,
  }),
}));
vi.mock("../../state/use-atom-command", () => ({
  useAtomCommand: (command: { kind: string }) =>
    command.kind === "save" ? state.save : state.preview,
}));
vi.mock("./SettingsScopeContext", () => ({
  useSettingsScope: () => ({
    environments: [
      { environmentId: "test-env", label: "Test Mac", connection: { phase: "connected" } },
    ],
  }),
}));
vi.mock("./settingsLayout", () => ({
  SettingsPageContainer: ({ children }: { children: ReactNode }) => <main>{children}</main>,
  SettingsSection: ({
    children,
    title,
    headerAction,
  }: {
    children: ReactNode;
    title: string;
    headerAction: ReactNode;
  }) => (
    <section>
      <h2>{title}</h2>
      {headerAction}
      {children}
    </section>
  ),
}));
vi.mock("../ui/select", () => ({
  Select: ({
    children,
    value,
    onValueChange,
  }: {
    children: ReactNode;
    value: string;
    onValueChange: (value: string) => void;
  }) => (
    <select value={value} onChange={(event) => onValueChange(event.target.value)}>
      {children}
    </select>
  ),
  SelectTrigger: ({
    children,
    "aria-label": label,
  }: {
    children: ReactNode;
    "aria-label": string;
  }) => <span aria-label={label}>{children}</span>,
  SelectValue: ({ children }: { children: ReactNode }) => <span>{children}</span>,
  SelectPopup: ({ children }: { children: ReactNode }) => <>{children}</>,
  SelectItem: ({ children, value }: { children: ReactNode; value: string }) => (
    <option value={value}>{children}</option>
  ),
}));
vi.mock("../ui/checkbox", () => ({
  Checkbox: ({
    checked,
    onCheckedChange,
  }: {
    checked: boolean;
    onCheckedChange: (checked: boolean) => void;
  }) => (
    <input
      type="checkbox"
      checked={checked}
      onChange={(event) => onCheckedChange(event.target.checked)}
    />
  ),
}));

import { DelegationSettings } from "./DelegationSettings";
const decodeManifest = Schema.decodeUnknownSync(AgentPolicyManifest);
const decodeProvider = Schema.decodeUnknownSync(ServerProvider);

function fixture(): AgentPolicySettings {
  const role = (
    name: string,
    pool: string,
    sourceAccess: string,
    toolProfile: string,
    taskClasses: string[] = ["non-ui"],
  ) => ({
    pool,
    brief: `roles/${name}.md`,
    sourceAccess,
    toolProfile,
    taskClasses,
    restrictions: {},
    effort: {
      [pool === "ui" || pool === "advisor" ? "opus" : "sol"]: {
        default: "medium",
        demanding: "high",
      },
    },
  });
  const manifest = decodeManifest({
    version: 1,
    revision: "fixture.1",
    models: {
      sol: { driverKind: "codex", model: "gpt-test", effortOption: "reasoning" },
      opus: { driverKind: "claudeAgent", model: "claude-test", effortOption: "effort" },
    },
    pools: Object.fromEntries(
      ["fast", "workhorse", "ui", "advisor"].map((pool) => {
        const alias = pool === "ui" || pool === "advisor" ? "opus" : "sol";
        return [pool, { allow: [alias], prefer: [alias], crossProvider: true }];
      }),
    ),
    roles: {
      "chore-worker": role("chore-worker", "fast", "scoped-write", "implementation"),
      "implementation-worker": role(
        "implementation-worker",
        "workhorse",
        "scoped-write",
        "implementation",
      ),
      "ui-worker": role("ui-worker", "ui", "scoped-write", "implementation", ["ui", "mixed"]),
      browser: role("browser", "fast", "read-only", "phi", ["ui"]),
      "ui-verifier": role("ui-verifier", "fast", "read-only", "phi", ["ui"]),
      advisor: role("advisor", "advisor", "read-only", "source-reader"),
      reviewer: role("reviewer", "workhorse", "read-only", "source-reader"),
    },
  });
  return {
    snapshot: {
      hash: "a".repeat(64),
      sourceRevision: manifest.revision,
      manifest,
      briefs: Object.fromEntries(
        Object.keys(manifest.roles).map((name) => [
          name,
          { hash: "b".repeat(64), text: "Read-only role brief" },
        ]),
      ) as AgentPolicySettings["snapshot"]["briefs"],
    },
    sourceRoot: "/policy-fixture",
    uncommitted: false,
    providers: [],
  };
}
let renderer: ReactTestRenderer | undefined;
beforeEach(() => {
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  state.data = fixture();
  state.canEdit = true;
  state.save.mockReset();
  state.preview.mockReset();
  state.refresh.mockReset();
  state.save.mockResolvedValue(AsyncResult.success(state.data));
  state.preview.mockResolvedValue(
    AsyncResult.success({
      selection: null,
      refusal: "no-eligible-model",
      candidates: [{ alias: "sol", model: "gpt-test", reason: "not-signed-in" }],
    }),
  );
});
afterEach(async () => {
  if (renderer) await act(() => renderer!.unmount());
  renderer = undefined;
  vi.unstubAllGlobals();
});
const mount = async () => {
  await act(() => {
    renderer = create(<DelegationSettings />);
  });
  return renderer!.root;
};
const button = (label: string) =>
  renderer!.root.findAllByType("button").find((node) => node.children.includes(label))!;
const checkbox = (label: string) =>
  renderer!.root
    .findAllByType("label")
    .find((node) => node.children.includes(label))!
    .findByType("input");

it("saves edited reviewer rules against the loaded revision without mutating the loaded snapshot", async () => {
  await mount();
  await act(() =>
    checkbox("Require a different provider from the author").props.onChange({
      target: { checked: true },
    }),
  );
  await act(() => button("Save policy").props.onClick());
  expect(state.save).toHaveBeenCalledWith({
    environmentId: EnvironmentId.make("test-env"),
    input: {
      expectedHash: "a".repeat(64),
      manifest: expect.objectContaining({
        reviewer: { prefer: ["sol"], requireDifferentProvider: true },
      }),
    },
  });
  expect(state.data!.snapshot.manifest.reviewer).toBeUndefined();
  expect(state.refresh).toHaveBeenCalledOnce();
});
it("previews unsaved choices without saving and displays the refusal explanation", async () => {
  await mount();
  await act(() =>
    checkbox("Require a different provider from the author").props.onChange({
      target: { checked: true },
    }),
  );
  const select = renderer!.root
    .findAllByType("select")
    .find((node) => node.findAllByProps({ "aria-label": "Role" }).length > 0)!;
  await act(() => select.props.onChange({ target: { value: "reviewer" } }));
  await act(() => button("Preview selection").props.onClick());
  expect(state.preview).toHaveBeenCalledWith(
    expect.objectContaining({
      input: expect.objectContaining({
        role: "reviewer",
        manifest: expect.objectContaining({
          reviewer: { prefer: ["sol"], requireDifferentProvider: true },
        }),
      }),
    }),
  );
  expect(state.save).not.toHaveBeenCalled();
  expect(
    renderer!.root
      .findAllByType("p")
      .some((node) => node.children.join("").includes("not signed in")),
  ).toBe(true);
});
it("reports a stale save, refreshes current values and does not retry the write", async () => {
  state.save.mockResolvedValue(
    AsyncResult.failure(Cause.fail(new AgentPolicySettingsError({ reason: "stale" }))),
  );
  await mount();
  await act(() =>
    checkbox("Require a different provider from the author").props.onChange({
      target: { checked: true },
    }),
  );
  await act(() => button("Save policy").props.onClick());
  expect(renderer!.root.findByProps({ role: "alert" }).children.join("")).toContain(
    "policy changed on disk",
  );
  expect(state.refresh).toHaveBeenCalledOnce();
  expect(state.save).toHaveBeenCalledOnce();
  state.data = {
    ...state.data!,
    snapshot: { ...state.data!.snapshot, hash: "c".repeat(64), sourceRevision: "fixture.2" },
  };
  await act(() => renderer!.update(<DelegationSettings />));
  expect(checkbox("Require a different provider from the author").props.checked).toBe(false);
});
it("removing a pool's last model blocks saving and discarding restores it", async () => {
  await mount();
  await act(() => renderer!.root.findByProps({ "aria-label": "Remove model sol" }).props.onClick());
  expect(button("Save policy").props.disabled).toBe(true);
  expect(state.save).not.toHaveBeenCalled();
  await act(() => button("Discard edits").props.onClick());
  expect(button("Save policy").props.disabled).toBe(false);
});
it("changing a model preserves default and demanding effort when the new model supports them", async () => {
  state.data = {
    ...state.data!,
    providers: [
      decodeProvider({
        driver: "codex",
        instanceId: "codex-test",
        enabled: true,
        installed: true,
        version: "test-version",
        status: "ready",
        auth: { status: "authenticated" },
        checkedAt: "2026-10-15T00:00:00.000Z",
        models: ["gpt-test", "gpt-second"].map((slug) => ({
          slug,
          name: slug,
          isCustom: false,
          capabilities: {
            optionDescriptors: [
              {
                id: "reasoning",
                label: "Effort",
                type: "select",
                options: ["medium", "high"].map((id) => ({ id, label: id })),
              },
            ],
          },
        })),
        slashCommands: [],
        skills: [],
      }),
    ],
  };
  await mount();
  const select = renderer!.root
    .findAllByType("select")
    .find((node) => node.findAllByProps({ "aria-label": "sol" }).length > 0)!;
  await act(() => select.props.onChange({ target: { value: "codex:gpt-second" } }));
  await act(() => button("Save policy").props.onClick());
  expect(state.save).toHaveBeenCalledWith(
    expect.objectContaining({
      input: expect.objectContaining({
        manifest: expect.objectContaining({
          models: expect.objectContaining({
            sol: expect.objectContaining({ model: "gpt-second" }),
          }),
          roles: expect.objectContaining({
            "implementation-worker": expect.objectContaining({
              effort: { sol: { default: "medium", demanding: "high" } },
            }),
          }),
        }),
      }),
    }),
  );
  expect(state.data!.snapshot.manifest.models.sol!.model).toBe("gpt-test");
});
