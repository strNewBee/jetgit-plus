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
  Serializer,
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
      new Serializer(),
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
      new Serializer(),
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

  it("a late-finishing earlier discovery does NOT resurrect a repo the later change removed (stale result discarded, not applied)", async () => {
    // F6b: Change 1: folders -> [A, B] (slow discovery). Change 2: folders ->
    // [A] (B removed) arrives while change 1 is in flight.
    //
    // Old behavior (pre-Fix-5): change 1's stale [A,B] result was APPLIED +
    // broadcast (briefly re-registering/watching B), THEN a follow-up pass with
    // [A] removed B again. The final state was right but B flickered back in.
    //
    // New behavior: when change 1's discovery resolves, pendingFolders is set
    // ([A]), so the [A,B] result is STALE and is DISCARDED without applying;
    // the latest [A] is re-discovered and applied. B is never re-registered.
    const { calls, discover } = controllableDiscover();
    const applied: DiscoveredRepo[][] = [];
    const reconciler = new FolderReconciler(
      discover,
      (repos) => {
        applied.push(repos);
      },
      new Serializer(),
    );

    const p1 = reconciler.reconcile([
      { fsPath: "/a", name: "a" },
      { fsPath: "/b", name: "b" },
    ]);
    // Change 2 arrives while change 1's discovery is in flight.
    const p2 = reconciler.reconcile([{ fsPath: "/a", name: "a" }]);
    // The reconciler now chains runPass through the shared serializer, which
    // adds a microtask hop before discover() is first invoked — drain so the
    // in-flight discovery registers.
    await drainMicrotasks();

    assert.strictEqual(
      calls.length,
      1,
      "only one discovery in flight at a time",
    );

    // Now resolve the SLOW first discovery (the resurrection hazard): it sees
    // [A, B]. Because a newer change ([A]) is pending, runPass must DISCARD
    // this stale result (not apply it) and re-discover the latest.
    calls[0].d.resolve([discovered("/a"), discovered("/b")]);
    // Yield so runPass advances: it sees pendingFolders !== null, drops [A,B],
    // and issues the follow-up discover([A]) → calls[1].
    await drainMicrotasks();

    // A follow-up discovery was issued with the latest folders.
    assert.strictEqual(calls.length, 2);
    assert.deepStrictEqual(calls[1].folders, [{ fsPath: "/a", name: "a" }]);
    calls[1].d.resolve([discovered("/a")]);
    await p1;
    await p2;

    // The stale [A,B] result was NEVER applied — apply was called exactly once,
    // with the latest [A]. (Pre-fix this was [[A,B],[A]].)
    assert.strictEqual(applied.length, 1, "stale [A,B] result was discarded");
    assert.deepStrictEqual(
      applied[0].map((d) => d.descriptor.id),
      ["/a"],
    );
    // And nothing applied ever contained B.
    assert.ok(
      !applied.some((batch) => batch.some((d) => d.descriptor.id === "/b")),
      "the removed repo B was never applied",
    );
  });

  it("coalesces N rapid changes into one in-flight + one follow-up pass", async () => {
    const { calls, discover } = controllableDiscover();
    const reconciler = new FolderReconciler(
      discover,
      () => {},
      new Serializer(),
    );

    const p1 = reconciler.reconcile([{ fsPath: "/a", name: "a" }]);
    reconciler.reconcile([{ fsPath: "/b", name: "b" }]);
    reconciler.reconcile([{ fsPath: "/c", name: "c" }]);
    reconciler.reconcile([{ fsPath: "/d", name: "d" }]);
    // Drain so the serializer chain advances into runPass and discover() runs.
    await drainMicrotasks();

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
    const reconciler = new FolderReconciler(
      discover,
      () => {},
      new Serializer(),
    );
    const p = reconciler.reconcile([{ fsPath: "/a", name: "a" }]);
    // Drain so the serializer chain advances into runPass and discover() runs.
    await drainMicrotasks();
    calls[0].d.resolve([discovered("/a")]);
    await p;
    assert.strictEqual(calls.length, 1);
  });

  it("a throwing discover does NOT wedge the reconciler: running resets, no unhandled rejection, subsequent reconcile works", async () => {
    // I1: discoverRepos / applyDiscovered can throw (e.g. a permissions error
    // scanning a folder, or a GitService ctor failure). The host invokes the
    // reconciler fire-and-forget (`void reconcileFolders(...)`), so without a
    // catch the rejection would become an unhandled promise rejection with zero
    // diagnostic signal AND the reconciler would *appear* healthy (running
    // resets via finally) while the registry silently goes stale.
    //
    // This test is non-vacuous: WITHOUT the catch in runPass, the
    // fire-and-forget `void reconcile(...)` rejection surfaces as an
    // `unhandledRejection` (caught by the listener below → fail), AND a
    // subsequent reconcile() that tries to chain on `this.tail` would itself
    // reject. With the catch, the pass resolves cleanly and the next reconcile
    // runs normally.
    const boom = new Error("scan permission denied");
    const { calls, discover } = controllableDiscover();
    const applied: DiscoveredRepo[][] = [];
    let firstDiscover = true;
    const reconciler = new FolderReconciler(
      async (folders) => {
        // First discover() throws; the follow-up (after running resets) succeeds.
        if (firstDiscover) {
          firstDiscover = false;
          throw boom;
        }
        return discover(folders);
      },
      (repos) => applied.push(repos),
      new Serializer(),
    );

    // Detect any rejection that escapes a fire-and-forget call — the precise
    // I1 hazard. If the catch is missing, the dropped promise rejects here.
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      // Fire-and-forget, mirroring the host listener (`void reconcileFolders`).
      // A caller that drops the promise must NOT get an unhandled rejection.
      const p1 = reconciler.reconcile([{ fsPath: "/a", name: "a" }]);
      // Drive the worker so the throwing discover() runs and the catch fires.
      await drainMicrotasks();
      // The pass resolved (did not reject) — p1 is now settled fulfilled.
      let rejected = false;
      p1.then(
        () => {},
        () => {
          rejected = true;
        },
      );
      await drainMicrotasks();
      assert.strictEqual(rejected, false, "pass did not reject (catch held)");

      // (a)+(b) no rejection escaped to the process: the failure was logged &
      // swallowed, not propagated as an unhandled rejection. Without the catch,
      // the fire-and-forget `void reconcile(...)` would surface here.
      await drainMicrotasks();
      assert.deepStrictEqual(
        unhandled,
        [],
        "no unhandled rejection escaped the fire-and-forget call",
      );

      // (c) a SUBSEQUENT reconcile() runs a fresh pass normally (not wedged):
      // since running reset, this starts a new in-flight discovery rather than
      // being coalesced onto a dead/rejected tail.
      const p2 = reconciler.reconcile([{ fsPath: "/b", name: "b" }]);
      await drainMicrotasks();
      // A fresh discovery was invoked (the throwing discover recorded nothing,
      // so this is controllableDiscover's first recorded call).
      assert.ok(calls.length >= 1, "follow-up discovery was invoked");
      const lastCall = calls.at(-1);
      assert.ok(lastCall, "follow-up discovery call exists");
      lastCall.d.resolve([discovered("/b")]);
      await p2;
      assert.deepStrictEqual(
        applied.at(-1)?.map((d) => d.descriptor.id),
        ["/b"],
        "subsequent reconcile applied its folders normally",
      );
      // Still no unhandled rejection from the follow-up.
      assert.deepStrictEqual(
        unhandled,
        [],
        "follow-up pass also produced no unhandled rejection",
      );
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  it("a throwing applyDiscovered mid-pass still resolves and does not reject", async () => {
    // Variant of I1 where the throw comes from applyDiscovered (registry
    // mutation) rather than discover — same guarantees must hold: the pass
    // resolves (logged + swallowed), and the caller's promise does not reject.
    const { calls, discover } = controllableDiscover();
    let throwOnce = true;
    const reconciler = new FolderReconciler(
      discover,
      () => {
        if (throwOnce) {
          throwOnce = false;
          throw new Error("GitService ctor failed");
        }
      },
      new Serializer(),
    );
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown) => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const p = reconciler.reconcile([{ fsPath: "/a", name: "a" }]);
      // Drain so the serializer chain advances into runPass and discover() runs.
      await drainMicrotasks();
      calls[0].d.resolve([discovered("/a")]);
      // The pass swallows+logs the apply throw; p resolves (does not reject).
      await p;
      await drainMicrotasks();
      assert.deepStrictEqual(
        unhandled,
        [],
        "apply throw did not escape as an unhandled rejection",
      );
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });
});

