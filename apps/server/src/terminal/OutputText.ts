import * as NodeUtil from "node:util";

// Keeps one read well inside an agent's tool-result budget even when a few lines are huge.
const MAX_OUTPUT_TEXT_LENGTH = 64 * 1024;

// eslint-disable-next-line no-control-regex -- Matching CSI sequences needs the escape byte.
const CSI_SEQUENCE = /\u001b\[([0-9;?]*)[ -/]*([@-~])/g;

/**
 * Replays carriage returns, backspaces and the line-editing sequences (erase in
 * line, cursor left, right and to a column) within each line, as the screen would
 * show them, so progress bars and shell line editing read as their final text.
 */
function renderLine(raw: string): string {
  const cells: Array<string> = [];
  let column = 0;
  const write = (text: string) => {
    for (const char of NodeUtil.stripVTControlCharacters(text)) {
      if (char === "\r") {
        column = 0;
      } else if (char === "\b") {
        column = Math.max(0, column - 1);
      } else if (char === "\t" || char >= " ") {
        cells[column] = char;
        column += 1;
      }
    }
  };
  let written = 0;
  for (const match of raw.matchAll(CSI_SEQUENCE)) {
    write(raw.slice(written, match.index));
    written = match.index + match[0].length;
    const parameter = Number.parseInt(match[1] ?? "", 10);
    const count = Number.isNaN(parameter) || parameter < 1 ? 1 : parameter;
    switch (match[2]) {
      case "K":
        if (Number.isNaN(parameter) || parameter === 0)
          cells.length = Math.min(cells.length, column);
        else if (parameter === 1) cells.fill(" ", 0, Math.min(cells.length, column + 1));
        else if (parameter === 2) cells.length = 0;
        break;
      case "C":
        column += count;
        break;
      case "D":
        column = Math.max(0, column - count);
        break;
      case "G":
        column = count - 1;
        break;
    }
  }
  write(raw.slice(written));
  return Array.from(cells, (cell) => cell ?? " ")
    .join("")
    .trimEnd();
}

/** Turns stored terminal history into the plain text an agent can read, newest lines last. */
export function terminalOutputText(
  history: string,
  maxLines: number,
): { readonly text: string; readonly truncated: boolean } {
  const lines = history.split("\n").map(renderLine);
  while (lines.length > 0 && lines.at(-1) === "") lines.pop();
  const tail = lines.slice(-maxLines).join("\n");
  const text = tail.length > MAX_OUTPUT_TEXT_LENGTH ? tail.slice(-MAX_OUTPUT_TEXT_LENGTH) : tail;
  return { text, truncated: lines.length > maxLines || text.length < tail.length };
}
