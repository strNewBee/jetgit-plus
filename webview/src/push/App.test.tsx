import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Push panel re-init binding + remote-key tests.
 *
 * The panel is reused across repos (host calls reveal() + posts a `pushPanelInit`
 * event instead of recreating the webview). These tests assert the correctness
 * invariants at the bridge-message level — which is what matters for routing —
 * rather than the rendered DOM:
 *
 * (a) a `pushPanelInit{repoId:"B",...}` event while idle calls `bindRepo("B")`
 *     (observed as a `setRepoContext("B")` bump) AND the next repo-bound
 *     request the panel issues carries repoId "B".
 * (b) the remote key: a re-init with `remote:"up"` results in the push target
 *     remote being "up" (not the old "origin" fallback from the key mismatch).
 *
 * The icon virtual modules (`~icons/...`) are not registered under vitest, so
 * they are stubbed. The bridge singleton is mocked so we can capture requests
 * and emit events via the captured `onEvent` listener.
 */
const mocks = vi.hoisted(() => {
  const eventListener: {
    current: ((event: string, data: unknown) => void) | null;
  } = { current: null };
  const setRepoContext = vi.fn();
  // Per-command responder so tests can return canned getBranches / getAheadCommits
  // payloads. Default resolves undefined.
  const responders: Record<string, (params: object) => unknown> = {};
  const request = vi.fn(
    (
      command: string,
      params: object = {},
      _options?: { scope?: string; repoId?: string },
    ) => {
      const r = responders[command];
      return Promise.resolve(r ? r(params) : undefined);
    },
  );
  const onEvent = vi.fn(
    (handler: (event: string, data: unknown) => void): (() => void) => {
      eventListener.current = handler;
      return () => {
        if (eventListener.current === handler) eventListener.current = null;
      };
    },
  );
  return { setRepoContext, request, onEvent, eventListener, responders };
});

vi.mock("../shared/bridge", () => ({
  bridge: {
    setRepoContext: mocks.setRepoContext,
    request: mocks.request,
    onEvent: mocks.onEvent,
  },
}));

import { PushApp } from "./App";

const { setRepoContext, request, onEvent, eventListener, responders } = mocks;

function emit(event: string, data: unknown) {
  eventListener.current?.(event, data);
}

/** Set (or clear) host-supplied seed attributes on #root. */
function seedRoot(attrs: {
  repoId?: string;
  branch?: string;
  remote?: string;
  repoName?: string;
}) {
  let root = document.getElementById("root");
  if (!root) {
    root = document.createElement("div");
    root.id = "root";
    document.body.appendChild(root);
  }
  delete root.dataset.repoId;
  delete root.dataset.branch;
  delete root.dataset.remote;
  delete root.dataset.repoName;
  if (attrs.repoId !== undefined) root.dataset.repoId = attrs.repoId;
  if (attrs.branch !== undefined) root.dataset.branch = attrs.branch;
  if (attrs.remote !== undefined) root.dataset.remote = attrs.remote;
  if (attrs.repoName !== undefined) root.dataset.repoName = attrs.repoName;
}

/** Last call to `bridge.request` for a given command, or undefined. */
function lastCall(command: string) {
  const calls = request.mock.calls.filter((c) => c[0] === command);
  return calls.length ? calls[calls.length - 1] : undefined;
}

