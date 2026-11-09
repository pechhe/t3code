import { describe, expect, it } from "@effect/vitest";

import { chooseRemoteProject } from "./remoteProjectChoice.ts";

const project = (id: string, title: string, workspaceRoot: string) => ({
  id,
  title,
  workspaceRoot,
});
const mac = [
  project("ys", "YardSmith", "/Users/h/Engineering/weave"),
  project("ps", "PropSmith", "/Users/h/Engineering/weave"),
  project("wv", "Weave", "/Users/h/Engineering/weave"),
];

describe("chooseRemoteProject", () => {
  it("takes the only match", () => {
    expect(chooseRemoteProject([mac[0]!], undefined)).toEqual({ _tag: "chosen", project: mac[0] });
  });

  it("reports no match", () => {
    expect(chooseRemoteProject([], { title: "Weave", workspaceRoot: "/x" })).toEqual({
      _tag: "none",
    });
  });

  it("prefers the project with the same title among several", () => {
    expect(chooseRemoteProject(mac, { title: " weave ", workspaceRoot: "/srv/weave" })).toEqual({
      _tag: "chosen",
      project: mac[2],
    });
  });

  it("falls back to the same folder name when titles differ", () => {
    const matches = [
      project("a", "Alpha", "/Users/h/code/app"),
      project("b", "Beta", "/Users/h/code/other"),
    ];
    expect(chooseRemoteProject(matches, { title: "Gamma", workspaceRoot: "/srv/app/" })).toEqual({
      _tag: "chosen",
      project: matches[0],
    });
  });

  it("leaves a real tie to the person", () => {
    expect(chooseRemoteProject(mac, { title: "Other", workspaceRoot: "/srv/weave" })).toEqual({
      _tag: "ambiguous",
      candidates: mac,
    });
    expect(chooseRemoteProject(mac, undefined)).toEqual({ _tag: "ambiguous", candidates: mac });
  });
});
