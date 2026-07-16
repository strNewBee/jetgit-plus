import type {
  DiscoveredRepo,
  RepoDescriptor,
  RepoRegistry,
} from "./repoRegistry";

/**
 * A promise-chain mutex: `chain(fn)` runs `fn` only after every previously
 * chained `fn` has settled (fulfilled OR rejected). A failing link is absorbed
 * (`.catch(() => undefined)`) so one rejection can never wedge the chain —
 * later links still run. This is the single lowest-level concurrency primitive
 * in this module.
 *
 * Fix-5 (F5): {@link RepoSelectionCoordinator} and {@link FolderReconciler}
 * historically each kept their OWN private `tail` promise-chain. That meant a
 * `select(B)` and a `reconcile(folders-without-B)` ran on two INDEPENDENT
 * mutexes and could interleave: `select` would `setActive(B)`, read
 * `activeId=B`, then `await persist(B)`; DURING that await a reconciliation
 * could remove B (registry falling back to A); when `select` resumed,
 * `registry.get(B)` returned null → it broadcast `null` and returned
 * `{activeId:B}` while the registry held A — three divergent values. Sharing
 * ONE `Serializer` instance between the coordinator and the reconciler makes
 * `select` and `reconcile`'s pass mutually exclusive: neither can mutate the
 * registry (or read a half-applied registry) while the other is mid-flight.
 */
export class Serializer {
  private tail: Promise<unknown> = Promise.resolve();
  chain<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.tail.then(fn);
    // A failing link must not break the chain: the caller observes `run`'s
    // rejection, but `this.tail` continues on the swallowed value.
    this.tail = run.catch(() => undefined);
    return run;
  }
}

/**
 * Task 24 (P2#6) + Fix-5 (F5): serialize concurrent repo selections so the
 * broadcast always reflects the truly-active repo and persisted state never
 * disagrees with it.
 *
 * The original `selectRepo` handler did `setActive(repoId)` (sync), then
 * `await workspaceState.update(...)`, then `broadcastEvent`. The `await` yields
 * the event loop between `setActive` and the broadcast, so two rapid selects
 * (B then C) interleave: C's `setActive(C)` can run before B's broadcast fires,
 * emitting `activeRepoChanged{B}` while the registry's active repo is actually
 * C — a stale broadcast lands last and the webview ends on the wrong repo after
 * reload. Persisted state can likewise disagree with the last broadcast.
 *
 * Design — selections are chained on a (shared) {@link Serializer} promise-chain
 * mutex: each `select()` awaits the previous link before running, so selections
 * execute one-at-a-time IN SUBMISSION ORDER. Because a selection now runs
 * atomically (setActive -> persist -> broadcast) with no interleaving `await`
 * gap between setActive and broadcast, B fully completes before C starts; the
 * final broadcast is C and matches both the registry active and the persisted
 * value. `setActive` is the single source of truth: the broadcast payload and
 * the returned `activeId` are re-read from the registry (not the captured
 * `repoId`), so they can never disagree with `getActiveId()`.
 *
 * Because the SAME shared `Serializer` is also used by {@link FolderReconciler},
 * a `select` and a folder-reconciliation pass can NEVER interleave: whichever is
 * chained first runs fully (including its `await persist` / `await discover`)
 * before the other begins. This closes the F5 three-way-split window.
 *
 * Persist-before-broadcast is preserved: the persisted value is written before
 * any webview learns of the change, so a reload always observes the same active
 * repo the UI was showing.
 *
 * Dependencies (including the `Serializer`) are injected so this is unit-testable
 * without `activate`.
 */
export class RepoSelectionCoordinator {
  constructor(
    private readonly registry: RepoRegistry,
    private readonly persist: (
      activeId: string | null,
    ) => PromiseLike<void> | void,
    private readonly broadcastActive: (repo: RepoDescriptor | null) => void,
    private readonly serializer: Serializer,
  ) {}

