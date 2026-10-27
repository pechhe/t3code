import type { EnvironmentId } from "@t3tools/contracts";
import { useEffect } from "react";

import { ensureLocalApi } from "../../localApi";
import { useEnvironmentHttpBaseUrl, useEnvironments } from "../../state/environments";
import { useEnvironmentQuery } from "../../state/query";
import { forgeWorkItems } from "../../state/forgeWorkItems";
import { useAtomCommand } from "../../state/use-atom-command";
import { toastManager } from "../ui/toast";
import { Button } from "../ui/button";
import { SettingsRow, SettingsSection } from "./settingsLayout";
import { describeHqConnection, handbackOriginOf } from "./HqConnectionSettings.logic";

/** While Weave's page is open, so the result shows without a reload; the server ends it after ten minutes. */
const SIGN_IN_POLL_MS = 2_000;

function HqConnectionRow({
  environmentId,
  label,
  showLabel,
}: {
  readonly environmentId: EnvironmentId;
  readonly label: string;
  readonly showLabel: boolean;
}) {
  const connection = useEnvironmentQuery(forgeWorkItems.connection({ environmentId, input: {} }));
  const httpBaseUrl = useEnvironmentHttpBaseUrl(environmentId);
  const start = useAtomCommand(forgeWorkItems.signInStart, { label: "Connect to Weave" });
  const disconnect = useAtomCommand(forgeWorkItems.disconnect, { label: "Disconnect from Weave" });
  const view = describeHqConnection(connection.data);
  const { refresh } = connection;

  useEffect(() => {
    if (!view.waiting) return;
    const timer = setInterval(refresh, SIGN_IN_POLL_MS);
    return () => clearInterval(timer);
  }, [view.waiting, refresh]);

  const connect = async () => {
    const handbackOrigin = httpBaseUrl === null ? null : handbackOriginOf(httpBaseUrl);
    if (handbackOrigin === null) return;
    // Browsers block a tab opened after an await, so the web build reserves one first.
    const reserved = window.desktopBridge ? null : window.open("", "_blank");
    if (reserved) reserved.opener = null;
    const result = await start({ environmentId, input: { handbackOrigin } });
    if (result._tag !== "Success") {
      reserved?.close();
      return;
    }
    try {
      if (reserved) reserved.location.href = result.value.url;
      else await ensureLocalApi().shell.openExternal(result.value.url);
    } catch {
      reserved?.close();
      toastManager.add({
        type: "error",
        title: "Could not open the Weave sign-in page",
        description: "Allow pop-ups for T3, then choose Connect to Weave again.",
      });
    }
    refresh();
  };

  return (
    <SettingsRow
      title={showLabel ? `Connect to Weave · ${label}` : "Connect to Weave"}
      description={view.description}
      control={
        <div className="flex gap-2">
          <Button
            size="xs"
            variant={view.connected && !view.refused ? "outline" : "default"}
            disabled={httpBaseUrl === null}
            onClick={() => void connect()}
          >
            {view.waiting ? "Open Weave again" : view.connected ? "Reconnect" : "Connect to Weave"}
          </Button>
          {view.connected ? (
            <Button
              size="xs"
              variant="outline"
              onClick={() =>
                void disconnect({ environmentId, input: {} }).then(() => connection.refresh())
              }
            >
              Disconnect
            </Button>
          ) : null}
        </div>
      }
    />
  );
}

/** Weave is connected per environment: the one that starts the sign-in receives the result. */
export function HqConnectionSettings() {
  const { environments } = useEnvironments();
  return (
    <SettingsSection id="hq" title="Weave">
      {environments.map((environment) => (
        <HqConnectionRow
          key={environment.environmentId}
          environmentId={environment.environmentId}
          label={environment.label}
          showLabel={environments.length > 1}
        />
      ))}
    </SettingsSection>
  );
}
