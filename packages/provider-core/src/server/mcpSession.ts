import type { EnvironmentId, ProviderInstanceId, ThreadId } from "@t3tools/contracts";

export interface McpProviderSessionConfig {
  readonly environmentId: EnvironmentId;
  readonly threadId: ThreadId;
  readonly providerSessionId: string;
  readonly providerInstanceId: ProviderInstanceId;
  readonly endpoint: string;
  readonly authorizationHeader: string;
  /**
   * Adapters read it to keep developer instructions truthful: when the user
   * withholds agent browser access, the prompt must not advertise `preview_*`
   * tools that every call would reject.
   */
  readonly browserToolsAvailable: boolean;
  /**
   * Set for a managed browser task. Its endpoint serves only Phi's browser operations, so a
   * managed task may attach it while no other T3 tool reaches the task.
   */
  readonly managedBrowser?: boolean;
  /**
   * A delegated child: it lists only its own work family and the leaf tools, and
   * is told so instead of the parent's orchestration sections.
   */
  readonly delegated?: boolean;
  /** The thread's listing carries the preview family. */
  readonly listsPreview?: boolean;
  /** The thread's listing carries the device family. */
  readonly listsDevice?: boolean;
  /** The thread's listing carries the html tools. */
  readonly listsHtml?: boolean;
  /** Capabilities the credential grants ("preview", "device"). */
  readonly capabilities?: ReadonlySet<string>;
  readonly agentDeviceEnvironment?: Readonly<Record<string, string>>;
}

export function withAgentDeviceEnvironment(
  base: NodeJS.ProcessEnv,
  config: Pick<McpProviderSessionConfig, "agentDeviceEnvironment"> | undefined,
): NodeJS.ProcessEnv {
  const extra = config?.agentDeviceEnvironment;
  if (!extra) return base;
  const separator = extra.PATH_SEPARATOR ?? ":";
  const basePath = base.PATH ?? base.Path;
  const { PATH: shimDir, PATH_SEPARATOR: _separator, ...rest } = extra;
  return {
    ...base,
    ...rest,
    ...(shimDir ? { PATH: basePath ? `${shimDir}${separator}${basePath}` : shimDir } : {}),
  };
}
