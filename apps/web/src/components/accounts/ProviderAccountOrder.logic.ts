const ordinal = (n: number) => {
  const tens = n % 100;
  if (tens >= 11 && tens <= 13) return `${n}th`;
  return `${n}${["th", "st", "nd", "rd"][n % 10] ?? "th"}`;
};

/** Where a provider's accounts sit in the account order: "2nd", or "2nd, 4th and 6th–9th". */
export function accountPositionsText(positions: ReadonlyArray<number>): string {
  const runs: Array<[number, number]> = [];
  for (const position of positions.toSorted((a, b) => a - b)) {
    const last = runs.at(-1);
    if (last !== undefined && last[1] === position - 1) last[1] = position;
    else runs.push([position, position]);
  }
  const parts = runs.flatMap(([from, to]) =>
    to - from >= 2
      ? [`${ordinal(from)}–${ordinal(to)}`]
      : Array.from({ length: to - from + 1 }, (_, index) => ordinal(from + index)),
  );
  return parts.length < 2
    ? (parts[0] ?? "")
    : `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}
