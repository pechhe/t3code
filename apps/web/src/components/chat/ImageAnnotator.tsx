import { COMPOSER_CONTEXT_PREVIEW_COMMENT_MAX_CHARS } from "@t3tools/contracts";
import { T, useGT } from "gt-react";
import {
  EraserIcon,
  MousePointer2Icon,
  MoveUpRightIcon,
  Redo2Icon,
  Trash2Icon,
  Undo2Icon,
  XIcon,
} from "lucide-react";
import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";

import { observeResize } from "~/lib/observeResize";
import { randomUUID } from "~/lib/utils";
import { computeImageMarkBadges, toAnnotationMark, type ImageMark } from "~/lib/imageAnnotation";

import {
  CLICK_TOLERANCE_PX,
  arrowGeometry,
  boxFromCorners,
  clamp01,
  commitMarks,
  createHistory,
  effectiveTool,
  handlePositions,
  hitHandle,
  hitMark,
  initialLayout,
  layoutAfterAdd,
  leaderLine,
  moveArrowEnd,
  moveMark,
  placeCallouts,
  redoMarks,
  resizeBox,
  setMarkNote,
  undoMarks,
  type AnnotatorLayout,
  type Handle,
  type Point,
  type Rect,
  type Tool,
} from "./imageAnnotator.logic";

/** Presses that travel less than this many pixels select a mark instead of moving it. */
const MOVE_TOLERANCE_PX = 3;
const POINT_RADIUS = 9;

type Drag =
  | { kind: "draw"; start: Point; moved: boolean }
  | { kind: "move"; origin: ImageMark; start: Point; draft: ImageMark; moved: boolean }
  | { kind: "handle"; handle: Handle; origin: ImageMark; draft: ImageMark; moved: boolean };

function sameMarks(left: ReadonlyArray<ImageMark>, right: ReadonlyArray<ImageMark>): boolean {
  const wire = (marks: ReadonlyArray<ImageMark>) => JSON.stringify(marks.map(toAnnotationMark));
  return wire(left) === wire(right);
}

function isTextEntry(target: EventTarget | null): target is HTMLTextAreaElement {
  return target instanceof HTMLTextAreaElement;
}

function growNote(element: HTMLTextAreaElement) {
  element.style.height = "auto";
  element.style.height = String(element.scrollHeight) + "px";
}

/** Writes a mark's geometry straight onto its SVG nodes, so a drag never re-renders React. */
function paintMark(group: Element, mark: ImageMark, width: number, height: number) {
  const setAll = (selector: string, attributes: Record<string, string | number>) => {
    for (const node of group.querySelectorAll(selector)) {
      for (const [name, value] of Object.entries(attributes))
        node.setAttribute(name, String(value));
    }
  };
  if (mark.kind === "box") {
    setAll("[data-shape]", {
      x: mark.x * width,
      y: mark.y * height,
      width: mark.width * width,
      height: mark.height * height,
    });
  } else if (mark.kind === "point") {
    setAll("[data-shape]", { cx: mark.x * width, cy: mark.y * height });
    setAll("[data-select]", { cx: mark.x * width, cy: mark.y * height });
  } else {
    const geometry = arrowGeometry(mark, width, height);
    setAll("[data-shape=line]", {
      x1: geometry.x1,
      y1: geometry.y1,
      x2: geometry.x2,
      y2: geometry.y2,
    });
    setAll("[data-shape=head]", { points: geometry.head });
  }
  for (const position of handlePositions(mark)) {
    setAll("[data-handle=" + position.handle + "]", {
      cx: position.x * width,
      cy: position.y * height,
    });
  }
}

