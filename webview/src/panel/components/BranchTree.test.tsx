import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../shared/bridge", () => ({
  bridge: {
    request: vi.fn().mockResolvedValue(undefined),
    onEvent: vi.fn(() => () => {}),
    setRepoContext: vi.fn(),
  },
  bridgeWithProgress: vi.fn().mockResolvedValue(undefined),
}));

const { usePanelStore } = await import("../../shared/store/panel-store");
const { BranchTree } = await import("./BranchTree");

const originalState = usePanelStore.getState();

function seedTree(showTags = true) {
  usePanelStore.setState({
    branches: [
      {
        name: "main",
        fullRef: "refs/heads/main",
        isRemote: false,
        isCurrent: true,
        isFavorite: false,
        ahead: 0,
        behind: 0,
        lastCommitHash: "branch-tip",
      },
    ],
    tags: [
      {
        name: "v1.0.0",
        fullRef: "refs/tags/v1.0.0",
        hash: "tag-object",
        targetCommitHash: "tag-tip",
        isFavorite: true,
        isAnnotated: true,
      },
    ],
    commits: [],
    currentBranch: "main",
    selectedRefs: [],
    filter: {
      searchQuery: "",
      branch: "",
      author: "",
      dateRange: "",
      file: "",
    },
    branchGroupByDirectory: false,
    showTags,
    singleClickAction: "filter",
  });
}

afterEach(() => {
  cleanup();
  usePanelStore.setState({
    ...originalState,
    branches: [],
    tags: [],
    commits: [],
    selectedRefs: [],
  });
});

describe("BranchTree unified refs", () => {
  it("honors Show Tags and selects a tag as a typed ref", () => {
    seedTree(false);
    const selectRef = vi.fn();
    const setFilter = vi.fn();
    usePanelStore.setState({ selectRef, setFilter });
    const { queryByText, rerender, getByText } = render(<BranchTree />);

    expect(queryByText("Tags")).toBeNull();

    usePanelStore.setState({ showTags: true });
    rerender(<BranchTree />);
    fireEvent.click(getByText("v1.0.0"));

    const tag = {
      type: "tag",
      name: "v1.0.0",
      fullRef: "refs/tags/v1.0.0",
    };
    expect(selectRef).toHaveBeenCalledWith(tag, "single", expect.any(Array));
    expect(setFilter).toHaveBeenCalledWith({ branch: tag.fullRef });
  });

  it("renders favorite stars and toggles a tag favorite", async () => {
    seedTree(true);
    const setFavorite = vi.fn().mockResolvedValue(undefined);
    usePanelStore.setState({ setFavorite });
    const { getByRole } = render(<BranchTree />);

    fireEvent.click(getByRole("button", { name: "Unmark v1.0.0 as favorite" }));

    await waitFor(() =>
      expect(setFavorite).toHaveBeenCalledWith(
        {
          type: "tag",
          name: "v1.0.0",
          fullRef: "refs/tags/v1.0.0",
        },
        false,
      ),
    );
  });

  it("offers Mark/Unmark as Favorite from a tag context menu", async () => {
    seedTree(true);
    const setFavorite = vi.fn().mockResolvedValue(undefined);
    usePanelStore.setState({ setFavorite });
    const { getByText } = render(<BranchTree />);

    fireEvent.contextMenu(getByText("v1.0.0"), {
      clientX: 20,
      clientY: 30,
    });
    fireEvent.click(getByText("Unmark as Favorite"));

    await waitFor(() =>
      expect(setFavorite).toHaveBeenCalledWith(
        {
          type: "tag",
          name: "v1.0.0",
          fullRef: "refs/tags/v1.0.0",
        },
        false,
      ),
    );
  });

  it("does not toggle the configured single-click action back on a double click", () => {
    seedTree(true);
    const setFilter = vi.fn();
    usePanelStore.setState({ setFilter });
    const { getByText } = render(<BranchTree />);
    const tag = getByText("v1.0.0");

    fireEvent.click(tag, { detail: 1 });
    fireEvent.click(tag, { detail: 2 });
    fireEvent.doubleClick(tag);

    expect(setFilter).toHaveBeenCalledTimes(1);
    expect(setFilter).toHaveBeenCalledWith({ branch: "refs/tags/v1.0.0" });
  });
});
