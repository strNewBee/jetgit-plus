import { beforeEach, describe, expect, it } from "vitest";
import { createVSCodeBridge } from "./vscode-bridge";

function installAcquire(postMessage: (m: unknown) => void) {
  (globalThis as unknown as { acquireVsCodeApi: unknown }).acquireVsCodeApi =
    () => ({
      postMessage,
      getState: () => ({}),
      setState: () => {},
    });
}

describe("bridge repo context + stale drop", () => {
  beforeEach(() => {
    installAcquire(() => {});
  });

  it("attaches current repoId to requests", () => {
    const posted: unknown[] = [];
    installAcquire((m) => posted.push(m));
    const bridge = createVSCodeBridge();
    bridge.setRepoContext("/r1");
    void bridge.request("getBranches");
    expect((posted[0] as { repoId?: string }).repoId).toBe("/r1");
  });

  it("a per-request repoId overrides the ambient context", () => {
    const posted: unknown[] = [];
    installAcquire((m) => posted.push(m));
    const bridge = createVSCodeBridge();
    bridge.setRepoContext("A");
    // Explicit override wins over ambient "A".
    void bridge.request("getX", {}, { repoId: "B" });
    // A plain request with no override uses ambient "A".
    void bridge.request("getX");
    expect((posted[0] as { repoId?: string }).repoId).toBe("B");
    expect((posted[1] as { repoId?: string }).repoId).toBe("A");
  });

  it("drops responses whose generation is stale", async () => {
    const posted: unknown[] = [];
    let deliver: ((m: unknown) => void) | null = null;
    installAcquire((m) => posted.push(m));
    // Capture the window 'message' listener so we can synthesize responses.
    const origAdd = window.addEventListener;
    window.addEventListener = ((
      type: string,
      cb: (e: MessageEvent) => void,
    ) => {
      if (type === "message")
        deliver = (m: unknown) => cb({ data: m } as MessageEvent);
    }) as typeof window.addEventListener;

    const bridge = createVSCodeBridge();
    const p = bridge.request("getBranches");
    const id = (
      posted.find((m) => (m as { type?: string }).type === "request") as {
        id: string;
      }
    ).id;
    bridge.setRepoContext("/r2"); // bump generation → previous request is now stale
    deliver!({ type: "response", id, success: true, data: [] });

    await expect(p).rejects.toThrow(/stale/i);
    window.addEventListener = origAdd;
  });

  it("preserves host error codes", async () => {
    const posted: any[] = [];
    let deliver!: (m: unknown) => void;
    installAcquire((m) => posted.push(m));
    const origAdd = window.addEventListener;
    window.addEventListener = ((
      type: string,
      cb: (e: MessageEvent) => void,
    ) => {
      if (type === "message") deliver = (m) => cb({ data: m } as MessageEvent);
    }) as typeof window.addEventListener;
    const bridge = createVSCodeBridge();
    bridge.setRepoContext("/r");
    const request = bridge.request("commitChanges");
    deliver({
      type: "response",
      id: posted[0].id,
      success: false,
      error: { code: "REPO_NOT_FOUND", message: "missing" },
    });
    await expect(request).rejects.toMatchObject({ code: "REPO_NOT_FOUND" });
    window.addEventListener = origAdd;
  });

  it("keeps a global selectRepo request alive across its own context event", async () => {
    const posted: any[] = [];
    let deliver!: (m: unknown) => void;
    installAcquire((m) => posted.push(m));
    const origAdd = window.addEventListener;
    window.addEventListener = ((
      type: string,
      cb: (e: MessageEvent) => void,
    ) => {
      if (type === "message") deliver = (m) => cb({ data: m } as MessageEvent);
    }) as typeof window.addEventListener;
    const bridge = createVSCodeBridge();
    bridge.setRepoContext("/r1");
    const request = bridge.request(
      "selectRepo",
      { repoId: "/r2" },
      { scope: "global" },
    );
    expect(posted[0].repoId).toBeUndefined();
    bridge.setRepoContext("/r2");
    deliver({
      type: "response",
      id: posted[0].id,
      success: true,
      data: { activeId: "/r2" },
    });
    await expect(request).resolves.toMatchObject({ activeId: "/r2" });
    window.addEventListener = origAdd;
  });
});
