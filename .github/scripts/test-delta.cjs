// Counts the test cases a pull request adds and removes, from a zero-context diff, so PR Size can
// say when a change grows the suite. Counting declarations keeps the number deterministic, unlike
// CI timings, which move with runner load.
const MARKER = "<!-- test-delta -->";
const NET_CASES_TO_REPORT = 20;
const TEST_FILE = /\.(?:test|spec)\.[cm]?[jt]sx?$/;
// `<` admits type arguments, as in `it.each<Row>(...)`, which may span lines.
const TEST_CASE = /^\s*(?:it|test)(?:\.\w+)*\s*[(<]/;

/** Server and integration files cost seconds of setup; everything else is a unit test. */
function kindOf(path) {
  if (path.startsWith("apps/server/") || path.includes(".integration.")) return "server";
  return "unit";
}

/** @param {string} diff output of `git diff -U0 base...head` */
function countTestDelta(diff) {
  const kinds = { server: 0, unit: 0 };
  let path = null;
  for (const line of diff.split("\n")) {
    if (line.startsWith("--- ")) {
      const source = line.slice(4).replace(/^a\//, "");
      path = TEST_FILE.test(source) ? source : null;
      continue;
    }
    if (line.startsWith("+++ ")) {
      const target = line.slice(4).replace(/^b\//, "");
      // A deleted file's target is /dev/null; keep its old path to count the removed cases.
      if (target !== "/dev/null") path = TEST_FILE.test(target) ? target : null;
      continue;
    }
    if (line.startsWith("new file mode") || !path) continue;
    const sign = line[0] === "+" ? 1 : line[0] === "-" ? -1 : 0;
    if (sign !== 0 && TEST_CASE.test(line.slice(1))) kinds[kindOf(path)] += sign;
  }
  return { kinds, net: kinds.server + kinds.unit };
}

/** Returns the comment body, or null when the change does not grow the suite enough to mention. */
function render(delta) {
  if (delta.net < NET_CASES_TO_REPORT) return null;
  const signed = (n) => (n > 0 ? `+${n}` : String(n));
  return [
    MARKER,
    `This PR changes the test suite by **${signed(delta.net)} test cases** ` +
      `(unit ${signed(delta.kinds.unit)}, server ${signed(delta.kinds.server)}).`,
    "",
    "Keep tests that would fail for a real reason, and test logic below the UI where it can be. See [Testing](https://github.com/pingdotgg/t3code/blob/main/docs/internals/15_testing.md).",
  ].join("\n");
}

module.exports = { MARKER, countTestDelta, render };
