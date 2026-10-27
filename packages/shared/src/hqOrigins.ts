/**
 * Where Weave, answers. It moved from `hq.yardsmith.co.uk` to
 * `weave.yardsmith.co.uk` on 2026-10-22 (pechhe/yardsmith YS-287): the old address only redirects,
 * and Weave's issuer and resource are the new one, so a delegation made for the old address is
 * refused. One module owns this so the connection store, the sign-in service and Forge links agree.
 */
export const DEFAULT_HQ_ORIGIN = "https://weave.yardsmith.co.uk";

/** Addresses Weave answered on before the move. They are the same service as the default. */
const LEGACY_HQ_ORIGINS: ReadonlySet<string> = new Set(["https://hq.yardsmith.co.uk"]);

/** The address Weave answers on now, for a link, connection or record made at any of its addresses. */
export const currentHqOrigin = (origin: string): string =>
  LEGACY_HQ_ORIGINS.has(origin) ? DEFAULT_HQ_ORIGIN : origin;

/** Whether two addresses are the same Weave: one it has moved from is still the same service. */
export const sameHqAddress = (left: string, right: string): boolean =>
  currentHqOrigin(left) === currentHqOrigin(right);
