// T3 hands every worker its own agentLoop (../worker.ts), so pi-ai's stream function is never called.
export const streamSimple = (): never => {
  throw new Error("Blackhole workers in T3 run through T3's text generation, not pi-ai.");
};
