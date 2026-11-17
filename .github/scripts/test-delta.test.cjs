const assert = require("node:assert/strict");
const test = require("node:test");

const { countTestDelta, render } = require("./test-delta.cjs");

const diff = `diff --git a/apps/web/src/Panel.test.ts b/apps/web/src/Panel.test.ts
new file mode 100644
--- /dev/null
+++ b/apps/web/src/Panel.test.ts
@@ -0,0 +1,4 @@
+it("opens", async () => {});
+  it.each<{ n: number }>([{ n: 1 }])("renders $n", async () => {});
+// it("is a comment, still counted only when it starts the line")
diff --git a/apps/server/src/thing.test.ts b/apps/server/src/thing.test.ts
--- a/apps/server/src/thing.test.ts
+++ b/apps/server/src/thing.test.ts
@@ -3,2 +3,1 @@
-it.effect("old", () => {});
-test("older", () => {});
+  it.effect("new", () => {});
`;

test("counts cases by kind, including deleted files", () => {
  assert.deepEqual(countTestDelta(diff), {
    kinds: { server: -1, unit: 2 },
    net: 1,
  });
});

test("reports only growth worth a reviewer's attention", () => {
  const quiet = { kinds: { server: 3, unit: 5 }, net: 8 };
  assert.equal(render(quiet), null);
  const growth = { kinds: { server: 10, unit: 12 }, net: 26 };
  assert.match(render(growth), /\*\*\+26 test cases\*\* \(unit \+12, server \+10\)/);
});
