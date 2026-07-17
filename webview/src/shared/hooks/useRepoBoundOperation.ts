import { useCallback, useEffect, useRef, useState } from "react";
import { bridge } from "../bridge";
import type { CommandType, RequestOptions } from "../bridge/types";

/**
 * A pending deferred repo: its id AND its disambiguated label land together.
 * `seq` is the shared monotonic sequence number stamped at ARRIVAL (see
 * `seqRef`), so this hook's `activeRepoChanged` and Push's `pushPanelInit`
 * can compete on a single latest-wins ordering — the LAST-ARRIVED event wins
 * regardless of which deferred queue drains first.
 */
interface PendingRepo {
  seq: number;
  id: string | null;
  name: string;
}

/**
 * Authoritative repo-bound operation hook for Push / Rollback / Conflicts
 * panels. Replaces `useOperationRepoBinding` for these panels by exposing the
 * authoritative `repoId` the panel renders, the matching disambiguated
 * `repoName` (kept in lockstep with `repoId`), a bound `request()` that stamps
 * every call with that repoId (the correctness guarantee), and a `bindRepo()`
 * setter the panel uses on host-driven re-init.
 *
 * Lifecycle:
 * - `repoId` is seeded from `#root[data-repo-id]` and `repoName` from
 *   `#root[data-repo-name]` (the host's create-time payload) so the very first
 *   render is correct before any event lands.
 * - `setRepo(id, name?)` updates the refs, calls `bridge.setRepoContext(id)`
 *   SYNCHRONOUSLY (so the generation bumps and stale-drop still works for the
 *   bound request before `onFollow`'s own requests fire), then flushes state.
 *   The short-circuit only fires when BOTH id and name are unchanged, since a
 *   reposChanged pass can shift the active repo's disambiguated label without
 *   changing its id.
 * - Idle follow: an `activeRepoChanged` event while not busy switches the repo
 *   (id + name together) and calls `onFollow`. While busy, the latest pending
 *   `{ id, name }` is deferred and applied together when `busy` flips false.
 *   This MUST carry both — applying a new id with a stale name (or vice versa)
 *   would point a destructive action at the wrong repo.
 * - `bindRepo(id, name?)` is the re-init entry point used by the panel's
 *   host-message listener; it routes through the same `setRepo` so context +
 *   state stay in lockstep. It is intentionally NOT seq-gated (see below).
 * - Latest-wins seq: every binding event arrival (this hook's
 *   `activeRepoChanged`, and — via the exported `nextSeq`/`claimSeq` helpers —
 *   Push's `pushPanelInit`) stamps a monotonic seq at ARRIVAL. Application is
 *   claim-gated (`applyAt`/`claimSeq`): an event applies ONLY if its seq is
 *   strictly greater than the last-applied seq, so the LAST-ARRIVED event wins
 *   regardless of which deferred queue drains first. Single-queue callers
 *   (Rollback/Conflicts) are unaffected: their pending stash always holds the
 *   latest arrival, whose seq strictly exceeds lastApplied → claim always
 *   succeeds. The gate only changes behavior when TWO independent deferred
 *   sources compete (Push's case). `bindRepo`/`setRepo` are NOT seq-gated
 *   because they are imperative setters, not events.
 *
 * The explicit `repoId` in each request is the guarantee; the ambient
 * `setRepoContext` call (driven synchronously here) keeps the bridge's existing
 * generation/stale-drop working for requests issued via `onFollow`.
 */
