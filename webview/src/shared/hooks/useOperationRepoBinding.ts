import { useCallback, useEffect, useRef } from "react";
import { bridge } from "../bridge";

/**
 * Idle-follow / execution-bound repo lifecycle hook for operation webviews
 * (Push / Rollback / Conflicts).
 *
 * - When `busy` is false: every `activeRepoChanged` event immediately switches
 *   the bridge's repo context and calls `onFollow`.
 * - When `busy` is true: incoming repo changes are deferred. Only the latest
 *   pending repo is remembered; it is applied once `busy` flips back to false.
 *
 * Merge panels intentionally do NOT use this hook — they stay bound to the
 * repo they were opened with for their entire lifetime.
 */
export function useOperationRepoBinding(
  busy: boolean,
  onFollow: (repoId: string | null) => void | Promise<void>,
): void {
  const busyRef = useRef(busy);
  const onFollowRef = useRef(onFollow);
  const pendingRepoRef = useRef<string | null | undefined>(undefined);
  busyRef.current = busy;
  onFollowRef.current = onFollow;

  const apply = useCallback(async (repoId: string | null) => {
    bridge.setRepoContext(repoId);
    await onFollowRef.current(repoId);
  }, []);

  useEffect(() => {
    return bridge.onEvent((event, data) => {
      if (event !== "activeRepoChanged") return;
      const repoId = (data as { repo: { id: string } | null }).repo?.id ?? null;
      if (busyRef.current) {
        pendingRepoRef.current = repoId;
      } else {
        void apply(repoId);
      }
    });
  }, [apply]);

  useEffect(() => {
    if (busy || pendingRepoRef.current === undefined) return;
    const repoId = pendingRepoRef.current;
    pendingRepoRef.current = undefined;
    void apply(repoId);
  }, [busy, apply]);
}
