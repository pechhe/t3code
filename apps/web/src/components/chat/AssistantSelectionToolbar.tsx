import {
  ASSISTANT_CITATION_MAX_TEXT_LENGTH,
  MessageId,
  type AssistantCitation,
  type ScopedThreadRef,
} from "@t3tools/contracts";
import { serializeAssistantCitation } from "@t3tools/shared/assistantCitations";
import { CopyIcon, QuoteIcon } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  captureAssistantTextSelection,
  type AssistantCitationSourceAnchor,
} from "~/lib/assistantTextSelection";
import {
  isSelectionRectVisible,
  markSelectionCoveredChips,
  observeSelectionActions,
  resolveSelectionActionPlacement,
} from "~/lib/selectionActions";
import { writeTextToClipboard } from "~/hooks/useCopyToClipboard";
import { Button } from "../ui/button";
import { toastManager } from "../ui/toast";

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function AssistantSelectionToolbar({
  viewport,
  threadRef,
  onCite,
}: {
  viewport: HTMLElement | null;
  threadRef: ScopedThreadRef;
  onCite: (citation: AssistantCitation, sourceAnchor: AssistantCitationSourceAnchor) => boolean;
}) {
  const [selection, setSelection] = useState<{
    citation: AssistantCitation;
    // The selected text that is on screen, which the toolbar is placed clear of.
    visible: { left: number; top: number; bottom: number };
    sourceAnchor: AssistantCitationSourceAnchor;
  } | null>(null);
  const toolbarRef = useRef<HTMLDivElement>(null);
  const actionsRef = useRef<ReturnType<typeof observeSelectionActions> | null>(null);

  useLayoutEffect(() => {
    const toolbar = toolbarRef.current;
    if (!toolbar || !selection) return;
    const rect = toolbar.getBoundingClientRect();
    const position = resolveSelectionActionPlacement({
      selection: selection.visible,
      size: { width: rect.width, height: rect.height },
      viewport: { width: window.innerWidth, height: window.innerHeight },
    });
    toolbar.style.left = `${position.x}px`;
    toolbar.style.top = `${position.y}px`;
  }, [selection]);

  useEffect(() => {
    if (!viewport) return;
    const clear = () => setSelection(null);
    const update = () => {
      const nativeSelection = window.getSelection();
      const captured = captureAssistantTextSelection(viewport, nativeSelection);
      const messageId = captured?.source.dataset.assistantCitationSource;
      if (!captured || !messageId) {
        clear();
        return;
      }
      const rect = captured.range.getBoundingClientRect();
      const viewportRect = viewport.getBoundingClientRect();
      if (!isSelectionRectVisible(rect, [viewportRect])) {
        clear();
        return;
      }
      // A selection can cross blocks with different clipping ancestors.
      const common = captured.range.commonAncestorContainer;
      const walker = document.createTreeWalker(common, NodeFilter.SHOW_TEXT);
      let node = common.nodeType === Node.TEXT_NODE ? common : walker.nextNode();
      let visible = false;
      for (; node && !visible; node = walker.nextNode()) {
        if (!captured.range.intersectsNode(node)) continue;
        if (node.parentElement && getComputedStyle(node.parentElement).userSelect === "none")
          continue;
        const fragment = document.createRange();
        fragment.selectNodeContents(node);
        if (node === captured.range.startContainer) {
          fragment.setStart(node, captured.range.startOffset);
        }
        if (node === captured.range.endContainer) {
          fragment.setEnd(node, captured.range.endOffset);
        }
        if (!fragment.toString().trim()) continue;
        const lines = Array.from(fragment.getClientRects());
        if (!lines.some((line) => isSelectionRectVisible(line, [viewportRect]))) continue;
        const clips: Pick<DOMRect, "left" | "right" | "top" | "bottom">[] = [viewportRect];
        for (
          let element = node.parentElement;
          element && element !== viewport;
          element = element.parentElement
        ) {
          const style = getComputedStyle(element);
          const clipX = style.overflowX !== "visible";
          const clipY = style.overflowY !== "visible";
          if (!clipX && !clipY) continue;
          const bounds = element.getBoundingClientRect();
          const left = bounds.left + element.clientLeft;
          const top = bounds.top + element.clientTop;
          clips.push({
            left: clipX ? left : -Infinity,
            right: clipX ? left + element.clientWidth : Infinity,
            top: clipY ? top : -Infinity,
            bottom: clipY ? top + element.clientHeight : Infinity,
          });
        }
        visible = lines.some((line) => isSelectionRectVisible(line, clips));
      }
      if (!visible) {
        clear();
        return;
      }
      const lines = Array.from(captured.range.getClientRects()).filter((line) =>
        isSelectionRectVisible(line, [viewportRect]),
      );
      const firstLine = lines.at(0) ?? rect;
      const lastLine = lines.at(-1) ?? rect;
      setSelection({
        sourceAnchor: { source: captured.source, range: captured.range, viewport },
        citation: {
          version: 1,
          ...threadRef,
          messageId: MessageId.make(messageId),
          ...captured.selector,
        },
        visible: {
          left: firstLine.left,
          top: Math.max(firstLine.top, viewportRect.top),
          bottom: Math.min(lastLine.bottom, viewportRect.bottom),
        },
      });
    };
    const actions = observeSelectionActions({
      element: viewport,
      getActionElement: () => toolbarRef.current,
      restoreAfterScroll: true,
      onSelection: () => update(),
      onDismiss: clear,
    });
    actionsRef.current = actions;
    const focusActions = (event: KeyboardEvent) => {
      const toolbar = toolbarRef.current;
      if (
        event.key !== "Tab" ||
        event.shiftKey ||
        event.altKey ||
        event.ctrlKey ||
        event.metaKey ||
        event.isComposing ||
        event.defaultPrevented ||
        !toolbar ||
        toolbar.contains(event.target as Node)
      ) {
        return;
      }
      const firstAction = toolbar.querySelector<HTMLButtonElement>("button:not(:disabled)");
      if (!firstAction) return;
      event.preventDefault();
      event.stopPropagation();
      firstAction.focus({ preventScroll: true });
    };
    const coverChips = () => markSelectionCoveredChips(viewport, window.getSelection());
    document.addEventListener("keydown", focusActions, true);
    document.addEventListener("selectionchange", actions.selectionChanged);
    document.addEventListener("selectionchange", coverChips);
    return () => {
      document.removeEventListener("keydown", focusActions, true);
      document.removeEventListener("selectionchange", actions.selectionChanged);
      document.removeEventListener("selectionchange", coverChips);
      markSelectionCoveredChips(viewport, null);
      actions.dispose();
      actionsRef.current = null;
    };
  }, [threadRef, viewport]);

  if (!selection) return null;
  const tooLong = selection.citation.text.length > ASSISTANT_CITATION_MAX_TEXT_LENGTH;
  const dismiss = () => {
    actionsRef.current?.cancel();
    setSelection(null);
  };
  const cite = () => {
    if (tooLong || !onCite(selection.citation, selection.sourceAnchor)) return false;
    window.getSelection()?.removeAllRanges();
    dismiss();
    return true;
  };
  // The composer turns the pasted link back into a chip in any thread; other apps get the quote.
  const copy = () => {
    if (tooLong) return;
    const { citation } = selection;
    window.getSelection()?.removeAllRanges();
    dismiss();
    void writeTextToClipboard(serializeAssistantCitation(citation), "citation", {
      "text/html": `<blockquote>${escapeHtml(citation.text)}</blockquote>`,
    }).then(
      () =>
        toastManager.add({
          type: "success",
          title: "Citation copied",
          description: "Paste it into any thread's composer to cite this response there.",
        }),
      (error: Error) =>
        toastManager.add({
          type: "error",
          title: "Could not copy citation",
          description: error.message,
        }),
    );
  };
  return createPortal(
    <div
      ref={toolbarRef}
      className="fixed z-50 flex max-w-[calc(100vw-1rem)] gap-1"
      style={{ left: selection.visible.left, top: selection.visible.top }}
      onPointerDown={(event) => event.preventDefault()}
      onKeyDown={(event) => {
        event.stopPropagation();
        if (event.key === "Escape" && !event.nativeEvent.isComposing) {
          event.preventDefault();
          dismiss();
        }
      }}
    >
      <Button
        type="button"
        size="xs"
        variant="glass"
        disabled={tooLong}
        aria-label={tooLong ? "Selection is too long to reply to" : "Reply with this selection"}
        onClick={cite}
      >
        <QuoteIcon aria-hidden="true" className="size-3.5" />
        {tooLong ? "Shorten selection" : "Reply"}
      </Button>
      {tooLong ? null : (
        <Button
          type="button"
          size="xs"
          variant="glass"
          aria-label="Copy citation to paste into another thread"
          onClick={copy}
        >
          <CopyIcon aria-hidden="true" className="size-3.5" />
          Copy for another thread
        </Button>
      )}
    </div>,
    document.body,
  );
}
