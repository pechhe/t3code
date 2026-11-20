import { useAtomValue } from "@effect/atom-react";
import type { OtlpEndpointCheckResult, OtlpSignal, ServerObservability } from "@t3tools/contracts";
import { useEffect, useEffectEvent, useState } from "react";
import { msg, T, useGT, useMessages, Var } from "gt-react";
import { m, type MessageResolver } from "../../i18n/messages";

import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { ConnectionStatusDot } from "../ConnectionStatusDot";
import { useSettingsScope } from "./SettingsScopeContext";
import { useScopedSettings } from "./useScopedSettings";
import { SettingsSection } from "./settingsLayout";
import { SettingsScopeNotice } from "./SettingsScopeNotice";

const SIGNALS = [
  {
    key: "otlpTracesUrl",
    sourceKey: "otlpTracesSource",
    variableKey: "otlpTracesVariable",
    label: msg("Traces endpoint"),
    signal: "traces",
  },
  {
    key: "otlpMetricsUrl",
    sourceKey: "otlpMetricsSource",
    variableKey: "otlpMetricsVariable",
    label: msg("Metrics endpoint"),
    signal: "metrics",
  },
  {
    key: "otlpLogsUrl",
    sourceKey: "otlpLogsSource",
    variableKey: "otlpLogsVariable",
    label: msg("Logs endpoint"),
    signal: "logs",
  },
] as const;

type SignalDescriptor = (typeof SIGNALS)[number];
type SignalKey = SignalDescriptor["key"];

const OVERRIDE_LABELS = {
  environment: msg("Set by environment"),
  bootstrap: msg("Set by desktop"),
} as const;

function runningOverride(
  running: ServerObservability | undefined,
  { key, sourceKey, variableKey }: SignalDescriptor,
  resolve: MessageResolver = m,
) {
  const url = running?.[key];
  const source = running?.[sourceKey];
  if (url === undefined || (source !== "environment" && source !== "bootstrap")) return undefined;
  return { url, label: resolve(OVERRIDE_LABELS[source]), variable: running?.[variableKey] };
}

type EndpointCheck = { readonly url: string; readonly result: OtlpEndpointCheckResult | null };

const isHttpUrl = (url: string) => /^https?:\/\/./i.test(url);

function endpointStatus(
  url: string,
  check: EndpointCheck | undefined,
  resolve: MessageResolver = m,
) {
  if (url === "") {
    return {
      label: resolve(msg("Off", { $context: "export disabled" })),
      dot: "bg-muted-foreground/40",
    };
  }
  if (check?.url !== url) {
    return { label: resolve(msg("Not checked")), dot: "bg-muted-foreground/40" };
  }
  const { result } = check;
  if (result === null) return { label: resolve(msg("Checking…")), dot: "bg-warning" };
  switch (result._tag) {
    case "Accepted":
      return {
        label: resolve(msg("Connected · {ms} ms", { ms: Math.round(result.latencyMs) })),
        dot: "bg-success",
      };
    case "Rejected":
      return {
        label: resolve(msg("Rejected · HTTP {status}", { status: result.status })),
        dot: "bg-destructive",
      };
    case "Unreachable":
      return {
        label: result.timedOut ? resolve(msg("Timed out")) : resolve(msg("Unreachable")),
        dot: "bg-destructive",
      };
  }
}

export function TelemetryExportSettings() {
  const gt = useGT();
  const { environment, scope } = useSettingsScope();
  if (scope.kind !== "environment" || !environment) {
    return (
      <SettingsSection title={gt("OpenTelemetry export")} id="telemetry-export">
        <SettingsScopeNotice target="environment">
          {gt("Choose one environment to configure its telemetry exports.")}
        </SettingsScopeNotice>
      </SettingsSection>
    );
  }
  return <TelemetryExportForm key={environment.environmentId} />;
}

