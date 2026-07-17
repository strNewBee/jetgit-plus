import { create } from "zustand";
import { bridge } from "../bridge";
import type { SelectionMode } from "../hooks/useModifierClickSelection";
import type {
  BranchInfo,
  Commit,
  DiffFile,
  GitRefIdentity,
  LaneInfo,
  LaneSnapshot,
  TagInfo,
} from "../types/git";
import { useRepoStore } from "./repo-store";

interface PanelFilter {
  searchQuery: string;
  branch: string;
  author: string;
  dateRange: string;
  file: string;
}

interface FetchInitialDataOptions {
  defaultToCurrentBranch?: boolean;
}

interface PanelStore {
  commits: Commit[];
  /** Commits filtered by search/author (client-side). Graph layout uses full `commits`. */
  visibleCommits: Commit[];
  branches: BranchInfo[];
  tags: TagInfo[];
  currentBranch: string;
  graphLayout: Record<string, LaneInfo>;
  laneSnapshot: LaneSnapshot | null;

  selectedCommitHash: string | null;
  selectedCommitHashes: string[];
  lastSelectedCommitHash: string | null;
  hoveredColumn: number | null;
  commitFiles: DiffFile[];
  selectedFilePath: string | null;
  /** Column visibility for the commit list */
  visibleColumns: { author: boolean; date: boolean; hash: boolean };
  /** When multiple commits are selected, stores the oldest/newest for range diff */
  rangeOldest: string | null;
  rangeNewest: string | null;
  selectedRefs: GitRefIdentity[];
  lastSelectedRefKey: string | null;
  branchGroupByDirectory: boolean;
  showTags: boolean;
  singleClickAction: "filter" | "navigate";
  scrollTargetHash: string | null;

  filter: PanelFilter;
  /** Hashes to restore after clearing a filter */
  pendingSelectionFromFilter: string[];
  /** Collapsed sequence IDs */
  collapsedSequenceIds: Set<string>;
  /** sequenceId → intermediate hashes that are hidden */
  collapsedIntermediates: Map<string, string[]>;

  loading: boolean;
  hasMore: boolean;
  operationInProgress: boolean;

  fetchInitialData: (options?: FetchInitialDataOptions) => Promise<void>;
  loadMore: () => Promise<void>;
  selectCommit: (
    hash: string,
    mode?: SelectionMode,
    allVisibleCommits?: string[],
    source?: "user" | "navigation",
  ) => Promise<void>;
  selectFile: (filePath: string) => void;
  openDiffEditor: (commitHash: string, file: DiffFile) => Promise<void>;
  setFilter: (filter: Partial<PanelFilter>) => void;
  selectRef: (
    ref: GitRefIdentity,
    mode: "single" | "toggle" | "range",
    allVisibleRefs: GitRefIdentity[],
  ) => void;
  setFavorite: (ref: GitRefIdentity, favorite: boolean) => Promise<void>;
  loadBranchDashboardPreferences: () => Promise<void>;
  setBranchDashboardPreferences: (patch: {
    showTags?: boolean;
    singleClickAction?: "filter" | "navigate";
  }) => Promise<void>;
  navigateToRef: (ref: GitRefIdentity, targetHash: string) => Promise<void>;
  clearScrollTarget: () => void;
  setHoveredColumn: (column: number | null) => void;
  toggleColumnVisibility: (column: "author" | "date" | "hash") => void;
  toggleSequenceCollapse: (sequenceId: string, intermediates: string[]) => void;
  toggleBranchGroupByDirectory: () => void;
  refresh: () => Promise<void>;
  /**
   * Reset the repo-SCOPED parts of `filter` (`branch`, `file`) before fetching
   * for a newly-active repo, WITHOUT touching the carryover (global-scope)
   * fields `searchQuery`/`author`/`dateRange`. Also drops collapse/selection
   * state that was tied to the previous repo's commit graph. Call this from the
   * active-repo switch site BEFORE `fetchInitialData()` so the new repo's Git
   * Log isn't silently scoped to the old repo's branch/path.
   */
  resetForRepoSwitch: () => void;
  /**
   * Clear all repo-bound display data (`commits`, `branches`, `tags`, graph,
   * selection, commit files) AND the repo-scoped filter fields, leaving the
   * panel empty. Used when `activeRepoId` becomes `null` (no repos / all
   * removed) so no stale data from a gone repo lingers. Carryover filter fields
   * are preserved (they are not repo-bound).
   */
  clearForNoRepo: () => void;
}

interface SelectionSnapshot {
  selectedCommitHash: string | null;
  selectedCommitHashes: string[];
  lastSelectedCommitHash: string | null;
  rangeOldest: string | null;
  rangeNewest: string | null;
}

