import { beforeEach, describe, expect, it, vi } from "vitest";

// Capture the event handler registered by panel-store at import time so the
// test can dispatch events into it. panel-store calls bridge.onEvent(cb) once
// at module load.
let panelEventHandler: ((event: string, data: unknown) => void) | null = null;

vi.mock("../bridge", () => ({
  bridge: {
    request: vi.fn().mockResolvedValue({ commits: [], lanes: {} }),
    onEvent: vi.fn((cb: (event: string, data: unknown) => void) => {
      panelEventHandler = cb;
      return () => {};
    }),
    setRepoContext: vi.fn(),
  },
}));

// Import after the mock is installed so the module-load onEvent call is captured.
const {
  usePanelStore,
  _resetOperationProgressForTests,
  _beginClientOperation,
  _endClientOperation,
} = await import("./panel-store");
const { useRepoStore } = await import("./repo-store");

function emit(event: string, data: unknown): void {
  if (!panelEventHandler) {
    throw new Error("panel event handler was never registered");
  }
  panelEventHandler(event, data);
}

describe("panel-store operationInProgress per-repo filter", () => {
  beforeEach(() => {
    _resetOperationProgressForTests();
    usePanelStore.setState({ operationInProgress: false });
    useRepoStore.setState({ activeRepoId: null });
  });

  it("an operationStart on the active repo sets operationInProgress", () => {
    useRepoStore.setState({ activeRepoId: "A" });
    emit("operationStart", { repoId: "A" });
    expect(usePanelStore.getState().operationInProgress).toBe(true);
  });

  it("an operationStart on a different repo does NOT set operationInProgress", () => {
    useRepoStore.setState({ activeRepoId: "A" });
    emit("operationStart", { repoId: "B" });
    expect(usePanelStore.getState().operationInProgress).toBe(false);
  });

  it("operationEnd on the active repo's op clears operationInProgress", () => {
    useRepoStore.setState({ activeRepoId: "A" });
    emit("operationStart", { repoId: "A" });
    expect(usePanelStore.getState().operationInProgress).toBe(true);
    emit("operationEnd", { repoId: "A" });
    expect(usePanelStore.getState().operationInProgress).toBe(false);
  });

  it("operationEnd on a non-active repo does not flip a false state", () => {
    useRepoStore.setState({ activeRepoId: "A" });
    emit("operationStart", { repoId: "B" }); // active repo A unaffected
    expect(usePanelStore.getState().operationInProgress).toBe(false);
    emit("operationEnd", { repoId: "B" });
    expect(usePanelStore.getState().operationInProgress).toBe(false);
  });

  it("switching to a repo with an in-flight op re-derives busy=true (I1: order-independent)", () => {
    // Reproduce the REAL multi-store flow: repo-store's `activeRepoChanged`
    // bridge handler is registered LATER (in a useEffect) than panel-store's,
    // so on the event panel-store runs first and reads a STALE activeRepoId.
    // repo-store then updates activeRepoId AFTER. The fix makes panel-store
    // recompute on the activeRepoId STORE change, not on the bridge event, so
    // it is correct regardless of handler registration order.
    //
    // This test does NOT pre-set activeRepoId before the switch the way the
    // old test did. It drives the switch the way repo-store actually does:
    // setState({ activeRepoId }) — the bridge event is a red herring for the
    // recompute trigger.
    useRepoStore.setState({ activeRepoId: "A" });
    emit("operationStart", { repoId: "B" }); // B op starts while A visible
    expect(usePanelStore.getState().operationInProgress).toBe(false);
    // User switches to B. repo-store's handler (which would also run here) does
    // setState({ activeRepoId: "B" }) — with the subscribe-based fix this store
    // change triggers the recompute, surfacing B's in-flight op.
    useRepoStore.setState({ activeRepoId: "B" });
    expect(usePanelStore.getState().operationInProgress).toBe(true);
  });

  it("switching away from a busy repo clears busy when the new repo has no op (I1)", () => {
    useRepoStore.setState({ activeRepoId: "A" });
    emit("operationStart", { repoId: "A" });
    expect(usePanelStore.getState().operationInProgress).toBe(true);
    // Switch via the store change (not the bridge event) — see I1 test above.
    useRepoStore.setState({ activeRepoId: "B" });
    expect(usePanelStore.getState().operationInProgress).toBe(false);
  });

  it("ignores an operationStart with repoId:null (non-repo-bound op)", () => {
    useRepoStore.setState({ activeRepoId: "A" });
    emit("operationStart", { repoId: null });
    expect(usePanelStore.getState().operationInProgress).toBe(false);
  });

  it("tracks multiple concurrent in-flight ops across repos", () => {
    useRepoStore.setState({ activeRepoId: "A" });
    emit("operationStart", { repoId: "A" });
    emit("operationStart", { repoId: "B" });
    expect(usePanelStore.getState().operationInProgress).toBe(true); // A in flight
    emit("operationEnd", { repoId: "A" });
    expect(usePanelStore.getState().operationInProgress).toBe(false); // only B left
    // Switch via the store change (see I1 test) — B is still in flight.
    useRepoStore.setState({ activeRepoId: "B" });
    expect(usePanelStore.getState().operationInProgress).toBe(true); // B in flight
  });
});

