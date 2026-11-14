import {
  DEFAULT_CLIENT_SETTINGS,
  ProviderDriverKind,
  ProviderInstanceId,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

import { render } from "../../../test/render";
import { __setClientSettingsForTests } from "../../hooks/useSettings";
import { ProviderModelsSection } from "./ProviderModelsSection";

it("lists a favorite the provider no longer reports so it can be unstarred", async () => {
  const onToggleFavorite = vi.fn();
  await using screen = await render(
    <ProviderModelsSection
      instanceId={ProviderInstanceId.make("claude")}
      driverKind={ProviderDriverKind.make("claude")}
      models={[]}
      customModels={[]}
      canManageCustomModels
      hiddenModels={[]}
      favoriteModels={["retired-model"]}
      modelOrder={[]}
      onChange={() => {}}
      onHiddenModelsChange={() => {}}
      onFavoriteModelsChange={() => {}}
      onToggleFavorite={onToggleFavorite}
      onModelOrderChange={() => {}}
    />,
  );
  await screen.getByRole("button", { name: "Remove retired-model from favorites" }).click();
  expect(onToggleFavorite).toHaveBeenCalledWith("retired-model");
});

it("shows model-maker icons and supports inline renaming and resetting built-in models", async () => {
  __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS);
  using _settings = {
    [Symbol.dispose]: () => __setClientSettingsForTests(DEFAULT_CLIENT_SETTINGS),
  };

  await using screen = await render(
    <ProviderModelsSection
      instanceId={ProviderInstanceId.make("pi")}
      driverKind={ProviderDriverKind.make("pi")}
      providerDisplayName="Pi"
      models={[
        {
          slug: "anthropic/claude-sonnet-5-5",
          name: "Claude Sonnet 5.5",
          subProvider: "anthropic",
          isCustom: false,
          capabilities: null,
        },
        {
          slug: "opencode-go/deepseek-v4.1-flash",
          name: "DeepSeek V4.1 Flash",
          subProvider: "opencode-go",
          isCustom: false,
          capabilities: null,
        },
      ]}
      customModels={[]}
      canManageCustomModels
      hiddenModels={[]}
      favoriteModels={[]}
      modelOrder={[]}
      onChange={() => {}}
      onHiddenModelsChange={() => {}}
      onFavoriteModelsChange={() => {}}
      onToggleFavorite={() => {}}
      onModelOrderChange={() => {}}
    />,
  );

  expect(
    screen.container.querySelector(
      '[data-model-slug="anthropic/claude-sonnet-5-5"] [data-model-maker]',
    ),
  ).toHaveAttribute("data-model-maker", "anthropic");
  expect(
    screen.container.querySelector(
      '[data-model-slug="opencode-go/deepseek-v4.1-flash"] [data-model-maker]',
    ),
  ).toHaveAttribute("data-model-maker", "deepseek");

  await screen.getByRole("button", { name: "Rename Claude Sonnet 5.5" }).click();
  await userEvent.type(screen.getByRole("textbox", { name: "Model name" }), "Work Sonnet{Enter}");

  await expect.element(screen.getByText("Work Sonnet")).toBeVisible();

  await screen.getByRole("button", { name: "Rename Work Sonnet" }).click();
  await screen.getByRole("button", { name: "Reset model name" }).click();

  await expect.element(screen.getByText("Claude Sonnet 5.5")).toBeVisible();
});
