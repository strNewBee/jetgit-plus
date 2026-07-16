import * as assert from "node:assert";
import { GitService } from "../../git/gitService";
import {
  type DiscoveredRepo,
  RepoRegistry,
  type RepositoryPaths,
} from "../../git/repoRegistry";
import {
  FolderReconciler,
  RepoSelectionCoordinator,
  RepoSelectionError,
} from "../../git/repoSelection";

function paths(root: string): RepositoryPaths {
  return {
    workTreeRoot: root,
    gitDir: `${root}/.git`,
    commonDir: `${root}/.git`,
  };
}
function discovered(id: string): DiscoveredRepo {
  return { descriptor: { id, name: id, rootPath: id }, paths: paths(id) };
}

/**
 * Drain the microtask queue enough times for the reconciler worker to advance
 * through its synchronous apply + the next discover() call (which registers a
 * new controllable call). Deterministic — no real timers; just N microtask
 * hops. The reconciler's worker does at most a couple of awaits between an
 * injected discovery resolving and the next discover() being invoked, so a
 * handful of hops is always sufficient.
 */
async function drainMicrotasks(hops = 8): Promise<void> {
  for (let i = 0; i < hops; i++) await Promise.resolve();
}

/** A promise we can resolve on demand to control async ordering deterministically. */
function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
} {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((res) => {
    resolve = res;
  });
  return { promise, resolve };
}

describe("RepoSelectionCoordinator (P2#6 selectRepo race)", () => {
  function setup() {
    const registry = new RepoRegistry();
    registry.build(
      [discovered("/a"), discovered("/b"), discovered("/c")],
      (p) => new GitService(p),
    );
    const persisted: (string | null)[] = [];
    const broadcasts: { repo: { id: string } | null }[] = [];
    const coordinator = new RepoSelectionCoordinator(
      registry,
      (activeId) => {
        persisted.push(activeId);
      },
      (repo) => {
        broadcasts.push({ repo: repo ? { id: repo.id } : null });
      },
    );
    return { registry, persisted, broadcasts, coordinator };
  }

  it("two rapid selects resolve to the LAST one and the broadcast reflects the truly-active repo", async () => {
    // Reproduce P2#6: select B then select C with a yielded persist between them.
    // The coordinator serializes them, so C's broadcast must land last and match
    // both the registry active and the persisted value.
    const { registry, persisted, broadcasts, coordinator } = setup();

    const pB = coordinator.select("/b");
    const pC = coordinator.select("/c");
    const [rB, rC] = await Promise.all([pB, pC]);

    assert.strictEqual(rB.activeId, "/b");
    assert.strictEqual(rC.activeId, "/c");
    // Registry active is the truly-active repo (C).
    assert.strictEqual(registry.getActiveId(), "/c");
    // The LAST broadcast reflects C — no stale B broadcast lands last.
    assert.strictEqual(broadcasts.at(-1)?.repo?.id, "/c");
    // Persisted value agrees with the last broadcast.
    assert.strictEqual(persisted.at(-1), "/c");
    // Both selects broadcast (in submission order: B then C).
    assert.deepStrictEqual(
      broadcasts.map((b) => b.repo?.id ?? null),
      ["/b", "/c"],
    );
    assert.deepStrictEqual(persisted, ["/b", "/c"]);
  });

  it("persists BEFORE broadcasting (reload observes the broadcast's active repo)", async () => {
    const { persisted, broadcasts, coordinator } = setup();
    await coordinator.select("/c");
    // Persisted is captured before the broadcast is emitted — the coordinator
    // awaits persist then calls broadcastActive synchronously after.
    assert.strictEqual(persisted.length, 1);
    assert.strictEqual(persisted[0], "/c");
    assert.strictEqual(broadcasts.length, 1);
    assert.strictEqual(broadcasts[0].repo?.id, "/c");
  });

  it("a stale select whose repo was removed mid-flight fails and does not broadcast", async () => {
    // select B is queued behind a slow select A; while queued, a folder
    // reconciliation removes B. When B's turn comes, setActive fails → reject,
    // no broadcast, previously-active repo untouched.
    const { registry, broadcasts } = setup();
    registry.setActive("/a");

    let releaseA!: () => void;
    const holdA = new Promise<void>((res) => {
      releaseA = res;
    });
    // Gate the first select's persist so the second queues behind it.
    const slowCoordinator = new RepoSelectionCoordinator(
      registry,
      async () => {
        if (registry.getActiveId() === "/a") await holdA;
      },
      (repo) => broadcasts.push({ repo: repo ? { id: repo.id } : null }),
    );

    const pA = slowCoordinator.select("/a");
    const pB = slowCoordinator.select("/b"); // queues behind A
    // While A is still in flight, remove B (simulating reconciliation).
    registry.remove("/b");
    releaseA();
    await pA;
    await assert.rejects(pB, RepoSelectionError);

    // Only A broadcast; B failed and broadcast nothing. Active stayed on A.
    assert.deepStrictEqual(
      broadcasts.map((b) => b.repo?.id ?? null),
      ["/a"],
    );
    assert.strictEqual(registry.getActiveId(), "/a");
  });
});

