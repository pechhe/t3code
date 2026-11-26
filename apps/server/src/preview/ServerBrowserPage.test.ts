import {
  chromium,
  type Browser,
  type BrowserContext,
  type CDPSession,
  type Page,
} from "playwright-core";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vite-plus/test";

import { PreviewAutomationEvaluateInput } from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import {
  bindingSatisfied,
  evaluateChecks,
  pageModelFromSnapshot,
  resolveTarget,
} from "../browserTasks/pageModel.ts";
import * as ServerBrowserPage from "./ServerBrowserPage.ts";
import { SessionControl } from "./SessionControl.ts";

const decodeEvaluateInput = Schema.decodeUnknownSync(PreviewAutomationEvaluateInput);
import { PHI_ANY_VISIBLE_MATCH } from "./PhiBrowserProtocol.ts";
import { pinnedBrowser } from "../testUtils/pinnedBrowser.ts";

// The page-level suites below launch a real browser, so they run only when T3's pinned shell
// resolved; a host that cannot install it skips them instead of launching Playwright's copy.
const browserPath = await pinnedBrowser();

describe("JPEG screenshot dimensions", () => {
  const encode = (bytes: number[]) => Buffer.from(bytes).toString("base64");
  const frame = [0xff, 0xd8, 0xff, 0xc0, 0, 7, 8, 0, 24, 0, 32];

  it("reads valid dimensions and rejects invalid or incomplete frames", () => {
    expect(ServerBrowserPage.jpegSize(encode(frame))).toEqual({ width: 32, height: 24 });
    for (const bytes of [
      [],
      [0xff, 0xd8, 0xff, 0xe1, 0, 20, 1],
      frame.slice(0, -1),
      [...frame.slice(0, 7), 0, 0, 0, 32],
      [...frame.slice(0, 9), 0, 0],
    ]) {
      expect(() => ServerBrowserPage.jpegSize(encode(bytes))).toThrow("Invalid JPEG screenshot.");
    }
  });
});

describe("snapshot deadline diagnostics", () => {
  const never = () => new Promise<never>(() => {});
  const stalledSnapshot = async (options: {
    readonly stalled?: "metrics";
    readonly page?: Partial<Record<keyof Page, unknown>>;
    readonly advanceMs: number;
  }) => {
    vi.useFakeTimers();
    try {
      const frame = {};
      const page = {
        viewportSize: () => ({ width: 1280, height: 800 }),
        mainFrame: () => frame,
        frames: () => [frame],
        on: () => {},
        evaluate: async () => ({
          url: "about:blank",
          title: "",
          loading: false,
          visibleText: "",
        }),
        ariaSnapshot: async () => "",
        ...options.page,
      } as unknown as Page;
      const cdp = {
        send: async (method: string) => {
          if (options.stalled === "metrics") return never();
          if (method === "Page.captureScreenshot") return { data: "" };
          if (method === "Page.getFrameTree") return { frameTree: { frame: { id: "main" } } };
          if (method === "Page.createIsolatedWorld") return { executionContextId: 1 };
          if (method === "Runtime.evaluate") return { result: { value: [] } };
          throw new Error(`Unexpected command: ${method}`);
        },
      } as unknown as CDPSession;
      const captured = ServerBrowserPage.snapshot({
        page,
        cdp,
        renderScale: options.stalled === "metrics" ? "display" : 1,
        consoleEntries: [],
        networkEntries: [],
        actionTimeline: [],
      }).catch((error: unknown) => error);
      await vi.advanceTimersByTimeAsync(options.advanceMs);
      return await captured;
    } finally {
      vi.useRealTimers();
    }
  };

  it("identifies a stalled metrics read", async () => {
    expect(await stalledSnapshot({ stalled: "metrics", advanceMs: 10_000 })).toMatchObject({
      tag: "PreviewAutomationTimeoutError",
      detail: { timeoutMs: 10_000, pendingStages: ["metrics"] },
    });
  });

  it("keeps an accessibility tree that hit its own timeout", async () => {
    const timedOut = Object.assign(new Error("Timeout exceeded"), { name: "TimeoutError" });
    const captured = await stalledSnapshot({
      page: { ariaSnapshot: () => Promise.reject(timedOut) },
      advanceMs: 0,
    });
    expect(captured).toMatchObject({
      tag: "PreviewAutomationTimeoutError",
      detail: { timeoutMs: 10_000 },
    });
    expect((captured as ServerBrowserPage.ServerBrowserOperationError).detail).toMatchObject({
      pendingStages: expect.arrayContaining(["accessibility tree"]),
    });
  });

  it("omits a timed-out stage after it succeeds on retry", async () => {
    let attempts = 0;
    const timedOut = Object.assign(new Error("Timeout exceeded"), { name: "TimeoutError" });
    expect(
      await stalledSnapshot({
        page: {
          evaluate: never,
          ariaSnapshot: async () => {
            if (attempts++ === 0) throw timedOut;
            return "";
          },
        },
        advanceMs: 10_000,
      }),
    ).toMatchObject({ detail: { timeoutMs: 10_000, pendingStages: ["page state"] } });
  });

  it.each(["elementHandle", "contentFrame"] as const)(
    "identifies stalled iframe %s lookup",
    async (stage) => {
      const main = {};
      const child = { evaluate: never, parentFrame: () => main };
      const captured = await stalledSnapshot({
        page: {
          mainFrame: () => main,
          frames: () => [main, child],
          context: () => ({
            newCDPSession: () =>
              Promise.reject(new Error("Only this preview tab's page can be attached")),
          }),
          ariaSnapshot: async () => "- iframe [ref=f1]:\n  - text: inside",
          locator: () => ({
            elementHandle:
              stage === "elementHandle" ? never : async () => ({ contentFrame: never }),
          }),
        },
        advanceMs: 10_000,
      });
      expect(captured).toMatchObject({
        detail: { timeoutMs: 10_000, pendingStages: expect.arrayContaining(["frames"]) },
      });
    },
  );

  it("reports a frame that didn't answer as the frame's own timeout", async () => {
    const main = {};
    // A desktop tab refuses frame sessions, so the frame is read in its own world.
    const child = { evaluate: never, parentFrame: () => main };
    const captured = await stalledSnapshot({
      page: {
        mainFrame: () => main,
        frames: () => [main, child],
        context: () => ({
          newCDPSession: () =>
            Promise.reject(new Error("Only this preview tab's page can be attached")),
        }),
        ariaSnapshot: async () => "- iframe [ref=f1]:\n  - text: inside",
        locator: () => ({
          elementHandle: async () => ({ contentFrame: async () => child, dispose: async () => {} }),
        }),
      },
      // Both attempts wait out the frame; neither reaches the capture deadline.
      advanceMs: 2_000,
    });
    expect(captured).toMatchObject({
      tag: "PreviewAutomationTimeoutError",
      detail: { timeoutMs: 1_000, pendingStages: ["frames"] },
    });
  });
});

