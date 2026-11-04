import { describe, expect, it } from "vite-plus/test";

import {
  EMPTY_THEME_ROTATION,
  localDateKey,
  msUntilNextLocalMidnight,
  parseThemeRotation,
  rotationDay,
  serializeThemeRotation,
  withFavourite,
  withFavouriteMoved,
  withOverride,
  withoutThemes,
} from "./themeRotation";

const day = (year: number, month: number, date: number, hour = 12) =>
  new Date(year, month - 1, date, hour);

const rotation = (favourites: ReadonlyArray<string>) => ({ ...EMPTY_THEME_ROTATION, favourites });

describe("daily theme rotation", () => {
  it("steps to the next favourite each calendar day and wraps around", () => {
    const favourites = ["ocean", "grove", "iris"];
    const seen = [0, 1, 2, 3, 4, 5].map(
      (offset) => rotationDay(rotation(favourites), day(2026, 11, 4 + offset)).theme,
    );
    expect(seen.slice(0, 3)).toEqual(expect.arrayContaining(favourites));
    expect(new Set(seen.slice(0, 3)).size).toBe(3);
    expect(seen.slice(3)).toEqual(seen.slice(0, 3));
  });

  it("gives the same theme all day, whatever the time", () => {
    const favourites = ["ocean", "grove", "iris"];
    const early = rotationDay(rotation(favourites), day(2026, 11, 4, 0));
    const late = rotationDay(rotation(favourites), new Date(2026, 10, 4, 23, 59, 59));
    expect(late.theme).toBe(early.theme);
  });

  it("names tomorrow's theme as the one the schedule reaches next", () => {
    const favourites = ["ocean", "grove", "iris"];
    const today = rotationDay(rotation(favourites), day(2026, 11, 4));
    const tomorrow = rotationDay(rotation(favourites), day(2026, 11, 5));
    expect(today.next).toBe(tomorrow.theme);
  });

  it("counts a daylight-saving changeover as one ordinary day", () => {
    const favourites = ["a", "b", "c", "d", "e", "f", "g"];
    const themes = Array.from(
      { length: 7 },
      (_, offset) => rotationDay(rotation(favourites), new Date(2026, 2, 27 + offset, 12)).theme,
    );
    expect(new Set(themes).size).toBe(7);
  });

  it("paints an override for today and resumes the schedule tomorrow", () => {
    const favourites = ["ocean", "grove", "iris"];
    const today = day(2026, 11, 4);
    const scheduledToday = rotationDay(rotation(favourites), today).theme;
    const pinned = withOverride(rotation(favourites), "ember", today);

    const overriddenToday = rotationDay(pinned, today);
    expect(overriddenToday.theme).toBe("ember");
    expect(overriddenToday.overridden).toBe(true);
    expect(overriddenToday.scheduled).toBe(scheduledToday);

    const tomorrow = rotationDay(pinned, day(2026, 11, 5));
    expect(tomorrow.overridden).toBe(false);
    expect(tomorrow.theme).toBe(rotationDay(rotation(favourites), day(2026, 11, 5)).theme);
  });

  it("clears an override on request", () => {
    const pinned = withOverride(rotation(["ocean"]), "ember", day(2026, 11, 4));
    expect(withOverride(pinned, null, day(2026, 11, 4)).override).toBeNull();
  });

  it("has no theme to paint without favourites, but still honours an override", () => {
    expect(rotationDay(EMPTY_THEME_ROTATION, day(2026, 11, 4)).theme).toBeNull();
    const pinned = withOverride(EMPTY_THEME_ROTATION, "ember", day(2026, 11, 4));
    expect(rotationDay(pinned, day(2026, 11, 4)).theme).toBe("ember");
  });

  it("waits for the next local midnight", () => {
    const now = new Date(2026, 10, 4, 23, 0, 0);
    expect(msUntilNextLocalMidnight(now)).toBe(60 * 60 * 1000);
  });

  it("formats the local calendar date", () => {
    expect(localDateKey(new Date(2026, 0, 5, 3))).toBe("2026-01-05");
  });
});

describe("editing favourites", () => {
  it("adds once, removes, and reorders", () => {
    let value = withFavourite(EMPTY_THEME_ROTATION, "ocean", true);
    value = withFavourite(value, "ocean", true);
    value = withFavourite(value, "grove", true);
    value = withFavourite(value, "iris", true);
    expect(value.favourites).toEqual(["ocean", "grove", "iris"]);
    expect(withFavouriteMoved(value, "iris", -1).favourites).toEqual(["ocean", "iris", "grove"]);
    expect(withFavouriteMoved(value, "ocean", -1)).toBe(value);
    expect(withFavourite(value, "grove", false).favourites).toEqual(["ocean", "iris"]);
  });
});

describe("removed themes", () => {
  it("leaves the favourites and today's override without a theme that was deleted", () => {
    const pinned = withOverride(rotation(["ocean", "grove", "iris"]), "grove", day(2026, 11, 4));
    const after = withoutThemes(pinned, ["grove", "iris"]);
    expect(after.favourites).toEqual(["ocean"]);
    expect(after.override).toBeNull();
    expect(withoutThemes(pinned, ["ember"])).toBe(pinned);
  });
});

describe("stored rotation", () => {
  it("round-trips favourites and an override", () => {
    const value = withOverride(rotation(["ocean", "grove"]), "iris", day(2026, 11, 4));
    expect(parseThemeRotation(serializeThemeRotation(value))).toEqual(value);
  });

  it("reads damaged storage as an empty rotation", () => {
    expect(parseThemeRotation(null)).toEqual(EMPTY_THEME_ROTATION);
    expect(parseThemeRotation("not json")).toEqual(EMPTY_THEME_ROTATION);
    expect(
      parseThemeRotation('{"favourites":[1,"ocean","ocean",""],"override":{"date":4}}'),
    ).toEqual({ favourites: ["ocean"], override: null });
  });
});
