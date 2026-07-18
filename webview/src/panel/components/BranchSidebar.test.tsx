import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
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

const { bridge, bridgeWithProgress } = await import("../../shared/bridge");
const { GitLogStoreProvider } = await import(
  "../../shared/store/git-log-store-context"
);
const { defaultGitLogStore } = await import("../../shared/store/panel-store");
const { BranchSidebar } = await import("./BranchSidebar");
const panelStore = defaultGitLogStore.store;

const originalSetFavorite = panelStore.getState().setFavorite;
const originalNavigateToRef = panelStore.getState().navigateToRef;

function StoreWrapper({ children }: PropsWithChildren) {
  return (
    <GitLogStoreProvider store={panelStore}>{children}</GitLogStoreProvider>
  );
}

function renderWithStore(ui: ReactElement) {
  return render(ui, { wrapper: StoreWrapper });
}

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  panelStore.setState({
    selectedRefs: [],
    branches: [],
    tags: [],
    setFavorite: originalSetFavorite,
    navigateToRef: originalNavigateToRef,
  });
});

describe("BranchSidebar ref actions", () => {
  it("updates only a selected local branch through updateBranch", async () => {
    panelStore.setState({
      selectedRefs: [
        { type: "local", name: "feature", fullRef: "refs/heads/feature" },
      ],
      branches: [
        {
          name: "feature",
          fullRef: "refs/heads/feature",
          isRemote: false,
          isFavorite: false,
          upstream: "origin/feature",
          lastCommitHash: "tip",
        } as never,
      ],
    });
    const { getByRole } = renderWithStore(<BranchSidebar />);

    fireEvent.click(getByRole("button", { name: "Update Selected" }));

    await waitFor(() =>
      expect(bridgeWithProgress).toHaveBeenCalledWith("updateBranch", {
        branchName: "feature",
      }),
    );
  });

  it("disables Update Selected when the local branch has no upstream", () => {
    panelStore.setState({
      selectedRefs: [
        { type: "local", name: "feature", fullRef: "refs/heads/feature" },
      ],
      branches: [
        {
          name: "feature",
          fullRef: "refs/heads/feature",
          isRemote: false,
          isFavorite: false,
          lastCommitHash: "tip",
        } as never,
      ],
    });
    const { getByRole } = renderWithStore(<BranchSidebar />);

    const update = getByRole("button", {
      name: "Update Selected",
    }) as HTMLButtonElement;
    expect(update.disabled).toBe(true);
    expect(update.getAttribute("aria-description")).toBe(
      "No upstream configured",
    );
    fireEvent.click(update);
    expect(bridgeWithProgress).not.toHaveBeenCalled();
  });

  it("allows tag favorites and navigation but disables branch-only actions", async () => {
    const tag = {
      type: "tag",
      name: "v1.0.0",
      fullRef: "refs/tags/v1.0.0",
    } as const;
    const setFavorite = vi.fn().mockResolvedValue(undefined);
    const navigateToRef = vi.fn().mockResolvedValue(undefined);
    panelStore.setState({
      selectedRefs: [tag],
      tags: [
        {
          name: tag.name,
          fullRef: tag.fullRef,
          targetCommitHash: "tag-tip",
          isFavorite: false,
        } as never,
      ],
      setFavorite,
      navigateToRef,
    });
    const { getByRole, queryByRole } = renderWithStore(<BranchSidebar />);

    expect(
      (getByRole("button", { name: "Update Selected" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(
      (getByRole("button", { name: "Delete Branch" }) as HTMLButtonElement)
        .disabled,
    ).toBe(true);
    expect(queryByRole("button", { name: "Show My Branches" })).toBeNull();

    fireEvent.click(getByRole("button", { name: "Mark/Unmark As Favorite" }));
    fireEvent.click(
      getByRole("button", { name: "Navigate Log to Selected Ref Head" }),
    );

    await waitFor(() => {
      expect(setFavorite).toHaveBeenCalledWith(tag, true);
      expect(navigateToRef).toHaveBeenCalledWith(tag, "tag-tip");
    });
    expect(bridge.request).not.toHaveBeenCalledWith("showMyBranches");
  });
});
