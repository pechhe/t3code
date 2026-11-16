import type { DelegationStance } from "@t3tools/contracts";
import { useState } from "react";
import { describe, expect, it, vi } from "vite-plus/test";
import { page, userEvent } from "vite-plus/test/browser";

import { render } from "../../../../test/render";
import { getDelegationStanceOption } from "../stance.logic";
import { DeviceStanceSwitch } from "./DeviceStanceSwitch";

function ControlledStance({
  initial = "flexible",
  disabled = false,
  onSelect,
}: {
  initial?: DelegationStance;
  disabled?: boolean;
  onSelect?: (stance: DelegationStance) => void;
}) {
  const [stance, setStance] = useState<DelegationStance>(initial);
  return (
    <DeviceStanceSwitch
      stance={stance}
      disabled={disabled}
      onChange={(next) => {
        setStance(next);
        onSelect?.(next);
      }}
    />
  );
}

describe("DeviceStanceSwitch", () => {
  it("exposes a three-position radio group operable by click and keyboard arrows", async () => {
    const onSelect = vi.fn();
    await using screen = await render(<ControlledStance onSelect={onSelect} />);

    const group = screen.getByRole("radiogroup", { name: "Delegation stance" });
    await expect.element(group).toBeVisible();

    const orchestrate = screen.getByRole("radio", { name: "Orchestrate" });
    const flexible = screen.getByRole("radio", { name: "Flexible" });
    const implement = screen.getByRole("radio", { name: "Implement" });

    await expect.element(flexible).toHaveAttribute("aria-checked", "true");
    await expect.element(orchestrate).toHaveAttribute("aria-checked", "false");
    await expect.element(implement).toHaveAttribute("aria-checked", "false");

    await userEvent.tab();
    await expect.element(flexible).toHaveFocus();

    await userEvent.keyboard("{ArrowUp}");
    expect(onSelect).toHaveBeenLastCalledWith("orchestrate");
    await expect.element(orchestrate).toHaveAttribute("aria-checked", "true");
    await expect.element(orchestrate).toHaveFocus();

    await userEvent.keyboard("{ArrowDown}");
    expect(onSelect).toHaveBeenLastCalledWith("flexible");
    await expect.element(flexible).toHaveAttribute("aria-checked", "true");

    await userEvent.keyboard("{End}");
    expect(onSelect).toHaveBeenLastCalledWith("implement");
    await expect.element(implement).toHaveAttribute("aria-checked", "true");

    await userEvent.keyboard("{Home}");
    expect(onSelect).toHaveBeenLastCalledWith("orchestrate");
    await expect.element(orchestrate).toHaveAttribute("aria-checked", "true");

    await userEvent.click(implement);
    expect(onSelect).toHaveBeenLastCalledWith("implement");
    await expect.element(implement).toHaveAttribute("aria-checked", "true");
  });

  it("names and explains a position when its icon is hovered", async () => {
    await using screen = await render(<ControlledStance initial="flexible" />);
    const implement = getDelegationStanceOption("implement");

    await userEvent.hover(screen.getByRole("radio", { name: "Implement" }));
    await expect.element(page.getByText(implement.label, { exact: true })).toBeVisible();
    await expect.element(page.getByText(implement.tooltip)).toBeVisible();
  });

  it("does not change when disabled", async () => {
    const onSelect = vi.fn();
    await using screen = await render(<ControlledStance disabled onSelect={onSelect} />);
    const orchestrate = screen.getByRole("radio", { name: "Orchestrate" });
    await expect.element(orchestrate).toBeDisabled();
    expect(onSelect).not.toHaveBeenCalled();
  });
});
