import type { AccountId, AccountReserve, EnvironmentId, PooledModelKey } from "@t3tools/contracts";
import {
  linkedModelKey,
  reserveAllows,
  routedModelsOn,
  type PooledModel,
} from "@t3tools/shared/accountPools";
import { CheckIcon, PlusIcon } from "lucide-react";
import { useGT } from "gt-react";

import { useEnvironmentSettings } from "../../hooks/useSettings";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { Toggle } from "../ui/toggle";
import { accountReserveIsMixed } from "./accountScope";
import { useOptionalSettingsScope } from "./SettingsScopeContext";
import { useUpdateEnvironmentScopedSettings } from "./useScopedSettings";

const RESERVE_CHOICES: ReadonlyArray<number> = [0, 5, 10, 15, 20, 30];

/**
 * An account's reserve: the remaining percent at which it stops serving routed models, and the
 * models still allowed to use it below that.
 */
export function AccountReserveControl(props: {
  environmentId: EnvironmentId;
  account: AccountId;
  accountLabel: string;
  /** The environment's routed models, labelled as the picker shows them. */
  routedModels: ReadonlyArray<PooledModel>;
  /** It reports a quota window or monthly budget a reserve can be measured against. */
  metered: boolean;
  disabled: boolean;
}) {
  const gt = useGT();
  const context = useOptionalSettingsScope();
  const environmentSettings = useEnvironmentSettings(props.environmentId);
  const settings = context?.target?.settings ?? environmentSettings;
  const reserve = settings.accountReserves?.[props.account];
  const links = settings.modelLinks;
  const update = useUpdateEnvironmentScopedSettings(props.environmentId);
  const mixed = context !== null && accountReserveIsMixed(context.targets, props.account);
  const percent = reserve?.percent ?? 0;
  const allowed = reserve?.allowedModels ?? [];
  const allows = (key: PooledModelKey) =>
    reserve !== undefined && reserveAllows(links, reserve, key);
  const models = routedModelsOn(props.routedModels, props.account);
  const choices = RESERVE_CHOICES.includes(percent)
    ? RESERVE_CHOICES
    : [...RESERVE_CHOICES, percent].toSorted((a, b) => a - b);
  const save = (next: AccountReserve | null) =>
    update({ accountReserves: { [props.account]: next } });
  const toggle = (key: PooledModelKey, on: boolean) =>
    save({
      percent,
      allowedModels: on
        ? [...allowed, key]
        : allowed.filter((model) => linkedModelKey(links, model) !== key),
    });
  const allowedNames = models
    .filter((model) => allows(model.key))
    .map((model) => model.displayName);
  // Nothing measures a reserve on an unmetered account, but one already set stays removable.
  if (!props.metered && reserve === undefined && !mixed) return null;
  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-border/60 bg-muted/30 px-3 py-2">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5">
        <span className="text-xs font-medium text-foreground">
          {gt("Reserve", { $context: "account reserve setting" })}
        </span>
        <Select
          value={mixed ? null : String(percent)}
          disabled={props.disabled}
          onValueChange={(value) => {
            if (value === null) return;
            const next = Number(value);
            save(next === 0 ? null : { percent: next, allowedModels: allowed });
          }}
        >
          <SelectTrigger
            size="xs"
            className="w-auto min-w-0"
            aria-label={gt("Reserve for {account}", { account: props.accountLabel })}
          >
            <SelectValue>
              {mixed
                ? gt("Mixed", { $context: "values differ across targets" })
                : percent === 0
                  ? gt("Off", { $context: "reserve setting" })
                  : `${percent}%`}
            </SelectValue>
          </SelectTrigger>
          <SelectPopup>
            {choices.map((choice) => (
              <SelectItem key={choice} value={String(choice)}>
                {choice === 0 ? gt("Off", { $context: "reserve setting" }) : `${choice}%`}
              </SelectItem>
            ))}
          </SelectPopup>
        </Select>
        {!mixed && percent > 0 && models.length > 0 ? (
          <span
            role="group"
            aria-label={gt("Models allowed into {account}'s reserve", {
              account: props.accountLabel,
            })}
            className="flex flex-wrap items-center gap-1.5"
          >
            <span className="text-xs text-muted-foreground">{gt("Allowed in reserve:")}</span>
            {models.map((model) => {
              const on = allows(model.key);
              return (
                <Toggle
                  key={model.key}
                  size="xs"
                  variant="outline"
                  pressed={on}
                  disabled={props.disabled}
                  onPressedChange={(pressed) => toggle(model.key, pressed)}
                >
                  {on ? <CheckIcon /> : <PlusIcon />}
                  {model.displayName}
                </Toggle>
              );
            })}
          </span>
        ) : null}
      </div>
      <p className="text-xs text-muted-foreground">
        {mixed
          ? gt(
              "Reserve differs across environments. Choose a value to apply it to all selected environments.",
            )
          : percent === 0
            ? gt("No reserve: every routed model can use this account down to 0%.")
            : models.length === 0
              ? gt(
                  "At or below {percent}% left, routed models stop using this account. No routed model uses it yet.",
                  { percent },
                )
              : allowedNames.length === 0
                ? gt(
                    "At or below {percent}% left, this account is held back from every routed model (manual pin only).",
                    { percent },
                  )
                : gt(
                    "At or below {percent}% left, only {models} can still use this account; other models spill over to their next account.",
                    { percent, models: allowedNames.join(", ") },
                  )}
      </p>
    </div>
  );
}
