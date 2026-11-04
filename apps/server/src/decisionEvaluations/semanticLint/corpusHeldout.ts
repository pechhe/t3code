import type { CorpusCase } from "./corpusTypes.ts";

type Held = Omit<CorpusCase, "split">;
const held = (cases: ReadonlyArray<Held>): ReadonlyArray<CorpusCase> =>
  cases.map((c) => ({ ...c, split: "heldout" as const }));

export const HELDOUT_CASES: ReadonlyArray<CorpusCase> = held([
  // comment-accuracy
  {
    id: "h-comment-1",
    category: "comment-accuracy",
    stratum: "clear-positive",
    authorLabel: "defect",
    authorNote: "Retry count changed, comment says 3.",
    evidence: `--- a/src/sync/upload.ts
+++ b/src/sync/upload.ts
@@
 // Retry up to 3 times before surfacing the failure.
-const MAX_ATTEMPTS = 3;
+const MAX_ATTEMPTS = 5;`,
  },
  {
    id: "h-comment-2",
    category: "comment-accuracy",
    stratum: "clear-positive",
    authorLabel: "defect",
    authorNote: "Doc claims a throw; code now returns undefined.",
    evidence: `--- a/src/users/find.ts
+++ b/src/users/find.ts
@@
 /**
  * Look up a user by id.
  * Throws NotFoundError when no user has that id.
  */
-export function findUser(db: Db, id: string): User {
-  const user = db.users.get(id);
-  if (!user) throw new NotFoundError(id);
-  return user;
-}
+export function findUser(db: Db, id: string): User | undefined {
+  return db.users.get(id);
+}`,
  },
  {
    id: "h-comment-3",
    category: "comment-accuracy",
    stratum: "clear-positive",
    authorLabel: "defect",
    authorNote: "TTL constant is now an hour, comment says five minutes.",
    evidence: `--- a/src/cache/tokens.ts
+++ b/src/cache/tokens.ts
@@
 // Tokens stay cached for 5 minutes.
-const TOKEN_TTL_MS = 5 * 60 * 1000;
+const TOKEN_TTL_MS = 60 * 60 * 1000;`,
  },
  {
    id: "h-comment-4",
    category: "comment-accuracy",
    stratum: "tricky-negative",
    authorLabel: "ok",
    authorNote: "Obvious comment, still accurate.",
    evidence: `--- a/src/metrics/counter.ts
+++ b/src/metrics/counter.ts
@@
 export function record(name: string) {
-  counts.set(name, (counts.get(name) ?? 0) + 1);
+  // Increment the counter for this name.
+  counts.set(name, (counts.get(name) ?? 0) + 1);
 }`,
  },
  {
    id: "h-comment-5",
    category: "comment-accuracy",
    stratum: "tricky-negative",
    authorLabel: "ok",
    authorNote: "Comment updated together with the code.",
    evidence: `--- a/src/sync/upload.ts
+++ b/src/sync/upload.ts
@@
-// Retry up to 3 times before surfacing the failure.
-const MAX_ATTEMPTS = 3;
+// Retry up to 5 times before surfacing the failure.
+const MAX_ATTEMPTS = 5;`,
  },
  {
    id: "h-comment-6",
    category: "comment-accuracy",
    stratum: "tricky-negative",
    authorLabel: "ok",
    authorNote: "Refactor keeps the documented ordering.",
    evidence: `--- a/src/feed/order.ts
+++ b/src/feed/order.ts
@@
 // Oldest first: sorted ascending by createdAt.
 export function orderFeed(items: FeedItem[]): FeedItem[] {
-  return [...items].sort((a, b) => a.createdAt - b.createdAt);
+  return items.toSorted((a, b) => a.createdAt - b.createdAt);
 }`,
  },
  {
    id: "h-comment-7",
    category: "comment-accuracy",
    stratum: "boundary",
    authorLabel: "uncertain",
    authorNote: "Whether the claim holds depends on code outside the shown change.",
    evidence: `--- a/src/jobs/prune.ts
+++ b/src/jobs/prune.ts
@@
 // Only called from the nightly scheduler, so it may block for a while.
 export function pruneOldJobs(db: Db) {
-  db.jobs.deleteWhere((j) => j.finishedAt < daysAgo(30));
+  db.jobs.deleteWhere((j) => j.finishedAt < daysAgo(RETENTION_DAYS));
 }
(The diff shows no call sites; RETENTION_DAYS is defined elsewhere.)`,
  },

  // name-side-effect
  {
    id: "h-name-1",
    category: "name-side-effect",
    stratum: "clear-positive",
    authorLabel: "defect",
    authorNote: "Validator that records state in the database.",
    evidence: `export async function isEmailValid(db: Db, email: string): Promise<boolean> {
  const ok = EMAIL_PATTERN.test(email);
  await db.audit.insert({ kind: "email-checked", email, at: Date.now() });
  if (!ok) await db.blocklist.add(email);
  return ok;
}`,
  },
  {
    id: "h-name-2",
    category: "name-side-effect",
    stratum: "clear-positive",
    authorLabel: "defect",
    authorNote: "Formatter performing network I/O.",
    evidence: `export async function formatPrice(amount: number, currency: string): Promise<string> {
  const rate = await fetch(\`https://rates.example.test/\${currency}\`).then((r) => r.json());
  rateCache.set(currency, rate);
  return \`\${(amount * rate.value).toFixed(2)} \${currency}\`;
}`,
  },
  {
    id: "h-name-3",
    category: "name-side-effect",
    stratum: "clear-positive",
    authorLabel: "defect",
    authorNote: "Plain getter creates a file.",
    evidence: `export function getConfig(dir: string): Config {
  const file = join(dir, "config.json");
  if (!existsSync(file)) writeFileSync(file, JSON.stringify(DEFAULT_CONFIG));
  return JSON.parse(readFileSync(file, "utf8"));
}`,
  },
  {
    id: "h-name-4",
    category: "name-side-effect",
    stratum: "tricky-negative",
    authorLabel: "ok",
    authorNote: "Name admits network I/O.",
    evidence: `export async function fetchUser(id: string): Promise<User> {
  const res = await fetch(\`https://api.example.test/users/\${id}\`);
  return res.json();
}`,
  },
  {
    id: "h-name-5",
    category: "name-side-effect",
    stratum: "tricky-negative",
    authorLabel: "ok",
    authorNote: "'getOrCreate' states the creation.",
    evidence: `export function getOrCreateSession(store: Store, userId: string): Session {
  const existing = store.sessions.get(userId);
  if (existing) return existing;
  const session = { id: randomUUID(), userId, createdAt: Date.now() };
  store.sessions.set(userId, session);
  return session;
}`,
  },
  {
    id: "h-name-6",
    category: "name-side-effect",
    stratum: "tricky-negative",
    authorLabel: "ok",
    authorNote: "Private memoisation is not an observable side effect.",
    evidence: `class Order {
  #total: number | undefined;
  constructor(private readonly lines: ReadonlyArray<Line>) {}
  getTotal(): number {
    this.#total ??= this.lines.reduce((n, l) => n + l.price * l.qty, 0);
    return this.#total;
  }
}`,
  },
  {
    id: "h-name-7",
    category: "name-side-effect",
    stratum: "boundary",
    authorLabel: "uncertain",
    authorNote: "Validator that also normalises its input in place.",
    evidence: `export function validateConfig(config: Config): void {
  config.port ??= 3000;
  config.host ??= "127.0.0.1";
  if (config.port < 1 || config.port > 65535) throw new Error(\`Port out of range: \${config.port}\`);
}`,
  },

  // error-actionability
  {
    id: "h-error-1",
    category: "error-actionability",
    stratum: "clear-positive",
    authorLabel: "defect",
    authorNote: "Generic message.",
    evidence: `async function syncWorkspace(id: string) {
  const res = await api.sync(id);
  if (!res.ok) throw new Error("Something went wrong");
  return res.body;
}`,
  },
  {
    id: "h-error-2",
    category: "error-actionability",
    stratum: "clear-positive",
    authorLabel: "defect",
    authorNote: "Rethrow drops the cause and the target.",
    evidence: `async function loadPlugin(name: string) {
  try {
    return await import(pluginPath(name));
  } catch (error) {
    throw new Error("Failed");
  }
}`,
  },
  {
    id: "h-error-3",
    category: "error-actionability",
    stratum: "clear-positive",
    authorLabel: "defect",
    authorNote: "One vague message for a twelve-field form.",
    evidence: `function validateSignup(form: SignupForm) {
  // checks name, email, phone, address1, address2, city, region, postcode, country, dob, password, terms
  if (!isValidName(form.name) || !isValidEmail(form.email) || !isValidPhone(form.phone) ||
      !isValidAddress(form) || !isValidDob(form.dob) || !isStrongPassword(form.password) || !form.terms) {
    throw new ValidationError("Invalid input");
  }
}`,
  },
  {
    id: "h-error-4",
    category: "error-actionability",
    stratum: "tricky-negative",
    authorLabel: "ok",
    authorNote: "Names path, cause and remedy.",
    evidence: `try {
  return parseConfig(readFileSync(path, "utf8"));
} catch (error) {
  throw new Error(
    \`Cannot read project config at \${path}: \${String(error)}. Run "t3 init" to create one.\`,
    { cause: error },
  );
}`,
  },
  {
    id: "h-error-5",
    category: "error-actionability",
    stratum: "tricky-negative",
    authorLabel: "ok",
    authorNote: "Terse but tells the reader what to do.",
    evidence: `server.on("error", (error: NodeJS.ErrnoException) => {
  if (error.code === "EADDRINUSE") {
    throw new Error(\`Port \${port} is already in use; pass --port to choose another.\`);
  }
  throw error;
});`,
  },
  {
    id: "h-error-6",
    category: "error-actionability",
    stratum: "tricky-negative",
    authorLabel: "ok",
    authorNote: "Programmer-error invariant names the impossible value.",
    evidence: `function labelFor(kind: Kind): string {
  switch (kind) {
    case "file": return "File";
    case "dir": return "Directory";
    default: throw new Error(\`Unreachable: unknown kind \${JSON.stringify(kind)}\`);
  }
}`,
  },

  // assertion-weakening
  {
    id: "h-assert-1",
    category: "assertion-weakening",
    stratum: "clear-positive",
    authorLabel: "defect",
    authorNote: "Value check replaced by existence.",
    evidence: `--- a/src/parse.test.ts
+++ b/src/parse.test.ts
@@
 it("parses a record", () => {
-  expect(parseRecord("a=1")).toEqual({ key: "a", value: 1 });
+  expect(parseRecord("a=1")).toBeDefined();
 });`,
  },
  {
    id: "h-assert-2",
    category: "assertion-weakening",
    stratum: "clear-positive",
    authorLabel: "defect",
    authorNote: "Call-count assertion dropped.",
    evidence: `--- a/src/notify.test.ts
+++ b/src/notify.test.ts
@@
 it("sends one email per recipient", async () => {
   await notifyAll(["a@x.test", "b@x.test"]);
-  expect(send).toHaveBeenCalledTimes(2);
   expect(send).toHaveBeenCalledWith(expect.objectContaining({ to: "a@x.test" }));
 });`,
  },
  {
    id: "h-assert-3",
    category: "assertion-weakening",
    stratum: "clear-positive",
    authorLabel: "defect",
    authorNote: "Exact length weakened to non-empty.",
    evidence: `--- a/src/search.test.ts
+++ b/src/search.test.ts
@@
 it("returns every match", () => {
   const items = search(index, "cat");
-  expect(items).toHaveLength(3);
+  expect(items.length).toBeGreaterThan(0);
 });`,
  },
  {
    id: "h-assert-4",
    category: "assertion-weakening",
    stratum: "tricky-negative",
    authorLabel: "ok",
    authorNote: "Matcher strengthened and extra check added.",
    evidence: `--- a/src/order.test.ts
+++ b/src/order.test.ts
@@
 it("builds the order", () => {
   const order = buildOrder(cart);
-  expect(order.total).toBeGreaterThan(0);
+  expect(order.total).toBe(42);
+  expect(order.lines).toHaveLength(2);
 });`,
  },
  {
    id: "h-assert-5",
    category: "assertion-weakening",
    stratum: "tricky-negative",
    authorLabel: "ok",
    authorNote:
      "Expected value changed because the specified behaviour changed; strictness is unchanged.",
    evidence: `Commit message: "Raise sales tax from 10% to 20% (spec T-211)."
--- a/src/tax.test.ts
+++ b/src/tax.test.ts
@@
 it("adds sales tax", () => {
-  expect(withTax(100)).toBe(110);
+  expect(withTax(100)).toBe(120);
 });`,
  },
  {
    id: "h-assert-6",
    category: "assertion-weakening",
    stratum: "tricky-negative",
    authorLabel: "ok",
    authorNote: "Three field checks folded into one equivalent object check.",
    evidence: `--- a/src/profile.test.ts
+++ b/src/profile.test.ts
@@
 it("builds the profile", () => {
   const p = buildProfile(input);
-  expect(p.name).toBe("Ada");
-  expect(p.role).toBe("admin");
-  expect(p.active).toBe(true);
+  expect(p).toStrictEqual({ name: "Ada", role: "admin", active: true });
 });`,
  },
  {
    id: "h-assert-7",
    category: "assertion-weakening",
    stratum: "boundary",
    authorLabel: "uncertain",
    authorNote: "Exact float equality relaxed to tolerance after a numeric change.",
    evidence: `Commit message: "Compute mean with a streaming algorithm."
--- a/src/stats.test.ts
+++ b/src/stats.test.ts
@@
 it("computes the mean", () => {
-  expect(mean([0.1, 0.2, 0.3])).toBe(0.2);
+  expect(mean([0.1, 0.2, 0.3])).toBeCloseTo(0.2, 10);
 });`,
  },

  // code-smell
  {
    id: "h-smell-1",
    category: "code-smell",
    stratum: "clear-positive",
    authorLabel: "defect",
    authorNote: "Request handler mixes validation, persistence, notification and analytics.",
    evidence: `export async function handleSignup(req: Request) {
  const form = Object.fromEntries(await req.formData());
  if (typeof form.email !== "string" || !form.email.includes("@")) return new Response("bad email", { status: 400 });
  if (String(form.password).length < 12) return new Response("weak password", { status: 400 });
  const hash = await bcrypt.hash(String(form.password), 12);
  const user = await db.users.insert({ email: form.email, hash });
  await db.audit.insert({ kind: "signup", userId: user.id });
  await mailer.send(form.email, "Welcome", renderWelcome(user));
  await analytics.track("signup", { userId: user.id });
  await billing.createCustomer(user);
  return Response.redirect("/welcome");
}`,
  },
  {
    id: "h-smell-2",
    category: "code-smell",
    stratum: "clear-positive",
    authorLabel: "defect",
    authorNote: "Class with unrelated responsibility groups.",
    evidence: `class AccountManager {
  login(user: string, pass: string) { /* session handling */ }
  logout(sessionId: string) { /* session handling */ }
  chargeCard(userId: string, cents: number) { /* payment provider calls */ }
  refund(chargeId: string) { /* payment provider calls */ }
  sendNewsletter(userId: string) { /* email rendering and sending */ }
  exportMonthlyReport(): Buffer { /* SQL aggregation and PDF rendering */ }
  resizeAvatar(userId: string, file: Buffer) { /* image processing */ }
}`,
  },
  {
    id: "h-smell-3",
    category: "code-smell",
    stratum: "clear-positive",
    authorLabel: "defect",
    authorNote: "Reads env, parses argv, spawns process and prints UI.",
    evidence: `export async function main() {
  const token = process.env.API_TOKEN ?? "";
  const args = process.argv.slice(2);
  const target = args.includes("--prod") ? "prod" : "dev";
  const files = readdirSync("dist").filter((f) => f.endsWith(".js"));
  for (const file of files) {
    const body = readFileSync(join("dist", file));
    const res = await fetch(\`https://deploy.example.test/\${target}/\${file}\`, { method: "PUT", body, headers: { authorization: token } });
    console.log(res.ok ? chalk.green("ok " + file) : chalk.red("fail " + file));
  }
  spawnSync("git", ["tag", \`deploy-\${Date.now()}\`]);
}`,
  },
  {
    id: "h-smell-4",
    category: "code-smell",
    stratum: "tricky-negative",
    authorLabel: "ok",
    authorNote: "Long, single-purpose state machine.",
    evidence: `export function nextState(state: Conn, event: ConnEvent): Conn {
  switch (state.kind) {
    case "idle":
      return event.type === "connect" ? { kind: "connecting", attempt: 1 } : state;
    case "connecting":
      if (event.type === "opened") return { kind: "open" };
      if (event.type === "failed") return state.attempt >= 5 ? { kind: "failed" } : { kind: "connecting", attempt: state.attempt + 1 };
      return state;
    case "open":
      if (event.type === "closed") return { kind: "connecting", attempt: 1 };
      if (event.type === "disconnect") return { kind: "idle" };
      return state;
    case "failed":
      return event.type === "connect" ? { kind: "connecting", attempt: 1 } : state;
  }
}`,
  },
  {
    id: "h-smell-5",
    category: "code-smell",
    stratum: "tricky-negative",
    authorLabel: "ok",
    authorNote: "Many parameters, one cohesive configuration purpose.",
    evidence: `export function createRetryPolicy(
  maxAttempts: number,
  baseDelayMs: number,
  maxDelayMs: number,
  jitter: number,
  retryOn: ReadonlySet<number>,
  onRetry: (attempt: number) => void,
  signal?: AbortSignal,
): RetryPolicy {
  return { maxAttempts, baseDelayMs, maxDelayMs, jitter, retryOn, onRetry, signal };
}`,
  },
  {
    id: "h-smell-6",
    category: "code-smell",
    stratum: "tricky-negative",
    authorLabel: "ok",
    authorNote: "Long linear parser, one responsibility.",
    evidence: `export function parseDuration(input: string): number {
  const match = /^(\\d+)(ms|s|m|h|d)$/.exec(input.trim());
  if (!match) throw new Error(\`Invalid duration "\${input}". Use forms like 500ms, 30s, 5m, 2h or 1d.\`);
  const value = Number(match[1]);
  switch (match[2]) {
    case "ms": return value;
    case "s": return value * 1_000;
    case "m": return value * 60_000;
    case "h": return value * 3_600_000;
    default: return value * 86_400_000;
  }
}`,
  },
  {
    id: "h-smell-7",
    category: "code-smell",
    stratum: "boundary",
    authorLabel: "uncertain",
    authorNote: "Fetch, parse and cache in one function: a pipeline, arguably one job.",
    evidence: `export async function loadManifest(url: string): Promise<Manifest> {
  const cached = cache.get(url);
  if (cached && cached.expires > Date.now()) return cached.value;
  const res = await fetch(url);
  if (!res.ok) throw new Error(\`Manifest request to \${url} failed with \${res.status}.\`);
  const manifest = ManifestSchema.parse(await res.json());
  cache.set(url, { value: manifest, expires: Date.now() + 60_000 });
  return manifest;
}`,
  },
]);
