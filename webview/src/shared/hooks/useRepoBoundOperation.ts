import { useCallback, useEffect, useRef, useState } from "react";
import { bridge } from "../bridge";
import type { CommandType, RequestOptions } from "../bridge/types";

/**
 * Authoritative repo-bound operation hook for Push / Rollback / Conflicts
 * panels. Replaces `useOperationRepoBinding` for these panels by exposing the
 * authoritative `repoId` the panel renders, a bound `request()` that stamps
 * every call with that repoId (the correctness guarantee), and a `bindRepo()`
 * setter the panel uses on host-driven re-init.
 *
 * Lifecycle:
 * - `repoId` is seeded from `#root[data-repo-id]` (the host's create-time
 *   payload) so the very first render is correct before any event lands.
 * - `setRepo(id)` updates the ref, calls `bridge.setRepoContext(id)`
 *   SYNCHRONOUSLY (so the generation bumps and stale-drop still works for the
 *   bound request before `onFollow`'s own requests fire), then flushes state.
 * - Idle follow: an `activeRepoChanged` event while not busy switches the repo
 *   and calls `onFollow`. While busy, the latest pending repo is deferred and
 *   applied when `busy` flips false (an `undefined` sentinel distinguishes
 *   "no pending event" from "pending null").
 * - `bindRepo(id)` is the re-init entry point used by the panel's host-message
 *   listener; it routes through the same `setRepo` so context + state stay in
 *   lockstep.
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
  request: <T = unknown>(
    cmd: string,
    params?: object,
    opts?: RequestOptions,
  ) => Promise<T>;
  bindRepo: (repoId: string | null) => void;
} {
  const busyRef = useRef(busy);
  const onFollowRef = useRef(onFollow);
  // undefined sentinel = no pending event; null = a pending deselection.
  const pendingRepoRef = useRef<string | null | undefined>(undefined);

  const [repoId, setRepoId] = useState<string | null>(() => {
    const el = document.getElementById("root");
    const ds = el?.dataset.repoId;
    return ds && ds.length > 0 ? ds : null;
  });
  const repoRef = useRef<string | null>(repoId);

  busyRef.current = busy;
  onFollowRef.current = onFollow;

  const setRepo = useCallback((id: string | null) => {
    if (id === repoRef.current) return;
    repoRef.current = id;
    // Bump generation synchronously BEFORE onFollow's requests can fire, so
    // any in-flight request from the previous repo is stale-dropped.
    bridge.setRepoContext(id);
    setRepoId(id);
  }, []);

  const apply = useCallback(
    async (id: string | null) => {
      try {
        setRepo(id);
        await onFollowRef.current(id);
      } catch (e) {
        console.error("useRepoBoundOperation apply failed:", e);
      }
    },
    [setRepo],
  );

  const request = useCallback(
    <T = unknown>(
      cmd: string,
      params: object = {},
      opts: RequestOptions = {},
    ): Promise<T> => {
      return bridge.request(
        cmd as CommandType,
        params as Record<string, unknown>,
        {
          repoId: repoRef.current ?? undefined,
          ...opts,
        },
      ) as Promise<T>;
    },
    [],
  );

  const bindRepo = useCallback(
    (id: string | null) => {
      setRepo(id);
    },
    [setRepo],
  );

  // Idle-follow: subscribe to activeRepoChanged once.
  useEffect(() => {
    return bridge.onEvent((event, data) => {
      if (event !== "activeRepoChanged") return;
      const id = (data as { repo: { id: string } | null }).repo?.id ?? null;
      if (busyRef.current) {
        pendingRepoRef.current = id;
      } else {
        void apply(id);
      }
    });
  }, [apply]);

  // When busy flips false, apply the latest pending repo (if any).
  useEffect(() => {
    if (busy || pendingRepoRef.current === undefined) return;
    const id = pendingRepoRef.current;
    pendingRepoRef.current = undefined;
    void apply(id);
  }, [busy, apply]);

  return { repoId, request, bindRepo };
}
