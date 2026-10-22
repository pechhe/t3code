import { describe, expect, it } from "vite-plus/test";

import { render } from "../../test/render";
import "../index.css";

import { ContextChip } from "../components/ContextChip";

function surfaces(element: HTMLElement) {
  const style = getComputedStyle(element);
  return { background: style.backgroundColor, border: style.borderTopColor };
}

describe("selection-covered surfaces", () => {
  it("drops the chip and inline-code surfaces the selection crosses", async () => {
    await using screen = await render(
      <div className="chat-markdown">
        <p>
          Alpha{" "}
          <ContextChip kind="file" data-selection-covered data-testid="covered-chip">
            mcpToolPolicy.ts
          </ContextChip>{" "}
          and{" "}
          <code data-selection-covered data-testid="covered-code">
            SESSION
          </code>{" "}
          beta{" "}
          <ContextChip kind="file" data-testid="free-chip">
            other.ts
          </ContextChip>
        </p>
      </div>,
    );
    const covered = surfaces(screen.getByTestId("covered-chip").element() as HTMLElement);
    const code = surfaces(screen.getByTestId("covered-code").element() as HTMLElement);
    const free = surfaces(screen.getByTestId("free-chip").element() as HTMLElement);

    expect(covered).toEqual({ background: "rgba(0, 0, 0, 0)", border: "rgba(0, 0, 0, 0)" });
    expect(code).toEqual({ background: "rgba(0, 0, 0, 0)", border: "rgba(0, 0, 0, 0)" });
    // Only the chips the selection covers lose their surface.
    expect(free.background).not.toBe("rgba(0, 0, 0, 0)");
  });
});
