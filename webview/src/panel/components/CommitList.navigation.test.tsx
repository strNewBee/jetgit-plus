import {
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

const scrollToIndex = vi.fn();

vi.mock("@tanstack/react-virtual", () => ({
  useVirtualizer: ({ count }: { count: number }) => ({
    getTotalSize: () => count * 28,
    getVirtualItems: () =>
      Array.from({ length: count }, (_, index) => ({
        index,
        key: index,
        start: index * 28,
        size: 28,
        end: (index + 1) * 28,
        lane: 0,
      })),
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
const { createGitLogStore, defaultGitLogStore } = await import(
  "../../shared/store/panel-store"
);
const { bridge } = await import("../../shared/bridge");
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
    const commit = (hash: string) =>
      ({
        hash,
        shortHash: hash,
        parents: [],
        authorName: "",
        authorEmail: "",
        authorDate: "",
        subject: hash,
        body: "",
        refs: [],
      }) as never;
    panelStore.setState({
      commits: [commit("a"), commit("target")],
      visibleCommits: [commit("a"), commit("target")],
      scrollTargetHash: "target",
    });

    render(<CommitList />, { wrapper: StoreWrapper });

    await waitFor(() =>
      expect(scrollToIndex).toHaveBeenCalledWith(1, { align: "center" }),
    );
    expect(panelStore.getState().scrollTargetHash).toBeNull();
  });

  it("handles Arrow navigation only in the pane where the key event originated", async () => {
    const top = createGitLogStore({
      repoId: "repo-a",
      history: { kind: "ordinary" },
      followGlobalActiveRepo: false,
      showCurrentReachability: false,
      bridge,
    });
    const bottom = createGitLogStore({
      repoId: "repo-a",
      history: { kind: "ordinary" },
      followGlobalActiveRepo: false,
      showCurrentReachability: false,
      bridge,
    });
    const commit = (hash: string, subject: string) =>
      ({
        hash,
        shortHash: hash,
        parents: [],
        authorName: "Ada",
        authorEmail: "",
        authorDate: "2026-07-18T00:00:00.000Z",
        subject,
        body: "",
        refs: [],
      }) as never;
    const topCommits = [commit("top-a", "Top A"), commit("top-b", "Top B")];
    const bottomCommits = [
      commit("bottom-a", "Bottom A"),
      commit("bottom-b", "Bottom B"),
    ];
    top.store.setState({
      commits: topCommits,
      visibleCommits: topCommits,
      selectedCommitHash: "top-a",
      selectedCommitHashes: ["top-a"],
      lastSelectedCommitHash: "top-a",
    });
    bottom.store.setState({
      commits: bottomCommits,
      visibleCommits: bottomCommits,
      selectedCommitHash: "bottom-a",
      selectedCommitHashes: ["bottom-a"],
      lastSelectedCommitHash: "bottom-a",
    });

    try {
      const view = render(
        <>
          <div data-testid="top-list">
            <GitLogStoreProvider store={top.store}>
              <CommitList />
            </GitLogStoreProvider>
          </div>
          <div data-testid="bottom-list">
            <GitLogStoreProvider store={bottom.store}>
              <CommitList />
            </GitLogStoreProvider>
          </div>
        </>,
      );
      const topRow = within(view.getByTestId("top-list"))
        .getByText("Top A")
        .closest(".selectable-row");
      expect(topRow).toBeTruthy();

      fireEvent.keyDown(topRow as HTMLElement, { key: "ArrowDown" });

      await waitFor(() =>
        expect(top.store.getState().selectedCommitHash).toBe("top-b"),
      );
      expect(bottom.store.getState().selectedCommitHash).toBe("bottom-a");
    } finally {
      top.dispose();
      bottom.dispose();
    }
  });
});