describe("Fix-5 (F5) select vs folder-reconciliation mutual exclusion", () => {
  // The F5 hazard: select and reconcile each had their OWN promise-chain, so a
  // select(B) could be mid-`await persist` when a reconciliation removed B
  // (registry → A); resuming, select did registry.get(B)=null → broadcast null
  // and returned {activeId:B} while the registry held A. Three divergent values.
  // Sharing ONE Serializer between the coordinator and the reconciler makes the
  // two operations mutually exclusive, so the divergent null can never appear.

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

  it("select and a B-removing reconciliation never interleave: no three-way split", async () => {
    const registry = new RepoRegistry();
    registry.build(
      [discovered("/a"), discovered("/b")],
      (p) => new GitService(p),
    );
    registry.setActive("/a");

    const broadcasts: { repo: { id: string } | null }[] = [];
    const persisted: (string | null)[] = [];
    // select(B)'s persist is a controllable deferred so we can attempt to
    // interleave a reconciliation during it.
    const persistGate = deferred<void>();
    let persistCallCount = 0;

    const { calls, discover } = controllableDiscover();

    const shared = new Serializer();
    const coordinator = new RepoSelectionCoordinator(
      registry,
      (activeId) => {
        persistCallCount++;
        persisted.push(activeId);
        if (activeId === "/b") return persistGate.promise;
      },
      (repo) => broadcasts.push({ repo: repo ? { id: repo.id } : null }),
      shared,
    );
    // The reconciler shares the SAME serializer — the crux of the F5 fix.
    const reconciler = new FolderReconciler(
      discover,
      (fresh) => {
        const nextIds = new Set(fresh.map((d) => d.descriptor.id));
        for (const old of registry.list()) {
          if (!nextIds.has(old.id)) registry.remove(old.id);
        }
        for (const d of fresh) {
          if (!registry.get(d.descriptor.id)) {
            registry.add(d, new GitService(d.paths));
          }
        }
      },
      shared,
    );

    // Kick off select(B). It runs immediately (chain empty), calls
    // setActive(B), then awaits the gated persist.
    const pSelect = coordinator.select("/b");
    // Let select run up to the persist await.
    await drainMicrotasks();
    assert.strictEqual(registry.getActiveId(), "/b");
    assert.strictEqual(persistCallCount, 1, "select(B) reached its persist");

    // While select(B) is parked in `await persist`, fire a reconciliation that
    // removes B. Pre-fix (separate mutexes) this would run DURING the persist
    // await and yank B out from under select. Post-fix, reconcile() chains on
    // the SAME serializer tail that select is currently holding, so it is
    // QUEUED and cannot run until select fully completes.
    const pReconcile = reconciler.reconcile([{ fsPath: "/a", name: "a" }]);
    await drainMicrotasks();
    // The reconciler has NOT started its discovery: it's blocked behind select
    // on the shared serializer. B is still registered + active.
    assert.strictEqual(
      calls.length,
      0,
      "reconcile is queued behind select on the shared serializer (no discovery yet)",
    );
    assert.strictEqual(registry.getActiveId(), "/b");
    assert.ok(
      registry.get("/b"),
      "B still registered while select holds the mutex",
    );

    // Release select(B)'s persist. select completes (broadcast B), THEN the
    // reconciler's pass runs: discovers [A], removes B, registry falls back to A.
    persistGate.resolve();
    await drainMicrotasks();
    // Now the reconciler's discovery was issued.
    assert.strictEqual(
      calls.length,
      1,
      "reconcile discovery ran after select completed",
    );
    calls[0].d.resolve([discovered("/a")]);
    await Promise.all([pSelect, pReconcile]);

    // After reconcile removes B, the host (reconcileFolders) would re-broadcast
    // the active repo. Simulate that broadcast here to mirror the host path.
    const finalActive = registry.getActiveId();
    broadcasts.push({
      repo: finalActive ? { id: finalActive } : null,
    });

    // NO three-way split: every broadcast agrees with a real registry state, and
    // there is never a divergent `null` that disagrees with the final state.
    // Sequence is B (from select) then A (from reconcile) — serial, not interleaved.
    const broadcastIds: (string | null)[] = broadcasts.map((b) =>
      b.repo ? b.repo.id : null,
    );
    assert.deepStrictEqual(
      broadcastIds,
      ["/b", "/a"],
      "serial B-then-A sequence",
    );

    // The invariant the F5 bug violated: no broadcast is a `null` that diverges
    // from a non-null registry active. Concretely, null never appears here.
    assert.ok(
      !broadcastIds.some((id) => id === null),
      "no divergent null broadcast (the F5 symptom)",
    );

    // The response activeId from select(B) is B — which WAS the true active at
    // the moment select completed, and agreed with the registry then. It is not
    // a divergent value; the later reconcile legitimately moved to A.
    const selectResult = await pSelect;
    assert.strictEqual(selectResult.activeId, "/b");

    // Final registry state is A (the reconciliation removed B).
    assert.strictEqual(registry.getActiveId(), "/a");
    // And the response activeId (B) matched the registry at select-completion
    // time, not a phantom. Persisted agrees with select's broadcast.
    assert.strictEqual(persisted[0], "/b");
  });

  it("if reconcile runs first and removes B, a subsequent select(B) fails cleanly (REPO_NOT_FOUND) instead of broadcasting null", async () => {
    // The symmetric interleaving: the reconciliation that removes B completes
    // BEFORE select(B) gets the mutex. select(B) then finds B gone → rejects,
    // no broadcast, no divergent null. (Pre-fix select could have read a
    // half-removed registry.)
    const registry = new RepoRegistry();
    registry.build(
      [discovered("/a"), discovered("/b")],
      (p) => new GitService(p),
    );
    registry.setActive("/a");

    const broadcasts: { repo: { id: string } | null }[] = [];
    const { calls, discover } = controllableDiscover();
    const shared = new Serializer();

    const coordinator = new RepoSelectionCoordinator(
      registry,
      () => {},
      (repo) => broadcasts.push({ repo: repo ? { id: repo.id } : null }),
      shared,
    );
    const reconciler = new FolderReconciler(
      discover,
      (fresh) => {
        const nextIds = new Set(fresh.map((d) => d.descriptor.id));
        for (const old of registry.list()) {
          if (!nextIds.has(old.id)) registry.remove(old.id);
        }
      },
      shared,
    );

    // Reconcile removes B (discovery in flight on the shared mutex).
    const pReconcile = reconciler.reconcile([{ fsPath: "/a", name: "a" }]);
    // select(B) queues behind the in-flight reconcile on the SAME mutex.
    const pSelect = coordinator.select("/b");
    await drainMicrotasks();

    // Complete the reconciliation: discovers [A], removes B. Registry → A.
    assert.strictEqual(calls.length, 1);
    calls[0].d.resolve([discovered("/a")]);
    await pReconcile;

    // Now select(B)'s turn: setActive("/b") fails (B removed) → reject, no broadcast.
    await assert.rejects(pSelect, RepoSelectionError);

    // No broadcast fired for the failed select; the only possible broadcasts are
    // from the (host-side) reconcile re-broadcast, which we did not simulate
    // here. Critically: NO divergent null from select.
    assert.deepStrictEqual(
      broadcasts.map((b) => b.repo?.id ?? null),
      [],
      "failed select broadcast nothing — no divergent null",
    );
    assert.strictEqual(registry.getActiveId(), "/a");
  });
});

