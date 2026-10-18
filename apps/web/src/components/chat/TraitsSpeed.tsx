import type { ProviderDriverKind, ProviderOptionDescriptor } from "@t3tools/contracts";
import { getProviderOptionCurrentValue } from "@t3tools/shared/model";
import { ZapIcon } from "lucide-react";
import { UltrafastIcon } from "../Icons";
import { cn } from "~/lib/utils";
import { ComposerControlIcon, type ComposerControlSize } from "./ComposerControl";

export function getTraitsSpeedDisplay(
  provider: ProviderDriverKind,
  descriptor: ProviderOptionDescriptor,
): { label: string; speedIcon: "fast" | "ultrafast" | null } | null {
  if (descriptor.id === "fastMode" && descriptor.type === "boolean") {
    return {
      label: descriptor.currentValue === true ? "Fast" : "Normal",
      speedIcon: descriptor.currentValue === true ? "fast" : null,
    };
  }
  if (provider !== "codex" || descriptor.id !== "serviceTier" || descriptor.type !== "select") {
    return null;
  }
  const currentValue = getProviderOptionCurrentValue(descriptor);
  const fastTier = descriptor.options.find(({ label }) => label === "Fast");
  const ultrafastTier = descriptor.options.find(({ label }) => label === "Ultrafast");
  if (
    ((fastTier || ultrafastTier) && currentValue === "default") ||
    (fastTier && currentValue === fastTier.id) ||
    (ultrafastTier && currentValue === ultrafastTier.id)
  ) {
    return {
      label: descriptor.options.find(({ id }) => id === currentValue)?.label ?? "Normal",
      speedIcon:
        ultrafastTier && currentValue === ultrafastTier.id
          ? "ultrafast"
          : fastTier && currentValue === fastTier.id
            ? "fast"
            : null,
    };
  }
  return null;
}

/**
 * The composer's Fast switch over whichever speed option the model exposes: Claude's `fastMode`
 * boolean or Codex's `serviceTier` select. Null when the model has no Fast option.
 */
export function resolveFastSwitch(descriptors: ReadonlyArray<ProviderOptionDescriptor>): {
  active: boolean;
  setActive: (active: boolean) => ReadonlyArray<ProviderOptionDescriptor>;
} | null {
  for (const descriptor of descriptors) {
    if (descriptor.id === "fastMode" && descriptor.type === "boolean") {
      return {
        active: descriptor.currentValue === true,
        setActive: (active) =>
          descriptors.map((entry) =>
            entry === descriptor ? { ...descriptor, currentValue: active } : entry,
          ),
      };
    }
    if (descriptor.id === "serviceTier" && descriptor.type === "select") {
      const fastTier = descriptor.options.find(({ label }) => label === "Fast");
      const standardTier = descriptor.options.find(({ id }) => id === "default");
      if (!fastTier || !standardTier) continue;
      const currentValue = getProviderOptionCurrentValue(descriptor);
      const fastTierIds = descriptor.options
        .filter(({ label }) => label === "Fast" || label === "Ultrafast")
        .map(({ id }) => id);
      return {
        active: typeof currentValue === "string" && fastTierIds.includes(currentValue),
        setActive: (active) =>
          descriptors.map((entry) =>
            entry === descriptor
              ? { ...descriptor, currentValue: active ? fastTier.id : standardTier.id }
              : entry,
          ),
      };
    }
  }
  return null;
}

export function TraitsSpeedIcon({
  provider,
  speedIcon,
  size = "sm",
}: {
  provider: ProviderDriverKind;
  speedIcon: "fast" | "ultrafast";
  size?: ComposerControlSize;
}) {
  return (
    <>
      <ComposerControlIcon
        icon={speedIcon === "ultrafast" ? UltrafastIcon : ZapIcon}
        size={size}
        className={cn(
          "fill-current opacity-80",
          size === "xs"
            ? "text-current"
            : provider === "claudeAgent"
              ? "text-[#d97757]"
              : "text-foreground",
        )}
      />
      <span className="sr-only">
        {speedIcon === "ultrafast" ? "Ultrafast mode on" : "Fast mode on"}
      </span>
    </>
  );
}
