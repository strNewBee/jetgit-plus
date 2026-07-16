import type { Bridge, CommandType } from "./types";
import { createVSCodeBridge } from "./vscode-bridge";

export const bridge: Bridge = createVSCodeBridge();

/**
 * Execute a bridge request with a progress indicator.
 *
 * Marks the operation in-flight for the ACTIVE repo via panel-store's per-repo
 * tracker (not a blunt boolean), so an op issued from the panel only disables
 * the UI when it targets the visible repo — consistent with host-broadcast
 * `operationStart/End` events. Five commands routed here (createBranch,
 * deleteBranch, checkoutCommit, revertFileChanges, cherryPickFileChanges) are
 * NOT host-wrapped in `withProgress`, so this client-side marker is the only
 * progress signal for them; for the rest it composes idempotently with the host
 * events.
 *
 * Minimum display time of 1s to ensure the animation is visible.
 */
export async function bridgeWithProgress(
  command: CommandType,
  params?: Record<string, unknown>,
): Promise<unknown> {
  const { useRepoStore } = await import("../store/repo-store");
  const { _beginClientOperation, _endClientOperation } = await import(
    "../store/panel-store"
  );
  const repoId = useRepoStore.getState().activeRepoId;
  _beginClientOperation(repoId);
  const start = Date.now();
  try {
    const result = await bridge.request(command, params);
    const elapsed = Date.now() - start;
    if (elapsed < 1000) {
      await new Promise((r) => setTimeout(r, 1000 - elapsed));
    }
    return result;
  } finally {
    _endClientOperation(repoId);
  }
}

export type {
  Bridge,
  BridgeRequestOptions,
  EventMessage,
  RequestMessage,
  RequestOptions,
  ResponseMessage,
} from "./types";