describe("panel-store client-side operation markers (bridgeWithProgress)", () => {
  beforeEach(() => {
    _resetOperationProgressForTests();
    usePanelStore.setState({ operationInProgress: false });
    useRepoStore.setState({ activeRepoId: null });
  });

  it("_beginClientOperation on the active repo sets operationInProgress", () => {
    useRepoStore.setState({ activeRepoId: "A" });
    _beginClientOperation("A");
    expect(usePanelStore.getState().operationInProgress).toBe(true);
  });

  it("_beginClientOperation on a non-active repo does NOT set operationInProgress", () => {
    useRepoStore.setState({ activeRepoId: "A" });
    _beginClientOperation("B");
    expect(usePanelStore.getState().operationInProgress).toBe(false);
    // the marker is tracked, so switching to B re-derives busy (via the store
    // change — see I1 test)
    useRepoStore.setState({ activeRepoId: "B" });
    expect(usePanelStore.getState().operationInProgress).toBe(true);
  });

  it("_endClientOperation clears the active repo's op", () => {
    useRepoStore.setState({ activeRepoId: "A" });
    _beginClientOperation("A");
    expect(usePanelStore.getState().operationInProgress).toBe(true);
    _endClientOperation("A");
    expect(usePanelStore.getState().operationInProgress).toBe(false);
  });

  it("a null client op (no active repo) is a no-op", () => {
    useRepoStore.setState({ activeRepoId: null });
    _beginClientOperation(null);
    expect(usePanelStore.getState().operationInProgress).toBe(false);
    _endClientOperation(null);
    expect(usePanelStore.getState().operationInProgress).toBe(false);
  });

  it("host events and client markers compose for the same repo", () => {
    useRepoStore.setState({ activeRepoId: "A" });
    _beginClientOperation("A"); // client-side marker (e.g. createBranch)
    emit("operationStart", { repoId: "A" }); // host also tags (e.g. via fetch)
    expect(usePanelStore.getState().operationInProgress).toBe(true);
    _endClientOperation("A"); // client done, but host op still in flight
    expect(usePanelStore.getState().operationInProgress).toBe(true);
    emit("operationEnd", { repoId: "A" }); // now fully clear
    expect(usePanelStore.getState().operationInProgress).toBe(false);
  });
});

