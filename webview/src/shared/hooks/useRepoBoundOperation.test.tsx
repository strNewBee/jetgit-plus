import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The hook imports the singleton `bridge` from `../bridge`. We mock that module
 * so we can capture `setRepoContext` / `request` calls and emit
 * `activeRepoChanged` events via the captured `onEvent` listener.
 * `vi.hoisted` lets the factory (which is hoisted above imports) reference
 * these mocks.
 */
const mocks = vi.hoisted(() => {
  const eventListener: {
    current: ((event: string, data: unknown) => void) | null;
  } = { current: null };
  const setRepoContext = vi.fn();
  const request = vi.fn(() => Promise.resolve(undefined));
  const onEvent = vi.fn(
    (handler: (event: string, data: unknown) => void): (() => void) => {
      eventListener.current = handler;
      return () => {
        if (eventListener.current === handler) eventListener.current = null;
      };
    },
  );
  return { setRepoContext, request, onEvent, eventListener };
});

vi.mock("../bridge", () => ({
  bridge: {
    setRepoContext: mocks.setRepoContext,
    request: mocks.request,
    onEvent: mocks.onEvent,
  },
}));

import { useRepoBoundOperation } from "./useRepoBoundOperation";

const { setRepoContext, request, onEvent, eventListener } = mocks;

function emit(event: string, data: unknown) {
  act(() => {
    eventListener.current?.(event, data);
  });
}

function activeRepoChanged(repoId: string | null, repoName: string = "") {
  emit("activeRepoChanged", {
    repo: repoId ? { id: repoId } : null,
    repoName,
  });
}

/** Set (or clear) the host-supplied seed attribute on #root. */
function seedRootRepoId(value: string | null) {
  let root = document.getElementById("root");
  if (value === null) {
    if (root) delete root.dataset.repoId;
  } else {
    if (!root) {
      const el = document.createElement("div");
      el.id = "root";
      document.body.appendChild(el);
      root = el;
    }
    root.dataset.repoId = value;
  }
}

/** Set (or clear) the host-supplied seed name attribute on #root. */
function seedRootRepoName(value: string | null) {
  let root = document.getElementById("root");
  if (!root) {
    if (value === null) return;
    root = document.createElement("div");
    root.id = "root";
    document.body.appendChild(root);
  }
  if (value === null) {
    delete root.dataset.repoName;
  } else {
    root.dataset.repoName = value;
  }
}

