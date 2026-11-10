import { RetiredWriterRole } from "@t3tools/contracts";

/**
 * The JSON texts a delegation request could have been fingerprinted from before `demanding`
 * was retired: decoding now drops the flag, but a task saved with it keeps that fingerprint.
 * It sat in `agentTask` just before `readOnly` and `authorModel`, so restoring it there
 * reproduces the old text, and a retry with or without it still matches its task.
 */
function withRetiredDemanding(json: string): ReadonlyArray<string> {
  const request = JSON.parse(json) as { readonly agentTask?: Record<string, unknown> };
  const task = request.agentTask;
  if (task === undefined) return [json];
  const restore = (value: boolean) => {
    const entries = Object.entries(task);
    const at = entries.findIndex(([key]) => key === "readOnly" || key === "authorModel");
    entries.splice(at === -1 ? entries.length : at, 0, ["demanding", value]);
    return JSON.stringify({ ...request, agentTask: Object.fromEntries(entries) });
  };
  return [json, restore(true), restore(false)];
}

/**
 * Every JSON text a delegation request could have been fingerprinted from before its retired
 * fields and names: the request's own text first. An `implementer` task may have been saved
 * under one of the writing roles it replaced, which decoding now renames.
 */
export function withRetiredFields(json: string): ReadonlyArray<string> {
  const request = JSON.parse(json) as { readonly agentTask?: Record<string, unknown> };
  const task = request.agentTask;
  if (task?.role !== "implementer") return withRetiredDemanding(json);
  return [
    ...withRetiredDemanding(json),
    ...RetiredWriterRole.literals.flatMap((role) =>
      withRetiredDemanding(JSON.stringify({ ...request, agentTask: { ...task, role } })),
    ),
  ];
}
