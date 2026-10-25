import { EnvironmentId, ThreadId } from "@t3tools/contracts";
import { AsyncResult } from "effect/reactivity";
import { type ReactElement } from "react";
import { describe, expect, it, vi } from "vite-plus/test";

import { act, render } from "../../test/render";
import "../index.css";

import { filesystemEnvironment } from "../state/filesystem";
import { useRightPanelStore } from "../rightPanelStore";
import { setMarkdownTaskChecked } from "./files/filePreviewMode";

const { workspaceSearch, filesystemMetadata } = vi.hoisted(() => ({
  workspaceSearch: vi.fn(),
  filesystemMetadata: vi.fn(),
}));
vi.mock(import("../state/use-atom-query-runner"), async (original) => ({
  ...(await original()),
  useAtomQueryRunner: ((family: unknown) =>
    family === filesystemEnvironment.getMetadata ? filesystemMetadata : workspaceSearch) as never,
}));

// Atoms derived from the server config run in the real registry over a missing config.
vi.mock(import("../state/server"), async (original) => {
  const actual = await original();
  const { Atom } = await import("effect/reactivity");
  const noConfig = Atom.make(null);
  return {
    ...actual,
    serverEnvironment: { ...actual.serverEnvironment, configValueAtom: (() => noConfig) as never },
  };
});
vi.mock(import("../state/session"), async (original) => {
  const { AuthStandardClientScopes } = await import("@t3tools/contracts");
  const granted = new Set<string>(AuthStandardClientScopes);
  const hasScope = (environmentId: unknown, scope: string) =>
    environmentId !== null && granted.has(scope);
  return {
    ...(await original()),
    useEnvironmentScope: hasScope as never,
    readEnvironmentScope: hasScope as never,
  };
});
vi.mock(import("../remoteOpen"), async (original) => ({
  ...(await original()),
  useRemoteOpenResolution: () => ({ state: { mode: "local-exec" }, isResolved: true }) as never,
}));
const { renderDiagram } = vi.hoisted(() => ({
  renderDiagram: vi.fn<(source: string) => Promise<string> | undefined>(),
}));
// Control rendering latency without running Mermaid layout.
vi.mock(import("./chat/MermaidDiagram"), async (original) => {
  const { use } = await import("react");
  return {
    ...(await original()),
    MermaidDiagram: ({ source }: { source: string }) => {
      const pending = renderDiagram(source);
      return <svg role="img" aria-label={pending ? use(pending) : "Diagram"} />;
    },
  };
});

const settingsOverrides = vi.hoisted(() => ({ mathRenderingEnabled: false }));
vi.mock(import("../hooks/useSettings"), async (original) => {
  const actual = await original();
  type Settings = ReturnType<typeof actual.getClientSettings>;
  function useClientSettings<T = Settings>(select?: (settings: Settings) => T): T {
    const settings = { ...actual.getClientSettings(), ...settingsOverrides };
    return select ? select(settings) : (settings as T);
  }
  return { ...actual, useClientSettings };
});

import ChatMarkdown from "./ChatMarkdown";
import { chatMarkdownClipboardPayload, serializeTableElementToCsv } from "../markdown-clipboard";
import { captureAssistantTextSelection } from "../lib/assistantTextSelection";

function setup() {
  settingsOverrides.mathRenderingEnabled = false;
  renderDiagram.mockReset();
  workspaceSearch.mockReset().mockResolvedValue(AsyncResult.success({ entries: [] }));
  filesystemMetadata.mockReset().mockResolvedValue(AsyncResult.success({ entries: [null] }));
}

function renderText(text: string, props: Partial<Parameters<typeof ChatMarkdown>[0]> = {}) {
  return render(<ChatMarkdown cwd="/tmp/project" text={text} {...props} />);
}

function buttonsLabelled(container: HTMLElement, label: string) {
  return [...container.querySelectorAll<HTMLButtonElement>("button")].filter(
    (button) => button.getAttribute("aria-label") === label,
  );
}

