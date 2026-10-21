// Letters the composer needs for editing; a project that starts with one is reached by click.
const EDITING_LETTERS = new Set(["a", "c", "v", "x", "z"]);

export function projectShortcutLetter(name: string): string | null {
  const letter = name.match(/[\p{L}\p{N}]/u)?.[0]?.toLowerCase() ?? null;
  return letter !== null && /^[a-z]$/.test(letter) ? letter : null;
}

export function isReservedForEditing(letter: string): boolean {
  return EDITING_LETTERS.has(letter);
}

/**
 * The project a letter shortcut selects: the first whose name starts with it, then each
 * next one on repeat presses, wrapping around. `null` when none starts with the letter.
 */
export function nextProjectForLetter<T>(
  entries: ReadonlyArray<{ readonly key: string; readonly name: string; readonly value: T }>,
  letter: string,
  currentKey: string | null,
): T | null {
  const matches = entries.filter((entry) => projectShortcutLetter(entry.name) === letter);
  if (matches.length === 0) return null;
  const currentIndex = matches.findIndex((entry) => entry.key === currentKey);
  return matches[(currentIndex + 1) % matches.length]!.value;
}
