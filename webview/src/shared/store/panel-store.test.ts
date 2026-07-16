import { beforeEach, describe, expect, it, vi } from "vitest";

// Capture the event handler registered by panel-store at import time so the
// test can dispatch events into it. panel-store calls bridge.onEvent(cb) once
// at module load.
let panelEventHandler: ((event: string, data: unknown) => void) | null = null;

vi.mock("../bridge", () => ({
  bridge: {
    request: vi.fn().mockResolvedValue({ commits: [], lanes: {} }),
    onEvent: vi.fn((cb: (event: string, data: unknown) => void) => {
      panelEventHandler = cb;
      return () => {};
    }),
    setRepoContext: vi.fn(),
  },
}));

// Import after the mock is installed so the module-load onEvent call is captured.
const {
  usePanelStore,
  _resetOperationProgressForTests,
  _beginClientOperation,
  _endClientOperation,
} = await import("./panel-store");
const { useRepoStore } = await import("./repo-store");

function emit(event: string, data: unknown): void {
  if (!panelEventHandler) {
    throw new Error("panel event handler was never registered");
  }
  panelEventHandler(event, data);
}

describe("panel-store operationInProgress per-repo filter", () => {
  beforeEach(() => {
    _resetOperationProgressForTests();
    usePanelStore.setState({ operationInProgress: false });
    useRepoStore.setState({ activeRepoId: null });
  });

  it("an operationStart on the active repo sets operationInProgress", () => {
    useRepoStore.setState({ activeRepoId: "A" });
    emit("operationStart", { repoId: "A" });
    expect(usePanelStore.getState().operationInProgress).toBe(true);
  });

  it("an operationStart on a different repo does NOT set operationInProgress", () => {
    useRepoStore.setState({ activeRepoId: "A" });
    emit("operationStart", { repoId: "B" });
    expect(usePanelStore.getState().operationInProgress).toBe(false);
  });

  it("operationEnd on the active repo's op clears operationInProgress", () => {
    useRepoStore.setState({ activeRepoId: "A" });
    emit("operationStart", { repoId: "A" });
    expect(usePanelStore.getState().operationInProgress).toBe(true);
    emit("operationEnd", { repoId: "A" });
    expect(usePanelStore.getState().operationInProgress).toBe(false);
  });

  it("operationEnd on a non-active repo does not flip a false state", () => {
    useRepoStore.setState({ activeRepoId: "A" });
    emit("operationStart", { repoId: "B" }); // active repo A unaffected
    expect(usePanelStore.getState().operationInProgress).toBe(false);
    emit("operationEnd", { repoId: "B" });
    expect(usePanelStore.getState().operationInProgress).toBe(false);
  });

  it("switching to a repo with an in-flight op re-derives busy=true", () => {
    useRepoStore.setState({ activeRepoId: "A" });
    emit("operationStart", { repoId: "B" }); // B op starts while A visible
    expect(usePanelStore.getState().operationInProgress).toBe(false);
    // User switches to B — the in-flight B op should now show as in-progress.
    useRepoStore.setState({ activeRepoId: "B" });
    emit("activeRepoChanged", { repo: { id: "B" } });
    expect(usePanelStore.getState().operationInProgress).toBe(true);
  });

  it("switching away from a busy repo clears busy when the new repo has no op", () => {
    useRepoStore.setState({ activeRepoId: "A" });
    emit("operationStart", { repoId: "A" });
    expect(usePanelStore.getState().operationInProgress).toBe(true);
    useRepoStore.setState({ activeRepoId: "B" });
    emit("activeRepoChanged", { repo: { id: "B" } });
    expect(usePanelStore.getState().operationInProgress).toBe(false);
  });

  it("ignores an operationStart with repoId:null (non-repo-bound op)", () => {
    useRepoStore.setState({ activeRepoId: "A" });
    emit("operationStart", { repoId: null });
    expect(usePanelStore.getState().operationInProgress).toBe(false);
  });

  it("tracks multiple concurrent in-flight ops across repos", () => {
    useRepoStore.setState({ activeRepoId: "A" });
    emit("operationStart", { repoId: "A" });
    emit("operationStart", { repoId: "B" });
    expect(usePanelStore.getState().operationInProgress).toBe(true); // A in flight
    emit("operationEnd", { repoId: "A" });
    expect(usePanelStore.getState().operationInProgress).toBe(false); // only B left
    useRepoStore.setState({ activeRepoId: "B" });
    emit("activeRepoChanged", { repo: { id: "B" } });
    expect(usePanelStore.getState().operationInProgress).toBe(true); // B in flight
  });
});

describe("panel-store client-side operation markers (bridgeWithProgress)", () => {
  beforeEach(() => {
    _resetOperationProgressForTests();
    usePanelStore.setState({ operationInProgress: false });
    useRepoStore.setState({ activeRepoId: null });
  });

  it("_beginClientOperation on the active repo sets operationInProgress", () => {
    useRepoStore.setState({ activeRepoId: "A" });
    _beginClientOperation("A");
    expect(usePanelStore.getState().operationInProgress).toBe(true);
  });

  it("_beginClientOperation on a non-active repo does NOT set operationInProgress", () => {
    useRepoStore.setState({ activeRepoId: "A" });
    _beginClientOperation("B");
    expect(usePanelStore.getState().operationInProgress).toBe(false);
    // the marker is tracked, so switching to B re-derives busy (without re-adding)
    useRepoStore.setState({ activeRepoId: "B" });
    emit("activeRepoChanged", { repo: { id: "B" } });
    expect(usePanelStore.getState().operationInProgress).toBe(true);
  });

  it("_endClientOperation clears the active repo's op", () => {
    useRepoStore.setState({ activeRepoId: "A" });
    _beginClientOperation("A");
    expect(usePanelStore.getState().operationInProgress).toBe(true);
    _endClientOperation("A");
    expect(usePanelStore.getState().operationInProgress).toBe(false);
  });

  it("a null client op (no active repo) is a no-op", () => {
    useRepoStore.setState({ activeRepoId: null });
    _beginClientOperation(null);
    expect(usePanelStore.getState().operationInProgress).toBe(false);
    _endClientOperation(null);
    expect(usePanelStore.getState().operationInProgress).toBe(false);
  });

  it("host events and client markers compose for the same repo", () => {
    useRepoStore.setState({ activeRepoId: "A" });
    _beginClientOperation("A"); // client-side marker (e.g. createBranch)
    emit("operationStart", { repoId: "A" }); // host also tags (e.g. via fetch)
    expect(usePanelStore.getState().operationInProgress).toBe(true);
    _endClientOperation("A"); // client done, but host op still in flight
    expect(usePanelStore.getState().operationInProgress).toBe(true);
    emit("operationEnd", { repoId: "A" }); // now fully clear
    expect(usePanelStore.getState().operationInProgress).toBe(false);
  });
});
