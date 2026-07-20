import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { WorkingTreeFile } from "../../shared/store/commit-store";
import { FileItem } from "./FileItem";

const file: WorkingTreeFile = {
  path: "config.yaml",
  status: "modified",
  staged: false,
};

describe("FileItem", () => {
  it("highlights the full file row without native word selection", () => {
    const view = render(
      <FileItem
        file={file}
        selected={false}
        highlighted
        onToggle={vi.fn()}
        onContextMenu={vi.fn()}
        onShowDiff={vi.fn()}
        onClick={vi.fn()}
      />,
    );

    const row = view.getByText("config.yaml").closest(".commit-file-item");
    expect(row).not.toBeNull();
    expect((row as HTMLElement).style.userSelect).toBe("none");
    expect((row as HTMLElement).style.background).toBe(
      "var(--vscode-list-activeSelectionBackground, #04395e)",
    );
    expect((row as HTMLElement).style.color).toBe(
      "var(--vscode-list-activeSelectionForeground, #fff)",
    );
  });
});
