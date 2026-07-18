import {
  act,
  cleanup,
  fireEvent,
  render,
  waitFor,
  within,
} from "@testing-library/react";
import type { PropsWithChildren } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { GitRefIdentity } from "../shared/types/git";

const mocks = vi.hoisted(() => {
  const eventListeners = new Set<(event: string, data: unknown) => void>();
  const state = {
    graphMode: "data" as
      | "data"
      | "empty"
      | "ref-unavailable"
      | "repo-not-found"
      | "generic-error",
  };

  const commit = (hash: string, subject: string) => ({
    hash,
    shortHash: hash,
    parents: [],
    authorName: "Ada",
    authorEmail: "ada@example.com",
    authorDate: "2026-07-18T00:00:00.000Z",
    subject,
    body: "",
    refs: [],
  });

  const request = vi.fn(
    async (command: string, params: Record<string, unknown> = {}) => {
      if (command === "getBranches") return [];
      if (command === "getTags" || command === "getCommitRangeFiles") {
        return [];
      }
      if (command !== "getGraphData" && command !== "loadMoreLog") {
        return null;
      }

      if (state.graphMode === "repo-not-found") {
        throw Object.assign(new Error("Repository was removed"), {
          code: "REPO_NOT_FOUND",
        });
      }
      if (state.graphMode === "generic-error") {
        throw Object.assign(new Error("Git process failed"), {
          code: "GIT_FAILED",
        });
      }

      const revision = params.revision as
        | {
            kind: "range";
            excludeRef: GitRefIdentity;
            includeRef: GitRefIdentity;
          }
        | undefined;
      if (state.graphMode === "ref-unavailable") {
        return {
          status: "ref-unavailable" as const,
          ref: revision?.includeRef,
        };
      }

      const isTop = revision?.includeRef.fullRef === "refs/heads/feature";
      const commits =
        state.graphMode === "empty" || params.search
          ? []
          : isTop
            ? [commit("top-1", "Top first"), commit("top-2", "Top second")]
            : [
                commit("bottom-1", "Bottom first"),
                commit("bottom-2", "Bottom second"),
              ];
      return {
        status: "ok" as const,
        graphData: { commits, lanes: {} },
        snapshot: {
          activeLanes: [],
          laneColors: [],
          nextColorIndex: 0,
        },
        hasMore: false,
      };
    },
  );
  const onEvent = vi.fn((handler: (event: string, data: unknown) => void) => {
    eventListeners.add(handler);
    return () => eventListeners.delete(handler);
  });
  return { eventListeners, onEvent, request, state };
});

vi.mock("../shared/bridge", () => ({
  bridge: {
    request: mocks.request,
    onEvent: mocks.onEvent,
    setRepoContext: vi.fn(),
  },
}));

vi.mock("allotment", () => {
  function Allotment({ children }: PropsWithChildren<{ vertical?: boolean }>) {
    return <div>{children}</div>;
  }
  Allotment.Pane = function Pane({ children }: PropsWithChildren) {
    return <div>{children}</div>;
  };
  return { Allotment };
});

vi.mock("../panel/components/Toolbar", async () => {
  const { useGitLogStore } = await import(
    "../shared/store/git-log-store-context"
  );
  return {
    Toolbar({ showBranchFilter = true }: { showBranchFilter?: boolean }) {
      const filter = useGitLogStore((store) => store.filter);
      const setFilter = useGitLogStore((store) => store.setFilter);
      return (
        <div>
          <input
            aria-label="Search commits"
            value={filter.searchQuery}
            onChange={(event) =>
              setFilter({ searchQuery: event.currentTarget.value })
            }
          />
          {showBranchFilter ? <button type="button">Branch</button> : null}
          <button type="button">User</button>
          <button type="button">Date</button>
          <button type="button">Columns</button>
        </div>
      );
    },
  };
});

vi.mock("../panel/components/GitGraphPanel", async () => {
  const { useGitLogStore } = await import(
    "../shared/store/git-log-store-context"
  );
  return {
    GitGraphPanel({
      onRefreshComparison,
    }: {
      onRefreshComparison?: () => void | Promise<void>;
    }) {
      const commits = useGitLogStore((store) => store.visibleCommits);
      const selectCommit = useGitLogStore((store) => store.selectCommit);
      return (
        <div>
          {commits.map((commit) => (
            <button
              key={commit.hash}
              type="button"
              onClick={() => void selectCommit(commit.hash)}
            >
              {commit.subject}
            </button>
          ))}
          <button type="button" onClick={() => void onRefreshComparison?.()}>
            Refresh comparison
          </button>
        </div>
      );
    },
  };
});

