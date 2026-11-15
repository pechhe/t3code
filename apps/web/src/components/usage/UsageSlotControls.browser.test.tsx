import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { REMEMBERED_LIMIT_WINDOW_ID } from "@t3tools/shared/providerPools";
import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";

const PRIMARY_ENV = vi.hoisted(() => "primary-env" as EnvironmentId);
const REMOTE_ENV = vi.hoisted(() => "remote-env" as EnvironmentId);
const state = vi.hoisted(() => ({
  commands: [] as Array<{ readonly environmentId: string; readonly input: unknown }>,
  providersByEnv: new Map<EnvironmentId, ReadonlyArray<ServerProvider>>(),
  settingsAtoms: new Map<EnvironmentId, unknown>(),
}));

vi.mock(import("~/state/environments"), (async (
  original: () => Promise<Record<string, unknown>>,
) => {
  const actual = await original();
  return {
    ...actual,
    usePrimaryEnvironmentId: () => PRIMARY_ENV,
    useEnvironmentProviders: () => state.providersByEnv,
    useEnvironments: () => ({
      environments: [
        {
          environmentId: PRIMARY_ENV,
          label: "Mac",
          connection: { phase: "connected" },
          serverConfig: null,
        },
        {
          environmentId: REMOTE_ENV,
          label: "VPS",
          connection: { phase: "connected" },
          serverConfig: null,
        },
      ],
    }),
  };
}) as never);

vi.mock(import("~/state/server"), async (original) => {
  const { Atom } = await import("effect/reactivity");
  const actual = await original();
  state.settingsAtoms.set(PRIMARY_ENV, Atom.make(DEFAULT_SERVER_SETTINGS));
  state.settingsAtoms.set(
    REMOTE_ENV,
    Atom.make({
      ...DEFAULT_SERVER_SETTINGS,
      usageSlotBudgets: {
        "pi:anthropic-hfpetch": {
          monthlyBudgetUsd: 50,
          resetDayOfMonth: 1,
          cycleSpendUsd: 12,
          correctedAt: "2026-11-15T10:00:00.000Z",
        },
      },
    }),
  );
  const granted = Atom.make(true);
  return {
    ...actual,
    serverEnvironment: {
      ...actual.serverEnvironment,
      settingsValueAtom: ((id: EnvironmentId) =>
        state.settingsAtoms.get(id) ?? state.settingsAtoms.get(PRIMARY_ENV)) as never,
      clearUsageLimit: {
        ...actual.serverEnvironment.clearUsageLimit,
        permissionAtom: (() => granted) as never,
      } as never,
    },
  };
});

vi.mock(import("~/state/session"), (async (original: () => Promise<Record<string, unknown>>) => {
  const { AsyncResult, Atom } = await import("effect/reactivity");
  const actual = await original();
  const session = Atom.make(
    AsyncResult.success({ authenticated: true, scopes: ["settings:write", "providers:manage"] }),
  );
  return {
    ...actual,
    useEnvironmentScope: () => {},
    readEnvironmentScope: () => true,
    environmentSession: {
      ...(actual.environmentSession as Record<string, unknown>),
      sessionStateAtom: () => session,
    },
  };
}) as never);

vi.mock(import("~/state/use-atom-command"), async (original) => ({
  ...(await original()),
  useAtomCommand: (() =>
    async (request: { readonly environmentId: string; readonly input: unknown }) => {
      state.commands.push(request);
      return { _tag: "Success" };
    }) as never,
}));

import { UsageLimitsPooled } from "./UsageLimitsPooled";

const NOW = "2026-11-15T12:00:00.000Z";

function remotePiProvider(): ServerProvider {
  return {
    instanceId: ProviderInstanceId.make("pi"),
    driver: ProviderDriverKind.make("pi"),
    displayName: "Pi",
    enabled: true,
    installed: true,
    version: "1.5.2",
    status: "ready",
    auth: { status: "authenticated" },
    checkedAt: NOW,
    models: [],
    slashCommands: [],
    skills: [],
    usageSlots: [
      {
        accountKey: "anthropic-hfpetch",
        label: "anthropic-hfpetch",
        usageLimits: {
          checkedAt: NOW,
          windows: [
            {
              id: "budget",
              kind: "monthly",
              label: "Monthly budget",
              usedPercent: 24,
              usedUsd: 12,
              limitUsd: 50,
              resetsAt: "2026-12-01T00:00:00.000Z",
            },
            {
              id: REMEMBERED_LIMIT_WINDOW_ID,
              kind: "other",
              label: "Usage limit reached",
              usedPercent: 100,
              resetsAt: "2999-01-01T00:00:00.000Z",
            },
          ],
        },
      },
    ],
  };
}

describe("UsageLimitsPooled remote slot controls", () => {
  it("targets the slot's own environment rather than the primary environment", async () => {
    state.commands.length = 0;
    const provider = remotePiProvider();
    state.providersByEnv.clear();
    state.providersByEnv.set(REMOTE_ENV, [provider]);

    const presentations = new Map([
      [
        REMOTE_ENV,
        {
          entry: { target: { label: "VPS" } },
          serverConfig: { providers: [provider] },
        },
      ],
    ]);

    await using screen = await render(
      <UsageLimitsPooled presentations={presentations} now={Date.parse(NOW)} />,
    );

    await expect.element(screen.getByText("$12.00 of $50.00 this cycle")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Clear cooldown" }));
    expect(state.commands).toContainEqual({
      environmentId: REMOTE_ENV,
      input: { instanceId: "pi", accountKey: "anthropic-hfpetch" },
    });

    await userEvent.click(screen.getByRole("button", { name: "Edit budget" }));
    await expect.element(screen.getByLabelText("Monthly budget (USD)")).toHaveValue("50");
    await userEvent.click(screen.getByRole("button", { name: "Save budget" }));
    expect(state.commands).toContainEqual(
      expect.objectContaining({
        environmentId: REMOTE_ENV,
        input: {
          patch: {
            usageSlotBudgets: {
              "pi:anthropic-hfpetch": {
                monthlyBudgetUsd: 50,
                resetDayOfMonth: 1,
                cycleSpendUsd: 12,
              },
            },
          },
        },
      }),
    );
  });
});
