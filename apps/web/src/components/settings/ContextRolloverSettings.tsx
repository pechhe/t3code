import {
  type ContextRolloverModelRule,
  type ContextRolloverSettings as ContextRolloverSettingsValue,
  DEFAULT_SERVER_SETTINGS,
} from "@t3tools/contracts";
import { PlusIcon, Trash2Icon } from "lucide-react";
import { useState } from "react";

import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  NumberField,
  NumberFieldDecrement,
  NumberFieldGroup,
  NumberFieldIncrement,
  NumberFieldInput,
} from "../ui/number-field";
import { Switch } from "../ui/switch";
import { SettingResetButton, SettingsRow, SettingsSection } from "./settingsLayout";
import { searchableSetting } from "./settingsSearch";
import { useScopedSettings, useUpdateScopedSettings } from "./useScopedSettings";

const DEFAULTS = DEFAULT_SERVER_SETTINGS.contextRollover;
const MAX_K = 2_000;

/** A token count edited in thousands. */
function TokensField({
  label,
  value,
  onChange,
}: {
  label: string;
  value: number;
  onChange: (value: number) => void;
}) {
  const k = Math.round(value / 1000);
  const [draft, setDraft] = useState<number | null>(k);
  const [saved, setSaved] = useState(k);
  if (saved !== k) {
    setSaved(k);
    setDraft(k);
  }
  return (
    <NumberField
      value={draft}
      min={1}
      max={MAX_K}
      step={10}
      size="sm"
      className="w-auto"
      onValueChange={setDraft}
      onValueCommitted={(next) => {
        if (next === null) return setDraft(k);
        const clamped = Math.min(MAX_K, Math.max(1, Math.round(next)));
        setDraft(clamped);
        onChange(clamped * 1000);
      }}
    >
      <NumberFieldGroup>
        <NumberFieldDecrement aria-label={`Decrease ${label}`} />
        <NumberFieldInput
          aria-label={`${label} in thousands of tokens`}
          size={String(draft ?? k).length}
          className="field-sizing-content w-auto min-w-[1ch] grow-0 text-right"
        />
        <span aria-hidden="true" className="self-center pr-2 text-xs">
          k
        </span>
        <NumberFieldIncrement aria-label={`Increase ${label}`} />
      </NumberFieldGroup>
    </NumberField>
  );
}

function thresholdProblem(soft: number, hard: number): string | undefined {
  return soft >= hard ? "The hard threshold should be above the soft one." : undefined;
}

function ModelRuleRow({
  rule,
  onChange,
  onRemove,
}: {
  rule: ContextRolloverModelRule;
  onChange: (rule: ContextRolloverModelRule) => void;
  onRemove: () => void;
}) {
  const problem = thresholdProblem(rule.softThreshold, rule.hardThreshold);
  return (
    <div className="flex flex-col gap-1.5">
      <div className="flex flex-wrap items-center justify-end gap-2">
        <Input
          key={rule.modelPattern}
          aria-label="Model name contains"
          className="w-36"
          autoCapitalize="none"
          spellCheck={false}
          placeholder="e.g. haiku"
          defaultValue={rule.modelPattern}
          onBlur={(event) => {
            const modelPattern = event.target.value.trim();
            if (modelPattern.length > 0 && modelPattern !== rule.modelPattern)
              onChange({ ...rule, modelPattern });
          }}
        />
        {rule.enabled ? (
          <>
            <TokensField
              label={`${rule.modelPattern} soft threshold`}
              value={rule.softThreshold}
              onChange={(softThreshold) => onChange({ ...rule, softThreshold })}
            />
            <TokensField
              label={`${rule.modelPattern} hard threshold`}
              value={rule.hardThreshold}
              onChange={(hardThreshold) => onChange({ ...rule, hardThreshold })}
            />
          </>
        ) : (
          <span className="text-xs text-muted-foreground">No rollover</span>
        )}
        <Switch
          aria-label={`Roll over ${rule.modelPattern}`}
          checked={rule.enabled}
          onCheckedChange={(enabled) => onChange({ ...rule, enabled })}
        />
        <Button
          size="icon-sm"
          variant="ghost"
          aria-label={`Remove the ${rule.modelPattern} rule`}
          onClick={onRemove}
        >
          <Trash2Icon />
        </Button>
      </div>
      {rule.enabled && problem ? (
        <p className="text-right text-xs text-destructive">{problem}</p>
      ) : null}
    </div>
  );
}

