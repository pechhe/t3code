/** The settings Blackhole's compaction, memory and recall read, at pi-blackhole 0.5.19's defaults. */
export const BLACKHOLE_DEFAULTS = {
  observeAfterTokens: 15_000,
  reflectAfterTokens: 25_000,
  observationsPoolMaxTokens: 20_000,
  reflectionsPoolMaxTokens: 8_000,
  observationsPoolTargetTokens: 10_000,
  fullFoldAlways: true,
  reflectionTimestamps: true,
  reflectionSupersedes: false,
  reflectorInputMaxTokens: 80_000,
  dropperInputMaxTokens: 80_000,
  dropperPressureThreshold: 0.7,
  dropperPoolFullnessThreshold: 0.1,
  observerChunkMaxTokens: 40_000,
  observerPreambleMaxTokens: 0,
  agentMaxTurns: 16,
  recallResponseMaxChars: 48_000,
} as const;

export type BlackholeConfig = {
  -readonly [K in keyof typeof BLACKHOLE_DEFAULTS]: (typeof BLACKHOLE_DEFAULTS)[K] extends boolean
    ? boolean
    : number;
};
