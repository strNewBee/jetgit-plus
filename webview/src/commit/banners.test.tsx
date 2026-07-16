import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Commit operation banner repo-binding tests.
 *
 * The commit webview is a single shared panel; its three operation banners
 * (Rebase / Merge / CherryPick) are leaf components that each fetch their
 * operation state on mount and on git/commit-state events. The banners are
 * remounted on repo switch (keyed by activeRepoId) and route every repo-bound
 * request through the bridge's per-request `repoId` override so the displayed
 * repo is always the one acted on — regardless of ambient bridge context.
 *
 * These tests assert the correctness invariants at the bridge-message level
 * (which is what matters for routing) by rendering each banner in isolation
 * with `repoId="B"` and inspecting the posted RequestOptions:
 *
 * (a) the mount state-fetch (`getRebaseState`/`getMergeState`/`getCherryPickState`)
 *     carries `repoId:"B"`;
 * (b) the action requests (`rebaseAction`/`mergeAction`/`cherryPickAction`,
 *     and for merge: `getConflictFiles`/`openConflictsPanel`) carry `repoId:"B"`;
 * (c) `showErrorNotification` (repo-agnostic) carries NO repoId (global scope).
 *
 * The banners import only `Tooltip` (no `~icons/*` virtual modules), so no icon
 * stubbing is needed. The bridge singleton is mocked so we can capture requests
 * and drive canned responses via per-command responders.
 */
const mocks = vi.hoisted(() => {
  const eventListener: {
    current: ((event: string, data: unknown) => void) | null;
  } = { current: null };
  // Per-command responder so tests can return canned payloads. Default resolves
  // undefined (banners treat a missing operation state as "not in progress").
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
  return { request, onEvent, eventListener, responders };
});

vi.mock("../shared/bridge", () => ({
  bridge: {
    request: mocks.request,
    onEvent: mocks.onEvent,
  },
}));

import { CherryPickBanner, MergeBanner, RebaseBanner } from "./App";

const { request, onEvent, eventListener, responders } = mocks;

/** Last call to `bridge.request` for a given command, or undefined. */
function lastCall(command: string) {
  const calls = request.mock.calls.filter((c) => c[0] === command);
  return calls.length ? calls[calls.length - 1] : undefined;
}

/** Options object (3rd arg) of the last call for a command. */
function lastOpts(command: string) {
  return lastCall(command)?.[2] as
    | { scope?: string; repoId?: string }
    | undefined;
}

beforeEach(() => {
  request.mockClear();
  onEvent.mockClear();
  eventListener.current = null;
  for (const k of Object.keys(responders)) delete responders[k];
});
afterEach(() => {
  cleanup();
  eventListener.current = null;
});

describe("RebaseBanner", () => {
  it("mount state-fetch getRebaseState carries repoId 'B'", async () => {
    responders.getRebaseState = () => ({ isRebasing: true });
    render(<RebaseBanner repoId="B" />);
    await waitFor(() => {
      expect(lastCall("getRebaseState")).toBeTruthy();
    });
    expect(lastOpts("getRebaseState")?.repoId).toBe("B");
  });

  it("rebaseAction carries repoId 'B'", async () => {
    // isRebasing:true so the banner renders its action buttons.
    responders.getRebaseState = () => ({ isRebasing: true });
    responders.rebaseAction = () => ({ ok: true });

    render(<RebaseBanner repoId="B" />);
    await waitFor(() => {
      expect(document.querySelector(".rebase-continue")).toBeTruthy();
    });

    const continueBtn = document.querySelector(
      ".rebase-continue",
    ) as HTMLDivElement;
    continueBtn.click();

    await waitFor(() => {
      expect(lastCall("rebaseAction")).toBeTruthy();
    });
    expect(lastCall("rebaseAction")?.[1]).toMatchObject({ action: "continue" });
    expect(lastOpts("rebaseAction")?.repoId).toBe("B");
  });

  it("showErrorNotification carries NO repoId (global scope)", async () => {
    // getRebaseState resolves so the banner renders; rebaseAction rejects so the
    // catch fires showErrorNotification.
    responders.getRebaseState = () => ({ isRebasing: true });
    responders.rebaseAction = () => {
      throw new Error("boom");
    };

    render(<RebaseBanner repoId="B" />);
    await waitFor(() => {
      expect(document.querySelector(".rebase-abort")).toBeTruthy();
    });

    const abortBtn = document.querySelector(".rebase-abort") as HTMLDivElement;
    abortBtn.click();

    await waitFor(() => {
      expect(lastCall("showErrorNotification")).toBeTruthy();
    });
    const opts = lastOpts("showErrorNotification");
    expect(opts?.repoId).toBeUndefined();
    expect(opts?.scope).toBe("global");
  });
});

