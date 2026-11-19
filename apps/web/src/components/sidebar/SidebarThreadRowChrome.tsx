import { AlarmClockIcon, CheckIcon, LinkIcon, Undo2Icon, XIcon } from "lucide-react";
import {
  forwardRef,
  type ComponentPropsWithoutRef,
  type MouseEvent as ReactMouseEvent,
  type PointerEvent as ReactPointerEvent,
  type ReactNode,
} from "react";
import { T, useGT } from "gt-react";

import { cn } from "~/lib/utils";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

export const draftSurfaceClassName = "bg-warning/4 hover:bg-warning/8";

export type SidebarThreadRowSurfaceState = {
  readonly variantAction: string | null;
  readonly isActive: boolean;
  readonly isSelected: boolean;
  readonly hasUnsentDraft: boolean;
  readonly shouldRecede: boolean;
  readonly status: string;
  readonly isFileDragOver: boolean;
  readonly isDragging: boolean;
};

export const SidebarThreadRowTrigger = forwardRef<
  HTMLDivElement,
  ComponentPropsWithoutRef<"div"> & {
    readonly surface: SidebarThreadRowSurfaceState;
    readonly layout: "card" | "slim";
    readonly twoLine?: boolean;
    readonly inFolder?: boolean;
  }
>(function SidebarThreadRowTrigger(
  { surface, layout, twoLine = false, inFolder = false, className, ...props },
  ref,
) {
  const {
    variantAction,
    isActive,
    isSelected,
    hasUnsentDraft,
    shouldRecede,
    status,
    isFileDragOver,
    isDragging,
  } = surface;
  return (
    <div
      {...props}
      ref={ref}
      className={cn(
        "group/sidebar-row relative w-full cursor-pointer overflow-hidden rounded-md text-left outline-none select-none group-focus-visible/sidebar-row:ring-2 group-focus-visible/sidebar-row:ring-inset group-focus-visible/sidebar-row:ring-ring",
        variantAction === "unsettle" &&
          !isActive &&
          "[&:not(:hover):not(:focus-within)_*:not(.live-activity-focus_*)]:text-secondary-label",
        isActive
          ? "bg-sidebar-row-active text-sidebar-foreground light:ring-1 light:ring-inset light:ring-sidebar-border/70"
          : isSelected
            ? "bg-sidebar-row-selected text-sidebar-foreground light:ring-1 light:ring-inset light:ring-sidebar-border/70"
            : hasUnsentDraft
              ? cn(draftSurfaceClassName, "text-sidebar-foreground")
              : shouldRecede
                ? "text-sidebar-muted-foreground/75 hover:bg-sidebar-row-hover hover:text-sidebar-foreground"
                : "bg-transparent text-sidebar-foreground hover:bg-sidebar-row-hover",
        shouldRecede &&
          (status === "preparing" || status === "working") &&
          "opacity-70 transition-opacity hover:opacity-100 focus-within:opacity-100 motion-reduce:transition-none",
        isFileDragOver && "ring-1 ring-inset ring-primary/70",
        isFileDragOver && !isActive && !isSelected && "bg-sidebar-row-hover",
        isDragging &&
          "bg-sidebar bg-linear-to-b from-sidebar-row-active to-sidebar-row-active text-sidebar-foreground opacity-100 shadow-lg",
        layout === "slim" &&
          (twoLine
            ? "flex flex-col justify-center px-2.5 py-1.5"
            : "flex h-9 items-center gap-2.5 px-2.5"),
        layout === "slim" && inFolder && "ps-9",
        className,
      )}
    />
  );
});

type SidebarTooltipButtonProps = Omit<ComponentPropsWithoutRef<"button">, "className"> & {
  readonly kind: "woke" | "unsettle" | "settle" | "discard" | "insert" | "settle-label";
  readonly isWoke?: boolean;
  readonly compact?: boolean;
  readonly statusTone?: string;
};