describe("PushApp re-init binding", () => {
  beforeEach(() => {
    setRepoContext.mockReset();
    request.mockClear();
    onEvent.mockClear();
    eventListener.current = null;
    for (const k of Object.keys(responders)) delete responders[k];
  });
  afterEach(() => {
    cleanup();
    eventListener.current = null;
  });

  it("a pushPanelInit{repoId:'B'} re-init while idle rebinds so the next repo-bound request carries repoId 'B'", async () => {
    // Seed create-time state for repo A.
    seedRoot({ repoId: "A", branch: "main", remote: "origin" });
    // On re-init the panel reloads branches (loadRepo path is NOT triggered by
    // pushPanelInit — it re-derives from the payload directly and calls
    // getAheadCommits). Provide a canned response so the panel settles.
    responders.getAheadCommits = () => ({ commits: [] });

    render(<PushApp />);

    // Initial mount: the create-time branch is non-empty, so the initial-load
    // effect fires getAheadCommits for "main"/"origin" bound to repo A.
    await waitFor(() => {
      expect(lastCall("getAheadCommits")).toBeTruthy();
    });
    expect(lastCall("getAheadCommits")?.[2]).toMatchObject({ repoId: "A" });

    // Re-init to repo B while idle.
    emit("pushPanelInit", { repoId: "B", branchName: "feature", remote: "up" });

    // bindRepo("B") bumps bridge context synchronously.
    await waitFor(() => {
      expect(setRepoContext).toHaveBeenCalledWith("B");
    });

    // The re-init's own getAheadCommits (for feature/up) is now bound to B.
    await waitFor(() => {
      const ahead = lastCall("getAheadCommits");
      expect(ahead).toBeTruthy();
      expect(ahead?.[1]).toMatchObject({ branchName: "feature", remote: "up" });
      expect(ahead?.[2]).toMatchObject({ repoId: "B" });
    });
  });

  it("the remote key: a re-init with remote:'up' makes the push target remote 'up' (not 'origin')", async () => {
    seedRoot({ repoId: "A", branch: "main", remote: "origin" });
    responders.getAheadCommits = () => ({ commits: [] });
    // executePush resolves success with no isUpToDate → panel closes.
    responders.executePush = () => ({ data: {} });

    render(<PushApp />);

    // Re-init with remote:"up" (the previously-broken key). Frontend must read
    // payload.remote (not payload.remoteName, which is now never sent).
    emit("pushPanelInit", { repoId: "A", branchName: "main", remote: "up" });

    await waitFor(() => {
      const ahead = lastCall("getAheadCommits");
      expect(ahead?.[1]).toMatchObject({ remote: "up" });
    });

    // Click the Push button → executePush must target remote "up".
    const pushBtn = document.querySelector(
      ".push-split-main",
    ) as HTMLButtonElement;
    expect(pushBtn).toBeTruthy();
    // The button is disabled while commits.length === 0; supply a commit so the
    // button enables and the push fires executePush with the chosen remote.
    // Include `refs` (CommitInfo reads commit.refs.filter on selection).
    responders.getAheadCommits = () => ({
      commits: [{ hash: "h1", subject: "s", refs: [] }],
    });
    emit("pushPanelInit", { repoId: "A", branchName: "main", remote: "up" });

    await waitFor(() => {
      expect(
        (document.querySelector(".push-split-main") as HTMLButtonElement)
          .disabled,
      ).toBe(false);
    });

    request.mockClear();
    pushBtn.click();

    await waitFor(() => {
      const push = lastCall("executePush");
      expect(push).toBeTruthy();
      expect(push?.[1]).toMatchObject({ remote: "up" });
    });
  });
});

describe("PushApp header repo label (Task 25)", () => {
  beforeEach(() => {
    setRepoContext.mockReset();
    request.mockClear();
    onEvent.mockClear();
    eventListener.current = null;
    for (const k of Object.keys(responders)) delete responders[k];
  });
  afterEach(() => {
    cleanup();
    eventListener.current = null;
  });

  it("renders the seeded data-repo-name in the header", async () => {
    seedRoot({
      repoId: "A",
      branch: "main",
      remote: "origin",
      repoName: "myrepo",
    });
    responders.getAheadCommits = () => ({ commits: [] });

    render(<PushApp />);

    await waitFor(() => {
      expect(
        (document.querySelector(".push-repo-name") as HTMLElement | null)
          ?.textContent,
      ).toBe("myrepo");
    });
  });

  it("updates the header when a pushPanelInit re-init carries repoName", async () => {
    seedRoot({
      repoId: "A",
      branch: "main",
      remote: "origin",
      repoName: "first",
    });
    responders.getAheadCommits = () => ({ commits: [] });

    render(<PushApp />);

    await waitFor(() => {
      expect(
        (document.querySelector(".push-repo-name") as HTMLElement | null)
          ?.textContent,
      ).toBe("first");
    });

    // Re-init to a different repo with a different disambiguated label.
    emit("pushPanelInit", {
      repoId: "B",
      branchName: "main",
      remote: "origin",
      repoName: "other (path/to/other)",
    });

    await waitFor(() => {
      expect(
        (document.querySelector(".push-repo-name") as HTMLElement | null)
          ?.textContent,
      ).toBe("other (path/to/other)");
    });
  });

  it("renders no repo-name badge when the seed is absent", async () => {
    seedRoot({ repoId: "A", branch: "main", remote: "origin" });
    responders.getAheadCommits = () => ({ commits: [] });

    render(<PushApp />);

    await waitFor(() => {
      expect(lastCall("getAheadCommits")).toBeTruthy();
    });
    expect(document.querySelector(".push-repo-name")).toBeNull();
  });
});

