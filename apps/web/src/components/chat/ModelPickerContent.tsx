import { T, useGT, useLocale, useMessages } from "gt-react";
import { useLegendListRef } from "~/hooks/useLegendListRef";
import {
  ANTIGRAVITY_DEFAULT_MODEL,
  type ProviderInstanceId,
  type EnvironmentId,
  type ProviderDriverKind,
  type ResolvedKeybindingsConfig,
  MODEL_PICKER_JUMP_KEYBINDING_COMMANDS,
} from "@t3tools/contracts";
import { resolveSelectableModel } from "@t3tools/shared/model";
import { useAtomValue } from "@effect/atom-react";
import { formatProviderUpdateRequiredNotice } from "@t3tools/client-runtime/providerUpdateRequiredModels";
import { useNavigate } from "@tanstack/react-router";
import { LegendList, type LegendListRef } from "@legendapp/list/react";
import {
  DndContext,
  type DragEndEvent,
  PointerSensor,
  closestCenter,
  useDndMonitor,
  useSensor,
  useSensors,
} from "@dnd-kit/core";
import { restrictToVerticalAxis } from "@dnd-kit/modifiers";
import { SortableContext, useSortable, verticalListSortingStrategy } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";
import { GripVerticalIcon } from "lucide-react";
import {
  createContext,
  memo,
  use,
  useState,
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  type ReactNode,
  type RefObject,
} from "react";
import { ModelListRow } from "./ModelListRow";
import { ModelPickerSidebar } from "./ModelPickerSidebar";
import { useProviderWorkspaceSnapshotRefresh } from "./useProviderWorkspaceSnapshotRefresh";
import { getProviderStatusMessage, hasProviderSetup } from "./ProviderStatusBanner";
import {
  modelPickerLegacySectionKey,
  modelPickerModelKey,
  parseModelPickerLegacySectionKey,
  parseModelPickerModelKey,
} from "./modelPickerKeys";
import type { ModelPickerPooling } from "./modelPickerPooling";
import { usePooledPickerEntries } from "./PooledModelEntries";
import { rankModelPickerSearch } from "@t3tools/client-runtime/model-search";
import {
  Combobox,
  ComboboxEmpty,
  ComboboxSearchInput,
  ComboboxItem,
  ComboboxListVirtualized,
} from "../ui/combobox";
import { getDisplayModelName, ModelEsque } from "./providerIconUtils";
import { getCustomModelLabel, saveModelLabel, selectModelSlotLabels } from "./modelLabels";
import { isCommandPaletteOpen } from "../../commandPaletteBus";
import { registerModelPickerContent } from "../../modelPickerVisibility";
import { primaryServerKeybindingsAtom } from "../../state/server";
import {
  modelPickerJumpCommandForIndex,
  modelPickerJumpIndexFromCommand,
  resolveShortcutCommand,
  shortcutLabelForCommand,
} from "../../keybindings";
import {
  useClientSettings,
  useEnvironmentModelPreferences,
  useToggleSharedModelFavorite,
  useUpdateEnvironmentModelPreferences,
} from "~/hooks/useSettings";
import { announce } from "~/lib/announce";
import { cn } from "~/lib/utils";
import { getVirtualizedScrollFadeClassName } from "../ui/scroll-area";
import { TooltipProvider } from "../ui/tooltip";
import { InlineButton } from "../ui/button";
import {
  isProviderInstancePickerReady,
  isProviderInstancePickerVisible,
  shouldShowInstanceBadge,
  type ProviderInstanceEntry,
} from "../../providerInstances";
import { moveFavorite, providerModelKey, sortProviderModelItems } from "../../modelOrdering";
import { resolveModelPickerSelectedModel } from "../../modelSelection";
import { FAVORITE_SLOTS } from "./device/favoriteSlots.logic";
import { hasRuntimeModelCatalog } from "../../providerModels";

type ModelPickerItem = {
  slug: string;
  name: string;
  shortName?: string;
  subProvider?: string;
  badge?: "new";
  instanceId: ProviderInstanceId;
  driverKind: ProviderDriverKind;
  instanceDisplayName: string;
  instanceAccentColor?: string | undefined;
  acpRegistryAgentId?: string | undefined;
  acpRegistryIconUrl?: string | undefined;
  continuationGroupKey?: string | undefined;
  isLegacy?: boolean | undefined;
  isUnavailable?: boolean | undefined;
};

function shouldIncludeModelPickerOption(input: {
  readonly entry: ProviderInstanceEntry;
  readonly option: ModelEsque;
  readonly activeInstanceId: ProviderInstanceId;
  readonly activeModel: string;
}): boolean {
  if (input.entry.driverKind === "antigravity" && input.option.slug === ANTIGRAVITY_DEFAULT_MODEL) {
    return false;
  }
  if (isProviderInstancePickerReady(input.entry)) return true;
  return (
    input.entry.enabled &&
    hasRuntimeModelCatalog(input.entry.driverKind) &&
    input.entry.instanceId === input.activeInstanceId &&
    input.option.slug === input.activeModel &&
    input.option.isUnavailable === true
  );
}

function shouldOfferModelPickerSetup(
  entry: ProviderInstanceEntry,
  options: ReadonlyArray<ModelEsque>,
): boolean {
  return (
    entry.enabled &&
    entry.status !== "disabled" &&
    hasProviderSetup(entry.snapshot) &&
    (!isProviderInstancePickerReady(entry) ||
      !entry.installed ||
      entry.snapshot.auth.status === "unauthenticated" ||
      !options.some((option) => !option.isUnavailable))
  );
}

function adjacentModelPickerProvider(input: {
  entries: ReadonlyArray<ProviderInstanceEntry>;
  selectedInstanceId: ProviderInstanceId | "favorites";
  direction: 1 | -1;
  disabledInstanceIds: ReadonlySet<ProviderInstanceId> | undefined;
  selectableUnavailableInstanceIds: ReadonlySet<ProviderInstanceId> | undefined;
}) {
  const providers: Array<ProviderInstanceId | "favorites"> = [
    "favorites",
    ...input.entries
      .filter(
        (entry) =>
          !input.disabledInstanceIds?.has(entry.instanceId) &&
          (isProviderInstancePickerReady(entry) ||
            input.selectableUnavailableInstanceIds?.has(entry.instanceId)),
      )
      .map((entry) => entry.instanceId),
  ];
  const index = providers.indexOf(input.selectedInstanceId);
  return providers[
    index < 0
      ? input.direction === 1
        ? 0
        : providers.length - 1
      : (index + input.direction + providers.length) % providers.length
  ]!;
}

