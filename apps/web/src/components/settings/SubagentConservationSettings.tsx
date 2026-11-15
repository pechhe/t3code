import { conservationModelsOf } from "@t3tools/shared/usageLimits";
import { useNowSecond } from "../../hooks/useNowSecond";
import { useAtomValue } from "@effect/atom-react";
import { useState } from "react";
import type {
  EnvironmentId,
  ProviderInstanceId,
  ServerProvider,
  SubagentConservationRule,
} from "@t3tools/contracts";
import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { serverEnvironment } from "../../state/server";
import { useEnvironmentScope } from "../../state/session";
import { AuthSettingsWriteScope } from "@t3tools/contracts";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
import { Input } from "../ui/input";
import { Switch } from "../ui/switch";
import { SettingsChoice } from "./SettingsChoice";
import { SettingsRow, SettingsSection } from "./settingsLayout";

export function SubagentConservationSettings({
  environmentId,
  label,
  instanceId,
  readOnly = false,
}: {
  environmentId: EnvironmentId;
  label: string;
  instanceId?: ProviderInstanceId;
  readOnly?: boolean;
}) {
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const settings = useAtomValue(serverEnvironment.settingsValueAtom(environmentId));
  const update = useUpdateEnvironmentSettings(environmentId);
  const writable = useEnvironmentScope(environmentId, AuthSettingsWriteScope);
  const providers =
    config?.providers.filter(
      (provider) =>
        provider.poolMembers === undefined &&
        (instanceId !== undefined
          ? provider.instanceId === instanceId
          : (provider.enabled && provider.installed && provider.auth.status === "authenticated") ||
            settings?.subagentConservation?.[provider.instanceId] !== undefined),
    ) ?? [];
  return (
    <SettingsSection
      aria-label={`Subscription conservation on ${label}`}
      title="Subscription conservation"
      id={`subscription-conservation-${environmentId}-${instanceId ?? "all"}`}
    >
      <SettingsRow
        title={label}
        description="Keep allowance for the work you value. Rules apply to new managed subagents on this environment. Your current conversation and previously created conversations keep their models."
      />
      {providers.map((provider) => (
        <AccountRule
          key={`${provider.instanceId}:${JSON.stringify(settings?.subagentConservation?.[provider.instanceId] ?? null)}`}
          provider={provider}
          rule={settings?.subagentConservation?.[provider.instanceId]}
          readOnly={readOnly || !writable || !settings}
          onSave={(rule) =>
            update({
              subagentConservation: {
                ...settings?.subagentConservation,
                [provider.instanceId]: rule,
              },
            })
          }
        />
      ))}
      {providers.length === 0 && (
        <SettingsRow
          title="No provider accounts available"
          description="Connect an account that reports subscription usage to configure conservation."
        />
      )}
    </SettingsSection>
  );
}

