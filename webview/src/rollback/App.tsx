import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import CodiconListFlat from "~icons/codicon/list-flat";
import CodiconListTree from "~icons/codicon/list-tree";
import { bridge } from "../shared/bridge";
import { FileTree, type FileTreeNode } from "../shared/components/FileTree";
import { useRepoBoundOperation } from "../shared/hooks/useRepoBoundOperation";
import type { DiffFile } from "../shared/types/git";
import "./rollback.css";

export interface RollbackFileInfo {
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

  // `loadRepo` needs the hook's bound `request`, and the hook needs `loadRepo`
  // as its idle-follow callback. Break the cycle with a ref: the hook calls a
  // stable wrapper that delegates to the latest `loadRepo` via the ref, so
  // `loadRepo` can be defined AFTER the hook (and thus use its `request`).
  const loadRepoRef = useRef<(() => Promise<void>) | null>(null);
  const onFollowRepo = useCallback((repoId: string | null) => {
    // Task 24 (P2#10): when every repo is removed, the host broadcasts
    // activeRepoChanged{repo:null}. Don't issue a repo-bound request (there is
    // no repo to bind to); clear the displayed state instead. Otherwise the
    // bound `request` would carry repoId=undefined and the host's strict-repo
    // guard would reject it as REPO_NOT_FOUND.
    if (repoId === null) {
      setFiles([]);
      setCheckedFiles(new Set());
      return;
    }
    // Delegate to the latest loadRepo; no-op if it hasn't been assigned yet.
    // The repoId is ignored here because the bound `request` already carries
    // the authoritative repo (the hook bumped bridge context before calling).
    return loadRepoRef.current?.();
  }, []);

  // Authoritative repo binding + bound request. `busy = rolling` (rollback is
  // atomic — no rejected/recovery flow). Every repo-bound request goes through
  // `request` so it carries the panel's authoritative repoId.
  const { request, bindRepo } = useRepoBoundOperation(rolling, onFollowRepo);

  // Load file list for the bound repo. Used both for the initial idle-follow
  // (via the hook) and when the active repo changes. Every request goes through
  // the bound `request` so it carries the panel's authoritative repoId.
  const loadRepo = useCallback(async () => {
    try {
      const result = (await request("getWorkingTreeChanges")) as
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
  }, [request]);
  // Wire the ref so the hook's onFollow wrapper reaches the real loadRepo.
  loadRepoRef.current = loadRepo;

  // Listen for re-init events (when panel is reused). Ignored while a rollback
  // is in progress so the in-flight operation is not disturbed. This is the
  // authoritative rebind path: bindRepo(payload.repoId) sets the panel's repo
  // (and bumps the bridge context synchronously) so subsequent requests target
  // the newly revealed repo, not whatever the ambient context was bound to. The
  // file list is reloaded through the bound request (NOT the raw payload) so
  // the displayed files are guaranteed to match the bound repo.
  useEffect(() => {
    return bridge.onEvent((event, data) => {
      if (event !== "rollbackPanelInit") return;
      if (rollingRef.current) return;
      const payload = data as { repoId?: string; files?: RollbackFileInfo[] };
      // Rebind to the host-supplied repo FIRST (bumps generation so any stale
      // in-flight response from the previous repo is dropped), then reload the
      // file list through the bound request. The payload may seed initial
      // display, but the authoritative list comes from getWorkingTreeChanges
      // stamped with the bound repoId.
      if (payload.repoId !== undefined) {
        bindRepo(payload.repoId);
      }
      setError(null);
      setRolling(false);
      setDeleteLocalCopies(false);
      setCollapsed({});
      void loadRepo();
    });
  }, [loadRepo, bindRepo]);

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
      await request("executeRollback", {
        filePaths,
        deleteLocalCopies,
      });
      // Panel will be closed by extension host on success
    } catch (err) {
      setRolling(false);
      setError(err instanceof Error ? err.message : String(err));
    }
  }, [checkedFiles, deleteLocalCopies, request]);

  const handleCancel = useCallback(() => {
    // Repo-agnostic control-plane call → { scope: "global" } (no repoId).
    bridge.request("closeRollbackPanel", {}, { scope: "global" });
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
