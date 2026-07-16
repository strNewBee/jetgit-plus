import type { Bridge, CommandType } from "./types";
import { createVSCodeBridge } from "./vscode-bridge";

export const bridge: Bridge = createVSCodeBridge();

/**
 * Execute a bridge request with progress indicator.
 * Sets operationInProgress=true immediately, resets on completion.
 * Minimum display time of 1s to ensure the animation is visible.
 */
export async function bridgeWithProgress(
  command: CommandType,
  params?: Record<string, unknown>,
): Promise<unknown> {
  const { usePanelStore } = await import("../store/panel-store");
  usePanelStore.setState({ operationInProgress: true });
  const start = Date.now();
  try {
    const result = await bridge.request(command, params);
    const elapsed = Date.now() - start;
    if (elapsed < 1000) {
      await new Promise((r) => setTimeout(r, 1000 - elapsed));
    }
    return result;
  } finally {
    usePanelStore.setState({ operationInProgress: false });
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
