import { useState } from "react";

import { usePrimaryEnvironmentId } from "../../state/environments";
import { usePrimarySettings, useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import {
  usageSlotBudgetCorrection,
  usageSlotBudgetForm,
  usageSlotBudgetPatch,
} from "./usageSlotBudgetForm";

/**
 * The budget editor sits where the dollars are shown, so a correction is made against the
 * figure it corrects. Only a moved spend figure re-anchors the cycle; a budget or reset-day
 * edit leaves the accumulated local spend alone.
 */
export function UsageSlotBudgetEditor({
  slotId,
  usedUsd,
  limitUsd,
}: {
  readonly slotId: string | undefined;
  readonly usedUsd?: number;
  readonly limitUsd?: number;
}) {
  const environmentId = usePrimaryEnvironmentId();
  const budget = usePrimarySettings((settings) =>
    slotId === undefined ? undefined : settings.usageSlotBudgets?.[slotId],
  );
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const [form, setForm] = useState(() => usageSlotBudgetForm(budget));
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  if (slotId === undefined) {
    return (
      <p className="text-xs text-muted-foreground tabular-nums">
        {usedUsd === undefined || limitUsd === undefined
          ? ""
          : `$${usedUsd.toFixed(2)} of $${limitUsd.toFixed(2)} this cycle`}
      </p>
    );
  }

  if (!editing) {
    return (
      <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground tabular-nums">
        {usedUsd === undefined || limitUsd === undefined ? null : (
          <span>
            ${usedUsd.toFixed(2)} of ${limitUsd.toFixed(2)} this cycle
          </span>
        )}
        <Button
          size="xs"
          variant="outline"
          onClick={() => {
            setForm(usageSlotBudgetForm(budget));
            setError(null);
            setEditing(true);
          }}
        >
          {budget === undefined ? "Set monthly budget" : "Edit budget"}
        </Button>
      </div>
    );
  }

  const save = async (correctSpend = false) => {
    const result = correctSpend
      ? usageSlotBudgetCorrection(budget, form)
      : usageSlotBudgetPatch(budget, form);
    if ("error" in result) {
      setError(result.error);
      return;
    }
    setSaving(true);
    setError(null);
    try {
      await updateSettings({ usageSlotBudgets: { [slotId]: result.patch } });
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  const field = (
    label: string,
    value: string,
    onChange: (next: string) => void,
    placeholder: string,
  ) => (
    <label className="flex flex-col gap-1">
      <span className="text-3xs text-muted-foreground">{label}</span>
      <Input
        value={value}
        placeholder={placeholder}
        inputMode="decimal"
        onChange={(event) => onChange(event.currentTarget.value)}
      />
    </label>
  );

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-dashed border-border/70 p-3">
      <div className="grid grid-cols-3 gap-3">
        {field(
          "Monthly budget (USD)",
          form.monthlyBudgetUsd,
          (next) => setForm({ ...form, monthlyBudgetUsd: next }),
          "40",
        )}
        {field(
          "Resets on day",
          form.resetDayOfMonth,
          (next) => setForm({ ...form, resetDayOfMonth: next }),
          "1",
        )}
        {field(
          "Spent so far this cycle",
          form.cycleSpendUsd,
          (next) => setForm({ ...form, cycleSpendUsd: next }),
          "0",
        )}
      </div>
      <p className="text-3xs text-muted-foreground">
        Type what the provider console says and T3 carries on from that figure, adding what it
        records after it.
      </p>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      <div className="flex gap-2">
        <Button size="xs" disabled={saving} onClick={() => void save()}>
          {saving ? "Saving…" : "Save budget"}
        </Button>
        {budget === undefined ? null : (
          <Button size="xs" variant="outline" disabled={saving} onClick={() => void save(true)}>
            {saving ? "Saving…" : "Correct spend"}
          </Button>
        )}
        <Button size="xs" variant="ghost" disabled={saving} onClick={() => setEditing(false)}>
          Cancel
        </Button>
        {budget === undefined ? null : (
          <Button
            size="xs"
            variant="ghost"
            disabled={saving}
            onClick={() => {
              setSaving(true);
              void Promise.resolve(updateSettings({ usageSlotBudgets: { [slotId]: null } }))
                .then(() => setEditing(false))
                .finally(() => setSaving(false));
            }}
          >
            Remove budget
          </Button>
        )}
      </div>
    </div>
  );
}
