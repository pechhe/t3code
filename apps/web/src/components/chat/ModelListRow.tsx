import { type ProviderDriverKind, type ProviderInstanceId } from "@t3tools/contracts";
import { memo, useRef } from "react";
import { CheckIcon, PencilIcon, RotateCcwIcon, StarIcon } from "lucide-react";
import { getDisplayModelName } from "./providerIconUtils";
import { ComboboxItem } from "../ui/combobox";
import { Button } from "../ui/button";
import { Badge } from "../ui/badge";
import { Kbd } from "../ui/kbd";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { cn } from "~/lib/utils";
import { modelPickerModelKey } from "./modelPickerKeys";
import { ProviderInstanceIcon } from "./ProviderInstanceIcon";

export function InlineModelRenameInput(props: {
  initialValue: string;
  placeholder: string;
  hasCustomLabel: boolean;
  inputClassName?: string;
  onCommit: (nextName: string, restoreFocus: boolean) => void;
  onCancel: () => void;
}) {
  const focusedRef = useRef(false);
  const handledRef = useRef(false);

  const commit = (value: string, restoreFocus: boolean) => {
    if (handledRef.current) return;
    handledRef.current = true;
    props.onCommit(value, restoreFocus);
  };

  const cancel = () => {
    if (handledRef.current) return;
    handledRef.current = true;
    props.onCancel();
  };

  return (
    <div
      className="flex min-w-0 flex-1 items-center gap-1"
      onMouseDown={(event) => {
        event.stopPropagation();
      }}
      onPointerDown={(event) => {
        event.stopPropagation();
      }}
      onClick={(event) => {
        event.stopPropagation();
      }}
    >
      <input
        ref={(node) => {
          if (node && !focusedRef.current) {
            focusedRef.current = true;
            node.focus();
            node.select();
          }
        }}
        type="text"
        defaultValue={props.initialValue}
        placeholder={props.placeholder}
        aria-label="Model name"
        autoFocus
        className={cn(
          "h-6 min-w-0 flex-1 rounded border border-ring/60 bg-background px-1.5 text-sm font-normal leading-snug text-foreground outline-none",
          props.inputClassName,
        )}
        onMouseDown={(event) => {
          event.stopPropagation();
        }}
        onPointerDown={(event) => {
          event.stopPropagation();
        }}
        onClick={(event) => {
          event.stopPropagation();
        }}
        onKeyDown={(event) => {
          event.stopPropagation();
          (event as typeof event & { preventBaseUIHandler?: () => void }).preventBaseUIHandler?.();
          if (event.key === "Enter") {
            event.preventDefault();
            event.nativeEvent.stopImmediatePropagation();
            commit(event.currentTarget.value, true);
          } else if (event.key === "Escape") {
            event.preventDefault();
            event.nativeEvent.stopImmediatePropagation();
            cancel();
          }
        }}
        onBlur={(event) => {
          commit(event.currentTarget.value, false);
        }}
      />
      {props.hasCustomLabel ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                type="button"
                size="icon-xs"
                variant="ghost-muted"
                aria-label="Reset model name"
                onMouseDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                }}
                onPointerDown={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                }}
                onClick={(event) => {
                  event.preventDefault();
                  event.stopPropagation();
                  commit("", true);
                }}
                onKeyDown={(event) => {
                  event.stopPropagation();
                }}
              >
                <RotateCcwIcon className="size-3" />
              </Button>
            }
          />
          <TooltipPopup side="top" align="center">
            Reset to default name
          </TooltipPopup>
        </Tooltip>
      ) : null}
    </div>
  );
}

