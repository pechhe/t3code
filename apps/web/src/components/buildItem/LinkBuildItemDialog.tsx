import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useEffect, useRef, useState } from "react";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { buildWorkItems } from "~/state/buildWorkItems";
import { useAtomCommand } from "~/state/use-atom-command";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogPanel,
  DialogPopup,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";

/**
 * Which thread has the Build link dialog open. Set by the header, its thread menu or the
 * command palette, and rendered once by the chat view so it outlives a closing palette.
 */
const linkBuildItemDialogThreadAtom = Atom.make<ScopedThreadRef | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("build:link-dialog-thread"),
);

export function openLinkBuildItemDialog(threadRef: ScopedThreadRef): void {
  appAtomRegistry.set(linkBuildItemDialogThreadAtom, threadRef);
}

export function LinkBuildItemDialogHost() {
  const threadRef = useAtomValue(linkBuildItemDialogThreadAtom);
  if (threadRef === null) return null;
  return (
    <LinkBuildItemDialog
      threadRef={threadRef}
      onClose={() => appAtomRegistry.set(linkBuildItemDialogThreadAtom, null)}
    />
  );
}

function LinkBuildItemDialog(props: { threadRef: ScopedThreadRef; onClose: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [reference, setReference] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const link = useAtomCommand(buildWorkItems.link, { reportFailure: false });
  const { threadRef, onClose } = props;

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, []);

  const submit = async () => {
    const trimmed = reference.trim();
    if (trimmed.length === 0) {
      setError("Paste a Build URL or enter a ref such as YS-12 or #1000123.");
      return;
    }
    setError(null);
    setPending(true);
    // The server resolves the reference against T3's HQ and explains any refusal.
    const result = await link({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, reference: trimmed },
    });
    setPending(false);
    if (result._tag === "Failure") {
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : "Could not link the Build item.");
      return;
    }
    onClose();
  };

  return (
    <Dialog open onOpenChange={(next) => (pending || next ? undefined : onClose())}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Link Build item</DialogTitle>
          <DialogDescription>
            Show the Build Spec or Ticket this thread works on, from Weave. Linking replaces any
            item already linked.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <Input
            ref={inputRef}
            placeholder="Build URL, YS-12 or #1000123"
            value={reference}
            onChange={(event) => {
              setError(null);
              setReference(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key !== "Enter") return;
              event.preventDefault();
              void submit();
            }}
          />
          {error ? <p className="text-destructive text-xs">{error}</p> : null}
        </DialogPanel>
        <DialogFooter>
          <Button type="button" variant="outline" size="sm" onClick={onClose} disabled={pending}>
            Cancel
          </Button>
          <Button type="button" size="sm" onClick={() => void submit()} disabled={pending}>
            {pending ? "Linking..." : "Link"}
          </Button>
        </DialogFooter>
      </DialogPopup>
    </Dialog>
  );
}
