import { act, fireEvent, render } from "@testing-library/react";
import { createElement } from "react";
import { describe, expect, it, vi } from "vitest";
import {
  computeTooltipPosition,
  isTooltipContentTruncated,
  Tooltip,
} from "./Tooltip";

describe("computeTooltipPosition", () => {
  it("sizes tooltip content before clamping it away from the viewport edge", async () => {
    vi.useFakeTimers();
    const view = render(
      createElement(
        Tooltip,
        { text: "Flat List", delay: 0 },
        createElement("button", { type: "button" }, "Flat"),
      ),
    );

    try {
      fireEvent.mouseEnter(view.getByRole("button", { name: "Flat" }));
      await act(async () => vi.runAllTimersAsync());
      const popup = document.querySelector<HTMLElement>(".tooltip-popup");
      expect(popup?.style.width).toBe("max-content");
    } finally {
      view.unmount();
      vi.useRealTimers();
    }
  });

  it("clamps a long tooltip inside the viewport without alternating edges", () => {
    const input = {
      trigger: { top: 80, bottom: 100, left: 286, width: 20 },
      tooltip: { width: 292, height: 48 },
      viewport: { width: 300, height: 200 },
      preferred: "top" as const,
    };

    const first = computeTooltipPosition(input);
    const second = computeTooltipPosition(input);

    expect(first).toEqual(second);
    expect(first.left).toBe(150);
    expect(first.position).toBe("top");
  });

  it("flips below when the measured tooltip cannot fit above", () => {
    expect(
      computeTooltipPosition({
        trigger: { top: 10, bottom: 28, left: 40, width: 20 },
        tooltip: { width: 120, height: 40 },
        viewport: { width: 300, height: 200 },
        preferred: "top",
      }).position,
    ).toBe("bottom");
  });

  it("uses the roomier side and clamps inside the viewport when neither side fits", () => {
    const result = computeTooltipPosition({
      trigger: { top: 80, bottom: 100, left: 140, width: 20 },
      tooltip: { width: 120, height: 100 },
      viewport: { width: 300, height: 140 },
      preferred: "bottom",
    });

    expect(result.position).toBe("top");
    // A top tooltip is translated upward by its own height. Clamping its
    // anchor to 104 therefore leaves the rendered top edge at the 4px margin.
    expect(result.top).toBe(104);
  });

  it("detects text clipped by its parent even when the child itself does not overflow", () => {
    const parent = document.createElement("span");
    const wrapper = document.createElement("span");
    const child = document.createElement("span");
    parent.appendChild(wrapper);
    wrapper.appendChild(child);
    Object.defineProperties(parent, {
      clientWidth: { value: 100 },
      scrollWidth: { value: 300 },
    });
    Object.defineProperties(child, {
      clientWidth: { value: 300 },
      scrollWidth: { value: 300 },
    });

    expect(isTooltipContentTruncated(wrapper)).toBe(true);
  });
});
