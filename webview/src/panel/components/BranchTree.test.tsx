import {
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import type { PropsWithChildren, ReactElement } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("../../shared/bridge", () => ({
  bridge: {
    request: vi.fn().mockResolvedValue(undefined),
    onEvent: vi.fn(() => () => {}),
    setRepoContext: vi.fn(),
  },
  bridgeWithProgress: vi.fn().mockResolvedValue(undefined),
}));

const { GitLogStoreProvider } = await import(
  "../../shared/store/git-log-store-context"
);
const { defaultGitLogStore } = await import("../../shared/store/panel-store");
const { bridge, bridgeWithProgress } = await import("../../shared/bridge");
const { useRepoStore } = await import("../../shared/store/repo-store");
const { BranchTree } = await import("./BranchTree");
const panelStore = defaultGitLogStore.store;

const originalState = panelStore.getState();

function StoreWrapper({ children }: PropsWithChildren) {
  return (
    <GitLogStoreProvider store={panelStore}>{children}</GitLogStoreProvider>
  );
}

function renderWithStore(ui: ReactElement) {
  return render(ui, { wrapper: StoreWrapper });
}

function seedTree(showTags = true) {
  panelStore.setState({
    branches: [
      {
        name: "main",
        fullRef: "refs/heads/main",
        isRemote: false,
        isCurrent: true,
        isFavorite: true,
        ahead: 0,
        behind: 0,
        lastCommitHash: "branch-tip",
      },
      {
        name: "favorite",
        fullRef: "refs/heads/favorite",
        isRemote: false,
        isCurrent: false,
        isFavorite: true,
        upstream: "origin/favorite",
        ahead: 0,
        behind: 0,
        lastCommitHash: "favorite-tip",
      },
      {
        name: "feature/plain",
        fullRef: "refs/heads/feature/plain",
        isRemote: false,
        isCurrent: false,
        isFavorite: false,
        ahead: 0,
        behind: 0,
        lastCommitHash: "plain-tip",
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
      {
        name: "v2.0.0",
        fullRef: "refs/tags/v2.0.0",
        hash: "tag-v2-object",
        targetCommitHash: "tag-v2-tip",
        isFavorite: false,
        isAnnotated: false,
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
  vi.clearAllMocks();
  panelStore.setState({
    ...originalState,
    branches: [],
    tags: [],
    commits: [],
    selectedRefs: [],
  });
  useRepoStore.setState({ activeRepoId: null });
});

describe("BranchTree unified refs", () => {
  it("honors Show Tags and selects a tag as a typed ref", () => {
    seedTree(false);
    const selectRef = vi.fn();
    const setFilter = vi.fn();
    panelStore.setState({ selectRef, setFilter });
    const { queryByText, rerender, getByText } = renderWithStore(
      <BranchTree />,
    );

    expect(queryByText("Tags")).toBeNull();

    panelStore.setState({ showTags: true });
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

  it("renders one prioritized status icon for current, favorite, and ordinary refs", () => {
    seedTree(true);
    const { getByText } = renderWithStore(<BranchTree />);

    const iconFor = (name: string) => {
      const row = getByText(name).closest(".selectable-row");
      if (!row) throw new Error(`missing row for ${name}`);
      expect(row.querySelectorAll("[data-ref-status-icon]")).toHaveLength(1);
      expect(
        within(row).queryByRole("button", { name: /as favorite/i }),
      ).toBeNull();
      return within(row).getByRole("img");
    };

    // Current wins even when main is also a persisted favorite.
    expect(iconFor("main").getAttribute("aria-label")).toBe("Current branch");
    expect(iconFor("favorite").getAttribute("aria-label")).toBe(
      "Favorite branch",
    );
    expect(iconFor("feature/plain").getAttribute("aria-label")).toBe("Branch");
    expect(iconFor("v1.0.0").getAttribute("aria-label")).toBe("Favorite tag");
    expect(iconFor("v2.0.0").getAttribute("aria-label")).toBe("Tag");
  });

  it("uses compact fixed heights for ref and directory rows", () => {
    seedTree(true);
    panelStore.setState({ branchGroupByDirectory: true });
    const { getByText } = renderWithStore(<BranchTree />);

    const branchRow = getByText("plain").closest(".selectable-row");
    expect((branchRow as HTMLElement).style.height).toBe("22px");
    expect(
      (getByText("feature").parentElement as HTMLElement).style.height,
    ).toBe("22px");
    expect(
      (getByText("v1.0.0").closest(".selectable-row") as HTMLElement).style
        .height,
    ).toBe("22px");
    expect((getByText("Local") as HTMLElement).style.height).toBe("24px");
    expect(
      (getByText("Current Branch: main") as HTMLElement).style.height,
    ).toBe("24px");
  });

  it("keeps a long current branch label inside its fixed-height row", () => {
    seedTree(true);
    const longBranch = "feat/0.5.1-branch-ux-reliability";
    panelStore.setState({
      branches: [
        {
          name: longBranch,
          fullRef: `refs/heads/${longBranch}`,
          isRemote: false,
          isCurrent: true,
          isFavorite: false,
          ahead: 0,
          behind: 0,
          lastCommitHash: "branch-tip",
        },
      ],
      currentBranch: longBranch,
    });
    const label = `Current Branch: ${longBranch}`;
    const { getByText } = renderWithStore(<BranchTree />);

    const row = getByText(label) as HTMLElement;
    expect(row.style.height).toBe("24px");
    expect(row.style.whiteSpace).toBe("nowrap");
    expect(row.style.overflow).toBe("hidden");
    expect(row.style.textOverflow).toBe("ellipsis");
    expect(row.title).toBe(label);
  });

  it("allows a ref row to be selected from the keyboard", () => {
    seedTree(true);
    const selectRef = vi.fn();
    const setFilter = vi.fn();
    panelStore.setState({ selectRef, setFilter });
    const { getByRole } = renderWithStore(<BranchTree />);

    const row = getByRole("treeitem", { name: /main/i });
    fireEvent.keyDown(row, { key: "Enter" });

    expect(selectRef).toHaveBeenCalledWith(
      { type: "local", name: "main", fullRef: "refs/heads/main" },
      "single",
      expect.any(Array),
    );
    expect(setFilter).toHaveBeenCalledWith({ branch: "refs/heads/main" });
  });

  it("offers Mark/Unmark as Favorite from a tag context menu", async () => {
    seedTree(true);
    const setFavorite = vi.fn().mockResolvedValue(undefined);
    panelStore.setState({ setFavorite });
    const { getByText } = renderWithStore(<BranchTree />);

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

  it("disables Update in the branch context menu when upstream is missing", () => {
    seedTree(true);
    const { getByText, getByLabelText } = renderWithStore(<BranchTree />);

    fireEvent.contextMenu(getByText("feature/plain"), {
      clientX: 20,
      clientY: 30,
    });
    const update = getByLabelText("Update");
    expect(update.getAttribute("role")).toBe("menuitem");
    expect(update.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(update);

    expect(bridgeWithProgress).not.toHaveBeenCalledWith(
      "updateBranch",
      expect.anything(),
    );
  });

  it("compares the right-clicked local branch instead of prior multi-selection", async () => {
    seedTree(true);
    useRepoStore.setState({ activeRepoId: "repo-tree" });
    panelStore.setState({
      selectedRefs: [
        { type: "local", name: "main", fullRef: "refs/heads/main" },
        {
          type: "local",
          name: "favorite",
          fullRef: "refs/heads/favorite",
        },
      ],
    });
    const { getByText, getByLabelText } = renderWithStore(<BranchTree />);

    fireEvent.contextMenu(getByText("feature/plain"), {
      clientX: 20,
      clientY: 30,
    });
    fireEvent.click(getByLabelText("Compare with Current"));

    await waitFor(() =>
      expect(bridge.request).toHaveBeenCalledWith(
        "openCompareWithCurrent",
        {
          ref: {
            type: "local",
            name: "feature/plain",
            fullRef: "refs/heads/feature/plain",
          },
        },
        { repoId: "repo-tree" },
      ),
    );
  });

  it("compares the right-clicked remote branch through the bound surface", async () => {
    seedTree(true);
    useRepoStore.setState({ activeRepoId: "repo-tree" });
    panelStore.setState((state) => ({
      branches: [
        ...state.branches,
        {
          name: "origin/feature",
          fullRef: "refs/remotes/origin/feature",
          isRemote: true,
          isCurrent: false,
          isFavorite: false,
          ahead: 0,
          behind: 0,
          lastCommitHash: "remote-tip",
        },
      ],
    }));
    const { getByText, getByLabelText } = renderWithStore(<BranchTree />);

    fireEvent.contextMenu(getByText("origin/feature"), {
      clientX: 20,
      clientY: 30,
    });
    fireEvent.click(getByLabelText("Compare with Current"));

    await waitFor(() =>
      expect(bridge.request).toHaveBeenCalledWith(
        "openCompareWithCurrent",
        {
          ref: {
            type: "remote",
            name: "origin/feature",
            fullRef: "refs/remotes/origin/feature",
          },
        },
        { repoId: "repo-tree" },
      ),
    );
  });

  it("compares the right-clicked tag through the bound surface", async () => {
    seedTree(true);
    useRepoStore.setState({ activeRepoId: "repo-tree" });
    const { getByText, getByRole } = renderWithStore(<BranchTree />);

    fireEvent.contextMenu(getByText("v2.0.0"), {
      clientX: 20,
      clientY: 30,
    });
    fireEvent.click(getByRole("button", { name: "Compare with Current" }));

    await waitFor(() =>
      expect(bridge.request).toHaveBeenCalledWith(
        "openCompareWithCurrent",
        {
          ref: {
            type: "tag",
            name: "v2.0.0",
            fullRef: "refs/tags/v2.0.0",
          },
        },
        { repoId: "repo-tree" },
      ),
    );
  });

  it("disables Compare with Current for the checked-out local branch", () => {
    seedTree(true);
    useRepoStore.setState({ activeRepoId: "repo-tree" });
    const { getByText, getByLabelText } = renderWithStore(<BranchTree />);

    fireEvent.contextMenu(getByText("main"), {
      clientX: 20,
      clientY: 30,
    });
    const compare = getByLabelText("Compare with Current");
    expect(compare.getAttribute("aria-disabled")).toBe("true");
    fireEvent.click(compare);

    expect(bridge.request).not.toHaveBeenCalledWith(
      "openCompareWithCurrent",
      expect.anything(),
      expect.anything(),
    );
  });

  it("does not toggle the configured single-click action back on a double click", () => {
    seedTree(true);
    const setFilter = vi.fn();
    panelStore.setState({ setFilter });
    const { getByText } = renderWithStore(<BranchTree />);
    const tag = getByText("v1.0.0");

    fireEvent.click(tag, { detail: 1 });
    fireEvent.click(tag, { detail: 2 });
    fireEvent.doubleClick(tag);

    expect(setFilter).toHaveBeenCalledTimes(1);
    expect(setFilter).toHaveBeenCalledWith({ branch: "refs/tags/v1.0.0" });
  });
});
