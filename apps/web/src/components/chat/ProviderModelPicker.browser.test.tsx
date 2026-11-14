import {
  DEFAULT_CLIENT_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
  type ModelSelection,
} from "@t3tools/contracts";
import { useState } from "react";
import { expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import "~/index.css";

import { render } from "../../../test/render";
import { __setClientSettingsForTests } from "../../hooks/useSettings";
import { deriveProviderInstanceEntries } from "../../providerInstances";
import { ProviderModelPicker } from "./ProviderModelPicker";

it("keeps each registry image when adding a model from another ACP agent", async () => {
  const icons = [
    "https://cdn.agentclientprotocol.com/registry/icons/picker-explicit.svg",
    "https://cdn.agentclientprotocol.com/registry/v1/latest/picker-by-id.svg",
  ];
  const cache = await caches.open("t3-acp-registry-icons-v1");
  await using _cachedIcons = {
    async [Symbol.asyncDispose]() {
      await Promise.all(icons.map((url) => cache.delete(url)));
    },
  };
  for (const [index, url] of icons.entries()) {
    await cache.put(
      url,
      new Response(
        `<svg xmlns="http://www.w3.org/2000/svg" width="${11 + index * 6}" height="10"><path d="M0 0h10v10H0z"/></svg>`,
        { headers: { "content-type": "image/svg+xml" } },
      ),
    );
  }
  const entries = deriveProviderInstanceEntries(
    ["First", "Second"].map((name) => ({
      instanceId: ProviderInstanceId.make(name.toLowerCase()),
      driver: ProviderDriverKind.make("acpRegistry"),
      displayName: `${name} agent`,
      enabled: true,
      installed: true,
      version: null,
      status: "ready" as const,
      auth: { status: "authenticated" as const },
      checkedAt: "2026-01-01T00:00:00.000Z",
      models: [
        { slug: name.toLowerCase(), name: `${name} model`, isCustom: false, capabilities: {} },
      ],
      slashCommands: [],
      skills: [],
    })),
  ).map((entry, index) => ({
    ...entry,
    ...(index === 0 ? { acpRegistryIconUrl: icons[0] } : { acpRegistryAgentId: "picker-by-id" }),
  }));
  const first = { instanceId: entries[0]!.instanceId, model: "first" };
  const options = new Map(entries.map((entry) => [entry.instanceId, entry.models]));

  function Picker() {
    const [selection, setSelection] = useState<ReadonlyArray<ModelSelection>>([first]);
    return (
      <ProviderModelPicker
        environmentId={null}
        activeInstanceId={first.instanceId}
        model={first.model}
        {...(selection.length > 1 ? { selectedModels: selection } : {})}
        lockedProvider={null}
        instanceEntries={entries}
        modelOptionsByInstance={options}
        onToggleModel={(instanceId, model) => setSelection([...selection, { instanceId, model }])}
        onInstanceModelChange={(instanceId, model) => setSelection([{ instanceId, model }])}
      />
    );
  }

  await using screen = await render(<Picker />);
  const imageWidths = () =>
    Array.from(
      screen.container.querySelectorAll<HTMLImageElement>("[data-chat-provider-model-picker] img"),
      (image) => image.naturalWidth,
    );
  await vi.waitFor(() => expect(imageWidths()).toEqual([11]));
  await screen.getByRole("button", { name: "First model", exact: true }).click();
  await page.getByRole("button", { name: "Second agent", exact: true }).click();
  await userEvent.keyboard("{Shift>}");
  try {
    await page.getByRole("option", { name: /Second model/ }).click();
  } finally {
    await userEvent.keyboard("{/Shift}");
  }
  await userEvent.keyboard("{Escape}");
  await vi.waitFor(() => expect(imageWidths()).toEqual([11, 17]));
});

it("keeps a docked picker open after a pick and hands focus to that model's effort", async () => {
  const instanceId = ProviderInstanceId.make("codex");
  const entries = deriveProviderInstanceEntries([
    {
      instanceId,
      driver: ProviderDriverKind.make("codex"),
      enabled: true,
      installed: true,
      version: null,
      status: "ready",
      auth: { status: "authenticated" },
      checkedAt: "2026-01-01T00:00:00.000Z",
      models: [],
      slashCommands: [],
      skills: [],
    },
  ]);
  const options = new Map([
    [
      instanceId,
      [
        { slug: "original", name: "Original model" },
        { slug: "second", name: "Second model" },
        { slug: "plain", name: "Plain model" },
      ],
    ],
  ]);
  // The last level is the selected one; "plain" has no effort to pick.
  const levels: Record<string, ReadonlyArray<string>> = {
    original: ["Low", "High"],
    second: ["Medium"],
    plain: [],
  };

  function Picker() {
    const [model, setModel] = useState("original");
    return (
      <ProviderModelPicker
        environmentId={null}
        activeInstanceId={instanceId}
        model={model}
        lockedProvider={null}
        instanceEntries={entries}
        modelOptionsByInstance={options}
        triggerAriaLabel="Choose model"
        onInstanceModelChange={(_, selected) => setModel(selected)}
        effortColumn={(levels[model] ?? []).map((level, index, all) => (
          <button
            key={level}
            type="button"
            role="radio"
            aria-checked={index === all.length - 1}
            data-effort-row
            data-effort-level
          >
            {level}
          </button>
        ))}
      />
    );
  }

  await using screen = await render(<Picker />);
  await screen.getByRole("button", { name: "Choose model" }).click();
  const search = page.getByPlaceholder("Search models...");
  await expect.element(search).toHaveFocus();
  await userEvent.keyboard("{ArrowRight}");
  await expect.element(page.getByRole("radio", { name: "High" })).toHaveFocus();
  await userEvent.keyboard("{ArrowLeft}");
  await expect.element(search).toHaveFocus();

  await page.getByRole("option", { name: /Second model/ }).click();
  await expect.element(page.getByRole("radio", { name: "Medium" })).toHaveFocus();

  await page.getByRole("option", { name: /Plain model/ }).click();
  await page.getByRole("option", { name: /Second model/ }).click();
  await expect.element(page.getByRole("radio", { name: "Medium" })).toHaveFocus();
  await userEvent.keyboard("{Escape}");
  await expect.element(search).not.toBeInTheDocument();
});

it("opens on the active provider when every favorite belongs to a disabled provider", async () => {
  const entries = deriveProviderInstanceEntries(
    ["Codex", "Claude"].map((name) => ({
      instanceId: ProviderInstanceId.make(name.toLowerCase()),
      driver: ProviderDriverKind.make(name.toLowerCase()),
      enabled: name === "Codex",
      installed: true,
      version: null,
      status: "ready" as const,
      auth: { status: "authenticated" as const },
      checkedAt: "2026-01-01T00:00:00.000Z",
      models: [
        { slug: name.toLowerCase(), name: `${name} model`, isCustom: false, capabilities: {} },
      ],
      slashCommands: [],
      skills: [],
    })),
  );
  const [codex, claude] = entries;
  __setClientSettingsForTests({
    ...DEFAULT_CLIENT_SETTINGS,
    favorites: [{ provider: claude!.instanceId, model: "claude" }],
  });
  using _settings = {
    [Symbol.dispose]: () => __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS),
  };

  await using screen = await render(
    <ProviderModelPicker
      environmentId={null}
      activeInstanceId={codex!.instanceId}
      model="codex"
      lockedProvider={null}
      instanceEntries={entries}
      modelOptionsByInstance={new Map(entries.map((entry) => [entry.instanceId, entry.models]))}
      triggerAriaLabel="Choose model"
      onInstanceModelChange={() => {}}
    />,
  );
  await screen.getByRole("button", { name: "Choose model" }).click();
  await expect.element(page.getByRole("option", { name: /Codex model/ })).toBeVisible();
});

