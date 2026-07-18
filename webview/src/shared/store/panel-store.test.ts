import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Bridge, LogQueryRevision } from "../bridge/types";
import type { Commit, GitRefIdentity } from "../types/git";

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
  createGitLogStore,
  defaultGitLogStore,
  _resetOperationProgressForTests,
  _beginClientOperation,
  _endClientOperation,
} = await import("./panel-store");
const usePanelStore = defaultGitLogStore.store;
const { useRepoStore } = await import("./repo-store");
const { bridge } = await import("../bridge");

function emit(event: string, data: unknown): void {
  if (!panelEventHandler) {
    throw new Error("panel event handler was never registered");
  }
  panelEventHandler(event, data);
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
}

function commit(hash: string): Commit {
  return {
    hash,
    shortHash: hash.slice(0, 8),
    parents: [],
    authorName: "author",
    authorEmail: "author@example.com",
    authorDate: "2026-07-17T00:00:00.000Z",
    subject: hash,
    body: "",
    refs: [],
  };
}

function graphResult(commits: Commit[]) {
  return {
    graphData: { commits, lanes: {} },
    snapshot: { activeLanes: [], laneColors: [], nextColorIndex: 0 },
  };
}

function createFakeBridge(
  request: Bridge["request"] = vi.fn().mockResolvedValue([]),
) {
  const handlers = new Set<(event: string, data: unknown) => void>();
  const unsubscribe = vi.fn();
  const fakeBridge: Bridge = {
    request,
    onEvent: vi.fn((handler) => {
      handlers.add(handler);
      return () => {
        handlers.delete(handler);
        unsubscribe();
      };
    }),
    setRepoContext: vi.fn(),
  };
  return { bridge: fakeBridge, handlers, unsubscribe };
}

function comparisonHistory(revision: LogQueryRevision) {
  return { kind: "comparison" as const, revision };
}