export function useRepoBoundOperation(
  busy: boolean,
  onFollow: (repoId: string | null) => void | Promise<void>,
): {
  repoId: string | null;
  repoName: string;
  request: <T = unknown>(
    cmd: CommandType,
    params?: object,
    opts?: RequestOptions,
  ) => Promise<T>;
  bindRepo: (repoId: string | null, repoName?: string) => void;
  /**
   * Allocate the next monotonic seq number, for a panel that competes on the
   * SAME latest-wins ordering as this hook's `activeRepoChanged` (Push's
   * `pushPanelInit`). The caller stamps the returned seq at ARRIVAL, then asks
   * `claimSeq` whether it may apply. Exported so the two deferred-repo queues
   * agree on which event arrived last, regardless of drain order.
   */
  nextSeq: () => number;
  /**
   * Claim a seq for application. Returns true iff `seq` is strictly greater
   * than the last-applied seq (and, as a side effect, records it as applied).
   * This is the latest-wins gate: a stale event whose seq has already been
   * overtaken is rejected, so it cannot override a newer binding.
   */
  claimSeq: (seq: number) => boolean;
} {
  const busyRef = useRef(busy);
  const onFollowRef = useRef(onFollow);
  // Shared monotonic sequence counter for ALL binding events that can switch
  // this hook's repo — this hook's own `activeRepoChanged` AND Push's
  // `pushPanelInit` (via the exported nextSeq/claimSeq helpers). Every arrival
  // stamps ++seqRef.current, so whichever event arrives LAST has the highest
  // seq and wins application regardless of which deferred queue drains first.
  // Single-queue callers (Rollback/Conflicts) are unaffected: their pending
  // stash always holds the latest arrival, whose seq strictly exceeds
  // lastAppliedSeqRef, so their claim always succeeds (no behavior change).
  const seqRef = useRef(0);
  // The highest seq that has been ALLOWED to apply so far. `applyAt` and
  // `claimSeq` both gate on `seq > lastAppliedSeqRef.current` so a stale event
  // (lower seq) is skipped once a newer one has applied.
  const lastAppliedSeqRef = useRef(0);
  // undefined sentinel = no pending event; a { seq, id, name } object = a
  // pending (possibly null) repo. The pending repo's id and label travel
  // together so a deferred switch can never apply a new id with a stale name.
  // `seq` is stamped at arrival so the drain can re-run the latest-wins gate.
  const pendingRepoRef = useRef<PendingRepo | undefined>(undefined);

  const [repoId, setRepoId] = useState<string | null>(() => {
    const el = document.getElementById("root");
    const ds = el?.dataset.repoId;
    return ds && ds.length > 0 ? ds : null;
  });
  const repoRef = useRef<string | null>(repoId);
  const [repoName, setRepoName] = useState<string>(
    () => document.getElementById("root")?.dataset.repoName?.trim() ?? "",
  );
  const repoNameRef = useRef<string>(repoName);

  busyRef.current = busy;
  onFollowRef.current = onFollow;

  const setRepo = useCallback((id: string | null, name: string = "") => {
    // Short-circuit only when BOTH id and name are unchanged: a reposChanged
    // pass can shift the active repo's disambiguated label without changing
    // its id, and we must still update the header in that case.
    if (id === repoRef.current && name === repoNameRef.current) return;
    repoRef.current = id;
    repoNameRef.current = name;
    // Bump generation synchronously BEFORE onFollow's requests can fire, so
    // any in-flight request from the previous repo is stale-dropped.
    bridge.setRepoContext(id);
    setRepoId(id);
    setRepoName(name);
  }, []);

  const applyAt = useCallback(
    async (seq: number, id: string | null, name: string) => {
      // Latest-wins gate: skip if a newer binding event already applied. This
      // makes the two deferred queues (this hook's activeRepoChanged + Push's
      // pushPanelInit) agree on the last-arrived event regardless of which
      // drains first. `>` (strict) is correct: an event may never re-apply at
      // its own seq, and equal seqs only arise for the same event.
      if (seq <= lastAppliedSeqRef.current) return;
      lastAppliedSeqRef.current = seq;
      try {
        setRepo(id, name);
        await onFollowRef.current(id);
      } catch (e) {
        console.error("useRepoBoundOperation applyAt failed:", e);
      }
    },
    [setRepo],
  );

  const request = useCallback(
    <T = unknown>(
      cmd: CommandType,
      params: object = {},
      opts: RequestOptions = {},
    ): Promise<T> => {
      return bridge.request(cmd, params as Record<string, unknown>, {
        repoId: repoRef.current ?? undefined,
        ...opts,
      }) as Promise<T>;
    },
    [],
  );

  const bindRepo = useCallback(
    (id: string | null, name: string = "") => {
      // NOTE: intentionally NOT seq-gated. `bindRepo` is the imperative rebind
      // the panel calls from its own applyReInit (which is itself seq-gated via
      // claimSeq before reaching here). Gating it here would double-gate the
      // Push path and, worse, would silently no-op a direct programmatic
      // rebind that has no competing event. The seq gate lives at the EVENT
      // boundary (applyAt / claimSeq), not at the imperative setter.
      setRepo(id, name);
    },
    [setRepo],
  );

  // Allocate the next monotonic seq. Used by Push's pushPanelInit arrival so
  // its re-init competes on the SAME ordering as this hook's activeRepoChanged.
  const nextSeq = useCallback(() => ++seqRef.current, []);

  // Claim a seq for application (latest-wins gate). Returns false if a newer
  // event already applied, in which case the caller MUST skip. Used by Push's
  // applyReInit so a stale re-init (superseded by a newer activeRepoChanged)
  // cannot override the newer repo's branch/remote.
  const claimSeq = useCallback((seq: number) => {
    if (seq <= lastAppliedSeqRef.current) return false;
    lastAppliedSeqRef.current = seq;
    return true;
  }, []);

  // Idle-follow: subscribe to activeRepoChanged once. The event carries the
  // disambiguated `repoName` (host computes it via formatRepoLabel) so the
  // header label updates in lockstep with repoId, not just on panel re-open.
  // Each arrival stamps a fresh seq so it can win (or lose) the latest-wins
  // race against Push's pushPanelInit on the shared counter.
  useEffect(() => {
    return bridge.onEvent((event, data) => {
      if (event !== "activeRepoChanged") return;
      const payload = data as {
        repo: { id: string } | null;
        repoName?: string;
      };
      const id = payload.repo?.id ?? null;
      const name = payload.repoName ?? "";
      const seq = ++seqRef.current;
      if (busyRef.current) {
        pendingRepoRef.current = { seq, id, name };
      } else {
        void applyAt(seq, id, name);
      }
    });
  }, [applyAt]);

  // When busy flips false, apply the latest pending repo (seq + id + name
  // together). Re-runs the latest-wins gate via applyAt so a pending event
  // whose seq was overtaken by a Push re-init that already applied is skipped.
  useEffect(() => {
    if (busy || pendingRepoRef.current === undefined) return;
    const { seq, id, name } = pendingRepoRef.current;
    pendingRepoRef.current = undefined;
    void applyAt(seq, id, name);
  }, [busy, applyAt]);

  return { repoId, repoName, request, bindRepo, nextSeq, claimSeq };
}