function filterCommits(
  commits: Commit[],
  filter: PanelFilter,
  collapsedIntermediates: Map<string, string[]>,
): Commit[] {
  const hiddenSet = new Set<string>();
  for (const hashes of collapsedIntermediates.values()) {
    for (const h of hashes) hiddenSet.add(h);
  }

  // Compute date cutoff for dateRange filter
  let dateCutoff: Date | null = null;
  if (filter.dateRange) {
    const now = new Date();
    if (filter.dateRange === "today") {
      dateCutoff = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    } else if (filter.dateRange === "7days") {
      dateCutoff = new Date(now.getTime() - 7 * 24 * 60 * 60 * 1000);
    } else if (filter.dateRange === "30days") {
      dateCutoff = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    } else if (filter.dateRange === "90days") {
      dateCutoff = new Date(now.getTime() - 90 * 24 * 60 * 60 * 1000);
    }
  }

  return commits.filter((c) => {
    if (hiddenSet.has(c.hash)) return false;

    if (filter.searchQuery) {
      const q = filter.searchQuery.toLowerCase();
      if (
        !c.subject.toLowerCase().includes(q) &&
        !c.body.toLowerCase().includes(q)
      ) {
        return false;
      }
    }
    if (filter.author) {
      if (!c.authorName.toLowerCase().includes(filter.author.toLowerCase())) {
        return false;
      }
    }
    if (dateCutoff) {
      const commitDate = new Date(c.authorDate);
      if (commitDate < dateCutoff) {
        return false;
      }
    }
    return true;
  });
}

function deriveSelectionFromVisible(
  visibleCommits: Commit[],
  selectedCommitHashes: string[],
  selectedCommitHash: string | null,
  lastSelectedCommitHash: string | null,
): SelectionSnapshot {
  const visibleHashes = visibleCommits.map((c) => c.hash);
  const visibleSet = new Set(visibleHashes);
  const nextSelected = selectedCommitHashes.filter((h) => visibleSet.has(h));

  if (nextSelected.length === 0) {
    const fallback = visibleCommits[0]?.hash ?? null;
    if (!fallback) {
      return {
        selectedCommitHash: null,
        selectedCommitHashes: [],
        lastSelectedCommitHash: null,
        rangeOldest: null,
        rangeNewest: null,
      };
    }
    return {
      selectedCommitHash: fallback,
      selectedCommitHashes: [fallback],
      lastSelectedCommitHash: fallback,
      rangeOldest: fallback,
      rangeNewest: fallback,
    };
  }

  const ordered = visibleHashes.filter((h) => nextSelected.includes(h));
  const preferredFocus =
    selectedCommitHash && visibleSet.has(selectedCommitHash);
  const nextFocus = preferredFocus ? selectedCommitHash : ordered[0];
  const nextAnchor =
    lastSelectedCommitHash && visibleSet.has(lastSelectedCommitHash)
      ? lastSelectedCommitHash
      : ordered[0];

  return {
    selectedCommitHash: nextFocus,
    selectedCommitHashes: ordered,
    lastSelectedCommitHash: nextAnchor,
    rangeOldest: ordered[ordered.length - 1],
    rangeNewest: ordered[0],
  };
}

/**
 * The repo-BOUND display/selection/range/collapse state to drop whenever the
 * active repo changes (repo→repo switch via `resetForRepoSwitch`, or →null via
 * `clearForNoRepo`). Shared by both paths so the field set cannot drift. The
 * carryover filter fields (`searchQuery`/`author`/`dateRange`) and the
 * repo-scoped filter fields (`branch`/`file`) are handled by each caller —
 * they reset repo-scoped fields and preserve carryover identically.
 */
function _clearRepoBoundDisplay() {
  return {
    commits: [] as Commit[],
    visibleCommits: [] as Commit[],
    branches: [] as BranchInfo[],
    tags: [] as TagInfo[],
    currentBranch: "",
    graphLayout: {} as Record<string, LaneInfo>,
    laneSnapshot: null as LaneSnapshot | null,
    selectedCommitHash: null,
    selectedCommitHashes: [] as string[],
    lastSelectedCommitHash: null,
    selectedRefs: [] as GitRefIdentity[],
    lastSelectedRefKey: null as string | null,
    scrollTargetHash: null as string | null,
    commitFiles: [] as DiffFile[],
    selectedFilePath: null,
    rangeOldest: null,
    rangeNewest: null,
    collapsedSequenceIds: new Set<string>(),
    collapsedIntermediates: new Map<string, string[]>(),
    pendingSelectionFromFilter: [] as string[],
  };
}