vi.mock("../panel/components/DetailPanel", async () => {
  const { useGitLogStore } = await import(
    "../shared/store/git-log-store-context"
  );
  return {
    DetailPanel() {
      const commits = useGitLogStore((store) => store.commits);
      const selectedHash = useGitLogStore((store) => store.selectedCommitHash);
      return (
        <div>
          {commits.find((commit) => commit.hash === selectedHash)?.subject ??
            "No selection"}
        </div>
      );
    },
  };
});

import { CompareApp } from "./App";

const currentRef: GitRefIdentity = {
  type: "local",
  name: "main",
  fullRef: "refs/heads/main",
};
const selectedRef: GitRefIdentity = {
  type: "local",
  name: "feature",
  fullRef: "refs/heads/feature",
};

function seedRoot(options: { repoId?: string } = { repoId: "repo-a" }) {
  let root = document.getElementById("root");
  if (!root) {
    root = document.createElement("div");
    root.id = "root";
    document.body.appendChild(root);
  }
  for (const key of Object.keys(root.dataset)) delete root.dataset[key];
  if (options.repoId) root.dataset.repoId = options.repoId;
  root.dataset.selectedRefType = selectedRef.type;
  root.dataset.selectedRefName = selectedRef.name;
  root.dataset.selectedRefFullRef = selectedRef.fullRef;
  root.dataset.currentRefType = currentRef.type;
  root.dataset.currentRefName = currentRef.name;
  root.dataset.currentRefFullRef = currentRef.fullRef;
}

function emit(event: string, data: unknown = {}) {
  act(() => {
    for (const listener of mocks.eventListeners) listener(event, data);
  });
}

function graphRequests() {
  return mocks.request.mock.calls
    .filter(([command]) => command === "getGraphData")
    .map(([, params, options]) => ({ params, options }));
}

async function renderLoaded() {
  const result = render(<CompareApp />);
  await waitFor(() => expect(graphRequests()).toHaveLength(2));
  await waitFor(() => {
    expect(
      within(result.getByTestId("compare-top")).getByRole("button", {
        name: "Top first",
      }),
    ).toBeTruthy();
    expect(
      within(result.getByTestId("compare-bottom")).getByRole("button", {
        name: "Bottom first",
      }),
    ).toBeTruthy();
  });
  return result;
}

