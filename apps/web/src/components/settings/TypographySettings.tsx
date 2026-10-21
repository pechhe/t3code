import { QueueSound, SendSound, SettleSound } from "@t3tools/contracts/settings";
import { COMPOSER_FINISHES, resolveComposerFinish } from "~/lib/composerFinish";
import { previewQueueSound, previewSendSound, previewSettleSound } from "~/lib/interfaceSounds";
import type { ReactNode } from "react";
import { useEffect, useEffectEvent, useRef, useState } from "react";
import {
  DEFAULT_UNIFIED_SETTINGS,
  MAX_CODE_FONT_SIZE,
  MAX_INTERFACE_FONT_SIZE,
  MAX_PROMPT_FONT_SIZE,
  MAX_TERMINAL_FONT_SIZE,
  MIN_CODE_FONT_SIZE,
  MIN_INTERFACE_FONT_SIZE,
  MIN_PROMPT_FONT_SIZE,
  MIN_TERMINAL_FONT_SIZE,
} from "@t3tools/contracts/settings";
import * as Schema from "effect/Schema";
import { useLocalStorage } from "../../hooks/useLocalStorage";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";
import { isMacPlatform } from "../../lib/utils";
import { Input } from "../ui/input";
import {
  DEFAULT_CODE_FONT_STACK,
  DEFAULT_SANS_FONT_STACK,
  isFontFamilyAvailable,
  isMonospaceFamily,
  resolveDefaultFamilyLabel,
  resolveTerminalFontPreference,
  resolveTerminalFontSizePreference,
  TYPOGRAPHY_ADVANCED_STORAGE_KEY,
} from "../../appearanceFonts";
import { CodeFontPreview, PromptFontPreview, TerminalFontPreview } from "./SettingsFontPreviews";
import { discoverInstalledFonts, FontFamilyPicker, useFontEnumeration } from "./FontFamilyPicker";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Switch } from "../ui/switch";
import {
  SettingResetButton,
  SettingsRow,
  SettingsSection,
  useSettingsSearchTargetId,
  useInSettingsSearchResults,
} from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";

function useFontDefaultFamilies() {
  const settings = useScopedSettings();
  const [defaults] = useState(() => ({
    sans: resolveDefaultFamilyLabel(DEFAULT_SANS_FONT_STACK) ?? "System default",
    code: resolveDefaultFamilyLabel(DEFAULT_CODE_FONT_STACK) ?? "System monospace",
  }));
  return {
    sans: defaults.sans,
    code: defaults.code,
    interfaceFamily: settings.fontFamilySans.trim() || defaults.sans,
  };
}

function InterfaceFontRow({ preview }: { preview?: ReactNode }) {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const defaults = useFontDefaultFamilies();
  return (
    <FontFamilySettingsRow
      {...searchableSetting("interface-font")}
      description="Menus, labels, your messages, and everything else outside agent responses and code."
      defaultFamily={defaults.sans}
      defaultValue={DEFAULT_UNIFIED_SETTINGS.fontFamilySans}
      value={settings.fontFamilySans}
      onValueChange={(fontFamilySans) => updateSettings({ fontFamilySans })}
      onReset={() =>
        updateSettings({
          fontFamilySans: DEFAULT_UNIFIED_SETTINGS.fontFamilySans,
          fontSizeInterface: DEFAULT_UNIFIED_SETTINGS.fontSizeInterface,
        })
      }
      size={{
        label: "Interface font size",
        min: MIN_INTERFACE_FONT_SIZE,
        max: MAX_INTERFACE_FONT_SIZE,
        value: settings.fontSizeInterface,
        defaultValue: DEFAULT_UNIFIED_SETTINGS.fontSizeInterface,
        onChange: (fontSizeInterface) => updateSettings({ fontSizeInterface }),
      }}
      {...(preview !== undefined ? { preview } : {})}
    />
  );
}

function ResponseFontRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const defaults = useFontDefaultFamilies();
  // Sized with the interface; only the family is separate.
  return (
    <FontFamilySettingsRow
      {...searchableSetting("response-font")}
      description="What agents write: replies, plans, and reasoning."
      defaultFamily={defaults.sans}
      defaultValue={DEFAULT_UNIFIED_SETTINGS.fontFamilyResponse}
      value={settings.fontFamilyResponse}
      onValueChange={(fontFamilyResponse) => updateSettings({ fontFamilyResponse })}
      onReset={() =>
        updateSettings({ fontFamilyResponse: DEFAULT_UNIFIED_SETTINGS.fontFamilyResponse })
      }
    />
  );
}

function PromptFontRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const defaults = useFontDefaultFamilies();
  return (
    <FontFamilySettingsRow
      {...searchableSetting("prompt-font")}
      description="Only the box you write prompts in. Mono works well here."
      defaultFamily={defaults.interfaceFamily}
      defaultValue={DEFAULT_UNIFIED_SETTINGS.fontFamilyComposer}
      value={settings.fontFamilyComposer}
      onValueChange={(fontFamilyComposer) => updateSettings({ fontFamilyComposer })}
      onReset={() =>
        updateSettings({
          fontFamilyComposer: DEFAULT_UNIFIED_SETTINGS.fontFamilyComposer,
          fontSizePrompt: DEFAULT_UNIFIED_SETTINGS.fontSizePrompt,
        })
      }
      size={{
        label: "Prompt font size",
        min: MIN_PROMPT_FONT_SIZE,
        max: MAX_PROMPT_FONT_SIZE,
        value: settings.fontSizePrompt,
        defaultValue: DEFAULT_UNIFIED_SETTINGS.fontSizePrompt,
        onChange: (fontSizePrompt) => updateSettings({ fontSizePrompt }),
      }}
      preview={<PromptFontPreview />}
    />
  );
}

function CodeFontRow({
  title,
  description = "Code blocks, diffs, and file previews.",
  preview,
}: {
  title?: string;
  description?: string;
  preview?: ReactNode;
}) {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const defaults = useFontDefaultFamilies();
  return (
    <FontFamilySettingsRow
      {...searchableSetting("code-font")}
      {...(title !== undefined ? { title } : {})}
      description={description}
      defaultFamily={defaults.code}
      defaultValue={DEFAULT_UNIFIED_SETTINGS.fontFamilyCode}
      value={settings.fontFamilyCode}
      onValueChange={(fontFamilyCode) => updateSettings({ fontFamilyCode })}
      onReset={() =>
        updateSettings({
          fontFamilyCode: DEFAULT_UNIFIED_SETTINGS.fontFamilyCode,
          fontSizeCode: DEFAULT_UNIFIED_SETTINGS.fontSizeCode,
        })
      }
      requireMonospace
      size={{
        label: "Code font size",
        min: MIN_CODE_FONT_SIZE,
        max: MAX_CODE_FONT_SIZE,
        value: settings.fontSizeCode,
        defaultValue: DEFAULT_UNIFIED_SETTINGS.fontSizeCode,
        onChange: (fontSizeCode) => updateSettings({ fontSizeCode }),
      }}
      preview={preview ?? <CodeFontPreview />}
    />
  );
}

function TerminalFontRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const defaults = useFontDefaultFamilies();
  return (
    <FontFamilySettingsRow
      {...searchableSetting("terminal-font")}
      description="Terminal output, independent from code blocks and diffs."
      defaultFamily={defaults.code}
      defaultValue={DEFAULT_UNIFIED_SETTINGS.fontFamilyTerminal}
      value={settings.fontFamilyTerminal}
      onValueChange={(fontFamilyTerminal) => updateSettings({ fontFamilyTerminal })}
      onReset={() =>
        updateSettings({
          fontFamilyTerminal: DEFAULT_UNIFIED_SETTINGS.fontFamilyTerminal,
          fontSizeTerminal: DEFAULT_UNIFIED_SETTINGS.fontSizeTerminal,
        })
      }
      requireMonospace
      size={{
        label: "Terminal font size",
        min: MIN_TERMINAL_FONT_SIZE,
        max: MAX_TERMINAL_FONT_SIZE,
        value: settings.fontSizeTerminal,
        defaultValue: DEFAULT_UNIFIED_SETTINGS.fontSizeTerminal,
        onChange: (fontSizeTerminal) => updateSettings({ fontSizeTerminal }),
      }}
      preview={
        <TerminalFontPreview
          family={resolveTerminalFontPreference({
            advanced: true,
            code: settings.fontFamilyCode,
            terminal: settings.fontFamilyTerminal,
          })}
          size={settings.fontSizeTerminal}
        />
      }
    />
  );
}

function FontSmoothingRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  if (!isMacPlatform(navigator.platform)) return null;
  return (
    <SettingsRow
      {...searchableSetting("font-smoothing")}
      description="Use thinner grayscale text smoothing instead of the macOS default."
      resetAction={
        settings.fontSmoothing !== DEFAULT_UNIFIED_SETTINGS.fontSmoothing ? (
          <SettingResetButton
            label="font smoothing"
            onClick={() =>
              updateSettings({ fontSmoothing: DEFAULT_UNIFIED_SETTINGS.fontSmoothing })
            }
          />
        ) : null
      }
      control={
        <Switch
          checked={settings.fontSmoothing}
          onCheckedChange={(checked) => updateSettings({ fontSmoothing: Boolean(checked) })}
          aria-label="Font smoothing"
        />
      }
    />
  );
}

function WordWrapRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      {...searchableSetting("word-wrap")}
      description="Wrap long lines in code blocks, tables, diffs, and file previews by default."
      resetAction={
        settings.wordWrap !== DEFAULT_UNIFIED_SETTINGS.wordWrap ? (
          <SettingResetButton
            label="word wrapping"
            onClick={() => updateSettings({ wordWrap: DEFAULT_UNIFIED_SETTINGS.wordWrap })}
          />
        ) : null
      }
      control={
        <Switch
          checked={settings.wordWrap}
          onCheckedChange={(checked) => updateSettings({ wordWrap: Boolean(checked) })}
          aria-label="Wrap code, tables, diffs, and file previews by default"
        />
      }
    />
  );
}

function InterfaceSoundsRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      {...searchableSetting("interface-sounds")}
      description="Play a click when you press the composer's controls and a tick as you pass sidebar items."
      resetAction={
        settings.interfaceSounds !== DEFAULT_UNIFIED_SETTINGS.interfaceSounds ? (
          <SettingResetButton
            label="interface sounds"
            onClick={() =>
              updateSettings({ interfaceSounds: DEFAULT_UNIFIED_SETTINGS.interfaceSounds })
            }
          />
        ) : null
      }
      control={
        <Switch
          checked={settings.interfaceSounds}
          onCheckedChange={(checked) => updateSettings({ interfaceSounds: Boolean(checked) })}
          aria-label="Interface sounds"
        />
      }
    />
  );
}

const SEND_SOUNDS = SendSound.literals;
const QUEUE_SOUNDS = QueueSound.literals;

const SEND_SOUND_LABELS = {
  press: "Press",
  air: "Air release",
  tube: "Pneumatic tube",
  bell: "Struck bell",
} as const satisfies Record<SendSound, string>;

function SendSoundRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  if (!settings.interfaceSounds) return null;
  return (
    <SettingsRow
      {...searchableSetting("send-sound")}
      description="What the send dial sounds like when a message goes straight to the agent. Press is the dial's own click; the others play instead of it."
      resetAction={
        settings.sendSound !== DEFAULT_UNIFIED_SETTINGS.sendSound ? (
          <SettingResetButton
            label="send sound"
            onClick={() => updateSettings({ sendSound: DEFAULT_UNIFIED_SETTINGS.sendSound })}
          />
        ) : null
      }
      control={
        <Select
          value={settings.sendSound}
          onValueChange={(value) => {
            const sound = SEND_SOUNDS.find((candidate) => candidate === value);
            if (!sound) return;
            updateSettings({ sendSound: sound });
            previewSendSound(sound);
          }}
        >
          <SelectTrigger size="sm" className="w-full sm:w-40" aria-label="Send sound">
            <SelectValue>{SEND_SOUND_LABELS[settings.sendSound]}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {SEND_SOUNDS.map((sound) => (
              <SelectItem key={sound} hideIndicator value={sound}>
                {SEND_SOUND_LABELS[sound]}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}

const QUEUE_SOUND_LABELS = {
  latch: "Latch",
  drop: "Drop in slot",
} as const satisfies Record<QueueSound, string>;

function QueueSoundRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  if (!settings.interfaceSounds) return null;
  return (
    <SettingsRow
      {...searchableSetting("queue-sound")}
      description="What the send dial plays, in place of its click, when the agent is busy and your message waits in the queue."
      resetAction={
        settings.queueSound !== DEFAULT_UNIFIED_SETTINGS.queueSound ? (
          <SettingResetButton
            label="queue sound"
            onClick={() => updateSettings({ queueSound: DEFAULT_UNIFIED_SETTINGS.queueSound })}
          />
        ) : null
      }
      control={
        <Select
          value={settings.queueSound}
          onValueChange={(value) => {
            const sound = QUEUE_SOUNDS.find((candidate) => candidate === value);
            if (!sound) return;
            updateSettings({ queueSound: sound });
            previewQueueSound(sound);
          }}
        >
          <SelectTrigger size="sm" className="w-full sm:w-40" aria-label="Queue sound">
            <SelectValue>{QUEUE_SOUND_LABELS[settings.queueSound]}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {QUEUE_SOUNDS.map((sound) => (
              <SelectItem key={sound} hideIndicator value={sound}>
                {QUEUE_SOUND_LABELS[sound]}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}

const SETTLE_SOUNDS = SettleSound.literals;

const SETTLE_SOUND_LABELS = {
  off: "Off",
  seat: "Seat",
  tick: "Tick (key down, key up)",
  press: "Press (machined)",
  pair: "Pair (rising clicks)",
  soft: "Soft (airy)",
  detent: "Detent (rotary)",
  whoosh: "Metal whoosh",
  filed: "Filed",
  stamp: "Stamp",
  resolve: "Resolve",
  switch: "Heavy switch",
  tap: "Glass tap",
} as const satisfies Record<SettleSound, string>;

function SettleSoundRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  if (!settings.interfaceSounds) return null;
  return (
    <SettingsRow
      {...searchableSetting("settle-sound")}
      description="What plays when you settle a thread, from the sidebar, a shortcut or the thread menu."
      resetAction={
        settings.settleSound !== DEFAULT_UNIFIED_SETTINGS.settleSound ? (
          <SettingResetButton
            label="settle sound"
            onClick={() => updateSettings({ settleSound: DEFAULT_UNIFIED_SETTINGS.settleSound })}
          />
        ) : null
      }
      control={
        <Select
          value={settings.settleSound}
          onValueChange={(value) => {
            const sound = SETTLE_SOUNDS.find((candidate) => candidate === value);
            if (!sound) return;
            updateSettings({ settleSound: sound });
            previewSettleSound(sound);
          }}
        >
          <SelectTrigger size="sm" className="w-full sm:w-40" aria-label="Settle sound">
            <SelectValue>{SETTLE_SOUND_LABELS[settings.settleSound]}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {SETTLE_SOUNDS.map((sound) => (
              <SelectItem key={sound} hideIndicator value={sound}>
                {SETTLE_SOUND_LABELS[sound]}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}

const SEND_MOTION_LABELS = { lift: "Lift", vacuum: "Vacuum", off: "Off" } as const;

function SendMotionRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  return (
    <SettingsRow
      {...searchableSetting("send-motion")}
      description="Lift flies your message from the composer into the thread; Vacuum pulls it out of the composer. Off when your system asks for reduced motion."
      resetAction={
        settings.sendMotion !== DEFAULT_UNIFIED_SETTINGS.sendMotion ? (
          <SettingResetButton
            label="send motion"
            onClick={() => updateSettings({ sendMotion: DEFAULT_UNIFIED_SETTINGS.sendMotion })}
          />
        ) : null
      }
      control={
        <Select
          value={settings.sendMotion}
          onValueChange={(value) => {
            if (value === "lift" || value === "vacuum" || value === "off") {
              updateSettings({ sendMotion: value });
            }
          }}
        >
          <SelectTrigger size="sm" className="w-full sm:w-40" aria-label="Send motion">
            <SelectValue>{SEND_MOTION_LABELS[settings.sendMotion]}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {(["lift", "vacuum", "off"] as const).map((motion) => (
              <SelectItem key={motion} hideIndicator value={motion}>
                {SEND_MOTION_LABELS[motion]}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}

function ComposerFinishRow() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const finish = resolveComposerFinish(settings.composerFinish);
  return (
    <SettingsRow
      {...searchableSetting("composer-finish")}
      description="The composer's metal and screen, chosen apart from the app theme."
      resetAction={
        settings.composerFinish !== DEFAULT_UNIFIED_SETTINGS.composerFinish ? (
          <SettingResetButton
            label="composer finish"
            onClick={() =>
              updateSettings({ composerFinish: DEFAULT_UNIFIED_SETTINGS.composerFinish })
            }
          />
        ) : null
      }
      control={
        <Select
          value={finish.id}
          onValueChange={(value) => {
            if (typeof value === "string") updateSettings({ composerFinish: value });
          }}
        >
          <SelectTrigger size="sm" className="w-full sm:w-40" aria-label="Composer finish">
            <SelectValue>{finish.label}</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {COMPOSER_FINISHES.map((option) => (
              <SelectItem hideIndicator key={option.id} value={option.id}>
                {option.label}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
      }
    />
  );
}

function FontSettingsGroup() {
  return (
    <>
      <InterfaceFontRow />
      <ResponseFontRow />
      <PromptFontRow />
      <CodeFontRow />
      <TerminalFontRow />
      <FontSmoothingRow />
    </>
  );
}

function SimpleFontRows() {
  const settings = useScopedSettings();
  return (
    <>
      <InterfaceFontRow preview={<PromptFontPreview />} />
      <ResponseFontRow />
      <CodeFontRow
        title="Monospace font"
        description="Code blocks, diffs, file previews, and the terminal."
        preview={
          <>
            <CodeFontPreview />
            <TerminalFontPreview
              family={resolveTerminalFontPreference({
                advanced: false,
                code: settings.fontFamilyCode,
                terminal: settings.fontFamilyTerminal,
              })}
              size={resolveTerminalFontSizePreference({
                advanced: false,
                code: settings.fontSizeCode,
                terminal: settings.fontSizeTerminal,
              })}
            />
          </>
        }
      />
    </>
  );
}

// Font smoothing only renders on macOS, so a search jump to it elsewhere
// must not flip the section - the target would never mount to be scrolled to.
const ADVANCED_TYPOGRAPHY_TARGET_IDS: ReadonlySet<string> = new Set([
  "prompt-font",
  "terminal-font",
  ...(typeof navigator !== "undefined" && isMacPlatform(navigator.platform)
    ? ["font-smoothing"]
    : []),
]);

export function TypographySection() {
  const [advanced, setAdvanced] = useLocalStorage(
    TYPOGRAPHY_ADVANCED_STORAGE_KEY,
    false,
    Schema.Boolean,
  );
  const inSearchResults = useInSettingsSearchResults();
  const searchTargetId = useSettingsSearchTargetId();
  const lastExpandedTargetRef = useRef<string | null>(null);
  useEffect(() => {
    if (searchTargetId === null || !ADVANCED_TYPOGRAPHY_TARGET_IDS.has(searchTargetId)) return;
    if (lastExpandedTargetRef.current === searchTargetId) return;
    lastExpandedTargetRef.current = searchTargetId;
    setAdvanced(true);
  }, [searchTargetId, setAdvanced]);
  return (
    <SettingsSection
      id="typography"
      title="Typography"
      headerAction={
        <label className="flex cursor-pointer items-center gap-2 text-xs font-medium text-muted-foreground">
          Advanced
          <Switch
            checked={advanced}
            onCheckedChange={(checked) => setAdvanced(Boolean(checked))}
            aria-label="Show advanced typography settings"
          />
        </label>
      }
    >
      {/* The search view needs the advanced rows mounted to show matches among them. */}
      {advanced || inSearchResults ? <FontSettingsGroup /> : <SimpleFontRows />}
      <WordWrapRow />
      <InterfaceSoundsRow />
      <SendSoundRow />
      <QueueSoundRow />
      <SettleSoundRow />
      <SendMotionRow />
      <ComposerFinishRow />
    </SettingsSection>
  );
}

function FontFamilySettingsRow({
  id,
  title,
  description,
  defaultFamily,
  defaultValue,
  preview,
  value,
  onValueChange,
  onReset,
  requireMonospace = false,
  size,
}: {
  id?: string;
  title: string;
  description: string;
  defaultFamily: string;
  defaultValue: string;
  preview?: ReactNode;
  value: string;
  onValueChange: (value: string) => void;
  onReset: () => void;
  requireMonospace?: boolean;
  size?: {
    label: string;
    min: number;
    max: number;
    value: number;
    defaultValue: number;
    onChange: (v: number) => void;
  };
}) {
  const trimmed = value.trim();
  const [draft, setDraft] = useState(value);
  const [draftSettled, setDraftSettled] = useState(true);
  // Each pending commit remembers the value it was typed against, so one that outlives
  // an external change (hydration, reset, picker selection) drops its stale draft.
  const commitTimerRef = useRef<{ readonly id: number; readonly value: string } | null>(null);
  const cancelPendingCommit = () => {
    if (commitTimerRef.current !== null) window.clearTimeout(commitTimerRef.current.id);
    commitTimerRef.current = null;
  };
  // Bumped on every external value change, so a pending commit typed before one never lands,
  // even if the value has since changed back to what it was typed against.
  const [adopted, setAdopted] = useState({ value, generation: 0 });
  if (adopted.value !== value) {
    setAdopted({ value, generation: adopted.generation + 1 });
    setDraft(value);
    setDraftSettled(true);
  }
  const readAdoptedGeneration = useEffectEvent(() => adopted.generation);
  useEffect(
    () => () => {
      if (commitTimerRef.current !== null) window.clearTimeout(commitTimerRef.current.id);
    },
    [],
  );
  const acceptsFamily = (candidate: string) =>
    isFontFamilyAvailable(candidate) && (!requireMonospace || isMonospaceFamily(candidate));
  const commitDraft = (next: string) => {
    setDraftSettled(true);
    if (next.trim().length === 0 || acceptsFamily(next)) {
      onValueChange(next);
    }
  };
  const flushDraft = () => {
    const pending = commitTimerRef.current;
    cancelPendingCommit();
    if (pending !== null && pending.value === value) commitDraft(draft);
  };
  const draftTrimmed = draft.trim();
  const draftPending = draftSettled && draftTrimmed.length > 0 && draftTrimmed !== trimmed;
  const resetToDefault = () => {
    cancelPendingCommit();
    setDraft(defaultValue);
    setDraftSettled(true);
    onReset();
  };
  const resetAction =
    value !== defaultValue || (size !== undefined && size.value !== size.defaultValue) ? (
      <SettingResetButton label={title.toLowerCase()} onClick={resetToDefault} />
    ) : null;
  const fontEnumeration = useFontEnumeration();
  const [inputFocused, setInputFocused] = useState(false);
  const familyControl =
    fontEnumeration.status === "granted" ? (
      <FontFamilyPicker
        ariaLabel={`${title} family`}
        defaultFamily={defaultFamily}
        selectedFamily={trimmed}
        requireMonospace={requireMonospace}
        initialOpen={inputFocused}
        onSelect={onValueChange}
      />
    ) : (
      <Input
        size="sm"
        aria-label={`${title} family`}
        aria-invalid={draftPending || undefined}
        autoCapitalize="off"
        autoComplete="off"
        className="min-w-0 flex-1"
        maxLength={200}
        onFocus={() => {
          setInputFocused(true);
          discoverInstalledFonts();
        }}
        onBlur={() => {
          setInputFocused(false);
          flushDraft();
        }}
        onChange={(event) => {
          const next = event.currentTarget.value;
          setDraft(next);
          setDraftSettled(false);
          cancelPendingCommit();
          const typedAgainst = value;
          const typedInGeneration = adopted.generation;
          commitTimerRef.current = {
            id: window.setTimeout(() => {
              commitTimerRef.current = null;
              if (readAdoptedGeneration() === typedInGeneration) commitDraft(next);
            }, 400),
            value: typedAgainst,
          };
        }}
        onKeyDown={(event) => {
          if (event.key === "Enter") flushDraft();
          if (event.key === "Escape") {
            // Discard uncommitted typing without closing the settings page,
            // which is what an unhandled Escape does.
            event.preventDefault();
            event.stopPropagation();
            cancelPendingCommit();
            setDraft(value);
            setDraftSettled(true);
          }
        }}
        placeholder={defaultFamily}
        spellCheck={false}
        value={draft}
      />
    );
  const control = (
    <div className="flex w-full items-center gap-2 sm:w-auto">
      <div className="min-w-0 flex-1 sm:w-44 sm:flex-none">{familyControl}</div>
      {size !== undefined ? (
        <Select
          value={String(size.value)}
          onValueChange={(next) => {
            if (typeof next !== "string") return;
            const parsed = Number(next);
            if (Number.isInteger(parsed) && parsed >= size.min && parsed <= size.max) {
              size.onChange(parsed);
            }
          }}
        >
          <SelectTrigger size="sm" className="w-22 shrink-0" aria-label={size.label}>
            <SelectValue>{size.value} px</SelectValue>
          </SelectTrigger>
          <SelectPopup align="end" alignItemWithTrigger={false}>
            {Array.from({ length: size.max - size.min + 1 }, (_, index) => size.min + index).map(
              (px) => (
                <SelectItem hideIndicator key={px} value={String(px)}>
                  {px} px
                </SelectItem>
              ),
            )}
          </SelectPopup>
        </Select>
      ) : null}
    </div>
  );
  return (
    <SettingsRow
      {...(id !== undefined ? { id } : {})}
      title={title}
      description={description}
      resetAction={resetAction}
      control={control}
    >
      {preview}
    </SettingsRow>
  );
}
