/**
 * A compaction seen on the context bar: the segments of context being folded away fall into the
 * black hole, which swells and swallows them. Plays once per compaction and then stops, moving
 * only transform, opacity and colour on a few short-lived elements.
 */

const DURATION_MS = 1_700;
/** The share of the run spent pulling segments in; the rest is the swallow. */
const PULL_SHARE = 0.86;
/** Each segment's fall as a share of the run, and how far the last one starts behind the first. */
const FALL_SHARE = 0.4;
const STAGGER_SHARE = 0.46;
const MAX_SEGMENTS = 60;
const FALL_STEPS = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.86, 0.93, 1];
const HOLE_STEPS = [0, 0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.72, 0.86, 0.9, 0.95, 1];

const clamp = (value: number) => Math.max(0, Math.min(1, value));
const smooth = (value: number) => {
  const share = clamp(value);
  return share * share * (3 - 2 * share);
};

function fallKeyframes(input: {
  readonly dx: number;
  readonly dy: number;
  readonly phase: number;
  readonly lit: string;
  readonly hot: string;
}): Array<Keyframe> {
  return FALL_STEPS.map((q) => {
    const fall = q * q * q;
    const swirl = Math.sin(q * 7 + input.phase) * 5 * Math.sin(q * Math.PI) * smooth(q * 2);
    return {
      offset: q,
      transform: `translate(${input.dx * fall}px, ${input.dy * fall + swirl}px) scale(${
        1 + 3.2 * q * q
      }, ${1 - 0.86 * smooth(q * 1.5)})`,
      backgroundColor: `color-mix(in oklch, ${input.hot} ${Math.round(smooth(q * 1.5) * 100)}%, ${input.lit})`,
      opacity: q < 0.86 ? 1 : 1 - (q - 0.86) / 0.14,
    };
  });
}

function holeKeyframes(base: string, hot: string): Array<Keyframe> {
  return HOLE_STEPS.map((p) => {
    const heat =
      p < PULL_SHARE
        ? smooth((p / PULL_SHARE) * 1.4)
        : 1 - smooth((p - PULL_SHARE) / (1 - PULL_SHARE));
    return {
      offset: p,
      transform: `scale(${1 + 0.42 * heat})`,
      color: `color-mix(in oklch, ${hot} ${Math.round(heat * 100)}%, ${base})`,
      filter: `drop-shadow(0 0 ${heat * 6}px color-mix(in oklch, ${hot} ${Math.round(heat * 80)}%, transparent))`,
    };
  });
}

/**
 * Plays the pull from `fromShare` down to `toShare` of the track. `onProgress` receives the
 * share of the window still shown as used while it runs, then null. Returns a function that
 * stops it early. Does nothing when the system asks for reduced motion.
 */
export function playCompactionPull(input: {
  readonly track: HTMLElement;
  readonly hole: Element;
  readonly fromShare: number;
  readonly toShare: number;
  readonly onProgress: (usedShare: number | null) => void;
}): () => void {
  const { track, hole } = input;
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) return () => undefined;
  const trackRect = track.getBoundingClientRect();
  const holeRect = hole.getBoundingClientRect();
  if (trackRect.width <= 0 || holeRect.width <= 0) return () => undefined;

  const style = getComputedStyle(track);
  const segment = Number.parseFloat(style.getPropertyValue("--crt-seg")) || 9;
  const gap = Number.parseFloat(style.getPropertyValue("--crt-seg-gap")) || 3;
  const fromX = clamp(input.fromShare) * trackRect.width;
  const toX = clamp(input.toShare) * trackRect.width;
  const pitch = Math.max(segment + gap, (fromX - toX) / MAX_SEGMENTS);
  const holeX = holeRect.left + holeRect.width / 2;
  const holeY = holeRect.top + holeRect.height / 2;

  const probe = document.createElement("span");
  probe.className = "device-context__pull";
  track.append(probe);
  const lit = getComputedStyle(probe).backgroundColor;
  const hot = getComputedStyle(probe).color;
  probe.remove();

  const layer = document.createElement("span");
  layer.className = "device-context__pull-layer";
  layer.setAttribute("aria-hidden", "true");
  const starts: Array<number> = [];
  for (let x = Math.ceil(toX / pitch) * pitch; x + segment <= fromX + 0.5; x += pitch)
    starts.push(x);
  const animations: Array<Animation> = [];
  const segments = starts.map((x) => {
    const element = document.createElement("span");
    element.className = "device-context__pull";
    element.style.left = `${x}px`;
    element.style.width = `${segment}px`;
    layer.append(element);
    return element;
  });
  track.append(layer);
  segments.forEach((element, index) => {
    const x = starts[index]!;
    // The segment nearest the hole leaves first.
    const behind = (segments.length - 1 - index) / Math.max(1, segments.length - 1);
    animations.push(
      element.animate(
        fallKeyframes({
          dx: holeX - (trackRect.left + x + segment / 2),
          dy: holeY - (trackRect.top + trackRect.height / 2),
          phase: index * 1.3,
          lit,
          hot,
        }),
        {
          duration: DURATION_MS * FALL_SHARE,
          delay: DURATION_MS * STAGGER_SHARE * behind,
          fill: "both",
        },
      ),
    );
  });

  animations.push(
    hole.animate(holeKeyframes(getComputedStyle(hole).color, hot), { duration: DURATION_MS }),
  );
  const ring = document.createElement("span");
  ring.className = "device-context__bh-gulp";
  ring.setAttribute("aria-hidden", "true");
  hole.parentElement?.append(ring);
  animations.push(
    ring.animate(
      [
        { transform: "scale(1)", opacity: 1 },
        { transform: "scale(3.6)", opacity: 0 },
      ],
      {
        duration: DURATION_MS * (1 - PULL_SHARE),
        delay: DURATION_MS * PULL_SHARE,
        fill: "backwards",
      },
    ),
  );

  let frame = 0;
  let stopped = false;
  const stop = () => {
    if (stopped) return;
    stopped = true;
    cancelAnimationFrame(frame);
    for (const animation of animations) animation.cancel();
    layer.remove();
    ring.remove();
    input.onProgress(null);
  };
  const startedAt = performance.now();
  const step = (now: number) => {
    const progress = clamp((now - startedAt) / DURATION_MS);
    if (progress >= 1) return stop();
    const pulled = clamp(progress / PULL_SHARE);
    input.onProgress(input.fromShare - (input.fromShare - input.toShare) * pulled * pulled);
    frame = requestAnimationFrame(step);
  };
  frame = requestAnimationFrame(step);
  return stop;
}
