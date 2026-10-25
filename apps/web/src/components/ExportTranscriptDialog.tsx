import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type {
  OrchestrationV2ThreadTranscript,
  ScopedThreadRef,
  ThreadId,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import { Atom } from "effect/reactivity";
import { DownloadIcon } from "lucide-react";
import { useState } from "react";

import { useCopyToClipboard } from "~/hooks/useCopyToClipboard";
import { downloadMarkdownFile } from "~/lib/markdownExport";
import {
  buildTranscriptMarkdown,
  transcriptExportFilename,
  type TranscriptExportMeta,
} from "~/lib/threadTranscriptMarkdown";
import { appAtomRegistry } from "~/rpc/atomRegistry";
import { useProject, useThreadShell, useThreadShells } from "~/state/entities";
import { orchestrationEnvironment } from "~/state/orchestration";
import { useAtomCommand } from "~/state/use-atom-command";
import {
  collectTranscriptSections,
  describeExportFailure,
  transcriptExportItemCount,
} from "./ExportTranscriptDialog.logic";
import { Button } from "./ui/button";
import { Checkbox } from "./ui/checkbox";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "./ui/dialog";
import { Label } from "./ui/label";
import { stackedThreadToast, toastManager } from "./ui/toast";

/**
 * Which thread has the transcript export dialog open. Set by the sidebar, the thread menu
 * and the command palette, and rendered once by the app shell so it outlives a closing
 * palette and works on any route, not only a chat.
 */
const exportTranscriptDialogThreadAtom = Atom.make<ScopedThreadRef | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("transcript-export:dialog-thread"),
);

export function openExportTranscriptDialog(threadRef: ScopedThreadRef): void {
  appAtomRegistry.set(exportTranscriptDialogThreadAtom, threadRef);
}

export function ExportTranscriptDialogHost() {
  const threadRef = useAtomValue(exportTranscriptDialogThreadAtom);
  if (threadRef === null) return null;
  return (
    <ExportTranscriptDialog
      threadRef={threadRef}
      onClose={() => appAtomRegistry.set(exportTranscriptDialogThreadAtom, null)}
    />
  );
}

