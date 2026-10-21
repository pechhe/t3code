/**
 * Interface sounds: the composer's machined press and rotary clicks (peach-pi's
 * recordings), the keycaps' clicks, the synthesised cue that replaces the
 * click on a send or a queue, the cue that marks a thread settling (one of them peach-pi's metal whoosh),
 * and the sidebar's hover tick (YardSmith's synthesised detent).
 *
 * Browsers keep audio silent until the page sees a gesture, so the context starts
 * on the first pointer or key press and anything earlier is skipped. Between
 * bursts it suspends, so an idle window holds no audio output open. Everything is
 * quiet while the `interfaceSounds` client setting is off.
 */
import type { QueueSound, SendSound, SettleSound } from "@t3tools/contracts/settings";
import type { MouseEvent as ReactMouseEvent, PointerEvent as ReactPointerEvent } from "react";

import { getClientSettings } from "~/hooks/useSettings";

import metalWhooshUrl from "../assets/sounds/metal-whoosh.mp3?url";
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
/** A bulk settle lands its threads back to back; only the first of a burst sounds. */
const SETTLE_COOLDOWN_MS = 250;

const RECORDINGS = {
  pressDown: pressDownUrl,
  pressUp: pressUpUrl,
  rotary: rotaryUrl,
  metalWhoosh: metalWhooshUrl,
};
type Recording = keyof typeof RECORDINGS;

let context: AudioContext | null = null;
let master: GainNode | null = null;
let idleTimer: ReturnType<typeof setTimeout> | undefined;
let lastTickAt = Number.NEGATIVE_INFINITY;
let lastSettleAt = Number.NEGATIVE_INFINITY;
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

/** Runs `build` against a running context, scheduled from its current time. */
function synth(build: (audio: AudioContext, output: AudioNode, at: number) => void): void {
  if (!context || !master || !enabled()) return;
  const output = master;
  const audio = context;
  const start = () => build(audio, output, audio.currentTime);
  if (audio.state === "running") start();
  else void audio.resume().then(start, () => undefined);
  scheduleSuspend();
}

function noise(audio: AudioContext, seconds: number): AudioBuffer {
  const buffer = audio.createBuffer(1, Math.ceil(seconds * audio.sampleRate), audio.sampleRate);
  const samples = buffer.getChannelData(0);
  for (let index = 0; index < samples.length; index += 1) samples[index] = Math.random() * 2 - 1;
  return buffer;
}

/** A breath of filtered noise whose band sweeps from `from` to `to` hertz. */
function sweep(
  audio: AudioContext,
  output: AudioNode,
  at: number,
  seconds: number,
  [from, to]: [number, number],
  volume: number,
  q: number,
  type: BiquadFilterType = "bandpass",
): void {
  const source = audio.createBufferSource();
  source.buffer = noise(audio, seconds);
  const filter = audio.createBiquadFilter();
  filter.type = type;
  filter.Q.value = q;
  filter.frequency.setValueAtTime(from, at);
  filter.frequency.exponentialRampToValueAtTime(to, at + seconds);
  const gain = audio.createGain();
  gain.gain.setValueAtTime(0, at);
  gain.gain.linearRampToValueAtTime(volume, at + seconds * 0.25);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + seconds);
  source.connect(filter).connect(gain).connect(output);
  source.addEventListener("ended", () => gain.disconnect());
  source.start(at);
  source.stop(at + seconds);
}

/** A decaying partial gliding from `from` to `to` hertz. */
function tone(
  audio: AudioContext,
  output: AudioNode,
  at: number,
  seconds: number,
  [from, to]: [number, number],
  volume: number,
  type: OscillatorType = "sine",
): void {
  const oscillator = audio.createOscillator();
  oscillator.type = type;
  oscillator.frequency.setValueAtTime(from, at);
  oscillator.frequency.exponentialRampToValueAtTime(to, at + seconds);
  const gain = audio.createGain();
  gain.gain.setValueAtTime(volume, at);
  gain.gain.exponentialRampToValueAtTime(0.0001, at + seconds);
  oscillator.connect(gain).connect(output);
  oscillator.addEventListener("ended", () => gain.disconnect());
  oscillator.start(at);
  oscillator.stop(at + seconds);
}

type Cue = (audio: AudioContext, output: AudioNode, at: number) => void;