/**
 * F2 (P1): re-init during a rejected dialog + recovery repoId pinning.
 *
 * Bug: while repo A's push-rejected dialog was open, a pushPanelInit{repoId:"B"}
 * (panel reuse) immediately rebound the hook to B. The recovery requests then
 * fired through the now-B-bound `request`, targeting B instead of the rejected
 * repo A.
 *
 * Fix: (A) the rejected context now captures repoId, and every recovery request
 * passes it as an explicit override; (B) a re-init received while pushing OR
 * while the rejected dialog is open is DEFERRED until the panel goes idle.
 */
describe("PushApp rejected-dialog re-init deferral (F2)", () => {
  beforeEach(() => {
    setRepoContext.mockReset();
    request.mockClear();
    onEvent.mockClear();
    eventListener.current = null;
    for (const k of Object.keys(responders)) delete responders[k];
  });
  afterEach(() => {
    cleanup();
    eventListener.current = null;
  });

  it("a pushPanelInit{repoId:'B'} during A's rejected dialog does NOT rebind, and recovery pins repoId 'A'", async () => {
    seedRoot({
      repoId: "A",
      branch: "main",
      remote: "origin",
      repoName: "A-name",
    });
    // Supply a commit so the Push button is enabled.
    responders.getAheadCommits = () => ({
      commits: [{ hash: "h1", subject: "s", refs: [] }],
    });
    // executePush rejects with a non-fast-forward message so the dialog shows.
    responders.executePush = () => {
      throw new Error("![rejected] Would be an error");
    };

    render(<PushApp />);

    await waitFor(() => {
      expect(
        (document.querySelector(".push-split-main") as HTMLButtonElement)
          .disabled,
      ).toBe(false);
    });

    // Trigger the rejected push for repo A.
    request.mockClear();
    (document.querySelector(".push-split-main") as HTMLButtonElement).click();

    // The rejected dialog must appear for A.
    await waitFor(() => {
      expect(document.querySelector(".push-rejected-dialog")).toBeTruthy();
    });

    // Sanity: header still reads A-name right after rejection.
    expect(
      (document.querySelector(".push-repo-name") as HTMLElement | null)
        ?.textContent,
    ).toBe("A-name");

    // --- The race: panel reuse posts pushPanelInit{B} while A's dialog is open.
    setRepoContext.mockClear();
    request.mockClear();
    emit("pushPanelInit", {
      repoId: "B",
      repoName: "B-name",
      branchName: "feature",
      remote: "up",
    });

    // The re-init MUST be deferred: no rebind to B while the dialog is open.
    // Give the event a tick to (wrongly) process if it were going to.
    await new Promise((r) => setTimeout(r, 0));
    expect(setRepoContext).not.toHaveBeenCalledWith("B");
    // Header still shows A (not B).
    expect(
      (document.querySelector(".push-repo-name") as HTMLElement | null)
        ?.textContent,
    ).toBe("A-name");
    // No getAheadCommits for B leaked through (would indicate a rebind).
    expect(lastCall("getAheadCommits")).toBeFalsy();

    // --- Recovery: click "Rebase". Its requests must pin repoId "A".
    responders.pullRebase = () => undefined;
    responders.executePush = () => ({ data: {} });
    (document.querySelector(".push-btn-rebase") as HTMLButtonElement).click();

    await waitFor(() => {
      expect(lastCall("pullRebase")).toBeTruthy();
    });
    expect(lastCall("pullRebase")?.[2]).toMatchObject({ repoId: "A" });

    await waitFor(() => {
      expect(lastCall("executePush")).toBeTruthy();
    });
    expect(lastCall("executePush")?.[2]).toMatchObject({ repoId: "A" });

    // After recovery (dialog dismissed + push succeeded), the deferred B re-init
    // applies: bindRepo("B") bumps the bridge context to B.
    await waitFor(() => {
      expect(setRepoContext).toHaveBeenCalledWith("B");
    });
    // And the header flips to B.
    await waitFor(() => {
      expect(
        (document.querySelector(".push-repo-name") as HTMLElement | null)
          ?.textContent,
      ).toBe("B-name");
    });
  });
});