// Async log requests may overlap when the user changes filters, switches repos,
// or clicks a ref while a refresh is in flight. Generations make every result
// conditional on still belonging to the latest intent instead of allowing a
// slow response to overwrite newer state.
let logLoadGeneration = 0;
let selectionGeneration = 0;
let navigationGeneration = 0;
let activeLogLoad: Promise<void> | null = null;
// Repository initialization is an intent, not a property of one request. A
// watcher refresh may supersede the first request before branches resolve; the
// replacement request must still initialize the log to the checked-out branch.
let pendingDefaultBranchInitialization = false;

function invalidateRepoAsyncWork(): void {
  logLoadGeneration += 1;
  selectionGeneration += 1;
  navigationGeneration += 1;
  activeLogLoad = null;
}

export const usePanelStore = create<PanelStore>((set, get) => ({
  commits: [],
  visibleCommits: [],
  branches: [],
  tags: [],
  currentBranch: "",
  graphLayout: {},
  laneSnapshot: null,

  selectedCommitHash: null,
  selectedCommitHashes: [],
  lastSelectedCommitHash: null,
  hoveredColumn: null,
  commitFiles: [],
  selectedFilePath: null,
  visibleColumns: { author: true, date: true, hash: true },
  rangeOldest: null,
  rangeNewest: null,
  selectedRefs: [],
  lastSelectedRefKey: null,
  showTags: true,
  singleClickAction: "filter",
  scrollTargetHash: null,
  branchGroupByDirectory: (() => {
    try {
      return localStorage.getItem("branchGroupByDirectory") === "true";
    } catch {
      return false;
    }
  })(),

  filter: { searchQuery: "", branch: "", author: "", dateRange: "", file: "" },
  pendingSelectionFromFilter: [],
  collapsedSequenceIds: new Set(),
  collapsedIntermediates: new Map(),

  loading: false,
  hasMore: true,
  operationInProgress: false,

  async fetchInitialData(options = {}) {
    const generation = ++logLoadGeneration;
    if (options.defaultToCurrentBranch && !get().filter.branch) {
      pendingDefaultBranchInitialization = true;
    }
    const shouldDefaultToCurrentBranch =
      pendingDefaultBranchInitialization && !get().filter.branch;
    set({ loading: true });
    const start = Date.now();
    const operation = (async () => {
      try {
        let requestedFilter = { ...get().filter };
        const branchesRequest = bridge.request("getBranches") as Promise<
          BranchInfo[] | null
        >;
        const tagsRequest = bridge.request("getTags") as Promise<
          TagInfo[] | null
        >;
        const requestGraph = () =>
          bridge.request("getGraphData", {
            maxCount: 200,
            branch: requestedFilter.branch || undefined,
            file: requestedFilter.file || undefined,
          }) as Promise<{
            graphData: { commits: Commit[]; lanes: Record<string, LaneInfo> };
            snapshot: LaneSnapshot;
          } | null>;

        let graphResult: Awaited<ReturnType<typeof requestGraph>>;
        let branches: BranchInfo[] | null;
        let tags: TagInfo[] | null;
        if (shouldDefaultToCurrentBranch) {
          [branches, tags] = await Promise.all([branchesRequest, tagsRequest]);
          if (generation !== logLoadGeneration) return;
          const currentRef = branches?.find(
            (branch) => !branch.isRemote && branch.isCurrent,
          )?.fullRef;
          if (currentRef) {
            requestedFilter = { ...requestedFilter, branch: currentRef };
            set((state) => ({
              filter: { ...state.filter, branch: currentRef },
            }));
            // The initialization intent is fulfilled once the checked-out ref
            // is known and reflected in state. Do not retain it while the
            // graph request is pending: a newer refresh may supersede that
            // request, and a leaked flag would later override an explicit
            // filter clear (for example during navigateToRef).
            pendingDefaultBranchInitialization = false;
          } else {
            // Detached HEAD (or a repository without a local branch) has no
            // branch to initialize. Future ordinary refreshes stay unfiltered.
            pendingDefaultBranchInitialization = false;
          }
          graphResult = await requestGraph();
        } else {
          [graphResult, branches, tags] = await Promise.all([
            requestGraph(),
            branchesRequest,
            tagsRequest,
          ]);
        }

        if (generation !== logLoadGeneration) return;
        if (shouldDefaultToCurrentBranch) {
          pendingDefaultBranchInitialization = false;
        }

        const commits = graphResult?.graphData?.commits ?? [];
        const lanes = graphResult?.graphData?.lanes ?? {};
        const snapshot = graphResult?.snapshot ?? null;
        const branchList = branches ?? [];
        const tagList = tags ?? [];
        const current = branchList.find((b) => b.isCurrent)?.name ?? "";

        const { filter, pendingSelectionFromFilter, collapsedIntermediates } =
          get();
        const visible = filterCommits(commits, filter, collapsedIntermediates);

        // Check if we need to restore selection from a cleared filter.
        if (pendingSelectionFromFilter.length > 0) {
          const validHashes = pendingSelectionFromFilter.filter((h) =>
            commits.some((c) => c.hash === h),
          );
          if (validHashes.length > 0) {
            const fileGeneration = ++selectionGeneration;
            set({
              commits,
              visibleCommits: visible,
              graphLayout: lanes,
              laneSnapshot: snapshot,
              branches: branchList,
              tags: tagList,
              currentBranch: current,

              hasMore: commits.length >= 200,
              selectedCommitHash: validHashes[0],
              selectedCommitHashes: validHashes,
              lastSelectedCommitHash: validHashes[0],
              commitFiles: [],
              selectedFilePath: null,
              rangeOldest: validHashes[validHashes.length - 1],
              rangeNewest: validHashes[0],
              pendingSelectionFromFilter: [],
            });

            const files = (await bridge.request("getCommitRangeFiles", {
              hashes: validHashes,
            })) as DiffFile[] | null;
            if (
              generation === logLoadGeneration &&
              fileGeneration === selectionGeneration
            ) {
              set({ commitFiles: files ?? [] });
            }
            return;
          }
        }

        const firstVisible = visible[0];
        const fileGeneration = ++selectionGeneration;
        set({
          commits,
          visibleCommits: visible,
          graphLayout: lanes,
          laneSnapshot: snapshot,
          branches: branchList,
          tags: tagList,
          currentBranch: current,

          hasMore: commits.length >= 200,
          selectedCommitHash: firstVisible?.hash ?? null,
          selectedCommitHashes: firstVisible ? [firstVisible.hash] : [],
          lastSelectedCommitHash: firstVisible?.hash ?? null,
          commitFiles: [],
          selectedFilePath: null,
          rangeOldest: null,
          rangeNewest: null,
          pendingSelectionFromFilter: [],
        });

        // Auto-select first visible commit.
        if (firstVisible) {
          const hash = firstVisible.hash;
          const files = (await bridge.request("getCommitRangeFiles", {
            hashes: [hash],
          })) as DiffFile[] | null;
          if (
            generation === logLoadGeneration &&
            fileGeneration === selectionGeneration
          ) {
            set({
              commitFiles: files ?? [],
              rangeOldest: hash,
              rangeNewest: hash,
            });
          }
        }
      } catch (err) {
        if (generation === logLoadGeneration) {
          console.error("fetchInitialData failed:", err);
        }
      } finally {
        const elapsed = Date.now() - start;
        if (elapsed < 1000) {
          await new Promise((resolve) => setTimeout(resolve, 1000 - elapsed));
        }
        if (generation === logLoadGeneration) set({ loading: false });
      }
    })();

    activeLogLoad = operation;
    try {
      await operation;
    } finally {
      if (activeLogLoad === operation) activeLogLoad = null;
    }
  },

  async loadMore() {
    if (activeLogLoad) {
      await activeLogLoad;
      return;
    }

    const { commits, laneSnapshot, hasMore, filter } = get();
    if (!hasMore) return;

    const generation = logLoadGeneration;
    set({ loading: true });
    const operation = (async () => {
      try {
        const result = (await bridge.request("loadMoreLog", {
          skip: commits.length,
          count: 200,
          snapshot: laneSnapshot,
          branch: filter.branch || undefined,
        })) as {
          graphData: { commits: Commit[]; lanes: Record<string, LaneInfo> };
          snapshot: LaneSnapshot;
        } | null;

        if (generation !== logLoadGeneration) return;

        if (result?.graphData?.commits?.length) {
          const newCommits = result.graphData.commits;
          const allCommits = [...commits, ...newCommits];
          set({
            commits: allCommits,
            visibleCommits: filterCommits(
              allCommits,
              get().filter,
              get().collapsedIntermediates,
            ),
            graphLayout: { ...get().graphLayout, ...result.graphData.lanes },
            laneSnapshot: result.snapshot,
            hasMore: newCommits.length >= 200,
          });
        } else {
          set({ hasMore: false });
        }
      } catch (err) {
        if (generation === logLoadGeneration) {
          console.error("loadMore failed:", err);
        }
      } finally {
        if (generation === logLoadGeneration) set({ loading: false });
      }
    })();

    activeLogLoad = operation;
    try {
      await operation;
    } finally {
      if (activeLogLoad === operation) activeLogLoad = null;
    }
  },

  async selectCommit(
    hash: string,
    mode: SelectionMode = "single",
    allVisibleCommits: string[] = [],
    source: "user" | "navigation" = "user",
  ) {
    if (source === "user") navigationGeneration += 1;
    const generation = ++selectionGeneration;
    const { selectedCommitHashes, lastSelectedCommitHash } = get();
    let nextSelected: string[] = [];
    let nextAnchor = lastSelectedCommitHash;

    if (mode === "single") {
      nextSelected = [hash];
      nextAnchor = hash;
    } else if (mode === "toggle") {
      if (selectedCommitHashes.includes(hash)) {
        nextSelected = selectedCommitHashes.filter((h) => h !== hash);
        if (nextSelected.length === 0) {
          nextSelected = [hash];
        }
      } else {
        nextSelected = [...selectedCommitHashes, hash];
      }
      nextAnchor = hash;
    } else {
      const anchor = lastSelectedCommitHash;
      if (!anchor || allVisibleCommits.length === 0) {
        nextSelected = [hash];
        nextAnchor = hash;
      } else {
        const anchorIdx = allVisibleCommits.indexOf(anchor);
        const targetIdx = allVisibleCommits.indexOf(hash);
        if (anchorIdx === -1 || targetIdx === -1) {
          nextSelected = [hash];
          nextAnchor = hash;
        } else {
          const start = Math.min(anchorIdx, targetIdx);
          const end = Math.max(anchorIdx, targetIdx);
          nextSelected = allVisibleCommits.slice(start, end + 1);
        }
      }
    }

    const focusHash = nextSelected.includes(hash)
      ? hash
      : (nextSelected[nextSelected.length - 1] ?? hash);

    // Sort selected hashes by visible list order (newest first)
    const selected = new Set(nextSelected);
    const orderedHashes =
      allVisibleCommits.length > 0
        ? allVisibleCommits.filter((h) => selected.has(h))
        : nextSelected;

    set({
      selectedCommitHash: focusHash,
      selectedCommitHashes: nextSelected,
      lastSelectedCommitHash: nextAnchor,
      commitFiles: [],
      selectedFilePath: null,
      rangeOldest: orderedHashes[orderedHashes.length - 1],
      rangeNewest: orderedHashes[0],
    });
    try {
      const files = (await bridge.request("getCommitRangeFiles", {
        hashes: orderedHashes,
      })) as DiffFile[] | null;
      if (generation === selectionGeneration) {
        set({ commitFiles: files ?? [] });
      }
    } catch (err) {
      if (generation === selectionGeneration) {
        console.error("selectCommit failed:", err);
      }
    }
  },

  selectFile(filePath: string) {
    set({ selectedFilePath: filePath });
  },

  async openDiffEditor(commitHash: string, file: DiffFile) {
    try {
      const { selectedCommitHashes, commitFiles } = get();
      const filePath = file.newPath || file.oldPath;
      const isMulti = selectedCommitHashes.length > 1;

      if (isMulti) {
        await bridge.request("openDiffEditor", {
          commit: selectedCommitHashes[0],
          filePath,
          file,
          cherryPickHashes: selectedCommitHashes,
          fileList: commitFiles,
        });
      } else {
        await bridge.request("openDiffEditor", {
          commit: commitHash,
          filePath,
          file,
          fileList: commitFiles,
        });
      }
    } catch (err) {
      console.error("openDiffEditor failed:", err);
    }
  },

  setFilter(partial: Partial<PanelFilter>) {
    navigationGeneration += 1;
    if (partial.branch !== undefined) {
      // Any explicit branch choice, including clearing the chip, supersedes
      // repository initialization and must survive ordinary refreshes.
      pendingDefaultBranchInitialization = false;
    }
    const { filter: current, selectedCommitHashes, commits } = get();
    const next = { ...current, ...partial };

    // Branch or file filter changes require a backend re-fetch
    if (
      (partial.branch !== undefined && partial.branch !== current.branch) ||
      (partial.file !== undefined && partial.file !== current.file)
    ) {
      set({
        filter: next,
        pendingSelectionFromFilter: [],
        collapsedSequenceIds: new Set(),
        collapsedIntermediates: new Map(),
      });
      get().fetchInitialData();
      return;
    }

    // Search/author filter: client-side only
    const wasFiltered = !!(
      current.searchQuery ||
      current.author ||
      current.dateRange
    );
    const isNowFiltered = !!(next.searchQuery || next.author || next.dateRange);
    const visible = filterCommits(commits, next, get().collapsedIntermediates);

    if (wasFiltered && !isNowFiltered) {
      // Clearing filter → save current selection for restoration
      set({
        filter: next,
        visibleCommits: visible,
        pendingSelectionFromFilter: selectedCommitHashes,
      });
    } else {
      set({
        filter: next,
        visibleCommits: visible,
        pendingSelectionFromFilter: [],
      });
    }
  },

  selectRef(ref, mode, allVisibleRefs) {
    const keyOf = (candidate: GitRefIdentity) =>
      `${candidate.type}\0${candidate.name}`;
    const targetKey = keyOf(ref);
    const { selectedRefs, lastSelectedRefKey } = get();

    if (mode === "single") {
      set({ selectedRefs: [ref], lastSelectedRefKey: targetKey });
      return;
    }

    if (mode === "toggle") {
      const isSelected = selectedRefs.some(
        (candidate) => keyOf(candidate) === targetKey,
      );
      set({
        selectedRefs: isSelected
          ? selectedRefs.filter((candidate) => keyOf(candidate) !== targetKey)
          : [...selectedRefs, ref],
        lastSelectedRefKey: targetKey,
      });
      return;
    }

    const anchorIndex = allVisibleRefs.findIndex(
      (candidate) => keyOf(candidate) === lastSelectedRefKey,
    );
    const targetIndex = allVisibleRefs.findIndex(
      (candidate) => keyOf(candidate) === targetKey,
    );
    if (anchorIndex === -1 || targetIndex === -1) {
      set({ selectedRefs: [ref], lastSelectedRefKey: targetKey });
      return;
    }

    const start = Math.min(anchorIndex, targetIndex);
    const end = Math.max(anchorIndex, targetIndex);
    set({ selectedRefs: allVisibleRefs.slice(start, end + 1) });
  },

  async setFavorite(ref, favorite) {
    await bridge.request("setFavorite", { ref, favorite });
    set((state) => ({
      branches: state.branches.map((branch) => {
        const type = branch.isRemote ? "remote" : "local";
        return type === ref.type && branch.name === ref.name
          ? { ...branch, isFavorite: favorite }
          : branch;
      }),
      tags: state.tags.map((tag) =>
        ref.type === "tag" && tag.name === ref.name
          ? { ...tag, isFavorite: favorite }
          : tag,
      ),
    }));
  },

  async loadBranchDashboardPreferences() {
    const preferences = (await bridge.request(
      "getBranchDashboardPreferences",
      {},
      { scope: "global" },
    )) as {
      showTags: boolean;
      singleClickAction: "filter" | "navigate";
    } | null;
    if (preferences) set(preferences);
  },

  async setBranchDashboardPreferences(patch) {
    const preferences = (await bridge.request(
      "setBranchDashboardPreferences",
      patch,
      { scope: "global" },
    )) as {
      showTags: boolean;
      singleClickAction: "filter" | "navigate";
    } | null;
    if (preferences) set(preferences);
  },

  async navigateToRef(ref, targetHash) {
    const generation = ++navigationGeneration;
    const filter = get().filter;
    const hasActiveFilter = Object.values(filter).some(Boolean);

    // Navigate means reveal this ref's head in the main log. Any active filter
    // can hide that commit, so clear it and await the replacement log before
    // searching or paginating.
    if (hasActiveFilter) {
      set({
        filter: {
          searchQuery: "",
          branch: "",
          author: "",
          dateRange: "",
          file: "",
        },
        pendingSelectionFromFilter: [],
        collapsedSequenceIds: new Set(),
        collapsedIntermediates: new Map(),
      });
      await get().fetchInitialData();
    } else if (activeLogLoad) {
      await activeLogLoad;
    }

    if (generation !== navigationGeneration) return;

    let visibleHashes = get().visibleCommits.map((commit) => commit.hash);
    while (!visibleHashes.includes(targetHash) && get().hasMore) {
      if (activeLogLoad) await activeLogLoad;
      if (generation !== navigationGeneration) return;
      visibleHashes = get().visibleCommits.map((commit) => commit.hash);
      if (visibleHashes.includes(targetHash) || !get().hasMore) break;

      const previousCount = get().commits.length;
      await get().loadMore();
      if (generation !== navigationGeneration) return;
      visibleHashes = get().visibleCommits.map((commit) => commit.hash);
      if (get().commits.length === previousCount) break;
    }
    if (!visibleHashes.includes(targetHash)) {
      await bridge.request(
        "showErrorNotification",
        {
          message: `Could not find ${ref.name} (${targetHash.slice(0, 8)}) in the loaded log.`,
        },
        { scope: "global" },
      );
      return;
    }
    await get().selectCommit(targetHash, "single", visibleHashes, "navigation");
    if (
      generation === navigationGeneration &&
      get().selectedCommitHash === targetHash
    ) {
      set({ scrollTargetHash: targetHash });
    }
  },

  clearScrollTarget() {
    set({ scrollTargetHash: null });
  },

  setHoveredColumn(column: number | null) {
    set({ hoveredColumn: column });
  },

  toggleColumnVisibility(column: "author" | "date" | "hash") {
    set((state) => ({
      visibleColumns: {
        ...state.visibleColumns,
        [column]: !state.visibleColumns[column],
      },
    }));
  },

  toggleBranchGroupByDirectory() {
    set((state) => {
      const next = !state.branchGroupByDirectory;
      try {
        localStorage.setItem("branchGroupByDirectory", String(next));
      } catch {
        // ignore
      }
      return { branchGroupByDirectory: next };
    });
  },

  toggleSequenceCollapse(sequenceId: string, intermediates: string[]) {
    const fileGeneration = ++selectionGeneration;
    const {
      commits,
      filter,
      collapsedSequenceIds,
      collapsedIntermediates,
      selectedCommitHashes,
      selectedCommitHash,
      lastSelectedCommitHash,
    } = get();
    const nextIds = new Set(collapsedSequenceIds);
    const nextMap = new Map(collapsedIntermediates);

    if (nextIds.has(sequenceId)) {
      nextIds.delete(sequenceId);
      nextMap.delete(sequenceId);
    } else {
      nextIds.add(sequenceId);
      nextMap.set(sequenceId, intermediates);
    }

    const nextVisible = filterCommits(commits, filter, nextMap);
    const nextSelection = deriveSelectionFromVisible(
      nextVisible,
      selectedCommitHashes,
      selectedCommitHash,
      lastSelectedCommitHash,
    );

    set({
      collapsedSequenceIds: nextIds,
      collapsedIntermediates: nextMap,
      visibleCommits: nextVisible,
      selectedCommitHash: nextSelection.selectedCommitHash,
      selectedCommitHashes: nextSelection.selectedCommitHashes,
      lastSelectedCommitHash: nextSelection.lastSelectedCommitHash,
      rangeOldest: nextSelection.rangeOldest,
      rangeNewest: nextSelection.rangeNewest,
      selectedFilePath: null,
      commitFiles: [],
    });

    const hashes = nextSelection.selectedCommitHashes;
    if (hashes.length > 0) {
      void (async () => {
        try {
          const files = (await bridge.request("getCommitRangeFiles", {
            hashes,
          })) as DiffFile[] | null;
          if (fileGeneration === selectionGeneration) {
            set({ commitFiles: files ?? [] });
          }
        } catch (err) {
          console.error("toggleSequenceCollapse failed to load files:", err);
        }
      })();
    }
  },

  async refresh() {
    set({ collapsedSequenceIds: new Set(), collapsedIntermediates: new Map() });
    await get().fetchInitialData();
  },

  resetForRepoSwitch() {
    invalidateRepoAsyncWork();
    pendingDefaultBranchInitialization = false;
    const { filter } = get();
    // On a repo→repo switch the old repo's display/selection/range/collapse
    // data must be dropped IMMEDIATELY: the new repo's fetch is async, and if
    // the old data lingered a user could act on a still-visible A commit
    // (Checkout / Delete / Cherry-pick / open file) through a now-B-bound
    // request — the operation would target B. Clearing here guarantees there
    // is nothing stale to act on during B's load. Carryover (global-scope)
    // filters `searchQuery`/`author`/`dateRange` are preserved; the repo-scoped
    // `branch`/`file` are reset so B's Git Log isn't scoped to A's refs/paths.
    // The repo-bound field set mirrors `clearForNoRepo` via the shared helper
    // so the two cannot drift.
    set({
      ..._clearRepoBoundDisplay(),
      filter: {
        searchQuery: filter.searchQuery,
        branch: "",
        author: filter.author,
        dateRange: filter.dateRange,
        file: "",
      },
      loading: false,
    });
  },

  clearForNoRepo() {
    invalidateRepoAsyncWork();
    pendingDefaultBranchInitialization = false;
    const { filter } = get();
    // Wipe repo-bound display data + repo-scoped filter fields; keep carryover
    // (search/author/date) since they are not repo-bound and a future repo may
    // reasonably reuse them. `hasMore` is reset to its initial `true` (the
    // null path leaves the panel fully empty, as if never loaded).
    set({
      ..._clearRepoBoundDisplay(),
      filter: {
        searchQuery: filter.searchQuery,
        branch: "",
        author: filter.author,
        dateRange: filter.dateRange,
        file: "",
      },
      hasMore: true,
      loading: false,
    });
  },
}));