function MarkShape(props: {
  mark: ImageMark;
  width: number;
  height: number;
  selected: boolean;
  hovered: boolean;
}) {
  const { mark, width, height } = props;
  let shape;
  if (mark.kind === "box") {
    const rect = {
      x: mark.x * width,
      y: mark.y * height,
      width: mark.width * width,
      height: mark.height * height,
    };
    shape = (
      <>
        <rect data-shape className="image-annotator-halo" rx={2} {...rect} />
        <rect data-shape className="image-annotator-ring" rx={2} {...rect} />
      </>
    );
  } else if (mark.kind === "point") {
    const center = { cx: mark.x * width, cy: mark.y * height };
    shape = (
      <>
        {props.selected ? (
          <circle data-select className="image-annotator-select" r={POINT_RADIUS + 7} {...center} />
        ) : null}
        <circle data-shape className="image-annotator-halo" r={POINT_RADIUS} {...center} />
        <circle data-shape className="image-annotator-ring" r={POINT_RADIUS} {...center} />
      </>
    );
  } else {
    const geometry = arrowGeometry(mark, width, height);
    const line = { x1: geometry.x1, y1: geometry.y1, x2: geometry.x2, y2: geometry.y2 };
    shape = (
      <>
        <line data-shape="line" className="image-annotator-halo" {...line} />
        <polygon data-shape="head" className="image-annotator-head-halo" points={geometry.head} />
        <line data-shape="line" className="image-annotator-ring" {...line} />
        <polygon data-shape="head" className="image-annotator-head" points={geometry.head} />
      </>
    );
  }
  return (
    <g
      data-mark-id={mark.id}
      data-selected={props.selected || undefined}
      data-hovered={props.hovered || undefined}
      className="image-annotator-mark"
    >
      {shape}
      {props.selected
        ? handlePositions(mark).map((position) => (
            <circle
              key={position.handle}
              data-handle={position.handle}
              className="image-annotator-handle"
              r={5.5}
              cx={position.x * width}
              cy={position.y * height}
            />
          ))
        : null}
    </g>
  );
}

