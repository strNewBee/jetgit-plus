import { useCallback, useRef, useState } from "react";
import CodiconListFlat from "~icons/codicon/list-flat";
import CodiconListTree from "~icons/codicon/list-tree";
import { FileTree } from "../../shared/components/FileTree";
import { Tooltip } from "../../shared/components/Tooltip";
import "../../shared/components/Tooltip.css";
import { useGitLogStore } from "../../shared/store/git-log-store-context";
import type { DiffFile } from "../../shared/types/git";
import { FileContextMenu } from "./FileContextMenu";

export function FileChangeTree() {
  const commitFiles = useGitLogStore((s) => s.commitFiles);
  const selectedFilePath = useGitLogStore((s) => s.selectedFilePath);
  const selectedCommitHash = useGitLogStore((s) => s.selectedCommitHash);
  const selectFile = useGitLogStore((s) => s.selectFile);
  const openDiffEditor = useGitLogStore((s) => s.openDiffEditor);
  const lastClickRef = useRef<{ path: string; time: number }>({
    path: "",
    time: 0,
  });

  const [viewMode, setViewMode] = useState<"tree" | "flat">("tree");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [contextMenu, setContextMenu] = useState<{
    x: number;
    y: number;
    file: DiffFile;
  } | null>(null);

  const handleFileClick = useCallback(
    (_e: React.MouseEvent, file: DiffFile) => {
      const now = Date.now();
      const last = lastClickRef.current;
      const filePath = file.newPath || file.oldPath;

      if (last.path === filePath && now - last.time < 400) {
        if (selectedCommitHash) {
          openDiffEditor(selectedCommitHash, file);
        }
        lastClickRef.current = { path: "", time: 0 };
      } else {
        selectFile(filePath);
        lastClickRef.current = { path: filePath, time: now };
      }
    },
    [selectedCommitHash, selectFile, openDiffEditor],
  );

  const handleFileContextMenu = useCallback(
    (e: React.MouseEvent, file: DiffFile) => {
      setContextMenu({ x: e.clientX, y: e.clientY, file });
    },
    [],
  );

  const closeContextMenu = useCallback(() => {
    setContextMenu(null);
  }, []);

  const toggleCollapse = (key: string) => {
    setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  const filter = useGitLogStore((s) => s.filter);

  // When file filter is active, only show that file
  const displayFiles = filter.file
    ? commitFiles.filter((f) => (f.newPath || f.oldPath) === filter.file)
    : commitFiles;

  if (displayFiles.length === 0 && commitFiles.length === 0) {
    return (
      <div style={{ padding: 12, opacity: 0.5 }}>
        Select a commit to see changed files
      </div>
    );
  }

  if (displayFiles.length === 0 && filter.file) {
    return (
      <div style={{ padding: 12, opacity: 0.5 }}>
        No changes to {filter.file.split("/").pop()} in this commit
      </div>
    );
  }

  const selectedFiles = selectedFilePath ? [selectedFilePath] : [];

  return (
    <div style={{ display: "flex", flexDirection: "column", height: "100%" }}>
      {/* Fixed header — does not scroll */}
      <div
        style={{
          padding: "6px 12px",
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          flexShrink: 0,
        }}
      >
        <span
          style={{
            fontWeight: 600,
            fontSize: "0.8em",
            opacity: 0.6,
            textTransform: "uppercase",
          }}
        >
          Changed Files
        </span>
        <span style={{ display: "flex", gap: 2 }}>
          <Tooltip text="Tree View">
            <button
              type="button"
              onClick={() => setViewMode("tree")}
              style={{
                background:
                  viewMode === "tree" ? "var(--selected-bg)" : "transparent",
                border: "none",
                borderRadius: 3,
                cursor: "pointer",
                padding: "2px 4px",
                display: "flex",
                alignItems: "center",
                color: "inherit",
              }}
            >
              <CodiconListTree />
            </button>
          </Tooltip>
          <Tooltip text="Flat List">
            <button
              type="button"
              onClick={() => setViewMode("flat")}
              style={{
                background:
                  viewMode === "flat" ? "var(--selected-bg)" : "transparent",
                border: "none",
                borderRadius: 3,
                cursor: "pointer",
                padding: "2px 4px",
                display: "flex",
                alignItems: "center",
                color: "inherit",
              }}
            >
              <CodiconListFlat />
            </button>
          </Tooltip>
        </span>
      </div>

      {/* Scrollable content area */}
      <div style={{ flex: 1, overflow: "auto", overflowX: "hidden" }}>
        <FileTree
          files={displayFiles}
          viewMode={viewMode}
          selectedFiles={selectedFiles}
          onFileClick={handleFileClick}
          onFileContextMenu={handleFileContextMenu}
          collapsed={collapsed}
          onToggle={toggleCollapse}
        />
      </div>
      {contextMenu && (
        <FileContextMenu
          x={contextMenu.x}
          y={contextMenu.y}
          file={contextMenu.file}
          onClose={closeContextMenu}
        />
      )}
    </div>
  );
}