describe("git log store instances", () => {
  it("keeps mutations and async graph results isolated", async () => {
    const topRange: LogQueryRevision = {
      kind: "ref",
      ref: { type: "local", name: "top", fullRef: "refs/heads/top" },
    };
    const bottomRange: LogQueryRevision = {
      kind: "ref",
      ref: {
        type: "local",
        name: "bottom",
        fullRef: "refs/heads/bottom",
      },
    };
    const { bridge: fakeBridge } = createFakeBridge(
      vi.fn(async (command, params) => {
        if (command === "getGraphData") {
          const revision = (params as { revision?: LogQueryRevision }).revision;
          return graphResult([
            commit(revision === topRange ? "top-result" : "bottom-result"),
          ]);
        }
        if (command === "getBranches" || command === "getTags") return [];
        if (command === "getCommitRangeFiles") return [];
        return null;
      }),
    );
    const top = createGitLogStore({
      repoId: "repo-a",
      history: comparisonHistory(topRange),
      followGlobalActiveRepo: false,
      showCurrentReachability: false,
      bridge: fakeBridge,
    });
    const bottom = createGitLogStore({
      repoId: "repo-a",
      history: comparisonHistory(bottomRange),
      followGlobalActiveRepo: false,
      showCurrentReachability: false,
      bridge: fakeBridge,
    });

    top.store.getState().setFilter({ searchQuery: "top" });
    expect(bottom.store.getState().filter.searchQuery).toBe("");
    void top.store.getState().selectCommit("a", "single", ["a"]);
    expect(bottom.store.getState().selectedCommitHashes).toEqual([]);

    await Promise.all([
      top.store.getState().fetchInitialData(),
      bottom.store.getState().fetchInitialData(),
    ]);

    expect(top.store.getState().commits.map(({ hash }) => hash)).toEqual([
      "top-result",
    ]);
    expect(bottom.store.getState().commits.map(({ hash }) => hash)).toEqual([
      "bottom-result",
    ]);
    top.dispose();
    bottom.dispose();
  });

  it("rejects a stale graph response after a newer filter intent", async () => {
    const older = deferred<ReturnType<typeof graphResult>>();
    const newer = deferred<ReturnType<typeof graphResult>>();
    const { bridge: fakeBridge } = createFakeBridge(
      vi.fn(async (command, params) => {
        if (command === "getGraphData") {
          return (params as { branch?: string }).branch === "branch-a"
            ? older.promise
            : newer.promise;
        }
        if (command === "getBranches" || command === "getTags") return [];
        if (command === "getCommitRangeFiles") return [];
        return null;
      }),
    );
    const instance = createGitLogStore({
      repoId: "repo-a",
      history: { kind: "ordinary" },
      followGlobalActiveRepo: false,
      showCurrentReachability: false,
      bridge: fakeBridge,
    });

    instance.store.setState((state) => ({
      filter: { ...state.filter, branch: "branch-a" },
    }));
    const first = instance.store.getState().fetchInitialData();
    instance.store.setState((state) => ({
      filter: { ...state.filter, branch: "branch-b" },
    }));
    const second = instance.store.getState().fetchInitialData();

    newer.resolve(graphResult([commit("branch-b-tip")]));
    await vi.waitFor(() => {
      expect(instance.store.getState().commits[0]?.hash).toBe("branch-b-tip");
    });
    older.resolve(graphResult([commit("branch-a-tip")]));
    await Promise.all([first, second]);

    expect(instance.store.getState().filter.branch).toBe("branch-b");
    expect(instance.store.getState().commits.map(({ hash }) => hash)).toEqual([
      "branch-b-tip",
    ]);
    instance.dispose();
  });

  it("releases its event subscription exactly once when disposed", () => {
    const fake = createFakeBridge();
    const instance = createGitLogStore({
      repoId: "repo-a",
      history: { kind: "ordinary" },
      followGlobalActiveRepo: false,
      showCurrentReachability: false,
      bridge: fake.bridge,
    });

    expect(fake.handlers.size).toBe(1);
    instance.dispose();
    instance.dispose();

    expect(fake.handlers.size).toBe(0);
    expect(fake.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("uses tagged query hasMore and exposes an unavailable revision", async () => {
    const revisionRef: GitRefIdentity = {
      type: "local",
      name: "feature",
      fullRef: "refs/heads/feature",
    };
    let unavailable = false;
    const { bridge: fakeBridge } = createFakeBridge(
      vi.fn(async (command) => {
        if (command === "getGraphData") {
          return unavailable
            ? { status: "ref-unavailable", ref: revisionRef }
            : {
                status: "ok",
                ...graphResult([commit("feature-tip")]),
                hasMore: true,
              };
        }
        if (command === "getBranches" || command === "getTags") return [];
        if (command === "getCommitRangeFiles") return [];
        return null;
      }),
    );
    const instance = createGitLogStore({
      repoId: "repo-a",
      history: comparisonHistory({ kind: "ref", ref: revisionRef }),
      followGlobalActiveRepo: false,
      showCurrentReachability: false,
      bridge: fakeBridge,
    });

    await instance.store.getState().fetchInitialData();
    expect(instance.store.getState().hasMore).toBe(true);
    expect(instance.store.getState().unavailableRef).toBeNull();

    unavailable = true;
    await instance.store.getState().refresh();

    expect(instance.store.getState().unavailableRef).toEqual(revisionRef);
    expect(instance.store.getState().commits).toEqual([]);
    expect(instance.store.getState().hasMore).toBe(false);
    instance.dispose();
  });

  it("ignores global file-history events in a fixed ordinary store", () => {
    const fake = createFakeBridge();
    const instance = createGitLogStore({
      repoId: "repo-a",
      history: { kind: "ordinary" },
      followGlobalActiveRepo: false,
      showCurrentReachability: false,
      bridge: fake.bridge,
    });

    for (const handler of fake.handlers) {
      handler("showFileHistory", { file: "src/a.ts" });
    }
    const fileFilter = instance.store.getState().filter.file;
    const requestCount = vi.mocked(fake.bridge.request).mock.calls.length;
    instance.dispose();

    expect(fileFilter).toBe("");
    expect(requestCount).toBe(0);
  });
});

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
      selectedRefs: [
        {
          type: "local",
          name: "feature-a",
          fullRef: "refs/heads/feature-a",
        },
      ],
      lastSelectedRefKey: "local\0feature-a",
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
    expect(s.selectedRefs).toEqual([]);
    expect(s.lastSelectedRefKey).toBeNull();
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
      selectedRefs: [
        {
          type: "local" as const,
          name: "feature-a",
          fullRef: "refs/heads/feature-a",
        },
      ],
      lastSelectedRefKey: "local\0feature-a",
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
      selectedRefs: s.selectedRefs,
      lastSelectedRefKey: s.lastSelectedRefKey,
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

  it("clears selectedRefs / lastSelectedRefKey on repo switch so wrong-repo ref ops are disabled", () => {
    usePanelStore.setState({
      selectedRefs: [
        {
          type: "local",
          name: "repo-A-branch",
          fullRef: "refs/heads/repo-A-branch",
        },
      ],
      lastSelectedRefKey: "local\0repo-A-branch",
      branches: [{ name: "repo-A-branch", isCurrent: true } as never],
    });
    usePanelStore.getState().resetForRepoSwitch();
    const s = usePanelStore.getState();
    expect(s.selectedRefs).toEqual([]);
    expect(s.lastSelectedRefKey).toBeNull();
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

describe("panel-store ref selection", () => {
  const localMain: GitRefIdentity = {
    type: "local",
    name: "main",
    fullRef: "refs/heads/main",
  };
  const tagMain: GitRefIdentity = {
    type: "tag",
    name: "main",
    fullRef: "refs/tags/main",
  };

  it("selects same-named refs independently and clears them on repo switch", () => {
    usePanelStore.setState({ selectedRefs: [], lastSelectedRefKey: null });

    usePanelStore
      .getState()
      .selectRef(localMain, "single", [localMain, tagMain]);
    usePanelStore.getState().selectRef(tagMain, "toggle", [localMain, tagMain]);

    expect(usePanelStore.getState().selectedRefs).toEqual([localMain, tagMain]);

    usePanelStore.getState().resetForRepoSwitch();
    expect(usePanelStore.getState().selectedRefs).toEqual([]);
    expect(usePanelStore.getState().lastSelectedRefKey).toBeNull();
  });

  it("persists favorite state and patches only the matching ref type", async () => {
    const request = vi.mocked(bridge.request);
    request.mockResolvedValueOnce({ ref: tagMain, isFavorite: true });
    usePanelStore.setState({
      branches: [
        {
          name: "main",
          fullRef: "refs/heads/main",
          isRemote: false,
          isCurrent: true,
          isFavorite: false,
        } as never,
      ],
      tags: [
        {
          name: "main",
          fullRef: "refs/tags/main",
          isFavorite: false,
        } as never,
      ],
    });

    await usePanelStore.getState().setFavorite(tagMain, true);

    expect(request).toHaveBeenCalledWith("setFavorite", {
      ref: tagMain,
      favorite: true,
    });
    expect(usePanelStore.getState().branches[0].isFavorite).toBe(false);
    expect(usePanelStore.getState().tags[0].isFavorite).toBe(true);
  });

  it("loads and persists branch dashboard preferences", async () => {
    const request = vi.mocked(bridge.request);
    request
      .mockResolvedValueOnce({ showTags: false, singleClickAction: "navigate" })
      .mockResolvedValueOnce({ showTags: true, singleClickAction: "filter" });

    await usePanelStore.getState().loadBranchDashboardPreferences();
    expect(usePanelStore.getState().showTags).toBe(false);
    expect(usePanelStore.getState().singleClickAction).toBe("navigate");

    await usePanelStore
      .getState()
      .setBranchDashboardPreferences({ showTags: true });
    expect(request).toHaveBeenLastCalledWith(
      "setBranchDashboardPreferences",
      { showTags: true },
      { scope: "global" },
    );
    expect(usePanelStore.getState().showTags).toBe(true);
    expect(usePanelStore.getState().singleClickAction).toBe("filter");
  });

  it("navigates to a loaded ref target and exposes a one-shot scroll target", async () => {
    usePanelStore.setState({
      commits: [{ hash: "tip" } as never],
      visibleCommits: [{ hash: "tip" } as never],
      filter: {
        searchQuery: "",
        branch: "",
        author: "",
        dateRange: "",
        file: "",
      },
      scrollTargetHash: null,
    });

    await usePanelStore.getState().navigateToRef(localMain, "tip");

    expect(usePanelStore.getState().selectedCommitHash).toBe("tip");
    expect(usePanelStore.getState().scrollTargetHash).toBe("tip");
    usePanelStore.getState().clearScrollTarget();
    expect(usePanelStore.getState().scrollTargetHash).toBeNull();
  });

  it("loads additional pages before navigating to an older ref target", async () => {
    const originalLoadMore = usePanelStore.getState().loadMore;
    const loadMore = vi.fn(async () => {
      usePanelStore.setState({
        commits: [{ hash: "old-tip" } as never],
        visibleCommits: [{ hash: "old-tip" } as never],
        hasMore: false,
      });
    });
    usePanelStore.setState({
      commits: [],
      visibleCommits: [],
      hasMore: true,
      loading: false,
      scrollTargetHash: null,
      loadMore,
    });

    await usePanelStore.getState().navigateToRef(localMain, "old-tip");

    expect(loadMore).toHaveBeenCalledTimes(1);
    expect(usePanelStore.getState().selectedCommitHash).toBe("old-tip");
    expect(usePanelStore.getState().scrollTargetHash).toBe("old-tip");
    usePanelStore.setState({ loadMore: originalLoadMore });
  });

  it("clears an existing branch filter before navigating to another ref", async () => {
    const request = vi.mocked(bridge.request);
    request.mockReset();
    request.mockImplementation(async (command, params) => {
      if (command === "getGraphData") {
        expect((params as { branch?: string }).branch).toBeUndefined();
        return graphResult([commit("target-tip")]);
      }
      if (command === "getBranches" || command === "getTags") return [];
      if (command === "getCommitRangeFiles") return [];
      return null;
    });
    usePanelStore.setState({
      commits: [commit("branch-a-tip")],
      visibleCommits: [commit("branch-a-tip")],
      filter: {
        searchQuery: "",
        branch: "refs/heads/branch-a",
        author: "",
        dateRange: "",
        file: "",
      },
      hasMore: false,
      loading: false,
    });

    await usePanelStore.getState().navigateToRef(localMain, "target-tip");

    expect(usePanelStore.getState().filter.branch).toBe("");
    expect(usePanelStore.getState().selectedCommitHash).toBe("target-tip");
    expect(usePanelStore.getState().scrollTargetHash).toBe("target-tip");
    expect(request).not.toHaveBeenCalledWith(
      "showErrorNotification",
      expect.anything(),
      expect.anything(),
    );
  });

  it("waits for an active log load instead of reporting a false navigation miss", async () => {
    const request = vi.mocked(bridge.request);
    const graph = deferred<ReturnType<typeof graphResult>>();
    request.mockReset();
    request.mockImplementation(async (command) => {
      if (command === "getGraphData") return graph.promise;
      if (command === "getBranches" || command === "getTags") return [];
      if (command === "getCommitRangeFiles") return [];
      return null;
    });
    usePanelStore.setState({
      commits: [],
      visibleCommits: [],
      filter: {
        searchQuery: "",
        branch: "",
        author: "",
        dateRange: "",
        file: "",
      },
      hasMore: true,
      loading: false,
      scrollTargetHash: null,
    });

    const loading = usePanelStore.getState().fetchInitialData();
    const navigation = usePanelStore
      .getState()
      .navigateToRef(localMain, "loaded-tip");
    graph.resolve(graphResult([commit("loaded-tip")]));
    await Promise.all([loading, navigation]);

    expect(usePanelStore.getState().selectedCommitHash).toBe("loaded-tip");
    expect(usePanelStore.getState().scrollTargetHash).toBe("loaded-tip");
    expect(request).not.toHaveBeenCalledWith(
      "showErrorNotification",
      expect.anything(),
      expect.anything(),
    );
  });

  it("lets a later filter change cancel an in-flight paginated navigation", async () => {
    const request = vi.mocked(bridge.request);
    const page = deferred<ReturnType<typeof graphResult>>();
    request.mockReset();
    request.mockImplementation(async (command) => {
      if (command === "loadMoreLog") return page.promise;
      if (command === "getCommitRangeFiles") return [];
      return null;
    });
    const current = commit("keep-current");
    usePanelStore.setState({
      commits: [current],
      visibleCommits: [current],
      selectedCommitHash: current.hash,
      selectedCommitHashes: [current.hash],
      filter: {
        searchQuery: "",
        branch: "",
        author: "",
        dateRange: "",
        file: "",
      },
      hasMore: true,
      loading: false,
      scrollTargetHash: null,
    });

    const navigation = usePanelStore
      .getState()
      .navigateToRef(localMain, "target-tip");
    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith("loadMoreLog", expect.anything());
    });
    usePanelStore.getState().setFilter({ searchQuery: "keep" });
    page.resolve(graphResult([commit("target-tip")]));
    await navigation;

    expect(usePanelStore.getState().filter.searchQuery).toBe("keep");
    expect(usePanelStore.getState().selectedCommitHash).toBe(current.hash);
    expect(usePanelStore.getState().scrollTargetHash).toBeNull();
    expect(request).not.toHaveBeenCalledWith(
      "showErrorNotification",
      expect.anything(),
      expect.anything(),
    );
  });

  it("lets a later manual commit selection cancel an in-flight navigation", async () => {
    const request = vi.mocked(bridge.request);
    const page = deferred<ReturnType<typeof graphResult>>();
    request.mockReset();
    request.mockImplementation(async (command) => {
      if (command === "loadMoreLog") return page.promise;
      if (command === "getCommitRangeFiles") return [];
      return null;
    });
    const current = commit("current");
    const manual = commit("manual");
    usePanelStore.setState({
      commits: [current, manual],
      visibleCommits: [current, manual],
      selectedCommitHash: current.hash,
      selectedCommitHashes: [current.hash],
      filter: {
        searchQuery: "",
        branch: "",
        author: "",
        dateRange: "",
        file: "",
      },
      hasMore: true,
      loading: false,
      scrollTargetHash: null,
    });

    const navigation = usePanelStore
      .getState()
      .navigateToRef(localMain, "target-tip");
    await vi.waitFor(() => {
      expect(request).toHaveBeenCalledWith("loadMoreLog", expect.anything());
    });
    await usePanelStore
      .getState()
      .selectCommit(manual.hash, "single", [current.hash, manual.hash]);
    page.resolve(graphResult([commit("target-tip")]));
    await navigation;

    expect(usePanelStore.getState().selectedCommitHash).toBe(manual.hash);
    expect(usePanelStore.getState().scrollTargetHash).toBeNull();
  });
});

describe("panel-store async response ordering", () => {
  beforeEach(() => {
    vi.mocked(bridge.request).mockReset();
    usePanelStore.getState().resetForRepoSwitch();
    usePanelStore.setState({ loading: false, hasMore: true });
  });

  it("defaults initial repository loading to the checked-out branch", async () => {
    const request = vi.mocked(bridge.request);
    const graphBranches: Array<string | undefined> = [];
    request.mockImplementation(async (command, params) => {
      if (command === "getBranches") {
        return [
          {
            name: "main",
            fullRef: "refs/heads/main",
            isRemote: false,
            isCurrent: true,
          },
        ];
      }
      if (command === "getTags") return [];
      if (command === "getGraphData") {
        graphBranches.push((params as { branch?: string }).branch);
        return graphResult([]);
      }
      return null;
    });

    await usePanelStore
      .getState()
      .fetchInitialData({ defaultToCurrentBranch: true });

    expect(graphBranches).toEqual(["refs/heads/main"]);
    expect(usePanelStore.getState().filter.branch).toBe("refs/heads/main");
  });

  it("keeps detached HEAD logs unfiltered across later refreshes", async () => {
    const request = vi.mocked(bridge.request);
    const graphBranches: Array<string | undefined> = [];
    request.mockImplementation(async (command, params) => {
      if (command === "getBranches" || command === "getTags") return [];
      if (command === "getGraphData") {
        graphBranches.push((params as { branch?: string }).branch);
        return graphResult([]);
      }
      return null;
    });

    await usePanelStore
      .getState()
      .fetchInitialData({ defaultToCurrentBranch: true });
    await usePanelStore.getState().refresh();

    expect(graphBranches).toEqual([undefined, undefined]);
    expect(usePanelStore.getState().filter.branch).toBe("");
  });

  it("does not restore the default branch during an ordinary refresh after clearing it", async () => {
    const request = vi.mocked(bridge.request);
    const graphBranches: Array<string | undefined> = [];
    request.mockImplementation(async (command, params) => {
      if (command === "getBranches") {
        return [
          {
            name: "main",
            fullRef: "refs/heads/main",
            isRemote: false,
            isCurrent: true,
          },
        ];
      }
      if (command === "getTags") return [];
      if (command === "getGraphData") {
        graphBranches.push((params as { branch?: string }).branch);
        return graphResult([]);
      }
      return null;
    });

    await usePanelStore
      .getState()
      .fetchInitialData({ defaultToCurrentBranch: true });
    usePanelStore.setState((state) => ({
      filter: { ...state.filter, branch: "" },
    }));
    await usePanelStore.getState().fetchInitialData();

    expect(graphBranches).toEqual(["refs/heads/main", undefined]);
    expect(usePanelStore.getState().filter.branch).toBe("");
  });

  it("preserves pending default-branch initialization when refresh supersedes the first load", async () => {
    const request = vi.mocked(bridge.request);
    const firstBranches = deferred<never[]>();
    const graphBranches: Array<string | undefined> = [];
    let branchRequests = 0;
    const currentBranch = {
      name: "main",
      fullRef: "refs/heads/main",
      isRemote: false,
      isCurrent: true,
    };
    request.mockImplementation(async (command, params) => {
      if (command === "getBranches") {
        branchRequests += 1;
        return branchRequests === 1 ? firstBranches.promise : [currentBranch];
      }
      if (command === "getTags") return [];
      if (command === "getGraphData") {
        graphBranches.push((params as { branch?: string }).branch);
        return graphResult([]);
      }
      return null;
    });

    const initial = usePanelStore
      .getState()
      .fetchInitialData({ defaultToCurrentBranch: true });
    await vi.waitFor(() => expect(branchRequests).toBe(1));
    const refresh = usePanelStore.getState().refresh();
    await refresh;
    firstBranches.resolve([currentBranch] as never[]);
    await initial;

    expect(graphBranches).toEqual(["refs/heads/main"]);
    expect(usePanelStore.getState().filter.branch).toBe("refs/heads/main");
  });

  it("consumes default initialization once the current branch is known", async () => {
    const request = vi.mocked(bridge.request);
    const firstGraph = deferred<ReturnType<typeof graphResult>>();
    const graphBranches: Array<string | undefined> = [];
    const currentBranch = {
      name: "main",
      fullRef: "refs/heads/main",
      isRemote: false,
      isCurrent: true,
    };
    request.mockImplementation(async (command, params) => {
      if (command === "getBranches") return [currentBranch];
      if (command === "getTags") return [];
      if (command === "getGraphData") {
        graphBranches.push((params as { branch?: string }).branch);
        if (graphBranches.length === 1) return firstGraph.promise;
        if (graphBranches.length === 3) {
          return graphResult([commit("feature-tip")]);
        }
        return graphResult([]);
      }
      if (command === "getCommitRangeFiles") return [];
      return null;
    });

    const initial = usePanelStore
      .getState()
      .fetchInitialData({ defaultToCurrentBranch: true });
    await vi.waitFor(() => {
      expect(graphBranches).toEqual(["refs/heads/main"]);
      expect(usePanelStore.getState().filter.branch).toBe("refs/heads/main");
    });
    await usePanelStore.getState().refresh();
    firstGraph.resolve(graphResult([]));
    await initial;

    await usePanelStore.getState().navigateToRef(
      {
        type: "local",
        name: "feature",
        fullRef: "refs/heads/feature",
      },
      "feature-tip",
    );

    expect(graphBranches).toEqual([
      "refs/heads/main",
      "refs/heads/main",
      undefined,
    ]);
  });

  it("discards an older graph response that resolves after a newer filter", async () => {
    const request = vi.mocked(bridge.request);
    const older = deferred<ReturnType<typeof graphResult>>();
    const newer = deferred<ReturnType<typeof graphResult>>();
    request.mockImplementation(async (command, params) => {
      if (command === "getGraphData") {
        return (params as { branch?: string }).branch === "branch-a"
          ? older.promise
          : newer.promise;
      }
      if (command === "getBranches" || command === "getTags") return [];
      if (command === "getCommitRangeFiles") return [];
      return null;
    });

    usePanelStore.setState((state) => ({
      filter: { ...state.filter, branch: "branch-a" },
    }));
    const first = usePanelStore.getState().fetchInitialData();
    usePanelStore.setState((state) => ({
      filter: { ...state.filter, branch: "branch-b" },
    }));
    const second = usePanelStore.getState().fetchInitialData();

    newer.resolve(graphResult([commit("branch-b-tip")]));
    await vi.waitFor(() => {
      expect(usePanelStore.getState().commits[0]?.hash).toBe("branch-b-tip");
    });
    older.resolve(graphResult([commit("branch-a-tip")]));
    await Promise.all([first, second]);

    expect(usePanelStore.getState().filter.branch).toBe("branch-b");
    expect(usePanelStore.getState().commits.map((item) => item.hash)).toEqual([
      "branch-b-tip",
    ]);
    expect(usePanelStore.getState().loading).toBe(false);
  });

  it("keeps commit files aligned with the latest selected commit", async () => {
    const request = vi.mocked(bridge.request);
    const older = deferred<never[]>();
    const newer = deferred<never[]>();
    request.mockImplementation(async (command, params) => {
      if (command !== "getCommitRangeFiles") return null;
      const hashes = (params as { hashes: string[] }).hashes;
      return hashes[0] === "older" ? older.promise : newer.promise;
    });

    const first = usePanelStore.getState().selectCommit("older");
    const second = usePanelStore.getState().selectCommit("newer");
    newer.resolve([{ newPath: "newer.ts" } as never]);
    await second;
    older.resolve([{ newPath: "older.ts" } as never]);
    await first;

    expect(usePanelStore.getState().selectedCommitHash).toBe("newer");
    expect(usePanelStore.getState().commitFiles).toEqual([
      { newPath: "newer.ts" },
    ]);
  });
});
