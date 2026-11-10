export const THEME_MODE_STORAGE_KEY = "t3code:theme-mode:v1";
export const THEME_ROTATION_STORAGE_KEY = "t3code:theme-rotation:v1";

/** The standard T3 Code theme has no palette id; a rotation names it with this. */
export const STANDARD_ROTATION_THEME = "standard";

export type ThemeMode = "single" | "project" | "rotation";
export const DEFAULT_THEME_MODE: ThemeMode = "project";

export type ThemeRotation = Readonly<{
  /** Whole themes in the order the days walk through them. */
  favourites: ReadonlyArray<string>;
  /** A theme chosen for one local calendar day; it lapses at midnight. */
  override: Readonly<{ date: string; theme: string }> | null;
}>;

export const EMPTY_THEME_ROTATION: ThemeRotation = { favourites: [], override: null };

export type RotationDay = Readonly<{
  /** The theme to paint today, or null when there are no favourites. */
  theme: string | null;
  /** What the schedule gives today, ignoring any override. */
  scheduled: string | null;
  overridden: boolean;
  /** What the schedule gives tomorrow. */
  next: string | null;
}>;

export function isThemeMode(value: unknown): value is ThemeMode {
  return value === "single" || value === "project" || value === "rotation";
}

const pad = (value: number) => String(value).padStart(2, "0");

export function localDateKey(date: Date): string {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** Whole local calendar days since 1970-01-01, so a daylight-saving day is still one step. */
function localDayNumber(date: Date): number {
  return Math.floor(Date.UTC(date.getFullYear(), date.getMonth(), date.getDate()) / 86_400_000);
}

function scheduledTheme(favourites: ReadonlyArray<string>, dayNumber: number): string | null {
  if (favourites.length === 0) return null;
  return favourites[((dayNumber % favourites.length) + favourites.length) % favourites.length]!;
}

export function rotationDay(rotation: ThemeRotation, now: Date): RotationDay {
  const dayNumber = localDayNumber(now);
  const scheduled = scheduledTheme(rotation.favourites, dayNumber);
  const overridden = rotation.override !== null && rotation.override.date === localDateKey(now);
  return {
    theme: overridden ? rotation.override!.theme : scheduled,
    scheduled,
    overridden,
    next: scheduledTheme(rotation.favourites, dayNumber + 1),
  };
}

export function msUntilNextLocalMidnight(now: Date): number {
  const next = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return Math.max(1_000, next.getTime() - now.getTime());
}

export function parseThemeRotation(raw: string | null): ThemeRotation {
  if (raw === null) return EMPTY_THEME_ROTATION;
  try {
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null) return EMPTY_THEME_ROTATION;
    const record = value as Record<string, unknown>;
    const favourites: Array<string> = [];
    if (Array.isArray(record.favourites)) {
      for (const entry of record.favourites) {
        if (typeof entry === "string" && entry !== "" && !favourites.includes(entry)) {
          favourites.push(entry);
        }
      }
    }
    const override = record.override;
    const parsedOverride =
      typeof override === "object" &&
      override !== null &&
      typeof (override as Record<string, unknown>).date === "string" &&
      typeof (override as Record<string, unknown>).theme === "string"
        ? {
            date: (override as { date: string }).date,
            theme: (override as { theme: string }).theme,
          }
        : null;
    return { favourites, override: parsedOverride };
  } catch {
    return EMPTY_THEME_ROTATION;
  }
}

export function serializeThemeRotation(rotation: ThemeRotation): string {
  return JSON.stringify({
    favourites: rotation.favourites,
    ...(rotation.override ? { override: rotation.override } : {}),
  });
}

export function withFavourite(
  rotation: ThemeRotation,
  themeId: string,
  favourite: boolean,
): ThemeRotation {
  const present = rotation.favourites.includes(themeId);
  if (favourite === present) return rotation;
  return {
    ...rotation,
    favourites: favourite
      ? [...rotation.favourites, themeId]
      : rotation.favourites.filter((id) => id !== themeId),
  };
}

export function withFavouriteMoved(
  rotation: ThemeRotation,
  themeId: string,
  direction: -1 | 1,
): ThemeRotation {
  const index = rotation.favourites.indexOf(themeId);
  const target = index + direction;
  if (index === -1 || target < 0 || target >= rotation.favourites.length) return rotation;
  const favourites = [...rotation.favourites];
  [favourites[index], favourites[target]] = [favourites[target]!, favourites[index]!];
  return { ...rotation, favourites };
}

export function withOverride(
  rotation: ThemeRotation,
  themeId: string | null,
  now: Date,
): ThemeRotation {
  return {
    ...rotation,
    override: themeId === null ? null : { date: localDateKey(now), theme: themeId },
  };
}

/** Drops themes that no longer exist from the favourites, and from today's override. */
export function withoutThemes(
  rotation: ThemeRotation,
  themeIds: ReadonlyArray<string>,
): ThemeRotation {
  const gone = new Set(themeIds);
  const overrideGone = rotation.override !== null && gone.has(rotation.override.theme);
  if (!overrideGone && !rotation.favourites.some((id) => gone.has(id))) return rotation;
  return {
    favourites: rotation.favourites.filter((id) => !gone.has(id)),
    override: overrideGone ? null : rotation.override,
  };
}
