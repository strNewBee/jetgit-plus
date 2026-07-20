import { render } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import type { DiffFile } from "../types/git";
import { FileTree } from "./FileTree";

const file: DiffFile = {
  oldPath: "webview/src/App.tsx",
  newPath: "webview/src/App.tsx",
  status: "modified",
  additions: 1,
  deletions: 1,
};

describe("FileTree", () => {
  it("prevents native word selection when a file row is double-clicked", () => {
    const view = render(
      <FileTree
        files={[file]}
        viewMode="tree"
        selectedFiles={[file.newPath]}
        onFileClick={vi.fn()}
      />,
    );

    const row = view.getByText("App.tsx").closest(".selectable-row");
    expect(row).not.toBeNull();
    expect((row as HTMLElement).style.userSelect).toBe("none");
    expect(row?.classList.contains("selected")).toBe(true);
  });
});
