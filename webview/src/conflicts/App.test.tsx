import { cleanup, fireEvent, render, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * Conflicts panel re-init binding tests.
 *
 * The panel is reused across repos (host calls reveal() + posts a
 * `conflictsPanelInit` event instead of recreating the webview). These tests
 * assert the correctness invariants at the bridge-message level — which is what
 * matters for routing — rather than the rendered DOM:
 *
 * (a) a `conflictsPanelInit{repoId:"B"}` event while idle calls `bindRepo("B")`
 *     (observed as a `setRepoContext("B")` bump) AND the subsequent
 *     `getConflictFiles` reload carries repoId "B".
 * (b) `acceptOurs` carries repoId "B" after re-init (the destructive Accept
 *     action targets the repo the panel is showing).
 *
 * The bridge singleton is mocked so we can capture requests and emit events via
 * the captured `onEvent` listener.
 */
const mocks = vi.hoisted(() => {
  const eventListener: {
    current: ((event: string, data: unknown) => void) | null;
  } = { current: null };
  const setRepoContext = vi.fn();
  // Per-command responder so tests can return canned payloads. Default
  // resolves undefined (getMergeState/getConflictFiles tolerate that).
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

import { ConflictsApp } from "./App";

const { setRepoContext, request, onEvent, eventListener, responders } = mocks;

function emit(event: string, data: unknown) {
  eventListener.current?.(event, data);
}

/** Set (or clear) host-supplied seed attributes on #root. */
function seedRoot(attrs: { repoId?: string }) {
  let root = document.getElementById("root");
  if (!root) {
    root = document.createElement("div");
    root.id = "root";
    document.body.appendChild(root);
  }
  delete root.dataset.repoId;
  if (attrs.repoId !== undefined) root.dataset.repoId = attrs.repoId;
}

/** Last call to `bridge.request` for a given command, or undefined. */
function lastCall(command: string) {
  const calls = request.mock.calls.filter((c) => c[0] === command);
  return calls.length ? calls[calls.length - 1] : undefined;
}

describe("ConflictsApp re-init binding", () => {
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

  it("a conflictsPanelInit{repoId:'B'} re-init while idle rebinds so the next getConflictFiles carries repoId 'B'", async () => {
    // Seed create-time state for repo A.
    seedRoot({ repoId: "A" });
    responders.getMergeState = () => ({ isMerging: true });
    responders.getConflictFiles = () => ["b.txt"];

    render(<ConflictsApp />);

    // Initial mount: getConflictFiles bound to repo A.
    await waitFor(() => {
      expect(lastCall("getConflictFiles")).toBeTruthy();
    });
    expect(lastCall("getConflictFiles")?.[2]).toMatchObject({ repoId: "A" });

    // Re-init to repo B while idle.
    emit("conflictsPanelInit", { repoId: "B" });

    // bindRepo("B") bumps bridge context synchronously.
    await waitFor(() => {
      expect(setRepoContext).toHaveBeenCalledWith("B");
    });

    // The re-init's getConflictFiles reload is bound to B.
    await waitFor(() => {
      const files = lastCall("getConflictFiles");
      expect(files).toBeTruthy();
      expect(files?.[2]).toMatchObject({ repoId: "B" });
    });
  });

  it("acceptOurs after a re-init to repo 'B' carries repoId 'B'", async () => {
    seedRoot({ repoId: "A" });
    responders.getMergeState = () => ({ isMerging: true });
    responders.getConflictFiles = () => ["b.txt"];
    // acceptOurs resolves success.
    responders.acceptOurs = () => ({ success: true });

    render(<ConflictsApp />);

    // Re-init to repo B while idle.
    emit("conflictsPanelInit", { repoId: "B" });

    // Wait for the reload to land so the conflict file is present and the
    // Accept button is enabled.
    await waitFor(() => {
      expect(lastCall("getConflictFiles")?.[2]).toMatchObject({
        repoId: "B",
      });
    });

    // Select the file first (click it) so Accept Yours targets it. The file
    // row is a .selectable-row whose filename appears in a <span>; locate it by
    // its rendered text rather than relying on a data attribute.
    const fileSpan = Array.from(document.querySelectorAll("span")).find((s) =>
      s.textContent?.includes("b.txt"),
    );
    // Click the enclosing selectable row (parent of the filename span).
    const fileRow = (fileSpan?.closest(".selectable-row") ??
      fileSpan) as HTMLElement | null;
    expect(fileRow).toBeTruthy();
    fireEvent.click(fileRow as HTMLElement);

    request.mockClear();
    // Click the "Accept Yours" button (matched by its text label).
    const buttons = Array.from(document.querySelectorAll("button"));
    const acceptYours = buttons.find(
      (b) => b.textContent?.trim() === "Accept Yours",
    ) as HTMLButtonElement | undefined;
    expect(acceptYours).toBeTruthy();
    fireEvent.click(acceptYours as HTMLButtonElement);

    await waitFor(() => {
      const acc = lastCall("acceptOurs");
      expect(acc).toBeTruthy();
      expect(acc?.[1]).toMatchObject({ filePath: "b.txt" });
      expect(acc?.[2]).toMatchObject({ repoId: "B" });
    });
  });
});
