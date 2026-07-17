import { describe, expect, it } from "vitest";
import { computeTooltipPosition, isTooltipContentTruncated } from "./Tooltip";

describe("computeTooltipPosition", () => {
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
