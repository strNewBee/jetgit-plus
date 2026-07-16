import type {
  DiscoveredRepo,
  RepoDescriptor,
  RepoRegistry,
} from "./repoRegistry";

/**
 * Task 24 (P2#6): serialize concurrent repo selections so the broadcast always
 * reflects the truly-active repo and persisted state never disagrees with it.
 *
 * The original `selectRepo` handler did `setActive(repoId)` (sync), then
 * `await workspaceState.update(...)`, then `broadcastEvent`. The `await` yields
 * the event loop between `setActive` and the broadcast, so two rapid selects
 * (B then C) interleave: C's `setActive(C)` can run before B's broadcast fires,
 * emitting `activeRepoChanged{B}` while the registry's active repo is actually
 * C — a stale broadcast lands last and the webview ends on the wrong repo after
 * reload. Persisted state can likewise disagree with the last broadcast.
 *
 * Design — a promise-chain mutex (simplest provably-correct option):
 * Each `select()` awaits the previous selection before running, so selections
 * execute one-at-a-time IN SUBMISSION ORDER. Because a selection now runs
 * atomically (setActive -> persist -> broadcast) with no interleaving `await`
 * gap between setActive and broadcast, B fully completes before C starts; the
 * final broadcast is C and matches both the registry active and the persisted
 * value. `setActive` is the single source of truth: the broadcast payload is
 * re-read from the registry (not the captured `repoId`), so the broadcast can
 * never disagree with `getActiveId()`.
 *
 * A generation counter was the alternative; the chain is strictly simpler and
 * gives in-order semantics for free (last submitted is last to run, so
 * "last-completed-wins" = "last-submitted-wins"). Persist-before-broadcast is
 * preserved: the persisted value is written before any webview learns of the
 * change, so a reload always observes the same active repo the UI was showing.
 *
 * Dependencies are injected so this is unit-testable without `activate`.
 */
export class RepoSelectionCoordinator {
  private tail: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly registry: RepoRegistry,
    private readonly persist: (
      activeId: string | null,
    ) => PromiseLike<void> | void,
    private readonly broadcastActive: (repo: RepoDescriptor | null) => void,
  ) {}

  /**
   * Select `repoId` as active. Resolves once the selection has been fully
   * applied (persisted + broadcast). Rejects with {@link RepoSelectionError}
   * if the repo is no longer registered (e.g. removed by a concurrent folder
   * reconciliation while this select was queued) — in that case the
   * previously-active repo is left untouched and NO broadcast fires.
   */
  async select(
    repoId: string,
  ): Promise<{ activeId: string; changed: boolean }> {
    // Chain onto the previous selection. Each link runs to completion (incl. its
    // broadcast) before the next starts, so there is no interleaving window.
    const run = this.tail.then(async () => {
      if (!this.registry.setActive(repoId)) {
        // The repo vanished while queued (folder reconciliation removed it).
        // Leave the current active as-is; signal failure to the caller.
        throw new RepoSelectionError(`Repository not available: ${repoId}`);
      }
      const activeId = this.registry.getActiveId();
      // Persist BEFORE broadcasting so a reload observes the same active repo
      // the (about-to-be) broadcast claims. The value comes from the registry
      // (source of truth), not the captured repoId.
      await this.persist(activeId);
      const runtime = activeId ? this.registry.get(activeId) : null;
      this.broadcastActive(runtime ? runtime.descriptor : null);
      return { activeId, changed: true };
    });
    // Keep the chain from breaking on rejection: a failed select must not
    // prevent later selects from running. The caller still sees the rejection
    // via `run`; the chain continues via `this.tail`.
    this.tail = run.catch(() => undefined);
    return run as Promise<{ activeId: string; changed: boolean }>;
  }
}

/** Raised when a queued selection targets a repo that no longer exists. */
export class RepoSelectionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "RepoSelectionError";
  }
}

/**
 * Task 24 (P2#9): serialize workspace-folder reconciliation so a slow earlier
 * `discoverRepos` cannot complete AFTER a later one and resurrect a repo that
 * the later change removed.
 *
 * The original `onDidChangeWorkspaceFolders` handler ran
 * `await discoverRepos(foldersNow)` with no serialization. If two folder
 * changes arrived quickly, a slower first discovery could finish after a faster
 * second one and re-`add` a repo the second change had removed.
 *
 * Design — single in-flight discovery with "re-run once more if a change
 * arrived during flight":
 * - At most one `discoverRepos` runs at a time.
 * - If `reconcile(folders)` is called while a discovery is in flight, the new
 *   folders replace any previously-stashed pending folders and exactly one
 *   re-run is scheduled after the in-flight one completes (coalescing — only
 *   the LATEST folders matter, not how many changes arrived).
 * - Therefore the final pass always reflects the latest folders, and a late
 *   earlier discovery has no window to re-add a removed repo: a change that
 *   arrives during flight forces a final pass using fresher folders.
 *
 * `discover` is injected so tests can introduce deterministic delays, and
 * `applyDiscovered` (the registry mutation) is injected so the same
 * serialization can wrap the activation bootstrap.
 */
export class FolderReconciler {
  // Folders awaiting a follow-up pass; `null` while no re-run is requested.
  private pendingFolders: Array<{ fsPath: string; name: string }> | null = null;
  private tail: Promise<void> = Promise.resolve();
  private running = false;

  constructor(
    private readonly discover: (
      folders: Array<{ fsPath: string; name: string }>,
    ) => Promise<DiscoveredRepo[]>,
    private readonly applyDiscovered: (repos: DiscoveredRepo[]) => void,
  ) {}

  /**
   * Reconcile the registry against `folders`. Resolves once the registry
   * reflects these folders (and any later folders supplied via concurrent
   * `reconcile` calls). Safe to call concurrently; only one discovery runs at a
   * time and the final state always matches the latest folders.
   */
  reconcile(folders: Array<{ fsPath: string; name: string }>): Promise<void> {
    if (this.running) {
      // Coalesce: a discovery is in flight — stash the latest folders so a
      // single follow-up pass runs after it. N rapid changes collapse to one
      // extra pass with the newest folders.
      this.pendingFolders = folders;
      return this.tail;
    }
    this.running = true;
    this.tail = this.runPass(folders);
    return this.tail;
  }

  private async runPass(
    folders: Array<{ fsPath: string; name: string }>,
  ): Promise<void> {
    try {
      this.applyDiscovered(await this.discover(folders));
      // If another change arrived while we were discovering (or while applying),
      // run ONE more pass with the latest stashed folders. Loop until no more
      // changes arrive so the final registry reflects the very latest folders.
      while (this.pendingFolders !== null) {
        const next = this.pendingFolders;
        // Clear before re-running so a change arriving during the re-run stashes
        // again and forces yet another pass.
        this.pendingFolders = null;
        this.applyDiscovered(await this.discover(next));
      }
    } finally {
      this.running = false;
    }
  }
}