describe("ChatMarkdown favicon privacy", () => {
  it("suppresses private link images while preserving public links across updates", async () => {
    setup();
    const markdown = (url: string) => <ChatMarkdown cwd="/tmp/project" text={`[Link](${url})`} />;
    await using screen = await render(markdown("https://example.com"));
    const { container, rerender } = screen;
    expect([...container.querySelectorAll("img")].map((image) => image.src)).toEqual([
      "https://www.google.com/s2/favicons?domain=example.com&sz=32",
    ]);
    for (const url of ["http://192.168.1.10:8080", "http://localhost:3000", "http://home.arpa"]) {
      await rerender(markdown(url));
      expect(container.querySelectorAll("img")).toHaveLength(0);
    }
    await rerender(markdown("https://example.com"));
    expect(container.querySelectorAll("img")).toHaveLength(1);
    await rerender(markdown("https://github.com/pingdotgg/t3code/pull/1"));
    expect(container.querySelectorAll("img")).toHaveLength(0);
    expect(container.querySelector("a svg")).not.toBeNull();
  });
});

describe("ChatMarkdown streaming", () => {
  it("runs only a complete single-line shell block after a click", async () => {
    setup();
    const onRunShellCommand = vi.fn();
    const message = (text: string, isStreaming = false) => (
      <ChatMarkdown
        cwd="/tmp/project"
        text={text}
        isStreaming={isStreaming}
        onRunShellCommand={onRunShellCommand}
      />
    );
    await using screen = await render(message("```bash\necho hello\n```", true));
    const { container, rerender } = screen;
    const runButtons = () => buttonsLabelled(container, "Run in terminal");
    expect(runButtons()).toHaveLength(0);

    await rerender(message("```bash\necho hello\n```"));
    await act(async () => runButtons()[0]!.click());
    expect(onRunShellCommand).toHaveBeenCalledExactlyOnceWith("echo hello");

    for (const text of [
      "~~~bash\necho tilde\n~~~",
      "> ```bash\n> echo quote\n> ```",
      "````bash\necho four\n````",
      "```text\nbws-save EXECUTOR_PAT\n```",
      "```\nbws-save EXECUTOR_PAT\n```",
      "- Command\n\n  ```bash\n  echo list\n  ```",
      "```bash\r\necho crlf\r\n```\r",
    ]) {
      await rerender(message(text));
      expect(runButtons()).toHaveLength(1);
    }

    for (const text of [
      "```bash\necho one\necho two\n```",
      "```typescript\necho hello\n```",
      "```bash\n\n```",
      "```bash\necho hello\n\n```",
      "```bash\necho hello\\\n```",
      "```bash\necho safe \u202e#\n```",
      "```bash\necho incomplete",
      "~~~bash\necho incomplete",
      "````bash\necho incomplete\n```",
      '<pre><code class="language-bash">echo html</code></pre>',
    ]) {
      await rerender(message(text));
      expect(runButtons()).toHaveLength(0);
    }
  });

  it("edits the current task text and marker after reusing a renderer", async () => {
    setup();
    let editedText: string | undefined;
    let rerender: (next: ReactElement) => Promise<void> = async () => {};
    const message = (text: string): ReactElement => (
      <ChatMarkdown
        cwd="/tmp/project"
        text={text}
        onTaskListChange={({ markerOffset, checked }) => {
          editedText = setMarkdownTaskChecked(text, markerOffset, checked);
          void rerender(message(editedText));
        }}
      />
    );
    await using rendered = await render(message("- [ ] First\n- [ ] Second"));
    rerender = rendered.rerender;
    const { container } = rendered;
    const checkboxes = () => container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]');
    const original = checkboxes()[1]!;
    await rerender(message("- [ ] A longer first task\n- [ ] Second"));
    expect(checkboxes()[1]).toBe(original);

    await act(async () => original.click());
    expect(editedText).toBe("- [ ] A longer first task\n- [x] Second");
    await vi.waitFor(() => expect(checkboxes()[1]!.checked).toBe(true));
  });

  it("edits a task marker in a later block of the message", async () => {
    let editedText: string | undefined;
    const text = "Intro paragraph.\n\n## Tasks\n\n- [ ] First\n- [ ] Second";
    const { container } = await render(
      <ChatMarkdown
        cwd="/tmp/project"
        text={text}
        onTaskListChange={({ markerOffset, checked }) => {
          editedText = setMarkdownTaskChecked(text, markerOffset, checked);
        }}
      />,
    );
    await act(async () =>
      container.querySelectorAll<HTMLInputElement>('input[type="checkbox"]')[1]!.click(),
    );
    expect(editedText).toBe("Intro paragraph.\n\n## Tasks\n\n- [ ] First\n- [x] Second");
  });

  it("fades in streamed words of the newest blocks only when asked", async () => {
    const text = "First paragraph.\n\nSecond paragraph.\n\nThird paragraph.";
    const wordsIn = (container: HTMLElement) =>
      [...container.querySelectorAll("p")].map(
        (paragraph) => paragraph.querySelectorAll(".chat-stream-word").length > 0,
      );
    const plain = await render(<ChatMarkdown cwd="/tmp/project" text={text} isStreaming />);
    expect(wordsIn(plain.container)).toEqual([false, false, false]);

    const revealed = await render(
      <ChatMarkdown cwd="/tmp/project" text={text} isStreaming revealWords />,
    );
    expect(wordsIn(revealed.container)).toEqual([false, true, true]);
    await revealed.rerender(<ChatMarkdown cwd="/tmp/project" text={text} revealWords />);
    expect(wordsIn(revealed.container)).toEqual([false, false, false]);
  });

  it("does not re-render finished blocks while a reply streams", async () => {
    const renderContextReference = vi.fn(({ label }: { label: string }) => <span>{label}</span>);
    const message = (text: string): ReactElement => (
      <ChatMarkdown
        cwd="/tmp/project"
        text={text}
        isStreaming
        renderContextReference={renderContextReference}
      />
    );
    const finished = "See [Terminal output](t3-context://v1/terminal/term-1).\n\n";
    const { container, rerender } = await render(message(`${finished}Streaming`));
    const renders = renderContextReference.mock.calls.length;
    expect(renders).toBeGreaterThan(0);

    for (const words of ["Streaming reply", "Streaming reply grows", "Streaming reply grows on"]) {
      await rerender(message(`${finished}${words}`));
    }

    expect(container.textContent).toContain("Streaming reply grows on");
    expect(renderContextReference).toHaveBeenCalledTimes(renders);
  });

  // Regression budget: rendering the whole message per token grows with the square of
  // the reply length; rendering only the changing block keeps it linear.
  it("replays a long streamed reply within a linear render budget", async () => {
    const sections = Array.from({ length: 8 }, (_, index) =>
      [
        `## Section ${index + 1}`,
        `Most of the time goes to [Terminal ${index}](t3-context://v1/terminal/term-${index}) and \`apps/web/src/components/ChatMarkdown.tsx\` while a reply streams, so long replies cost more than short ones.`,
        "- First point with **bold** text.\n- Second point with a [link](https://example.com).",
        "```ts\nexport const answer = 42;\n```",
      ].join("\n\n"),
    );
    const reply = sections.join("\n\n");
    const renderContextReference = vi.fn(({ label }: { label: string }) => <span>{label}</span>);
    const message = (text: string, isStreaming = true): ReactElement => (
      <ChatMarkdown
        cwd="/tmp/project"
        text={text}
        isStreaming={isStreaming}
        renderContextReference={renderContextReference}
      />
    );

    const { container, rerender } = await render(message(reply.slice(0, 24)));
    let updates = 1;
    for (let end = 48; end < reply.length; end += 24, updates += 1) {
      await rerender(message(reply.slice(0, end)));
    }
    await rerender(message(reply, false));

    expect(container.querySelectorAll("h2")).toHaveLength(sections.length);
    // Rendering only the block being written costs about 1.4 renders per update here;
    // re-rendering the whole message costs about 4.3, and grows with the reply.
    expect(renderContextReference.mock.calls.length).toBeLessThanOrEqual(updates * 2);
  });
});

