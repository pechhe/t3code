import type { CorpusCase } from "./corpusTypes.ts";

export const TUNE_CASES: ReadonlyArray<CorpusCase> = [
  {
    id: "t-comment-1",
    split: "tune",
    category: "comment-accuracy",
    stratum: "clear-positive",
    authorLabel: "defect",
    authorNote: "Timeout changed, comment still says 10 seconds.",
    evidence: `--- a/src/http/client.ts
+++ b/src/http/client.ts
@@
-// Give up after 10 seconds.
-const REQUEST_TIMEOUT_MS = 10_000;
+// Give up after 10 seconds.
+const REQUEST_TIMEOUT_MS = 45_000;`,
  },
  {
    id: "t-comment-2",
    split: "tune",
    category: "comment-accuracy",
    stratum: "tricky-negative",
    authorLabel: "ok",
    authorNote: "Obvious but accurate comment.",
    evidence: `--- a/src/list.ts
+++ b/src/list.ts
@@
 export function lastItem<T>(items: ReadonlyArray<T>): T | undefined {
-  return items[items.length - 1];
+  // Return the last element, or undefined when the list is empty.
+  return items.at(-1);
 }`,
  },
  {
    id: "t-name-1",
    split: "tune",
    category: "name-side-effect",
    stratum: "clear-positive",
    authorLabel: "defect",
    authorNote: "A getter that deletes records.",
    evidence: `export function getExpiredSessions(db: Db, now: number): Session[] {
  const expired = db.sessions.filter((s) => s.expiresAt < now);
  for (const s of expired) db.sessions.delete(s.id);
  return expired;
}`,
  },
  {
    id: "t-name-2",
    split: "tune",
    category: "name-side-effect",
    stratum: "tricky-negative",
    authorLabel: "ok",
    authorNote: "Name states the creation side effect.",
    evidence: `export function ensureLogDirectory(root: string): string {
  const dir = join(root, "logs");
  mkdirSync(dir, { recursive: true });
  return dir;
}`,
  },
  {
    id: "t-error-1",
    split: "tune",
    category: "error-actionability",
    stratum: "clear-positive",
    authorLabel: "defect",
    authorNote: "Generic message, no context.",
    evidence: `function loadProfile(path: string) {
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("Error");
  }
}`,
  },
  {
    id: "t-error-2",
    split: "tune",
    category: "error-actionability",
    stratum: "tricky-negative",
    authorLabel: "ok",
    authorNote: "Names the value and the fix.",
    evidence: `if (!SUPPORTED_REGIONS.has(region)) {
  throw new Error(
    \`Unsupported region "\${region}". Use one of: \${[...SUPPORTED_REGIONS].join(", ")}.\`,
  );
}`,
  },
  {
    id: "t-assert-1",
    split: "tune",
    category: "assertion-weakening",
    stratum: "clear-positive",
    authorLabel: "defect",
    authorNote: "Exact check replaced by existence check.",
    evidence: `--- a/src/price.test.ts
+++ b/src/price.test.ts
@@
 it("applies the discount", () => {
-  expect(applyDiscount(200, 0.25)).toBe(150);
+  expect(applyDiscount(200, 0.25)).toBeTruthy();
 });`,
  },
  {
    id: "t-assert-2",
    split: "tune",
    category: "assertion-weakening",
    stratum: "tricky-negative",
    authorLabel: "ok",
    authorNote: "Stricter matcher, same expectation.",
    evidence: `--- a/src/user.test.ts
+++ b/src/user.test.ts
@@
 it("returns the user", () => {
-  expect(getUser("u1")).toEqual({ id: "u1", name: "Ada" });
+  expect(getUser("u1")).toStrictEqual({ id: "u1", name: "Ada" });
 });`,
  },
  {
    id: "t-smell-1",
    split: "tune",
    category: "code-smell",
    stratum: "clear-positive",
    authorLabel: "defect",
    authorNote: "One function parses, charges, persists and emails.",
    evidence: `export async function checkout(req: Request) {
  const body = JSON.parse(await req.text());
  if (!body.items?.length) return new Response("empty", { status: 400 });
  const total = body.items.reduce((n: number, i: Item) => n + i.price * i.qty, 0);
  const charge = await stripe.charges.create({ amount: total, source: body.token });
  await db.orders.insert({ id: charge.id, total, items: body.items });
  await mailer.send(body.email, "Receipt", renderReceipt(body.items, total));
  await analytics.track("checkout", { total });
  await warehouse.reserve(body.items);
  return new Response(JSON.stringify({ id: charge.id }));
}`,
  },
  {
    id: "t-smell-2",
    split: "tune",
    category: "code-smell",
    stratum: "tricky-negative",
    authorLabel: "ok",
    authorNote: "Long but one cohesive responsibility (a reducer).",
    evidence: `export function cartReducer(state: Cart, action: CartAction): Cart {
  switch (action.type) {
    case "add": return { ...state, items: [...state.items, action.item] };
    case "remove": return { ...state, items: state.items.filter((i) => i.id !== action.id) };
    case "clear": return { ...state, items: [] };
    case "setQty": return { ...state, items: state.items.map((i) => (i.id === action.id ? { ...i, qty: action.qty } : i)) };
    case "applyCoupon": return { ...state, coupon: action.code };
    case "removeCoupon": return { ...state, coupon: undefined };
    default: return state;
  }
}`,
  },
];