describe("panel-store resetForRepoSwitch", () => {
  beforeEach(() => {
    usePanelStore.setState({
      filter: {
        searchQuery: "",
        branch: "",
        author: "",
        dateRange: "",
        file: "",
      },
      commits: [],
      branches: [],
      tags: [],
      collapsedSequenceIds: new Set(),
      collapsedIntermediates: new Map(),
      pendingSelectionFromFilter: [],
    });
  });

  it("clears repo-scoped branch/file but preserves carryover search/author/date", () => {
    usePanelStore.setState({
      filter: {
        searchQuery: "fix",
        branch: "feature",
        author: "alice",
        dateRange: "7days",
        file: "src/a.ts",
      },
    });
    usePanelStore.getState().resetForRepoSwitch();
    const { filter } = usePanelStore.getState();
    expect(filter.branch).toBe(""); // repo-scoped → reset
    expect(filter.file).toBe(""); // repo-scoped → reset
    // carryover (global-scope) fields preserved
    expect(filter.searchQuery).toBe("fix");
    expect(filter.author).toBe("alice");
    expect(filter.dateRange).toBe("7days");
  });

  it("clears collapse + pending-selection state tied to the old repo's graph", () => {
    usePanelStore.setState({
      collapsedSequenceIds: new Set(["seq1"]),
      collapsedIntermediates: new Map([["seq1", ["h1"]]]),
      pendingSelectionFromFilter: ["abc", "def"],
    });
    usePanelStore.getState().resetForRepoSwitch();
    const s = usePanelStore.getState();
    expect(s.collapsedSequenceIds.size).toBe(0);
    expect(s.collapsedIntermediates.size).toBe(0);
    expect(s.pendingSelectionFromFilter).toEqual([]);
  });

  it("clears ALL repo-bound display data (commits/branches/tags/graph/selection/range) on switch (F3)", () => {
    // Seed the store with repo-A data across every repo-bound field.
    usePanelStore.setState({
      commits: [{ hash: "a1" } as never],
      visibleCommits: [{ hash: "a1" } as never],
      branches: [{ name: "main", isCurrent: true } as never],
      tags: [{ name: "v1" } as never],
      currentBranch: "main",
      graphLayout: { lane0: {} as never },
      laneSnapshot: { lanes: [], commitLanes: { a1: 0 } } as never,
      selectedCommitHash: "a1",
      selectedCommitHashes: ["a1"],
      lastSelectedCommitHash: "a1",
      selectedBranches: ["feature-a"],
      lastSelectedBranch: "feature-a",
      commitFiles: [{ path: "a.ts" } as never],
      selectedFilePath: "a.ts",
      rangeOldest: "a1",
      rangeNewest: "a1",
      collapsedSequenceIds: new Set(["seq1"]),
      collapsedIntermediates: new Map([["seq1", ["h1"]]]),
      pendingSelectionFromFilter: ["a1"],
      filter: {
        searchQuery: "keep-search",
        branch: "feature-a",
        author: "keep-author",
        dateRange: "keep-date",
        file: "src/a.ts",
      },
    });

    usePanelStore.getState().resetForRepoSwitch();
    const s = usePanelStore.getState();

    // repo-bound display data cleared — nothing stale to act on during B's load
    expect(s.commits).toEqual([]);
    expect(s.visibleCommits).toEqual([]);
    expect(s.branches).toEqual([]);
    expect(s.tags).toEqual([]);
    expect(s.currentBranch).toBe("");
    expect(s.graphLayout).toEqual({});
    expect(s.laneSnapshot).toBeNull();
    // selection cleared (A's hashes must not survive into a B-bound context)
    expect(s.selectedCommitHash).toBeNull();
    expect(s.selectedCommitHashes).toEqual([]);
    expect(s.lastSelectedCommitHash).toBeNull();
    expect(s.selectedBranches).toEqual([]);
    expect(s.lastSelectedBranch).toBeNull();
    expect(s.commitFiles).toEqual([]);
    expect(s.selectedFilePath).toBeNull();
    // range cleared
    expect(s.rangeOldest).toBeNull();
    expect(s.rangeNewest).toBeNull();
    // collapse + pending-selection (tied to old graph/hashes) cleared
    expect(s.collapsedSequenceIds.size).toBe(0);
    expect(s.collapsedIntermediates.size).toBe(0);
    expect(s.pendingSelectionFromFilter).toEqual([]);

    // repo-scoped filter cleared, carryover preserved
    expect(s.filter.branch).toBe("");
    expect(s.filter.file).toBe("");
    expect(s.filter.searchQuery).toBe("keep-search");
    expect(s.filter.author).toBe("keep-author");
    expect(s.filter.dateRange).toBe("keep-date");
  });

  it("resetForRepoSwitch clears the same repo-bound field set as clearForNoRepo (no drift)", () => {
    // Seed identical rich state, run both resets, and assert the repo-bound
    // (non-filter, non-hasMore) slice is identical between the two paths.
    const seed = {
      commits: [{ hash: "a1" } as never],
      visibleCommits: [{ hash: "a1" } as never],
      branches: [{ name: "main", isCurrent: true } as never],
      tags: [{ name: "v1" } as never],
      currentBranch: "main",
      graphLayout: { lane0: {} as never },
      laneSnapshot: { lanes: [], commitLanes: {} } as never,
      selectedCommitHash: "a1",
      selectedCommitHashes: ["a1"],
      lastSelectedCommitHash: "a1",
      selectedBranches: ["feature-a"],
      lastSelectedBranch: "feature-a",
      commitFiles: [{ path: "a.ts" } as never],
      selectedFilePath: "a.ts",
      rangeOldest: "a1",
      rangeNewest: "a1",
      collapsedSequenceIds: new Set(["seq1"]),
      collapsedIntermediates: new Map([["seq1", ["h1"]]]),
      pendingSelectionFromFilter: ["a1"],
    };

    usePanelStore.setState({ ...seed });
    usePanelStore.getState().resetForRepoSwitch();
    const afterSwitch = usePanelStore.getState();

    usePanelStore.setState({ ...seed });
    usePanelStore.getState().clearForNoRepo();
    const afterNull = usePanelStore.getState();

    const pick = (s: typeof afterSwitch) => ({
      commits: s.commits,
      visibleCommits: s.visibleCommits,
      branches: s.branches,
      tags: s.tags,
      currentBranch: s.currentBranch,
      graphLayout: s.graphLayout,
      laneSnapshot: s.laneSnapshot,
      selectedCommitHash: s.selectedCommitHash,
      selectedCommitHashes: s.selectedCommitHashes,
      lastSelectedCommitHash: s.lastSelectedCommitHash,
      selectedBranches: s.selectedBranches,
      lastSelectedBranch: s.lastSelectedBranch,
      commitFiles: s.commitFiles,
      selectedFilePath: s.selectedFilePath,
      rangeOldest: s.rangeOldest,
      rangeNewest: s.rangeNewest,
      collapsedSequenceIds: s.collapsedSequenceIds,
      collapsedIntermediates: s.collapsedIntermediates,
      pendingSelectionFromFilter: s.pendingSelectionFromFilter,
    });

    expect(pick(afterSwitch)).toEqual(pick(afterNull));
  });

  it("clears selectedBranches / lastSelectedBranch on repo switch so wrong-repo branch ops are disabled", () => {
    // Hazard: BranchSidebar/BoundTree gate Update/Delete/Favorite/Navigate on
    // selectedBranches[0]. If repo-A's selected branch survives the A→B switch and
    // repo-B happens to have a same-named branch, the op is routed through the
    // B-bound bridge onto the wrong repo. Resetting both fields closes that window:
    // after switch, BranchSidebar has no selected branch, so those actions are
    // DISABLED until the user selects a branch in repo-B.
    usePanelStore.setState({
      selectedBranches: ["repo-A-branch"],
      lastSelectedBranch: "repo-A-branch",
      branches: [{ name: "repo-A-branch", isCurrent: true } as never],
    });
    usePanelStore.getState().resetForRepoSwitch();
    const s = usePanelStore.getState();
    expect(s.selectedBranches).toEqual([]);
    expect(s.lastSelectedBranch).toBeNull();
  });

  it("a failed fetchInitialData after reset does NOT resurrect stale repo-A data (F3 fetch-failure guarantee)", async () => {
    const { bridge } = await import("../bridge");
    const mockedRequest = vi.mocked(bridge.request);
    mockedRequest.mockReset();

    // Seed repo-A display data, then switch (clearing it all).
    usePanelStore.setState({
      commits: [{ hash: "a1" } as never],
      branches: [{ name: "main", isCurrent: true } as never],
      tags: [{ name: "v1" } as never],
      selectedCommitHash: "a1",
      graphLayout: { lane0: {} as never },
      filter: {
        searchQuery: "keep",
        branch: "feature-a",
        author: "al",
        dateRange: "7days",
        file: "src/a.ts",
      },
    });
    usePanelStore.getState().resetForRepoSwitch();

    // Simulate repo B's fetch failing entirely.
    mockedRequest.mockRejectedValue(new Error("network down"));
    await usePanelStore.getState().fetchInitialData();

    const s = usePanelStore.getState();
    // Store stays empty — no A data resurrected by the failed fetch.
    expect(s.commits).toEqual([]);
    expect(s.branches).toEqual([]);
    expect(s.tags).toEqual([]);
    expect(s.selectedCommitHash).toBeNull();
    expect(s.graphLayout).toEqual({});
    // Carryover filter still preserved across the failed fetch.
    expect(s.filter.searchQuery).toBe("keep");
    expect(s.filter.branch).toBe("");
    expect(s.filter.file).toBe("");
  });

  it("after reset, fetchInitialData does NOT carry the old repo's branch/file into getGraphData", async () => {
    const { bridge } = await import("../bridge");
    const mockedRequest = vi.mocked(bridge.request);
    mockedRequest.mockReset();
    // Seed the store as if the user had filtered repo A by branch + file.
    usePanelStore.setState({
      filter: {
        searchQuery: "bug",
        branch: "feature-a",
        author: "bob",
        dateRange: "30days",
        file: "src/a.ts",
      },
      commits: [],
    });
    // Resolve all bridge requests with empty-ish payloads so fetchInitialData
    // completes without throwing.
    mockedRequest.mockImplementation(async (cmd: string) => {
      if (cmd === "getGraphData") {
        return {
          graphData: { commits: [], lanes: {} },
          snapshot: { lanes: [], commitLanes: {} },
        };
      }
      if (cmd === "getBranches") return [];
      if (cmd === "getTags") return [];
      return null;
    });

    // Simulate the App switch handler: reset THEN fetch.
    usePanelStore.getState().resetForRepoSwitch();
    await usePanelStore.getState().fetchInitialData();

    // Find the getGraphData call and inspect its params.
    const graphCall = mockedRequest.mock.calls.find(
      (c) => c[0] === "getGraphData",
    );
    expect(graphCall).toBeTruthy();
    const params = (graphCall?.[1] ?? {}) as {
      branch?: string;
      file?: string;
    };
    expect(params.branch).toBeUndefined(); // old repo's branch NOT carried
    expect(params.file).toBeUndefined(); // old repo's file NOT carried
  });
});

