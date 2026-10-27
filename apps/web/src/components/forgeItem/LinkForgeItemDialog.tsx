import { useAtomValue } from "@effect/atom-react";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import type { ScopedThreadRef } from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useEffect, useRef, useState } from "react";

import { appAtomRegistry } from "~/rpc/atomRegistry";
import { forgeWorkItems } from "~/state/forgeWorkItems";
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
 * Which thread has the Forge link dialog open. Set by the header, its thread menu or the
 * command palette, and rendered once by the chat view so it outlives a closing palette.
 */
const linkForgeItemDialogThreadAtom = Atom.make<ScopedThreadRef | null>(null).pipe(
  Atom.keepAlive,
  Atom.withLabel("build:link-dialog-thread"),
);

export function openLinkForgeItemDialog(threadRef: ScopedThreadRef): void {
  appAtomRegistry.set(linkForgeItemDialogThreadAtom, threadRef);
}

export function LinkForgeItemDialogHost() {
  const threadRef = useAtomValue(linkForgeItemDialogThreadAtom);
  if (threadRef === null) return null;
  return (
    <LinkForgeItemDialog
      threadRef={threadRef}
      onClose={() => appAtomRegistry.set(linkForgeItemDialogThreadAtom, null)}
    />
  );
}

function LinkForgeItemDialog(props: { threadRef: ScopedThreadRef; onClose: () => void }) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [reference, setReference] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [pending, setPending] = useState(false);
  const link = useAtomCommand(forgeWorkItems.link, { reportFailure: false });
  const { threadRef, onClose } = props;

  useEffect(() => {
    const frame = window.requestAnimationFrame(() => inputRef.current?.focus());
    return () => window.cancelAnimationFrame(frame);
  }, []);

  const submit = async () => {
    const trimmed = reference.trim();
    if (trimmed.length === 0) {
      setError("Paste a Forge URL or enter a ref such as YS-12 or YS-ARC-01 or #1000123.");
      return;
    }
    setError(null);
    setPending(true);
    // The server resolves the reference against T3's Weave and explains any refusal.
    const result = await link({
      environmentId: threadRef.environmentId,
      input: { threadId: threadRef.threadId, reference: trimmed },
    });
    setPending(false);
    if (result._tag === "Failure") {
      const failure = squashAtomCommandFailure(result);
      setError(failure instanceof Error ? failure.message : "Could not link the Forge item.");
      return;
    }
    onClose();
  };

  return (
    <Dialog open onOpenChange={(next) => (pending || next ? undefined : onClose())}>
      <DialogPopup className="max-w-xl">
        <DialogHeader>
          <DialogTitle>Link Forge item</DialogTitle>
          <DialogDescription>
            Show the Forge Spec, Ticket or Arc this thread works on, from Weave. Linking replaces
            any item already linked.
          </DialogDescription>
        </DialogHeader>
        <DialogPanel>
          <Input
            ref={inputRef}
            placeholder="Forge URL, YS-12, YS-ARC-01 or #1000123"
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