export function ImageAnnotator(props: {
  file: File;
  initialMarks: ReadonlyArray<ImageMark>;
  onDone: (marks: ImageMark[]) => Promise<void>;
  onClose: () => void;
}) {
  const { file, onDone, onClose } = props;
  const gt = useGT();
  const [history, setHistory] = useState(() =>
    createHistory(props.initialMarks.map((mark) => ({ ...mark }))),
  );
  const marks = history.marks;
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoverId, setHoverId] = useState<string | null>(null);
  const [frameSize, setFrameSize] = useState({ width: 1, height: 1 });
  const [baseTool, setBaseTool] = useState<Tool>("mark");
  const [modifierHeld, setModifierHeld] = useState(false);
  const [layout, setLayout] = useState<AnnotatorLayout>(() =>
    initialLayout(props.initialMarks.length),
  );
  const [saving, setSaving] = useState(false);
  // Set by the first Esc or Cancel while there are unsaved changes; the second one leaves.
  const [confirmingDiscard, setConfirmingDiscard] = useState(false);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const imageRef = useRef<HTMLImageElement | null>(null);
  const svgRef = useRef<SVGSVGElement | null>(null);
  const dragRef = useRef<Drag | null>(null);
  const pendingFocusRef = useRef<string | null>(null);
  const layoutPinnedRef = useRef(false);

  const tool = effectiveTool(baseTool, modifierHeld);
  const { width, height } = frameSize;

  const placements =
    layout === "callouts" ? placeCallouts(marks, width, height) : new Map<string, Rect>();
  const badges = layout === "rail" ? computeImageMarkBadges(marks, width, height) : [];

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- binds the image element to a file-backed object URL.
  useLayoutEffect(() => {
    const image = imageRef.current;
    if (!image) return;
    const url = URL.createObjectURL(file);
    image.src = url;
    return () => URL.revokeObjectURL(url);
  }, [file]);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- measures the laid-out frame, which only the DOM knows.
  useLayoutEffect(() => {
    const frame = frameRef.current;
    if (!frame) return;
    const measure = () => {
      const rect = frame.getBoundingClientRect();
      setFrameSize({ width: Math.max(1, rect.width), height: Math.max(1, rect.height) });
    };
    measure();
    return observeResize(frame, measure);
  }, []);

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- transfers DOM focus and restores it on close.
  useEffect(() => {
    const previous = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    dialogRef.current?.focus();
    return () => previous?.focus();
  }, []);

  /** Keeps Tab cycling through the editor's own controls instead of the page behind it. */
  const trapTab = (event: KeyboardEvent) => {
    const dialog = dialogRef.current;
    if (!dialog) return;
    const focusable = [...dialog.querySelectorAll<HTMLElement>("button:not(:disabled), textarea")];
    const first = focusable[0];
    const last = focusable.at(-1);
    if (!first || !last) {
      event.preventDefault();
      return;
    }
    const active = document.activeElement;
    const outside = !dialog.contains(active) || active === dialog;
    if (event.shiftKey && (outside || active === first)) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && (outside || active === last)) {
      event.preventDefault();
      first.focus();
    }
  };

  const undo = () => {
    const next = undoMarks(history);
    setHistory(next);
    if (selectedId && !next.marks.some((mark) => mark.id === selectedId)) setSelectedId(null);
  };

  const redo = () => setHistory((current) => redoMarks(current));

  const addMark = (mark: ImageMark) => {
    setHistory(commitMarks(history, [...marks, mark]));
    setSelectedId(mark.id);
    pendingFocusRef.current = mark.id;
    setLayout((current) => layoutAfterAdd(current, marks.length + 1, layoutPinnedRef.current));
  };

  const removeMark = (id: string) => {
    setHistory(
      commitMarks(
        history,
        marks.filter((mark) => mark.id !== id),
      ),
    );
    if (selectedId === id) setSelectedId(null);
  };

  const clearMarks = () => {
    setHistory(commitMarks(history, []));
    setSelectedId(null);
  };

  const chooseLayout = (next: AnnotatorLayout) => {
    layoutPinnedRef.current = true;
    const active = document.activeElement;
    if (isTextEntry(active) && active.dataset.noteId)
      pendingFocusRef.current = active.dataset.noteId;
    setLayout(next);
  };

  /** Leaves without the changes, asking once first when that would lose any. */
  const close = () => {
    if (confirmingDiscard || sameMarks(marks, props.initialMarks)) {
      onClose();
      return;
    }
    setConfirmingDiscard(true);
  };

  const done = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await onDone([...marks]);
    } catch (error) {
      setSaving(false);
      throw error;
    }
    setSaving(false);
  };

  // The editor owns the keyboard while open, so Esc and Enter never reach the composer.
  const handleKeyDown = useEffectEvent((event: KeyboardEvent) => {
    setModifierHeld(event.metaKey || event.ctrlKey);
    if (event.key === "Tab") {
      trapTab(event);
      return;
    }
    const typing = isTextEntry(event.target) ? event.target : null;
    const command = event.metaKey || event.ctrlKey;
    const key = event.key.toLowerCase();
    if ((key === "z" || key === "y") && command) {
      const isRedo = key === "y" || event.shiftKey;
      // A note with text keeps the browser's own text undo; an empty one steps the marks.
      if (typing && typing.value.length > 0) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      if (isRedo) redo();
      else undo();
      return;
    }
    if (!command && !event.altKey && !typing && (key === "a" || key === "m")) {
      event.preventDefault();
      setBaseTool(key === "a" ? "arrow" : "mark");
      return;
    }
    if (
      !typing &&
      !command &&
      selectedId &&
      (event.key === "Delete" || event.key === "Backspace")
    ) {
      event.preventDefault();
      removeMark(selectedId);
      return;
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (typing) typing.blur();
      else if (selectedId) setSelectedId(null);
      else close();
      return;
    }
    if (event.key === "Enter" && !event.isComposing) {
      if (command) {
        event.preventDefault();
        event.stopImmediatePropagation();
        void done();
      } else if (typing && !event.shiftKey) {
        event.preventDefault();
        event.stopImmediatePropagation();
        typing.blur();
      }
    }
  });
  const handleKeyUp = useEffectEvent((event: KeyboardEvent) => {
    setModifierHeld(event.metaKey || event.ctrlKey);
  });
  const handleBlur = useEffectEvent(() => setModifierHeld(false));

  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- subscribes to window keyboard and focus events.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => handleKeyDown(event);
    const onKeyUp = (event: KeyboardEvent) => handleKeyUp(event);
    const onBlur = () => handleBlur();
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", onBlur);
    };
  }, []);

  const measure = (event: ReactPointerEvent<HTMLDivElement>) => {
    const rect = event.currentTarget.getBoundingClientRect();
    const w = Math.max(1, rect.width);
    const h = Math.max(1, rect.height);
    const x = Math.min(w, Math.max(0, event.clientX - rect.left));
    const y = Math.min(h, Math.max(0, event.clientY - rect.top));
    return { w, h, at: { x, y }, fraction: { x: clamp01(x / w), y: clamp01(y / h) } };
  };

  const blurTypingNote = () => {
    const active = document.activeElement;
    if (!isTextEntry(active)) return false;
    active.blur();
    return true;
  };

  const paintDraft = (draft: ImageMark) => {
    const svg = svgRef.current;
    if (!svg) return;
    const group = svg.querySelector('[data-mark-id="' + draft.id + '"]');
    if (group) paintMark(group, draft, width, height);
    const draftMarks = marks.map((mark) => (mark.id === draft.id ? draft : mark));
    if (layout === "rail") {
      computeImageMarkBadges(draftMarks, width, height).forEach((badge, index) => {
        const node = svg.querySelector('[data-badge-id="' + draftMarks[index]!.id + '"]');
        node?.setAttribute(
          "transform",
          "translate(" + String(badge.x) + " " + String(badge.y) + ")",
        );
      });
    } else {
      const card = placements.get(draft.id);
      const leader = svg.querySelector('[data-leader-id="' + draft.id + '"]');
      if (card && leader) {
        const line = leaderLine(draft, card, width, height);
        leader.setAttribute("x1", String(line.x1));
        leader.setAttribute("y1", String(line.y1));
      }
    }
  };

  const paintPreview = (start: Point, end: Point, arrow: boolean) => {
    const preview = svgRef.current?.querySelector<SVGGElement>("[data-preview]");
    if (!preview) return;
    const box = preview.querySelector<SVGRectElement>("[data-preview-box]");
    const line = preview.querySelector<SVGLineElement>("[data-preview-line]");
    const head = preview.querySelector<SVGPolygonElement>("[data-preview-head]");
    if (!box || !line || !head) return;
    box.style.display = arrow ? "none" : "";
    line.style.display = arrow ? "" : "none";
    head.style.display = arrow ? "" : "none";
    if (arrow) {
      const geometry = arrowGeometry(
        {
          id: "",
          kind: "arrow",
          x: start.x / width,
          y: start.y / height,
          toX: end.x / width,
          toY: end.y / height,
          note: "",
        },
        width,
        height,
      );
      line.setAttribute("x1", String(geometry.x1));
      line.setAttribute("y1", String(geometry.y1));
      line.setAttribute("x2", String(geometry.x2));
      line.setAttribute("y2", String(geometry.y2));
      head.setAttribute("points", geometry.head);
    } else {
      const rect = boxFromCorners(start, end);
      box.setAttribute("x", String(rect.x));
      box.setAttribute("y", String(rect.y));
      box.setAttribute("width", String(rect.width));
      box.setAttribute("height", String(rect.height));
    }
    preview.style.display = "";
  };

  const hidePreview = () => {
    const preview = svgRef.current?.querySelector<SVGGElement>("[data-preview]");
    if (preview) preview.style.display = "none";
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    setConfirmingDiscard(false);
    // A click away from a note only finishes it; the next press starts a mark.
    if (blurTypingNote()) return;
    const { w, h, at } = measure(event);
    const selected = marks.find((mark) => mark.id === selectedId);
    const handle = hitHandle(selected, at, w, h);
    if (selected && handle) {
      dragRef.current = { kind: "handle", handle, origin: selected, draft: selected, moved: false };
      event.currentTarget.setPointerCapture(event.pointerId);
      return;
    }
    const drawing = effectiveTool(baseTool, event.metaKey || event.ctrlKey) === "arrow";
    if (!drawing) {
      if (layout === "rail") {
        const hitBadge = badges.findLastIndex(
          (badge) => Math.hypot(badge.x - at.x, badge.y - at.y) <= badge.radius + 2,
        );
        if (hitBadge >= 0) {
          setSelectedId(marks[hitBadge]!.id);
          return;
        }
      }
      const hit = hitMark(marks, at, w, h);
      if (hit) {
        setSelectedId(hit.id);
        dragRef.current = { kind: "move", origin: hit, start: at, draft: hit, moved: false };
        event.currentTarget.setPointerCapture(event.pointerId);
        return;
      }
    }
    setSelectedId(null);
    dragRef.current = { kind: "draw", start: at, moved: false };
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    const drag = dragRef.current;
    const { w, h, at, fraction } = measure(event);
    if (!drag) {
      const selected = marks.find((mark) => mark.id === selectedId);
      const overMark =
        effectiveTool(baseTool, event.metaKey || event.ctrlKey) === "mark" &&
        (hitHandle(selected, at, w, h) || hitMark(marks, at, w, h));
      event.currentTarget.style.cursor = overMark ? "pointer" : "";
      return;
    }
    if (drag.kind === "draw") {
      if (
        !drag.moved &&
        Math.hypot(at.x - drag.start.x, at.y - drag.start.y) < CLICK_TOLERANCE_PX
      ) {
        return;
      }
      drag.moved = true;
      paintPreview(
        drag.start,
        at,
        effectiveTool(baseTool, event.metaKey || event.ctrlKey) === "arrow",
      );
      return;
    }
    if (drag.kind === "move") {
      if (!drag.moved && Math.hypot(at.x - drag.start.x, at.y - drag.start.y) < MOVE_TOLERANCE_PX) {
        return;
      }
      drag.moved = true;
      drag.draft = moveMark(
        drag.origin,
        fraction.x - drag.start.x / w,
        fraction.y - drag.start.y / h,
      );
    } else {
      drag.moved = true;
      drag.draft =
        drag.handle === "from" || drag.handle === "to"
          ? moveArrowEnd(drag.origin, drag.handle, fraction)
          : resizeBox(drag.origin, drag.handle, fraction);
    }
    paintDraft(drag.draft);
  };

  const endDrag = (event: ReactPointerEvent<HTMLDivElement>, cancelled: boolean) => {
    const drag = dragRef.current;
    if (!drag) return;
    dragRef.current = null;
    if (event.currentTarget.hasPointerCapture(event.pointerId)) {
      event.currentTarget.releasePointerCapture(event.pointerId);
    }
    hidePreview();
    if (drag.kind !== "draw") {
      if (cancelled) paintDraft(drag.origin);
      else if (drag.moved) {
        const draft = drag.draft;
        setHistory(
          commitMarks(
            history,
            marks.map((mark) => (mark.id === draft.id ? draft : mark)),
          ),
        );
      }
      return;
    }
    if (cancelled) return;
    const { w, h, at } = measure(event);
    const arrow = effectiveTool(baseTool, event.metaKey || event.ctrlKey) === "arrow";
    const id = randomUUID();
    const start = { x: clamp01(drag.start.x / w), y: clamp01(drag.start.y / h) };
    const end = { x: clamp01(at.x / w), y: clamp01(at.y / h) };
    if (!drag.moved) {
      if (!arrow) addMark({ id, kind: "point", x: start.x, y: start.y, note: "" });
    } else if (arrow) {
      addMark({ id, kind: "arrow", x: start.x, y: start.y, toX: end.x, toY: end.y, note: "" });
    } else {
      addMark({ id, kind: "box", ...boxFromCorners(start, end), note: "" });
    }
  };

  const onStagePointerDown = (event: ReactPointerEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget) return;
    setConfirmingDiscard(false);
    if (!blurTypingNote()) setSelectedId(null);
  };

  const noteField = (mark: ImageMark) => (
    <textarea
      ref={(element) => {
        if (!element) return;
        growNote(element);
        if (pendingFocusRef.current === mark.id) {
          pendingFocusRef.current = null;
          element.focus({ preventScroll: true });
        }
      }}
      rows={1}
      data-note-id={mark.id}
      className="image-annotator-note-input"
      placeholder={gt("What should change here?")}
      value={mark.note}
      maxLength={COMPOSER_CONTEXT_PREVIEW_COMMENT_MAX_CHARS}
      aria-label={gt("Annotation note")}
      onChange={(event) => {
        growNote(event.currentTarget);
        setHistory((current) => setMarkNote(current, mark.id, event.currentTarget.value));
      }}
      onFocus={() => setSelectedId(mark.id)}
    />
  );

  const deleteButton = (mark: ImageMark) => (
    <button
      type="button"
      className="image-annotator-note-delete"
      aria-label={gt("Delete annotation")}
      onClick={() => removeMark(mark.id)}
    >
      <XIcon className="size-3.5" />
    </button>
  );

  const selectedMark = marks.find((mark) => mark.id === selectedId);

  return createPortal(
    <div
      ref={dialogRef}
      className="image-annotator"
      data-layout={layout}
      role="dialog"
      aria-modal="true"
      aria-label={gt("Annotate image")}
      tabIndex={-1}
    >
      <div className="image-annotator-bar">
        <strong>
          <T>Annotate image</T>
        </strong>
        <div
          className="image-annotator-segments"
          role="radiogroup"
          aria-label={gt("Annotation tool")}
        >
          <button
            type="button"
            role="radio"
            aria-checked={tool === "mark"}
            className="image-annotator-segment"
            onClick={() => setBaseTool("mark")}
          >
            <MousePointer2Icon className="size-3.5" />
            {gt("Mark", { $context: "noun, point or box annotation tool" })}
            <kbd>M</kbd>
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={tool === "arrow"}
            className="image-annotator-segment"
            onClick={() => setBaseTool("arrow")}
          >
            <MoveUpRightIcon className="size-3.5" />
            <T>Arrow</T>
            <kbd>A</kbd>
          </button>
        </div>
        <div className="image-annotator-segments" role="radiogroup" aria-label={gt("Note layout")}>
          <button
            type="button"
            role="radio"
            aria-checked={layout === "callouts"}
            className="image-annotator-segment"
            onClick={() => chooseLayout("callouts")}
          >
            <T>Callouts</T>
          </button>
          <button
            type="button"
            role="radio"
            aria-checked={layout === "rail"}
            className="image-annotator-segment"
            onClick={() => chooseLayout("rail")}
          >
            <T>Side rail</T>
          </button>
        </div>
        <div className="image-annotator-actions">
          <button
            type="button"
            className="image-annotator-action"
            aria-label={gt("Undo")}
            disabled={history.past.length === 0}
            onClick={undo}
          >
            <Undo2Icon className="size-3.5" />
          </button>
          <button
            type="button"
            className="image-annotator-action"
            aria-label={gt("Redo")}
            disabled={history.future.length === 0}
            onClick={redo}
          >
            <Redo2Icon className="size-3.5" />
          </button>
          {selectedMark ? (
            <button
              type="button"
              className="image-annotator-action"
              onClick={() => removeMark(selectedMark.id)}
            >
              <Trash2Icon className="size-3.5" />
              <T>Delete</T>
            </button>
          ) : null}
          {marks.length > 1 ? (
            <button type="button" className="image-annotator-action" onClick={clearMarks}>
              <EraserIcon className="size-3.5" />
              <T>Clear all</T>
            </button>
          ) : null}
          <button type="button" className="image-annotator-action" onClick={close}>
            {confirmingDiscard ? <T>Discard changes</T> : <T>Cancel</T>}
          </button>
          <button
            type="button"
            className="image-annotator-action"
            data-primary
            disabled={saving}
            onClick={() => void done()}
          >
            {saving ? <T>Saving…</T> : <T>Done</T>}
          </button>
        </div>
      </div>
      <div className="image-annotator-body">
        <div className="image-annotator-stage" onPointerDown={onStagePointerDown}>
          <div
            ref={frameRef}
            role="application"
            aria-label={gt("Annotation canvas")}
            className="image-annotator-frame"
            data-arrow={tool === "arrow" || undefined}
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={(event) => endDrag(event, false)}
            onPointerCancel={(event) => endDrag(event, true)}
          >
            <img
              ref={imageRef}
              alt={gt("Image to annotate")}
              className="image-annotator-image"
              draggable={false}
            />
            <svg
              ref={svgRef}
              className="image-annotator-marks"
              data-dim={(layout === "rail" && hoverId !== null) || undefined}
              viewBox={"0 0 " + String(width) + " " + String(height)}
              aria-hidden="true"
            >
              {layout === "callouts"
                ? marks.map((mark) => {
                    const card = placements.get(mark.id);
                    if (!card) return null;
                    const line = leaderLine(mark, card, width, height);
                    return (
                      <line
                        key={mark.id}
                        data-leader-id={mark.id}
                        className="image-annotator-leader"
                        {...line}
                      />
                    );
                  })
                : null}
              {marks.map((mark) => (
                <MarkShape
                  key={mark.id}
                  mark={mark}
                  width={width}
                  height={height}
                  selected={selectedId === mark.id}
                  hovered={hoverId === mark.id}
                />
              ))}
              {layout === "rail"
                ? marks.map((mark, index) => {
                    const badge = badges[index];
                    if (!badge) return null;
                    return (
                      <g
                        key={mark.id}
                        data-badge-id={mark.id}
                        data-selected={selectedId === mark.id || undefined}
                        data-hovered={hoverId === mark.id || undefined}
                        className="image-annotator-badge"
                        transform={"translate(" + String(badge.x) + " " + String(badge.y) + ")"}
                      >
                        <circle r={badge.radius} />
                        <text fontSize={badge.radius * 1.15}>{index + 1}</text>
                      </g>
                    );
                  })
                : null}
              <g data-preview style={{ display: "none" }} className="image-annotator-preview">
                <rect
                  data-preview-box
                  style={{ display: "none" }}
                  className="image-annotator-ring"
                  rx={2}
                />
                <line
                  data-preview-line
                  style={{ display: "none" }}
                  className="image-annotator-ring"
                />
                <polygon
                  data-preview-head
                  style={{ display: "none" }}
                  className="image-annotator-head"
                />
              </g>
            </svg>
            {layout === "callouts"
              ? marks.map((mark) => {
                  const card = placements.get(mark.id);
                  if (!card) return null;
                  return (
                    <div
                      key={mark.id}
                      className="image-annotator-callout"
                      data-selected={selectedId === mark.id || undefined}
                      style={{ left: card.left, top: card.top, width: card.width }}
                      onPointerDown={(event) => event.stopPropagation()}
                    >
                      {noteField(mark)}
                      {deleteButton(mark)}
                    </div>
                  );
                })
              : null}
          </div>
        </div>
        {layout === "rail" ? (
          <ol className="image-annotator-rail" aria-label={gt("Annotation notes")}>
            {marks.map((mark, index) => (
              <li
                key={mark.id}
                className="image-annotator-row"
                data-selected={selectedId === mark.id || undefined}
                onPointerEnter={() => setHoverId(mark.id)}
                onPointerLeave={() => setHoverId(null)}
                onPointerDown={() => setSelectedId(mark.id)}
              >
                <span className="image-annotator-row-number">{index + 1}</span>
                {noteField(mark)}
                {deleteButton(mark)}
              </li>
            ))}
            {marks.length === 0 ? (
              <li className="image-annotator-rail-empty">
                <T>Marks you add are listed here.</T>
              </li>
            ) : null}
          </ol>
        ) : null}
      </div>
      <p className="image-annotator-hint" data-warning={confirmingDiscard || undefined}>
        {confirmingDiscard ? (
          <T>Your changes will be lost. Press Esc or Cancel again to leave, or ⌘↩ to add them.</T>
        ) : tool === "arrow" ? (
          <T>Drag from what you mean to where it should go.</T>
        ) : (
          <T>Click to point · drag to box · hold ⌘ for an arrow · ⌘Z undoes · ⌘↩ adds your marks</T>
        )}
      </p>
    </div>,
    document.body,
  );
}
