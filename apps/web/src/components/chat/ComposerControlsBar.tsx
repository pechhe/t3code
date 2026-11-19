import type { ModelPickerPooling } from "./modelPickerPooling";
import { cloneElement, type ReactNode, type RefObject } from "react";
import type { ChatComposerProps } from "./ChatComposer";
import type { PromptUltrathink } from "./TraitsPicker";
import type { ProviderInstanceEntry } from "../../providerInstances";
import { type AppModelOption } from "../../modelSelection";
import { useGT, useMessages } from "gt-react";
import { CircleAlertIcon } from "lucide-react";
import { CompactComposerControlsMenu } from "./CompactComposerControlsMenu";
import { ComposerControl } from "./ComposerControl";
import { DeviceModelSlider, type DeviceModelSliderHandle } from "./device/DeviceModelSlider";
import { DeviceReasoningDial, type DeviceReasoningDialHandle } from "./device/DeviceReasoningDial";
import { DeviceStanceSwitch } from "./device/DeviceStanceSwitch";
import { ComposerStanceControl } from "./ComposerStanceControl";
import {
  ComposerFooterModeControls,
  ComposerModelPicker,
  type RuntimeModeOption,
} from "./ComposerFooterControls";
import {
  type DelegationStance,
  type EnvironmentId,
  type ModelSelection,
  type ProviderDriverKind,
  type ProviderInstanceId,
  type RuntimeMode,
  type ServerProvider,
} from "@t3tools/contracts";
import type { EffortDisplay } from "@t3tools/contracts/settings";
import { cn } from "~/lib/utils";
import { getComposerFastSwitch, resolveComposerTraitsInput } from "./composerProviderState";
import { useApplyThreadModelPick } from "./useApplyThreadModelPick";
import { useStableCallback } from "../../hooks/useStableCallback";
import {
  ComposerEffortColumn,
  ComposerPickerFooter,
  describeComposerEffort,
} from "./ComposerModelEffort";
import type { useComposerProviderModel } from "./useComposerProviderModel";
import { resolveComposerControlsOwnership } from "./composerControlsOwnership";

/**
 * The composer footer controls: the model picker (which also holds effort, speed and
 * permissions), mode controls and the overflow menu for blocks that do not fit. Rendered in the
 * expanded footer or the resting controls host.
 */
// Model and effort share one trigger; it stays filled while its popup is open.
const MODEL_TRIGGER_STATES = "data-popup-open:bg-accent data-popup-open:text-foreground";

