import type { EnvironmentId } from "@t3tools/contracts";
import { T, useGT, Var } from "gt-react";
import { useState } from "react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { useUpdateEnvironmentScopedSettings } from "../settings/useScopedSettings";
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
  environmentId,
  slotId,
  usedUsd,
  limitUsd,
}: {
  readonly environmentId: EnvironmentId | null;
  readonly slotId: string | undefined;
  readonly usedUsd?: number | undefined;
  readonly limitUsd?: number | undefined;
}) {
  const gt = useGT();
  if (slotId === undefined || environmentId === null) {
    return (
      <p className="text-xs text-muted-foreground tabular-nums">
        {usedUsd === undefined || limitUsd === undefined
          ? ""
          : gt("${used} of ${limit} this cycle", {
              used: usedUsd.toFixed(2),
              limit: limitUsd.toFixed(2),
            })}
      </p>
    );
  }
  return (
    <UsageSlotBudgetEditorForm
      environmentId={environmentId}
      slotId={slotId}
      usedUsd={usedUsd}
      limitUsd={limitUsd}
    />
  );
}

function UsageSlotBudgetEditorForm({
  environmentId,
  slotId,
  usedUsd,
  limitUsd,
}: {
  readonly environmentId: EnvironmentId;
  readonly slotId: string;
  readonly usedUsd?: number | undefined;
  readonly limitUsd?: number | undefined;
}) {
  const gt = useGT();
  const budget = useEnvironmentSettings(
    environmentId,
    (settings) => settings.usageSlotBudgets?.[slotId],
  );
  const updateSettings = useUpdateEnvironmentScopedSettings(environmentId);
  const [form, setForm] = useState(() => usageSlotBudgetForm(budget));
  const [editing, setEditing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  if (!editing) {
    return (
      <div className="flex flex-wrap items-center gap-3 text-xs text-muted-foreground tabular-nums">
        {usedUsd === undefined || limitUsd === undefined ? null : (
          <span>
            <T>
              $<Var>{usedUsd.toFixed(2)}</Var> of $<Var>{limitUsd.toFixed(2)}</Var> this cycle
            </T>
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
          {budget === undefined ? gt("Set monthly budget") : gt("Edit budget")}
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
    await Promise.resolve(updateSettings({ usageSlotBudgets: { [slotId]: result.patch } }))
      .then(() => setEditing(false))
      .finally(() => setSaving(false));
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
          gt("Monthly budget (USD)"),
          form.monthlyBudgetUsd,
          (next) => setForm({ ...form, monthlyBudgetUsd: next }),
          "40",
        )}
        {field(
          gt("Resets on day"),
          form.resetDayOfMonth,
          (next) => setForm({ ...form, resetDayOfMonth: next }),
          "1",
        )}
        {field(
          gt("Spent so far this cycle"),
          form.cycleSpendUsd,
          (next) => setForm({ ...form, cycleSpendUsd: next }),
          "0",
        )}
      </div>
      <p className="text-3xs text-muted-foreground">
        <T>
          Type what the provider console says and T3 carries on from that figure, adding what it
          records after it.
        </T>
      </p>
      {error ? <p className="text-xs text-destructive">{error}</p> : null}
      <div className="flex gap-2">
        <Button size="xs" disabled={saving} onClick={() => void save()}>
          {saving ? gt("Saving…") : gt("Save budget")}
        </Button>
        {budget === undefined ? null : (
          <Button size="xs" variant="outline" disabled={saving} onClick={() => void save(true)}>
            {saving ? gt("Saving…") : gt("Correct spend")}
          </Button>
        )}
        <Button size="xs" variant="ghost" disabled={saving} onClick={() => setEditing(false)}>
          {gt("Cancel")}
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
            {gt("Remove budget")}
          </Button>
        )}
      </div>
    </div>
  );
}
