import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const stylesheet = readFileSync(
  resolve(process.cwd(), "src/shared/theme/variables.css"),
  "utf8",
);

describe("commit reachability theme", () => {
  it("keeps the reachable-row background valid without optional theme colors", () => {
    const declaration = stylesheet.match(
      /--current-reachable-bg:\s*color-mix\([\s\S]*?\);/,
    )?.[0];

    expect(declaration).toBeDefined();
    expect(declaration).toContain(
      "var(--vscode-list-activeSelectionBackground, #04395e)",
    );
    expect(declaration).not.toContain(
      "var(--vscode-list-inactiveSelectionBackground)",
    );
  });
});
