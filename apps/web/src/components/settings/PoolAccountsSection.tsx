import {
  DndContext,
  type DragEndEvent,
  KeyboardSensor,
  PointerSensor,
  closestCenter,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToParentElement, restrictToVerticalAxis } from "@dnd-kit/modifiers";
import {
  SortableContext,
  arrayMove,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import type { ProviderInstanceConfig, ProviderInstanceId } from "@t3tools/contracts";
import { GripVerticalIcon } from "lucide-react";

import { cn } from "~/lib/utils";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import {
  POOL_RESERVE_PRESETS,
  type PoolSwitchOnLimit,
  poolSwitchOnLimitOf,
  withPoolPolicy,
} from "./PoolAccountsSection.logic";

const STRATEGY_LABELS = {
  spend: "Spend allowance that would lapse",
  order: "My order",
} as const;

const SWITCH_LABELS: Record<PoolSwitchOnLimit, string> = {
  global: "Follow general setting",
  always: "Always switch",
  never: "Wait for the reset",
};

const NO_RESERVE = "off";

/** Settings for an account pool: who it picks, in what order, and when it moves on. */
export function PoolAccountsSection({
  instance,
  memberLabels,
  readOnly,
  onUpdate,
}: {
  readonly instance: ProviderInstanceConfig & { readonly pool: ReadonlyArray<ProviderInstanceId> };
  /** Display names of the members, aligned with `instance.pool`. */
  readonly memberLabels: ReadonlyArray<string>;
  readonly readOnly: boolean;
  readonly onUpdate: (next: ProviderInstanceConfig) => void;
}) {
  const policy = instance.poolPolicy;
  const strategy = policy?.strategy ?? "spend";
  const disabled = policy?.disabledMembers ?? [];
  const reserve = policy?.reservePercent;
  const switchOnLimit = poolSwitchOnLimitOf(policy);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const labelOf = (member: ProviderInstanceId) =>
    memberLabels[instance.pool.indexOf(member)] ?? String(member);

  const handleDragEnd = (event: DragEndEvent) => {
    if (event.over === null || event.active.id === event.over.id) return;
    const from = instance.pool.findIndex((member) => member === event.active.id);
    const to = instance.pool.findIndex((member) => member === event.over?.id);
    onUpdate({ ...instance, pool: arrayMove([...instance.pool], from, to) });
  };

  const setEnabled = (member: ProviderInstanceId, enabled: boolean) =>
    onUpdate(
      withPoolPolicy(instance, {
        disabledMembers: enabled ? disabled.filter((id) => id !== member) : [...disabled, member],
      }),
    );

  return (
    <SettingsSection title="Accounts">
      <SettingsRow
        title="How the pool picks"
        description={
          strategy === "order"
            ? "New threads and delegated tasks use the first account in your order that has usage left. A thread keeps its account while that account has usage left."
            : "New threads and delegated tasks use the account whose usage resets soonest, skipping any that have run out. A thread keeps its account while that account has usage left."
        }
        control={
          <Select
            value={strategy}
            disabled={readOnly}
            onValueChange={(value) =>
              onUpdate(
                withPoolPolicy(instance, { strategy: value === "order" ? "order" : "spend" }),
              )
            }
          >
            <SelectTrigger size="sm" className="w-full sm:w-64" aria-label="How the pool picks">
              <SelectValue>{STRATEGY_LABELS[strategy]}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {(Object.keys(STRATEGY_LABELS) as Array<keyof typeof STRATEGY_LABELS>).map((key) => (
                <SelectItem hideIndicator key={key} value={key}>
                  {STRATEGY_LABELS[key]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        title="Accounts"
        description={
          strategy === "order"
            ? "Drag to set your order; the first is used first. Switch an account off to keep it out of the pool without removing it."
            : "Switch an account off to keep it out of the pool without removing it. The order applies when the pool picks “My order”."
        }
        status={
          <DndContext
            sensors={sensors}
            collisionDetection={closestCenter}
            modifiers={[restrictToVerticalAxis, restrictToParentElement]}
            onDragEnd={handleDragEnd}
          >
            <SortableContext items={[...instance.pool]} strategy={verticalListSortingStrategy}>
              <ol aria-label="Pooled accounts, most preferred first" className="pt-1">
                {instance.pool.map((member, index) => (
                  <SortableAccountRow
                    key={member}
                    member={member}
                    label={labelOf(member)}
                    position={index + 1}
                    enabled={!disabled.includes(member)}
                    readOnly={readOnly}
                    onEnabledChange={(enabled) => setEnabled(member, enabled)}
                  />
                ))}
              </ol>
            </SortableContext>
          </DndContext>
        }
      />
      <SettingsRow
        title="Keep in reserve"
        description="Treat an account as out once it is this much used, so new threads and switches leave the rest of it alone. A running thread stays on its account until the real limit."
        control={
          <Select
            value={reserve === undefined ? NO_RESERVE : String(reserve)}
            disabled={readOnly}
            onValueChange={(value) =>
              onUpdate(
                withPoolPolicy(instance, {
                  reservePercent: value === NO_RESERVE ? null : Number(value),
                }),
              )
            }
          >
            <SelectTrigger size="sm" className="w-full sm:w-44" aria-label="Keep in reserve">
              <SelectValue>{reserve === undefined ? "Off" : `At ${reserve}% used`}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              <SelectItem hideIndicator value={NO_RESERVE}>
                Off
              </SelectItem>
              {[...new Set([...POOL_RESERVE_PRESETS, ...(reserve === undefined ? [] : [reserve])])]
                .toSorted((a, b) => a - b)
                .map((percent) => (
                  <SelectItem hideIndicator key={percent} value={String(percent)}>
                    At {percent}% used
                  </SelectItem>
                ))}
            </SelectPopup>
          </Select>
        }
      />
      <SettingsRow
        title="When an account hits its limit"
        description="Continue the thread at once on the next account with usage left, or wait for the reset. Following the general setting uses Settings → General → Switch pooled account on limit."
        control={
          <Select
            value={switchOnLimit}
            disabled={readOnly}
            onValueChange={(value) =>
              onUpdate(
                withPoolPolicy(instance, {
                  switchOnLimit: value === "always" || value === "never" ? value : "global",
                }),
              )
            }
          >
            <SelectTrigger
              size="sm"
              className="w-full sm:w-52"
              aria-label="When an account hits its limit"
            >
              <SelectValue>{SWITCH_LABELS[switchOnLimit]}</SelectValue>
            </SelectTrigger>
            <SelectPopup align="end" alignItemWithTrigger={false}>
              {(Object.keys(SWITCH_LABELS) as Array<PoolSwitchOnLimit>).map((key) => (
                <SelectItem hideIndicator key={key} value={key}>
                  {SWITCH_LABELS[key]}
                </SelectItem>
              ))}
            </SelectPopup>
          </Select>
        }
      />
    </SettingsSection>
  );
}

function SortableAccountRow({
  member,
  label,
  position,
  enabled,
  readOnly,
  onEnabledChange,
}: {
  readonly member: ProviderInstanceId;
  readonly label: string;
  readonly position: number;
  readonly enabled: boolean;
  readonly readOnly: boolean;
  readonly onEnabledChange: (enabled: boolean) => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: member, disabled: readOnly });

  return (
    <li
      ref={setNodeRef}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn(
        "flex items-center gap-2 py-1.5",
        isDragging && "relative z-10 rounded-md bg-background shadow-md",
      )}
    >
      <button
        type="button"
        ref={setActivatorNodeRef}
        {...attributes}
        {...listeners}
        disabled={readOnly}
        aria-label={`Reorder ${label}, position ${position}`}
        className="flex size-6 shrink-0 cursor-grab touch-none items-center justify-center rounded text-muted-foreground/70 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring active:cursor-grabbing"
      >
        <GripVerticalIcon className="size-3.5" />
      </button>
      <span
        className={cn(
          "min-w-0 flex-1 truncate text-xs",
          enabled ? "text-foreground" : "text-muted-foreground",
        )}
      >
        {label}
      </span>
      <Switch
        checked={enabled}
        disabled={readOnly}
        onCheckedChange={(checked) => onEnabledChange(Boolean(checked))}
        aria-label={`Use ${label}`}
      />
    </li>
  );
}