// Per-repo operation progress tracking.
//
// `operationInProgress` is true ONLY when an operation targets the ACTIVE repo.
// We track a per-repo COUNT of in-flight operations (a Map, not a Set, so two
// concurrent ops on the same repo don't cancel early when the first one ends)
// and recompute the boolean whenever an operation event arrives OR the active
// repo changes. An `operationStart{repoId:"B"}` while repo A is visible does
// NOT set `operationInProgress` (the op isn't on the visible repo); switching to
// B then re-derives busy=true so the in-flight B op shows correctly.
// `repoId: null` (a non-repo-bound operation) is ignored — it cannot match any
// active repo, so its progress never disables the UI (acceptable for global
// operations).
const inFlightOpCounts = new Map<string, number>();

function recomputeOperationInProgress() {
  const activeRepoId = useRepoStore.getState().activeRepoId;
  usePanelStore.setState({
    operationInProgress:
      activeRepoId !== null && (inFlightOpCounts.get(activeRepoId) ?? 0) > 0,
  });
}

function incrementInFlight(repoId: string): void {
  inFlightOpCounts.set(repoId, (inFlightOpCounts.get(repoId) ?? 0) + 1);
  recomputeOperationInProgress();
}

function decrementInFlight(repoId: string): void {
  const next = (inFlightOpCounts.get(repoId) ?? 0) - 1;
  if (next <= 0) {
    inFlightOpCounts.delete(repoId);
  } else {
    inFlightOpCounts.set(repoId, next);
  }
  recomputeOperationInProgress();
}

