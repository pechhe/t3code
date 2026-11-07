import type { PreviewAutomationSnapshot, PreviewTaskBinding } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  bindingSatisfied,
  describeElement,
  evaluateChecks,
  evidentAbsence,
  pageModelFromSnapshot,
  resolveTarget,
} from "./pageModel.ts";

// Lines as Playwright 1.60's `ariaSnapshot({ mode: "ai", boxes: true })` wrote them for filled fields.
const TREE = String.raw`- main [ref=e2] [box=8,8,1264,63]:
  - generic [ref=e3] [box=8,30,222,17]:
    - text: Plain
    - textbox "Plain" [ref=e4] [box=45,29,185,21]: Sentinel check can someone confirm
  - generic [ref=e5] [box=234,30,228,17]:
    - text: Colon
    - textbox "Colon" [ref=e6] [box=277,29,185,21]: "Sentinel check: can someone confirm \"it\""
  - generic [ref=e7] [box=466,30,264,17]:
    - text: "Note: today"
    - 'textbox "Note: today" [ref=e8] [box=545,29,185,21]': "it's: fine"
  - generic [ref=e9] [box=734,30,271,17]:
    - text: Reply to Ann
    - textbox "Reply to Ann" [ref=e10] [box=823,8,182,36]:
      - /placeholder: Reply to Ann. Sending joins you
      - text: "Sentinel check: reply"
  - generic [ref=e11] [box=1009,30,241,17]:
    - text: Number
    - textbox "Number" [ref=e12] [box=1066,29,185,21]: "42"
  - generic [ref=e13] [box=8,51,221,17]:
    - text: Lead
    - textbox "Lead" [ref=e14] [box=44,50,185,21]: "- dash #tag"
  - generic [ref=e17] [box=462,51,252,17]:
    - text: Empty ph
    - textbox "Empty ph" [ref=e18] [box=528,50,185,21]:
      - /placeholder: Type here`;

const snapshot = (tree: string): PreviewAutomationSnapshot => ({
  url: "http://site.test/",
  title: "Form",
  loading: false,
  visibleText: "",
  interactiveElements: [],
  accessibilityTree: tree,
  consoleEntries: [],
  networkEntries: [],
  actionTimeline: [],
  screenshot: { mimeType: "image/png", data: "", width: 1, height: 1 },
});

const model = pageModelFromSnapshot(snapshot(TREE));

const field = (name: string) => {
  const resolved = resolveTarget(model, { role: "textbox", name });
  if (resolved._tag !== "unique") throw new Error(`${name} is ${resolved._tag}`);
  return resolved.node;
};

const applied = (name: string, text: string) => {
  const binding: PreviewTaskBinding = {
    id: "b",
    control: "text",
    target: { role: "textbox", name },
    text,
  };
  return bindingSatisfied(model, binding, field(name));
};

const valueCheck = (name: string, value: string) =>
  evaluateChecks(model, [
    { id: "c", kind: "target", target: { role: "textbox", name }, expect: "present", value },
  ])[0]!.status;

