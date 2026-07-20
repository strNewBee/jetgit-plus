import { fireEvent, render } from "@testing-library/react";
import { useState } from "react";
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

  it("renders a selected changed file with the full selection colors", () => {
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
    expect((row as HTMLElement).style.background).toBe(
      "var(--vscode-list-activeSelectionBackground, #04395e)",
    );
    expect((row as HTMLElement).style.color).toBe(
      "var(--vscode-list-activeSelectionForeground, #fff)",
    );
  });

  it("shows an accessible chevron and toggles a directory from the full row", () => {
    function ControlledTree() {
      const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
      return (
        <FileTree
          files={[file]}
          viewMode="tree"
          selectedFiles={[]}
          onFileClick={vi.fn()}
          collapsed={collapsed}
          onToggle={(key) =>
            setCollapsed((previous) => ({
              ...previous,
              [key]: !previous[key],
            }))
          }
        />
      );
    }

    const view = render(<ControlledTree />);
    const directory = view.getByText("webview/src").closest("[role=treeitem]");

    expect(directory).not.toBeNull();
    expect(directory?.getAttribute("aria-expanded")).toBe("true");
    expect(directory?.querySelector("[data-file-tree-chevron]")).not.toBeNull();
    expect(view.queryByText("App.tsx")).not.toBeNull();

    fireEvent.click(directory as HTMLElement);
    expect(directory?.getAttribute("aria-expanded")).toBe("false");
    expect(view.queryByText("App.tsx")).toBeNull();

    fireEvent.keyDown(directory as HTMLElement, { key: "Enter" });
    expect(directory?.getAttribute("aria-expanded")).toBe("true");
    expect(view.queryByText("App.tsx")).not.toBeNull();
  });

  it("keeps flat mode free of directory disclosure controls", () => {
    const view = render(
      <FileTree
        files={[file]}
        viewMode="flat"
        selectedFiles={[]}
        onFileClick={vi.fn()}
      />,
    );

    expect(view.container.querySelector("[data-file-tree-chevron]")).toBeNull();
  });
});
