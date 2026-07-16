import type {
  Bridge,
  EventMessage,
  RequestMessage,
  ResponseMessage,
} from "./types";

declare function acquireVsCodeApi(): {
  postMessage(msg: unknown): void;
  getState(): unknown;
  setState(state: unknown): void;
};

export function createVSCodeBridge(): Bridge {
  const vscode = acquireVsCodeApi();
  const pendingRequests = new Map<
    string,
    {
      resolve: (v: unknown) => void;
      reject: (e: Error) => void;
      gen: number | null;
    }
  >();
  const eventHandlers = new Set<(event: string, data: unknown) => void>();
  let currentRepoId: string | null = null;
  let generation = 0;

  class BridgeRequestError extends Error {
    readonly code: string;
    constructor(code: string, message: string) {
      super(message);
      this.code = code;
      this.name = "BridgeRequestError";
    }
  }

  window.addEventListener("message", (e: MessageEvent) => {
    const msg = e.data;
    if (msg.type === "response") {
      const resp = msg as ResponseMessage;
      const pending = pendingRequests.get(resp.id);
      if (pending) {
        pendingRequests.delete(resp.id);
        if (pending.gen !== null && pending.gen !== generation) {
          pending.reject(
            new BridgeRequestError(
              "STALE_RESPONSE",
              "stale response: repo context changed",
            ),
          );
          return;
        }
        if (resp.success) {
          pending.resolve(resp.data);
        } else {
          pending.reject(
            new BridgeRequestError(
              resp.error?.code ?? "UNKNOWN",
              resp.error?.message ?? "Unknown error",
            ),
          );
        }
      }
    } else if (msg.type === "event") {
      const evt = msg as EventMessage;
      for (const h of eventHandlers) {
        h(evt.event, evt.data);
      }
    }
  });

  return {
    request(command, params = {}, options = {}) {
      return new Promise((resolve, reject) => {
        const id = crypto.randomUUID();
        const globalRequest = options.scope === "global";
        const myGen = globalRequest ? null : generation;
        // Explicit per-request repoId overrides the ambient context. This is the
        // guarantee layer: operation panels stamp every request with the repo
        // the UI is showing, so it can never diverge from ambient state.
        const effectiveRepo =
          options.repoId !== undefined ? options.repoId : currentRepoId;
        const timeout = setTimeout(() => {
          pendingRequests.delete(id);
          reject(new Error(`Request '${command}' timed out`));
        }, 10_000);

        pendingRequests.set(id, {
          gen: myGen,
          resolve: (v) => {
            clearTimeout(timeout);
            resolve(v);
          },
          reject: (e) => {
            clearTimeout(timeout);
            reject(e);
          },
        });

        const msg: RequestMessage = {
          type: "request",
          id,
          command,
          params,
          ...(!globalRequest && effectiveRepo ? { repoId: effectiveRepo } : {}),
        };
        vscode.postMessage(msg);
      });
    },
    onEvent(handler) {
      eventHandlers.add(handler);
      return () => {
        eventHandlers.delete(handler);
      };
    },
    setRepoContext(repoId) {
      if (currentRepoId === repoId) return;
      currentRepoId = repoId;
      generation += 1;
      for (const [id, pending] of pendingRequests) {
        if (pending.gen !== null && pending.gen !== generation) {
          pendingRequests.delete(id);
          pending.reject(
            new BridgeRequestError(
              "STALE_RESPONSE",
              "stale response: repo context changed",
            ),
          );
        }
      }
    },
  };
}
