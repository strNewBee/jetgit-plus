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

const { bridge, bridgeWithProgress } = await import("../../shared/bridge");
const { usePanelStore } = await import("../../shared/store/panel-store");
const { BranchSidebar } = await import("./BranchSidebar");

const originalSetFavorite = usePanelStore.getState().setFavorite;
const originalNavigateToRef = usePanelStore.getState().navigateToRef;

afterEach(() => {
  cleanup();
  vi.clearAllMocks();
  usePanelStore.setState({
    selectedRefs: [],
    branches: [],
    tags: [],
    setFavorite: originalSetFavorite,
    navigateToRef: originalNavigateToRef,
  });
});

describe("BranchSidebar ref actions", () => {
  it("updates only a selected local branch through updateBranch", async () => {
    usePanelStore.setState({
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
    const { getByRole } = render(<BranchSidebar />);

    fireEvent.click(getByRole("button", { name: "Update Selected" }));

    await waitFor(() =>
      expect(bridgeWithProgress).toHaveBeenCalledWith("updateBranch", {
        branchName: "feature",
      }),
    );
  });

  it("allows tag favorites and navigation but disables branch-only actions", async () => {
    const tag = {
      type: "tag",
      name: "v1.0.0",
      fullRef: "refs/tags/v1.0.0",
    } as const;
    const setFavorite = vi.fn().mockResolvedValue(undefined);
    const navigateToRef = vi.fn().mockResolvedValue(undefined);
    usePanelStore.setState({
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
    const { getByRole, queryByRole } = render(<BranchSidebar />);

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
