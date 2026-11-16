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
import {
  isModelPoolSlotEnabled,
  type EnvironmentId,
  type ModelPoolConfig,
  type ModelPoolId,
  type ServerProvider,
  type UnifiedSettings,
} from "@t3tools/contracts";
import { slotStanding, modelPoolLimitPercentOf } from "@t3tools/shared/modelPools";
import { GripVerticalIcon, PlusIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import { useNowMinute } from "../../hooks/useNowMinute";
import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { cn } from "~/lib/utils";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  Select,
  SelectGroup,
  SelectGroupLabel,
  SelectItem,
  SelectPopup,
  SelectTrigger,
  SelectValue,
} from "../ui/select";
import { Switch } from "../ui/switch";
import {
  modelPoolIdFor,
  modelPoolSwitchOnLimitOf,
  slotAccountLabel,
  slotChoices,
  slotKeyOf,
  slotModelLabel,
  withModelPoolPolicy,
  withSlotEnabled,
  withSlots,
} from "./ModelPoolsSettings.logic";
import { POOL_RESERVE_PRESETS, type PoolSwitchOnLimit } from "./PoolAccountsSection.logic";
import { searchableSetting } from "./settingsSearch";
import { SettingsRow, SettingsSection } from "./settingsLayout";

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

/** Settings → Providers → Model pools: one model by name, served by several accounts. */
export function ModelPoolsSettings({
  environmentId,
  pools,
  providers,
  readOnly,
}: {
  readonly environmentId: EnvironmentId;
  readonly pools: UnifiedSettings["modelPools"];
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly readOnly: boolean;
}) {
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const [draftName, setDraftName] = useState<string | null>(null);
  const entries = Object.entries(pools) as Array<[ModelPoolId, ModelPoolConfig]>;
  const save = (id: ModelPoolId, pool: ModelPoolConfig | null) =>
    updateSettings({ modelPools: { [id]: pool } });

  const create = () => {
    const name = draftName?.trim();
    if (!name) return;
    save(modelPoolIdFor(name, Object.keys(pools)), { displayName: name, slots: [] });
    setDraftName(null);
  };

  return (
    <SettingsSection
      {...searchableSetting("model-pools")}
      headerAction={
        !readOnly && draftName === null ? (
          <Button size="xs" variant="outline" onClick={() => setDraftName("")}>
            <PlusIcon className="size-3" aria-hidden />
            New pool
          </Button>
        ) : null
      }
    >
      {draftName !== null ? (
        <SettingsRow
          title="New model pool"
          description="Name it after the model it serves, such as “Opus 5.5”. You add the accounts next."
          control={
            <form
              className="flex items-center gap-2"
              onSubmit={(event) => {
                event.preventDefault();
                create();
              }}
            >
              <Input
                size="sm"
                autoFocus
                aria-label="Pool name"
                placeholder="Opus 5.5"
                value={draftName}
                onChange={(event) => setDraftName(event.currentTarget.value)}
              />
              <Button size="xs" type="submit" disabled={!draftName.trim()}>
                Create
              </Button>
              <Button size="xs" variant="ghost" type="button" onClick={() => setDraftName(null)}>
                Cancel
              </Button>
            </form>
          }
        />
      ) : null}
      {entries.length === 0 && draftName === null ? (
        <SettingsRow
          title="No model pools."
          description="A pool lets you pick one model by name and have T3 choose which account pays for it, moving on when one runs out."
        />
      ) : null}
      {entries.map(([id, pool]) => (
        <ModelPoolEditor
          key={id}
          pool={pool}
          providers={providers}
          readOnly={readOnly}
          onUpdate={(next) => save(id, next)}
          onDelete={() => save(id, null)}
        />
      ))}
    </SettingsSection>
  );
}

