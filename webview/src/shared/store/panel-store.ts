import { createStore, type StoreApi } from "zustand/vanilla";
import { bridge } from "../bridge";
import type {
  Bridge,
  BridgeRequestOptions,
  CommandType,
  LogQueryResult,
  LogQueryRevision,
} from "../bridge/types";
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

export interface PanelFilter {
  searchQuery: string;
  branch: string;
  author: string;
  dateRange: string;
  file: string;
}

export interface FetchInitialDataOptions {
  defaultToCurrentBranch?: boolean;
}

export interface PanelStore {
  commits: Commit[];
  /** Commits visible after local collapse state. Host queries apply log filters. */
  visibleCommits: Commit[];
  branches: BranchInfo[];
  tags: TagInfo[];
  currentBranch: string;
  graphLayout: Record<string, LaneInfo>;
  laneSnapshot: LaneSnapshot | null;
  unavailableRef: GitRefIdentity | null;

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

export type LogRevision = LogQueryRevision;

export interface GitLogStoreOptions {
  repoId: string | null;
  history: { kind: "ordinary" } | { kind: "comparison"; revision: LogRevision };
  followGlobalActiveRepo: boolean;
  showCurrentReachability: boolean;
  bridge: Bridge;
}

export interface GitLogStore {
  store: StoreApi<PanelStore>;
  dispose: () => void;
  beginClientOperation: (repoId: string | null) => void;
  endClientOperation: (repoId: string | null) => void;
  resetOperationProgressForTests: () => void;
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
  collapsedIntermediates: Map<string, string[]>,
): Commit[] {
  const hiddenSet = new Set<string>();
  for (const hashes of collapsedIntermediates.values()) {
    for (const h of hashes) hiddenSet.add(h);
  }

  return commits.filter((commit) => !hiddenSet.has(commit.hash));
}

function dateRangeParams(dateRange: PanelFilter["dateRange"]): {
  since?: string;
  until?: string;
} {
  if (!dateRange) return {};

  const now = new Date();
  let since: Date;
  if (dateRange === "today") {
    since = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  } else {
    const days = dateRange === "7days" ? 7 : dateRange === "30days" ? 30 : 90;
    since = new Date(now.getTime() - days * 24 * 60 * 60 * 1000);
  }
  return { since: since.toISOString(), until: now.toISOString() };
}

function queryParams(filter: PanelFilter): Record<string, unknown> {
  return {
    ...(filter.branch ? { branch: filter.branch } : {}),
    ...(filter.searchQuery ? { search: filter.searchQuery } : {}),
    ...(filter.author ? { author: filter.author } : {}),
    ...dateRangeParams(filter.dateRange),
    ...(filter.file ? { file: filter.file } : {}),
  };
}

function currentBranchRef(
  branches: BranchInfo[] | null,
): GitRefIdentity | null {
  const branch = branches?.find(
    (candidate) => !candidate.isRemote && candidate.isCurrent,
  );
  return branch
    ? { type: "local", name: branch.name, fullRef: branch.fullRef }
    : null;
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
    unavailableRef: null as GitRefIdentity | null,
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

export function createGitLogStore(options: GitLogStoreOptions): GitLogStore {
  // Async log requests may overlap when the user changes filters, switches
  // repos, or clicks a ref while a refresh is in flight. Every generation and
  // active request belongs to this instance so one log cannot invalidate or
  // overwrite another log's work.
  let logLoadGeneration = 0;
  let selectionGeneration = 0;
  let navigationGeneration = 0;
  let activeLogLoad: Promise<void> | null = null;
  let filterRefreshTimer: ReturnType<typeof setTimeout> | null = null;
  let currentReachabilityRef: GitRefIdentity | null = null;
  // Repository initialization is an intent, not a property of one request. A
  // watcher refresh may supersede the first request before branches resolve;
  // the replacement request must still initialize the checked-out branch.
  let pendingDefaultBranchInitialization = false;
  let disposed = false;

  function invalidateRepoAsyncWork(): void {
    logLoadGeneration += 1;
    selectionGeneration += 1;
    navigationGeneration += 1;
    activeLogLoad = null;
    currentReachabilityRef = null;
    if (filterRefreshTimer) {
      clearTimeout(filterRefreshTimer);
      filterRefreshTimer = null;
    }
  }

  function request(
    command: CommandType,
    params?: Record<string, unknown>,
    requestOptions?: BridgeRequestOptions,
  ): Promise<unknown> {
    const fixedRepoOptions =
      !options.followGlobalActiveRepo &&
      options.repoId !== null &&
      requestOptions?.scope !== "global"
        ? { ...requestOptions, repoId: options.repoId }
        : requestOptions;
    if (fixedRepoOptions) {
      return options.bridge.request(command, params, fixedRepoOptions);
    }
    if (params !== undefined) {
      return options.bridge.request(command, params);
    }
    return options.bridge.request(command);
  }

  const revision =
    options.history.kind === "comparison"
      ? options.history.revision
      : undefined;
  const historyParams = revision ? { revision } : {};

  const store = createStore<PanelStore>((set, get) => ({
    commits: [],
    visibleCommits: [],
    branches: [],
    tags: [],
    currentBranch: "",
    graphLayout: {},
    laneSnapshot: null,
    unavailableRef: null,

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

    loading: false,
    hasMore: true,
    operationInProgress: false,

    async fetchInitialData(fetchOptions = {}) {
      const generation = ++logLoadGeneration;
      if (fetchOptions.defaultToCurrentBranch && !get().filter.branch) {
        pendingDefaultBranchInitialization = true;
      }
      const shouldDefaultToCurrentBranch =
        pendingDefaultBranchInitialization && !get().filter.branch;
      set({ loading: true });
      const start = Date.now();
      const operation = (async () => {
        try {
          let requestedFilter = { ...get().filter };
          const branchesRequest = request("getBranches") as Promise<
            BranchInfo[] | null
          >;
          const tagsRequest = request("getTags") as Promise<TagInfo[] | null>;
          const requestGraph = (currentRef: GitRefIdentity | null) =>
            request("getGraphData", {
              maxCount: 200,
              ...historyParams,
              ...queryParams(requestedFilter),
              ...(options.showCurrentReachability && currentRef
                ? { currentRef }
                : {}),
            }) as Promise<
              | LogQueryResult
              | {
                  graphData: {
                    commits: Commit[];
                    lanes: Record<string, LaneInfo>;
                  };
                  snapshot: LaneSnapshot;
                }
              | null
            >;

          let graphResult: Awaited<ReturnType<typeof requestGraph>>;
          let branches: BranchInfo[] | null;
          let tags: TagInfo[] | null;
          if (shouldDefaultToCurrentBranch || options.showCurrentReachability) {
            [branches, tags] = await Promise.all([
              branchesRequest,
              tagsRequest,
            ]);
            if (generation !== logLoadGeneration) return;
            const currentRef = currentBranchRef(branches);
            if (shouldDefaultToCurrentBranch && currentRef) {
              requestedFilter = {
                ...requestedFilter,
                branch: currentRef.fullRef,
              };
              set((state) => ({
                filter: { ...state.filter, branch: currentRef.fullRef },
              }));
              // The initialization intent is fulfilled once the checked-out ref
              // is known and reflected in state. Do not retain it while the
              // graph request is pending: a newer refresh may supersede that
              // request, and a leaked flag would later override an explicit
              // filter clear (for example during navigateToRef).
              pendingDefaultBranchInitialization = false;
            } else if (shouldDefaultToCurrentBranch) {
              // Detached HEAD (or a repository without a local branch) has no
              // branch to initialize. Future ordinary refreshes stay unfiltered.
              pendingDefaultBranchInitialization = false;
            }
            currentReachabilityRef = options.showCurrentReachability
              ? currentRef
              : null;
            graphResult = await requestGraph(currentReachabilityRef);
          } else {
            [graphResult, branches, tags] = await Promise.all([
              requestGraph(null),
              branchesRequest,
              tagsRequest,
            ]);
          }

          if (generation !== logLoadGeneration) return;
          if (shouldDefaultToCurrentBranch) {
            pendingDefaultBranchInitialization = false;
          }

          const branchList = branches ?? [];
          const tagList = tags ?? [];
          const current = branchList.find((b) => b.isCurrent)?.name ?? "";
          if (
            graphResult &&
            "status" in graphResult &&
            graphResult.status === "ref-unavailable"
          ) {
            set({
              ..._clearRepoBoundDisplay(),
              branches: branchList,
              tags: tagList,
              currentBranch: current,
              unavailableRef: graphResult.ref,
              hasMore: false,
            });
            return;
          }

          const commits = graphResult?.graphData?.commits ?? [];
          const lanes = graphResult?.graphData?.lanes ?? {};
          const snapshot = graphResult?.snapshot ?? null;
          const queryHasMore =
            graphResult && "status" in graphResult
              ? graphResult.hasMore
              : commits.length >= 200;

          const { pendingSelectionFromFilter, collapsedIntermediates } = get();
          const visible = filterCommits(commits, collapsedIntermediates);

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

                hasMore: queryHasMore,
                unavailableRef: null,
                selectedCommitHash: validHashes[0],
                selectedCommitHashes: validHashes,
                lastSelectedCommitHash: validHashes[0],
                commitFiles: [],
                selectedFilePath: null,
                rangeOldest: validHashes[validHashes.length - 1],
                rangeNewest: validHashes[0],
                pendingSelectionFromFilter: [],
              });

              const files = (await request("getCommitRangeFiles", {
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

            hasMore: queryHasMore,
            unavailableRef: null,
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
            const files = (await request("getCommitRangeFiles", {
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
          const result = (await request("loadMoreLog", {
            skip: commits.length,
            count: 200,
            snapshot: laneSnapshot,
            ...historyParams,
            ...queryParams(filter),
            ...(options.showCurrentReachability && currentReachabilityRef
              ? { currentRef: currentReachabilityRef }
              : {}),
          })) as
            | LogQueryResult
            | {
                graphData: {
                  commits: Commit[];
                  lanes: Record<string, LaneInfo>;
                };
                snapshot: LaneSnapshot;
              }
            | null;

          if (generation !== logLoadGeneration) return;

          if (
            result &&
            "status" in result &&
            result.status === "ref-unavailable"
          ) {
            set({ unavailableRef: result.ref, hasMore: false });
            return;
          }

          if (result?.graphData?.commits?.length) {
            const newCommits = result.graphData.commits;
            const allCommits = [...commits, ...newCommits];
            set({
              commits: allCommits,
              visibleCommits: filterCommits(
                allCommits,
                get().collapsedIntermediates,
              ),
              graphLayout: { ...get().graphLayout, ...result.graphData.lanes },
              laneSnapshot: result.snapshot,
              hasMore:
                "status" in result ? result.hasMore : newCommits.length >= 200,
              unavailableRef: null,
            });
          } else {
            set({ hasMore: false, unavailableRef: null });
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
        const files = (await request("getCommitRangeFiles", {
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
          await request("openDiffEditor", {
            commit: selectedCommitHashes[0],
            filePath,
            file,
            cherryPickHashes: selectedCommitHashes,
            fileList: commitFiles,
          });
        } else {
          await request("openDiffEditor", {
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
      const { filter: current } = get();
      const next = { ...current, ...partial };
      const queryChanged =
        current.searchQuery !== next.searchQuery ||
        current.branch !== next.branch ||
        current.author !== next.author ||
        current.dateRange !== next.dateRange ||
        current.file !== next.file;
      if (!queryChanged) return;

      // Invalidate old results; the replacement response validates selection.
      // These counters are per store instance, so comparison panels stay isolated.
      logLoadGeneration += 1;
      selectionGeneration += 1;
      if (filterRefreshTimer) clearTimeout(filterRefreshTimer);
      filterRefreshTimer = null;
      set({
        filter: next,
        commits: [],
        visibleCommits: [],
        graphLayout: {},
        laneSnapshot: null,
        unavailableRef: null,
        commitFiles: [],
        selectedFilePath: null,
        pendingSelectionFromFilter: [],
        collapsedSequenceIds: new Set(),
        collapsedIntermediates: new Map(),
        hasMore: true,
        loading: false,
      });

      const refresh = () => {
        filterRefreshTimer = null;
        void get().fetchInitialData();
      };
      if (partial.searchQuery !== undefined) {
        filterRefreshTimer = setTimeout(refresh, 200);
      } else {
        refresh();
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
      await request("setFavorite", { ref, favorite });
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
      const preferences = (await request(
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
      const preferences = (await request(
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
        await request(
          "showErrorNotification",
          {
            message: `Could not find ${ref.name} (${targetHash.slice(0, 8)}) in the loaded log.`,
          },
          { scope: "global" },
        );
        return;
      }
      await get().selectCommit(
        targetHash,
        "single",
        visibleHashes,
        "navigation",
      );
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

      const nextVisible = filterCommits(commits, nextMap);
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
            const files = (await request("getCommitRangeFiles", {
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
      set({
        collapsedSequenceIds: new Set(),
        collapsedIntermediates: new Map(),
      });
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

  // Progress counts and both subscriptions are instance-owned. Fixed-repo
  // stores compare events against their configured repo while the ordinary
  // panel follows the repo store's active id.
  const inFlightOpCounts = new Map<string, number>();
  const visibleRepoId = () =>
    options.followGlobalActiveRepo
      ? useRepoStore.getState().activeRepoId
      : options.repoId;

  function recomputeOperationInProgress(): void {
    const repoId = visibleRepoId();
    store.setState({
      operationInProgress:
        repoId !== null && (inFlightOpCounts.get(repoId) ?? 0) > 0,
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

  const unsubscribeEvents = options.bridge.onEvent((event, data) => {
    if (event === "gitStateChanged") {
      const { repoId } = data as { repoId?: string };
      if (!repoId || repoId === visibleRepoId()) {
        void store.getState().refresh();
      }
    }
    if (
      event === "showFileHistory" &&
      options.history.kind === "ordinary" &&
      options.followGlobalActiveRepo
    ) {
      const { file } = data as { file: string };
      store.getState().setFilter({ file });
    }
    if (event === "operationStart") {
      const { repoId } = data as { repoId?: string | null };
      if (typeof repoId === "string") incrementInFlight(repoId);
    }
    if (event === "operationEnd") {
      const { repoId } = data as { repoId?: string | null };
      if (typeof repoId === "string") {
        decrementInFlight(repoId);
      } else {
        inFlightOpCounts.clear();
        recomputeOperationInProgress();
      }
    }
  });

  const unsubscribeActiveRepo = options.followGlobalActiveRepo
    ? useRepoStore.subscribe((state, prevState) => {
        if (state.activeRepoId !== prevState.activeRepoId) {
          recomputeOperationInProgress();
        }
      })
    : null;

  return {
    store,
    beginClientOperation(repoId) {
      if (typeof repoId === "string") incrementInFlight(repoId);
    },
    endClientOperation(repoId) {
      if (typeof repoId === "string") decrementInFlight(repoId);
    },
    resetOperationProgressForTests() {
      inFlightOpCounts.clear();
      recomputeOperationInProgress();
    },
    dispose() {
      if (disposed) return;
      disposed = true;
      invalidateRepoAsyncWork();
      unsubscribeEvents();
      unsubscribeActiveRepo?.();
    },
  };
}

export const defaultGitLogStore = createGitLogStore({
  repoId: null,
  history: { kind: "ordinary" },
  followGlobalActiveRepo: true,
  showCurrentReachability: true,
  bridge,
});

/** Reset default-panel progress tracking (test-only). */
export function _resetOperationProgressForTests(): void {
  defaultGitLogStore.resetOperationProgressForTests();
}

/** Mark an ordinary-panel client operation as in flight. */
export function _beginClientOperation(repoId: string | null): void {
  defaultGitLogStore.beginClientOperation(repoId);
}

/** Clear an ordinary-panel client operation marker. */
export function _endClientOperation(repoId: string | null): void {
  defaultGitLogStore.endClientOperation(repoId);
}
