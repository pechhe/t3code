import {
  ProjectId,
  ThreadId,
  type OrchestrationV2WorkspaceAttachment,
} from "@t3tools/contracts";
import { describe, expect, it } from "vite-plus/test";

import {
  attachmentsToRemoveOnDelete,
  deriveWorkspaceChips,
  resolveSelectedWorkspace,
  resolveWorkspaceChipDetail,
} from "./threadWorkspaces.logic";

const home = ProjectId.make("home");
const other = ProjectId.make("other");
const primary = { projectId: home, worktreePath: "/ws/home", branch: "main" };

function attachment(
  overrides: Partial<OrchestrationV2WorkspaceAttachment> = {},
): OrchestrationV2WorkspaceAttachment {
  return {
    projectId: other,
    workspacePath: "/ws/other",
    branch: "feature",
    origin: "allocated",
    attachedAt: "2026-10-19T00:00:00.000Z",
    releasedAt: null,
    ...overrides,
  } as OrchestrationV2WorkspaceAttachment;
}

describe("resolveSelectedWorkspace", () => {
  it("defaults to the primary workspace", () => {
    const result = resolveSelectedWorkspace({
      primary,
      attachments: [attachment()],
      selectedWorkspacePath: null,
    });
    expect(result).toEqual({ ...primary, attachment: null });
  });

  it("points at the selected attachment's project and path", () => {
    const selected = attachment();
    const result = resolveSelectedWorkspace({
      primary,
      attachments: [selected],
      selectedWorkspacePath: "/ws/other",
    });
    expect(result).toEqual({
      projectId: other,
      worktreePath: "/ws/other",
      branch: "feature",
      attachment: selected,
    });
  });

  it("falls back to primary when the selected attachment disappears", () => {
    expect(
      resolveSelectedWorkspace({ primary, attachments: [], selectedWorkspacePath: "/ws/other" })
        .attachment,
    ).toBeNull();
    expect(
      resolveSelectedWorkspace({
        primary,
        attachments: undefined,
        selectedWorkspacePath: "/ws/other",
      }).worktreePath,
    ).toBe("/ws/home");
  });

  it("falls back to primary once the selected attachment is released or moved", () => {
    for (const changed of [
      { releasedAt: "2026-10-19T01:00:00.000Z" },
      { movedTo: ThreadId.make("fork") },
    ]) {
      const result = resolveSelectedWorkspace({
        primary,
        attachments: [attachment(changed)],
        selectedWorkspacePath: "/ws/other",
      });
      expect(result.attachment).toBeNull();
      expect(result.projectId).toBe(home);
    }
  });
});

describe("deriveWorkspaceChips", () => {
  const chipPrimary = { projectId: home, statusCwd: "/ws/home", branch: "main" };

  it("shows no chips for a thread without attachments", () => {
    const selected = resolveSelectedWorkspace({
      primary,
      attachments: [],
      selectedWorkspacePath: null,
    });
    expect(
      deriveWorkspaceChips({ primary: chipPrimary, attachments: [], selected }),
    ).toEqual([]);
  });

  it("lists the primary then each attachment, marking the selected one", () => {
    const attachments = [attachment()];
    const selected = resolveSelectedWorkspace({
      primary,
      attachments,
      selectedWorkspacePath: "/ws/other",
    });
    const chips = deriveWorkspaceChips({ primary: chipPrimary, attachments, selected });
    expect(chips.map((chip) => [chip.workspacePath, chip.selected, chip.detachable])).toEqual([
      [null, false, false],
      ["/ws/other", true, true],
    ]);
  });

  it("shows a released attachment as released without a checkout to read, until detached", () => {
    const attachments = [attachment({ releasedAt: "2026-10-19T01:00:00.000Z" })];
    const selected = resolveSelectedWorkspace({
      primary,
      attachments,
      selectedWorkspacePath: "/ws/other",
    });
    const chips = deriveWorkspaceChips({ primary: chipPrimary, attachments, selected });
    expect(chips[0]?.selected).toBe(true);
    expect(chips[1]).toMatchObject({ released: true, statusCwd: null, detachable: true });
  });

  it("omits attachments handed to a moved chat", () => {
    const attachments = [attachment({ movedTo: ThreadId.make("fork") })];
    const selected = resolveSelectedWorkspace({
      primary,
      attachments,
      selectedWorkspacePath: null,
    });
    expect(deriveWorkspaceChips({ primary: chipPrimary, attachments, selected })).toEqual([]);
  });
});

describe("resolveWorkspaceChipDetail", () => {
  const status = {
    refName: "feature",
    hasWorkingTreeChanges: true,
    workingTree: { files: [{}, {}] },
  };

  it("reports the ref and uncommitted edits", () => {
    expect(resolveWorkspaceChipDetail({ released: false, branch: null, status })).toEqual({
      label: "feature",
      editedFileCount: 2,
    });
  });

  it("prefers the SlipJay base and hides edits when the tree is clean", () => {
    expect(
      resolveWorkspaceChipDetail({
        released: false,
        branch: null,
        status: {
          ...status,
          hasWorkingTreeChanges: false,
          slipJay: { integration: "main" },
        },
      }),
    ).toEqual({ label: "on main", editedFileCount: 0 });
  });

  it("falls back to the recorded branch before status loads", () => {
    expect(resolveWorkspaceChipDetail({ released: false, branch: "feature", status: null })).toEqual(
      { label: "feature", editedFileCount: 0 },
    );
  });

  it("shows a released attachment without edits", () => {
    expect(resolveWorkspaceChipDetail({ released: true, branch: "feature", status })).toEqual({
      label: "Released",
      editedFileCount: 0,
    });
  });
});

describe("attachmentsToRemoveOnDelete", () => {
  it("offers only live allocated attachments", () => {
    const allocated = attachment({ workspacePath: "/ws/a" });
    const result = attachmentsToRemoveOnDelete([
      allocated,
      attachment({ workspacePath: "/ws/adopted", origin: "adopted" }),
      attachment({ workspacePath: "/ws/released", releasedAt: "2026-10-19T01:00:00.000Z" }),
      attachment({ workspacePath: "/ws/moved", movedTo: ThreadId.make("fork") }),
    ]);
    expect(result).toEqual([allocated]);
  });

  it("offers nothing for a thread without attachments", () => {
    expect(attachmentsToRemoveOnDelete(undefined)).toEqual([]);
  });
});
