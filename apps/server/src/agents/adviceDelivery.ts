import type { OrchestratorMcpAdvice } from "@t3tools/contracts";

export const adviceVersion = (requests: ReadonlyArray<OrchestratorMcpAdvice>) =>
  requests
    .map((request) => `${encodeURIComponent(request.requestId)}:${request.status}`)
    .sort()
    .join(",");
