import type { BuildConnectionReadResult } from "@t3tools/contracts";

export interface HqConnectionView {
  readonly connected: boolean;
  readonly waiting: boolean;
  /** Weave rejected the stored delegation, so it works no longer although it is still stored. */
  readonly refused: boolean;
  /** One line under the title; a refused or declined sign-in is explained, never silent. */
  readonly description: string;
}

const FAILURE_TEXT = {
  expired: "The sign-in took too long. Try again.",
  rejected: "Weave did not accept that sign-in. Try again.",
  no_access: "Your Weave account no longer has access to connect T3.",
  unavailable: "T3 could not reach Weave to finish connecting. Try again shortly.",
  invalid_response: "Weave answered in a way T3 did not expect. Try again.",
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
      ? `Weave no longer accepts T3's connection to ${connection.origin ?? "Weave"}. Reconnect to restore it.`
      : `Connected to ${connection?.origin ?? "Weave"}.`;
  if (waiting)
    return {
      connected,
      waiting,
      refused,
      description: "Finish signing in to Weave in your browser. This page updates when you do.",
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
      : "Not connected. Sign in to let agents in your threads act in Weave.",
  };
}

/** The origin Weave should send the browser back to: how this client reaches the environment. */
export function handbackOriginOf(httpBaseUrl: string): string | null {
  try {
    return new URL(httpBaseUrl).origin;
  } catch {
    return null;
  }
}
