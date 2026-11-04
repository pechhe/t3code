/**
 * Prior findings an agent could be handed: lessons recorded by earlier reviews, fixes and the repository's own rules,
 * restated in one or two sentences. Authored for this pilot from retained project records; none contains a secret or customer data.
 */
export const FINDINGS: ReadonlyArray<{ slug: string; title: string; text: string }> = [
  [
    "one-choice-decision",
    "Decision choice questions need two labels",
    "A choice question with a single option passes schema but the classifier throws; the foundation now rejects it before encoding (a412a7ae).",
  ],
  [
    "unknown-cost-stays-unknown",
    "Failed attempts keep cost unknown",
    "A failed or unobserved model call has unknown spend, not zero; any total that includes one stays unknown and reports the known part separately.",
  ],
  [
    "label-sensitivity",
    "Score against each labeler alone",
    "Report results under the adjudicated labels and under each labeler alone; a ranking that flips under one labeler is not robust.",
  ],
  [
    "entrypoint-in-run-identity",
    "Run identity must hash the entry point",
    "A retained run's identity must hash every executable source including the command-line entry point and provenance helper, or the result can describe different code.",
  ],
  [
    "synthetic-too-regular",
    "Regular synthetic corpora only support revise",
    "A corpus written by one author with regular structure can recommend revise at most; keep real incidents and hard negatives in the held-out set.",
  ],
  [
    "audit-cause-mutates",
    "slipjay audit cause writes state",
    "Only `slipjay audit status` is read-only. `slipjay audit cause` and the other setters change audit records and are out of scope for agents running an evaluation.",
  ],
  [
    "prepared-deps-corruption",
    "Prepared node_modules can miss vfile files",
    "A prepared workspace can lack vfile 6.0.3 files (SJ-194); repair the generated package locally with an integrity check, with no source or shared-store change.",
  ],
  [
    "rescore-keeps-identity",
    "A rescore keeps the original run identity",
    "Re-scoring retained records must not alter the run identity; it records the scorer digest that produced the new numbers.",
  ],
  [
    "decision-rate-limit",
    "Decision calls are limited to 60 a minute",
    "DecisionService admits 60 calls a minute and 4 at once; evaluation runs use a fixed gap between calls and never retry automatically.",
  ],
  [
    "never-kill-by-name",
    "Never kill a process by name match",
    "Your own agent's argv contains the path, so pkill -f or a pgrep pipeline can kill it; stop only a PID captured at spawn.",
  ],
  [
    "live-state-is-read-only",
    "~/.t3/userdata is the running installation",
    "Copy from it; never open it read-write, clean it up, or start a server against it, and never symlink test data back to it.",
  ],
  [
    "no-baked-dev-origins",
    "Never set VITE_HTTP_URL or VITE_WS_URL in dev",
    "Vite proxies /api, /ws and /oauth through the browser origin; a baked-in localhost breaks remote clients.",
  ],
  [
    "landed-is-not-installed",
    "Landed work is not running until installed",
    "A change landed on t3peach is not in the Nightly app until the t3-fork-install steps have run.",
  ],
  [
    "chores-need-no-spec",
    "Cleanups and bumps are chores",
    "A cleanup, dependency bump, dead-code removal or follow-up to just-landed work is done directly as a change, with no Spec, Ticket or Spec review.",
  ],
  [
    "intervals-overlap",
    "Small pilots make no significance claim",
    "With about thirty cases the 95% intervals overlap; report counts with intervals and avoid significance claims.",
  ],
  [
    "oom-kill-was-the-change",
    "A Killed exit was the change, not the machine",
    "A check that died with Killed looked like an environment failure but an unbounded buffer added by the change caused it; read the change before dismissing.",
  ],
  [
    "date-dependent-fixture",
    "A fixture failed once its date aged out",
    "A saved-usage fixture failed every commit after it passed the 92-day scan cache window (8c12bfaf41); keep fixture dates inside the window.",
  ],
  [
    "dpop-https-behind-tunnel",
    "DPoP must use the https URL behind the tunnel",
    "Behind the T3 Connect tunnel the client signs the https URL; verification must rebuild it from forwarded headers, not use the internal http URL.",
  ],
  [
    "mcp-credential-refresh",
    "Reused sessions must refresh MCP credentials",
    "Reusing a provider session without refreshing MCP account credentials makes tools fail after token expiry.",
  ],
  [
    "readonly-provider-only",
    "Read-only tasks need an enforcing provider",
    "A read-only managed task may run only on a provider that actually enforces read-only access; otherwise it must be refused.",
  ],
  [
    "pending-items-partial-index",
    "Pending turn item reads need the partial index",
    "Shell snapshot reads of pending turn items must go through the partial index; a full scan made streaming slow.",
  ],
  [
    "record-fork-difference",
    "Record every deliberate upstream difference",
    "Every deliberate difference from upstream updates fork/differences.md in the same change.",
  ],
  [
    "comments-default-none",
    "Default to no code comments",
    "Record only a constraint, external quirk or invariant the code cannot show, in one to four lines.",
  ],
  [
    "no-ui-restyle",
    "UI components own their look",
    "Exports in components/ui take a variant or size; do not restyle them through className.",
  ],
  [
    "mobile-nav-is-separate",
    "Mobile navigation is separate from web",
    "Shared client logic belongs in packages/client-runtime; mobile navigation is its own surface.",
  ],
  [
    "one-browser-check",
    "One integrated browser check after integration",
    "A visible UI change gets one Browser-panel check by the primary agent after integration; helpers do not start dev servers.",
  ],
  [
    "design-loop-needs-yes",
    "Look-and-feel changes wait for the owner's yes",
    "A change judged by look or feel is shown on a preview and lands only after the owner says it feels right; apply each round of notes to the same preview.",
  ],
  [
    "no-continuous-repaint",
    "Avoid continuously repainting animations",
    "Continuous repaints cost battery and frames on high-refresh displays; prefer transitions that settle.",
  ],
  [
    "bounded-wait-on-background",
    "A managed task waits a bounded time on background work",
    "A managed task publishes its result after a bounded wait on a background command it left running; it never waits indefinitely.",
  ],
  [
    "followup-keeps-workspace",
    "A follow-up keeps the task's own workspace",
    "A delegate_task follow-up continues in the existing conversation and workspace; do not start a fresh workspace for it.",
  ],
  [
    "registered-flake-different-error",
    "A registered flaky test with a new error is not a known flake",
    "A test in the flake registry that fails with a different error than the registered signature needs investigation, not a quarantine.",
  ],
  [
    "unattended-asks-nothing",
    "Unattended runs ask no routine questions",
    "When the owner is away, settle reversible choices from evidence, record blocked actions and carry on with independent work.",
  ],
].map(([slug, title, text]) => ({ slug: slug!, title: title!, text: text! }));
