import { cleanup, render, waitFor } from "@testing-library/react";
import type { PropsWithChildren } from "react";
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

const { GitLogStoreProvider } = await import(
  "../../shared/store/git-log-store-context"
);
const { defaultGitLogStore } = await import("../../shared/store/panel-store");
const { CommitList } = await import("./CommitList");
const panelStore = defaultGitLogStore.store;

function StoreWrapper({ children }: PropsWithChildren) {
  return (
    <GitLogStoreProvider store={panelStore}>{children}</GitLogStoreProvider>
  );
}

afterEach(() => {
  cleanup();
  scrollToIndex.mockClear();
  panelStore.setState({
    visibleCommits: [],
    commits: [],
    scrollTargetHash: null,
  });
});

describe("CommitList ref navigation", () => {
  it("scrolls the requested ref target into the center and consumes it", async () => {
    panelStore.setState({
      commits: [{ hash: "a" }, { hash: "target" }] as never,
      visibleCommits: [{ hash: "a" }, { hash: "target" }] as never,
      scrollTargetHash: "target",
    });

    render(<CommitList />, { wrapper: StoreWrapper });

    await waitFor(() =>
      expect(scrollToIndex).toHaveBeenCalledWith(1, { align: "center" }),
    );
    expect(panelStore.getState().scrollTargetHash).toBeNull();
  });
});