export function ComposerControlsBar(props: {
  environmentId: EnvironmentId;
  workspaceCwd: string | null;
  routeKind: ChatComposerProps["routeKind"];
  routeThreadRef: ChatComposerProps["routeThreadRef"];
  draftId: ChatComposerProps["draftId"];
  selectedProvider: ProviderDriverKind;
  selectedInstanceId: ProviderInstanceId;
  selectedModel: string;
  selectedProviderModels: ServerProvider["models"];
  composerModelOptions: ReturnType<typeof useComposerProviderModel>["composerModelOptions"];
  reportedModelSelection: ChatComposerProps["reportedModelSelection"];
  promptUltrathink: PromptUltrathink;
  onPromptEdit: (edit: (prompt: string) => string) => void;
  effortDisplay: EffortDisplay;
  /** The strip under a new thread names the permissions, so the row does not repeat them. */
  permissionsShownInStrip: boolean;
  compatibleRuntimeMode: RuntimeMode;
  defaultRuntimeMode: RuntimeMode | undefined;
  compatibleRuntimeModeOptions: ReadonlyArray<RuntimeModeOption>;
  handleRuntimeModeChange: (mode: RuntimeMode) => void;
  delegationStance: DelegationStance;
  delegationStanceDisabled: boolean;
  onDelegationStanceChange: (stance: DelegationStance) => void;
  composerControlsCollapsed: boolean;
  composerControlsHidden: boolean;
  restingHiddenBlockCount: number;
  iconOnlyBlockCount: number;
  showInlineRestingControls: boolean;
  /** Desktop-width composers render the machined device controls; phones keep the compact ones. */
  deviceComposer: boolean;
  /** The machine switch leading the device controls, when the project has two machines to run on. */
  deviceEnvironmentSwitch?: ReactNode;
  reasoningDialRef: RefObject<DeviceReasoningDialHandle | null>;
  modelSliderRef: RefObject<DeviceModelSliderHandle | null>;
  showProviderUnavailable: boolean;
  providerSetupInstanceId: ProviderInstanceId | undefined;
  onOpenProviderSetup: ChatComposerProps["onOpenProviderSetup"];
  providerCatalogPending: boolean;
  isSendBusy: boolean;
  multipleModelsEnabled: boolean;
  multipleModelSelections: ChatComposerProps["multipleModelSelections"];
  onMultipleModelSelectionsChange: ChatComposerProps["onMultipleModelSelectionsChange"];
  selectedModelSelection: ModelSelection;
  onProviderModelSelect: ChatComposerProps["onProviderModelSelect"];
  pooling: ModelPickerPooling;
  activeThreadModelSelection: ChatComposerProps["activeThreadModelSelection"];
  selectedModelForPickerWithCustomFallback: string;
  lockedProvider: ChatComposerProps["lockedProvider"];
  lockedContinuationGroupKey: string | null;
  providerInstanceEntries: ReadonlyArray<ProviderInstanceEntry>;
  keybindings: ChatComposerProps["keybindings"];
  modelOptionsByInstance: ReadonlyMap<ProviderInstanceId, ReadonlyArray<AppModelOption>>;
  terminalOpen: boolean;
  modelPickerOpen: boolean;
  onModelPickerOpenChange: (open: boolean) => void;
  modelPickerIconClassName: string | undefined;
  getModelDisabledReason: ChatComposerProps["getModelDisabledReason"];
}) {
  const {
    environmentId,
    routeKind,
    routeThreadRef,
    draftId,
    selectedProvider,
    selectedInstanceId,
    selectedModel,
    selectedProviderModels,
    composerModelOptions,
    reportedModelSelection,
    promptUltrathink,
    onPromptEdit,
    compatibleRuntimeMode,
    defaultRuntimeMode,
    compatibleRuntimeModeOptions,
    handleRuntimeModeChange,
    composerControlsCollapsed,
    composerControlsHidden,
    restingHiddenBlockCount: measuredHiddenBlockCount,
    iconOnlyBlockCount,
    deviceComposer,
    deviceEnvironmentSwitch,
    reasoningDialRef,
    modelSliderRef,
    showProviderUnavailable,
    providerSetupInstanceId,
    onOpenProviderSetup,
    providerCatalogPending,
    isSendBusy,
    multipleModelsEnabled,
    multipleModelSelections,
    onMultipleModelSelectionsChange,
    selectedModelSelection,
    onProviderModelSelect,
    pooling,
    activeThreadModelSelection,
    selectedModelForPickerWithCustomFallback,
    lockedProvider,
    lockedContinuationGroupKey,
    providerInstanceEntries,
    keybindings,
    modelOptionsByInstance,
    terminalOpen,
    modelPickerOpen,
    onModelPickerOpenChange,
    modelPickerIconClassName,
    getModelDisabledReason,
  } = props;
  const accessMatchesDefault = compatibleRuntimeMode === defaultRuntimeMode;
  const {
    accessDisplay,
    showModeBlock,
    hiddenBlockCount: restingHiddenBlockCount,
    hiddenBlockIds: hiddenRestingBlockIds,
    overflowShowsPermissions,
    overflowShowsStance,
    pickerOwnsModeShortcut,
  } = resolveComposerControlsOwnership({
    matchesDefault: accessMatchesDefault || props.permissionsShownInStrip,
    collapsed: composerControlsCollapsed,
    measuredHiddenBlockCount,
  });
  const controlSize = composerControlsCollapsed ? "xs" : "sm";
  const gt = useGT();
  const m = useMessages();
  const applyThreadModelPick = useApplyThreadModelPick();
  const applyRouteThreadModelPick = useStableCallback(() => applyThreadModelPick(routeThreadRef));
  const traitsInput = resolveComposerTraitsInput({
    provider: selectedProvider,
    instanceId: selectedInstanceId,
    ...(routeKind === "server"
      ? { threadRef: routeThreadRef, onDraftModelOptionsChange: applyRouteThreadModelPick }
      : {}),
    ...(routeKind === "draft" && draftId ? { draftId } : {}),
    model: selectedModel,
    models: selectedProviderModels,
    modelOptions: composerModelOptions?.[selectedInstanceId],
    reportedModelSelection,
    promptUltrathink,
    onPromptEdit,
  });
  const effort = describeComposerEffort(traitsInput, props.effortDisplay, controlSize, m);
  const restingBlockDefs = [
    {
      id: "stance",
      content: (
        <ComposerStanceControl
          stance={props.delegationStance}
          disabled={props.delegationStanceDisabled}
          size={controlSize}
          hidden={composerControlsHidden || overflowShowsStance}
          onChange={props.onDelegationStanceChange}
        />
      ),
    },
    ...(showModeBlock
      ? [
          {
            id: "mode",
            content: (
              <ComposerFooterModeControls
                runtimeMode={compatibleRuntimeMode}
                runtimeModeOptions={compatibleRuntimeModeOptions}
                size={controlSize}
                hidden={composerControlsHidden || overflowShowsPermissions}
                accessDisplay={accessDisplay}
                emphasized={!accessMatchesDefault}
                onRuntimeModeChange={handleRuntimeModeChange}
              />
            ),
          },
        ]
      : []),
  ];
  // Its own element, so typing (which rebuilds the controls around it) leaves it cached.
  const providerTraitsPickerInput = traitsInput;
  const fastActive =
    getComposerFastSwitch({
      provider: selectedProvider,
      model: selectedModel,
      models: selectedProviderModels,
      modelOptions: composerModelOptions?.[selectedInstanceId],
      includePlanAgent: false,
    })?.active ?? false;
  const composerModelPicker = (
    <ComposerModelPicker
      environmentId={environmentId}
      workspaceCwd={props.workspaceCwd}
      compact={false}
      isComposerOwned
      // The trigger grows away from this edge when its model or effort label changes.
      popupAlign={composerControlsCollapsed ? "start" : "end"}
      disabled={providerCatalogPending || isSendBusy}
      multipleModelsEnabled={multipleModelsEnabled}
      multipleModelSelections={multipleModelSelections}
      onMultipleModelSelectionsChange={onMultipleModelSelectionsChange}
      selectedModelSelection={selectedModelSelection}
      onProviderModelSelect={onProviderModelSelect}
      pooling={pooling}
      activeInstanceId={
        providerCatalogPending
          ? (activeThreadModelSelection?.instanceId ?? selectedInstanceId)
          : selectedInstanceId
      }
      model={
        providerCatalogPending
          ? (activeThreadModelSelection?.model ?? selectedModelForPickerWithCustomFallback)
          : selectedModelForPickerWithCustomFallback
      }
      lockedProvider={lockedProvider}
      lockedContinuationGroupKey={lockedContinuationGroupKey}
      instanceEntries={providerInstanceEntries}
      keybindings={keybindings}
      modelOptionsByInstance={modelOptionsByInstance}
      size={controlSize}
      triggerClassName={cn(
        "group/model-trigger",
        MODEL_TRIGGER_STATES,
        composerControlsCollapsed ? "min-w-13 shrink text-xs!" : "min-w-13",
      )}
      triggerSuffix={effort.suffix}
      triggerDetail={effort.detail}
      triggerShortcuts={
        pickerOwnsModeShortcut ? "composer.effort composer.mode" : "composer.effort"
      }
      effortColumn={<ComposerEffortColumn traits={traitsInput} environmentId={environmentId} />}
      footer={
        <ComposerPickerFooter
          traits={traitsInput}
          runtimeMode={compatibleRuntimeMode}
          runtimeModeOptions={compatibleRuntimeModeOptions}
          onRuntimeModeChange={handleRuntimeModeChange}
        />
      }
      terminalOpen={terminalOpen}
      open={modelPickerOpen}
      instanceIndicatorBackground={
        composerControlsCollapsed
          ? "color-mix(in srgb, var(--chat-composer-glass-surface) var(--glass-opacity), transparent)"
          : "var(--contrast-input)"
      }
      {...(modelPickerIconClassName || composerControlsCollapsed
        ? {
            activeProviderIconClassName: cn(
              modelPickerIconClassName,
              composerControlsCollapsed &&
                // Package glyphs get opaque fills and one opacity, so overlapping paths don't band.
                "fill-muted-foreground/70! text-muted-foreground/70! [&_path]:fill-muted-foreground/70! [&_rect]:fill-muted-foreground/70! [&_[data-icon-detail]]:fill-transparent! [&[data-provider-package-icon]]:opacity-70 [&[data-provider-package-icon]_path:not([data-icon-detail])]:fill-muted-foreground!",
            ),
          }
        : {})}
      onOpenChange={onModelPickerOpenChange}
      getModelDisabledReason={getModelDisabledReason}
      onOpenProviderSetup={onOpenProviderSetup}
    />
  );
  return showProviderUnavailable ? (
    <ComposerControl
      type="button"
      disabled={!providerSetupInstanceId}
      onClick={() => {
        if (providerSetupInstanceId) {
          onOpenProviderSetup(providerSetupInstanceId);
        }
      }}
      data-chat-provider-unavailable="true"
      className="shrink-0"
    >
      <CircleAlertIcon className="size-4" />
      {providerSetupInstanceId ? gt("Open provider settings") : gt("No provider available")}
    </ComposerControl>
  ) : deviceComposer ? (
    <>
      {deviceEnvironmentSwitch}
      <DeviceStanceSwitch
        stance={props.delegationStance}
        disabled={props.delegationStanceDisabled}
        onChange={props.onDelegationStanceChange}
      />
      <DeviceModelSlider
        ref={modelSliderRef}
        environmentId={environmentId}
        activeInstanceId={selectedInstanceId}
        model={selectedModelForPickerWithCustomFallback}
        instanceEntries={providerInstanceEntries}
        modelOptionsByInstance={modelOptionsByInstance}
        lockedProvider={lockedProvider}
        lockedContinuationGroupKey={lockedContinuationGroupKey}
        disabled={providerCatalogPending || isSendBusy}
        getModelDisabledReason={getModelDisabledReason}
        onSelect={(instanceId, model) => {
          onMultipleModelSelectionsChange(null);
          onProviderModelSelect(instanceId, model, { focusComposer: false });
        }}
        renderOverflow={(trigger) => cloneElement(composerModelPicker, { trigger })}
        pooledName={
          pooling.active?.pinned === null
            ? pooling.models.find((model) => model.key === pooling.active?.key)?.displayName
            : undefined
        }
        fast={fastActive}
      />
      {providerTraitsPickerInput ? (
        <DeviceReasoningDial ref={reasoningDialRef} {...providerTraitsPickerInput} />
      ) : null}
    </>
  ) : (
    <>
      {composerModelPicker}

      <>
        {restingBlockDefs.map((def, index) => {
          const hidden = index >= restingBlockDefs.length - restingHiddenBlockCount;
          return (
            <div
              key={def.id}
              data-resting-block={def.id}
              data-composer-block-icon-only={
                index >= restingBlockDefs.length - iconOnlyBlockCount ? "true" : "false"
              }
              aria-hidden={hidden || undefined}
              inert={hidden || undefined}
              className={cn(
                "flex w-max min-w-max shrink-0 items-center gap-1",
                hidden && "pointer-events-none invisible absolute",
                index >= restingBlockDefs.length - iconOnlyBlockCount &&
                  "[&_[data-composer-control-label]]:pointer-events-none [&_[data-composer-control-label]]:invisible [&_[data-composer-control-label]]:absolute [&_[data-composer-control-label]]:w-max [&_[data-composer-control-label]]:max-w-none [&_[data-composer-control-compact-icon]]:[visibility:inherit] [&_[data-composer-control-compact-icon]]:relative",
              )}
            >
              {def.content}
            </div>
          );
        })}
        <div
          data-resting-controls-overflow
          aria-hidden={hiddenRestingBlockIds.length === 0 || undefined}
          inert={hiddenRestingBlockIds.length === 0 || undefined}
          className={cn(
            "min-w-0 shrink-0",
            hiddenRestingBlockIds.length === 0 && "pointer-events-none invisible absolute",
          )}
        >
          <CompactComposerControlsMenu
            stance={props.delegationStance}
            stanceDisabled={props.delegationStanceDisabled}
            showStance={overflowShowsStance}
            onStanceChange={props.onDelegationStanceChange}
            runtimeMode={compatibleRuntimeMode}
            runtimeModeOptions={compatibleRuntimeModeOptions}
            size={controlSize}
            hidden={composerControlsHidden || hiddenRestingBlockIds.length === 0}
            // Permissions join the overflow only when their normal home is in it.
            showPermissions={overflowShowsPermissions}
            onRuntimeModeChange={handleRuntimeModeChange}
          />
        </div>
      </>
    </>
  );
}
