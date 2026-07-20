import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const stylesheet = readFileSync(
  resolve(process.cwd(), "src/shared/theme/variables.css"),
  "utf8",
);

describe("commit reachability theme", () => {
  it("outlines a selected commit outside the reachable range", () => {
    const selectedRule = stylesheet.match(
      /\.commit-row\.selected[\s\S]*?\{([\s\S]*?)\}/,
    )?.[1];

    expect(selectedRule).toMatch(
      /outline:\s*1px solid\s+var\(--vscode-list-focusOutline,\s*var\(--vscode-focusBorder,\s*#007fd4\)\)/,
    );
    expect(selectedRule).toContain("outline-offset: -1px");
  });

  it("defines progressively stronger reachable, hover, and selected fills", () => {
    const declarations = [
      ["--current-reachable-bg", 28],
      ["--current-reachable-hover-bg", 40],
      ["--current-reachable-selected-bg", 58],
    ] as const;

    for (const [name, strength] of declarations) {
      const declaration = stylesheet.match(
        new RegExp(`${name}:\\s*[^;]+;`),
      )?.[0];
      expect(declaration).toBeDefined();
      expect(declaration ?? "").toContain("color-mix(");
      expect(declaration ?? "").toContain(`${strength}%`);
      expect(declaration ?? "").not.toContain(
        "--vscode-list-activeSelectionBackground",
      );
    }
  });

  it("keeps the selected commit identifiable inside a highlighted range", () => {
    const hoverRule = stylesheet.match(
      /\.selectable-row\.current-reachable:hover,[\s\S]*?\{([\s\S]*?)\}/,
    )?.[1];
    const selectedRule = stylesheet.match(
      /\.selectable-row\.current-reachable\.selected[\s\S]*?\{([\s\S]*?)\}/,
    )?.[1];

    expect(hoverRule).toContain(
      "background: var(--current-reachable-hover-bg)",
    );
    expect(selectedRule).toContain(
      "background: var(--current-reachable-selected-bg)",
    );
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
