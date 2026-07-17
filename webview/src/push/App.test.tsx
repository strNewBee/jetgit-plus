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
  // Mirror the REAL bridge (vscode-bridge.ts): onEvent registers handlers into
  // a Set and an emit broadcasts to ALL of them. The previous mock kept only
  // the LAST handler in a single slot, which silently dropped the hook's
  // activeRepoChanged listener once Push's pushPanelInit listener subscribed —
  // making the two-listener interleaving untestable. With a Set, both
  // listeners coexist and BOTH fire on emit (each filters by event name).
  const eventListeners = new Set<(event: string, data: unknown) => void>();
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
      eventListeners.add(handler);
      return () => {
        eventListeners.delete(handler);
      };
    },
  );
  return { setRepoContext, request, onEvent, eventListeners, responders };
});

vi.mock("../shared/bridge", () => ({
  bridge: {
    setRepoContext: mocks.setRepoContext,
    request: mocks.request,
    onEvent: mocks.onEvent,
  },
}));

import { PushApp } from "./App";

const { setRepoContext, request, onEvent, eventListeners, responders } = mocks;

function emit(event: string, data: unknown) {
  for (const h of eventListeners) h(event, data);
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
    eventListeners.clear();
    for (const k of Object.keys(responders)) delete responders[k];
  });
  afterEach(() => {
    cleanup();
    eventListeners.clear();
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
    eventListeners.clear();
    for (const k of Object.keys(responders)) delete responders[k];
  });
  afterEach(() => {
    cleanup();
    eventListeners.clear();
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
    eventListeners.clear();
    for (const k of Object.keys(responders)) delete responders[k];
  });
  afterEach(() => {
    cleanup();
    eventListeners.clear();
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

  // Fix-11 (Important #4): the Push panel has TWO independent deferred-repo
  // queues — the hook's pendingRepoRef (for activeRepoChanged) and Push's own
  // pendingReInitRef (for pushPanelInit) — that both drain when the panel goes
  // idle, in React effect-registration order (the hook's drain runs FIRST, then
  // Push's drain runs LAST). Before the shared-monotonic-seq fix, a stale
  // pushPanelInit(B) stashed EARLIER could override a NEWER activeRepoChanged(C)
  // because Push's drain applied last, leaving the panel bound to B while the
  // global active repo was C — a wrong-repo-operation window. The fix stamps a
  // shared seq at arrival at BOTH points and claim-gates application so the
  // LAST-ARRIVED event wins regardless of drain order.
  it("Fix-11: a stale pushPanelInit(B) then a newer activeRepoChanged(C) while busy ends on C (latest wins, regardless of drain order)", async () => {
    seedRoot({
      repoId: "A",
      branch: "main",
      remote: "origin",
      repoName: "A-name",
    });
    responders.getAheadCommits = () => ({
      commits: [{ hash: "h1", subject: "s", refs: [] }],
    });
    responders.executePush = () => {
      throw new Error("![rejected] non-fast-forward");
    };

    render(<PushApp />);

    // Enable + trigger the rejected push for repo A so the dialog opens (busy).
    await waitFor(() => {
      expect(
        (document.querySelector(".push-split-main") as HTMLButtonElement)
          .disabled,
      ).toBe(false);
    });
    (document.querySelector(".push-split-main") as HTMLButtonElement).click();
    await waitFor(() => {
      expect(document.querySelector(".push-rejected-dialog")).toBeTruthy();
    });

    // --- While busy: B arrives FIRST (lower seq), then C arrives SECOND
    //     (higher seq). Pre-fix, Push's drain would apply B last and win. The
    //     seq gate must make C (last-arrived) win instead.
    setRepoContext.mockClear();
    request.mockClear();
    emit("pushPanelInit", {
      repoId: "B",
      repoName: "B-name",
      branchName: "feature",
      remote: "up",
    });
    emit("activeRepoChanged", {
      repo: { id: "C" },
      repoName: "C-name",
    });

    // Both events are deferred while the dialog is open: no rebind yet.
    await new Promise((r) => setTimeout(r, 0));
    expect(setRepoContext).not.toHaveBeenCalledWith("B");
    expect(setRepoContext).not.toHaveBeenCalledWith("C");

    // --- Dismiss the dialog via Cancel: pushRejected.show flips false while
    //     pushing stays false, so both drains fire on this commit. This is the
    //     exact busy→idle transition where the two queues race. NOTE: scoped to
    //     `.push-rejected-dialog` because the footer also has a Cancel button
    //     (`.push-btn-secondary`) that calls closePushPanel instead of clearing
    //     the dialog — it would NOT trigger the busy→idle drain.
    responders.getAheadCommits = () => ({ commits: [] });
    // Provide a getBranches response so the hook's onFollow→loadRepo proceeds
    // past its early-return and issues a repo-bound request we can inspect.
    responders.getBranches = () => [
      { name: "main", isCurrent: true, upstream: "origin/main" },
    ];
    (
      document.querySelector(
        ".push-rejected-dialog .push-btn-secondary",
      ) as HTMLButtonElement
    ).click();

    // LATEST WINS: the panel must end on C, NOT B. The hook's applyAt for C has
    // the higher seq, so Push's stale applyReInit(B) is rejected by claimSeq.
    await waitFor(() => {
      expect(setRepoContext).toHaveBeenCalledWith("C");
    });
    // The stale B re-init must NOT have applied (it was superseded by C).
    expect(setRepoContext).not.toHaveBeenCalledWith("B");
    // Header reflects C, the last-arrived event.
    await waitFor(() => {
      expect(
        (document.querySelector(".push-repo-name") as HTMLElement | null)
          ?.textContent,
      ).toBe("C-name");
    });
    // And the next repo-bound request the panel issues carries repoId "C"
    // (loadRepo fires from the hook's onFollow after applyAt rebinds to C).
    await waitFor(() => {
      expect(lastCall("getBranches")?.[2]).toMatchObject({ repoId: "C" });
    });
  });
});