function ModelPoolEditor({
  pool,
  providers,
  readOnly,
  onUpdate,
  onDelete,
}: {
  readonly pool: ModelPoolConfig;
  readonly providers: ReadonlyArray<ServerProvider>;
  readonly readOnly: boolean;
  readonly onUpdate: (next: ModelPoolConfig) => void;
  readonly onDelete: () => void;
}) {
  const strategy = pool.policy?.strategy ?? "spend";
  const reserve = pool.policy?.reservePercent;
  const switchOnLimit = modelPoolSwitchOnLimitOf(pool.policy);
  const keys = pool.slots.map(slotKeyOf);
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );
  const choices = slotChoices(pool, providers);
  const nowMs = Date.parse(useNowMinute());
  const limitPercent = modelPoolLimitPercentOf(pool);

  const handleDragEnd = (event: DragEndEvent) => {
    if (event.over === null || event.active.id === event.over.id) return;
    const from = keys.indexOf(String(event.active.id));
    const to = keys.indexOf(String(event.over.id));
    onUpdate(withSlots(pool, arrayMove([...pool.slots], from, to)));
  };

  return (
    <div className="border-t border-border/60 first:border-t-0" data-model-pool={pool.displayName}>
      <SettingsRow
        title={
          <span className="inline-flex items-center gap-2">
            {pool.displayName}
            <Badge variant="outline" size="sm">
              Pool
            </Badge>
          </span>
        }
        description={
          strategy === "order"
            ? "New threads use the first account in your order with allowance left. A thread keeps its account while it has allowance."
            : "New threads use the account whose allowance would lapse unused soonest. A thread keeps its account while it has allowance."
        }
        control={
          <div className="flex items-center gap-2">
            <Select
              value={strategy}
              disabled={readOnly}
              onValueChange={(value) =>
                onUpdate(
                  withModelPoolPolicy(pool, { strategy: value === "order" ? "order" : "spend" }),
                )
              }
            >
              <SelectTrigger
                size="sm"
                className="w-full sm:w-64"
                aria-label={`How ${pool.displayName} picks`}
              >
                <SelectValue>{STRATEGY_LABELS[strategy]}</SelectValue>
              </SelectTrigger>
              <SelectPopup align="end" alignItemWithTrigger={false}>
                {(Object.keys(STRATEGY_LABELS) as Array<keyof typeof STRATEGY_LABELS>).map(
                  (key) => (
                    <SelectItem hideIndicator key={key} value={key}>
                      {STRATEGY_LABELS[key]}
                    </SelectItem>
                  ),
                )}
              </SelectPopup>
            </Select>
            {!readOnly ? <DeletePoolButton name={pool.displayName} onConfirm={onDelete} /> : null}
          </div>
        }
      />
      <SettingsRow
        title="Accounts"
        description="Drag to set your order. Switch an account off to keep it out of the pool without removing it."
        status={
          <div className="pt-1">
            {pool.slots.length === 0 ? (
              <p className="py-1.5 text-xs text-muted-foreground">No accounts yet.</p>
            ) : (
              <DndContext
                sensors={sensors}
                collisionDetection={closestCenter}
                modifiers={[restrictToVerticalAxis, restrictToParentElement]}
                onDragEnd={handleDragEnd}
              >
                <SortableContext items={keys} strategy={verticalListSortingStrategy}>
                  <ol aria-label={`${pool.displayName} accounts, most preferred first`}>
                    {pool.slots.map((slot, index) => {
                      const key = slotKeyOf(slot);
                      const provider = providers.find(
                        (candidate) => candidate.instanceId === slot.providerInstanceId,
                      );
                      const standing = slotStanding(provider, slot.model, nowMs, limitPercent);
                      return (
                        <SortableSlotRow
                          key={key}
                          id={key}
                          account={slotAccountLabel(slot, providers)}
                          model={slotModelLabel(slot, providers)}
                          missing={provider === undefined}
                          standing={standing}
                          position={index + 1}
                          enabled={isModelPoolSlotEnabled(slot)}
                          readOnly={readOnly}
                          onEnabledChange={(enabled) =>
                            onUpdate(withSlotEnabled(pool, key, enabled))
                          }
                          onRemove={() =>
                            onUpdate(
                              withSlots(
                                pool,
                                pool.slots.filter((entry) => slotKeyOf(entry) !== key),
                              ),
                            )
                          }
                        />
                      );
                    })}
                  </ol>
                </SortableContext>
              </DndContext>
            )}
            {!readOnly && choices.length > 0 ? (
              <Select
                value={null}
                onValueChange={(value) => {
                  const choice = choices
                    .flatMap((group) => group.choices)
                    .find((entry) => slotKeyOf(entry.slot) === value);
                  if (choice) onUpdate(withSlots(pool, [...pool.slots, choice.slot]));
                }}
              >
                <SelectTrigger
                  size="sm"
                  className="mt-1 w-full sm:w-72"
                  aria-label={`Add an account to ${pool.displayName}`}
                >
                  <SelectValue placeholder="Add an account…" />
                </SelectTrigger>
                <SelectPopup align="start" alignItemWithTrigger={false}>
                  {choices.map((group) => (
                    <SelectGroup key={group.account}>
                      <SelectGroupLabel>{group.account}</SelectGroupLabel>
                      {group.choices.map((choice) => (
                        <SelectItem
                          hideIndicator
                          key={slotKeyOf(choice.slot)}
                          value={slotKeyOf(choice.slot)}
                        >
                          {choice.model}
                        </SelectItem>
                      ))}
                    </SelectGroup>
                  ))}
                </SelectPopup>
              </Select>
            ) : null}
          </div>
        }
      />
      <SettingsRow
        title="Keep in reserve"
        description="Treat an account as out once it is this much used, so new threads and switches leave the rest alone. A running thread stays until the real limit."
        control={
          <Select
            value={reserve === undefined ? NO_RESERVE : String(reserve)}
            disabled={readOnly}
            onValueChange={(value) =>
              onUpdate(
                withModelPoolPolicy(pool, {
                  reservePercent: value === NO_RESERVE ? null : Number(value),
                }),
              )
            }
          >
            <SelectTrigger
              size="sm"
              className="w-full sm:w-44"
              aria-label={`${pool.displayName} reserve`}
            >
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
        description="Continue the thread on the next account with allowance, or wait for the reset."
        control={
          <Select
            value={switchOnLimit}
            disabled={readOnly}
            onValueChange={(value) =>
              onUpdate(
                withModelPoolPolicy(pool, {
                  switchOnLimit: value === "always" || value === "never" ? value : "global",
                }),
              )
            }
          >
            <SelectTrigger
              size="sm"
              className="w-full sm:w-52"
              aria-label={`${pool.displayName} on limit`}
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
    </div>
  );
}

const STANDING_LABELS = {
  available: "Has allowance",
  unknown: "No reading",
  out: "Out",
} as const;

function SortableSlotRow({
  id,
  account,
  model,
  missing,
  standing,
  position,
  enabled,
  readOnly,
  onEnabledChange,
  onRemove,
}: {
  readonly id: string;
  readonly account: string;
  readonly model: string;
  readonly missing: boolean;
  readonly standing: keyof typeof STANDING_LABELS;
  readonly position: number;
  readonly enabled: boolean;
  readonly readOnly: boolean;
  readonly onEnabledChange: (enabled: boolean) => void;
  readonly onRemove: () => void;
}) {
  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id, disabled: readOnly });
  const label = `${model} on ${account}`;
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
        {account}
        <span className="text-muted-foreground"> · {model}</span>
      </span>
      <Badge
        variant={
          missing || standing === "unknown" ? "outline" : standing === "out" ? "error" : "success"
        }
        size="sm"
      >
        {missing ? "Not installed" : STANDING_LABELS[standing]}
      </Badge>
      <Switch
        checked={enabled}
        disabled={readOnly}
        onCheckedChange={(checked) => onEnabledChange(Boolean(checked))}
        aria-label={`Use ${label}`}
      />
      {!readOnly ? (
        <Button
          size="icon-xs"
          variant="ghost-muted"
          aria-label={`Remove ${label}`}
          onClick={onRemove}
        >
          <Trash2Icon />
        </Button>
      ) : null}
    </li>
  );
}

function DeletePoolButton({
  name,
  onConfirm,
}: {
  readonly name: string;
  readonly onConfirm: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="xs" variant="ghost" onClick={() => setOpen(true)}>
        Delete
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Delete {name}?</AlertDialogTitle>
            <AlertDialogDescription>
              Threads on this pool keep the account they last ran on. The accounts themselves are
              untouched.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                setOpen(false);
                onConfirm();
              }}
            >
              Delete pool
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}