describe("FolderReconciler (P2#9 folder reconciliation)", () => {
  /**
   * A controllable `discover`: each call returns a deferred the test resolves,
   * so we can make the FIRST discovery complete AFTER the second change — the
   * exact resurrection hazard — deterministically (no real timers).
   */
  function controllableDiscover() {
    const calls: Array<{
      folders: Array<{ fsPath: string; name: string }>;
      d: {
        promise: Promise<DiscoveredRepo[]>;
        resolve: (v: DiscoveredRepo[]) => void;
      };
    }> = [];
    const discover = (
      folders: Array<{ fsPath: string; name: string }>,
    ): Promise<DiscoveredRepo[]> => {
      const d = deferred<DiscoveredRepo[]>();
      calls.push({ folders, d });
      return d.promise;
    };
    return { calls, discover };
  }

  it("a late-finishing earlier discovery does NOT resurrect a repo the later change removed", async () => {
    // Change 1: folders -> [A, B] (slow discovery).
    // Change 2: folders -> [A] (B removed) arrives while change 1 is in flight.
    // Without serialization, change 1's late completion would re-add B.
    // With the reconciler, a follow-up pass with [A] runs after, so B is gone.
    const { calls, discover } = controllableDiscover();
    const applied: DiscoveredRepo[][] = [];
    const reconciler = new FolderReconciler(discover, (repos) => {
      applied.push(repos);
    });

    const p1 = reconciler.reconcile([
      { fsPath: "/a", name: "a" },
      { fsPath: "/b", name: "b" },
    ]);
    // Change 2 arrives while change 1's discovery is in flight.
    const p2 = reconciler.reconcile([{ fsPath: "/a", name: "a" }]);

    assert.strictEqual(
      calls.length,
      1,
      "only one discovery in flight at a time",
    );

    // Now resolve the SLOW first discovery (the resurrection hazard): it sees
    // [A, B]. The reconciler must then run a follow-up pass with the LATEST
    // folders ([A]) so B does not survive.
    calls[0].d.resolve([discovered("/a"), discovered("/b")]);
    // Yield so runPass advances past the first apply and into the follow-up
    // pass (which registers calls[1]). We must drive BOTH deferreds before the
    // reconciler's tail promise can settle.
    await drainMicrotasks();

    // A follow-up pass was scheduled with the latest folders.
    assert.strictEqual(calls.length, 2);
    assert.deepStrictEqual(calls[1].folders, [{ fsPath: "/a", name: "a" }]);
    calls[1].d.resolve([discovered("/a")]);
    // Both callers share the same tail promise that resolves once the worker
    // reaches idle (after the follow-up apply).
    await p1;
    await p2;

    // The final applied state reflects the LATEST folders only — B is gone.
    assert.deepStrictEqual(
      applied.at(-1)?.map((d) => d.descriptor.id),
      ["/a"],
    );
  });

  it("coalesces N rapid changes into one in-flight + one follow-up pass", async () => {
    const { calls, discover } = controllableDiscover();
    const reconciler = new FolderReconciler(discover, () => {});

    const p1 = reconciler.reconcile([{ fsPath: "/a", name: "a" }]);
    reconciler.reconcile([{ fsPath: "/b", name: "b" }]);
    reconciler.reconcile([{ fsPath: "/c", name: "c" }]);
    reconciler.reconcile([{ fsPath: "/d", name: "d" }]);

    assert.strictEqual(calls.length, 1, "single in-flight discovery");
    calls[0].d.resolve([discovered("/a")]);
    // Yield so the worker advances into the coalesced follow-up pass.
    await drainMicrotasks();

    // Exactly one follow-up pass, with the LATEST folders ([D]).
    assert.strictEqual(calls.length, 2);
    assert.deepStrictEqual(calls[1].folders, [{ fsPath: "/d", name: "d" }]);
    calls[1].d.resolve([discovered("/d")]);
    await p1;
  });

  it("serial discovery: with no concurrent change, runs exactly once", async () => {
    const { calls, discover } = controllableDiscover();
    const reconciler = new FolderReconciler(discover, () => {});
    const p = reconciler.reconcile([{ fsPath: "/a", name: "a" }]);
    calls[0].d.resolve([discovered("/a")]);
    await p;
    assert.strictEqual(calls.length, 1);
  });
});