const EMPTY_MODEL_JUMP_LABELS = new Map<string, string>();
const MODEL_LIST_ESTIMATED_ITEM_SIZE = 32;
// Rendered heights in `--spacing` units. Chrome is the search box and list padding, plus a 1px border.
const ROW_UNITS = 8;
const ROW_SEPARATOR_UNITS = 0.5;
const COMPOSER_DIVIDER_UNITS = 6;
const LIST_CHROME_UNITS = 15.5;

/** The last favourite the composer slider shows, when more favourites follow it. */
const ComposerBoundaryContext = createContext<string | null>(null);

function ModelListSeparator({ leadingItem }: { leadingItem: string }) {
  if (use(ComposerBoundaryContext) !== leadingItem) return <div className="h-0.5" />;
  return (
    <div className="flex h-6 items-center gap-2 px-2 text-2xs text-muted-foreground/70">
      <span>
        <T>On the composer ↑</T>
      </span>
      <span className="h-px flex-1 bg-border/70" />
    </div>
  );
}

/** A favourite in the Favorites tab: the whole row drags, and its logo turns into a grip on hover. */
function SortableModelListRow(
  props: Omit<React.ComponentProps<typeof ModelListRow>, "dragHandle"> & { sortableId: string },
) {
  const { sortableId, ...rowProps } = props;
  // No sortable attributes: focus stays in the search box, and Alt+Up/Down moves the highlighted row.
  const { listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: sortableId,
  });
  // The click that ends a drag must not also pick the dropped model; it fires before this timer.
  const draggingRef = useRef(false);
  const settle = () => window.setTimeout(() => (draggingRef.current = false));
  useDndMonitor({
    onDragStart: () => (draggingRef.current = true),
    onDragEnd: settle,
    onDragCancel: settle,
  });
  return (
    <div
      ref={setNodeRef}
      // Capture, ahead of the item's own capture handler: it prevents default, and a prevented
      // press never starts a dnd-kit drag.
      onPointerDownCapture={(event) => listeners?.onPointerDown?.(event)}
      style={{ transform: CSS.Translate.toString(transform), transition }}
      className={cn("relative rounded-sm", isDragging && "z-10 bg-popover shadow-md")}
      onClickCapture={(event) => {
        if (!draggingRef.current) return;
        event.preventDefault();
        event.stopPropagation();
      }}
    >
      <ModelListRow
        {...rowProps}
        dragHandle={
          <span
            aria-hidden="true"
            className="pointer-events-none absolute inset-y-0 left-0 hidden w-8 items-center justify-center group-hover:flex pointer-coarse:flex"
          >
            <GripVerticalIcon className="size-3.5 text-muted-foreground" />
          </span>
        }
      />
    </div>
  );
}

function modelJumpLabelsByKey(
  modelKeys: ReadonlyArray<string>,
  keybindings: ResolvedKeybindingsConfig,
  terminalOpen: boolean,
): ReadonlyMap<string, string> {
  const shortcutLabelOptions = {
    platform: navigator.platform,
    context: { terminalFocus: false, terminalOpen, modelPickerOpen: true },
  };
  const mapping = new Map<string, string>();
  for (const [index, modelKey] of modelKeys.entries()) {
    const command = modelPickerJumpCommandForIndex(index);
    const label = command && shortcutLabelForCommand(keybindings, command, shortcutLabelOptions);
    if (label) {
      mapping.set(modelKey, label);
    }
  }
  return mapping.size > 0 ? mapping : EMPTY_MODEL_JUMP_LABELS;
}

function ModelPickerProviderNotices({
  setupEntries,
  updateRequiredNotices,
  emptyLabel,
  onRequestClose,
  onOpenProviderSetup,
}: {
  setupEntries: ReadonlyArray<ProviderInstanceEntry>;
  emptyLabel: string;
  updateRequiredNotices: ReadonlyArray<{ instanceId: ProviderInstanceId; notice: string }>;
  onRequestClose: (() => void) | undefined;
  onOpenProviderSetup: ((instanceId: ProviderInstanceId) => void) | undefined;
}) {
  const gt = useGT();
  const messages = useMessages();
  const navigate = useNavigate();
  return (
    <>
      {setupEntries.length > 0 ? (
        <div className="max-h-44 shrink-0 overflow-y-auto border-t border-border/70 p-2">
          {setupEntries.map((entry) => (
            <div key={entry.instanceId} className="px-1 py-1.5 text-xs leading-snug">
              <p className="line-clamp-3 text-muted-foreground">
                {getProviderStatusMessage(entry.snapshot, messages)}
              </p>
              <InlineButton
                className="mt-1"
                onClick={() => {
                  onRequestClose?.();
                  onOpenProviderSetup?.(entry.instanceId);
                }}
              >
                {setupEntries.length > 1
                  ? gt("Set up {provider}", { provider: entry.displayName })
                  : gt("Open provider setup")}
              </InlineButton>
            </div>
          ))}
        </div>
      ) : (
        <ComboboxEmpty className="empty:h-0">{emptyLabel}</ComboboxEmpty>
      )}
      {updateRequiredNotices.map(({ instanceId, notice }) => (
        <p
          key={instanceId}
          className="shrink-0 border-t border-border/70 px-3 py-2 text-xs leading-snug text-muted-foreground"
        >
          {notice}{" "}
          <InlineButton
            onClick={() => {
              onRequestClose?.();
              void navigate({ to: "/settings/providers" });
            }}
          >
            <T>Provider settings</T>
          </InlineButton>
        </p>
      ))}
    </>
  );
}