/** Reset per-repo progress tracking (test-only). */
export function _resetOperationProgressForTests(): void {
  inFlightOpCounts.clear();
  recomputeOperationInProgress();
}

/**
 * Mark a client-side operation (one issued via `bridgeWithProgress`) as
 * in-flight for `repoId`. Client-side ops that are NOT host-wrapped in
 * `withProgress` (createBranch, deleteBranch, checkoutCommit,
 * revertFileChanges, cherryPickFileChanges) would otherwise never surface a
 * busy state, because the
 * host never broadcasts operationStart/End for them. Routing the marker through
 * the same per-repo count keeps the per-active-repo filter correct: the op only
 * disables the UI when it targets the visible repo, and concurrent ops on the
 * same repo don't clear early.
 *
 * `repoId: null` (no active repo) is a no-op — there is no visible repo to
 * disable.
 */
export function _beginClientOperation(repoId: string | null): void {
  if (typeof repoId === "string") {
    incrementInFlight(repoId);
  }
}

/** Clear the in-flight marker established by `_beginClientOperation`. */
export function _endClientOperation(repoId: string | null): void {
  if (typeof repoId === "string") {
    decrementInFlight(repoId);
  }
}

// Listen for git state changes
bridge.onEvent((event, data) => {
  if (event === "gitStateChanged") {
    const { repoId } = data as { repoId?: string };
    if (!repoId || repoId === useRepoStore.getState().activeRepoId) {
      void usePanelStore.getState().refresh();
    }
  }
  if (event === "showFileHistory") {
    const { file } = data as { file: string };
    usePanelStore.getState().setFilter({ file });
  }
  if (event === "operationStart") {
    const { repoId } = data as { repoId?: string | null };
    if (typeof repoId === "string") {
      incrementInFlight(repoId);
    }
  }
  if (event === "operationEnd") {
    const { repoId } = data as { repoId?: string | null };
    if (typeof repoId === "string") {
      decrementInFlight(repoId);
    } else {
      // Legacy/null event: clear all (defensive — a null op can't be matched,
      // so the only safe assumption on a null end is to drop everything).
      inFlightOpCounts.clear();
      recomputeOperationInProgress();
    }
  }
  // NOTE: activeRepoChanged is intentionally NOT handled here. The active-repo
  // busy recompute is driven by the useRepoStore subscription below, which fires
  // AFTER repo-store has updated activeRepoId. Handling it here as well would be
  // registration-order-dependent (panel-store's bridge handler registers at
  // import time, before repo-store's, so it would read a STALE activeRepoId) —
  // see the I1 fix in this file's history.
});