describe("CherryPickBanner", () => {
  it("mount state-fetch getCherryPickState carries repoId 'B'", async () => {
    responders.getCherryPickState = () => ({ isCherryPicking: true });
    render(<CherryPickBanner repoId="B" />);
    await waitFor(() => {
      expect(lastCall("getCherryPickState")).toBeTruthy();
    });
    expect(lastOpts("getCherryPickState")?.repoId).toBe("B");
  });

  it("cherryPickAction carries repoId 'B'", async () => {
    responders.getCherryPickState = () => ({ isCherryPicking: true });
    responders.cherryPickAction = () => ({ ok: true });

    render(<CherryPickBanner repoId="B" />);
    await waitFor(() => {
      expect(document.querySelector(".rebase-continue")).toBeTruthy();
    });

    const continueBtn = document.querySelector(
      ".rebase-continue",
    ) as HTMLDivElement;
    continueBtn.click();

    await waitFor(() => {
      expect(lastCall("cherryPickAction")).toBeTruthy();
    });
    expect(lastCall("cherryPickAction")?.[1]).toMatchObject({
      action: "continue",
    });
    expect(lastOpts("cherryPickAction")?.repoId).toBe("B");
  });

  it("showErrorNotification carries NO repoId (global scope)", async () => {
    responders.getCherryPickState = () => ({ isCherryPicking: true });
    responders.cherryPickAction = () => {
      throw new Error("boom");
    };

    render(<CherryPickBanner repoId="B" />);
    await waitFor(() => {
      expect(document.querySelector(".rebase-abort")).toBeTruthy();
    });

    const abortBtn = document.querySelector(".rebase-abort") as HTMLDivElement;
    abortBtn.click();

    await waitFor(() => {
      expect(lastCall("showErrorNotification")).toBeTruthy();
    });
    const opts = lastOpts("showErrorNotification");
    expect(opts?.repoId).toBeUndefined();
    expect(opts?.scope).toBe("global");
  });
});

describe("MergeBanner", () => {
  it("mount state-fetch getMergeState carries repoId 'B'", async () => {
    responders.getMergeState = () => ({ isMerging: true });
    render(<MergeBanner repoId="B" />);
    await waitFor(() => {
      expect(lastCall("getMergeState")).toBeTruthy();
    });
    expect(lastOpts("getMergeState")?.repoId).toBe("B");
  });

  it("continue path: getConflictFiles + openConflictsPanel carry repoId 'B' when conflicts exist", async () => {
    responders.getMergeState = () => ({ isMerging: true });
    responders.getConflictFiles = () => ["foo.txt"];
    responders.openConflictsPanel = () => undefined;

    render(<MergeBanner repoId="B" />);
    await waitFor(() => {
      expect(document.querySelector(".rebase-continue")).toBeTruthy();
    });

    const continueBtn = document.querySelector(
      ".rebase-continue",
    ) as HTMLDivElement;
    continueBtn.click();

    await waitFor(() => {
      expect(lastCall("openConflictsPanel")).toBeTruthy();
    });
    expect(lastOpts("getConflictFiles")?.repoId).toBe("B");
    expect(lastOpts("openConflictsPanel")?.repoId).toBe("B");
    // mergeAction{continue} must NOT fire when conflicts remain unresolved.
    expect(lastCall("mergeAction")).toBeUndefined();
  });

  it("continue path: mergeAction{continue} carries repoId 'B' when no conflicts", async () => {
    responders.getMergeState = () => ({ isMerging: true });
    responders.getConflictFiles = () => [];
    responders.mergeAction = () => ({ ok: true });

    render(<MergeBanner repoId="B" />);
    await waitFor(() => {
      expect(document.querySelector(".rebase-continue")).toBeTruthy();
    });

    const continueBtn = document.querySelector(
      ".rebase-continue",
    ) as HTMLDivElement;
    continueBtn.click();

    await waitFor(() => {
      expect(lastCall("mergeAction")).toBeTruthy();
    });
    expect(lastCall("mergeAction")?.[1]).toMatchObject({ action: "continue" });
    expect(lastOpts("mergeAction")?.repoId).toBe("B");
  });

  it("abort path: mergeAction{abort} carries repoId 'B'", async () => {
    responders.getMergeState = () => ({ isMerging: true });
    responders.mergeAction = () => ({ ok: true });

    render(<MergeBanner repoId="B" />);
    await waitFor(() => {
      expect(document.querySelector(".rebase-abort")).toBeTruthy();
    });

    const abortBtn = document.querySelector(".rebase-abort") as HTMLDivElement;
    abortBtn.click();

    await waitFor(() => {
      expect(lastCall("mergeAction")).toBeTruthy();
    });
    expect(lastCall("mergeAction")?.[1]).toMatchObject({ action: "abort" });
    expect(lastOpts("mergeAction")?.repoId).toBe("B");
  });

  it("showErrorNotification carries NO repoId (global scope)", async () => {
    responders.getMergeState = () => ({ isMerging: true });
    responders.mergeAction = () => {
      throw new Error("boom");
    };

    render(<MergeBanner repoId="B" />);
    await waitFor(() => {
      expect(document.querySelector(".rebase-abort")).toBeTruthy();
    });

    const abortBtn = document.querySelector(".rebase-abort") as HTMLDivElement;
    abortBtn.click();

    await waitFor(() => {
      expect(lastCall("showErrorNotification")).toBeTruthy();
    });
    const opts = lastOpts("showErrorNotification");
    expect(opts?.repoId).toBeUndefined();
    expect(opts?.scope).toBe("global");
  });
});

describe("banner remount on repo switch", () => {
  it("a banner rendered with repoId null stamps no repoId on its state-fetch", async () => {
    // When there is no active repo the banners still mount (they self-hide via
    // isRebasing:false), but their fetch must not pin a stale repoId.
    responders.getRebaseState = () => ({ isRebasing: false });
    render(<RebaseBanner repoId={null} />);
    await waitFor(() => {
      expect(lastCall("getRebaseState")).toBeTruthy();
    });
    expect(lastOpts("getRebaseState")?.repoId).toBeUndefined();
  });
});