describe("server browser capture deadlines", () => {
  it("releases control after an unanswered capture and ignores its late reply", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const captured = Promise.withResolvers<{ data: string }>();
      const send = vi.fn(async (method: string) =>
        method === "Page.captureScreenshot"
          ? captured.promise
          : { result: { value: "still responsive" } },
      );
      const cdp = { send } as unknown as CDPSession;
      const control = new SessionControl("agent");
      let outcome: unknown;
      const capture = control
        .agent("agent", () => ServerBrowserPage.captureViewport(cdp, { format: "png" }))
        .catch((cause: unknown) => {
          outcome = cause;
        });
      const evaluation = control.agent("agent", () =>
        ServerBrowserPage.evaluate(cdp, { expression: "document.title" }, 1_000),
      );

      await vi.advanceTimersByTimeAsync(3_000);
      expect(outcome).toMatchObject({
        tag: "PreviewAutomationExecutionError",
        message: expect.stringContaining("not producing screenshot frames"),
      });
      await capture;
      expect(await evaluation).toBe("still responsive");
      expect(vi.getTimerCount()).toBe(0);

      captured.resolve({ data: "late-frame" });
      await captured.promise;
      expect(outcome).toBeInstanceOf(ServerBrowserPage.ServerBrowserOperationError);
      expect(send.mock.calls.map(([method]) => method)).toEqual([
        "Page.captureScreenshot",
        "Runtime.evaluate",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe.skipIf(browserPath === null)("server browser element refs", () => {
  let browser: Browser;
  let context: BrowserContext;
  let page: Page;
  let cdp: CDPSession;

  beforeAll(async () => {
    browser = await chromium.launch({ executablePath: browserPath!, headless: true });
  });
  afterAll(async () => {
    await browser?.close();
  });
  beforeEach(async () => {
    context = await browser.newContext();
    page = await context.newPage();
    cdp = await context.newCDPSession(page);
  });
  afterEach(async () => {
    await context.close();
  });

  const takeSnapshot = (locator?: string) =>
    ServerBrowserPage.snapshot({
      locator,
      page,
      cdp,
      renderScale: 1,
      consoleEntries: [],
      networkEntries: [],
      actionTimeline: [],
    });
  const locators = (tree: unknown) => {
    expect(typeof tree).toBe("string");
    return Array.from(
      String(tree).matchAll(/\[ref=([^\]]+)\]/g),
      (match) => `aria-ref=${match[1]}`,
    );
  };
  const buttonLocator = (tree: unknown, name: string) => {
    const line = String(tree)
      .split("\n")
      .find((line) => line.includes(`button "${name}"`));
    const locator = locators(line)[0];
    expect(locator).toBeDefined();
    return locator!;
  };
  const repeatedRows = `<ul>${Array.from({ length: 5 }, (_, i) => `<li>row ${i + 1}<button data-testid="delete-row" onclick="this.parentElement.remove()">delete</button></li>`).join("")}</ul>`;

  it("does not report an empty interactiveElements list beside a tree full of controls", async () => {
    await page.setContent(
      `<a href="#signin">Sign in</a><button>Open menu</button><button>Dismiss local database notice</button>`,
    );
    const result = await takeSnapshot();
    expect(buttonLocator(result.accessibilityTree, "Open menu")).toBeDefined();
    expect(String(result.accessibilityTree)).toContain('link "Sign in"');
    const elements = (
      result as { readonly interactiveElements?: ReadonlyArray<{ readonly name: string }> }
    ).interactiveElements;
    if (elements !== undefined) {
      expect(elements.map((element) => element.name)).toEqual(
        expect.arrayContaining(["Sign in", "Open menu", "Dismiss local database notice"]),
      );
    }
  });

  it("clicks the fifth repeated delete control without touching row one", async () => {
    await page.setContent(repeatedRows);
    const result = await takeSnapshot();
    const buttons = String(result.accessibilityTree)
      .split("\n")
      .filter((line) => line.includes('button "delete"'));
    expect(buttons).toHaveLength(5);
    await ServerBrowserPage.click(page, { locator: locators(buttons[4])[0]!, timeoutMs: 1_000 });
    expect(await page.locator("li").allTextContents()).toEqual([
      "row 1delete",
      "row 2delete",
      "row 3delete",
      "row 4delete",
    ]);
  });

  it("returns from a click once it opens a dialog", async () => {
    await page.setContent(
      `<button onclick="document.body.dataset.answer = String(confirm('sure?'))">Confirm</button>`,
    );
    const dialog = new Promise<import("playwright-core").Dialog>((resolve) =>
      page.once("dialog", resolve),
    );
    await ServerBrowserPage.click(page, {
      locator: buttonLocator((await takeSnapshot()).accessibilityTree, "Confirm"),
      timeoutMs: 1_000,
    });
    await (await dialog).accept();
    await expect.poll(() => page.locator("body").getAttribute("data-answer")).toBe("true");
  });

  it("rejects ambiguous CSS controls without clicking any row", async () => {
    await page.setContent(repeatedRows);
    await expect(
      ServerBrowserPage.click(page, {
        selector: 'button[data-testid="delete-row"]',
        timeoutMs: 1_000,
      }),
    ).rejects.toThrow(/strict mode violation/);
    expect(await page.locator("li").count()).toBe(5);
  });

  it("tells a click target that matches nothing from one that never becomes clickable", async () => {
    await page.setContent(`<button hidden>hidden</button>`);
    const failure = (selector: string) =>
      ServerBrowserPage.click(page, { selector, timeoutMs: 500 }).then(
        () => expect.unreachable(),
        ServerBrowserPage.toOperationError,
      );

    const absent = await failure(".definitely-no-such-t3-target");
    expect(absent.tag).toBe("PreviewAutomationTimeoutError");
    expect(absent.message).toBe(
      'The click may have happened and removed its target or navigated; check the page before retrying. No element matches ".definitely-no-such-t3-target" after the timeout; take a fresh snapshot and use its locator.',
    );
    expect(absent.cause).toMatchObject({ name: "TimeoutError" });
    const hidden = await failure("button");
    expect(hidden.tag).toBe("PreviewAutomationTimeoutError");
    expect(hidden.message).toMatch(
      /^The click may have happened; check the page before retrying\. "button" still matches an element after the timeout\./,
    );
    expect(hidden.message).toContain("Playwright last saw: element is not visible");
  });

  it("does not retarget a removed ref to a replacement node", async () => {
    await page.setContent("<button onclick=\"this.textContent='clicked'\">original</button>");
    const locator = buttonLocator((await takeSnapshot()).accessibilityTree, "original");
    await page.setContent("<button onclick=\"this.textContent='clicked'\">replacement</button>");
    await expect(ServerBrowserPage.click(page, { locator, timeoutMs: 100 })).rejects.toThrow();
    expect(await page.locator("button").textContent()).toBe("replacement");
  });

  it("targets iframe input refs and preserves the parent form", async () => {
    await page.setContent(
      '<input aria-label="parent"><iframe srcdoc="<input aria-label=child>"></iframe>',
    );
    await page.frameLocator("iframe").getByRole("textbox").waitFor();
    const result = await takeSnapshot();
    const line = String(result.accessibilityTree)
      .split("\n")
      .find((line) => line.includes('textbox "child"'));
    const locator = locators(line)[0]!;
    await ServerBrowserPage.type(page, { locator, text: "inside iframe", clear: true });
    expect(await page.frameLocator("iframe").getByRole("textbox").inputValue()).toBe(
      "inside iframe",
    );
    expect(await page.getByRole("textbox", { name: "parent" }).inputValue()).toBe("");
  });

  it("marks a password field refusal as a secret field without typing", async () => {
    await page.setContent('<input type="password" aria-label="Password">');
    const failure = await ServerBrowserPage.refuseSecretField(page, {
      locator: "input",
      text: "hunter2",
    }).then(
      () => expect.unreachable(),
      (error: unknown) => error,
    );
    expect(failure).toMatchObject({
      tag: "PreviewAutomationTargetNotEditableError",
      message: "The target is a password or secret field, and agents never type into one.",
      detail: { secretField: true },
    });
    expect(await page.locator("input").inputValue()).toBe("");
  });

  it("types after a click by coordinates into a shadow-root field, and refuses a field inside an editable frame", async () => {
    await page.setContent(
      `<div id="host"></div><div contenteditable="true"><iframe srcdoc="<input id=inner>"></iframe></div><script>document.getElementById("host").attachShadow({mode:"open"}).innerHTML = "<input id=field>";</script>`,
    );
    const field = page.locator("#host #field");
    const box = (await field.boundingBox())!;
    await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
    await ServerBrowserPage.type(page, { text: "shadow" });
    expect(await field.inputValue()).toBe("shadow");

    // Refused for now: focus inside a frame cannot be checked from the top document.
    const inner = page.frameLocator("iframe").locator("#inner");
    await inner.click();
    await expect(ServerBrowserPage.type(page, { text: "frame" })).rejects.toMatchObject({
      tag: "PreviewAutomationTargetNotEditableError",
    });
    expect(await inner.inputValue()).toBe("");
  });

  it("types into a field that builds its value from keydown, with and without clear", async () => {
    await page.setContent(
      `<input id=a><input id=b><script>for(const f of[a,b]){f.keys="";f.onkeydown=e=>{if(e.key.length===1){e.preventDefault();f.keys+=e.key}}}</script>`,
    );
    const keys = (selector: string) =>
      page.locator(selector).evaluate((field) => (field as unknown as { keys: string }).keys);
    await ServerBrowserPage.type(page, { locator: "#a", text: "girona42" });
    expect(await keys("#a")).toBe("girona42");
    await ServerBrowserPage.type(page, { locator: "#b", text: "girona42", clear: true });
    expect(await keys("#b")).toBe("girona42");
    await ServerBrowserPage.type(page, { locator: "#b", text: "a".repeat(501), clear: true });
    expect(await keys("#b")).toBe(`girona42${"a".repeat(501)}`);

    await page.setContent(
      `<form onsubmit="event.preventDefault();sent.value='sent'"><label for=e>Email</label><input id=e value=old><input id=d type=date value=2020-02-02><label>Tint <input id=c type=color></label><input id=r type=range><textarea id=t></textarea><input id=sent></form>`,
    );
    await ServerBrowserPage.type(page, { locator: "text=Email", text: "a@b.c", clear: true });
    expect(await page.locator("#e").inputValue()).toBe("a@b.c");
    await ServerBrowserPage.type(page, { locator: "#d", text: "2026-01-31", clear: true });
    expect(await page.locator("#d").inputValue()).toBe("2026-01-31");
    await ServerBrowserPage.type(page, { locator: "text=Tint", text: "#ff0000", clear: true });
    expect(await page.locator("#c").inputValue()).toBe("#ff0000");
    await ServerBrowserPage.type(page, { locator: "#r", text: "70", clear: true });
    expect(await page.locator("#r").inputValue()).toBe("70");
    await ServerBrowserPage.type(page, { locator: "#e", text: "x\ny" });
    await ServerBrowserPage.type(page, { locator: "#t", text: "one\r\ntwo" });
    expect(await page.locator("#t").inputValue()).toBe("one\ntwo");
    expect(await page.locator("#sent").inputValue()).toBe("");
  });

  it("shows dotted fields as dots wherever their value appears, keeping text values and refs", async () => {
    await page.setContent(`
      <table><tr><td>password:</td><td><input id="pw" type="password" aria-label="Password"></td></tr></table>
      <input aria-label="Username" value="maria">
      <input type="password" aria-label='saved" [ref=e2]: x' placeholder="hint" value="saved-pass">
      <input type="password" role="combobox" aria-label="Code" value="role-pass">
      <input aria-label="PIN" style="-webkit-text-security: disc" value="styled-pass">
      <div contenteditable style="-webkit-text-security: disc">editable-pass</div>
      <iframe srcdoc="<input type=password aria-label=child value=frame-pass>"></iframe>
      <iframe id="blank" src="javascript:false"></iframe>
      <p>Order styled-pass-2</p>
      <script>
        // A frame that never commits a document, filled by its parent.
        blank.contentDocument.body.innerHTML = "<input type=password aria-label=blank value=blank-pass>";
        // Page script can't change the value the snapshot sees.
        Object.defineProperty(HTMLInputElement.prototype, "value", { get: () => "" });
      </script>`);
    await page.frameLocator("iframe[srcdoc]").getByRole("textbox").waitFor();
    await ServerBrowserPage.type(page, { locator: "#pw", text: "typed-pass" });
    const result = await takeSnapshot();
    const tree = String(result.accessibilityTree);
    expect(tree).toContain('textbox "blank"');
    expect(tree).not.toMatch(
      /typed-pass|saved-pass|role-pass|styled-pass|editable-pass|frame-pass|blank-pass/,
    );
    expect(result.visibleText).not.toContain("editable-pass");
    expect(result.visibleText).toContain("Order ••••••••-2");
    // Playwright 1.64 no longer names a row after its cells; where a snapshot does, the name is masked too.
    const row = tree.split("\n").find((line) => /- '?row\b/.test(line));
    expect(row).toBeDefined();
    if (row!.includes('row "')) expect(row).toMatch(/row "password: •+"/);
    expect(tree).toMatch(/textbox "Username" [^\n]*: maria$/m);
    const line = tree.split("\n").find((line) => line.includes('textbox "Password"'));
    expect(line).toMatch(/: •+$/);
    await ServerBrowserPage.type(page, { locator: locators(line)[0]!, text: "next", clear: true });
    expect(await page.locator("#pw").inputValue()).toBe("next");
  });

  it("masks dotted values in page text next to punctuation, with odd spaces, and at the cut", async () => {
    await page.setContent(`
      <input type="password" aria-label="PIN" value="123">
      <input type="password" aria-label="Phrase" value="open&nbsp;sesame">
      <p>PIN: 123. Code (123) id 1234</p>
      <p>open&nbsp;sesame</p>`);
    const text = (await takeSnapshot()).visibleText;
    expect(text).toContain("PIN: ••••••••. Code (••••••••) id 1234");
    expect(text).not.toMatch(/open|sesame/);
    await page.setContent(`
      <p>${"x".repeat(19_995)}long-secret</p>
      <input type="password" aria-label="Long" value="long-secret">`);
    const cut = (await takeSnapshot()).visibleText;
    expect(cut.length).toBe(20_000);
    expect(cut.slice(-8)).toBe("xxx•••••");
  });

  it("shows a data: link or blocked data: navigation by media type only", async () => {
    // Chromium keeps raw spaces and quotes in both, so a payload can't be cut at either.
    await page.setContent(`
      <a download href="data:text/plain;charset=&quot;a,b&quot;,head PAYLOAD'tail">Key</a>
      <a href="https://example.com/data:report,2026">Report</a>
      <a href="#">data:text/plain,label</a>
      <a href='"data:text/plain,relative'>Relative</a>
      <a href=" data:text/plain,PAYLOAD">Spaced</a>
      <a href="da&#9;ta:text/plain,PAYLOAD">Tabbed</a>
      <a href="data:text/plain,head&#x2028;PAYLOAD">Separated</a>
      <a href="data:PAYLOAD,x">Typeless</a>
      <a href="&#11;data:text/plain,PAYLOAD">Vertical tab</a>
      <a href="&#8;data:text/plain,PAYLOAD">Backspace</a>
      <a id="controlled">Controlled</a>
      <a id="escaped">Escaped</a>
      <script>
        controlled.href = "\\x01data:text/plain,PAYLOAD";
        escaped.href = "\\x02da\\tta:text/plain,PAYLOAD";
      </script>`);
    const tree = String((await takeSnapshot()).accessibilityTree);
    expect(tree.match(/\/url: data:text\/plain,…$/gm)).toHaveLength(8);
    expect(tree).toContain("/url: data:,…");
    expect(tree).toContain("/url: https://example.com/data:report,2026");
    expect(tree).toMatch(/link "data:text\/plain,label" \[ref=t3-/);
    expect(tree).not.toMatch(/PAYLOAD|tail|charset|\u2028/);
    expect(tree).toContain('/url: "\\"data:text/plain,relative"');
  });

  it("redacts a data: link whose scheme a password value would mask", async () => {
    await page.setContent(`
      <input type="password" aria-label="Scheme" value="data">
      <a download href="data:text/plain,PAYLOAD">Key</a>`);
    const tree = String((await takeSnapshot()).accessibilityTree);
    expect(tree).toContain("/url: ••••••••:text/plain,…");
    expect(tree).not.toContain("PAYLOAD");
  });

  it("shows a data: page's own URL by media type only", async () => {
    await page.goto("data:text/html,<title>Key</title>PAYLOAD");
    expect((await takeSnapshot()).url).toBe("data:text/html,…");
  });

  it("rejects refs from another tab", async () => {
    await page.setContent("<button>same label</button>");
    const locator = buttonLocator((await takeSnapshot()).accessibilityTree, "same label");
    const other = await context.newPage();
    await other.setContent("<button>same label</button>");
    await expect(ServerBrowserPage.click(other, { locator })).rejects.toThrow(/another tab/);
  });

  it("revokes refs after navigation even when labels are identical", async () => {
    await page.goto("data:text/html,<button>continue</button>");
    const locator = buttonLocator((await takeSnapshot()).accessibilityTree, "continue");
    await page.goto("data:text/html,<button>continue</button><p>new document</p>");
    await expect(ServerBrowserPage.click(page, { locator })).rejects.toThrow(/stale/);
  });

  it("snapshots only the region named by a locator, with refs that work", async () => {
    await page.setContent(
      `<nav><button>Sidebar</button></nav>
       <section aria-label="card"><p>Acme Ltd</p><button onclick="this.textContent='accepted'">Accept</button></section>`,
    );
    const whole = await takeSnapshot();
    const card = locators(
      String(whole.accessibilityTree)
        .split("\n")
        .find((line) => line.includes('region "card"')),
    )[0]!;
    const scoped = await takeSnapshot(card);
    expect(String(scoped.accessibilityTree)).toContain('button "Accept"');
    expect(String(scoped.accessibilityTree)).not.toContain("Sidebar");
    expect(scoped.visibleText).toContain("Acme Ltd");
    expect(scoped.visibleText).not.toContain("Sidebar");
    await ServerBrowserPage.click(page, {
      locator: buttonLocator(scoped.accessibilityTree, "Accept"),
      timeoutMs: 1_000,
    });
    expect(await page.getByRole("button", { name: "accepted" }).count()).toBe(1);
  });

  it("captures a contenteditable's innerText without replacing its tree or nearby field values", async () => {
    await page.setContent(`
      <style>.suggestion::before { content: "Smith"; }</style>
      <nav>Sidebar text</nav>
      <input aria-label="Name" value="Native value">
      <div id="doc" role="textbox" aria-label="Doc" contenteditable="true">
        <h2>Account notes</h2>
        <p>Brookside <a href="#">Skip Hire Ltd</a> is a prospect.</p>
        <p class="suggestion">The quote should say "Operator", not "Basic".</p>
      </div>
      <input aria-label="Other" value="Unrelated value">
    `);
    const body = await page.locator("#doc").innerText();
    expect(body).not.toContain("Smith");
    const whole = await takeSnapshot();
    const wholeTree = String(whole.accessibilityTree);
    const docLine = wholeTree.split("\n").find((line) => line.includes('textbox "Doc"'));
    expect(wholeTree).toContain("Smith");
    expect(docLine).toContain(`: ${JSON.stringify(body)}`);
    expect(wholeTree).toContain('textbox "Name"');
    expect(wholeTree).toContain("Native value");
    expect(docLine).not.toContain("Unrelated value");
    expect(wholeTree).toContain('link "Skip Hire Ltd"');

    const docRef = /\[ref=([^\]]+)\]/.exec(docLine!)?.[1];
    const scoped = await takeSnapshot(`aria-ref=${docRef}`);
    expect(scoped.visibleText).toBe(body);
    expect(String(scoped.accessibilityTree)).not.toContain("Sidebar text");
    expect(
      String(scoped.accessibilityTree)
        .split("\n")
        .find((line) => line.includes('textbox "Doc"')),
    ).toContain(`: ${JSON.stringify(body)}`);
  });

  it("ignores reference-looking text in a textbox label when reading editable values", async () => {
    await page.setContent(`
      <input aria-label="Native [ref=e999999]" value="Native value">
      <div role="textbox" aria-label="Doc" contenteditable="true">Editor value</div>
    `);
    const snapshot = await takeSnapshot();
    const tree = String(snapshot.accessibilityTree);
    const nativeLine = tree.split("\n").find((line) => line.includes('textbox "Native'));
    const editorLine = tree.split("\n").find((line) => line.includes('textbox "Doc"'));
    expect(nativeLine).toContain("Native value");
    expect(editorLine).toContain(`: ${JSON.stringify("Editor value")}`);
  });

  it("does not use an editor's ref-looking label text to overwrite a native value", async () => {
    await page.setContent(`
      <div id="doc" role="textbox" aria-label="Doc" contenteditable="true">Editor value</div>
      <input id="native" aria-label="Native" value="Native value">
    `);
    const initialTree = await page.ariaSnapshot({ mode: "ai", boxes: true });
    const editorLine = initialTree.split("\n").find((line) => line.includes('textbox "Doc"'));
    const editorRef = /\[ref=((?:f\d+)?e\d+)\]/.exec(editorLine!)?.[1];
    expect(editorRef).toBeDefined();
    await page.locator("#native").evaluate((element, ref) => {
      element.setAttribute("aria-label", `Native [ref=${ref}]`);
    }, editorRef);

    const snapshot = await takeSnapshot();
    const tree = String(snapshot.accessibilityTree);
    const nativeLine = tree.split("\n").find((line) => line.includes('textbox "Native'));
    const capturedEditorLine = tree.split("\n").find((line) => line.includes('textbox "Doc"'));
    expect(nativeLine).toContain("Native value");
    expect(capturedEditorLine).toContain(`: ${JSON.stringify("Editor value")}`);
  });

  it("does not pass empty checks when flat editor content is omitted by the task snapshot budget", async () => {
    const textLength = ServerBrowserPage.TASK_SNAPSHOT_TEXT_LENGTH;
    const body = "x".repeat(textLength - 1);
    await page.setContent(
      `<div role="textbox" aria-label="Doc" contenteditable="true">${body}</div>`,
    );
    const originalTree = await page.ariaSnapshot({ mode: "ai", boxes: true });
    const originalDocLine = originalTree.split("\n").find((line) => line.includes('textbox "Doc"'));
    expect(originalDocLine).toBeDefined();
    expect(originalDocLine).not.toContain(":");
    expect(originalTree).not.toContain("\n  - ");
    const snapshot = await ServerBrowserPage.snapshot({
      page,
      cdp,
      renderScale: 1,
      consoleEntries: [],
      networkEntries: [],
      actionTimeline: [],
      textLength,
    });
    const tree = String(snapshot.accessibilityTree);
    const docLine = tree.split("\n").find((line) => line.includes('textbox "Doc"'));
    expect(originalTree.length).toBeLessThan(textLength);
    expect(snapshot.visibleText.length).toBeLessThan(textLength);
    expect(tree.length).toBeLessThan(textLength);
    expect(docLine).not.toContain(`: ${JSON.stringify(body)}`);

    const model = pageModelFromSnapshot(snapshot);
    expect(model.truncated).toBe(false);
    const field = resolveTarget(model, { role: "textbox", name: "Doc" });
    if (field._tag !== "unique") throw new Error(`Doc is ${field._tag}`);
    const binding = bindingSatisfied(
      model,
      { id: "empty", control: "text", target: { role: "textbox", name: "Doc" }, text: "" },
      field.node,
    );
    const valueCheck = evaluateChecks(model, [
      {
        id: "empty",
        kind: "target",
        target: { role: "textbox", name: "Doc" },
        expect: "present",
        value: "",
      },
    ])[0]?.status;
    expect({ binding, valueCheck }).toEqual({ binding: false, valueCheck: "failed" });
  });

  it("does not compare a rich-text value omitted by the task snapshot budget", async () => {
    const body = "x".repeat(600_000);
    await page.setContent(
      `<div id="doc" role="textbox" aria-label="Doc" contenteditable="true"><p>${body.slice(0, 300_000)}</p><p>${body.slice(300_000)}</p></div>`,
    );
    const editorText = await page.locator("#doc").innerText();
    const originalTree = await page.ariaSnapshot({ mode: "ai", boxes: true });
    const textLength = ServerBrowserPage.TASK_SNAPSHOT_TEXT_LENGTH;
    expect(originalTree.length).toBeLessThan(textLength);
    expect(originalTree.length + editorText.length).toBeGreaterThan(textLength);

    const snapshot = await ServerBrowserPage.snapshot({
      page,
      cdp,
      renderScale: 1,
      consoleEntries: [],
      networkEntries: [],
      actionTimeline: [],
      textLength,
    });
    const tree = String(snapshot.accessibilityTree);
    const docLine = tree.split("\n").find((line) => line.includes('textbox "Doc"'));
    expect(tree.length).toBeLessThan(textLength);
    expect(snapshot.visibleText.length).toBeLessThan(textLength);
    expect(docLine).not.toContain(`: ${JSON.stringify(editorText)}`);
  });

  it("rejects a contenteditable value that changes during the capture", async () => {
    await page.setContent(
      '<div id="doc" role="textbox" aria-label="Doc" contenteditable="true">draft</div>',
    );
    await page.locator("#doc").evaluate((element) => {
      let reads = 0;
      Object.defineProperty(element, "innerText", {
        configurable: true,
        get: () => `changed ${++reads}`,
      });
    });
    await expect(takeSnapshot()).rejects.toMatchObject({
      message: "The page changed while capturing its snapshot. Take another snapshot.",
    });
  });

  it("waits for text and elements to go away, and names what still holds on timeout", async () => {
    await page.setContent(
      `<p id="note">Saving</p><div class="card">Acme</div>
       <script>setTimeout(() => { document.getElementById("note").textContent = "Saved"; document.querySelector(".card").hidden = true }, 150)</script>`,
    );
    await ServerBrowserPage.waitFor(page, {
      textAbsent: "Saving",
      locatorAbsent: ".card",
      timeoutMs: 3_000,
    });
    expect(await page.locator("#note").textContent()).toBe("Saved");
    await page.setContent('<p>Saving</p><div class="card">Acme</div>');
    await expect(
      ServerBrowserPage.waitFor(page, {
        text: "Saving",
        textAbsent: "Saving",
        locatorAbsent: ".card",
        timeoutMs: 200,
      }),
    ).rejects.toThrow("still not holding: textAbsent, locatorAbsent");
    await ServerBrowserPage.waitFor(page, { locatorAbsent: ".missing", timeoutMs: 200 });
    // One hidden match does not make the element gone while another still shows.
    await page.setContent('<div class="card" hidden>old</div><div class="card">new</div>');
    await expect(
      ServerBrowserPage.waitFor(page, { locatorAbsent: ".card", timeoutMs: 200 }),
    ).rejects.toThrow("still not holding: locatorAbsent");
    // Failing to look is an error, never absence.
    await expect(
      ServerBrowserPage.waitFor(page, { locatorAbsent: "css=:::", timeoutMs: 200 }),
    ).rejects.not.toThrow("still not holding");
  });

  it("tells whether any match of a selector shows, as Phi's absence wait needs", async () => {
    const shown = (selector: string) =>
      page.evaluate(`(${PHI_ANY_VISIBLE_MATCH})(${JSON.stringify(selector)})`);
    await page.setContent('<div class="card" hidden>old</div><div class="card">new</div>');
    expect(await shown(".card")).toBe(true);
    await page.setContent(
      '<div class="card" hidden>old</div><div class="card" style="visibility:hidden">new</div>',
    );
    expect(await shown(".card")).toBe(false);
    const frame = (style: string) =>
      `<iframe style="${style}" srcdoc="<div class=card>inside</div>"></iframe>`;
    await page.setContent(frame("width:200px;height:100px"));
    await page.frameLocator("iframe").locator(".card").waitFor();
    expect(await shown(".card")).toBe(true);
    await page.setContent(frame("width:200px;height:100px;visibility:hidden"));
    await page.waitForLoadState("load");
    expect(await shown(".card")).toBe(false);
    await expect(shown(":::")).rejects.toThrow();
  });

  it.each(["aria-ref=e1", " aria-ref=e1", "css=body >> aria-ref=e1"])(
    "does not allow native refs to bypass generation validation (%s)",
    async (locator) => {
      await page.setContent("<button>continue</button>");
      await takeSnapshot();
      await expect(ServerBrowserPage.click(page, { locator })).rejects.toThrow(/stale/);
    },
  );

  it("preserves quoted attribute values containing ref engine text", async () => {
    await page.setContent(
      '<button data-example=" >> aria-ref=e1" onclick="this.textContent=\'saved\'">save</button>',
    );
    await ServerBrowserPage.click(page, { selector: 'button[data-example=" >> aria-ref=e1"]' });
    expect(await page.locator("button").textContent()).toBe("saved");
  });

  it("evaluates top-level await and returns the last expression's value", async () => {
    await page.setContent("<title>Ready</title>");
    const result = await ServerBrowserPage.evaluate(
      cdp,
      { expression: "await Promise.resolve(); document.title" },
      5_000,
    );
    expect(result).toBe("Ready");
  });

  it("returns object contents even when a legacy caller asks for a remote reference", async () => {
    const input = decodeEvaluateInput({
      expression: "({ answer: 42, nested: { ready: true } })",
      returnByValue: false,
    });
    const result = await ServerBrowserPage.evaluate(cdp, input, 5_000);
    expect(result).toEqual({ answer: 42, nested: { ready: true } });
  });

  it("still awaits the promise an async function returns", async () => {
    const result = await ServerBrowserPage.evaluate(
      cdp,
      { expression: "(async () => { await 0; return 1 })()" },
      5_000,
    );
    expect(result).toBe(1);
  });

  it("does not rerun an expression whose SyntaxError is thrown at runtime", async () => {
    const evaluation = ServerBrowserPage.evaluate(
      cdp,
      { expression: "window.runs = (window.runs ?? 0) + 1; new Function('await 0')" },
      5_000,
    );
    await expect(evaluation).rejects.toThrow("await is only valid");
    expect(await page.evaluate("window.runs")).toBe(1);
  });

  it("does not rerun an expression whose awaited browser call rejects with a SyntaxError", async () => {
    let posts = 0;
    await page.route("http://preview.test/**", (route) => {
      if (route.request().method() === "POST") posts++;
      return route.fulfill({ contentType: "text/html", body: "<title>Ready</title>" });
    });
    await page.goto("http://preview.test/");
    const evaluation = ServerBrowserPage.evaluate(
      cdp,
      {
        expression:
          "(async () => { const r = await fetch('/api', { method: 'POST' }); return r.json() })()",
      },
      5_000,
    );
    await expect(evaluation).rejects.toThrow("is not valid JSON");
    expect(posts).toBe(1);
  });

  it("returns the result of a top-level await expression that reloads the page", async () => {
    await page.route("http://preview.test/", (route) =>
      route.fulfill({ contentType: "text/html", body: "<title>Ready</title>" }),
    );
    await page.goto("http://preview.test/");
    const result = await ServerBrowserPage.evaluate(
      cdp,
      { expression: "await 0; location.reload(); ({ clicked: true })" },
      5_000,
    );
    expect(result).toEqual({ clicked: true });
  });
});

describe.skipIf(browserPath === null)("server browser snapshot screenshot", () => {
  let browser: Browser;
  let context: BrowserContext;

  beforeAll(async () => {
    // ServerBrowserContexts launches with these, and the capture scale depends on them.
    browser = await chromium.launch({
      executablePath: browserPath!,
      headless: true,
      args: ["--disable-gpu", "--force-device-scale-factor=2"],
    });
  });
  afterAll(async () => {
    await browser?.close();
  });
  beforeEach(async () => {
    context = await browser.newContext({
      viewport: { width: 1280, height: 800 },
      deviceScaleFactor: 2,
    });
  });
  afterEach(async () => {
    await context.close();
  });

  // Blue on the left half and red on the right, so a mirrored left half shows up on the right.
  const halves = (overlay: string) => `
    <style>
      body { margin: 0; background: white; }
      .half { position: absolute; top: 0; width: 640px; height: 800px; }
      .overlay { position: fixed; inset: 0; ${overlay} }
    </style>
    <div class="half" style="left: 0; background: #2563eb"></div>
    <div class="half" style="left: 640px; background: #ef4444"></div>
    <div class="overlay"></div>`;

  const screenshotOf = async (html: string) => {
    const page = await context.newPage();
    await page.setContent(html);
    const input = {
      page,
      cdp: await context.newCDPSession(page),
      renderScale: 2,
      fullScreenshot: true,
      consoleEntries: [],
      networkEntries: [],
      actionTimeline: [],
    };
    const captured = await ServerBrowserPage.snapshot(input);
    // No saved login is in play here, so a snapshot always carries its image.
    const screenshot = captured.screenshot!;
    const { fullScreenshot } = captured;
    // The server has no DOM types, so the decoder runs as page source.
    const points = [
      [0.15, 0.75],
      [0.85, 0.25],
      [0.85, 0.75],
    ];
    const pixels = (await page.evaluate(`(async () => {
      const bytes = Uint8Array.from(atob(${JSON.stringify(screenshot.data)}), (char) => char.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/png" }));
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext("2d");
      context.drawImage(bitmap, 0, 0);
      return ${JSON.stringify(points)}.map(([x, y]) =>
        Array.from(context.getImageData(x * bitmap.width, y * bitmap.height, 1, 1).data),
      );
    })()`)) as Array<[number, number, number, number]>;
    return { screenshot, fullScreenshot, pixels, input };
  };
  const colorOf = ([red, green, blue]: readonly [number, number, number, number]) =>
    blue - red > 100 ? "blue" : red - blue > 100 ? "red" : `rgb(${red}, ${green}, ${blue})`;

  it("gives a task screenshot an inline copy no wider than the tab, keeping the capture", async () => {
    const page = await context.newPage();
    await page.setContent(halves(""));
    const taken = await ServerBrowserPage.captureTaskScreenshot({
      page,
      cdp: await context.newCDPSession(page),
      framing: "viewport",
      maxBytes: 5_000_000,
      timeoutMs: 10_000,
      secrets: [],
    });
    expect([taken.width, taken.height]).toEqual([2560, 1600]);
    // A PNG's IHDR holds its width and height, big-endian, at bytes 16 and 20.
    expect([taken.inline!.readUInt32BE(16), taken.inline!.readUInt32BE(20)]).toEqual([1280, 800]);
  });

  it("captures a blurred backdrop-filter page as rendered, not mirrored", async () => {
    const { screenshot, pixels } = await screenshotOf(halves("backdrop-filter: blur(4px);"));

    expect({
      size: [screenshot.width, screenshot.height],
      colors: pixels.map(colorOf),
    }).toEqual({ size: [1280, 800], colors: ["blue", "red", "red"] });
  });

  it("captures a plain page at the shrunk size with its content in place", async () => {
    const { screenshot, fullScreenshot, pixels, input } = await screenshotOf(halves(""));
    const metadata = await ServerBrowserPage.snapshotMetadata(input);

    expect({
      size: [screenshot.width, screenshot.height],
      fullSize: [fullScreenshot?.width, fullScreenshot?.height],
      metadataSize: metadata.screenshot,
      colors: pixels.map(colorOf),
    }).toEqual({
      size: [1280, 800],
      fullSize: [2560, 1600],
      metadataSize: { width: 1280, height: 800 },
      colors: ["blue", "red", "red"],
    });
  });

  it("caps the inline image at the tab's CSS width and keeps the device pixels to save", async () => {
    const page = await context.newPage();
    await page.setViewportSize({ width: 375, height: 667 });
    await page.setContent("<title>Phone</title><h1>Phone</h1>");
    const captured = await ServerBrowserPage.snapshot({
      page,
      cdp: await context.newCDPSession(page),
      renderScale: 2,
      fullScreenshot: true,
      consoleEntries: [],
      networkEntries: [],
      actionTimeline: [],
    });

    expect([captured.screenshot?.width, captured.screenshot?.height]).toEqual([375, 667]);
    expect([captured.fullScreenshot?.width, captured.fullScreenshot?.height]).toEqual([750, 1334]);
  });

  it("records the destination of a finite entrance animation without waiting on infinite ones", async () => {
    const page = await context.newPage();
    await page.setContent(`
      <style>
        body { margin: 0; background: #2563eb; }
        @keyframes enter { from { opacity: 0; } to { opacity: 1; } }
        @keyframes pulse { from { opacity: 0.5; } to { opacity: 1; } }
        button { animation: pulse 2s infinite; }
        #paused { animation: enter 2s paused; }
        #overlay { display: none; position: fixed; inset: 0; background: #ef4444; }
        #overlay.open { display: block; animation: enter 200ms both; }
      </style>
      <button onclick="document.querySelector('#overlay').classList.add('open')">Open</button>
      <div id="paused"></div>
      <div id="overlay"></div>
    `);
    await page.getByRole("button", { name: "Open" }).click();
    const frame = await ServerBrowserPage.captureFinalRecordingFrame(
      await context.newCDPSession(page),
      80,
    );
    expect(frame).toBeDefined();
    const pixel = (await page.evaluate(`(async () => {
      const bytes = Uint8Array.from(atob(${JSON.stringify(frame)}), char => char.charCodeAt(0));
      const bitmap = await createImageBitmap(new Blob([bytes], { type: "image/jpeg" }));
      const canvas = document.createElement("canvas");
      canvas.width = bitmap.width;
      canvas.height = bitmap.height;
      const context = canvas.getContext("2d");
      context.drawImage(bitmap, 0, 0);
      return Array.from(context.getImageData(bitmap.width / 2, bitmap.height / 2, 1, 1).data);
    })()`)) as [number, number, number, number];
    expect(colorOf(pixel)).toBe("red");
  });

  it("shrinks the screenshot of an XML document, whose createElement makes no canvas", async () => {
    const page = await context.newPage();
    await page.goto("data:text/xml,<a/>");
    const { screenshot } = await ServerBrowserPage.snapshot({
      page,
      cdp: await context.newCDPSession(page),
      renderScale: 2,
      consoleEntries: [],
      networkEntries: [],
      actionTimeline: [],
    });

    expect([screenshot?.width, screenshot?.height]).toEqual([1280, 800]);
  });
});

describe.skipIf(browserPath === null)("server browser drag", () => {
  it("fails the drag, not the server, when it times out while the cursor is still moving", async () => {
    const timedOut = new Error("locator.dragTo: Timeout 30000ms exceeded.");
    const box = { x: 0, y: 0, width: 20, height: 20 };
    const targetBox = Promise.withResolvers<typeof box>();
    const page = {
      locator: (selector: string) =>
        selector === "#card"
          ? {
              scrollIntoViewIfNeeded: async () => {},
              boundingBox: async () => box,
              dragTo: () => Promise.reject(timedOut),
            }
          : { boundingBox: () => targetBox.promise },
    } as unknown as Page;
    const unobserved: Array<unknown> = [];
    const onUnhandled = (reason: unknown) => unobserved.push(reason);
    process.on("unhandledRejection", onUnhandled);
    try {
      let finished = false;
      const settled = ServerBrowserPage.drag(page, { source: "#card", target: "#lane" }).then(
        () => null,
        (error: unknown) => error,
      );
      void settled.then(() => (finished = true));
      // Two macrotask turns: Node reports a rejection nobody observed after the first.
      for (let turn = 0; turn < 2; turn++) {
        // oxlint-disable-next-line t3code/no-real-time-wait-in-tests -- Node emits unhandledRejection only between macrotasks; no promise can mark that point.
        await new Promise((resolve) => setImmediate(resolve));
      }
      expect(finished).toBe(false);
      targetBox.resolve(box);

      expect(await settled).toBe(timedOut);
      expect(unobserved).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("moves the mouse after dragstart, so pages that track a drag with mousemove see it", async () => {
    const browser = await chromium.launch({ executablePath: browserPath!, headless: true });
    try {
      const page = await browser.newPage();
      await page.setContent(`
        <div style="display:flex;gap:40px">
          <div id="source" draggable="true" style="width:200px;height:120px">source</div>
          <div id="target" style="width:200px;height:120px">target</div>
        </div>
        <script>
          window.events = [];
          let dragging = false;
          source.addEventListener("dragstart", (event) => {
            event.preventDefault();
            dragging = true;
            events.push("dragstart");
          });
          addEventListener("mousemove", () => dragging && events.push("mousemove"));
          addEventListener("mouseup", () => events.push("mouseup"));
        </script>`);

      await ServerBrowserPage.drag(page, { source: "#source", target: "#target" });

      const events = (await page.evaluate("window.events")) as Array<string>;
      expect(events.slice(0, 2)).toEqual(["dragstart", "mousemove"]);
      expect(events.at(-1)).toBe("mouseup");
    } finally {
      await browser.close();
    }
  });
});

describe("server browser action timeout", () => {
  type StepOptions = { readonly timeout?: number };
  it.each([
    {
      action: "hover",
      act: (page: Page) => ServerBrowserPage.hover(page, { selector: "#a", timeoutMs: 9_000 }),
      last: ["#a.hover 1"],
    },
    {
      action: "drag",
      act: (page: Page) =>
        ServerBrowserPage.drag(page, { source: "#a", target: "#b", timeoutMs: 9_000 }),
      last: ["#a.dragTo 1", "#b.boundingBox 1"],
    },
  ])("gives the $action's steps one shared timeout", async ({ act, last }) => {
    let now = 0;
    using _now = vi.spyOn(Date, "now").mockImplementation(() => now);
    const steps: Array<string> = [];
    const box = { x: 0, y: 0, width: 20, height: 20 };
    const page = {
      locator: (selector: string) => {
        const record = (step: string, options: StepOptions) =>
          steps.push(`${selector}.${step} ${options.timeout}`);
        return {
          // Each step that finds the target takes 5 of the 9 seconds.
          scrollIntoViewIfNeeded: async (options: StepOptions) => {
            record("scrollIntoViewIfNeeded", options);
            now += 5_000;
          },
          boundingBox: async (options: StepOptions) => {
            record("boundingBox", options);
            now += 5_000;
            return box;
          },
          hover: async (options: StepOptions) => record("hover", options),
          dragTo: async (_target: unknown, options: StepOptions) => record("dragTo", options),
        };
      },
    } as unknown as Page;

    await act(page);

    expect(steps).toEqual(["#a.scrollIntoViewIfNeeded 9000", "#a.boundingBox 4000", ...last]);
  });
});

describe("server browser click", () => {
  it("clicks a target the page replaced while it was being scrolled into view", async () => {
    let scrolls = 0;
    const clicks: Array<unknown> = [];
    const page = {
      locator: () => ({
        // Playwright resolves the node once; a page re-rendering it detaches that node.
        scrollIntoViewIfNeeded: async () => {
          if (scrolls++ === 0) {
            throw new Error("locator.scrollIntoViewIfNeeded: Element is not attached to the DOM");
          }
        },
        boundingBox: async () => ({ x: 0, y: 0, width: 20, height: 20 }),
        click: async (options: unknown) => {
          clicks.push(options);
        },
        count: async () => 1,
      }),
      once: () => {},
      off: () => {},
    } as unknown as Page;

    await expect(ServerBrowserPage.click(page, { selector: "#save" })).resolves.toEqual({
      x: 10,
      y: 10,
    });
    expect(clicks).toHaveLength(1);
  });

  it("retries a replaced target only within the action's timeout", async () => {
    vi.useFakeTimers();
    try {
      const timeouts: Array<number | undefined> = [];
      const clicks: Array<unknown> = [];
      const detached = new Error(
        "locator.scrollIntoViewIfNeeded: Element is not attached to the DOM",
      );
      const page = {
        locator: () => ({
          scrollIntoViewIfNeeded: async (options?: { timeout?: number }) => {
            timeouts.push(options?.timeout);
            vi.advanceTimersByTime(60);
            throw detached;
          },
          click: async (options: unknown) => {
            clicks.push(options);
          },
        }),
      } as unknown as Page;

      await expect(
        ServerBrowserPage.click(page, { selector: "#save", timeoutMs: 100 }),
      ).rejects.toBe(detached);
      expect(timeouts).toEqual([100, 40]);
      expect(clicks).toHaveLength(0);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("server browser snapshot of a stale ref", () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it("rejects without leaving a timeout armed that would fire unhandled", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const page = {} as unknown as Page;

    await expect(
      ServerBrowserPage.snapshot({
        locator: "aria-ref=e1",
        page,
        cdp: {} as unknown as CDPSession,
        renderScale: 1,
        consoleEntries: [],
        networkEntries: [],
        actionTimeline: [],
      }),
    ).rejects.toThrow(/stale/);

    expect(vi.getTimerCount()).toBe(0);
  });
});

describe("server browser evaluate", () => {
  it("does not retry a parse error that arrives after the timeout", async () => {
    vi.useFakeTimers();
    try {
      const classic = Promise.withResolvers<unknown>();
      const send = vi.fn((method: string) =>
        method === "Runtime.evaluate" ? classic.promise : Promise.resolve({}),
      );
      const cdp = { send } as unknown as CDPSession;
      const evaluation = ServerBrowserPage.evaluate(cdp, { expression: "await 0; 1" }, 10);
      const rejected = expect(evaluation).rejects.toMatchObject({
        tag: "PreviewAutomationTimeoutError",
      });
      await vi.advanceTimersByTimeAsync(10);
      await rejected;
      classic.resolve({
        result: { type: "object" },
        exceptionDetails: {
          text: "Uncaught",
          scriptId: "4",
          exception: { type: "object", className: "SyntaxError" },
        },
      });
      await classic.promise;
      expect(send.mock.calls.map(([method]) => method)).toEqual([
        "Runtime.evaluate",
        "Runtime.terminateExecution",
      ]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("server browser type", () => {
  // As on a desktop tab whose Playwright utility world never answers.
  const stalledPage = (focusAnswer: () => Promise<unknown>, typed: string[]) =>
    ({
      locator: () => ({ last: () => ({ count: () => new Promise<number>(() => {}) }) }),
      evaluate: focusAnswer,
      keyboard: { type: async (text: string) => void typed.push(text) },
    }) as unknown as Page;

  it("types into the focused field when Playwright's utility world never answers", async () => {
    vi.useFakeTimers();
    try {
      const typed: string[] = [];
      let outcome: unknown = "pending";
      const page = stalledPage(async () => true, typed);
      void ServerBrowserPage.type(page, { text: "hello", timeoutMs: 300 }).then(
        () => (outcome = "typed"),
        (error: unknown) => (outcome = error),
      );
      await vi.advanceTimersByTimeAsync(300);
      expect(outcome).toBe("typed");
      expect(typed).toEqual(["hello"]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("stops at its timeout without typing when the page never answers", async () => {
    vi.useFakeTimers();
    try {
      const typed: string[] = [];
      let outcome: unknown = "pending";
      const page = stalledPage(() => new Promise(() => {}), typed);
      void ServerBrowserPage.type(page, { text: "hello", timeoutMs: 300 }).then(
        () => (outcome = "typed"),
        (error: unknown) => (outcome = error),
      );
      await vi.advanceTimersByTimeAsync(300);
      expect(outcome).toMatchObject({
        tag: "PreviewAutomationTimeoutError",
        detail: { timeoutMs: 300 },
      });
      expect(typed).toEqual([]);

      // A target whose element is found but whose page then stops answering.
      const fill = vi.fn(async () => {});
      const hung = {
        locator: () => ({ evaluate: () => new Promise(() => {}), fill }),
        keyboard: { type: async (text: string) => void typed.push(text) },
      } as unknown as Page;
      void ServerBrowserPage.type(hung, {
        locator: "#field",
        text: "hello",
        clear: true,
        timeoutMs: 300,
      }).then(
        () => (outcome = "typed"),
        (error: unknown) => (outcome = error),
      );
      outcome = "pending";
      await vi.advanceTimersByTimeAsync(300);
      expect(outcome).toMatchObject({
        tag: "PreviewAutomationTimeoutError",
        detail: { timeoutMs: 300 },
      });
      expect(fill).not.toHaveBeenCalled();
      expect(typed).toEqual([]);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("server browser unresponsive script", () => {
  it("leaves a page that answers alone", async () => {
    const send = vi.fn(async (_method: string) => ({}));
    await ServerBrowserPage.stopUnresponsiveScript({ send } as unknown as CDPSession);
    expect(send.mock.calls.map(([method]) => method)).toEqual(["Runtime.evaluate"]);
  });
});

describe("server browser net errors", () => {
  it("ends at its timeout when a check never answers", async () => {
    // As on a desktop tab whose Playwright utility world never answers.
    const page = {
      locator: () => ({ count: () => new Promise<number>(() => {}) }),
    } as unknown as Page;
    vi.useFakeTimers();
    try {
      let failure: unknown;
      void ServerBrowserPage.waitFor(page, { selector: "button", timeoutMs: 300 }).catch(
        (error: unknown) => (failure = error),
      );
      await vi.advanceTimersByTimeAsync(300);
      expect(failure).toMatchObject({ tag: "PreviewAutomationTimeoutError" });
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    ["net::ERR_CONNECTION_REFUSED", "ERR_CONNECTION_REFUSED", -102],
    [
      "page.goto: net::ERR_HTTP2_PROTOCOL_ERROR at https://localhost:5173/",
      "ERR_HTTP2_PROTOCOL_ERROR",
      -2,
    ],
    ["net::ERR_TLS13_DOWNGRADE_DETECTED", "ERR_TLS13_DOWNGRADE_DETECTED", -2],
  ])("reads the whole error name from %j", (errorText, description, code) => {
    expect(ServerBrowserPage.parseNetError(errorText)).toEqual({ description, code });
  });
});

describe.skipIf(browserPath === null)("server browser saved logins", () => {
  let browser: Browser;
  let context: BrowserContext;

  beforeAll(async () => {
    browser = await chromium.launch({ executablePath: browserPath! });
    context = await browser.newContext({ viewport: { width: 640, height: 400 } });
  });
  afterAll(async () => {
    await browser.close();
  });

  const SECRET = "Synthetic secret 42";

  const snapshotOf = async (html: string) => {
    const page = await context.newPage();
    await page.setContent(html);
    return ServerBrowserPage.snapshot({
      page,
      cdp: await context.newCDPSession(page),
      renderScale: 1,
      consoleEntries: [],
      networkEntries: [],
      actionTimeline: [],
      secrets: [SECRET],
    });
  };

  it("refuses the screenshot while the value shows outside a password field", async () => {
    for (const shown of [
      `<input value="${SECRET}">`,
      `<p>${SECRET}</p>`,
      `<div title="${SECRET}"></div>`,
    ]) {
      const snapshot = await snapshotOf(shown);
      expect(snapshot.screenshot, shown).toBeUndefined();
      expect(snapshot.screenshotRefused).toBe("secret-visible");
    }
    const masked = await snapshotOf(`<input type="password" value="${SECRET}">`);
    expect(masked.screenshot).toBeDefined();
    expect(masked.screenshotRefused).toBeUndefined();
  });

  it("masks captured editable values protected by text security or a saved login", async () => {
    for (const style of ['style="-webkit-text-security: disc"', ""]) {
      const snapshot = await snapshotOf(
        `<div role="textbox" aria-label="Doc" contenteditable="true" ${style}>${SECRET}</div>`,
      );
      const line = String(snapshot.accessibilityTree)
        .split("\n")
        .find((entry) => entry.includes('textbox "Doc"'));
      expect(line).not.toContain(SECRET);
      expect(line).toContain("••••••••");
    }
  });

  it("types nothing through a field whose page navigated after the server's checks", async () => {
    const page = await context.newPage();
    await page.setContent(`<input type="password">`);
    const handle = (await page.$("input"))!;
    await page.goto(`data:text/html,<input type="password">`);
    expect(await ServerBrowserPage.typeLogin(handle, SECRET, ["null"])).toBe("stale");
    expect(await page.locator("input").inputValue()).toBe("");
  });
});