export const ModelListRow = memo(function ModelListRow(props: {
  index: number;
  slug: string;
  name: string;
  customLabel?: string | undefined;
  subProvider?: string | undefined;
  instanceId: ProviderInstanceId;
  driverKind: ProviderDriverKind;
  providerDisplayName: string;
  providerAccentColor?: string | undefined;
  acpRegistryAgentId?: string | undefined;
  acpRegistryIconUrl?: string | undefined;
  isFavorite: boolean;
  /** In Favorites every row is starred, so the star shows only on hover. */
  favoriteStarOnHover?: boolean;
  isSelected: boolean;
  isRenaming?: boolean | undefined;
  /** Marks this instance apart from another of the same provider. */
  showInstanceBadge: boolean;
  showNewBadge?: boolean;
  unavailable?: boolean;
  jumpLabel?: string | null;
  disabledReason?: string | null;
  onToggleFavorite: (instanceId: ProviderInstanceId, slug: string) => void;
  onStartRename: (instanceId: ProviderInstanceId, slug: string) => void;
  onCommitRename: (
    instanceId: ProviderInstanceId,
    slug: string,
    nextName: string,
    restoreFocus: boolean,
  ) => void;
  onCancelRename: () => void;
}) {
  const model = {
    slug: props.slug,
    name: props.name,
    subProvider: props.subProvider,
  };
  const defaultDisplayName = getDisplayModelName(model);
  const displayLabel = props.customLabel ?? defaultDisplayName;
  const rowKey = modelPickerModelKey(props.instanceId, props.slug);

  const row = (
    <ComboboxItem
      hideIndicator
      selectedFill={false}
      index={props.index}
      value={rowKey}
      disabled={Boolean(props.disabledReason)}
      className={cn(
        "group relative w-full !min-w-0 max-w-full cursor-pointer",
        props.disabledReason &&
          "data-disabled:pointer-events-auto data-disabled:cursor-not-allowed",
      )}
    >
      {/* One row shape in every tab: the logo names the provider, so Favorites needs no second line. */}
      <ProviderInstanceIcon
        driverKind={props.driverKind}
        model={props.slug}
        subProvider={props.subProvider}
        displayName={props.providerDisplayName}
        accentColor={props.providerAccentColor}
        acpRegistryAgentId={props.acpRegistryAgentId}
        acpRegistryIconUrl={props.acpRegistryIconUrl}
        showBadge={props.showInstanceBadge}
        className="size-4"
        iconClassName="size-4"
        indicatorBackground="var(--popover)"
        badgeClassName="right-[-0.125rem] bottom-[-0.125rem] h-3 min-w-3 px-0.5 text-5xs"
      />
      {props.isRenaming ? (
        <InlineModelRenameInput
          key={rowKey}
          initialValue={displayLabel}
          placeholder={defaultDisplayName}
          hasCustomLabel={props.customLabel !== undefined}
          onCommit={(nextName, restoreFocus) => {
            props.onCommitRename(props.instanceId, props.slug, nextName, restoreFocus);
          }}
          onCancel={props.onCancelRename}
        />
      ) : (
        <>
          <div className="flex min-w-0 flex-1 items-center gap-2 text-left">
            <div
              className="min-w-0 truncate text-sm font-normal leading-snug"
              // Names the row in full when renamed or when cut off on hover.
              onPointerEnter={(event) => {
                const name = event.currentTarget;
                if (props.customLabel) {
                  name.title = `${props.customLabel} (${defaultDisplayName})`;
                } else {
                  name.title = name.scrollWidth > name.clientWidth ? defaultDisplayName : "";
                }
              }}
            >
              {displayLabel}
              {/* The logo is decorative, so name the provider for screen readers. */}
              <span className="sr-only">, {props.providerDisplayName}</span>
            </div>
            {props.isSelected ? (
              <CheckIcon className="size-3.5 shrink-0" aria-hidden="true" />
            ) : null}
            {props.subProvider ? (
              <span className="min-w-0 shrink truncate text-xs text-muted-foreground/70">
                {props.subProvider}
              </span>
            ) : null}
            {props.showNewBadge ? (
              <span
                className="shrink-0 rounded border border-update/35 bg-update/15 px-0.5 py-px text-3xs font-bold uppercase leading-none tracking-wide text-update-foreground"
                aria-label="New model"
              >
                New
              </span>
            ) : null}
            {props.unavailable ? (
              <Badge variant="outline" size="sm">
                Unavailable
              </Badge>
            ) : null}
          </div>

          <div className="flex shrink-0 items-center gap-1.5">
            {!props.disabledReason ? (
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      type="button"
                      size="icon-xs"
                      variant="ghost-muted"
                      className="hidden group-hover:inline-flex group-data-highlighted:inline-flex focus-visible:inline-flex pointer-coarse:inline-flex"
                      onMouseDown={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                      }}
                      onPointerDown={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                      }}
                      onClick={(event) => {
                        event.preventDefault();
                        event.stopPropagation();
                        props.onStartRename(props.instanceId, props.slug);
                      }}
                      onKeyDown={(event) => {
                        event.stopPropagation();
                      }}
                      aria-label="Rename model"
                    >
                      <PencilIcon className="size-3" />
                    </Button>
                  }
                />
                <TooltipPopup side="top" align="center">
                  Rename model (F2)
                </TooltipPopup>
              </Tooltip>
            ) : null}
            <Tooltip>
              <TooltipTrigger
                render={
                  <Button
                    size="icon-xs"
                    variant="ghost-muted"
                    onClick={(event) => {
                      event.stopPropagation();
                      props.onToggleFavorite(props.instanceId, props.slug);
                    }}
                    onKeyDown={(event) => {
                      event.stopPropagation();
                    }}
                    disabled={Boolean(props.disabledReason)}
                    aria-label={props.isFavorite ? "Remove from favorites" : "Add to favorites"}
                  >
                    <StarIcon
                      className={cn(
                        "size-3.5 sm:size-3",
                        props.isFavorite && "fill-current text-warning",
                        (!props.isFavorite || props.favoriteStarOnHover) &&
                          "opacity-0 group-hover:opacity-100 group-data-highlighted:opacity-100 in-focus-visible:opacity-100 pointer-coarse:opacity-100",
                      )}
                    />
                  </Button>
                }
              />
              <TooltipPopup side="top" align="center">
                {props.isFavorite ? "Remove from favorites" : "Add to favorites"}
              </TooltipPopup>
            </Tooltip>
            {props.jumpLabel ? <Kbd>{props.jumpLabel}</Kbd> : null}
          </div>
        </>
      )}
    </ComboboxItem>
  );

  if (!props.disabledReason) {
    return row;
  }

  return (
    <Tooltip>
      <TooltipTrigger render={row} />
      <TooltipPopup side="left" align="center">
        {props.disabledReason}
      </TooltipPopup>
    </Tooltip>
  );
});