/** What a send sounds like: `press` is the dial's own click, any other cue plays instead of it. */
// Laptop speakers drop most of what sits below ~200 Hz and filtered noise loses most of
// its energy, so the cues keep their partials high and their noise loud to stay audible.
const SEND_CUES: Record<SendSound, Cue | null> = {
  press: null,
  air: (audio, output, at) => sweep(audio, output, at, 0.28, [900, 4200], 1.6, 0.8),
  tube: (audio, output, at) => {
    tone(audio, output, at, 0.1, [320, 180], 0.7);
    sweep(audio, output, at + 0.04, 0.32, [600, 3600], 1.4, 0.7, "lowpass");
  },
  bell: (audio, output, at) => {
    tone(audio, output, at, 0.45, [1320, 1316], 0.6);
    tone(audio, output, at, 0.3, [1980, 1975], 0.3);
  },
};

/** What a queued message sounds like; it always plays instead of the dial's click. */
const QUEUE_CUES: Record<QueueSound, Cue> = {
  latch: (audio, output, at) => {
    playAt(audio, output, recordings.get("pressDown"), at, 1.35, 0.9);
    tone(audio, output, at + 0.05, 0.12, [880, 660], 0.55);
    tone(audio, output, at + 0.14, 0.14, [660, 495], 0.45);
  },
  drop: (audio, output, at) => {
    sweep(audio, output, at, 0.16, [3200, 800], 1.4, 1);
    tone(audio, output, at + 0.15, 0.12, [360, 180], 0.7, "triangle");
  },
};

/** What plays once a thread settles; `off` adds nothing. Kept under half a second, since settling repeats all day. */
const SETTLE_CUES: Record<SettleSound, Cue | null> = {
  off: null,
  // The keycap's click with a soft low thud under it: the thread sits down, in the composer's voice.
  seat: (audio, output, at) => {
    KEY_CLICKS.down(audio, output, at);
    tone(audio, output, at, 0.12, [240, 150], 0.4, "triangle");
  },
  // Candidates to audition; the losers get deleted once one is chosen.
  tick: (audio, output, at) => {
    KEY_CLICKS.down(audio, output, at);
    KEY_CLICKS.up(audio, output, at + 0.09);
  },
  press: (audio, output, at) => playAt(audio, output, recordings.get("pressDown"), at, 1.1, 0.7),
  pair: (audio, output, at) => {
    KEY_CLICKS.down(audio, output, at);
    KEY_CLICKS.up(audio, output, at + 0.07);
    tone(audio, output, at + 0.07, 0.18, [1760, 1755], 0.12);
  },
  soft: (audio, output, at) => {
    sweep(audio, output, at, 0.14, [1800, 600], 1.1, 0.8, "lowpass");
    tone(audio, output, at + 0.02, 0.12, [520, 390], 0.25);
  },
  detent: (audio, output, at) => playAt(audio, output, recordings.get("rotary"), at, 1.1, 0.8),
  whoosh: (audio, output, at) => playAt(audio, output, recordings.get("metalWhoosh"), at, 1, 1),
  filed: (audio, output, at) => {
    sweep(audio, output, at, 0.22, [5200, 1100], 1.5, 0.9);
    tone(audio, output, at + 0.2, 0.07, [420, 300], 0.5, "triangle");
  },
  stamp: (audio, output, at) => {
    sweep(audio, output, at, 0.04, [2600, 2600], 0.9, 0.8, "highpass");
    tone(audio, output, at, 0.26, [300, 110], 0.55, "triangle");
    tone(audio, output, at, 0.14, [620, 240], 0.2);
  },
  resolve: (audio, output, at) => {
    tone(audio, output, at, 0.2, [1175, 1170], 0.5);
    tone(audio, output, at + 0.11, 0.4, [880, 877], 0.55);
    tone(audio, output, at + 0.11, 0.25, [1760, 1754], 0.12);
  },
  // The dial's own press and release, slowed so the same switch sounds heavier.
  switch: (audio, output, at) => {
    playAt(audio, output, recordings.get("pressDown"), at, 0.8, 1);
    playAt(audio, output, recordings.get("pressUp"), at + 0.2, 0.8, 0.9);
  },
  tap: (audio, output, at) => {
    tone(audio, output, at, 0.34, [2093, 2088], 0.55);
    tone(audio, output, at, 0.12, [3136, 3128], 0.2);
  },
};

