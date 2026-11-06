import type { PreviewAutomationSnapshot, PreviewTaskBinding } from "@t3tools/contracts";
import { describe, expect, it } from "@effect/vitest";

import {
  bindingSatisfied,
  evaluateChecks,
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
