import type { EnvironmentId } from "@t3tools/contracts";
import { squashAtomCommandFailure } from "@t3tools/client-runtime/state/runtime";
import { useState } from "react";

import { buildWorkItems, useBuildHome } from "../../state/buildWorkItems";
import { useAtomCommand } from "../../state/use-atom-command";
import { Button } from "../ui/button";
import { Input } from "../ui/input";
import { Label } from "../ui/label";
import { toastManager } from "../ui/toast";
import { SecretInput } from "./SecretInput";

const STATUS_TEXT = {
  not_connected: "Not connected.",
  invalid_token: "HQ refused the saved token: it expired or was revoked. Paste a new one.",
  unavailable: "Saved. HQ could not be reached just now.",
  ready: "Connected.",
} as const;

/**
 * The person's decision token for the Build button. It is pasted here once and goes to the server's
 * secret store; nothing reads it back, so this only ever shows whether one is set.
 */
export function BuildDecisionsSettings({
  environmentId,
}: {
  readonly environmentId: EnvironmentId;
}) {
  const query = useBuildHome(environmentId);
  const connect = useAtomCommand(buildWorkItems.homeConnect, { reportFailure: false });
  const disconnect = useAtomCommand(buildWorkItems.homeDisconnect, { reportFailure: false });
  const [endpoint, setEndpoint] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(false);
  const state = query.data ?? undefined;
  const isSet = state !== undefined && state.status !== "not_connected";

  const run = async (action: "connect" | "disconnect") => {
    setBusy(true);
    const result =
      action === "connect"
        ? await connect({ environmentId, input: { endpoint, token } })
        : await disconnect({ environmentId, input: {} });
    setBusy(false);
    if (result._tag === "Success") {
      setEndpoint("");
      setToken("");
      return query.refresh();
    }
    const error = squashAtomCommandFailure(result);
    toastManager.add({
      type: "error",
      title: "Could not save Build decisions",
      description: error instanceof Error ? error.message : "An error occurred.",
    });
  };

  return (
    <form
      className="grid gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        if (endpoint.trim() && token.trim()) void run("connect");
      }}
    >
      <fieldset disabled={busy} className="contents">
        <p className="max-w-2xl text-xs leading-relaxed text-muted-foreground">
          Lets the Build button in a thread accept or send back Specs as you. In HQ, open Settings →
          Connections → T3 decisions and copy its two lines. T3 keeps the token on the server;
          agents never see it.
        </p>
        <div className="grid gap-1.5">
          <Label htmlFor={`build-decisions-endpoint-${environmentId}`}>Decisions endpoint</Label>
          <Input
            id={`build-decisions-endpoint-${environmentId}`}
            autoComplete="off"
            size="sm"
            placeholder="https://hq.example/api/build/decisions"
            value={endpoint}
            onChange={(event) => setEndpoint(event.target.value)}
          />
        </div>
        <div className="grid gap-1.5">
          <Label htmlFor={`build-decisions-token-${environmentId}`}>Decision token</Label>
          <SecretInput
            id={`build-decisions-token-${environmentId}`}
            size="sm"
            configured={isSet}
            value={token}
            onChange={(event) => setToken(event.target.value)}
          />
        </div>
        <div className="flex items-center justify-between gap-3">
          <p className="text-xs text-muted-foreground">
            {state === undefined ? "Checking…" : STATUS_TEXT[state.status]}
            {isSet && state?.origin ? ` ${state.origin}` : ""}
          </p>
          <div className="flex shrink-0 gap-2">
            {isSet ? (
              <Button size="xs" variant="outline" onClick={() => void run("disconnect")}>
                Remove
              </Button>
            ) : null}
            <Button type="submit" size="xs" disabled={!endpoint.trim() || !token.trim()}>
              Save
            </Button>
          </div>
        </div>
      </fieldset>
    </form>
  );
}
