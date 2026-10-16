import { describe, expect, it } from "vite-plus/test";

import { revealEnd } from "./AssistantMessageText.logic";

/** The chunks a live stream reveals as the playhead moves through `text` a character at a time. */
function revealSteps(text: string) {
  const steps: string[] = [];
  let shown = 0;
  for (let playhead = 0; playhead <= text.length; playhead++) {
    const end = revealEnd(text, shown, playhead, true);
    if (end > shown) {
      steps.push(text.slice(shown, end));
      shown = end;
    }
  }
  const end = revealEnd(text, shown, text.length, false);
  if (end > shown) steps.push(text.slice(shown, end));
  return steps;
}

describe("revealEnd", () => {
  it("reveals a sentence at a time", () => {
    expect(revealSteps("The first sentence is here. The second one follows now. Tail")).toEqual([
      "The first sentence is here.",
      " The second one follows now.",
      " Tail",
    ]);
  });

  it("keeps a bullet's short bold label with the sentence after it", () => {
    expect(
      revealSteps("- **Pacing.** The playhead stays behind the text.\n- **Layout.** It grows"),
    ).toEqual([
      "- **Pacing.** The playhead stays behind the text.",
      "\n",
      "- **Layout.** It grows",
    ]);
  });

  it("waits for the character after a full stop, so a decimal is not a sentence end", () => {
    const text = "The version number is 1.5 and it works.";
    expect(revealEnd(text, 0, "The version number is 1.".length, true)).toBe(0);
  });

  it("ends a line as a sentence, even when it is short", () => {
    expect(revealSteps("## Plan\nThen the body goes here")).toEqual([
      "## Plan\n",
      "Then the body goes here",
    ]);
  });

  it("shows a long run with no sentence end up to its last whole word", () => {
    const text = `${"word ".repeat(60)}more`;
    const end = revealEnd(text, 0, 250, true);
    expect(end).toBeGreaterThan(0);
    expect(text[end - 1]).toBe(" ");
  });

  it("holds an unfinished sentence while the stream is live and shows it once it ends", () => {
    const text = "Still being written";
    expect(revealEnd(text, 0, text.length, true)).toBe(0);
    expect(revealEnd(text, 0, text.length, false)).toBe(text.length);
  });
});
