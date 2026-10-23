import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent, page } from "vite-plus/test/browser";

import { type EnvironmentOption } from "../../BranchToolbar.logic";
import { DeviceEnvironmentSwitch } from "./DeviceEnvironmentSwitch";
import { render } from "../../../../test/render";

const makeEnvironment = (id: string, label: string): EnvironmentOption => ({
  environmentId: id as EnvironmentOption["environmentId"],
  projectId: null,
  label,
  isPrimary: false,
  machine: "server",
});

const UPPER = makeEnvironment("env-upper", "PEACH-BOX");
const LOWER = makeEnvironment("env-lower", "MAC-STUDIO");

describe("DeviceEnvironmentSwitch", () => {
  it("explains the automatic pick and how to override it", async () => {
    await using screen = await render(
      <DeviceEnvironmentSwitch
        environments={[UPPER, LOWER]}
        environmentId={UPPER.environmentId}
        locked={false}
        balanceState="auto"
        onChange={vi.fn()}
      />,
    );
    await userEvent.hover(screen.getByRole("switch"));
    await expect
      .element(
        page.getByText("Auto balance recommends PEACH-BOX. Click to choose MAC-STUDIO manually.", {
          exact: true,
        }),
      )
      .toBeVisible();
  });

  it("names the recommended machine and the way back to Auto during an override", async () => {
    await using screen = await render(
      <DeviceEnvironmentSwitch
        environments={[UPPER, LOWER]}
        environmentId={LOWER.environmentId}
        locked={false}
        balanceState="override"
        balancedEnvironmentLabel="PEACH-BOX"
        onChange={vi.fn()}
      />,
    );
    await userEvent.hover(screen.getByRole("switch"));
    await expect
      .element(
        page.getByText(
          "Manual override. Runs on MAC-STUDIO; auto balance recommends PEACH-BOX. Click to return to Auto.",
          { exact: true },
        ),
      )
      .toBeVisible();
  });

  it("reports a pending resource check without claiming a machine was selected", async () => {
    await using screen = await render(
      <DeviceEnvironmentSwitch
        environments={[UPPER, LOWER]}
        environmentId={UPPER.environmentId}
        locked={false}
        balanceState="checking"
        onChange={vi.fn()}
      />,
    );
    await userEvent.hover(screen.getByRole("switch"));
    await expect
      .element(page.getByText("Auto balance is checking machines…", { exact: true }))
      .toBeVisible();
  });

  it("explains the plain machine choice when balancing is disabled", async () => {
    await using screen = await render(
      <DeviceEnvironmentSwitch
        environments={[UPPER, LOWER]}
        environmentId={UPPER.environmentId}
        locked={false}
        onChange={vi.fn()}
      />,
    );
    await userEvent.hover(screen.getByRole("switch"));
    await expect
      .element(page.getByText("Runs on PEACH-BOX. Click to switch to MAC-STUDIO.", { exact: true }))
      .toBeVisible();
  });
});