function formatTimestamp(iso: string): string {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return iso;
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

function ExportTranscriptDialog(props: { threadRef: ScopedThreadRef; onClose: () => void }) {
  const { threadRef, onClose } = props;
  const shell = useThreadShell(threadRef);
  const project = useProject(
    shell === null ? null : { environmentId: threadRef.environmentId, projectId: shell.projectId },
  );
  const shells = useThreadShells();
  const [includeSubagents, setIncludeSubagents] = useState(true);
  const [includeReasoning, setIncludeReasoning] = useState(false);
  const [includeToolOutput, setIncludeToolOutput] = useState(false);
  const [pending, setPending] = useState<"download" | "copy" | null>(null);
  const loadTranscript = useAtomCommand(orchestrationEnvironment.threadTranscript, {
    reportFailure: false,
  });
  const { copyToClipboard } = useCopyToClipboard<void>({
    target: "transcript",
    onCopy: () => toastManager.add({ type: "success", title: "Transcript copied" }),
    onError: (error) => reportFailure("Could not copy the transcript", error),
  });

  const itemCount = transcriptExportItemCount(shells, threadRef, includeSubagents);

  const buildDocument = async (): Promise<{ markdown: string; title: string } | null> => {
    const load = async (
      environmentId: ScopedThreadRef["environmentId"],
      threadId: ThreadId,
    ): Promise<OrchestrationV2ThreadTranscript> => {
      const result = await loadTranscript({ environmentId, input: { threadId } });
      if (result._tag === "Failure") throw squashAtomCommandFailure(result);
      return result.value;
    };

    const sections = await collectTranscriptSections({
      root: threadRef,
      includeSubagents,
      load,
      describeFailure: describeExportFailure,
    });
    const { main, subagents, missing } = sections;
    const now = new Date();
    const options = shell?.modelSelection.options ?? [];
    const modelOptions = options.map((option) => `${option.id}: ${option.value}`).join(", ");
    const meta: TranscriptExportMeta[] = [
      { label: "Thread", value: main.transcript.title },
      { label: "Thread ID", value: `${threadRef.environmentId}:${threadRef.threadId}` },
      ...(project === null ? [] : [{ label: "Project", value: project.title }]),
      ...(shell?.branch == null ? [] : [{ label: "Branch", value: shell.branch }]),
      ...(shell?.worktreePath == null ? [] : [{ label: "Workspace", value: shell.worktreePath }]),
      ...(shell === null
        ? []
        : [
            {
              label: "Provider",
              value: [
                shell.providerInstanceId,
                shell.modelSelection.model,
                modelOptions.length === 0 ? null : `(${modelOptions})`,
              ]
                .filter((part) => part !== null)
                .join(" "),
            },
          ]),
      ...(shell === null ? [] : [{ label: "Started", value: formatTimestamp(shell.createdAt) }]),
      {
        label: "Conversation updated",
        value: formatTimestamp(DateTime.formatIso(main.transcript.updatedAt)),
      },
      { label: "Exported", value: formatTimestamp(now.toISOString()) },
      {
        label: "Contents",
        value: [
          `${1 + subagents.length} thread${subagents.length === 0 ? "" : "s"}`,
          includeReasoning ? "reasoning included" : "reasoning hidden",
          includeToolOutput ? "tool output full" : "tool output condensed",
        ].join(" · "),
      },
    ];

    return {
      title: main.transcript.title,
      markdown: buildTranscriptMarkdown({
        meta,
        main,
        subagents,
        options: { includeReasoning, includeToolOutput },
        ...(missing.length === 0 ? {} : { missing }),
      }),
    };
  };

  const run = async (mode: "download" | "copy") => {
    setPending(mode);
    const document = await buildDocument().catch((error: unknown) => {
      reportFailure("Could not export the transcript", error);
      return null;
    });
    if (document === null) {
      setPending(null);
      return;
    }
    if (mode === "download") {
      const filename = transcriptExportFilename(document.title, new Date());
      downloadMarkdownFile(filename, document.markdown);
      toastManager.add({ type: "success", title: "Transcript saved", description: filename });
    } else {
      copyToClipboard(document.markdown, undefined);
    }
    setPending(null);
    onClose();
  };

  return (
    <Dialog open onOpenChange={(next) => (pending !== null || next ? undefined : onClose())}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Export transcript</DialogTitle>
          <DialogDescription>
            {`${shell?.title ?? "This thread"} · about ${itemCount} items across the whole history. Nothing leaves this machine.`}
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <div className="space-y-3">
            <OptionRow
              checked={includeSubagents}
              disabled={pending !== null}
              label="Include sub-agent threads"
              description="Appends the threads this one started, each with its own brief."
              onCheckedChange={setIncludeSubagents}
            />
            <OptionRow
              checked={includeReasoning}
              disabled={pending !== null}
              label="Include reasoning and thinking"
              description="Off keeps the reviewer on what was said and done."
              onCheckedChange={setIncludeReasoning}
            />
            <OptionRow
              checked={includeToolOutput}
              disabled={pending !== null}
              label="Include full tool output"
              description="Off writes each command with its exit code and the first line of its output."
              onCheckedChange={setIncludeToolOutput}
            />
          </div>
        </DialogPanel>
        <DialogFooter>
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={pending !== null}
            onClick={() => void run("copy")}
          >
            {pending === "copy" ? "Copying..." : "Copy Markdown"}
          </Button>
          <Button
            type="button"
            size="sm"
            disabled={pending !== null}
            onClick={() => void run("download")}
          >
            <DownloadIcon className="size-3.5" />
            {pending === "download" ? "Saving..." : "Save .md"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}

function OptionRow(props: {
  readonly checked: boolean;
  readonly disabled: boolean;
  readonly label: string;
  readonly description: string;
  readonly onCheckedChange: (next: boolean) => void;
}) {
  return (
    <div className="flex items-start gap-2.5">
      <Checkbox
        id={`export-transcript-${props.label}`}
        className="mt-0.5"
        checked={props.checked}
        disabled={props.disabled}
        onCheckedChange={(checked) => props.onCheckedChange(checked)}
      />
      <div className="space-y-0.5">
        <Label htmlFor={`export-transcript-${props.label}`}>{props.label}</Label>
        <p className="text-muted-foreground text-xs">{props.description}</p>
      </div>
    </div>
  );
}

function reportFailure(title: string, error: unknown): void {
  toastManager.add(
    stackedThreadToast({
      type: "error",
      title,
      description: describeExportFailure(error),
    }),
  );
}
