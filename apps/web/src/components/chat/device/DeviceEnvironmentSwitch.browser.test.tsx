import { describe, expect, it, vi } from "vite-plus/test";
import { userEvent } from "vite-plus/test/browser";

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
  it("stamps A on the knob while load balancing owns the pick", async () => {
    await using screen = await render(
      <DeviceEnvironmentSwitch
        environments={[UPPER, LOWER]}
        environmentId={UPPER.environmentId}
        locked={false}
        balanceState="auto"
        onChange={vi.fn()}
      />,
    );
    await expect
      .element(screen.getByRole("switch", { name: "Run on PEACH-BOX" }))
      .toHaveAttribute("data-device-switch-balance", "auto");
    await expect.element(screen.getByText("A", { exact: true })).toBeVisible();
  });

  it("stamps O when the user overrides the balanced pick", async () => {
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
    await expect
      .element(screen.getByRole("switch", { name: "Run on MAC-STUDIO" }))
      .toHaveAttribute("data-device-switch-balance", "override");
    await expect.element(screen.getByText("O", { exact: true })).toBeVisible();
    await expect.element(screen.getByText("A", { exact: true })).not.toBeInTheDocument();
  });

  it("stamps nothing on the plain, unbalanced lever", async () => {
    await using screen = await render(
      <DeviceEnvironmentSwitch
        environments={[UPPER, LOWER]}
        environmentId={UPPER.environmentId}
        locked={false}
        onChange={vi.fn()}
      />,
    );
    await expect
      .element(screen.getByRole("switch", { name: "Run on PEACH-BOX" }))
      .not.toHaveAttribute("data-device-switch-balance");
    await expect.element(screen.getByText("A", { exact: true })).not.toBeInTheDocument();
    await expect.element(screen.getByText("O", { exact: true })).not.toBeInTheDocument();
  });

  it("clicks to the other machine to override", async () => {
    const onChange = vi.fn();
    await using screen = await render(
      <DeviceEnvironmentSwitch
        environments={[UPPER, LOWER]}
        environmentId={UPPER.environmentId}
        locked={false}
        balanceState="auto"
        onChange={onChange}
      />,
    );
    await userEvent.click(screen.getByRole("switch", { name: "Run on PEACH-BOX" }));
    expect(onChange).toHaveBeenCalledWith(LOWER.environmentId);
  });
});
