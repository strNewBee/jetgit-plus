import { useCallback, useEffect, useRef, useState } from "react";
import { bridge } from "../bridge";
import type { CommandType, RequestOptions } from "../bridge/types";

/** A pending deferred repo: its id AND its disambiguated label land together. */
interface PendingRepo {
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
 *   state stay in lockstep.
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
} {
  const busyRef = useRef(busy);
  const onFollowRef = useRef(onFollow);
  // undefined sentinel = no pending event; a { id, name } object = a pending
  // (possibly null) repo. The pending repo's id and label travel together so a
  // deferred switch can never apply a new id with a stale name.
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

  const apply = useCallback(
    async (id: string | null, name: string) => {
      try {
        setRepo(id, name);
        await onFollowRef.current(id);
      } catch (e) {
        console.error("useRepoBoundOperation apply failed:", e);
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
      setRepo(id, name);
    },
    [setRepo],
  );

  // Idle-follow: subscribe to activeRepoChanged once. The event carries the
  // disambiguated `repoName` (host computes it via formatRepoLabel) so the
  // header label updates in lockstep with repoId, not just on panel re-open.
  useEffect(() => {
    return bridge.onEvent((event, data) => {
      if (event !== "activeRepoChanged") return;
      const payload = data as {
        repo: { id: string } | null;
        repoName?: string;
      };
      const id = payload.repo?.id ?? null;
      const name = payload.repoName ?? "";
      if (busyRef.current) {
        pendingRepoRef.current = { id, name };
      } else {
        void apply(id, name);
      }
    });
  }, [apply]);

  // When busy flips false, apply the latest pending repo (id + name together).
  useEffect(() => {
    if (busy || pendingRepoRef.current === undefined) return;
    const { id, name } = pendingRepoRef.current;
    pendingRepoRef.current = undefined;
    void apply(id, name);
  }, [busy, apply]);

  return { repoId, repoName, request, bindRepo };
}