describe("pageModelFromSnapshot", () => {
  it.each([
    ["Plain", "Sentinel check can someone confirm"],
    ["Colon", 'Sentinel check: can someone confirm "it"'],
    ["Note: today", "it's: fine"],
    ["Number", "42"],
    ["Lead", "- dash #tag"],
    ["Reply to Ann", "Sentinel check: reply"],
  ])("reads the value of %s as the field holds it", (name, text) => {
    expect(field(name).value).toBe(text);
    expect(applied(name, text)).toBe(true);
    expect(valueCheck(name, text)).toBe("passed");
  });

  it("still tells a different value apart", () => {
    expect(applied("Colon", "Sentinel check: can someone confirm")).toBe(false);
    expect(valueCheck("Reply to Ann", "Sentinel check")).toBe("failed");
  });

  it("reads an empty field with a placeholder as empty, not as its placeholder", () => {
    expect(field("Empty ph").value).toBeUndefined();
    expect(applied("Empty ph", "Type here")).toBe(false);
  });

  it("keeps a quoted name's colon and nests its children", () => {
    const note = field("Note: today");
    expect(note.ref).toBe("e8");
    expect(model.nodes[note.parent!]!.ref).toBe("e7");
  });

  it("names a control from its content when Playwright prints it without a name", () => {
    // Playwright 1.64 writes a button whose content holds a `time` this way.
    const desk = pageModelFromSnapshot(
      snapshot(String.raw`- list "Open cases" [ref=e4]:
  - listitem [ref=e5]:
    - button [ref=e11]:
      - text: HPHenry Petch
      - time [ref=e7]: 1m
      - text: YardSmithReply needed
  - listitem [ref=e8]:
    - button "Jo Petch 2d" [ref=e12]`),
    );
    const row = resolveTarget(desk, { role: "button", nameIncludes: "Henry Petch" });
    expect(row._tag).toBe("unique");
    if (row._tag === "unique") {
      expect(row.node.ref).toBe("e11");
      expect(row.node.name).toBe("HPHenry Petch 1m YardSmithReply needed");
    }
    // A listitem names nothing from its content, and a printed name is kept as written.
    expect(desk.nodes.find((node) => node.ref === "e5")!.name).toBe("");
    expect(desk.nodes.find((node) => node.ref === "e12")!.name).toBe("Jo Petch 2d");
  });

  it("keeps every complete line before a cut", () => {
    const cut = pageModelFromSnapshot(snapshot(TREE.slice(0, TREE.indexOf("it's: fine") + 3)));
    expect(cut.nodes.some((node) => node.name === "Colon" && node.ref === "e6")).toBe(true);
    expect(cut.nodes.some((node) => node.name === "Note: today")).toBe(false);
  });
});

describe("name fragments", () => {
  const rows = pageModelFromSnapshot(
    snapshot(String.raw`- list "Open cases" [ref=l]:
  - button "HPHenry  Petch  nowYardSmith" [ref=r1]
  - button "ABAnn Bell3dAcme" [ref=r2]`),
  );

  it.each([
    ["Henry Petch", "unique"],
    [" Henry   Petch ", "unique"],
    ["nowYardSmith", "unique"],
    ["henry petch", "missing"],
    ["d", "ambiguous"],
  ])("matches %j as %s: whitespace collapses, case matters, no word rule", (fragment, tag) => {
    expect(resolveTarget(rows, { role: "button", nameIncludes: fragment })._tag).toBe(tag);
  });

  it("reports what it matched only for a fragment, and lets absent pass only on no match", () => {
    const checks = evaluateChecks(rows, [
      {
        id: "frag",
        kind: "target",
        target: { role: "button", nameIncludes: "Ann" },
        expect: "present",
      },
      {
        id: "exact",
        kind: "target",
        target: { role: "list", name: "Open cases" },
        expect: "present",
      },
      {
        id: "gone",
        kind: "target",
        target: { role: "button", nameIncludes: "Zoe" },
        expect: "absent",
      },
      {
        id: "there",
        kind: "target",
        target: { role: "button", nameIncludes: "Acme" },
        expect: "absent",
      },
    ]);
    expect(checks).toEqual([
      { id: "frag", status: "passed", matchedName: "ABAnn Bell3dAcme" },
      { id: "exact", status: "passed" },
      { id: "gone", status: "passed" },
      {
        id: "there",
        status: "failed",
        detail: "The target is rendered.",
        matchedName: "ABAnn Bell3dAcme",
      },
    ]);
  });
});

// Shapes the live pages showed on 6 Nov 2026: an unnamed select, a clickable paragraph and
// a link name repeated across the header and the list.
const PAGES = String.raw`- banner [ref=e1] [box=0,0,1280,40]:
  - link "past" [ref=e2] [box=300,10,30,14]:
    - /url: front
- main [ref=e3] [box=0,40,1280,700]:
  - combobox [ref=e4] [box=8,60,200,20]:
    - option "Please select an option" [selected]
    - option "Option 1"
    - option "Option 2"
  - paragraph [ref=e5] [cursor=pointer] [box=600,500,40,16]: Close
  - paragraph [ref=e6] [box=8,700,400,16]: Closed for the day
  - link "past" [ref=e7] [box=8,720,30,14]:
    - /url: item?id=2`;