it("shows model-matched icons for pi models while keeping the pi icon in the sidebar", async () => {
  const entries = deriveProviderInstanceEntries([
    {
      instanceId: ProviderInstanceId.make("pi"),
      driver: ProviderDriverKind.make("pi"),
      enabled: true,
      installed: true,
      version: null,
      status: "ready" as const,
      auth: { status: "authenticated" as const },
      checkedAt: "2026-01-01T00:00:00.000Z",
      models: [
        { slug: "default", name: "Default", isCustom: false, capabilities: {} },
        {
          slug: "openai/gpt-6-luna",
          name: "GPT-6 Luna",
          subProvider: "openai",
          isCustom: false,
          capabilities: {},
        },
        {
          slug: "anthropic/claude-opus-4-6",
          name: "Claude Opus 4.6",
          subProvider: "anthropic",
          isCustom: false,
          capabilities: {},
        },
        {
          slug: "opencode/deepseek-v4.1-flash",
          name: "DeepSeek V4.1 Flash",
          subProvider: "opencode",
          isCustom: false,
          capabilities: {},
        },
      ],
      slashCommands: [],
      skills: [],
    },
  ]);
  const [piEntry] = entries;

  await using screen = await render(
    <ProviderModelPicker
      environmentId={null}
      activeInstanceId={piEntry!.instanceId}
      model="openai/gpt-6-luna"
      lockedProvider={null}
      instanceEntries={entries}
      modelOptionsByInstance={new Map(entries.map((entry) => [entry.instanceId, entry.models]))}
      triggerAriaLabel="Choose model"
      onInstanceModelChange={() => {}}
    />,
  );

  // Trigger icon matches the active Pi model's maker.
  const triggerIcon = screen.container.querySelector(
    "[data-chat-provider-model-picker-icon] [data-model-maker]",
  );
  expect(triggerIcon?.getAttribute("data-model-maker")).toBe("openai");

  await screen.getByRole("button", { name: "Choose model" }).click();
  const lunaRow = page.getByRole("option", { name: /GPT-6 Luna/ });
  const claudeRow = page.getByRole("option", { name: /Claude Opus 4.6/ });
  const deepseekRow = page.getByRole("option", { name: /DeepSeek V4.1 Flash/ });
  const defaultRow = page.getByRole("option", { name: /^Default\s*,/ });
  await expect.element(lunaRow).toBeVisible();

  expect(
    (await lunaRow.element()).querySelector("[data-model-maker]")?.getAttribute("data-model-maker"),
  ).toBe("openai");
  expect(
    (await claudeRow.element())
      .querySelector("[data-model-maker]")
      ?.getAttribute("data-model-maker"),
  ).toBe("anthropic");
  expect(
    (await deepseekRow.element())
      .querySelector("[data-model-maker]")
      ?.getAttribute("data-model-maker"),
  ).toBe("deepseek");
  expect((await defaultRow.element()).querySelector("[data-model-maker]")).toBeNull();
});

