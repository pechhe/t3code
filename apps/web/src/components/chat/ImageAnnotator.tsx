import { EraserIcon, XIcon } from "lucide-react";
import {
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { createPortal } from "react-dom";

import { observeResize } from "~/lib/observeResize";
import { randomUUID } from "~/lib/utils";
import { notedMarks, type ImageMark } from "~/lib/imageAnnotation";

type Point = { x: number; y: number };

/** A press that travels less than this many pixels is a click, which drops a point. */
const CLICK_TOLERANCE_PX = 6;

function clamp01(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function noteStyle(x: number, y: number): CSSProperties {
  const translateX = x > 0.85 ? "-100%" : x < 0.15 ? "0" : "-50%";
  const translateY = y > 0.7 ? "-115%" : "14px";
  return {
    left: `${x * 100}%`,
    top: `${y * 100}%`,
    transform: `translate(${translateX}, ${translateY})`,
  };
}

/**
 * Full-screen editor for marking up one composer image. Click drops a point, drag draws a
 * box, ⌘/Ctrl-drag draws an arrow; each mark gets a note. Marks left without a note are
 * dropped when the editor closes.
 */
export function ImageAnnotator(props: {
  file: File;
  initialMarks: ReadonlyArray<ImageMark>;
  onDone: (marks: ImageMark[]) => Promise<void>;
  onClose: () => void;
}) {
  const { file, onDone, onClose } = props;
  const [imageUrl, setImageUrl] = useState<string | null>(null);
  const [marks, setMarks] = useState<ImageMark[]>(() =>
    props.initialMarks.map((mark) => ({ ...mark })),
  );
  const [activeId, setActiveId] = useState<string | null>(null);
  const [drag, setDrag] = useState<{ start: Point; current: Point; arrow: boolean } | null>(null);
  const [frameSize, setFrameSize] = useState({ width: 1, height: 1 });
  const [arrowHeld, setArrowHeld] = useState(false);
  const [saving, setSaving] = useState(false);
  const frameRef = useRef<HTMLDivElement | null>(null);
  const noteInputRef = useRef<HTMLInputElement | null>(null);

  useEffect(() => {
    const url = URL.createObjectURL(file);
    setImageUrl(url);
    return () => URL.revokeObjectURL(url);
  }, [file]);

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

  useEffect(() => {
    if (activeId) noteInputRef.current?.focus();
  }, [activeId]);

  /** Closes the open note; a mark whose note is still empty goes with it. */
  const dismissActiveNote = () => {
    if (!activeId) return;
    setMarks((current) =>
      current.filter((mark) => mark.id !== activeId || mark.note.trim().length > 0),
    );
    setActiveId(null);
  };

  const close = () => onClose();

  const done = async () => {
    if (saving) return;
    setSaving(true);
    try {
      await onDone(notedMarks(marks));
    } finally {
      setSaving(false);
    }
  };

  // The editor owns the keyboard while open, so Esc and Enter never reach the composer.
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Meta" || event.key === "Control") setArrowHeld(true);
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        if (activeId) dismissActiveNote();
        else close();
        return;
      }
      if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
        event.preventDefault();
        event.stopImmediatePropagation();
        void done();
      }
    };
    const onKeyUp = (event: KeyboardEvent) => {
      if (event.key === "Meta" || event.key === "Control") setArrowHeld(false);
    };
    const onBlur = () => setArrowHeld(false);
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
      window.removeEventListener("blur", onBlur);
    };
  });

  const pointFromEvent = (event: ReactPointerEvent<HTMLDivElement>): Point => {
    const rect = event.currentTarget.getBoundingClientRect();
    return {
      x: clamp01((event.clientX - rect.left) / rect.width),
      y: clamp01((event.clientY - rect.top) / rect.height),
    };
  };

  const onPointerDown = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (event.button !== 0) return;
    dismissActiveNote();
    const point = pointFromEvent(event);
    setDrag({ start: point, current: point, arrow: event.metaKey || event.ctrlKey });
    event.currentTarget.setPointerCapture(event.pointerId);
  };

  const onPointerMove = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    const current = pointFromEvent(event);
    setDrag({ ...drag, current, arrow: drag.arrow || event.metaKey || event.ctrlKey });
  };

  const onPointerUp = (event: ReactPointerEvent<HTMLDivElement>) => {
    if (!drag) return;
    const { start, arrow } = drag;
    const end = pointFromEvent(event);
    setDrag(null);
    event.currentTarget.releasePointerCapture(event.pointerId);
    const distancePx = Math.hypot(
      (end.x - start.x) * frameSize.width,
      (end.y - start.y) * frameSize.height,
    );
    const id = randomUUID();
    const mark: ImageMark =
      distancePx < CLICK_TOLERANCE_PX
        ? { id, kind: "point", x: start.x, y: start.y, note: "" }
        : arrow
          ? { id, kind: "arrow", x: start.x, y: start.y, toX: end.x, toY: end.y, note: "" }
          : {
              id,
              kind: "box",
              x: Math.min(start.x, end.x),
              y: Math.min(start.y, end.y),
              width: Math.abs(end.x - start.x),
              height: Math.abs(end.y - start.y),
              note: "",
            };
    setMarks((current) => [...current, mark]);
    setActiveId(id);
  };

  const updateNote = (id: string, note: string) =>
    setMarks((current) => current.map((mark) => (mark.id === id ? { ...mark, note } : mark)));

  const removeMark = (id: string) => {
    setMarks((current) => current.filter((mark) => mark.id !== id));
    if (activeId === id) setActiveId(null);
  };

  const toggleNote = (id: string) => {
    if (activeId === id) {
      dismissActiveNote();
      return;
    }
    dismissActiveNote();
    setActiveId(id);
  };

  const onNoteKeyDown = (event: ReactKeyboardEvent<HTMLInputElement>, id: string) => {
    if (event.key === "Enter" && !event.metaKey && !event.ctrlKey) {
      event.preventDefault();
      dismissActiveNote();
      return;
    }
    if ((event.key === "Backspace" || event.key === "Delete") && !event.currentTarget.value) {
      event.preventDefault();
      removeMark(id);
    }
  };

  const lineStyle = (from: Point, to: Point): CSSProperties => {
    const dx = (to.x - from.x) * frameSize.width;
    const dy = (to.y - from.y) * frameSize.height;
    return {
      left: `${from.x * 100}%`,
      top: `${from.y * 100}%`,
      width: `${Math.hypot(dx, dy)}px`,
      transform: `rotate(${Math.atan2(dy, dx)}rad)`,
    };
  };

  const badge = (mark: ImageMark, index: number, className?: string, style?: CSSProperties) => (
    <button
      type="button"
      className={`image-annotator-badge${className ? ` ${className}` : ""}`}
      data-active={activeId === mark.id || undefined}
      style={style}
      aria-label={`Annotation ${String(index + 1)}`}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={() => toggleNote(mark.id)}
    >
      {index + 1}
    </button>
  );

  const preview = drag
    ? drag.arrow
      ? { kind: "arrow" as const }
      : {
          kind: "box" as const,
          left: Math.min(drag.start.x, drag.current.x),
          top: Math.min(drag.start.y, drag.current.y),
          width: Math.abs(drag.current.x - drag.start.x),
          height: Math.abs(drag.current.y - drag.start.y),
        }
    : null;

  return createPortal(
    <div className="image-annotator" role="dialog" aria-modal="true" aria-label="Annotate image">
      <div className="image-annotator-heading">
        <strong>Annotate image</strong>
        <span>Click to point · drag a box · ⌘-drag an arrow</span>
      </div>
      <div className="image-annotator-stage">
        <div
          ref={frameRef}
          role="application"
          aria-label="Annotation canvas"
          className="image-annotator-frame"
          data-arrow={arrowHeld || drag?.arrow || undefined}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onPointerCancel={() => setDrag(null)}
        >
          {imageUrl ? (
            <img
              src={imageUrl}
              alt="Image to annotate"
              className="image-annotator-image"
              draggable={false}
            />
          ) : null}

          {drag && preview?.kind === "arrow" ? (
            <span
              className="image-annotator-line"
              data-preview
              style={lineStyle(drag.start, drag.current)}
            />
          ) : null}
          {preview?.kind === "box" && (preview.width > 0.003 || preview.height > 0.003) ? (
            <span
              className="image-annotator-box"
              data-preview
              style={{
                left: `${preview.left * 100}%`,
                top: `${preview.top * 100}%`,
                width: `${preview.width * 100}%`,
                height: `${preview.height * 100}%`,
              }}
            />
          ) : null}

          {marks.map((mark, index) => (
            <div key={mark.id}>
              {mark.kind === "box" ? (
                <div
                  className="image-annotator-box"
                  data-active={activeId === mark.id || undefined}
                  style={{
                    left: `${mark.x * 100}%`,
                    top: `${mark.y * 100}%`,
                    width: `${mark.width * 100}%`,
                    height: `${mark.height * 100}%`,
                  }}
                >
                  {badge(mark, index, "image-annotator-badge-anchor")}
                </div>
              ) : mark.kind === "arrow" ? (
                <>
                  <div
                    className="image-annotator-line"
                    style={lineStyle(mark, { x: mark.toX, y: mark.toY })}
                  />
                  {badge(mark, index, "image-annotator-badge-anchor", {
                    left: `${mark.x * 100}%`,
                    top: `${mark.y * 100}%`,
                  })}
                </>
              ) : (
                <div
                  className="image-annotator-point"
                  style={{ left: `${mark.x * 100}%`, top: `${mark.y * 100}%` }}
                >
                  <i />
                  {badge(mark, index)}
                </div>
              )}
              {activeId === mark.id ? (
                <div
                  className="image-annotator-note"
                  role="group"
                  aria-label="Annotation note"
                  style={noteStyle(mark.x, mark.y)}
                  onPointerDown={(event) => event.stopPropagation()}
                >
                  <input
                    ref={noteInputRef}
                    type="text"
                    placeholder="What should change here?"
                    value={mark.note}
                    aria-label="Annotation note"
                    onChange={(event) => updateNote(mark.id, event.currentTarget.value)}
                    onKeyDown={(event) => onNoteKeyDown(event, mark.id)}
                  />
                  <button
                    type="button"
                    className="image-annotator-note-delete"
                    aria-label="Delete annotation"
                    onClick={() => removeMark(mark.id)}
                  >
                    <XIcon className="size-3.5" />
                  </button>
                </div>
              ) : null}
            </div>
          ))}
        </div>
      </div>
      <p className="image-annotator-hint">
        {arrowHeld
          ? "Arrow mode: drag to show direction."
          : "Enter closes a note · Backspace on an empty note deletes the mark · Esc leaves"}
      </p>
      <div className="image-annotator-actions">
        {marks.length > 0 ? (
          <button
            type="button"
            className="image-annotator-action"
            onClick={() => {
              setMarks([]);
              setActiveId(null);
            }}
          >
            <EraserIcon className="size-3.5" />
            Clear all
          </button>
        ) : null}
        <button type="button" className="image-annotator-action" onClick={close}>
          Cancel
        </button>
        <button
          type="button"
          className="image-annotator-action"
          data-primary
          disabled={saving}
          onClick={() => void done()}
        >
          {saving ? "Saving…" : "Done"}
        </button>
        <span className="image-annotator-kbd">Esc · ⌘↩</span>
      </div>
    </div>,
    document.body,
  );
}