function ModelPickerList({
  listRef,
  itemKeys,
  extraData,
  renderItem,
  sortable,
}: {
  listRef: RefObject<LegendListRef | null>;
  itemKeys: ReadonlyArray<string>;
  extraData: unknown;
  renderItem: (props: { item: string; index: number }) => ReactNode;
  /** Lets every row be dragged to a new place; `onMove` gets the dragged key and the one it took. */
  sortable?: { onMove: (key: string, targetKey: string) => void } | undefined;
}) {
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }));
  const [showTopScrollFade, setShowTopScrollFade] = useState(false);
  const [showBottomScrollFade, setShowBottomScrollFade] = useState(false);
  const updateScrollFades = () => {
    const metrics = listRef.current?.getState();
    if (!metrics) return;
    setShowTopScrollFade(!metrics.isAtStart);
    setShowBottomScrollFade(!metrics.isAtEnd);
  };
  const scrollRef = useLegendListRef(listRef, updateScrollFades);

  return (
    <div
      className={cn(
        "relative min-h-0 overflow-hidden pr-px",
        itemKeys.length > 0 ? "flex-1" : "h-0",
      )}
    >
      <ComboboxListVirtualized>
        <DndContext
          sensors={sensors}
          collisionDetection={closestCenter}
          modifiers={[restrictToVerticalAxis]}
          onDragEnd={(event: DragEndEvent) => {
            if (event.over === null || event.active.id === event.over.id) return;
            sortable?.onMove(String(event.active.id), String(event.over.id));
          }}
        >
          <SortableContext
            items={sortable ? [...itemKeys] : []}
            strategy={verticalListSortingStrategy}
          >
            <LegendList<string>
              ref={scrollRef}
              data={itemKeys}
              extraData={extraData}
              keyExtractor={(modelKey) => modelKey}
              renderItem={renderItem}
              estimatedItemSize={MODEL_LIST_ESTIMATED_ITEM_SIZE}
              drawDistance={480}
              recycleItems
              contentContainerClassName="pl-2 pr-px"
              ItemSeparatorComponent={ModelListSeparator}
              onLayout={updateScrollFades}
              onScroll={updateScrollFades}
              onReady={updateScrollFades}
              className={cn(
                "scrollbar-gutter-stable h-full overflow-x-hidden overscroll-y-contain py-1.5 [&::-webkit-scrollbar-track]:my-2",
                getVirtualizedScrollFadeClassName({
                  top: showTopScrollFade,
                  bottom: showBottomScrollFade,
                }),
              )}
            />
          </SortableContext>
        </DndContext>
      </ComboboxListVirtualized>
    </div>
  );
}

// Capture gives picker shortcuts priority over the composer.
function WindowKeyDownListener({ onKeyDown }: { onKeyDown: (event: KeyboardEvent) => void }) {
  const handleKeyDown = useEffectEvent(onKeyDown);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes a capture-phase window keydown listener for the picker's lifetime
  useEffect(() => {
    const listener = (event: KeyboardEvent) => handleKeyDown(event);
    window.addEventListener("keydown", listener, true);
    return () => {
      window.removeEventListener("keydown", listener, true);
    };
  }, []);
  return null;
}