const pages = pageModelFromSnapshot({
  ...snapshot(PAGES),
  viewport: { width: 1280, height: 800 },
});

describe("targets without a unique name", () => {
  it("resolves a role alone only when the page has one element of it", () => {
    const combobox = resolveTarget(pages, { role: "combobox" });
    expect(combobox._tag === "unique" && combobox.node.ref).toBe("e4");
    expect(resolveTarget(pages, { role: "paragraph" })._tag).toBe("ambiguous");
    expect(
      evaluateChecks(pages, [
        {
          id: "picked",
          kind: "target",
          target: { role: "combobox" },
          expect: "present",
          value: "Please select an option",
        },
      ])[0]?.status,
    ).toBe("passed");
  });

  it("resolves visible text against an element's whole line, whitespace-normalised", () => {
    const close = resolveTarget(pages, { text: "  Close " });
    expect(close._tag === "unique" && close.node.ref).toBe("e5");
    expect(resolveTarget(pages, { text: "Clos" })._tag).toBe("missing");
    expect(resolveTarget(pages, { text: "past" })._tag).toBe("ambiguous");
  });

  it("describes each match by role, name or text and region, cut to 120 characters", () => {
    const matches = resolveTarget(pages, { role: "link", name: "past" });
    if (matches._tag !== "ambiguous") throw new Error(matches._tag);
    expect(matches.nodes.map((node) => describeElement(pages, node))).toEqual([
      'link "past" in banner',
      'link "past" in main',
    ]);
    const close = resolveTarget(pages, { text: "Close" });
    if (close._tag !== "unique") throw new Error(close._tag);
    const outside = pageModelFromSnapshot({
      ...snapshot(`- paragraph [ref=e1] [box=0,700,40,16]: ${"Close ".repeat(40)}`),
      viewport: { width: 1280, height: 800 },
    });
    const long = describeElement(outside, outside.nodes[0]!);
    expect(long.startsWith('paragraph showing "Close Close')).toBe(true);
    expect(long.length).toBeLessThanOrEqual(121);
    const banded = pageModelFromSnapshot({
      ...snapshot("- paragraph [ref=e1] [box=0,700,40,16]: Close"),
      viewport: { width: 1280, height: 800 },
    });
    expect(describeElement(banded, banded.nodes[0]!)).toBe(
      'paragraph showing "Close" at the bottom of the viewport',
    );
  });

  it("offers an exact name near a label an icon font prefixes", () => {
    // The live login page's button name begins with a Font Awesome glyph and a space.
    const iconPage = pageModelFromSnapshot(
      snapshot('- main [ref=e1]:\n  - button "\uF090 Login" [ref=e2]'),
    );
    expect(resolveTarget(iconPage, { role: "button", name: "Login" })._tag).toBe("missing");
    expect(evidentAbsence(iconPage, { role: "button", name: "Login" })).toEqual({
      nearest: ['button "\uF090 Login"'],
    });
    expect(evidentAbsence(iconPage, { role: "button", name: "Logout" })).toBeUndefined();
  });

  it("points an exact name at the page's only, unnamed element of its role", () => {
    expect(evidentAbsence(pages, { role: "combobox", name: "Country" })).toEqual({
      nearest: ["combobox (no name)"],
    });
    // A fragment, or a role with named elements, never stops a page whose list may still load.
    expect(evidentAbsence(pages, { role: "combobox", nameIncludes: "Country" })).toBeUndefined();
    expect(evidentAbsence(pages, { role: "link", name: "Target" })).toBeUndefined();
  });
});

describe("text checks", () => {
  it("match the page's text whatever case CSS renders it in", () => {
    const shown = pageModelFromSnapshot({
      ...snapshot('- heading "This is a modal window" [level=3] [ref=e1]'),
      visibleText: "THIS IS A MODAL WINDOW\nClose",
    });
    expect(
      evaluateChecks(shown, [
        { id: "gone", kind: "text", includes: "This is a modal window", expect: "absent" },
        { id: "shown", kind: "text", includes: "this is a modal window", expect: "present" },
      ]).map(({ status }) => status),
    ).toEqual(["failed", "passed"]);
  });
});
