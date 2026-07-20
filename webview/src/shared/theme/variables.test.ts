import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const stylesheet = readFileSync(
  resolve(process.cwd(), "src/shared/theme/variables.css"),
  "utf8",
);

describe("commit reachability theme", () => {
  it("uses the full VS Code selection background for reachable rows", () => {
    const declaration = stylesheet.match(
      /--current-reachable-bg:\s*[^;]+;/,
    )?.[0];

    expect(declaration).toBe(
      "--current-reachable-bg: var(--vscode-list-activeSelectionBackground, #04395e);",
    );
  });

  it("keeps the selected commit identifiable inside a highlighted range", () => {
    const selectedRule = stylesheet.match(
      /\.selectable-row\.current-reachable\.selected[\s\S]*?\{([\s\S]*?)\}/,
    )?.[1];

    expect(selectedRule).toMatch(
      /outline:\s*1px solid\s+var\(--vscode-list-focusOutline,\s*var\(--vscode-focusBorder,\s*#007fd4\)\)/,
    );
    expect(selectedRule).toContain("outline-offset: -1px");
  });

  it("preserves a distinct selected outline in high contrast mode", () => {
    const genericSelector =
      "body.vscode-high-contrast .selectable-row.current-reachable";
    const selectedSelector = `${genericSelector}.selected`;
    const genericIndex = stylesheet.indexOf(genericSelector);
    const selectedIndex = stylesheet.indexOf(selectedSelector);
    const selectedRule = stylesheet.match(
      /body\.vscode-high-contrast \.selectable-row\.current-reachable\.selected\s*\{([\s\S]*?)\}/,
    )?.[1];

    expect(genericIndex).toBeGreaterThan(-1);
    expect(selectedIndex).toBeGreaterThan(genericIndex);
    expect(selectedRule).toContain("outline: 2px solid");
    expect(selectedRule).toContain("outline-offset: -2px");
  });
});