export const ModelPickerContent = memo(function ModelPickerContent(props: {
  environmentId: EnvironmentId | null;
  /** Keeps the open provider tab's catalog fresh for this directory. */
  workspaceCwd?: string | null;
  activeInstanceId: ProviderInstanceId;
  model: string;
  selectedModels?: ReadonlyArray<{ instanceId: ProviderInstanceId; model: string }>;
  onToggleModel?: (instanceId: ProviderInstanceId, model: string) => void;
  lockedProvider: ProviderDriverKind | null;
  lockedContinuationGroupKey?: string | null;
  instanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  keybindings?: ResolvedKeybindingsConfig;
  modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<ModelEsque>>;
  terminalOpen: boolean;
  onRequestClose?: () => void;
  onOpenProviderSetup?: (instanceId: ProviderInstanceId) => void;
  getModelDisabledReason?: (instanceId: ProviderInstanceId, model: string) => string | null;
  onInstanceModelChange: (instanceId: ProviderInstanceId, model: string) => void;
  /** The owning popup moves focus here when it opens (its `initialFocus`). */
  searchInputRef: RefObject<HTMLInputElement | null>;
  /** Sits beside an effort column: fills the shared row, and stacks above it on narrow screens. */
  docked?: boolean;
  /** Right at the end of the search text moves into the popup's effort column. */
  onFocusEffort?: () => void;
  /** Closes the list column, inside the popup's fixed height. */
  listFooter?: ReactNode;
  /** Models several accounts serve, listed above Favorites and in search. */
  pooling?: ModelPickerPooling;
}) {
  const gt = useGT();
  const messages = useMessages();
  const locale = useLocale();
  const {
    searchInputRef,
    keybindings: providedKeybindings,
    modelOptionsByInstance,
    instanceEntries,
    getModelDisabledReason,
    onInstanceModelChange,
    onToggleModel,
    onRequestClose,
    onOpenProviderSetup,
  } = props;
  const [searchQuery, setSearchQuery] = useState("");
  const modelListRef = useRef<LegendListRef | null>(null);
  const pickerContentRef = useRef<HTMLDivElement>(null);
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- publishes this picker's mount to global keydown handlers
  useLayoutEffect(() => registerModelPickerContent(), []);
  const highlightedModelKeyRef = useRef<string | null>(null);
  const { favorites: savedFavorites } = useEnvironmentModelPreferences(props.environmentId);
  const saveModelPreferences = useUpdateEnvironmentModelPreferences(props.environmentId);
  // A move shows at once and gives way when the saved favourites change.
  const [pendingFavoriteOrder, setPendingFavoriteOrder] = useState<{
    saved: typeof savedFavorites;
    next: typeof savedFavorites;
  } | null>(null);
  const favorites =
    pendingFavoriteOrder?.saved === savedFavorites ? pendingFavoriteOrder.next : savedFavorites;
  const handleMoveFavorite = async (key: string, targetKey: string) => {
    const next = moveFavorite(favorites, key, targetKey);
    if (!next) return;
    setPendingFavoriteOrder({ saved: savedFavorites, next });
    const result = await saveModelPreferences({ favorites: next });
    if (result?._tag !== "Success") setPendingFavoriteOrder(null);
  };
  const activeEntry = props.instanceEntries.find(
    (entry) => entry.instanceId === props.activeInstanceId,
  );
  const activeModel = resolveModelPickerSelectedModel({
    driverKind: activeEntry?.driverKind,
    model: props.model,
    options: modelOptionsByInstance.get(props.activeInstanceId) ?? [],
  });
  const activeModelSlug =
    activeModel?.slug ?? (props.model === ANTIGRAVITY_DEFAULT_MODEL ? "" : props.model);
  const activeModelKey = activeModelSlug
    ? modelPickerModelKey(props.activeInstanceId, activeModelSlug)
    : null;
  const selectedModelKeys = props.selectedModels?.map((selection) => {
    const entry = instanceEntries.find((entry) => entry.instanceId === selection.instanceId);
    const model = resolveModelPickerSelectedModel({
      driverKind: entry?.driverKind,
      model: selection.model,
      options: modelOptionsByInstance.get(selection.instanceId) ?? [],
    });
    return modelPickerModelKey(selection.instanceId, model?.slug ?? selection.model);
  });
  const selectedModelKeySet = new Set(
    selectedModelKeys ?? (activeModelKey ? [activeModelKey] : []),
  );
  const activeInstanceHasSelectableUnavailableModel =
    activeEntry !== undefined &&
    (modelOptionsByInstance.get(props.activeInstanceId) ?? []).some((option) =>
      shouldIncludeModelPickerOption({
        entry: activeEntry,
        option,
        activeInstanceId: props.activeInstanceId,
        activeModel: activeModelSlug,
      }),
    ) &&
    !isProviderInstancePickerReady(activeEntry);
  const activeInstanceNeedsSetup =
    onOpenProviderSetup !== undefined &&
    activeEntry !== undefined &&
    shouldOfferModelPickerSetup(
      activeEntry,
      modelOptionsByInstance.get(props.activeInstanceId) ?? [],
    );
  const [selectedInstanceId, setSelectedInstanceId] = useState<ProviderInstanceId | "favorites">(
    () => {
      if (
        props.lockedProvider !== null ||
        activeInstanceHasSelectableUnavailableModel ||
        activeInstanceNeedsSetup
      ) {
        return props.activeInstanceId;
      }
      // Pooled models live on the Favorites tab, so a thread on one opens there.
      if (props.pooling?.active) return "favorites";
      const hasPickableFavorite = favorites.some((favorite) => {
        const entry = instanceEntries.find((entry) => entry.instanceId === favorite.provider);
        return (
          entry !== undefined &&
          (modelOptionsByInstance.get(favorite.provider) ?? []).some(
            (option) =>
              option.slug === favorite.model &&
              shouldIncludeModelPickerOption({
                entry,
                option,
                activeInstanceId: props.activeInstanceId,
                activeModel: activeModelSlug,
              }),
          )
        );
      });
      const hasPools = (props.pooling?.models.length ?? 0) > 0;
      return hasPickableFavorite || hasPools ? "favorites" : props.activeInstanceId;
    },
  );
  const { scanning: workspaceModelsScanning } = useProviderWorkspaceSnapshotRefresh({
    environmentId: props.environmentId,
    gitCwd: props.workspaceCwd ?? null,
    instanceId: selectedInstanceId === "favorites" ? undefined : selectedInstanceId,
  });
  const favoritesSet = new Set(favorites.map((fav) => providerModelKey(fav.provider, fav.model)));
  const [expandedLegacyInstances, setExpandedLegacyInstances] = useState(
    () =>
      new Set<ProviderInstanceId>(
        activeModel?.isLegacy &&
          !favoritesSet.has(providerModelKey(props.activeInstanceId, activeModelSlug))
          ? [props.activeInstanceId]
          : [],
      ),
  );
  const serverKeybindings = useAtomValue(primaryServerKeybindingsAtom);
  const keybindings = providedKeybindings ?? serverKeybindings;
  const [searchHeight, setSearchHeight] = useState(0);
  const slotLabels = useClientSettings(selectModelSlotLabels);
  const [renamingModelKey, setRenamingModelKey] = useState<string | null>(null);
  const toggleFavorite = useToggleSharedModelFavorite(props.environmentId);

  const focusSearchInput = () => {
    searchInputRef.current?.focus({ preventScroll: true });
  };

  const handleStartRename = (instanceId: ProviderInstanceId, slug: string) => {
    setRenamingModelKey(modelPickerModelKey(instanceId, slug));
  };

  const handleCommitRename = (
    instanceId: ProviderInstanceId,
    slug: string,
    nextName: string,
    restoreFocus: boolean,
  ) => {
    const model = modelOptionsByInstance.get(instanceId)?.find((option) => option.slug === slug);
    saveModelLabel({
      slotLabels,
      instanceId,
      slug,
      nextName,
      ...(model ? { defaultNames: [getDisplayModelName(model), model.name] } : {}),
    });
    setRenamingModelKey(null);
    if (restoreFocus) {
      focusSearchInput();
    }
  };

  const handleCancelRename = () => {
    setRenamingModelKey(null);
    focusSearchInput();
  };

  const handleSelectInstance = (instanceId: ProviderInstanceId | "favorites") => {
    setRenamingModelKey(null);
    setSelectedInstanceId(instanceId);
    // Focusing the search on touch raises the on-screen keyboard on every provider tap.
    if (window.matchMedia("(pointer: coarse)").matches) return;
    window.requestAnimationFrame(() => {
      focusSearchInput();
    });
  };

  const toggleLegacySection = (instanceId: ProviderInstanceId) => {
    setExpandedLegacyInstances((expanded) => {
      const next = new Set(expanded);
      if (next.has(instanceId)) {
        next.delete(instanceId);
      } else {
        next.add(instanceId);
      }
      return next;
    });
  };

  const handleModelSelect = (
    modelSlug: string,
    instanceId: ProviderInstanceId,
    additive = false,
  ): string | null => {
    if (getModelDisabledReason?.(instanceId, modelSlug)) {
      return null;
    }
    const options = modelOptionsByInstance.get(instanceId);
    if (!options) {
      return null;
    }
    const entry = instanceEntries.find((candidate) => candidate.instanceId === instanceId);
    if (!entry) {
      return null;
    }
    const resolvedModel = resolveSelectableModel(entry.driverKind, modelSlug, options);
    if (!resolvedModel) return null;
    if (additive && onToggleModel) {
      onToggleModel(instanceId, resolvedModel);
    } else {
      onInstanceModelChange(instanceId, resolvedModel);
    }
    return resolvedModel;
  };

  const modelJumpShortcutContext = {
    terminalFocus: false,
    terminalOpen: props.terminalOpen,
    modelPickerOpen: true,
  } as const;
  const lockedProvider = props.lockedProvider;
  const lockedContinuationGroupKey = props.lockedContinuationGroupKey;
  const canOpenProviderSetup = onOpenProviderSetup !== undefined;

  const entryByInstanceId = new Map(instanceEntries.map((entry) => [entry.instanceId, entry]));
  const matchesLockedProvider = (
    entry: Pick<ProviderInstanceEntry, "driverKind" | "continuationGroupKey">,
  ): boolean => {
    if (lockedProvider === null) return true;
    if (entry.driverKind !== lockedProvider) return false;
    if (!lockedContinuationGroupKey) return true;
    return entry.continuationGroupKey === lockedContinuationGroupKey;
  };

  const selectableUnavailableInstanceIds = (() => {
    const instanceIds = new Set<ProviderInstanceId>();
    if (activeInstanceHasSelectableUnavailableModel) {
      instanceIds.add(props.activeInstanceId);
    }
    if (canOpenProviderSetup) {
      for (const entry of instanceEntries) {
        if (
          shouldOfferModelPickerSetup(entry, modelOptionsByInstance.get(entry.instanceId) ?? [])
        ) {
          instanceIds.add(entry.instanceId);
        }
      }
    }
    return instanceIds.size > 0 ? instanceIds : undefined;
  })();

  const flatModels = (() => {
    const out: ModelPickerItem[] = [];
    const seenKeys = new Set<string>();
    for (const [instanceId, models] of modelOptionsByInstance) {
      const entry = entryByInstanceId.get(instanceId);
      if (!entry) {
        continue;
      }
      for (const model of models) {
        const key = modelPickerModelKey(instanceId, model.slug);
        if (
          seenKeys.has(key) ||
          !shouldIncludeModelPickerOption({
            entry,
            option: model,
            activeInstanceId: props.activeInstanceId,
            activeModel: activeModelSlug,
          })
        ) {
          continue;
        }
        seenKeys.add(key);
        out.push({
          slug: model.slug,
          name: model.name,
          ...(model.shortName ? { shortName: model.shortName } : {}),
          ...(model.subProvider ? { subProvider: model.subProvider } : {}),
          ...(model.badge ? { badge: model.badge } : {}),
          ...(model.isLegacy ? { isLegacy: true } : {}),
          ...(model.isUnavailable ? { isUnavailable: true } : {}),
          instanceId,
          driverKind: entry.driverKind,
          instanceDisplayName: entry.displayName,
          ...(entry.accentColor ? { instanceAccentColor: entry.accentColor } : {}),
          ...(entry.acpRegistryAgentId ? { acpRegistryAgentId: entry.acpRegistryAgentId } : {}),
          ...(entry.acpRegistryIconUrl ? { acpRegistryIconUrl: entry.acpRegistryIconUrl } : {}),
          ...(entry.continuationGroupKey
            ? { continuationGroupKey: entry.continuationGroupKey }
            : {}),
        });
      }
    }
    return out;
  })();

  const isLocked = lockedProvider !== null;
  const isSearching = searchQuery.trim().length > 0;
  // Fit the tallest tab so switching tabs never resizes the popup and moves the rail under the cursor.
  const tallestTabUnits = (() => {
    const unitsByTab = new Map<ProviderInstanceId | "favorites", number>();
    const addRow = (tab: ProviderInstanceId | "favorites") => {
      const previous = unitsByTab.get(tab);
      unitsByTab.set(
        tab,
        previous === undefined ? ROW_UNITS : previous + ROW_SEPARATOR_UNITS + ROW_UNITS,
      );
    };
    const tabsWithLegacyRow = new Set<ProviderInstanceId>();
    let favoriteRows = 0;
    for (const model of flatModels) {
      if (!matchesLockedProvider(model)) continue;
      const isFavorite = favoritesSet.has(providerModelKey(model.instanceId, model.slug));
      if (isFavorite) {
        addRow("favorites");
        favoriteRows += 1;
      }
      if (model.isLegacy && !isFavorite) {
        tabsWithLegacyRow.add(model.instanceId);
      } else {
        addRow(model.instanceId);
      }
    }
    for (const instanceId of tabsWithLegacyRow) addRow(instanceId);
    const favoriteUnits = unitsByTab.get("favorites");
    if (!isLocked && favoriteUnits !== undefined && favoriteRows > FAVORITE_SLOTS) {
      unitsByTab.set("favorites", favoriteUnits + COMPOSER_DIVIDER_UNITS - ROW_SEPARATOR_UNITS);
    }
    return Math.max(0, ...unitsByTab.values());
  })();
  const lockedDisabledInstanceIds = (() => {
    if (!isLocked) {
      return undefined;
    }
    const disabled = new Set<ProviderInstanceId>();
    for (const entry of instanceEntries) {
      if (!matchesLockedProvider(entry)) {
        disabled.add(entry.instanceId);
      }
    }
    return disabled;
  })();
  const sidebarInstanceEntries = (() => {
    const enabledEntries = instanceEntries.filter(isProviderInstancePickerVisible);
    if (!isLocked) {
      return enabledEntries;
    }
    const available: ProviderInstanceEntry[] = [];
    const disabled: ProviderInstanceEntry[] = [];
    for (const entry of enabledEntries) {
      if (matchesLockedProvider(entry)) {
        available.push(entry);
      } else {
        disabled.push(entry);
      }
    }
    return [...available, ...disabled];
  })();
  const showSidebar = !isSearching && sidebarInstanceEntries.length > 0;
  const isArrangingFavorites = selectedInstanceId === "favorites" && !isSearching;

  const filteredModels = (() => {
    let result = flatModels;

    if (searchQuery.trim()) {
      const candidates =
        lockedProvider !== null ? result.filter((m) => matchesLockedProvider(m)) : result;
      return rankModelPickerSearch(candidates, searchQuery, (model) => {
        const customLabel = getCustomModelLabel(slotLabels, model.instanceId, model.slug);
        return {
          name: model.name,
          ...(customLabel ? { customName: customLabel } : {}),
          ...(model.shortName ? { shortName: model.shortName } : {}),
          ...(model.subProvider ? { subProvider: model.subProvider } : {}),
          driverKind: model.driverKind,
          providerDisplayName: model.instanceDisplayName,
          isFavorite: favoritesSet.has(providerModelKey(model.instanceId, model.slug)),
        };
      });
    }

    if (lockedProvider !== null) {
      result = result.filter((m) => matchesLockedProvider(m));
      if (selectedInstanceId === "favorites") {
        result = result.filter((m) => favoritesSet.has(providerModelKey(m.instanceId, m.slug)));
      } else {
        result = result.filter((m) => m.instanceId === selectedInstanceId);
      }
    } else if (selectedInstanceId === "favorites") {
      result = result.filter((m) => favoritesSet.has(providerModelKey(m.instanceId, m.slug)));
    } else {
      result = result.filter((m) => m.instanceId === selectedInstanceId);
    }

    return sortProviderModelItems(result, {
      favoriteModelKeys: favoritesSet,
      groupFavorites: selectedInstanceId !== "favorites",
      // Favorites keep the user's order, the order the composer slider takes its four from.
      keyOrder:
        selectedInstanceId === "favorites"
          ? favorites.map((favorite) => providerModelKey(favorite.provider, favorite.model))
          : [],
    });
  })();

  const legacySection = (() => {
    if (isSearching || selectedInstanceId === "favorites") {
      return null;
    }
    const currentModels: ModelPickerItem[] = [];
    const legacyModels: ModelPickerItem[] = [];
    for (const model of filteredModels) {
      const isLegacy =
        model.isLegacy && !favoritesSet.has(providerModelKey(model.instanceId, model.slug));
      (isLegacy ? legacyModels : currentModels).push(model);
    }
    if (legacyModels.length === 0) {
      return null;
    }
    return {
      key: modelPickerLegacySectionKey(selectedInstanceId),
      currentModels,
      legacyModels,
      isExpanded: expandedLegacyInstances.has(selectedInstanceId),
    };
  })();

  const visibleModels = (() => {
    if (!legacySection) {
      return filteredModels;
    }
    return [
      ...legacySection.currentModels,
      ...(legacySection.isExpanded ? legacySection.legacyModels : []),
    ];
  })();

  const pooled = usePooledPickerEntries({
    pooling: props.pooling,
    enabled: !isLocked,
    query: searchQuery,
    showWithoutQuery: selectedInstanceId === "favorites",
    favorites,
    onRenameEnd: (restoreFocus) => {
      if (restoreFocus) focusSearchInput();
    },
  });

  const selectedEntry =
    selectedInstanceId === "favorites" ? undefined : entryByInstanceId.get(selectedInstanceId);
  const providerSetupEntries =
    !isSearching && canOpenProviderSetup
      ? instanceEntries.filter(
          (entry) =>
            matchesLockedProvider(entry) &&
            shouldOfferModelPickerSetup(
              entry,
              modelOptionsByInstance.get(entry.instanceId) ?? [],
            ) &&
            (selectedEntry
              ? entry.instanceId === selectedEntry.instanceId
              : filteredModels.length === 0),
        )
      : [];

  const updateRequiredNotices = instanceEntries.flatMap((entry) => {
    const shown = isSearching
      ? matchesLockedProvider(entry)
      : entry.instanceId === selectedEntry?.instanceId;
    const notice = shown
      ? formatProviderUpdateRequiredNotice(entry.snapshot, searchQuery, messages, locale)
      : null;
    return notice ? [{ instanceId: entry.instanceId, notice }] : [];
  });

  const modelJumpModelKeys = visibleModels
    .filter((model) => !getModelDisabledReason?.(model.instanceId, model.slug))
    .slice(0, MODEL_PICKER_JUMP_KEYBINDING_COMMANDS.length)
    .map((model) => modelPickerModelKey(model.instanceId, model.slug));
  const allItemKeys = ((): string[] => [
    ...pooled.allKeys,
    ...flatModels.map((model) => modelPickerModelKey(model.instanceId, model.slug)),
    ...new Set(
      flatModels
        .filter((model) => model.isLegacy)
        .map((model) => modelPickerLegacySectionKey(model.instanceId)),
    ),
  ])();
  const filteredItemKeys = ((): string[] => {
    const modelKeys = visibleModels.map((model) =>
      modelPickerModelKey(model.instanceId, model.slug),
    );
    // The toggle trails the list, so expanding it reveals older models above it.
    return legacySection
      ? [...pooled.keys, ...modelKeys, legacySection.key]
      : [...pooled.keys, ...modelKeys];
  })();
  const filteredModelByKey = ((): ReadonlyMap<string, ModelPickerItem> =>
    new Map(
      visibleModels.map(
        (model) => [modelPickerModelKey(model.instanceId, model.slug), model] as const,
      ),
    ))();

  const moveFavoriteRow = (rowKey: string, targetRowKey: string) => {
    const model = filteredModelByKey.get(rowKey);
    const target = filteredModelByKey.get(targetRowKey);
    if (!model || !target) return;
    void handleMoveFavorite(
      providerModelKey(model.instanceId, model.slug),
      providerModelKey(target.instanceId, target.slug),
    );
  };
  const composerBoundaryModel =
    isArrangingFavorites && !isLocked ? visibleModels[FAVORITE_SLOTS - 1] : undefined;
  const composerBoundaryKey =
    composerBoundaryModel && visibleModels.length > FAVORITE_SLOTS
      ? modelPickerModelKey(composerBoundaryModel.instanceId, composerBoundaryModel.slug)
      : null;

  const modelJumpLabelByKey = modelJumpLabelsByKey(
    modelJumpModelKeys,
    keybindings,
    props.terminalOpen,
  );
  const badgedInstanceIds = new Set(
    instanceEntries
      .filter((entry) => shouldShowInstanceBadge(entry, instanceEntries))
      .map((entry) => entry.instanceId),
  );
  const modelListExtraData = {
    badgedInstanceIds,
    favoritesSet,
    modelJumpLabelByKey,
    activeModelKey,
    selectedModelKeySet,
    slotLabels,
    renamingModelKey,
    composerBoundaryKey,
  };

  const onWindowKeyDown = (event: globalThis.KeyboardEvent) => {
    if (renamingModelKey !== null) {
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        handleCancelRename();
      }
      return;
    }

    if (
      event.defaultPrevented ||
      event.repeat ||
      event.isComposing ||
      event.keyCode === 229 ||
      isCommandPaletteOpen()
    ) {
      return;
    }

    if (
      isArrangingFavorites &&
      (event.key === "ArrowUp" || event.key === "ArrowDown") &&
      event.altKey &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.shiftKey
    ) {
      const highlightedKey = highlightedModelKeyRef.current;
      const index = highlightedKey ? filteredItemKeys.indexOf(highlightedKey) : -1;
      const targetKey = filteredItemKeys[index + (event.key === "ArrowUp" ? -1 : 1)];
      if (highlightedKey && index !== -1 && targetKey && filteredModelByKey.has(targetKey)) {
        // The list still moves the highlight a step, so it follows the moved row.
        moveFavoriteRow(highlightedKey, targetKey);
      } else {
        // At either end, or next to a pool, the list would move the highlight off the row.
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
      }
      return;
    }

    if (
      event.key === "F2" &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.altKey &&
      !event.shiftKey
    ) {
      const highlightedKey = highlightedModelKeyRef.current;
      const highlighted = highlightedKey ? filteredModelByKey.get(highlightedKey) : undefined;
      if (pooled.startRename(highlightedKey)) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
      } else if (
        highlighted &&
        !getModelDisabledReason?.(highlighted.instanceId, highlighted.slug)
      ) {
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        setRenamingModelKey(highlightedKey);
      }
      return;
    }

    const command = resolveShortcutCommand(event, keybindings, {
      platform: navigator.platform,
      context: modelJumpShortcutContext,
    });
    if (command === "modelPicker.previousProvider" || command === "modelPicker.nextProvider") {
      event.preventDefault();
      event.stopPropagation();
      const next = adjacentModelPickerProvider({
        entries: sidebarInstanceEntries,
        selectedInstanceId,
        direction: command === "modelPicker.nextProvider" ? 1 : -1,
        disabledInstanceIds: lockedDisabledInstanceIds,
        selectableUnavailableInstanceIds,
      });
      setSearchQuery("");
      handleSelectInstance(next);
      announce(
        next === "favorites" ? gt("Favorites") : (entryByInstanceId.get(next)?.displayName ?? next),
        "model-picker",
      );
      return;
    }
    const jumpIndex = modelPickerJumpIndexFromCommand(command ?? "");
    if (jumpIndex === null) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();

    const targetModelKey = modelJumpModelKeys[jumpIndex];
    if (!targetModelKey) {
      return;
    }
    const model = parseModelPickerModelKey(targetModelKey);
    if (!model) {
      return;
    }
    const selectedSlug = handleModelSelect(model.slug, model.instanceId);
    if (selectedSlug === null) return;
    const name = flatModels.find(
      (item) => item.slug === selectedSlug && item.instanceId === model.instanceId,
    )?.name;
    announce(gt("Model: {name}", { name: name ?? selectedSlug }), "model-picker");
  };

  return (
    <TooltipProvider delay={0}>
      <WindowKeyDownListener onKeyDown={onWindowKeyDown} />
      <div
        ref={pickerContentRef}
        className={cn(
          "relative flex w-screen flex-row overflow-hidden",
          // Docked beside the w-48 effort column, the list takes what the window leaves, up to 30rem.
          props.docked
            ? "max-w-[min(30rem,calc(100vw-13rem))] max-sm:h-56 max-sm:w-full max-sm:max-w-none"
            : "max-h-86.5 max-w-90",
        )}
        // Docked, the popup sets the height; a minimum here would overflow short windows.
        style={
          props.docked
            ? undefined
            : isSearching
              ? { height: searchHeight }
              : {
                  minHeight: `min(calc(var(--spacing) * ${tallestTabUnits + LIST_CHROME_UNITS} + 1px), calc(var(--spacing) * 86.5))`,
                }
        }
        data-model-picker-content="true"
      >
        {showSidebar && (
          <ModelPickerSidebar
            selectedInstanceId={selectedInstanceId}
            onSelectInstance={handleSelectInstance}
            onFocusSearch={focusSearchInput}
            instanceEntries={sidebarInstanceEntries}
            showFavorites
            {...(selectableUnavailableInstanceIds ? { selectableUnavailableInstanceIds } : {})}
            {...(lockedDisabledInstanceIds
              ? {
                  disabledInstanceIds: lockedDisabledInstanceIds,
                  getDisabledInstanceTooltip: (entry: ProviderInstanceEntry) =>
                    gt(
                      "{provider} is unavailable in this thread. Start a new thread to switch providers.",
                      { provider: entry.displayName },
                    ),
                }
              : {})}
          />
        )}

        <Combobox<string, boolean>
          inline
          items={allItemKeys}
          filteredItems={filteredItemKeys}
          filter={null}
          autoHighlight
          open
          virtualized
          multiple={onToggleModel !== undefined}
          value={onToggleModel ? [...selectedModelKeySet] : (pooled.activeKey ?? activeModelKey)}
          onItemHighlighted={(modelKey, eventDetails) => {
            highlightedModelKeyRef.current = typeof modelKey === "string" ? modelKey : null;
            if (eventDetails.reason === "keyboard" && eventDetails.index >= 0) {
              void modelListRef.current?.scrollIndexIntoView?.({
                index: eventDetails.index,
                animated: false,
              });
            }
          }}
          onValueChange={(value, details) => {
            const modelKey = Array.isArray(value)
              ? (value.find((key) => !selectedModelKeySet.has(key)) ??
                [...selectedModelKeySet].find((key) => !value.includes(key)))
              : value;
            if (typeof modelKey !== "string") {
              return;
            }
            if (pooled.select(modelKey)) return;
            const legacyInstanceId = parseModelPickerLegacySectionKey(modelKey);
            if (legacyInstanceId) {
              toggleLegacySection(legacyInstanceId);
              return;
            }
            const model = parseModelPickerModelKey(modelKey);
            if (model) {
              handleModelSelect(
                model.slug,
                model.instanceId,
                "shiftKey" in details.event && details.event.shiftKey === true,
              );
            }
          }}
        >
          <div
            className={cn(
              "flex min-h-0 flex-1 flex-col overflow-hidden bg-muted/40",
              showSidebar && "border-l border-border/70",
            )}
          >
            <ComboboxSearchInput
              ref={searchInputRef}
              placeholder={gt("Search models...")}
              value={searchQuery}
              onChange={(e) => {
                if (!isSearching) setSearchHeight(pickerContentRef.current?.offsetHeight ?? 0);
                setSearchQuery(e.target.value);
              }}
              onKeyDown={(e) => {
                if (e.nativeEvent.isComposing || e.keyCode === 229) {
                  (e as typeof e & { preventBaseUIHandler?: () => void }).preventBaseUIHandler?.();
                  e.stopPropagation();
                  return;
                }
                if (pooled.onKeyDown(e, highlightedModelKeyRef.current)) return;
                if (
                  showSidebar &&
                  !e.altKey &&
                  !e.ctrlKey &&
                  !e.metaKey &&
                  ((e.key === "ArrowLeft" && !e.shiftKey && searchQuery.length === 0) ||
                    (e.key === "Tab" && e.shiftKey))
                ) {
                  const sidebar = e.currentTarget
                    .closest("[data-model-picker-content]")
                    ?.querySelector("[data-model-picker-sidebar]");
                  const button =
                    sidebar?.querySelector<HTMLButtonElement>(
                      'button[aria-pressed="true"]:not(:disabled)',
                    ) ?? sidebar?.querySelector<HTMLButtonElement>("button:not(:disabled)");
                  if (button) {
                    e.preventDefault();
                    e.stopPropagation();
                    button.focus();
                    return;
                  }
                }
                if (e.key === "Escape") {
                  e.preventDefault();
                  e.stopPropagation();
                  onRequestClose?.();
                  return;
                }
                if (
                  props.onFocusEffort &&
                  e.key === "ArrowRight" &&
                  !e.altKey &&
                  !e.ctrlKey &&
                  !e.metaKey &&
                  !e.shiftKey &&
                  e.currentTarget.selectionStart === searchQuery.length
                ) {
                  e.preventDefault();
                  e.stopPropagation();
                  // The column shows the selected model's effort, so a highlighted model is picked
                  // first; the owning popup then moves focus to that model's levels.
                  const highlighted = highlightedModelKeyRef.current
                    ? parseModelPickerModelKey(highlightedModelKeyRef.current)
                    : null;
                  const pickedNew =
                    highlighted !== null &&
                    highlightedModelKeyRef.current !== activeModelKey &&
                    handleModelSelect(highlighted.slug, highlighted.instanceId) !== null;
                  if (!pickedNew) props.onFocusEffort();
                  return;
                }
                if (e.key === "Enter" && highlightedModelKeyRef.current) {
                  (e as typeof e & { preventBaseUIHandler?: () => void }).preventBaseUIHandler?.();
                  e.preventDefault();
                  e.stopPropagation();
                  if (pooled.select(highlightedModelKeyRef.current)) return;
                  const legacyInstanceId = parseModelPickerLegacySectionKey(
                    highlightedModelKeyRef.current,
                  );
                  if (legacyInstanceId) {
                    toggleLegacySection(legacyInstanceId);
                    return;
                  }
                  const model = parseModelPickerModelKey(highlightedModelKeyRef.current);
                  if (model) {
                    handleModelSelect(model.slug, model.instanceId, e.shiftKey);
                  }
                  return;
                }
                e.stopPropagation();
              }}
              onMouseDown={(e) => e.stopPropagation()}
              onTouchStart={(e) => e.stopPropagation()}
            />

            <ComposerBoundaryContext value={composerBoundaryKey}>
              <ModelPickerList
                listRef={modelListRef}
                itemKeys={filteredItemKeys}
                extraData={modelListExtraData}
                sortable={isArrangingFavorites ? { onMove: moveFavoriteRow } : undefined}
                renderItem={({ item: modelKey, index }) => {
                  if (legacySection?.key === modelKey) {
                    return (
                      <ComboboxItem
                        hideIndicator
                        index={index}
                        value={modelKey}
                        aria-expanded={legacySection.isExpanded}
                        className="group w-full cursor-pointer"
                      >
                        <span className="text-sm leading-snug text-muted-foreground group-hover:text-foreground group-data-highlighted:text-foreground">
                          {legacySection.isExpanded
                            ? gt("Show less", { $context: "collapses the list of older models" })
                            : gt("Show more", { $context: "expands the list of older models" })}
                        </span>
                      </ComboboxItem>
                    );
                  }
                  const pooledRow = pooled.render(modelKey, index);
                  if (pooledRow) return pooledRow;
                  const model = filteredModelByKey.get(modelKey);
                  if (!model) {
                    return null;
                  }
                  const disabledReason =
                    getModelDisabledReason?.(model.instanceId, model.slug) ?? null;
                  const rowProps = {
                    index,
                    slug: model.slug,
                    name: model.name,
                    customLabel: getCustomModelLabel(slotLabels, model.instanceId, model.slug),
                    subProvider: model.subProvider,
                    instanceId: model.instanceId,
                    driverKind: model.driverKind,
                    providerDisplayName: model.instanceDisplayName,
                    providerAccentColor: model.instanceAccentColor,
                    acpRegistryAgentId: model.acpRegistryAgentId,
                    acpRegistryIconUrl: model.acpRegistryIconUrl,
                    isFavorite: favoritesSet.has(providerModelKey(model.instanceId, model.slug)),
                    isSelected:
                      selectedModelKeys !== undefined
                        ? selectedModelKeySet.has(modelKey)
                        : pooled.activeKey === null && modelKey === activeModelKey,
                    isRenaming: renamingModelKey === modelKey,
                    favoriteStarOnHover: isArrangingFavorites,
                    showInstanceBadge: badgedInstanceIds.has(model.instanceId),
                    showNewBadge: model.badge === "new",
                    unavailable: model.isUnavailable === true,
                    jumpLabel: modelJumpLabelByKey.get(modelKey) ?? null,
                    disabledReason,
                    onToggleFavorite: toggleFavorite,
                    onStartRename: handleStartRename,
                    onCommitRename: handleCommitRename,
                    onCancelRename: handleCancelRename,
                  };
                  return isArrangingFavorites ? (
                    <SortableModelListRow key={modelKey} sortableId={modelKey} {...rowProps} />
                  ) : (
                    <ModelListRow key={modelKey} {...rowProps} />
                  );
                }}
              />
            </ComposerBoundaryContext>
            <ModelPickerProviderNotices
              setupEntries={providerSetupEntries}
              updateRequiredNotices={updateRequiredNotices}
              emptyLabel={
                selectedInstanceId === "favorites" && !isSearching
                  ? gt("No favorites yet")
                  : workspaceModelsScanning
                    ? gt("Searching project models...")
                    : gt("No models found")
              }
              onRequestClose={onRequestClose}
              onOpenProviderSetup={onOpenProviderSetup}
            />
            {props.listFooter}
          </div>
        </Combobox>
      </div>
    </TooltipProvider>
  );
});