describe("ChatMarkdown workspace file opens", () => {
  const threadRef = {
    environmentId: EnvironmentId.make("workspace"),
    threadId: ThreadId.make("thread"),
  };

  it("keeps a newer absolute file open when an earlier repo-relative lookup finishes", async () => {
    setup();
    const result = AsyncResult.success({
      entries: [{ path: "notes/a.md", kind: "file" }],
      truncated: false,
    });
    let resolvePending!: (value: typeof result) => void;
    const pending = new Promise<typeof result>((resolve) => {
      resolvePending = resolve;
    });
    workspaceSearch.mockReturnValueOnce(pending);
    using openFile = vi
      .spyOn(useRightPanelStore.getState(), "openFile")
      .mockImplementation(() => {});
    await using screen = await renderText(
      "[Notes](physics/notes/a.md) and [Other](/elsewhere/b.md:9)",
      {
        cwd: "/school/physics",
        threadRef,
      },
    );
    const { container } = screen;
    const [notes, other] = container.querySelectorAll("a");
    await act(async () => notes!.click());
    expect(workspaceSearch).toHaveBeenCalledOnce();
    expect(openFile).not.toHaveBeenCalled();

    await act(async () => other!.click());
    await act(async () => resolvePending(result));

    expect(openFile).toHaveBeenCalledExactlyOnceWith(threadRef, "/elsewhere/b.md", 9);
    expect(workspaceSearch).toHaveBeenCalledOnce();
  });
});