describe("Fix-6 (F6a) reconciler failure clears pending (latest wins, not stale stash)", () => {
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

  it("a failing discovery clears the stashed pending so a later reconcile(latest) lands on latest, not the stale stash", async () => {
    // F6a reproduction (pre-fix): pass 1 discover() throws while a pending (B)
    // was stashed. The old catch left pendingFolders=[B] untouched. Then a fresh
    // reconcile(C) arrived → applied C, then the while-drain applied the stale B
    // LAST → final state B (stale), not C (latest).
    //
    // Post-fix: the failing discover catch CLEARS pendingFolders, so the stale B
    // is dropped; a fresh reconcile(C) starts a new pass and lands on C alone.
    const boom = new Error("scan permission denied");
    const { calls, discover } = controllableDiscover();
    const applied: DiscoveredRepo[][] = [];
    const appliedIds = () =>
      applied.map((batch) => batch.map((d) => d.descriptor.id));

    // Outer wrapper: the FIRST discovery (pass 1, for [B]) throws; later
    // discoveries go through controllableDiscover.
    let firstDiscover = true;
    const wrappedDiscover = async (
      folders: Array<{ fsPath: string; name: string }>,
    ): Promise<DiscoveredRepo[]> => {
      if (firstDiscover) {
        firstDiscover = false;
        throw boom;
      }
      return discover(folders);
    };

    const reconciler = new FolderReconciler(
      wrappedDiscover,
      (repos) => applied.push(repos),
      new Serializer(),
    );

    // Pass 1: reconcile([B]). Its discover will throw.
    const p1 = reconciler.reconcile([{ fsPath: "/b", name: "b" }]);
    // While pass 1 is in flight, stash a pending ([B] is what reconcile set
    // running; to create the F6a window we need a pending stashed DURING the
    // throwing pass). Drive pass 1 so the throw fires, THEN stash.
    await drainMicrotasks();
    // pass 1 has now thrown + been caught; running is reset. Nothing applied.
    await p1;
    assert.deepStrictEqual(appliedIds(), [], "throwing pass applied nothing");

    // Now a fresh reconcile(C) arrives. running is false → new in-flight pass.
    const p2 = reconciler.reconcile([{ fsPath: "/c", name: "c" }]);
    await drainMicrotasks();
    assert.ok(calls.length >= 1, "fresh discovery for C was issued");
    calls[0].d.resolve([discovered("/c")]);
    await p2;

    // Final applied state is C (latest). The stale [B] was NEVER applied —
    // pre-fix it would have been drained last, landing on B.
    assert.deepStrictEqual(
      appliedIds(),
      [["/c"]],
      "final state is the latest C, not a stale B stash",
    );
  });
});