function playAt(
  audio: AudioContext,
  output: AudioNode,
  buffer: AudioBuffer | undefined,
  at: number,
  rate: number,
  volume: number,
): void {
  if (!buffer) return;
  const source = audio.createBufferSource();
  source.buffer = buffer;
  source.playbackRate.value = rate;
  const gain = audio.createGain();
  gain.gain.value = volume;
  source.connect(gain).connect(output);
  source.addEventListener("ended", () => gain.disconnect());
  source.start(at);
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

/**
 * The composer's keycaps: a bright, dry click as a key goes down and a higher, lighter
 * one as it comes back up, so a latching key clicks in and then out, and a momentary key
 * clicks twice across one press.
 */
export type KeyClick = "down" | "up";

const KEY_CLICKS: Record<KeyClick, Cue> = {
  down: (audio, output, at) => sweep(audio, output, at, 0.007, [4800, 4800], 1.6, 0.7, "highpass"),
  up: (audio, output, at) => sweep(audio, output, at, 0.006, [6200, 6200], 1.1, 0.7, "highpass"),
};
/** A quick tap still clicks twice instead of the two smearing into one. */
const KEY_MIN_HOLD_MS = 70;

export function playKeyClick(click: KeyClick): void {
  synth(KEY_CLICKS[click]);
}

let heldKey: Element | null = null;
let keyPressedAt = 0;
function releaseKey(): void {
  if (!heldKey) return;
  heldKey = null;
  const wait = KEY_MIN_HOLD_MS - (performance.now() - keyPressedAt);
  if (wait <= 0) playKeyClick("up");
  else setTimeout(() => playKeyClick("up"), wait);
}

/** A momentary keycap's handlers: down on press, up on release, both in turn from the keyboard. */
export function momentaryKeyProps(activate: () => void) {
  return {
    onPointerDown: (event: ReactPointerEvent<HTMLElement>) => {
      // Keeps focus in the composer.
      event.preventDefault();
      if (event.button !== 0 || event.currentTarget.matches(':disabled, [aria-disabled="true"]'))
        return;
      heldKey = event.currentTarget;
      keyPressedAt = performance.now();
      playKeyClick("down");
    },
    onPointerUp: releaseKey,
    onPointerLeave: releaseKey,
    onPointerCancel: () => {
      heldKey = null;
    },
    onClick: (event: ReactMouseEvent<HTMLElement>) => {
      if (event.detail === 0) {
        synth((audio, output, at) => {
          KEY_CLICKS.down(audio, output, at);
          KEY_CLICKS.up(audio, output, at + KEY_MIN_HOLD_MS / 1000);
        });
      }
      activate();
    },
  };
}

/** Plays the press now and returns the release, which sounds only once the press has played out. */
export function pressClick(): () => void {
  const press = recordings.get("pressDown");
  play(press);
  const pressedAt = performance.now();
  const pressMs = press ? press.duration * 1000 : FALLBACK_PRESS_MS;
  return () => {
    const wait = Math.max(0, pressMs - (performance.now() - pressedAt));
    if (wait === 0) play(recordings.get("pressUp"));
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

/** Whether the dial's own click sounds: only a send on `press`, since every other cue stands in for it. */
export function dialClicks(queued: boolean): boolean {
  return !queued && SEND_CUES[getClientSettings().sendSound] === null;
}

/** The sound of a dispatch: the chosen send cue, or the queue cue when the message waits. */
export function playDispatchCue(queued: boolean): void {
  const settings = getClientSettings();
  const cue = queued ? QUEUE_CUES[settings.queueSound] : SEND_CUES[settings.sendSound];
  if (cue) synth(cue);
}

/** A send sound as a send plays it, for choosing one in Settings. */
export function previewSendSound(sound: SendSound): void {
  const cue = SEND_CUES[sound];
  if (cue) synth(cue);
  else pressClick()();
}

/** A queue sound as a queued send plays it, for choosing one in Settings. */
export function previewQueueSound(sound: QueueSound): void {
  synth(QUEUE_CUES[sound]);
}

/** The chosen settle sound, once a thread has settled. */
export function playSettleSound(): void {
  const now = performance.now();
  if (now - lastSettleAt < SETTLE_COOLDOWN_MS) return;
  lastSettleAt = now;
  const cue = SETTLE_CUES[getClientSettings().settleSound];
  if (cue) synth(cue);
}

/** A settle sound on its own, for choosing one in Settings. */
export function previewSettleSound(sound: SettleSound): void {
  const cue = SETTLE_CUES[sound];
  if (cue) synth(cue);
}
