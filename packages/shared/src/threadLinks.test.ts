import { describe, expect, it } from "vite-plus/test";

import {
  formatThreadLink,
  parseThreadLink,
  parseThreadLinkHref,
  relabelThreadLinks,
} from "./threadLinks.ts";

describe("thread links", () => {
  it("takes the thread id verbatim, percent escapes included", () => {
    expect(parseThreadLinkHref("t3-thread://v1/mcp:1234")).toBe("mcp:1234");
    expect(parseThreadLinkHref("t3-thread://v1/thread:delegated-task:mcp%3A1")).toBe(
      "thread:delegated-task:mcp%3A1",
    );
  });

  it("rejects other links and an empty id", () => {
    expect(parseThreadLinkHref("https://t3.codes")).toBeNull();
    expect(parseThreadLinkHref("t3-thread://v1/")).toBeNull();
    expect(parseThreadLinkHref("t3-thread://v1/ ")).toBeNull();
  });

  it("reads the environment qualifier and still names the thread without it", () => {
    expect(parseThreadLink("t3-thread://v1/t1?environment=env-vps")).toEqual({
      threadId: "t1",
      environmentId: "env-vps",
    });
    expect(parseThreadLink("t3-thread://v1/t1")).toEqual({ threadId: "t1", environmentId: null });
    // An older client's view of a qualified link: the id alone.
    expect(parseThreadLinkHref("t3-thread://v1/t1?environment=env-vps")).toBe("t1");
    // Unrelated parameters are ignored; an unusable qualifier is not silently local.
    expect(parseThreadLink("t3-thread://v1/t1?x=1")).toEqual({
      threadId: "t1",
      environmentId: null,
    });
    expect(parseThreadLink("t3-thread://v1/t1?environment=")).toBeNull();
  });

  it("formats a qualified link that parses back to the same thread and environment", () => {
    const link = formatThreadLink("t1", "Fix [login]", "env:vps/1" as never);
    expect(link).toBe("[Fix login](t3-thread://v1/t1?environment=env%3Avps%2F1)");
    const href = /\((.+)\)/.exec(link)![1]!;
    expect(parseThreadLink(href)).toEqual({ threadId: "t1", environmentId: "env:vps/1" });
    expect(formatThreadLink("t1", "Plain")).toBe("[Plain](t3-thread://v1/t1)");
  });

  it("leaves a qualified link's label alone when relabeling, since titles are one environment's", () => {
    expect(relabelThreadLinks("[Kept](t3-thread://v1/t1?environment=env-vps)", () => "New")).toBe(
      "[Kept](t3-thread://v1/t1?environment=env-vps)",
    );
  });

  it("resolves a percent-encoded id when the id as written names no thread", () => {
    const titles = new Map([
      ["thread:project:1", "Decoded"],
      ["provider%3A1", "Literal escape"],
    ]);
    expect(
      relabelThreadLinks(
        "[a](t3-thread://v1/thread%3Aproject%3A1) [b](t3-thread://v1/provider%3A1)",
        (threadId) => titles.get(threadId),
      ),
    ).toBe(
      "[Decoded](t3-thread://v1/thread:project:1) [Literal escape](t3-thread://v1/provider%3A1)",
    );
    const untitled = new Map([
      ["a%3A1", ""],
      ["a:1", "Other"],
    ]);
    expect(
      relabelThreadLinks("[Kept](t3-thread://v1/a%3A1)", (threadId) => untitled.get(threadId)),
    ).toBe("[Kept](t3-thread://v1/a%3A1)");
  });

  it("leaves links inside code spans and fences as written", () => {
    const markdown = [
      "Live [old](t3-thread://v1/t1), literal `[old](t3-thread://v1/t1)`.",
      "```md",
      "[old](t3-thread://v1/t1)",
      "```",
      "After [old](t3-thread://v1/t1)",
    ].join("\n");
    expect(relabelThreadLinks(markdown, () => "New")).toBe(
      [
        "Live [New](t3-thread://v1/t1), literal `[old](t3-thread://v1/t1)`.",
        "```md",
        "[old](t3-thread://v1/t1)",
        "```",
        "After [New](t3-thread://v1/t1)",
      ].join("\n"),
    );
  });

  it("formats a label that would otherwise break the Markdown link", () => {
    expect(formatThreadLink("t1", "Fix [ci] \\ build")).toBe("[Fix ci build](t3-thread://v1/t1)");
    expect(formatThreadLink("t1", " ] ")).toBe("[t1](t3-thread://v1/t1)");
  });

  it("relabels links with the current title and leaves unknown threads alone", () => {
    const titles = new Map([["renamed", "Fix [the] build\nnow"]]);
    expect(
      relabelThreadLinks(
        "See [Old name](t3-thread://v1/renamed) and [Gone](t3-thread://v1/deleted).",
        (threadId) => titles.get(threadId),
      ),
    ).toBe("See [Fix the build now](t3-thread://v1/renamed) and [Gone](t3-thread://v1/deleted).");
  });
});