it("renames a model inline from the picker, searches by custom name, and cancels on Escape without closing", async () => {
  const entries = deriveProviderInstanceEntries([
    {
      instanceId: ProviderInstanceId.make("pi"),
      driver: ProviderDriverKind.make("pi"),
      enabled: true,
      installed: true,
      version: null,
      status: "ready" as const,
      auth: { status: "authenticated" as const },
      checkedAt: "2026-01-01T00:00:00.000Z",
      models: [
        {
          slug: "openai/gpt-6-luna",
          name: "GPT-6 Luna",
          subProvider: "openai",
          isCustom: false,
          capabilities: {},
        },
        {
          slug: "anthropic/claude-opus-4-6",
          name: "Claude Opus 4.6",
          subProvider: "anthropic",
          isCustom: false,
          capabilities: {},
        },
      ],
      slashCommands: [],
      skills: [],
    },
  ]);
  const [piEntry] = entries;
  __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
  using _settings = {
    [Symbol.dispose]: () => __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS),
  };

  await using screen = await render(
    <ProviderModelPicker
      environmentId={null}
      activeInstanceId={piEntry!.instanceId}
      model="openai/gpt-6-luna"
      lockedProvider={null}
      instanceEntries={entries}
      modelOptionsByInstance={new Map(entries.map((entry) => [entry.instanceId, entry.models]))}
      triggerAriaLabel="Choose model"
      onInstanceModelChange={() => {}}
    />,
  );

  await screen.getByRole("button", { name: "Choose model" }).click();
  const lunaRow = page.getByRole("option", { name: /GPT-6 Luna/ });
  await expect.element(lunaRow).toBeVisible();
  await lunaRow.hover();

  const renameButton = (await lunaRow.element()).querySelector<HTMLButtonElement>(
    'button[aria-label="Rename model"]',
  );
  expect(renameButton).not.toBeNull();
  renameButton!.click();

  const renameInput = page.getByRole("textbox", { name: "Model name" });
  await expect.element(renameInput).toBeVisible();

  // Escape cancels rename and keeps the popover open.
  await userEvent.keyboard("{Escape}");
  await expect.element(renameInput).not.toBeInTheDocument();
  await expect.element(page.getByRole("option", { name: /GPT-6 Luna/ })).toBeVisible();

  // Re-open rename, type a new name, and press Enter to save.
  await page.getByRole("option", { name: /GPT-6 Luna/ }).hover();
  (await page.getByRole("option", { name: /GPT-6 Luna/ }).element())
    .querySelector<HTMLButtonElement>('button[aria-label="Rename model"]')!
    .click();
  await expect.element(page.getByRole("textbox", { name: "Model name" })).toBeVisible();
  await userEvent.type(page.getByRole("textbox", { name: "Model name" }), "Daily Luna{Enter}");

  // Trigger label and row reflect the custom name.
  await expect.element(page.getByRole("option", { name: /Daily Luna/ })).toBeVisible();
  expect(
    screen.container.querySelector("[data-chat-provider-model-picker-label]")?.textContent,
  ).toBe("Daily Luna");

  // Search matches the custom name.
  const searchInput = page.getByPlaceholder("Search models...");
  await userEvent.type(searchInput, "Daily");
  await expect.element(page.getByRole("option", { name: /Daily Luna/ })).toBeVisible();
  await expect
    .element(page.getByRole("option", { name: /Claude Opus 4.6/ }))
    .not.toBeInTheDocument();

  // Clear search and reset the custom name via the reset button.
  await userEvent.clear(searchInput);
  await page.getByRole("option", { name: /Daily Luna/ }).hover();
  (await page.getByRole("option", { name: /Daily Luna/ }).element())
    .querySelector<HTMLButtonElement>('button[aria-label="Rename model"]')!
    .click();
  const resetButton = page.getByRole("button", { name: "Reset model name" });
  await expect.element(resetButton).toBeVisible();
  await resetButton.click();

  await expect.element(page.getByRole("option", { name: /GPT-6 Luna/ })).toBeVisible();
  expect(
    screen.container.querySelector("[data-chat-provider-model-picker-label]")?.textContent,
  ).toBe("6 Luna");
});