// Recompute `operationInProgress` when `activeRepoId` changes IN THE STORE.
//
// This is order-independent: repo-store's `activeRepoChanged`/`select`/
// `reposChanged` handlers call `useRepoStore.setState({ activeRepoId })`, and
// this subscription fires on that change regardless of which bridge handler ran
// first. Previously the recompute was triggered inside the `activeRepoChanged`
// bridge-event handler, but panel-store registers that handler at module-import
// time while repo-store registers its handler later (in a useEffect), so
// panel-store ran first and read a STALE activeRepoId — leaving busy wrong on
// the immediate post-switch frame (it self-healed on the next op event, but
// violated the invariant). Reading the change off the store fixes it.
//
// Idempotent: the subscription is created once at module load. Zustand's
// `subscribe` returns an unsubscribe we retain for completeness but never call
// (the store lives for the page lifetime). No loop risk: recompute only calls
// `usePanelStore.setState`, never `useRepoStore.setState`.
let activeRepoSubscriptionInstalled = false;
function installActiveRepoSubscription(): void {
  if (activeRepoSubscriptionInstalled) return;
  activeRepoSubscriptionInstalled = true;
  useRepoStore.subscribe((state, prevState) => {
    if (state.activeRepoId !== prevState.activeRepoId) {
      recomputeOperationInProgress();
    }
  });
}
installActiveRepoSubscription();
