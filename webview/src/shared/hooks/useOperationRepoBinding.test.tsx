import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * The hook imports the singleton `bridge` from `../bridge`. We mock that module
 * so we can capture `setRepoContext` calls and emit `activeRepoChanged` events
 * via the captured `onEvent` listener. `vi.hoisted` lets the factory (which is
 * hoisted above imports) reference these mocks.
 */
const mocks = vi.hoisted(() => {
  const eventListener: {
    current: ((event: string, data: unknown) => void) | null;
  } = { current: null };
  const setRepoContext = vi.fn();
  const onEvent = vi.fn(
    (handler: (event: string, data: unknown) => void): (() => void) => {
      eventListener.current = handler;
      return () => {
        if (eventListener.current === handler) eventListener.current = null;
      };
    },
  );
  return { setRepoContext, onEvent, eventListener };
});

vi.mock("../bridge", () => ({
  bridge: {
    setRepoContext: mocks.setRepoContext,
    onEvent: mocks.onEvent,
  },
}));

import { useOperationRepoBinding } from "./useOperationRepoBinding";

const { setRepoContext, onEvent, eventListener } = mocks;

function emit(event: string, data: unknown) {
  act(() => {
    eventListener.current?.(event, data);
  });
}

function activeRepoChanged(repoId: string | null) {
  emit("activeRepoChanged", { repo: repoId ? { id: repoId } : null });
}

describe("useOperationRepoBinding", () => {
  beforeEach(() => {
    setRepoContext.mockReset();
    onEvent.mockClear();
    eventListener.current = null;
  });
  afterEach(() => {
    eventListener.current = null;
  });

  it("applies repo changes immediately when not busy", async () => {
    const onFollow = vi.fn();
    renderHook(({ busy }) => useOperationRepoBinding(busy, onFollow), {
      initialProps: { busy: false },
    });

    expect(eventListener.current).not.toBeNull();
    activeRepoChanged("B");

    await waitFor(() => {
      expect(setRepoContext).toHaveBeenCalledWith("B");
      expect(onFollow).toHaveBeenCalledWith("B");
    });
  });

  it("defers repo changes while busy and applies the latest when idle (acceptance proof)", async () => {
    const onFollow = vi.fn();
    const { rerender } = renderHook(
      ({ busy }) => useOperationRepoBinding(busy, onFollow),
      { initialProps: { busy: true } },
    );

    // While busy: emit B. Nothing should happen.
    activeRepoChanged("B");
    expect(setRepoContext).not.toHaveBeenCalled();
    expect(onFollow).not.toHaveBeenCalled();

    // Still busy: emit C. Only C should be remembered.
    activeRepoChanged("C");
    expect(setRepoContext).not.toHaveBeenCalled();
    expect(onFollow).not.toHaveBeenCalled();

    // Go idle — the latest pending repo (C) wins.
    rerender({ busy: false });
    await waitFor(() => {
      expect(setRepoContext).toHaveBeenCalledTimes(1);
      expect(setRepoContext).toHaveBeenCalledWith("C");
      expect(onFollow).toHaveBeenCalledTimes(1);
      expect(onFollow).toHaveBeenCalledWith("C");
    });
  });

  it("applies a null repo (deselection) when idle", async () => {
    const onFollow = vi.fn();
    const { rerender } = renderHook(
      ({ busy }) => useOperationRepoBinding(busy, onFollow),
      { initialProps: { busy: true } },
    );

    activeRepoChanged(null);
    rerender({ busy: false });

    await waitFor(() => {
      expect(setRepoContext).toHaveBeenCalledWith(null);
      expect(onFollow).toHaveBeenCalledWith(null);
    });
  });

  it("ignores non-activeRepoChanged events", async () => {
    const onFollow = vi.fn();
    renderHook(({ busy }) => useOperationRepoBinding(busy, onFollow), {
      initialProps: { busy: false },
    });

    emit("gitStateChanged", { scope: "all" });
    expect(setRepoContext).not.toHaveBeenCalled();
    expect(onFollow).not.toHaveBeenCalled();
  });
});
