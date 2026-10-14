import type { ContextRolloverSettings } from "@t3tools/contracts";

type RolloverBaseline = { soft: number; hard: number };
export function experimentRolloverBaseline(
  settings: ContextRolloverSettings,
  models: readonly string[],
): RolloverBaseline | null {
  if (!settings.enabled) return null;
  const policies =
    models.length > 0
      ? models.map((model) => {
          const rule = settings.modelRules.find((candidate) =>
            model.toLowerCase().includes(candidate.modelPattern.toLowerCase()),
          );
          return rule
            ? rule.enabled
              ? { soft: rule.softThreshold, hard: rule.hardThreshold }
              : null
            : { soft: settings.softThreshold, hard: settings.hardThreshold };
        })
      : [
          { soft: settings.softThreshold, hard: settings.hardThreshold },
          ...settings.modelRules.map((rule) =>
            rule.enabled ? { soft: rule.softThreshold, hard: rule.hardThreshold } : null,
          ),
        ];
  const first = policies[0];
  return first &&
    policies.every(
      (policy) => policy !== null && policy.soft === first.soft && policy.hard === first.hard,
    )
    ? first
    : null;
}
