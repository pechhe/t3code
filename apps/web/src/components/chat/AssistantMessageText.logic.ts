// Text is shown a sentence at a time. A shorter run, such as a bold label at the
// start of a bullet, waits for the sentence after it.
const SENTENCE_MIN_WORDS = 4;
// A run with no sentence end shows up to its last whole word past this length.
const RUN_ON_CHARS = 220;

/**
 * Where a streaming reveal may stop in `text`: the furthest sentence end between
 * `from` and the playhead. Once the stream has ended and the playhead reaches the
 * end, the whole text shows.
 */
export function revealEnd(text: string, from: number, playhead: number, live: boolean) {
  if (!live && playhead >= text.length) return text.length;
  let end = from;
  const sentenceEnd = /[.!?]["')\]*_`]*(?=\s)|\n/g;
  sentenceEnd.lastIndex = from;
  for (let match = sentenceEnd.exec(text); match; match = sentenceEnd.exec(text)) {
    const next = match.index + match[0].length;
    if (next > playhead) break;
    const words = text.slice(end, next).match(/\S+/g)?.length ?? 0;
    if (match[0] === "\n" || words >= SENTENCE_MIN_WORDS) end = next;
  }
  if (playhead - end > RUN_ON_CHARS) {
    const space = text.lastIndexOf(" ", Math.floor(playhead));
    if (space > end) end = space + 1;
  }
  return end;
}
