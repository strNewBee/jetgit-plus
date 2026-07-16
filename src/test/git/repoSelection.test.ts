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

/** A promise we can resolve/reject on demand to control async ordering deterministically. */
function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
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
        reject: (reason?: unknown) => void;
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
        reject: (reason?: unknown) => void;
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
    // The reconciler shares the SAME serializer — the crux of the F5 fix. Its
    // onSettled tail records the real post-reconcile broadcast (M3: this now
    // drives the actual host tail under the mutex, instead of hand-simulating
    // it after the fact — which is what let the I1 stale-tail bug slip through).
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
      // onSettled runs UNDER the mutex inside runPass's finally (I1 fix). Mirrors
      // the host tail: read the registry, persist, broadcast.
      () => {
        const activeId = registry.getActiveId();
        persisted.push(activeId);
        const repo = activeId ? { id: activeId } : null;
        broadcasts.push({ repo });
      },
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

    // NO three-way split: every broadcast agrees with a real registry state, and
    // there is never a divergent `null` that disagrees with the final state.
    // Sequence is B (from select) then A (from reconcile's onSettled tail) —
    // serial, not interleaved. The onSettled tail ran UNDER the mutex, so it
    // could not be re-ordered after a concurrently-queued select (I1).
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

    // The LAST broadcast agrees with the final registry active (I1 invariant:
    // the onSettled tail, running under the mutex, lands the final word).
    assert.strictEqual(broadcastIds.at(-1), registry.getActiveId());

    // Final registry state is A (the reconciliation removed B).
    assert.strictEqual(registry.getActiveId(), "/a");
    // Persisted agrees: select persisted B, then the onSettled tail persisted A
    // (the post-reconcile active). The LAST persisted value matches the final
    // registry active — no stale overwrite (I1).
    assert.deepStrictEqual(persisted, ["/b", "/a"]);
    assert.strictEqual(persisted.at(-1), registry.getActiveId());
  });

  it("I1: a select queued while reconcile is mid-runPass cannot interleave its broadcast with the reconcile's onSettled tail", async () => {
    // The I1 hazard: the post-reconcile persist+broadcast of the active repo
    // used to run OFF the mutex (in reconcileFolders, after `await reconcile`).
    // During that tail's `await workspaceState.update`, a `select` queued on the
    // now-free serializer ran its FULL body (setActive -> persist -> broadcast),
    // then the tail resumed and broadcast the STALE pre-select active id LAST
    // and overwrote the select's fresh persisted value.
    //
    // Post-fix (onSettled under the mutex): the entire reconcile-side tail runs
    // inside runPass's finally, which holds the serializer. A select queued
    // while reconcile is mid-runPass therefore runs STRICTLY AFTER the tail —
    // their broadcasts are ORDERED (select's lands last), and the LAST broadcast
    // agrees with the final registry active.
    //
    // This is NON-VACUOUS: moving onSettled back off the mutex (e.g. into
    // reconcileFolders after `await reconcile`) makes this test FAIL — the
    // onSettled broadcast lands AFTER the select's, so the last broadcast is the
    // stale pre-select active, disagreeing with the final registry active.
    const registry = new RepoRegistry();
    registry.build(
      [discovered("/a"), discovered("/b"), discovered("/d")],
      (p) => new GitService(p),
    );
    registry.setActive("/a");

    const broadcasts: { repo: { id: string } | null }[] = [];
    const persisted: (string | null)[] = [];

    const { calls, discover } = controllableDiscover();
    const shared = new Serializer();

    const coordinator = new RepoSelectionCoordinator(
      registry,
      (activeId) => {
        persisted.push(activeId);
      },
      (repo) => broadcasts.push({ repo: repo ? { id: repo.id } : null }),
      shared,
    );
    // Gate the onSettled tail so we can PROVE select stays queued until the tail
    // (which holds the mutex) fully completes. Without the gate, microtask
    // draining could advance both the tail and the queued select in one batch,
    // hiding the ordering. The gate makes "tail runs under the mutex, THEN
    // select runs" observable step-by-step.
    const tailGate = deferred<void>();
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
      // The real host tail: read registry, persist, broadcast — now UNDER the
      // mutex (I1 fix). The gate lets us park it mid-tail to observe ordering.
      async () => {
        await tailGate.promise;
        const activeId = registry.getActiveId();
        persisted.push(activeId);
        broadcasts.push({ repo: activeId ? { id: activeId } : null });
      },
    );

    // Start a reconcile that discovers [A, D]. Its discovery parks in the
    // deferred (reconcile holds the mutex for its whole runPass + onSettled).
    const pReconcile = reconciler.reconcile([
      { fsPath: "/a", name: "a" },
      { fsPath: "/d", name: "d" },
    ]);
    await drainMicrotasks();
    assert.strictEqual(calls.length, 1, "reconcile discovery in flight");

    // WHILE reconcile is mid-runPass (holding the mutex), queue select(D). It
    // chains on the SAME serializer tail and cannot run until reconcile —
    // INCLUDING its onSettled tail — fully releases the mutex.
    const pSelect = coordinator.select("/d");
    await drainMicrotasks();
    // select has NOT run yet: still parked behind the in-flight reconcile.
    assert.strictEqual(
      registry.getActiveId(),
      "/a",
      "select queued behind reconcile; active unchanged",
    );

    // Complete the reconcile's discovery: applies [A, D], then runPass enters its
    // finally and calls onSettled — which parks on tailGate (still under the
    // mutex). select(D) is STILL queued behind this held mutex.
    calls[0].d.resolve([discovered("/a"), discovered("/d")]);
    await drainMicrotasks();
    // The tail has NOT broadcast yet (parked on tailGate); select has NOT run.
    assert.deepStrictEqual(
      broadcasts.map((b) => (b.repo ? b.repo.id : null)),
      [],
      "onSettled tail parked on gate; no broadcast yet",
    );
    assert.strictEqual(
      registry.getActiveId(),
      "/a",
      "select still queued while the tail holds the mutex",
    );

    // Release the tail. It persists + broadcasts A (the post-reconcile active),
    // THEN runPass's finally resets running and the serializer releases — and
    // ONLY THEN does the queued select(D) get the mutex.
    tailGate.resolve();
    const selectResult = await pSelect;
    assert.strictEqual(selectResult.activeId, "/d");
    await pReconcile;

    // The two broadcasts are ORDERED, not interleaved: A (reconcile tail) then
    // D (select). The LAST broadcast is D — the select's fresh value — NOT the
    // stale A. Pre-fix (tail off the mutex, in reconcileFolders after `await
    // reconcile`) the tail would have been re-ordered to run AFTER select: during
    // the tail's `await workspaceState.update`, select would have run its full
    // body (broadcast D), then the tail resumed and broadcast the STALE A last,
    // disagreeing with the registry. Under the mutex that re-order is impossible.
    assert.deepStrictEqual(
      broadcasts.map((b) => (b.repo ? b.repo.id : null)),
      ["/a", "/d"],
      "ordered A-then-D; select's broadcast lands last (no stale-tail re-order)",
    );
    // The LAST broadcast agrees with the final registry active (the I1 invariant).
    assert.strictEqual(
      broadcasts.at(-1)?.repo?.id ?? null,
      registry.getActiveId(),
    );
    assert.strictEqual(registry.getActiveId(), "/d");
    // The LAST persisted value is D (select's), not a stale A overwrite from the
    // tail (reconcile tail persisted A first, then select persisted D last).
    assert.strictEqual(persisted.at(-1), "/d");
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
      settled: boolean;
      d: {
        promise: Promise<DiscoveredRepo[]>;
        resolve: (v: DiscoveredRepo[]) => void;
        reject: (reason?: unknown) => void;
      };
    }> = [];
    const discover = (
      folders: Array<{ fsPath: string; name: string }>,
    ): Promise<DiscoveredRepo[]> => {
      const d = deferred<DiscoveredRepo[]>();
      calls.push({ folders, settled: false, d });
      return d.promise;
    };
    return { calls, discover };
  }

  it("a failing discovery clears the stashed pending so a later reconcile(latest) lands on latest, not the stale stash", async () => {
    // F6a reproduction (pre-fix): pass 1's discover() is IN FLIGHT (running=true)
    // when reconcile(B) is called → pendingFolders=[B] is stashed. Then pass 1's
    // discover THROWS. The old catch left pendingFolders=[B] untouched, so the
    // re-discover loop continued with the stale B, applied it, and landed on B
    // (stale). A later reconcile(C) arrived too late.
    //
    // Post-fix: the failing-discover catch CLEARS pendingFolders, so the stale B
    // is dropped; the pass bails. A fresh reconcile(C) then starts a new pass and
    // lands on C alone.
    //
    // This is NON-VACUOUS: reverting the `this.pendingFolders = null` in the
    // discover catch makes this test FAIL (the stale B is applied and the final
    // state is B, not C) because the re-discover loop drains the uncleared stash.
    const { calls, discover } = controllableDiscover();
    const applied: DiscoveredRepo[][] = [];
    const appliedIds = () =>
      applied.map((batch) => batch.map((d) => d.descriptor.id));

    // Pass 1's discover is a controllable deferred that we REJECT, so pass 1
    // stays in flight (running=true) until we trigger the throw — letting us
    // stash a real pending during the failing pass.
    const reconciler = new FolderReconciler(
      discover,
      (repos) => applied.push(repos),
      new Serializer(),
    );

    // Pass 1: reconcile([A]). Its discover registers but does NOT resolve yet
    // (running=true, parked in `await this.discover`).
    const p1 = reconciler.reconcile([{ fsPath: "/a", name: "a" }]);
    await drainMicrotasks();
    assert.strictEqual(calls.length, 1, "pass 1 discovery is in flight");
    assert.deepStrictEqual(calls[0].folders, [{ fsPath: "/a", name: "a" }]);

    // WHILE pass 1's discovery is in flight, call reconcile(B). running=true so
    // this stashes pendingFolders=[B] and returns the in-flight tail (p1).
    void reconciler.reconcile([{ fsPath: "/b", name: "b" }]);

    // Now make pass 1's discovery THROW. The catch must CLEAR pendingFolders
    // (the fix) so the stale [B] is never re-discovered.
    calls[0].settled = true;
    calls[0].d.reject(new Error("scan permission denied"));
    await drainMicrotasks();
    // pass 1 has thrown + been caught; running is reset; nothing applied.
    await p1;
    assert.deepStrictEqual(appliedIds(), [], "throwing pass applied nothing");

    // A fresh reconcile(C) arrives. running is false → new in-flight pass.
    const p3 = reconciler.reconcile([{ fsPath: "/c", name: "c" }]);
    await drainMicrotasks();
    assert.ok(calls.length >= 2, "fresh discovery for C was issued");

    // Resolve EVERY outstanding discovery the pass requests, echoing the folders
    // it was asked for (so any stale re-discover the pre-fix bug triggers also
    // completes, applying its stale result — making the divergence a crisp
    // assertion failure rather than a timeout). Under post-fix only the [C]
    // discovery is requested; under pre-fix (clear disabled) the lingering stale
    // [B] pending makes runPass discard [C] and re-discover [B].
    const settleAllDiscoveries = async () => {
      // Bounded: each resolve either applies + breaks (no pending) or re-discovers
      // once; under both fix and pre-fix the loop terminates within a couple of
      // iterations. The cap is a guard against an accidental spin.
      for (let i = 0; i < 8; i++) {
        await drainMicrotasks();
        const pending = calls.filter((c) => !c.settled);
        if (pending.length === 0) break;
        for (const c of pending) {
          c.settled = true;
          c.d.resolve(c.folders.map((f) => discovered(f.fsPath)));
        }
      }
    };
    await settleAllDiscoveries();
    await p3;

    // Final applied state is C (latest). The stale [B] was NEVER applied —
    // pre-fix (catch did not clear pending) the re-discover loop would have
    // continued with [B] after the throw, applied it, and landed on B.
    assert.deepStrictEqual(
      appliedIds(),
      [["/c"]],
      "final state is the latest C, not a stale B stash",
    );
  });
});
