import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

const scrollToIndex = vi.fn();

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: () => ({
    getTotalSize: () => 28,
    getVirtualItems: () => [],
    scrollToIndex,
  }),
}));

vi.mock("../../shared/bridge", () => ({
  bridge: {
    request: vi.fn().mockResolvedValue([]),
    onEvent: vi.fn(() => () => {}),
    setRepoContext: vi.fn(),
  },
}));

const { usePanelStore } = await import("../../shared/store/panel-store");
const { CommitList } = await import("./CommitList");

afterEach(() => {
  cleanup();
  scrollToIndex.mockClear();
  usePanelStore.setState({
    visibleCommits: [],
    commits: [],
    scrollTargetHash: null,
  });
});

describe("CommitList ref navigation", () => {
  it("scrolls the requested ref target into the center and consumes it", async () => {
    usePanelStore.setState({
      commits: [{ hash: "a" }, { hash: "target" }] as never,
      visibleCommits: [{ hash: "a" }, { hash: "target" }] as never,
      scrollTargetHash: "target",
    });

    render(<CommitList />);

    await waitFor(() =>
      expect(scrollToIndex).toHaveBeenCalledWith(1, { align: "center" }),
    );
    expect(usePanelStore.getState().scrollTargetHash).toBeNull();
  });
});