function TelemetryExportForm() {
  const messages = useMessages();
  const gt = useGT();
  const { environment } = useSettingsScope();
  const saved = useScopedSettings((settings) => settings.observability);
  const [draft, setDraft] = useState<Partial<typeof saved>>({});
  const [message, setMessage] = useState<string | null>(null);
  const environmentId = environment?.environmentId;
  const canEdit = useAtomValue(
    serverEnvironment.checkOtlpEndpoint.permissionAtom(environmentId ?? null),
  );
  const canCheck =
    canEdit && environment?.serverConfig?.environment.capabilities.otlpEndpointCheck === true;
  const running = environment?.serverConfig?.observability;
  const [checks, setChecks] = useState<Partial<Record<SignalKey, EndpointCheck>>>(() =>
    Object.fromEntries(
      SIGNALS.flatMap((descriptor) => {
        const url = runningOverride(running, descriptor)?.url ?? saved[descriptor.key];
        return isHttpUrl(url) ? [[descriptor.key, { url, result: null }]] : [];
      }),
    ),
  );
  const updateSettings = useAtomCommand(serverEnvironment.updateSettings, { reportFailure: true });
  const checkOtlpEndpoint = useAtomCommand(serverEnvironment.checkOtlpEndpoint);
  const values = { ...saved, ...draft };

  const commit = async () => {
    if (!environment) return;
    const committed = Object.fromEntries(
      SIGNALS.flatMap(({ key }) => {
        const url = values[key].trim();
        return url !== saved[key] && (url === "" || isHttpUrl(url)) ? [[key, url]] : [];
      }),
    );
    if (SIGNALS.some(({ key }) => values[key].trim() !== "" && !isHttpUrl(values[key].trim())))
      setMessage(gt("Enter an HTTP or HTTPS endpoint, or leave it empty to turn export off."));
    if (Object.keys(committed).length === 0) return;
    setMessage(gt("Saving…"));
    const result = await updateSettings({
      environmentId: environment.environmentId,
      input: { patch: { observability: committed } },
    });
    if (result._tag !== "Success") return setMessage(null);
    // Keep anything typed while the save ran.
    setDraft((previous) =>
      Object.fromEntries(
        Object.entries(previous).filter(([key, value]) => value.trim() !== committed[key]),
      ),
    );
    setMessage(gt("Saved. Restart the server to apply."));
  };

  const sendCheck = async (key: SignalKey, signal: OtlpSignal, attempt: EndpointCheck) => {
    if (!environmentId) return;
    const { url } = attempt;
    const response = await checkOtlpEndpoint({ environmentId, input: { signal, url } });
    setChecks((previous) => {
      if (previous[key] !== attempt) return previous;
      const next = { ...previous };
      if (response._tag === "Success") next[key] = { url, result: response.value };
      else delete next[key];
      return next;
    });
  };

  const checkEndpoint = (key: SignalKey, signal: OtlpSignal, url: string) => {
    if (!isHttpUrl(url)) return;
    const attempt = { url, result: null };
    setChecks((previous) => ({ ...previous, [key]: attempt }));
    void sendCheck(key, signal, attempt);
  };

  const sendPendingChecks = useEffectEvent(() => {
    for (const { key, signal } of SIGNALS) {
      const check = checks[key];
      if (check?.result === null) void sendCheck(key, signal, check);
    }
  });
  // oxlint-disable-next-line t3code/no-unreasoned-state-sync -- sends pending endpoint check requests once the environment can run them
  useEffect(() => {
    // oxlint-disable-next-line react/set-state-in-effect -- State changes only after the response arrives.
    if (canCheck) sendPendingChecks();
  }, [canCheck]);

  return (
    <SettingsSection title={gt("OpenTelemetry export")} id="telemetry-export">
      <form
        className="grid gap-4 px-4 py-4 sm:px-5"
        onSubmit={(event) => {
          event.preventDefault();
          void commit();
        }}
      >
        <p className="text-xs text-muted-foreground">
          <T>
            Send traces, metrics, and logs to an OTLP HTTP receiver. Restart the server to apply.
            Environment variables override these settings.
          </T>
        </p>
        {!canEdit && (
          <p className="text-xs text-muted-foreground">
            {environment
              ? gt("This connection lacks permission to change settings on {environment}.", {
                  environment: environment.label,
                })
              : gt(
                  "This connection lacks permission to change settings on the selected environment.",
                )}
          </p>
        )}
        {SIGNALS.map((descriptor) => {
          const { key, label, signal } = descriptor;
          const override = runningOverride(running, descriptor, messages);
          const url = override?.url ?? values[key].trim();
          const check = canCheck ? endpointStatus(url, checks[key], messages) : null;
          const status = override
            ? {
                label: check ? `${override.label} · ${check.label}` : override.label,
                dot: check?.dot ?? "bg-muted-foreground/40",
              }
            : check;
          return (
            <div key={key} className="grid gap-1.5">
              <div className="flex items-center justify-between gap-3">
                <div className="flex items-center gap-1.5">
                  {status && <ConnectionStatusDot dotClassName={status.dot} />}
                  <Label htmlFor={key}>{messages(label)}</Label>
                </div>
                {status && <span className="text-xs text-muted-foreground">{status.label}</span>}
              </div>
              <div className="flex gap-2">
                <Input
                  id={key}
                  size="sm"
                  type="url"
                  pattern="[Hh][Tt][Tt][Pp][Ss]?://.*"
                  title={gt("Enter an HTTP or HTTPS endpoint, or leave empty to disable export.")}
                  placeholder={`http://localhost:4318/v1/${signal}`}
                  value={values[key]}
                  disabled={!canEdit}
                  onChange={(event) => {
                    const value = event.target.value;
                    // Clear restored drafts so later saves cannot overwrite another client's changes.
                    setDraft((previous) => {
                      const next = { ...previous, [key]: value };
                      if (value.trim() === saved[key]) delete next[key];
                      return next;
                    });
                    setMessage(null);
                  }}
                  onBlur={() => void commit()}
                />
                {canCheck && (
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    disabled={
                      !isHttpUrl(url) || (checks[key]?.url === url && checks[key].result === null)
                    }
                    onClick={() => void checkEndpoint(key, signal, url)}
                  >
                    <T>Test</T>
                  </Button>
                )}
              </div>
              {(saved[key] !== (running?.[key] ?? "") || override?.variable) && (
                <p className="break-all text-xs text-muted-foreground">
                  {override?.variable ? (
                    running?.[key] ? (
                      <T>
                        Running: <Var>{running[key]}</Var> from{" "}
                        <code className="font-mono">
                          <Var>{override.variable}</Var>
                        </code>
                      </T>
                    ) : (
                      <T>
                        Running: Disabled from{" "}
                        <code className="font-mono">
                          <Var>{override.variable}</Var>
                        </code>
                      </T>
                    )
                  ) : running?.[key] ? (
                    gt("Running: {url}", { url: running[key] })
                  ) : (
                    gt("Running: Disabled")
                  )}
                </p>
              )}
            </div>
          );
        })}
        <p role="status" className="text-xs text-muted-foreground">
          {message}
        </p>
      </form>
    </SettingsSection>
  );
}
