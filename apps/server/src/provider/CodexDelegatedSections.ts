import { T3_CODE_ORCHESTRATION_SECTIONS } from "@t3tools/provider-core/server/orchestrationInstructions";
import {
  T3_CODE_CHILD_HTML_SECTION,
  T3_CODE_CHILD_PREVIEW_SECTION,
  T3_CODE_CHILD_SECTIONS,
  DELEGATING_CHILD_SECTION,
} from "@t3tools/provider-core/server/delegatedChildInstructions";

import type { T3CodeToolAvailability } from "./CodexDeveloperInstructions.ts";

/** A delegated thread gets the child sections, trimmed to the tools its listing carries. */
export const orchestrationSections = (
  availability: T3CodeToolAvailability,
  delegated: boolean,
): ReadonlyArray<string> =>
  delegated
    ? [
        ...T3_CODE_CHILD_SECTIONS,
        DELEGATING_CHILD_SECTION,
        ...(availability.html === false ? [] : [T3_CODE_CHILD_HTML_SECTION]),
        ...(availability.browser ? [T3_CODE_CHILD_PREVIEW_SECTION] : []),
      ]
    : T3_CODE_ORCHESTRATION_SECTIONS;