describe("CompareApp", () => {
  beforeEach(() => {
    seedRoot();
    mocks.state.graphMode = "data";
    mocks.request.mockClear();
    mocks.onEvent.mockClear();
    mocks.eventListeners.clear();
  });

  afterEach(() => {
    cleanup();
    mocks.eventListeners.clear();
  });

  it("requests opposite ordered ranges and keeps filters and inspectors independent", async () => {
    const view = await renderLoaded();
    const requests = graphRequests();
    expect(requests[0]).toEqual({
      params: expect.objectContaining({
        revision: {
          kind: "range",
          excludeRef: currentRef,
          includeRef: selectedRef,
        },
      }),
      options: { repoId: "repo-a" },
    });
    expect(requests[1]).toEqual({
      params: expect.objectContaining({
        revision: {
          kind: "range",
          excludeRef: selectedRef,
          includeRef: currentRef,
        },
      }),
      options: { repoId: "repo-a" },
    });

    const top = view.getByTestId("compare-top");
    const bottom = view.getByTestId("compare-bottom");
    expect(within(top).queryByRole("button", { name: "Branch" })).toBeNull();
    expect(within(bottom).queryByRole("button", { name: "Branch" })).toBeNull();
    expect(within(top).getByRole("button", { name: "User" })).toBeTruthy();
    expect(
      within(bottom).getByRole("button", { name: "Columns" }),
    ).toBeTruthy();

    fireEvent.click(within(top).getByRole("button", { name: "Top second" }));
    await waitFor(() =>
      expect(
        within(view.getByTestId("compare-top-detail")).getByText("Top second"),
      ).toBeTruthy(),
    );
    expect(
      within(view.getByTestId("compare-bottom-detail")).getByText(
        "Bottom first",
      ),
    ).toBeTruthy();

    mocks.request.mockClear();
    fireEvent.change(within(top).getByRole("textbox", { name: /search/i }), {
      target: { value: "top only" },
    });
    await waitFor(() => expect(graphRequests()).toHaveLength(1));
    expect(graphRequests()[0]?.params).toEqual(
      expect.objectContaining({ search: "top only" }),
    );
    expect(
      within(bottom).getByRole<HTMLInputElement>("textbox", {
        name: /search/i,
      }).value,
    ).toBe("");
  });

  it("refreshes both ranges with retained filters and ignores other repositories", async () => {
    const view = await renderLoaded();
    const top = view.getByTestId("compare-top");
    fireEvent.change(within(top).getByRole("textbox", { name: /search/i }), {
      target: { value: "top only" },
    });
    await waitFor(() =>
      expect(
        graphRequests().some(
          ({ params }) =>
            (params as Record<string, unknown>).search === "top only",
        ),
      ).toBe(true),
    );

    mocks.request.mockClear();
    emit("comparePanelRefresh");
    await waitFor(() => expect(graphRequests()).toHaveLength(2));
    expect(
      graphRequests().filter(
        ({ params }) =>
          (params as Record<string, unknown>).search === "top only",
      ),
    ).toHaveLength(1);

    mocks.request.mockClear();
    emit("gitStateChanged", { repoId: "repo-b" });
    await act(async () => Promise.resolve());
    expect(graphRequests()).toHaveLength(0);

    emit("gitStateChanged", { repoId: "repo-a" });
    await waitFor(() => expect(graphRequests()).toHaveLength(2));

    mocks.request.mockClear();
    fireEvent.click(
      within(view.getByTestId("compare-bottom")).getByRole("button", {
        name: "Refresh comparison",
      }),
    );
    await waitFor(() => expect(graphRequests()).toHaveLength(2));
  });

  it("distinguishes empty range, filter-empty, and unavailable ref states", async () => {
    mocks.state.graphMode = "empty";
    const empty = render(<CompareApp />);
    await waitFor(() =>
      expect(empty.getByTestId("compare-top-state").dataset.state).toBe(
        "empty-range",
      ),
    );
    expect(empty.getByTestId("compare-top-state").textContent).toMatch(
      /no commits in this range/i,
    );
    cleanup();
    mocks.eventListeners.clear();

    mocks.state.graphMode = "data";
    mocks.request.mockClear();
    const filtered = await renderLoaded();
    fireEvent.change(
      within(filtered.getByTestId("compare-top")).getByRole("textbox", {
        name: /search/i,
      }),
      { target: { value: "does not match" } },
    );
    await waitFor(() =>
      expect(filtered.getByTestId("compare-top-state").dataset.state).toBe(
        "empty-filter",
      ),
    );
    expect(filtered.getByTestId("compare-top-state").textContent).toMatch(
      /no commits match/i,
    );
    cleanup();
    mocks.eventListeners.clear();

    mocks.state.graphMode = "ref-unavailable";
    mocks.request.mockClear();
    const unavailable = render(<CompareApp />);
    await waitFor(() =>
      expect(unavailable.getByTestId("compare-top-state").dataset.state).toBe(
        "ref-unavailable",
      ),
    );
    expect(unavailable.getByTestId("compare-top-state").textContent).toMatch(
      /ref.*unavailable/i,
    );
  });

  it("shows repository removal separately and clears it after a successful refresh", async () => {
    const view = await renderLoaded();
    mocks.state.graphMode = "repo-not-found";
    emit("comparePanelRefresh");
    await waitFor(() =>
      expect(view.getByTestId("compare-top-state").dataset.state).toBe(
        "repository-unavailable",
      ),
    );
    expect(view.getByTestId("compare-top-state").textContent).toMatch(
      /repository.*unavailable/i,
    );

    mocks.state.graphMode = "data";
    emit("comparePanelRefresh");
    await waitFor(() =>
      expect(
        within(view.getByTestId("compare-top")).getByRole("button", {
          name: "Top first",
        }),
      ).toBeTruthy(),
    );
    expect(view.queryByText(/repository.*unavailable/i)).toBeNull();
  });

  it("renders repository unavailable when the host seed has no repository", () => {
    seedRoot({});
    const view = render(<CompareApp />);
    expect(view.getByTestId("compare-app-state").dataset.state).toBe(
      "repository-unavailable",
    );
    expect(graphRequests()).toHaveLength(0);
  });
});
