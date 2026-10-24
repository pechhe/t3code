// @effect-diagnostics nodeBuiltinImport:off - Builds a throwaway directory to watch.
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";
import { expect, it } from "vite-plus/test";

import { waitForChange } from "./wait-for-change.ts";

const lineCount = async (path: string) => {
  const text = await NodeFSP.readFile(path, "utf8").catch(() => "");
  return text.split("\n").filter(Boolean).length;
};

it("keeps a change that lands after a below-target read, with nothing after it", async () => {
  const dir = await NodeFSP.realpath(
    await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "t3-wait-for-change-")),
  );
  try {
    const log = NodePath.join(dir, "log");
    await NodeFSP.writeFile(log, "first\n");
    // The one final append happens after this pass has read the log and decided it is not
    // there yet, and nothing touches the directory afterwards. Only a notification kept
    // across that read can wake the wait again, which is the gap a dormant watch leaves.
    let appended = false;
    const reached = async () => {
      const lines = await lineCount(log);
      if (lines === 1 && !appended) {
        appended = true;
        await NodeFSP.appendFile(log, "second\n");
      }
      return lines >= 2;
    };

    await waitForChange(dir, reached);

    expect(appended).toBe(true);
    expect(await lineCount(log)).toBe(2);
  } finally {
    await NodeFSP.rm(dir, { recursive: true, force: true });
  }
});
