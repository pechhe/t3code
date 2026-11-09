import { useAtomValue } from "@effect/atom-react";
import {
  DECISION_PROVIDERS,
  DECISION_PROVIDER_LABELS,
  DEFAULT_DECISION_PROVIDER,
  DEFAULT_OPENROUTER_DECISION_MODEL,
  DecisionOpenRouterModel,
  isSecretReference,
  type DecisionKeyStatus,
  type DecisionProvider,
  type DecisionRoutingFailureCode,
  type DecisionTestResult,
  type EnvironmentId,
  type SecretReference,
} from "@t3tools/contracts";
import * as Schema from "effect/Schema";
import { useState } from "react";

import type { EnvironmentPresentation } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Select, SelectItem, SelectPopup, SelectTrigger, SelectValue } from "../ui/select";
import { SecretSourceInput, useSecretSources } from "./SecretSourceInput";
import {
  SettingResetButton,
  SettingsPageContainer,
  SettingsRow,
  SettingsSection,
} from "./settingsLayout";
import { useSettingsScope } from "./SettingsScopeContext";
import {
  useScopedSettings,
  useScopedSettingsMixed,
  useUpdateScopedSettings,
} from "./useScopedSettings";

const isModelId = Schema.is(DecisionOpenRouterModel);

const FAILURE_TEXT: Readonly<Record<DecisionRoutingFailureCode, string>> = {
  "invalid-input": "the test request was not valid",
  "engine-not-accepted": "the test request named an engine",
  "key-missing": "no API key is set",
  "key-unreadable": "the saved key reference could not be read",
  "key-rejected": "the key was rejected, so check that it is current",
  "credits-exhausted": "the account is out of credits",
  "rate-limited": "the provider is rate limiting this account",
  timeout: "the provider did not answer in time",
  unreachable: "the server could not reach the provider",
  "invalid-provider-response": "the provider's answer did not match the request",
  busy: "this server has too many decisions in flight",
  cancelled: "the test was cancelled",
};

function describeKey(status: DecisionKeyStatus | undefined, saved: boolean, reference: boolean) {
  if (reference) return "Read from a secret provider when a decision runs.";
  if (saved) return status?.last4 ? `Saved, ending ${status.last4}.` : "Saved.";
  if (status === undefined) return "Not set.";
  if (status.source === "server-environment")
    return `From the server's environment${status.last4 ? `, ending ${status.last4}` : ""}.`;
  if (status.source === "bitwarden")
    return `From Bitwarden Secrets${status.last4 ? `, ending ${status.last4}` : ""}.`;
  return "Not set.";
}

function KeyRow({
  provider,
  environmentId,
}: {
  provider: DecisionProvider;
  environmentId: EnvironmentId;
}) {
  const credential = useScopedSettings((settings) => settings.decisionCredentials[provider]);
  const mixed = useScopedSettingsMixed(["decisionCredentials"]);
  const updateSettings = useUpdateScopedSettings();
  const sources = useSecretSources(environmentId);
  const status = useEnvironmentQuery(
    serverEnvironment.decisionStatus({ environmentId, input: {} }),
  );
  const [draft, setDraft] = useState<string | SecretReference>("");
  const reference = isSecretReference(credential);
  const saved = !reference && typeof credential === "string" && credential.length > 0;
  const submission = typeof draft === "string" ? draft.trim() : draft;
  const save = (value: string | SecretReference) => {
    updateSettings({ decisionCredentials: { [provider]: value } });
    setDraft("");
    status.refresh();
  };
  return (
    <SettingsRow
      serverScoped
      settingKeys={["decisionCredentials"]}
      title="API key"
      status={
        mixed
          ? "Differs between environments."
          : describeKey(status.data?.keys[provider], saved, reference)
      }
      control={
        <form
          className="flex w-72 max-w-full items-center gap-2"
          onSubmit={(event) => {
            event.preventDefault();
            if (submission !== "") save(submission);
          }}
        >
          <SecretSourceInput
            size="sm"
            aria-label={`${DECISION_PROVIDER_LABELS[provider]} key`}
            configured={saved}
            value={draft}
            sources={sources}
            onChange={(event) => setDraft(event.target.value)}
            onSecretChange={(secret) => setDraft(secret ?? "")}
          />
          {submission !== "" ? (
            <Button type="submit" size="xs">
              Save
            </Button>
          ) : saved || reference ? (
            <Button type="button" size="xs" variant="outline" onClick={() => save("")}>
              Clear
            </Button>
          ) : null}
        </form>
      }
    />
  );
}