export const SidebarTooltipButton = forwardRef<HTMLButtonElement, SidebarTooltipButtonProps>(
  function SidebarTooltipButton(
    { kind, isWoke = false, compact = false, statusTone, children, ...props },
    ref,
  ) {
    const className =
      kind === "woke"
        ? cn(
            "inline-flex cursor-pointer items-center gap-1 rounded-sm font-medium outline-none hover:underline focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring",
            compact && "text-xs text-warning-foreground",
            statusTone,
          )
        : kind === "unsettle"
          ? cn(
              "pointer-events-none absolute inset-y-0 right-0 -mr-1 inline-flex cursor-pointer items-center gap-1 rounded-md bg-transparent px-1.5 text-xs text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 group-any-hover/sidebar-row:pointer-events-auto group-any-hover/sidebar-row:opacity-100",
              isWoke && "group-any-hover/sidebar-row:static",
            )
          : kind === "settle"
            ? cn(
                "pointer-events-none absolute inset-y-0 right-0 inline-flex cursor-pointer items-center gap-1 rounded-md bg-transparent px-2 text-xs text-muted-foreground opacity-0 transition-opacity hover:text-foreground focus-visible:pointer-events-auto focus-visible:opacity-100 group-any-hover/sidebar-row:pointer-events-auto group-any-hover/sidebar-row:opacity-100",
                isWoke && "group-any-hover/sidebar-row:static",
              )
            : kind === "discard"
              ? "inline-flex cursor-pointer items-center rounded-md bg-transparent px-1.5 text-xs text-muted-foreground hover:text-foreground"
              : kind === "insert"
                ? "inline-flex h-full cursor-pointer items-center rounded-md bg-transparent px-1.5 text-xs text-muted-foreground hover:text-foreground"
                : "-mr-1 inline-flex cursor-pointer items-center gap-1 rounded-md bg-transparent px-1.5 text-xs text-muted-foreground hover:text-foreground";
    return (
      <button {...props} ref={ref} className={className}>
        {children ??
          (kind === "woke" ? (
            <>
              <AlarmClockIcon aria-hidden className={compact ? "size-3" : "size-4 shrink-0"} />
              <span role="status">
                <T context="thread status: woke from snooze">Woke</T>
              </span>
            </>
          ) : kind === "unsettle" ? (
            <Undo2Icon className="mb-px size-3.5" />
          ) : kind === "settle" || kind === "settle-label" ? (
            <>
              <CheckIcon className={kind === "settle" ? "size-3" : "size-3.5"} />
              {kind === "settle-label" ? <T>Settle</T> : null}
            </>
          ) : kind === "discard" ? (
            <XIcon className="size-3.5" />
          ) : (
            <LinkIcon className="size-3" />
          ))}
      </button>
    );
  },
);

/** The card row's hover actions: discard draft, insert into the composer, snooze (`children`), settle. */
export function SidebarThreadRowHoverActions(props: {
  readonly snoozeMenuOpen: boolean;
  readonly onDiscardDraft: ((event: ReactMouseEvent) => void) | null;
  readonly onInsert: (event: ReactMouseEvent) => void;
  readonly onSettle: ((event: ReactMouseEvent) => void) | null;
  readonly onSettlePointerDown: (event: ReactPointerEvent) => void;
  readonly children: ReactNode;
}) {
  const gt = useGT();
  return (
    <span
      className={cn(
        // Mouse clicks leave Settle focused; focus-within would pin controls over
        // the status label after the pointer leaves. Use focus-visible instead.
        "pointer-events-none absolute inset-y-0 right-0 flex items-stretch opacity-0 transition-opacity has-[:focus-visible]:pointer-events-auto has-[:focus-visible]:static has-[:focus-visible]:opacity-100 group-any-hover/sidebar-row:pointer-events-auto group-any-hover/sidebar-row:static group-any-hover/sidebar-row:opacity-100",
        props.snoozeMenuOpen && "pointer-events-auto static opacity-100",
      )}
    >
      {props.onDiscardDraft ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <SidebarTooltipButton
                kind="discard"
                type="button"
                aria-label={gt("Discard draft")}
                onClick={props.onDiscardDraft}
              />
            }
          />
          <TooltipPopup side="top">
            <T>Discard draft</T>
          </TooltipPopup>
        </Tooltip>
      ) : null}
      <Tooltip>
        <TooltipTrigger
          render={
            <SidebarTooltipButton
              kind="insert"
              type="button"
              aria-label={gt("Insert thread into the composer")}
              onClick={props.onInsert}
              onPointerDown={(event) => event.stopPropagation()}
              onDoubleClick={(event) => event.stopPropagation()}
            />
          }
        />
        <TooltipPopup>
          <T>Insert into the composer</T>
        </TooltipPopup>
      </Tooltip>
      {props.children}
      {props.onSettle ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <SidebarTooltipButton
                kind="settle-label"
                type="button"
                aria-label={gt("Settle thread")}
                onClick={props.onSettle}
                onPointerDown={props.onSettlePointerDown}
              />
            }
          />
          <TooltipPopup>
            <T>Settle thread</T>
          </TooltipPopup>
        </Tooltip>
      ) : null}
    </span>
  );
}
