import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import CodiconListFlat from "~icons/codicon/list-flat";
import CodiconListTree from "~icons/codicon/list-tree";
import { bridge } from "../shared/bridge";
import { FileTree, type FileTreeNode } from "../shared/components/FileTree";
import { useOperationRepoBinding } from "../shared/hooks/useOperationRepoBinding";
import type { DiffFile } from "../shared/types/git";
import "./rollback.css";

interface RollbackFileInfo {
  path: string;
  status: string;
  staged: boolean;
}

/**
 * Collect all leaf file paths under a FileTreeNode (recursively).
 */
function collectLeafPaths(node: FileTreeNode): string[] {
  if (node.isLeaf && node.file) {
    return [node.file.newPath || node.file.oldPath];
  }
  const paths: string[] = [];
  for (const child of node.children) {
    paths.push(...collectLeafPaths(child));
  }
  return paths;
}

export function RollbackApp() {
  const root = document.getElementById("root");
  const initialFilesJson = root?.dataset.files ?? "[]";

  const [files, setFiles] = useState<RollbackFileInfo[]>(() =>
    JSON.parse(initialFilesJson),
  );
  const [checkedFiles, setCheckedFiles] = useState<Set<string>>(
    () =>
      new Set(
        (JSON.parse(initialFilesJson) as RollbackFileInfo[]).map((f) => f.path),
      ),
  );
  const [viewMode, setViewMode] = useState<"tree" | "flat">("tree");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [deleteLocalCopies, setDeleteLocalCopies] = useState(false);
  const [rolling, setRolling] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Track rolling in a ref so the re-init event listener can read the latest
  // value without re-subscribing on every render.
  const rollingRef = useRef(rolling);
  rollingRef.current = rolling;

  // Load file list for the current repo context. Used both for the initial
  // mount (via the binding hook) and when the active repo changes.
  const loadRepo = useCallback(async () => {
    try {
      const result = (await bridge.request("getWorkingTreeChanges")) as
        | RollbackFileInfo[]
        | { status: string }
        | null;
      // not_git_repo guard
      if (!Array.isArray(result)) {
        setFiles([]);
        setCheckedFiles(new Set());
        return;
      }
      const mapped: RollbackFileInfo[] = result.map((f) => ({
        path: f.path,
        status: f.status,
        staged: f.staged,
      }));
      setFiles(mapped);
      setCheckedFiles(new Set(mapped.map((f) => f.path)));
      setError(null);
      setCollapsed({});
      setDeleteLocalCopies(false);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  // Idle-follow / execution-bound repo lifecycle: while a rollback is running,
  // active-repo changes are deferred and only the latest is applied when idle.
  useOperationRepoBinding(rolling, loadRepo);

  // Listen for re-init events (when panel is reused). Ignored while a rollback
  // is in progress so the in-flight operation is not disturbed.
  useEffect(() => {
    return bridge.onEvent((event, data) => {
      if (event !== "rollbackPanelInit") return;
      if (rollingRef.current) return;
      const { files: newFiles } = data as { files: RollbackFileInfo[] };
      setFiles(newFiles);
      setCheckedFiles(new Set(newFiles.map((f) => f.path)));
      setError(null);
      setRolling(false);
      setDeleteLocalCopies(false);
      setCollapsed({});
    });
  }, []);

  const handleToggleFile = useCallback((path: string) => {
    setCheckedFiles((prev) => {
      const next = new Set(prev);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });
  }, []);

  const handleToggleDir = useCallback((dirFiles: string[]) => {
    setCheckedFiles((prev) => {
      const next = new Set(prev);
      const allChecked = dirFiles.every((f) => next.has(f));
      for (const f of dirFiles) {
        if (allChecked) next.delete(f);
        else next.add(f);
      }
      return next;
    });
  }, []);

  const handleRollback = useCallback(async () => {
    const filePaths = [...checkedFiles];
    if (filePaths.length === 0) return;
    setRolling(true);
    setError(null);
    try {
      await bridge.request("executeRollback", {
        filePaths,
        deleteLocalCopies,
      });
      // Panel will be closed by extension host on success
    } catch (err) {
      setRolling(false);
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [checkedFiles, deleteLocalCopies]);

  const handleCancel = useCallback(() => {
    bridge.request("closeRollbackPanel");
  }, []);

  // Convert RollbackFileInfo[] to DiffFile[] for FileTree
  const diffFiles: DiffFile[] = useMemo(
    () =>
      files.map((f) => ({
        oldPath: f.path,
        newPath: f.path,
        status: f.status as DiffFile["status"],
        isBinary: false,
      })),
    [files],
  );

  return (
    <div className="rollback-container">
      {/* Header with view mode toggle */}
      <div className="rollback-header">
        <span className="rollback-title">
          {files.length} file{files.length !== 1 ? "s" : ""}
        </span>
        <span className="rollback-view-toggle">
          <button
            type="button"
            className={viewMode === "tree" ? "active" : ""}
            onClick={() => setViewMode("tree")}
            title="Tree View"
          >
            <CodiconListTree />
          </button>
          <button
            type="button"
            className={viewMode === "flat" ? "active" : ""}
            onClick={() => setViewMode("flat")}
            title="Flat List"
          >
            <CodiconListFlat />
          </button>
        </span>
      </div>

      {/* File list with checkboxes */}
      <div className="rollback-file-list">
        <FileTree
          files={diffFiles}
          viewMode={viewMode}
          selectedFiles={[]}
          onFileClick={(_e, file) =>
            handleToggleFile(file.newPath || file.oldPath)
          }
          collapsed={collapsed}
          onToggle={(key) =>
            setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }))
          }
          renderExtraColumns={(file) => {
            const filePath = file.newPath || file.oldPath;
            return (
              <input
                type="checkbox"
                checked={checkedFiles.has(filePath)}
                onChange={() => handleToggleFile(filePath)}
                onClick={(e) => e.stopPropagation()}
                style={{ order: -1 }}
              />
            );
          }}
          renderDirExtra={(dirNode) => {
            const leafPaths = collectLeafPaths(dirNode);
            const allChecked =
              leafPaths.length > 0 &&
              leafPaths.every((p) => checkedFiles.has(p));
            const someChecked =
              !allChecked && leafPaths.some((p) => checkedFiles.has(p));
            return (
              <input
                type="checkbox"
                checked={allChecked}
                ref={(el) => {
                  if (el) el.indeterminate = someChecked;
                }}
                onChange={() => handleToggleDir(leafPaths)}
                onClick={(e) => e.stopPropagation()}
                style={{ order: -1, marginRight: 4 }}
              />
            );
          }}
        />
      </div>

      {/* Footer */}
      <div className="rollback-footer">
        <label className="rollback-delete-option">
          <input
            type="checkbox"
            checked={deleteLocalCopies}
            onChange={() => setDeleteLocalCopies((prev) => !prev)}
          />
          Delete local copies of added files
        </label>
        {error && <span className="rollback-error">{error}</span>}
        <div className="rollback-actions">
          <button
            type="button"
            className="rollback-btn rollback-btn-secondary"
            onClick={handleCancel}
            disabled={rolling}
          >
            Cancel
          </button>
          <button
            type="button"
            className="rollback-btn rollback-btn-primary"
            onClick={handleRollback}
            disabled={rolling || checkedFiles.size === 0}
          >
            {rolling ? "Rolling back..." : "Rollback"}
          </button>
        </div>
      </div>
    </div>
  );
}
