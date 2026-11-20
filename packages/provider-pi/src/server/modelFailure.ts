import { ORCHESTRATION_V2_PROVIDER_OVERLOADED_FAILURE_CODE } from "@t3tools/contracts";
import { makeProviderFailure } from "@t3tools/provider-core/server/failure";
import * as DateTime from "effect/DateTime";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";

// Pi relays the upstream body as text only, so its overload is recognised by that body,
// which has said both `[overloaded]` and "service is overloaded".
const PI_OVERLOADED_ERROR = /\b429\b[\s\S]*\boverloaded\b/iu;
const PI_USAGE_LIMIT_ERROR =
  /\b(?:insufficient\s+credits?|not enough credits?|usage limit|quota limit|quota[- ]limited|quota reached|rate limit|credit limit|allowance exhausted)\b/iu;

/** The wait a quota host relays as `Please wait 113h50m33s`, in seconds. */
const piWaitSeconds = (message: string): number | undefined => {
  const match = message.match(/\bwait\s+(?:(\d+)h)?(?:(\d+)m)?(?:(\d+)s)?\b/iu);
  if (match === null) return undefined;
  const [, hours, minutes, seconds] = match;
  if (hours === undefined && minutes === undefined && seconds === undefined) return undefined;
  return Number(hours ?? 0) * 3_600 + Number(minutes ?? 0) * 60 + Number(seconds ?? 0);
};

const MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];

/**
 * "next reset Nov 24, 08:53": a quota host names its reset without a year or zone, so it is read as this machine's
 * clock and the first such time still ahead.
 */
const quotaResetAt = Effect.fn("PiAdapter.quotaResetAt")(function* (message: string) {
  const match = message.match(
    /\bnext reset\s+([A-Za-z]{3})[a-z]*\s+(\d{1,2}),?\s+(\d{1,2}):(\d{2})\b/iu,
  );
  if (match === null) return undefined;
  const month = MONTHS.indexOf(match[1]!.toLowerCase());
  if (month < 0) return undefined;
  const now = yield* DateTime.now;
  const zone = DateTime.zoneMakeLocal();
  const year = DateTime.getPartUtc(DateTime.setZone(now, zone), "year");
  for (const candidate of [year, year + 1]) {
    const at = DateTime.makeZoned(
      {
        year: candidate,
        month: month + 1,
        day: Number(match[2]),
        hour: Number(match[3]),
        minute: Number(match[4]),
      },
      { timeZone: zone },
    );
    if (at._tag === "Some" && DateTime.isGreaterThan(at.value, now))
      return DateTime.formatIso(at.value);
  }
  return undefined;
});

/** A Pi model failure, coded as an overload when the upstream said it was overloaded. */
export const piModelFailure = Effect.fn("PiAdapter.modelFailure")(function* (
  message: string,
  retryable?: boolean,
) {
  const absoluteReset = message.match(
    /\b(?:reset(?:At|_at)?|resets_at)\b[\s"'=:\-]{0,16}(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?Z)\b/iu,
  )?.[1];
  const retryAfterSeconds = Number(
    message.match(/\bretry[_ -]?after\b[\s"'=:\-]{0,16}(\d+(?:\.\d+)?)/iu)?.[1],
  );
  const resumeSeconds =
    Number.isFinite(retryAfterSeconds) && retryAfterSeconds > 0
      ? retryAfterSeconds
      : piWaitSeconds(message);
  const quotaReset = absoluteReset === undefined ? yield* quotaResetAt(message) : undefined;
  const resetAt =
    absoluteReset !== undefined
      ? absoluteReset
      : quotaReset !== undefined
        ? quotaReset
        : resumeSeconds !== undefined && resumeSeconds > 0
          ? DateTime.formatIso(
              DateTime.addDuration(yield* DateTime.now, Duration.seconds(resumeSeconds)),
            )
          : undefined;
  return makeProviderFailure({
    message,
    class: PI_USAGE_LIMIT_ERROR.test(message) ? "usage_limit" : "provider_error",
    ...(resetAt === undefined ? {} : { resetAt }),
    ...(retryable === undefined ? {} : { retryable }),
    ...(PI_OVERLOADED_ERROR.test(message)
      ? { code: ORCHESTRATION_V2_PROVIDER_OVERLOADED_FAILURE_CODE }
      : {}),
  });
});