  /**
   * Select `repoId` as active. Resolves once the selection has been fully
   * applied (persisted + broadcast). Rejects with {@link RepoSelectionError}
   * if the repo is no longer registered (e.g. removed by a concurrent folder
   * reconciliation while this select was queued) — in that case the
   * previously-active repo is left untouched and NO broadcast fires.
   */
  select(repoId: string): Promise<{ activeId: string; changed: boolean }> {
    // Chain onto the shared serializer. Each link runs to completion (incl. its
    // broadcast) before the next starts, and — critically — before/after any
    // reconciler pass chained on the SAME serializer, so there is no
    // interleaving window between select and reconcile.
    return this.serializer.chain(async () => {
      if (!this.registry.setActive(repoId)) {
        // The repo vanished while queued (folder reconciliation removed it).
        // Leave the current active as-is; signal failure to the caller.
        throw new RepoSelectionError(`Repository not available: ${repoId}`);
      }
      // Persist BEFORE broadcasting so a reload observes the same active repo
      // the (about-to-be) broadcast claims.
      await this.persist(this.registry.getActiveId());
      // Re-read the active id AFTER the await. The shared mutex guarantees no
      // reconciler mutated the registry during the persist, so in practice this
      // equals the pre-await value — but reading here is the correct
      // belt-and-suspenders: the descriptor lookup, the broadcast payload, and
      // the returned `activeId` all reflect post-persist registry reality, so
      // they can never diverge from one another (the F5 invariant).
      const activeId = this.registry.getActiveId();
      // setActive(repoId) just returned true, so the registry holds repoId as
      // active and getActiveId() is necessarily non-null here. The guard both
      // narrows the type and documents the invariant defensively.
      if (activeId === null) {
        throw new RepoSelectionError(`Repository not available: ${repoId}`);
      }
      const runtime = this.registry.get(activeId);
      this.broadcastActive(runtime ? runtime.descriptor : null);
      return { activeId, changed: true };
    });
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
 * Task 24 (P2#9) + Fix-5/6 (F5/F6): serialize workspace-folder reconciliation so
 * a slow earlier `discoverRepos` cannot complete AFTER a later one and
 * resurrect a repo that the later change removed — and so a reconciliation pass
 * never interleaves with a {@link RepoSelectionCoordinator.select}.
 *
 * The original `onDidChangeWorkspaceFolders` handler ran
 * `await discoverRepos(foldersNow)` with no serialization. If two folder
 * changes arrived quickly, a slower first discovery could finish after a faster
 * second one and re-`add` a repo the second change had removed.
 *
 * Design — single in-flight discovery with "re-discover the latest if a change
 * arrived during flight", all chained on a (shared) {@link Serializer}:
 * - At most one `discoverRepos` runs at a time.
 * - If `reconcile(folders)` is called while a discovery is in flight, the new
 *   folders replace any previously-stashed pending folders (coalescing — only
 *   the LATEST folders matter, not how many changes arrived).
 * - The whole pass (discover + apply + the re-discover loop) runs under the
 *   shared serializer mutex, so it can NEVER interleave with a concurrent
 *   `select` (F5): whichever was chained first completes fully before the other
 *   starts.
 *
 * F6 runPass invariants (vs. the old "apply initial then drain pending" loop):
 * - A discovery result is applied ONLY if no newer change arrived DURING that
 *   discovery. If `pendingFolders` is non-null when discovery resolves, the
 *   just-finished result is STALE (it reflects folders that have since been
 *   superseded) and is discarded; the latest folders are re-discovered. This
 *   removes the old window where the initial (stale) result was applied +
 *   broadcast BEFORE the latest pass — which briefly re-registered + watched a
 *   repo that the latest change had removed.
 * - On `discover` OR `applyDiscovered` failure, `pendingFolders` is CLEARED. The
 *   old code left a stashed pending untouched in the catch, so a later
 *   `reconcile(latest)` could apply `latest` and THEN the stale stash — landing
 *   on the stale value last. Clearing on failure guarantees only a fresh
 *   `reconcile()` call (which sets a new in-flight pass) can reintroduce work.
 *
 * `discover` is injected so tests can introduce deterministic delays, and
 * `applyDiscovered` (the registry mutation) is injected so the same
 * serialization can wrap the activation bootstrap.
 */
export class FolderReconciler {
  // Folders stashed by a `reconcile()` that arrived while a pass was in flight.
  // `null` while no re-run is requested. See runPass for how this is consumed.
  private pendingFolders: Array<{ fsPath: string; name: string }> | null = null;
  private tail: Promise<void> = Promise.resolve();
  private running = false;

  constructor(
    private readonly discover: (
      folders: Array<{ fsPath: string; name: string }>,
    ) => Promise<DiscoveredRepo[]>,
    private readonly applyDiscovered: (repos: DiscoveredRepo[]) => void,
    private readonly serializer: Serializer,
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
      // extra pass with the newest folders. Return the current tail so the
      // caller awaits the in-flight pass (which will re-discover the latest
      // via runPass's pendingFolders check).
      this.pendingFolders = folders;
      return this.tail;
    }
    this.running = true;
    // Chain the whole pass on the SHARED serializer so it cannot interleave
    // with a concurrent `select` (F5), and so multiple reconciles stay ordered.
    // `running` is reset inside runPass's `finally`; the serializer's own
    // `.catch(()=>undefined)` keeps the shared chain alive even if runPass
    // itself ever rejected (it doesn't — it catches internally).
    this.tail = this.serializer.chain(() => this.runPass(folders));
    return this.tail;
  }

  private async runPass(
    initialFolders: Array<{ fsPath: string; name: string }>,
  ): Promise<void> {
    try {
      let current = initialFolders;
      // Re-discover loop: keep going as long as a newer change supersedes the
      // in-flight discovery. Bounded by the number of distinct concurrent
      // `reconcile()` calls, which in practice is tiny (workspace-folder
      // changes arrive in bursts).
      while (true) {
        let discovered: DiscoveredRepo[];
        try {
          discovered = await this.discover(current);
        } catch (err) {
          // F6: a failing discovery must not leave a stale pending for a later
          // pass to re-apply. Log + clear, then bail (running resets below).
          console.error(
            "[jetgit-plus] folder discovery failed:",
            err instanceof Error ? (err.stack ?? err) : err,
          );
          this.pendingFolders = null;
          break;
        }
        if (this.pendingFolders !== null) {
          // A newer change arrived DURING this discovery → the result we just
          // got is stale (it describes superseded folders). Discard it WITHOUT
          // applying and re-discover the latest. This is the F6 stale-result
          // fix: the old code applied the stale result first (briefly
          // re-registering/watching removed repos) before the follow-up.
          current = this.pendingFolders;
          this.pendingFolders = null;
          continue;
        }
        try {
          this.applyDiscovered(discovered);
        } catch (err) {
          // F6: same rationale as the discovery catch — clear any pending so a
          // later reconcile() can't drain a stale stash onto a fresh state.
          console.error(
            "[jetgit-plus] folder apply failed:",
            err instanceof Error ? (err.stack ?? err) : err,
          );
          this.pendingFolders = null;
        }
        // No newer change arrived → we've applied the latest. Done.
        break;
      }
    } finally {
      this.running = false;
    }
  }
}
