import { cleanup, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Rollback panel re-init binding tests.
 *
 * The panel is reused across repos (host calls reveal() + posts a
 * `rollbackPanelInit` event instead of recreating the webview). These tests
 * assert the correctness invariants at the bridge-message level — which is what
 * matters for routing — rather than the rendered DOM:
 *
 * (a) a `rollbackPanelInit{repoId:"B"}` event while idle calls `bindRepo("B")`
 *     (observed as a `setRepoContext("B")` bump) AND the subsequent
 *     `getWorkingTreeChanges` request carries repoId "B".
 * (b) `executeRollback` carries repoId "B" after re-init (the destructive op
 *     targets the repo the panel is showing).
 *
 * The icon virtual modules (`~icons/...`) resolve via the Icons plugin in the
 * vitest config. The bridge singleton is mocked so we can capture requests and
 * emit events via the captured `onEvent` listener.
 */
const mocks = vi.hoisted(() => {
  const eventListener: {
    current: ((event: string, data: unknown) => void) | null;
  } = { current: null };
  const setRepoContext = vi.fn();
  // Per-command responder so tests can return canned payloads. Default
  // resolves undefined (treated as not-a-git-repo by the panel's guard).
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

import type { RollbackFileInfo } from "./App";
import { RollbackApp } from "./App";

const { setRepoContext, request, onEvent, eventListener, responders } = mocks;

function emit(event: string, data: unknown) {
  eventListener.current?.(event, data);
}

/** Set (or clear) host-supplied seed attributes on #root. */
function seedRoot(attrs: { repoId?: string; files?: RollbackFileInfo[] }) {
  let root = document.getElementById("root");
  if (!root) {
    root = document.createElement("div");
    root.id = "root";
    document.body.appendChild(root);
  }
  delete root.dataset.repoId;
  delete root.dataset.files;
  if (attrs.repoId !== undefined) root.dataset.repoId = attrs.repoId;
  if (attrs.files !== undefined)
    root.dataset.files = JSON.stringify(attrs.files);
}

/** Last call to `bridge.request` for a given command, or undefined. */
function lastCall(command: string) {
  const calls = request.mock.calls.filter((c) => c[0] === command);
  return calls.length ? calls[calls.length - 1] : undefined;
}

describe("RollbackApp re-init binding", () => {
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

  it("a rollbackPanelInit{repoId:'B'} re-init while idle rebinds so the next getWorkingTreeChanges carries repoId 'B'", async () => {
    // Seed create-time state for repo A with one file.
    seedRoot({
      repoId: "A",
      files: [{ path: "a.txt", status: "M", staged: false }],
    });
    responders.getWorkingTreeChanges = () =>
      [
        { path: "b.txt", status: "M", staged: false },
      ] satisfies RollbackFileInfo[];

    render(<RollbackApp />);

    // Re-init to repo B while idle.
    emit("rollbackPanelInit", { repoId: "B" });

    // bindRepo("B") bumps bridge context synchronously.
    await waitFor(() => {
      expect(setRepoContext).toHaveBeenCalledWith("B");
    });

    // The re-init's getWorkingTreeChanges reload is bound to B.
    await waitFor(() => {
      const gwt = lastCall("getWorkingTreeChanges");
      expect(gwt).toBeTruthy();
      expect(gwt?.[2]).toMatchObject({ repoId: "B" });
    });
  });

  it("executeRollback after a re-init to repo 'B' carries repoId 'B'", async () => {
    seedRoot({
      repoId: "A",
      files: [{ path: "a.txt", status: "M", staged: false }],
    });
    responders.getWorkingTreeChanges = () =>
      [
        { path: "b.txt", status: "M", staged: false },
      ] satisfies RollbackFileInfo[];
    // executeRollback resolves success → host closes the panel.
    responders.executeRollback = () => ({ success: true });

    render(<RollbackApp />);

    // Re-init to repo B while idle.
    emit("rollbackPanelInit", { repoId: "B" });

    // Wait for the reload to land so a file is checked.
    await waitFor(() => {
      expect(lastCall("getWorkingTreeChanges")?.[2]).toMatchObject({
        repoId: "B",
      });
    });

    request.mockClear();
    const rollbackBtn = document.querySelector(
      ".rollback-btn-primary",
    ) as HTMLButtonElement;
    expect(rollbackBtn).toBeTruthy();
    rollbackBtn.click();

    await waitFor(() => {
      const rb = lastCall("executeRollback");
      expect(rb).toBeTruthy();
      expect(rb?.[1]).toMatchObject({
        filePaths: ["b.txt"],
        deleteLocalCopies: false,
      });
      expect(rb?.[2]).toMatchObject({ repoId: "B" });
    });
  });
});