describe("ChatMarkdown headings", () => {
  it("never gives two headings the same id, even when a suffix matches another heading", async () => {
    setup();
    await using screen = await renderText(
      '## Setup\n\n## Setup\n\n## Setup-1\n\n<h2 id="install-1">Pinned</h2>\n\n## Install\n\n## Install',
      { parseRawHtml: true },
    );
    const { container } = screen;
    expect([...container.querySelectorAll("h2")].map((heading) => heading.id)).toEqual([
      "user-content-setup",
      "user-content-setup-1",
      "user-content-setup-1-1",
      "user-content-install-1",
      "user-content-install",
      "user-content-install-2",
    ]);
  });
});

describe("ChatMarkdown Windows file links", () => {
  const environmentId = EnvironmentId.make("env-windows");
  const renderWindows = (text: string, parseRawHtml: boolean) =>
    renderText(text, {
      cwd: "C:/Users/shawn/project",
      environmentId,
      lineBreaks: !parseRawHtml,
      parseRawHtml,
    });
  const fileHrefs = (container: HTMLElement) =>
    [...container.querySelectorAll(".chat-markdown-file-link")].map((chip) =>
      chip.getAttribute("href"),
    );

  it("still rejects unsafe schemes", async () => {
    setup();
    for (const parseRawHtml of [true, false]) {
      await using screen = await renderWindows(
        "[unsafe](javascript:alert(1)) and [unknown](d:alert(1))",
        parseRawHtml,
      );
      const { container } = screen;
      expect(container.innerHTML).not.toContain("javascript:");
      expect(container.innerHTML).not.toContain("d:alert");
      expect(fileHrefs(container)).toEqual([]);
    }
  });
});

describe("ChatMarkdown math", () => {
  it("renders table formulas and exports their TeX instead of duplicate glyph text", async () => {
    setup();
    settingsOverrides.mathRenderingEnabled = true;
    await using rendered = await render(
      <ChatMarkdown
        cwd="/tmp/project"
        text={
          "| Name | Formula |\n| --- | --- |\n| Norm | $|x|$ and \\(\\|y\\|\\) |\n| Price | $5 and $10 |"
        }
      />,
    );
    rendered.container.setAttribute("data-assistant-citation-source", "assistant");
    await act(async () => {
      await import("./chat/MathTypeset");
    });

    const table = rendered.container.querySelector("table")!;
    expect([...table.rows].map((row) => row.cells.length)).toEqual([2, 2, 2]);
    expect(table.querySelectorAll(".katex")).toHaveLength(2);
    const norm = table.querySelectorAll(".katex")[1]!;
    expect([...norm.querySelectorAll(".katex-mathml mi")].map((node) => node.textContent)).toEqual([
      "∥",
      "y",
      "∥",
    ]);
    expect(serializeTableElementToCsv(table)).toBe(
      "Name,Formula\nNorm,\\(|x|\\) and \\(\\|y\\|\\)\nPrice,$5 and $10",
    );
    const glyph = table.querySelector(".katex-mathml mi")!.firstChild!;
    const range = document.createRange();
    range.setStart(glyph, 0);
    range.setEnd(glyph, 1);
    const selection = window.getSelection()!;
    selection.removeAllRanges();
    selection.addRange(range);
    const payload = chatMarkdownClipboardPayload(selection)!;
    expect(payload.text).toBe("\\(|x|\\)");
    expect(payload.html).toContain("\\(|x|\\)");
    expect(payload.html).not.toContain("katex");
    expect(captureAssistantTextSelection(rendered.container, selection)?.selector.text).toBe(
      "\\(|x|\\)",
    );
  });
});