describe("panel-store clearForNoRepo", () => {
  beforeEach(() => {
    usePanelStore.setState({
      filter: {
        searchQuery: "",
        branch: "",
        author: "",
        dateRange: "",
        file: "",
      },
      commits: [],
      branches: [],
      tags: [],
      currentBranch: "",
      graphLayout: {},
      laneSnapshot: null,
      selectedCommitHash: null,
      selectedCommitHashes: [],
      commitFiles: [],
      visibleCommits: [],
    });
  });

  it("clears commits/branches/tags and repo-scoped filter when activeRepoId becomes null", () => {
    // Seed stale repo-A data.
    usePanelStore.setState({
      commits: [{ hash: "a1" } as never],
      visibleCommits: [{ hash: "a1" } as never],
      branches: [{ name: "main", isCurrent: true } as never],
      tags: [{ name: "v1" } as never],
      currentBranch: "main",
      graphLayout: { x: {} },
      selectedCommitHash: "a1",
      selectedCommitHashes: ["a1"],
      commitFiles: [{} as never],
      filter: {
        searchQuery: "keep",
        branch: "feature",
        author: "carol",
        dateRange: "today",
        file: "src/a.ts",
      },
    });

    usePanelStore.getState().clearForNoRepo();
    const s = usePanelStore.getState();

    // repo-bound display data cleared
    expect(s.commits).toEqual([]);
    expect(s.visibleCommits).toEqual([]);
    expect(s.branches).toEqual([]);
    expect(s.tags).toEqual([]);
    expect(s.currentBranch).toBe("");
    expect(s.graphLayout).toEqual({});
    expect(s.selectedCommitHash).toBeNull();
    expect(s.selectedCommitHashes).toEqual([]);
    expect(s.commitFiles).toEqual([]);

    // repo-scoped filter cleared, carryover preserved
    expect(s.filter.branch).toBe("");
    expect(s.filter.file).toBe("");
    expect(s.filter.searchQuery).toBe("keep");
    expect(s.filter.author).toBe("carol");
    expect(s.filter.dateRange).toBe("today");
  });
});
