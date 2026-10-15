/**
 * Interface sounds: the composer's machined press and rotary clicks (peach-pi's
 * recordings) and the sidebar's hover tick (YardSmith's synthesised detent).
 *
 * Browsers keep audio silent until the page sees a gesture, so the context starts
 * on the first pointer or key press and anything earlier is skipped. Between
 * bursts it suspends, so an idle window holds no audio output open. Everything is
 * quiet while the `interfaceSounds` client setting is off.
 */
import { getClientSettings } from "~/hooks/useSettings";

import pressDownUrl from "../assets/sounds/press-down.mp3?url";
import pressUpUrl from "../assets/sounds/press-up.mp3?url";
import rotaryUrl from "../assets/sounds/rotary.mp3?url";

const MASTER_VOLUME = 0.3;
const IDLE_SUSPEND_MS = 2_000;
/** The release waits for the press to finish, so a fast tap never smears into one click. */
const FALLBACK_PRESS_MS = 260;
/** A sweep across the sidebar ticks like a detent instead of buzzing. */
const TICK_INTERVAL_MS = 30;
const TICK_PITCH_SPREAD = 0.04;

const RECORDINGS = { pressDown: pressDownUrl, pressUp: pressUpUrl, rotary: rotaryUrl };
type Recording = keyof typeof RECORDINGS;

let context: AudioContext | null = null;
let master: GainNode | null = null;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
let lastTickAt = Number.NEGATIVE_INFINITY;
let tickBuffer: AudioBuffer | null = null;
const recordings = new Map<Recording, AudioBuffer>();

function enabled(): boolean {
  return getClientSettings().interfaceSounds;
}

/** Starts audio on the first gesture and decodes the recordings once. */
function wake(): void {
  if (context || typeof AudioContext === "undefined") return;
  context = new AudioContext();
  master = context.createGain();
  master.gain.value = MASTER_VOLUME;
  master.connect(context.destination);
  const started = context;
  for (const [name, url] of Object.entries(RECORDINGS) as [Recording, string][]) {
    void fetch(url)
      .then((response) => response.arrayBuffer())
      .then((data) => started.decodeAudioData(data))
      .then((buffer) => recordings.set(name, trimLeadingSilence(started, buffer)))
      .catch(() => undefined);
  }
  scheduleSuspend();
}

/** Thread rows only; the rest of the sidebar stays quiet. */
const SIDEBAR_ITEM = '[data-sidebar="sidebar"] [data-thread-item]';
let hoveredSidebarItem: Element | null = null;

/** Ticks as the pointer moves onto another thread; scrolling threads under it ticks too. */
function onPointerOver(event: PointerEvent): void {
  if (event.pointerType === "touch" || !(event.target instanceof Element)) return;
  const item = event.target.closest(SIDEBAR_ITEM);
  if (item === hoveredSidebarItem) return;
  hoveredSidebarItem = item;
  if (item && !item.matches(':disabled, [aria-disabled="true"]')) playHoverTick();
}

/** Listens for the first gesture and for sidebar hovers. Call once as the app starts. */
export function installInterfaceSounds(): void {
  window.addEventListener("pointerdown", wake, { capture: true });
  window.addEventListener("keydown", wake, { capture: true });
  window.addEventListener("pointerover", onPointerOver, { passive: true });
}

function scheduleSuspend(): void {
  clearTimeout(idleTimer);
  idleTimer = setTimeout(() => void context?.suspend().catch(() => undefined), IDLE_SUSPEND_MS);
}

function play(buffer: AudioBuffer | null | undefined, rate = 1, volume = 1): void {
  if (!buffer || !context || !master || !enabled()) return;
  const output = master;
  const audio = context;
  const start = () => {
    const source = audio.createBufferSource();
    source.buffer = buffer;
    source.playbackRate.value = rate;
    const gain = audio.createGain();
    gain.gain.value = volume;
    source.connect(gain).connect(output);
    source.addEventListener("ended", () => {
      source.disconnect();
      gain.disconnect();
    });
    source.start();
  };
  if (audio.state === "running") start();
  else void audio.resume().then(start, () => undefined);
  scheduleSuspend();
}

/** Recordings start a beat after the file does; cut that so a press sounds on the press. */
function trimLeadingSilence(audio: AudioContext, buffer: AudioBuffer): AudioBuffer {
  const channel = buffer.getChannelData(0);
  let peak = 0;
  for (const sample of channel) peak = Math.max(peak, Math.abs(sample));
  const threshold = peak * 0.04;
  let first = 0;
  while (first < channel.length && Math.abs(channel[first] ?? 0) < threshold) first += 1;
  const start = Math.max(0, first - Math.floor(buffer.sampleRate * 0.002));
  if (start === 0) return buffer;
  const trimmed = audio.createBuffer(
    buffer.numberOfChannels,
    buffer.length - start,
    buffer.sampleRate,
  );
  for (let index = 0; index < buffer.numberOfChannels; index += 1) {
    trimmed.copyToChannel(buffer.getChannelData(index).subarray(start), index);
  }
  return trimmed;
}

/** YardSmith's tick: a sub-millisecond noise snap over a 4.2 kHz ring. */
function renderTick(audio: AudioContext): AudioBuffer {
  const rate = audio.sampleRate;
  const samples = new Float32Array(Math.ceil(0.006 * rate));
  for (let index = 0; index < samples.length; index += 1) {
    const time = index / rate;
    const snap = 0.6 * (Math.random() * 2 - 1) * Math.exp(-time / 0.0004);
    const ring = 0.4 * Math.sin(2 * Math.PI * 4200 * time) * Math.exp(-time / 0.0012);
    samples[index] = snap + ring;
  }
  const buffer = audio.createBuffer(1, samples.length, rate);
  buffer.copyToChannel(samples, 0);
  return buffer;
}

/** Plays the press now and returns the release, which sounds only once the press has played out. */
export function pressClick(): () => void {
  const press = recordings.get("pressDown");
  play(press);
  const pressedAt = performance.now();
  const pressMs = press ? press.duration * 1000 : FALLBACK_PRESS_MS;
  return () => {
    const wait = pressMs - (performance.now() - pressedAt);
    if (wait <= 0) play(recordings.get("pressUp"));
    else setTimeout(() => play(recordings.get("pressUp")), wait);
  };
}

/** One detent of a rotary switch, pitched a little at random like a real one. */
export function playRotary(): void {
  play(recordings.get("rotary"), 0.9 + Math.random() * 0.2);
}

/** The quiet tick as the pointer passes a sidebar item. */
export function playHoverTick(): void {
  const now = performance.now();
  if (now - lastTickAt < TICK_INTERVAL_MS || !context) return;
  lastTickAt = now;
  tickBuffer ??= renderTick(context);
  // The tick is rendered at full scale; YardSmith plays it at 0.12 of its own master.
  play(tickBuffer, 1 + (Math.random() - 0.5) * TICK_PITCH_SPREAD * 2, 0.12 / MASTER_VOLUME);
}
