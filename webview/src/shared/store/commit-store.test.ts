import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  applyRepoSwitch,
  pruneRemovedDrafts,
  useCommitStore,
} from "./commit-store";
import { useRepoStore } from "./repo-store";

vi.mock("../bridge", () => ({
  bridge: {
    request: vi.fn(),
    onEvent: vi.fn(() => () => {}),
    setRepoContext: vi.fn(),
  },
}));

describe("commit-store per-repo isolation", () => {
  beforeEach(() => {
    useCommitStore.setState({
      commitMessage: "",
      selectedFiles: new Set(),
      highlightedFiles: new Set(),
      amend: false,
      expandedGroups: new Set(["changes", "unversioned", "staged"]),
      collapsedDirs: new Set(),
    });
  });

  it("saves and restores a draft across a repo switch", async () => {
    useCommitStore.setState({
      commitMessage: "draft for A",
      selectedFiles: new Set(["a.ts:false"]),
    });
    await applyRepoSwitch("/a", "/b", false);
    expect(useCommitStore.getState().commitMessage).toBe(""); // B had no draft
    useCommitStore.setState({ commitMessage: "draft for B" });
    await applyRepoSwitch("/b", "/a", false);
    expect(useCommitStore.getState().commitMessage).toBe("draft for A"); // A restored
  });

  it("prunes drafts for removed repos", async () => {
    await applyRepoSwitch(null, "/gone", false);
    useCommitStore.setState({ commitMessage: "x" });
    await applyRepoSwitch("/gone", null, false);
    pruneRemovedDrafts([]); // /gone removed
    useRepoStore.setState({ activeRepoId: null, repos: [] });
    await applyRepoSwitch(null, "/gone", false);
    expect(useCommitStore.getState().commitMessage).toBe("");
  });
});
