import type { ComposerHandleRef } from "../../composerHandleContext";
import type { ChatComposerHandle } from "./ChatComposer";
import type { ChatShortcutCommands } from "./useChatShortcuts";

const openControl =
  (composerRef: ComposerHandleRef, control: Parameters<ChatComposerHandle["openControl"]>[0]) =>
  ({ event }: { readonly event: KeyboardEvent }) => {
    if (!event.repeat) composerRef.current?.openControl(control);
  };

const selectModelSlot =
  (composerRef: ComposerHandleRef, index: number) =>
  ({ event }: { readonly event: KeyboardEvent }) => {
    if (!event.repeat) composerRef.current?.selectModelSlot(index);
  };

/** Chords that open or step the composer's controls. Held keys do not repeat the pickers. */
export function composerShortcutCommands(composerRef: ComposerHandleRef): ChatShortcutCommands {
  const toggleModelPicker = ({ event }: { readonly event: KeyboardEvent }) => {
    if (!event.repeat) composerRef.current?.toggleModelPicker();
  };
  return {
    "modelPicker.toggle": toggleModelPicker,
    "composer.effort": openControl(composerRef, "composer.effort"),
    "composer.mode": openControl(composerRef, "composer.mode"),
    "composer.modelSlot.1": selectModelSlot(composerRef, 0),
    "composer.modelSlot.2": selectModelSlot(composerRef, 1),
    "composer.modelSlot.3": selectModelSlot(composerRef, 2),
    // The slider holds three models; its fourth stop opens the full picker.
    "composer.modelSlot.4": toggleModelPicker,
    // A held key keeps turning the dial.
    "composer.effortUp": () => composerRef.current?.stepEffort(1),
    "composer.effortDown": () => composerRef.current?.stepEffort(-1),
  } satisfies ChatShortcutCommands;
}
