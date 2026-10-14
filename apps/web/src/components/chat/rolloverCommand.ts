import type { OrchestrationV2RolloverHold } from "@t3tools/contracts";

const MINUTE_MS = 60_000;
const HOUR_MS = 60 * MINUTE_MS;
const DAY_MS = 24 * HOUR_MS;

export const DEFAULT_ROLLOVER_PAUSE_MS = HOUR_MS;
export const MAX_ROLLOVER_PAUSE_MS = 7 * DAY_MS;

export type RolloverCommand =
  | { readonly kind: "status" }
  | { readonly kind: "on" }
  | { readonly kind: "off" }
  | { readonly kind: "pause"; readonly durationMs: number };

export type RolloverCommandParse =
  | { readonly ok: true; readonly command: RolloverCommand }
  | { readonly ok: false; readonly message: string };

const USAGE = "Use /rollover on, off, status, or pause [30m|2h|1d].";

/** A pause length such as `30m`, `2h` or `1d`; a bare number is hours. Null when malformed. */
export function parseRolloverDuration(text: string): number | null {
  const match = /^(\d+(?:\.\d+)?)\s*([mhd]?)$/i.exec(text.trim());
  if (!match) return null;
  const unit = match[2]?.toLowerCase();
  const unitMs = unit === "m" ? MINUTE_MS : unit === "d" ? DAY_MS : HOUR_MS;
  return Math.round(Number(match[1]) * unitMs);
}

/**
 * Parses a composer message that is a `/rollover` command, or returns null for
 * anything else. A bare `/rollover` reports the state.
 */
export function parseRolloverCommand(text: string): RolloverCommandParse | null {
  const match = /^\/rollover(?:\s+(.*))?$/is.exec(text.trim());
  if (!match) return null;
  const [action = "", ...rest] = (match[1] ?? "").trim().split(/\s+/);
  const argument = rest.join(" ");
  switch (action.toLowerCase()) {
    case "":
    case "status":
      return argument === "" ? { ok: true, command: { kind: "status" } } : fail(USAGE);
    case "on":
      return argument === "" ? { ok: true, command: { kind: "on" } } : fail(USAGE);
    case "off":
      return argument === "" ? { ok: true, command: { kind: "off" } } : fail(USAGE);
    case "pause": {
      if (argument === "") {
        return { ok: true, command: { kind: "pause", durationMs: DEFAULT_ROLLOVER_PAUSE_MS } };
      }
      const durationMs = parseRolloverDuration(argument);
      if (durationMs === null) return fail(`"${argument}" is not a duration. ${USAGE}`);
      if (durationMs <= 0) return fail("A pause must be longer than zero.");
      if (durationMs > MAX_ROLLOVER_PAUSE_MS) return fail("A pause can last at most 7 days.");
      return { ok: true, command: { kind: "pause", durationMs } };
    }
    default:
      return fail(USAGE);
  }
}

function fail(message: string): RolloverCommandParse {
  return { ok: false, message };
}

/** The hold to store for a command, or undefined for `status`. */
export function rolloverHoldForCommand(
  command: RolloverCommand,
  nowMs: number,
): OrchestrationV2RolloverHold | null | undefined {
  switch (command.kind) {
    case "status":
      return undefined;
    case "on":
      return null;
    case "off":
      return { kind: "off" };
    case "pause":
      return { kind: "paused", until: new Date(nowMs + command.durationMs).toISOString() };
  }
}

/** The hold that still applies at `nowMs`: a lapsed pause counts as none. */
export function activeRolloverHold(
  hold: OrchestrationV2RolloverHold | null | undefined,
  nowMs: number,
): OrchestrationV2RolloverHold | null {
  if (hold == null) return null;
  return hold.kind === "paused" && Date.parse(hold.until) <= nowMs ? null : hold;
}

function formatUntil(until: string, nowMs: number): string {
  const date = new Date(until);
  const time = date.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }).toLowerCase();
  const sameDay = date.toDateString() === new Date(nowMs).toDateString();
  return sameDay ? time : `${date.toLocaleDateString([], { weekday: "short" })} ${time}`;
}

/** The label for a hold in force at `nowMs`, or null when rollover is not held. */
export function describeRolloverHold(
  hold: OrchestrationV2RolloverHold | null | undefined,
  nowMs: number,
): string | null {
  const active = activeRolloverHold(hold, nowMs);
  if (active === null) return null;
  return active.kind === "off"
    ? "Rollover off"
    : `Rollover paused until ${formatUntil(active.until, nowMs)}`;
}