function ModelRow() {
  const model = useScopedSettings((settings) => settings.decisionOpenRouterModel);
  const mixed = useScopedSettingsMixed(["decisionOpenRouterModel"]);
  const updateSettings = useUpdateScopedSettings();
  const [draft, setDraft] = useState<string | null>(null);
  const value = draft ?? (mixed ? "" : model);
  const invalid = draft !== null && !isModelId(draft.trim());
  const commit = () => {
    if (draft === null) return;
    const next = draft.trim();
    if (isModelId(next)) updateSettings({ decisionOpenRouterModel: next });
    setDraft(null);
  };
  return (
    <SettingsRow
      serverScoped
      settingKeys={["decisionOpenRouterModel"]}
      title="OpenRouter model"
      status={invalid ? "Use an OpenRouter model id, such as ~typesafe/jev-latest." : undefined}
      resetAction={
        mixed || model !== DEFAULT_OPENROUTER_DECISION_MODEL ? (
          <SettingResetButton
            label="OpenRouter model"
            onClick={() =>
              updateSettings({ decisionOpenRouterModel: DEFAULT_OPENROUTER_DECISION_MODEL })
            }
          />
        ) : null
      }
      control={
        <Input
          size="sm"
          font="mono"
          aria-label="OpenRouter model"
          aria-invalid={invalid}
          autoComplete="off"
          spellCheck={false}
          value={value}
          placeholder={mixed ? "Mixed" : DEFAULT_OPENROUTER_DECISION_MODEL}
          onChange={(event) => setDraft(event.target.value)}
          onBlur={commit}
          onKeyDown={(event) => {
            if (event.key === "Enter") commit();
          }}
        />
      }
    />
  );
}

function TestButton({
  environments,
  onResults,
}: {
  environments: ReadonlyArray<EnvironmentPresentation>;
  onResults: (lines: ReadonlyArray<string>) => void;
}) {
  const test = useAtomCommand(serverEnvironment.testDecisions, { reportFailure: false });
  const first = environments[0]?.environmentId ?? null;
  // A test spends the provider's credits, so it follows the settings-write grant.
  const canTest = useAtomValue(serverEnvironment.testDecisions.permissionAtom(first));
  const [running, setRunning] = useState(false);
  const run = async () => {
    setRunning(true);
    onResults([]);
    const lines: string[] = [];
    for (const environment of environments) {
      const response = await test({ environmentId: environment.environmentId, input: {} });
      const result: DecisionTestResult | null = response._tag === "Success" ? response.value : null;
      const outcome =
        result === null
          ? "the test could not run"
          : result.ok
            ? `works, ${result.latencyMs ?? "?"} ms${result.costUsd === null ? "" : `, $${result.costUsd.toFixed(6)}`}`
            : FAILURE_TEXT[result.failure ?? "unreachable"];
      lines.push(environments.length > 1 ? `${environment.label}: ${outcome}` : outcome);
    }
    onResults(lines);
    setRunning(false);
  };
  return (
    <Button
      size="xs"
      variant="outline"
      disabled={running || !canTest || first === null}
      onClick={() => void run()}
    >
      {running ? "Testing" : "Test"}
    </Button>
  );
}

export function DecisionsSettings() {
  const { connectedEnvironments, target } = useSettingsScope();
  const provider = useScopedSettings((settings) => settings.decisionProvider);
  const mixed = useScopedSettingsMixed(["decisionProvider"]);
  const updateSettings = useUpdateScopedSettings();
  const [results, setResults] = useState<ReadonlyArray<string>>([]);
  const supported = connectedEnvironments.filter(
    (environment) => environment.serverConfig?.decisionSettings === true,
  );
  const outdated = connectedEnvironments.filter(
    (environment) =>
      environment.serverConfig !== null && environment.serverConfig.decisionSettings !== true,
  );
  const keyEnvironmentId = target?.environmentId ?? supported[0]?.environmentId ?? null;
  return (
    <SettingsPageContainer>
      <SettingsSection title="Decision model">
        <SettingsRow
          serverScoped
          settingKeys={["decisionProvider"]}
          title="Provider"
          description="If it fails, the decision fails; nothing switches provider for you."
          status={
            outdated.length > 0
              ? `Update T3 Code on ${outdated.map((environment) => environment.label).join(", ")} to set its decision model.`
              : results.length > 0
                ? results.join(" · ")
                : undefined
          }
          resetAction={
            mixed || provider !== DEFAULT_DECISION_PROVIDER ? (
              <SettingResetButton
                label="decision provider"
                onClick={() => updateSettings({ decisionProvider: DEFAULT_DECISION_PROVIDER })}
              />
            ) : null
          }
          control={
            <div className="flex items-center gap-2">
              <Select
                value={mixed ? null : provider}
                onValueChange={(value) => {
                  if (DECISION_PROVIDERS.includes(value as DecisionProvider))
                    updateSettings({ decisionProvider: value as DecisionProvider });
                }}
              >
                <SelectTrigger size="sm" aria-label="Decision provider">
                  <SelectValue>
                    {(value: DecisionProvider | null) =>
                      value === null ? "Mixed" : DECISION_PROVIDER_LABELS[value]
                    }
                  </SelectValue>
                </SelectTrigger>
                <SelectPopup align="end" alignItemWithTrigger={false}>
                  {DECISION_PROVIDERS.map((value) => (
                    <SelectItem key={value} value={value}>
                      {DECISION_PROVIDER_LABELS[value]}
                    </SelectItem>
                  ))}
                </SelectPopup>
              </Select>
              <TestButton environments={supported} onResults={setResults} />
            </div>
          }
        />
        {!mixed && provider === "openrouter" ? <ModelRow /> : null}
        {keyEnvironmentId !== null && !mixed ? (
          <KeyRow key={provider} provider={provider} environmentId={keyEnvironmentId} />
        ) : null}
      </SettingsSection>
    </SettingsPageContainer>
  );
}
