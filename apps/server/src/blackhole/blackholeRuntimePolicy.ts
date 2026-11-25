import { blackholeCompactPoint, nativeBackstopPoint } from "@t3tools/shared/blackholeCompactPoint";
import type { BlackholeSettings } from "@t3tools/contracts";

import { blackholeCompacts } from "./BlackholeService.ts";

/**
 * The harness's own compact point. On a thread Blackhole compacts, it moves past Blackhole's
 * point, so it only rescues a turn that overruns the window before a turn boundary.
 */
export function blackholeCompactPolicy(input: {
  readonly blackhole: BlackholeSettings | undefined;
  readonly driver: string | undefined;
  readonly compactAt: number | null | undefined;
  readonly windowTokens: number | undefined;
}): number | null | undefined {
  if (
    input.blackhole === undefined ||
    input.driver === undefined ||
    !blackholeCompacts(input.blackhole, input.driver)
  )
    return input.compactAt;
  const point = blackholeCompactPoint({
    compactAt: input.compactAt,
    windowTokens: input.windowTokens,
  });
  return point === undefined
    ? input.compactAt
    : nativeBackstopPoint({ blackholePoint: point, windowTokens: input.windowTokens });
}
