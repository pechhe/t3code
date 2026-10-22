import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";

/**
 * The host's last word on a command before an agent runs it, such as a repository's
 * own branch guard. Drivers answer it where their own protocol gives them a point
 * before execution; a repository with no policy must cost nothing, so a driver can
 * ask {@link CommandGuardService.governs} first.
 *
 * The port lives here rather than in the app so a provider package can call it
 * without depending on the server.
 */
export interface CommandGuardDecision {
  readonly allowed: boolean;
  /** The guard's own message when it refused the command. */
  readonly reason: string | null;
}

export class CommandGuard extends Context.Service<
  CommandGuard,
  {
    readonly check: (input: {
      readonly cwd: string;
      readonly command: string;
    }) => Effect.Effect<CommandGuardDecision>;
    readonly governs: (cwd: string) => Effect.Effect<boolean>;
  }
>()("@t3tools/provider-core/server/commandGuard") {}

/**
 * Asks the host's guard, when there is one, whether one command may run. A call with
 * no guard installed, or whose guard cannot answer, allows the command: an unguarded
 * repository must never be blocked by the check itself.
 */
export const guardCommand = (input: { readonly cwd: string; readonly command: string }) =>
  Effect.serviceOption(CommandGuard).pipe(
    Effect.flatMap((guard): Effect.Effect<CommandGuardDecision> =>
      Option.isNone(guard)
        ? Effect.succeed({ allowed: true, reason: null })
        : guard.value
            .check(input)
            .pipe(Effect.orElseSucceed(() => ({ allowed: true, reason: null }) as const)),
    ),
  );
