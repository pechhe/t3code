/** Current names first; retained aliases keep saved connections and running agents usable. */
export const WEAVE_NAMES = {
  servers: ["weave", "yardsmith-hq"],
  connectionTools: ["t3_weave_connection", "t3_hq_connection"],
  connectionStores: ["weave-connection", "hq-connection"],
  forgePrefixes: ["weave_forge_", "hq_forge_", "hq_build_"],
} as const;