describe("useRepoBoundOperation", () => {
  beforeEach(() => {
    setRepoContext.mockReset();
    request.mockReset();
    request.mockImplementation(() => Promise.resolve(undefined));
    onEvent.mockClear();
    eventListener.current = null;
  });
  afterEach(() => {
    seedRootRepoId(null);
    seedRootRepoName(null);
    eventListener.current = null;
  });

  it("seeds repoId from #root[data-repo-id]", () => {
    seedRootRepoId("seeded");
    const onFollow = vi.fn();
    const { result } = renderHook(
      ({ busy }) => useRepoBoundOperation(busy, onFollow),
      {
        initialProps: { busy: false },
      },
    );
    expect(result.current.repoId).toBe("seeded");
  });

  it("request() attaches the hook's repoId to every call", async () => {
    seedRootRepoId("A");
    const onFollow = vi.fn();
    const { result } = renderHook(
      ({ busy }) => useRepoBoundOperation(busy, onFollow),
      {
        initialProps: { busy: false },
      },
    );

    await act(async () => {
      await result.current.request("getBranches", { foo: 1 });
    });

    expect(request).toHaveBeenCalledTimes(1);
    expect(request).toHaveBeenCalledWith(
      "getBranches",
      { foo: 1 },
      expect.objectContaining({ repoId: "A" }),
    );
  });

  it("follows an activeRepoChanged event when idle", async () => {
    seedRootRepoId("A");
    const onFollow = vi.fn();
    renderHook(({ busy }) => useRepoBoundOperation(busy, onFollow), {
      initialProps: { busy: false },
    });

    expect(eventListener.current).not.toBeNull();
    activeRepoChanged("B");

    await waitFor(() => {
      expect(setRepoContext).toHaveBeenCalledWith("B");
      expect(onFollow).toHaveBeenCalledWith("B");
    });
  });

  it("idle-follow updates BOTH repoId AND repoName together (F1)", async () => {
    seedRootRepoId("A");
    seedRootRepoName("A-label");
    const onFollow = vi.fn();
    const { result } = renderHook(
      ({ busy }) => useRepoBoundOperation(busy, onFollow),
      { initialProps: { busy: false } },
    );

    expect(result.current.repoId).toBe("A");
    expect(result.current.repoName).toBe("A-label");

    activeRepoChanged("B", "B-label");

    await waitFor(() => {
      expect(result.current.repoId).toBe("B");
      expect(result.current.repoName).toBe("B-label");
    });

    // The bound request stamps the new repoId — the correctness guarantee.
    await act(async () => {
      await result.current.request("getBranches");
    });
    expect(request).toHaveBeenCalledWith(
      "getBranches",
      expect.anything(),
      expect.objectContaining({ repoId: "B" }),
    );
  });

  it("idle-follow with null repo clears repoId and repoName", async () => {
    seedRootRepoId("A");
    seedRootRepoName("A-label");
    const onFollow = vi.fn();
    const { result } = renderHook(
      ({ busy }) => useRepoBoundOperation(busy, onFollow),
      { initialProps: { busy: false } },
    );

    activeRepoChanged(null);

    await waitFor(() => {
      expect(result.current.repoId).toBeNull();
      expect(result.current.repoName).toBe("");
    });
  });

  it("busy-defer applies id AND name together when idle", async () => {
    seedRootRepoId("A");
    seedRootRepoName("A-label");
    const onFollow = vi.fn();
    const { rerender, result } = renderHook(
      ({ busy }) => useRepoBoundOperation(busy, onFollow),
      { initialProps: { busy: true } },
    );

    // While busy: emit a switch carrying BOTH id and name. Nothing applies yet.
    activeRepoChanged("B", "B-label");
    expect(setRepoContext).not.toHaveBeenCalled();
    expect(result.current.repoId).toBe("A");
    expect(result.current.repoName).toBe("A-label");

    // Go idle — BOTH repoId and repoName update together (never one without the
    // other, which would point a destructive action at the wrong repo).
    rerender({ busy: false });
    await waitFor(() => {
      expect(result.current.repoId).toBe("B");
      expect(result.current.repoName).toBe("B-label");
      expect(setRepoContext).toHaveBeenCalledWith("B");
    });
  });

  it("seeds repoName from #root[data-repo-name]", () => {
    seedRootRepoName("seeded-label");
    const onFollow = vi.fn();
    const { result } = renderHook(
      ({ busy }) => useRepoBoundOperation(busy, onFollow),
      { initialProps: { busy: false } },
    );
    expect(result.current.repoName).toBe("seeded-label");
  });

  it("bindRepo(id, name) updates both repoId and repoName", () => {
    seedRootRepoId("A");
    seedRootRepoName("A-label");
    const onFollow = vi.fn();
    const { result } = renderHook(
      ({ busy }) => useRepoBoundOperation(busy, onFollow),
      { initialProps: { busy: false } },
    );

    act(() => {
      result.current.bindRepo("C", "C-label");
    });

    expect(result.current.repoId).toBe("C");
    expect(result.current.repoName).toBe("C-label");
    expect(setRepoContext).toHaveBeenCalledWith("C");
  });

  it("defers repo changes while busy and applies only the latest when idle", async () => {
    seedRootRepoId("A");
    const onFollow = vi.fn();
    const { rerender, result } = renderHook(
      ({ busy }) => useRepoBoundOperation(busy, onFollow),
      { initialProps: { busy: true } },
    );

    // While busy: emit B, then C. Nothing applies yet.
    activeRepoChanged("B");
    activeRepoChanged("C");
    expect(setRepoContext).not.toHaveBeenCalled();
    expect(onFollow).not.toHaveBeenCalled();

    // Go idle — the latest pending (C) wins and repoId reflects it.
    rerender({ busy: false });
    await waitFor(() => {
      expect(setRepoContext).toHaveBeenCalledTimes(1);
      expect(setRepoContext).toHaveBeenCalledWith("C");
      expect(onFollow).toHaveBeenCalledTimes(1);
      expect(onFollow).toHaveBeenCalledWith("C");
      expect(result.current.repoId).toBe("C");
    });
  });

  it("bindRepo() sets repoId and bumps bridge context (re-init path)", () => {
    seedRootRepoId("A");
    const onFollow = vi.fn();
    const { result } = renderHook(
      ({ busy }) => useRepoBoundOperation(busy, onFollow),
      {
        initialProps: { busy: false },
      },
    );

    act(() => {
      result.current.bindRepo("C");
    });

    expect(result.current.repoId).toBe("C");
    expect(setRepoContext).toHaveBeenCalledWith("C");
  });
});
