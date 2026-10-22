import type { BuildConnectionReadResult } from "@t3tools/contracts";

export interface HqConnectionView {
  readonly connected: boolean;
  readonly waiting: boolean;
  /** HQ rejected the stored delegation, so it works no longer although it is still stored. */
  readonly refused: boolean;
  /** One line under the title; a refused or declined sign-in is explained, never silent. */
  readonly description: string;
}

const FAILURE_TEXT = {
  expired: "The sign-in took too long. Try again.",
  rejected: "HQ did not accept that sign-in. Try again.",
  no_access: "Your HQ account no longer has access to connect T3.",
  unavailable: "T3 could not reach HQ to finish connecting. Try again shortly.",
  invalid_response: "HQ answered in a way T3 did not expect. Try again.",
} as const;

export function describeHqConnection(
  connection: Pick<BuildConnectionReadResult, "connected" | "origin" | "signIn" | "refused"> | null,
): HqConnectionView {
  const signIn = connection?.signIn ?? null;
  const waiting = signIn?.status === "pending";
  const connected = connection?.connected === true;
  const refused = connected && connection?.refused === true;
  const connectedText =
    connection?.refused === true
      ? `HQ no longer accepts T3's connection to ${connection.origin ?? "HQ"}: it was revoked or has expired. Reconnect to restore it.`
      : `Connected to ${connection?.origin ?? "HQ"}.`;
  if (waiting)
    return {
      connected,
      waiting,
      refused,
      description: "Finish signing in to HQ in your browser. This page updates when you do.",
    };
  const prefix = connected ? `${connectedText} ` : "";
  if (signIn?.status === "cancelled")
    return {
      connected,
      waiting,
      refused,
      description: `${prefix}Connecting was cancelled${connected ? ", so the existing connection is unchanged." : "."}`,
    };
  if (signIn?.status === "failed")
    return {
      connected,
      waiting,
      refused,
      description: `${prefix}${FAILURE_TEXT[signIn.reason ?? "rejected"]}`,
    };
  return {
    connected,
    waiting,
    refused,
    description: connected
      ? connectedText
      : "Not connected. Sign in to let agents in your threads act in HQ.",
  };
}

/** The origin HQ should send the browser back to: how this client reaches the environment. */
export function handbackOriginOf(httpBaseUrl: string): string | null {
  try {
    return new URL(httpBaseUrl).origin;
  } catch {
    return null;
  }
}