export function ContextRolloverSettings() {
  const settings = useScopedSettings();
  const updateSettings = useUpdateScopedSettings();
  const rollover = settings.contextRollover;
  const update = (patch: Partial<ContextRolloverSettingsValue>) =>
    updateSettings({ contextRollover: { ...rollover, ...patch } });
  const setRules = (modelRules: ReadonlyArray<ContextRolloverModelRule>) => update({ modelRules });

  return (
    <SettingsSection id="context-rollover" title="Context rollover">
      <SettingsRow
        serverScoped
        settingKeys={["contextRollover"]}
        {...searchableSetting("context-rollover")}
        description="When a thread's context grows past the soft threshold, the agent is asked to reach a natural break and record what would be lost, and at the hard threshold to finish the step in hand. The provider then compacts the conversation itself, at the \u201cAuto-compact after\u201d size set in its provider settings, and the agent carries on in the same thread and run. In a thread, /rollover off holds this until /rollover on, /rollover pause [30m|2h|1d] holds it for a while, and /rollover status reports it."
        resetAction={
          JSON.stringify(rollover) !== JSON.stringify(DEFAULTS) ? (
            <SettingResetButton
              label="context rollover"
              onClick={() => updateSettings({ contextRollover: DEFAULTS })}
            />
          ) : null
        }
        control={
          <Switch
            aria-label="Context rollover"
            checked={rollover.enabled}
            onCheckedChange={(enabled) => update({ enabled })}
          />
        }
      />
      {rollover.enabled ? (
        <>
          <SettingsRow
            serverScoped
            settingKeys={["contextRollover"]}
            {...searchableSetting("context-rollover-thresholds")}
            description="Soft and hard thresholds, in thousands of tokens of context. Keep the hard threshold below the point where the provider would compact the conversation itself."
            status={thresholdProblem(rollover.softThreshold, rollover.hardThreshold)}
            control={
              <div className="flex flex-wrap items-center justify-end gap-2">
                <TokensField
                  label="Soft threshold"
                  value={rollover.softThreshold}
                  onChange={(softThreshold) => update({ softThreshold })}
                />
                <TokensField
                  label="Hard threshold"
                  value={rollover.hardThreshold}
                  onChange={(hardThreshold) => update({ hardThreshold })}
                />
              </div>
            }
          />
          <SettingsRow
            serverScoped
            settingKeys={["contextRollover"]}
            {...searchableSetting("context-rollover-delegated")}
            description="Also nudge child threads started with delegate_task. Subagents a provider starts on its own are never nudged."
            control={
              <Switch
                aria-label="Roll over delegated threads"
                checked={rollover.delegatedThreads}
                onCheckedChange={(delegatedThreads) => update({ delegatedThreads })}
              />
            }
          />
          <SettingsRow
            serverScoped
            settingKeys={["contextRollover"]}
            {...searchableSetting("context-rollover-models")}
            description="Different thresholds for some models. The first rule whose text appears in the model name applies; turn a rule off to never roll that model over."
            control={
              <Button
                size="sm"
                variant="outline"
                onClick={() =>
                  setRules([
                    ...rollover.modelRules,
                    {
                      modelPattern: "model",
                      enabled: true,
                      softThreshold: rollover.softThreshold,
                      hardThreshold: rollover.hardThreshold,
                    },
                  ])
                }
              >
                <PlusIcon />
                Add rule
              </Button>
            }
          >
            {rollover.modelRules.length > 0 ? (
              <div className="flex flex-col gap-2 pt-2">
                {rollover.modelRules.map((rule, index) => (
                  <ModelRuleRow
                    // oxlint-disable-next-line react/no-array-index-key -- rules have no id; order is their identity.
                    key={index}
                    rule={rule}
                    onChange={(next) =>
                      setRules(rollover.modelRules.map((other, i) => (i === index ? next : other)))
                    }
                    onRemove={() => setRules(rollover.modelRules.filter((_, i) => i !== index))}
                  />
                ))}
              </div>
            ) : null}
          </SettingsRow>
        </>
      ) : null}
    </SettingsSection>
  );
}
