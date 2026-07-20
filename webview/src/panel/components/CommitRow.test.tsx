import { cleanup, render } from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";

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
const { CommitRow } = await import("./CommitRow");
const panelStore = defaultGitLogStore.store;

function StoreWrapper({ children }: PropsWithChildren) {
  return (
    <GitLogStoreProvider store={panelStore}>{children}</GitLogStoreProvider>
  );
}

afterEach(() => {
  cleanup();
  panelStore.setState({ selectedCommitHashes: [] });
});

describe("CommitRow reachability styling", () => {
  it("marks reachable commits while retaining selected-row priority", () => {
    const commit = {
      hash: "abc123",
      shortHash: "abc123",
      parents: [],
      authorName: "Ada",
      authorEmail: "ada@example.com",
      authorDate: "2026-07-18T00:00:00.000Z",
      subject: "Reachable commit",
      body: "",
      refs: [],
      reachableFromCurrent: true,
    };
    panelStore.setState({ selectedCommitHashes: [commit.hash] });

    const { getByText } = render(
      <CommitRow
        commit={commit}
        lane={{ column: 0, color: 0, lines: [] }}
        rowMaxColumn={0}
        columnWidths={{ author: 100, date: 130, hash: 70 }}
        visibleColumns={{ author: true, date: true, hash: true }}
        onCommitClick={() => {}}
      />,
      { wrapper: StoreWrapper },
    );
    const row = getByText("Reachable commit").closest(".selectable-row");

    expect(row?.classList.contains("current-reachable")).toBe(true);
    expect(row?.classList.contains("selected")).toBe(true);
  });

  it("reserves the same resize gutter before every visible metadata column", () => {
    const commit = {
      hash: "def456",
      shortHash: "def456",
      parents: [],
      authorName: "Ada",
      authorEmail: "ada@example.com",
      authorDate: "2026-07-18T00:00:00.000Z",
      subject: "Aligned commit",
      body: "",
      refs: [],
    };

    const { getByText } = render(
      <CommitRow
        commit={commit}
        lane={{ column: 0, color: 0, lines: [] }}
        rowMaxColumn={0}
        columnWidths={{ author: 100, date: 130, hash: 70 }}
        visibleColumns={{ author: true, date: true, hash: true }}
        onCommitClick={() => {}}
      />,
      { wrapper: StoreWrapper },
    );
    const row = getByText("Aligned commit").closest(".commit-row");
    const gutters = row?.querySelectorAll("[data-commit-column-gutter]");

    expect(gutters?.length).toBe(3);
    expect(
      [...(gutters ?? [])].every(
        (gutter) => (gutter as HTMLElement).style.width === "9px",
      ),
    ).toBe(true);
  });
});