function AccountRule({
  provider,
  rule,
  readOnly,
  onSave,
}: {
  provider: ServerProvider;
  rule: SubagentConservationRule | undefined;
  readOnly: boolean;
  onSave: (rule: SubagentConservationRule) => void;
}) {
  const [enabled, setEnabled] = useState(rule?.enabled ?? false);
  const [threshold, setThreshold] = useState(rule ? String(rule.remainingPercent) : "");
  const [window, setWindow] = useState(rule?.window ?? "any");
  const [models, setModels] = useState<readonly string[]>(rule?.models ?? []);
  const limits =
    provider.conservationScope?.providerIds.length === 0 ? undefined : provider.usageLimits;
  const supportedModels = conservationModelsOf(provider, provider.models);
  const selectedModels = conservationModelsOf(provider, models);
  const supported =
    !!limits?.credentialFingerprint && !!limits.windows.length && supportedModels.length > 0;
  const blocked = readOnly || (!supported && !rule);
  const percent = Number(threshold);
  const valid =
    threshold.trim() !== "" && Number.isFinite(percent) && percent >= 1 && percent <= 99;
  const dirty =
    enabled !== (rule?.enabled ?? false) ||
    threshold !== (rule ? String(rule.remainingPercent) : "") ||
    window !== (rule?.window ?? "any") ||
    JSON.stringify(selectedModels) !== JSON.stringify(rule?.models ?? []);
  const status = provider.subagentConservation;
  const now = useNowSecond();
  const stale =
    limits !== undefined &&
    (now - Date.parse(limits.checkedAt) >= 60_000 ||
      limits.windows.some(
        (item) =>
          (rule?.window === "any" || item.id === rule?.window) &&
          item.resetsAt !== undefined &&
          Date.parse(item.resetsAt) <= now,
      ));
  const statusMessage =
    status && stale && !status.unavailable
      ? `Usage is stale. Keeping the last known ${status.state} state; usage will be refreshed before the next subagent starts.${status.state === "ready" ? " Starts are still permitted if refresh fails; this does not guarantee an unspent reserve." : ""}`
      : status?.message;

  const title = provider.displayName ?? provider.driver;
  return (
    <div className="border-t border-border px-4 py-4">
      <div className="flex items-start justify-between gap-4">
        <div>
          <h3 className="text-sm font-medium">{title}</h3>
          <p className="mt-1 text-xs text-muted-foreground">
            {provider.auth.email ?? provider.instanceId}
          </p>
        </div>
        <Switch
          aria-label={`Enable conservation for ${title}`}
          checked={enabled}
          disabled={blocked}
          onCheckedChange={setEnabled}
        />
      </div>
      {!supported && (
        <p className="mt-3 text-xs text-muted-foreground">
          {provider.conservationScope?.reason ??
            limits?.unavailable?.message ??
            "This connection cannot report identified subscription usage and windows. Conservation cannot be configured until it can."}
        </p>
      )}
      {(supported || rule) && (
        <>
          <div className="mt-4 flex flex-wrap items-center gap-2 text-sm">
            <label htmlFor={`conservation-threshold-${provider.instanceId}`}>
              Conserve when usage remaining is
            </label>
            <Input
              id={`conservation-threshold-${provider.instanceId}`}
              aria-label={`Remaining usage threshold for ${title}`}
              type="number"
              min={1}
              max={99}
              value={threshold}
              disabled={readOnly}
              className="w-18"
              onChange={(event) => setThreshold(event.target.value)}
            />
            <span>% or less in</span>
            <SettingsChoice
              label={`Usage window for ${title}`}
              value={window}
              disabled={readOnly}
              values={[
                { value: "any", label: "Any window" },
                ...(limits?.windows ?? []).map((item) => ({ value: item.id, label: item.label })),
              ]}
              onChange={setWindow}
            />
          </div>
          <p className="mt-4 text-xs text-muted-foreground">Models to conserve</p>
          <div className="mt-1 divide-y divide-border">
            {supportedModels.map((model) => (
              <label
                key={model.slug}
                className="flex cursor-pointer items-center justify-between gap-3 py-2 text-sm"
              >
                <span>{model.name ?? model.slug}</span>
                <Checkbox
                  aria-label={`Conserve ${model.name ?? model.slug} on ${title}`}
                  checked={selectedModels.includes(model.slug)}
                  disabled={readOnly}
                  onCheckedChange={(checked) =>
                    setModels(
                      checked
                        ? [...selectedModels, model.slug]
                        : selectedModels.filter((slug) => slug !== model.slug),
                    )
                  }
                />
              </label>
            ))}
          </div>
          <div
            role="status"
            className="mt-3 flex items-start gap-2 rounded-lg border border-border bg-muted/30 px-3 py-2 text-xs text-muted-foreground"
          >
            <span
              aria-hidden
              className={`mt-1 size-1.5 shrink-0 rounded-full ${rule?.enabled && !dirty ? (status?.unavailable || stale || status?.state === "unknown" ? "bg-muted-foreground" : status?.state === "active" ? "bg-warning" : "bg-success") : "bg-muted-foreground"}`}
            />
            <span>
              {dirty
                ? "Save changes to apply this rule."
                : !rule?.enabled
                  ? "Conservation off. New subagents use the normal role choices."
                  : (statusMessage ??
                    "Checking usage. Selected models are excluded until a usable reading is available.")}
            </span>
          </div>
          <div className="mt-3 flex items-center justify-between gap-3">
            <p className="text-xs text-muted-foreground">
              If no suitable model remains, the task will not start.
            </p>
            <Button
              size="sm"
              variant="outline"
              disabled={readOnly || !dirty || !valid || (enabled && selectedModels.length === 0)}
              onClick={() =>
                onSave({
                  enabled,
                  remainingPercent: percent,
                  window,
                  windowIds:
                    window === "any"
                      ? (limits?.windows.map((item) => item.id) ?? rule?.windowIds ?? [])
                      : [window],
                  models: selectedModels,
                })
              }
            >
              Save rule
            </Button>
          </div>
        </>
      )}
    </div>
  );
}
