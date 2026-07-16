import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { bridge } from "../shared/bridge";
import {
  buildFileTree,
  collectVisibleFilePaths,
  FileTree,
  STATUS_COLORS,
} from "../shared/components/FileTree";
import {
  type SelectionMode,
  useModifierClickSelection,
} from "../shared/hooks/useModifierClickSelection";
import { usePreventSelect } from "../shared/hooks/usePreventSelect";
import { useRepoBoundOperation } from "../shared/hooks/useRepoBoundOperation";
import type { DiffFile } from "../shared/types/git";

interface MergeState {
  isMerging: boolean;
  mergeHead?: string;
  mergeMsg?: string;
}

function parseMergeMsg(msg: string): { from: string; into: string } | null {
  const match = msg.match(/Merge branch '([^']+)' into (.+)/);
  if (match) {
    return { from: match[1], into: match[2] };
  }
  return null;
}

export function ConflictsApp() {
  const root = document.getElementById("root");
  // Disambiguated repo label seeded from the host (Task 25). Updated on re-init.
  // Empty when absent (single-repo / legacy) → header renders no suffix.
  const [repoName, setRepoName] = useState(
    root?.dataset.repoName?.trim() ?? "",
  );

  const [mergeState, setMergeState] = useState<MergeState | null>(null);
  const [conflictFiles, setConflictFiles] = useState<string[]>([]);
  const [loading, setLoading] = useState(true);
  // True while an Accept Yours / Accept Theirs / Merge action is in flight so
  // that active-repo changes are deferred until the mutation completes.
  const [mutating, setMutating] = useState(false);
  const [groupByDir, setGroupByDir] = useState(true);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [selectedFiles, setSelectedFiles] = useState<string[]>([]);
  const [lastSelectedFile, setLastSelectedFile] = useState<string | null>(null);

  const containerRef = usePreventSelect<HTMLDivElement>();

  // Track mutating in a ref so the re-init event listener can read the latest
  // value without re-subscribing on every render.
  const mutatingRef = useRef(mutating);
  mutatingRef.current = mutating;

  // `loadData` needs the hook's bound `request`, and the hook needs `loadData`
  // (well, a follow callback) as its idle-follow callback. Break the cycle with
  // a ref: the hook calls a stable wrapper that delegates to the latest
  // follow-path via the ref, so `loadData` can be defined AFTER the hook (and
  // thus use its `request`).
  const onFollowRef = useRef<(() => Promise<void>) | null>(null);
  const onFollowRepo = useCallback((repoId: string | null) => {
    // Task 24 (P2#10): when every repo is removed, the host broadcasts
    // activeRepoChanged{repo:null}. Don't issue a repo-bound request (there is
    // no repo to bind to); clear the displayed state instead. Otherwise the
    // bound `request` would carry repoId=undefined and the host's strict-repo
    // guard would reject it as REPO_NOT_FOUND.
    if (repoId === null) {
      setMergeState(null);
      setConflictFiles([]);
      setSelectedFiles([]);
      setLastSelectedFile(null);
      setLoading(false);
      return;
    }
    // Delegate to the latest follow-path; no-op if it hasn't been assigned yet.
    // The repoId is ignored here because the bound `request` already carries
    // the authoritative repo (the hook bumped bridge context before calling).
    return onFollowRef.current?.();
  }, []);

  // Authoritative repo binding + bound request. `busy = loading || mutating`
  // (Accept/Merge are mutating → idle-follow is suppressed during them, so an
  // active-repo change can't rebind the bridge away mid-mutation). Every
  // repo-bound request goes through `request` so it carries the panel's
  // authoritative repoId.
  const { request, bindRepo } = useRepoBoundOperation(
    loading || mutating,
    onFollowRepo,
  );

  // Load merge state + conflict files for the bound repo. Used for the initial
  // mount, the idle-follow path, and the host-driven re-init. Every request
  // goes through the bound `request` so it carries the panel's authoritative
  // repoId.
  const loadData = useCallback(async () => {
    try {
      const [state, files] = await Promise.all([
        request("getMergeState") as Promise<MergeState>,
        request("getConflictFiles") as Promise<string[]>,
      ]);
      setMergeState(state);
      setConflictFiles(files);
    } finally {
      setLoading(false);
    }
  }, [request]);

  useEffect(() => {
    loadData();
  }, [loadData]);

  // Idle-follow / execution-bound repo lifecycle. While loading or mutating,
  // active-repo changes are deferred; the latest pending repo is applied once
  // idle (clearing the selection and reloading conflict data for the new repo).
  // Wired via the ref so it can use the hook's bound `request` indirectly.
  onFollowRef.current = async () => {
    setSelectedFiles([]);
    setLastSelectedFile(null);
    setLoading(true);
    await loadData();
  };

  // Listen for re-init events (when panel is reused). Ignored while an Accept /
  // Merge is in progress so the in-flight mutation is not disturbed. This is
  // the authoritative rebind path: bindRepo(payload.repoId) sets the panel's
  // repo (and bumps the bridge context synchronously) so subsequent requests
  // target the newly revealed repo, not whatever the ambient context was bound
  // to. The conflict list is reloaded through the bound request (NOT the raw
  // payload) so the displayed files are guaranteed to match the bound repo.
  useEffect(() => {
    return bridge.onEvent((event, data) => {
      if (event !== "conflictsPanelInit") return;
      if (mutatingRef.current) return;
      const payload = data as { repoId?: string; repoName?: string };
      // Rebind to the host-supplied repo FIRST (bumps generation so any stale
      // in-flight response from the previous repo is dropped), then reload via
      // the bound request.
      if (payload.repoId !== undefined) {
        bindRepo(payload.repoId);
      }
      // Update the header repo label for the newly-targeted repo (Task 25).
      if (payload.repoName !== undefined) {
        setRepoName(payload.repoName.trim());
      }
      setSelectedFiles([]);
      setLastSelectedFile(null);
      setLoading(true);
      void loadData();
    });
  }, [loadData, bindRepo]);

  // Convert string[] to DiffFile[]
  const diffFiles: DiffFile[] = useMemo(
    () =>
      conflictFiles.map((f) => ({
        oldPath: f,
        newPath: f,
        status: "modified" as const,
        isBinary: false,
      })),
    [conflictFiles],
  );

  const viewMode = groupByDir ? "tree" : "flat";

  // Compute flat visible file paths for range selection
  const tree = useMemo(() => buildFileTree(diffFiles), [diffFiles]);
  const flatVisibleFiles = useMemo(
    () =>
      viewMode === "tree"
        ? collectVisibleFilePaths(tree, collapsed)
        : [...conflictFiles].sort((a, b) => {
            const nameA = a.split("/").pop() ?? "";
            const nameB = b.split("/").pop() ?? "";
            return nameA.localeCompare(nameB, undefined, {
              sensitivity: "base",
            });
          }),
    [viewMode, tree, collapsed, conflictFiles],
  );

  const handleSelect = useCallback(
    (file: DiffFile, mode: SelectionMode) => {
      const filePath = file.newPath || file.oldPath;

      if (mode === "single") {
        setSelectedFiles([filePath]);
      } else if (mode === "toggle") {
        setSelectedFiles((prev) =>
          prev.includes(filePath)
            ? prev.filter((f) => f !== filePath)
            : [...prev, filePath],
        );
      } else if (mode === "range") {
        if (!lastSelectedFile) {
          setSelectedFiles([filePath]);
        } else {
          const startIdx = flatVisibleFiles.indexOf(lastSelectedFile);
          const endIdx = flatVisibleFiles.indexOf(filePath);
          if (startIdx === -1 || endIdx === -1) {
            setSelectedFiles([filePath]);
          } else {
            const lo = Math.min(startIdx, endIdx);
            const hi = Math.max(startIdx, endIdx);
            setSelectedFiles(flatVisibleFiles.slice(lo, hi + 1));
          }
        }
      }

      setLastSelectedFile(filePath);
    },
    [lastSelectedFile, flatVisibleFiles],
  );

  const handleFileClick = useModifierClickSelection<DiffFile>(handleSelect);

  const toggleCollapse = (key: string) => {
    setCollapsed((prev) => ({ ...prev, [key]: !prev[key] }));
  };

  // Batch actions
  const handleAcceptYours = useCallback(async () => {
    setMutating(true);
    try {
      for (const filePath of selectedFiles) {
        await request("acceptOurs", { filePath });
      }
      setConflictFiles((prev) =>
        prev.filter((f) => !selectedFiles.includes(f)),
      );
      setSelectedFiles([]);
    } finally {
      setMutating(false);
    }
  }, [selectedFiles, request]);

  const handleAcceptTheirs = useCallback(async () => {
    setMutating(true);
    try {
      for (const filePath of selectedFiles) {
        await request("acceptTheirs", { filePath });
      }
      setConflictFiles((prev) =>
        prev.filter((f) => !selectedFiles.includes(f)),
      );
      setSelectedFiles([]);
    } finally {
      setMutating(false);
    }
  }, [selectedFiles, request]);

  const openMergeEditor = useCallback(
    async (filePath: string) => {
      await request("openMergeEditor", { file: filePath });
    },
    [request],
  );

  const handleMerge = useCallback(async () => {
    if (selectedFiles.length <= 0) return;
    setMutating(true);
    try {
      await openMergeEditor(selectedFiles[0]);
    } finally {
      setMutating(false);
    }
  }, [selectedFiles, openMergeEditor]);

  // Extra columns: Yours / Theirs status
  const renderExtraColumns = useCallback(
    (_file: DiffFile) => (
      <>
        <span
          style={{
            marginLeft: "auto",
            fontSize: 11,
            color: STATUS_COLORS.conflicts,
            flexShrink: 0,
            minWidth: 60,
            textAlign: "center",
          }}
        >
          Modified
        </span>
        <span
          style={{
            fontSize: 11,
            color: STATUS_COLORS.conflicts,
            flexShrink: 0,
            minWidth: 60,
            textAlign: "center",
          }}
        >
          Modified
        </span>
      </>
    ),
    [],
  );

  if (loading) {
    return (
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "center",
          height: "100%",
          opacity: 0.5,
        }}
      >
        Loading...
      </div>
    );
  }

  const branchInfo = mergeState?.mergeMsg
    ? parseMergeMsg(mergeState.mergeMsg)
    : null;

  const hasSelection = selectedFiles.length > 0;

  return (
    <div
      ref={containerRef}
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        fontFamily: "var(--font-family)",
        userSelect: "none",
      }}
    >
      {/* Header */}
      <div style={{ padding: "12px 16px 8px", flexShrink: 0 }}>
        <h2
          style={{
            fontSize: 16,
            fontWeight: 700,
            margin: 0,
            marginBottom: 4,
          }}
        >
          Conflicts{repoName ? ` — ${repoName}` : ""}
        </h2>
        <p style={{ margin: 0, fontSize: 13, opacity: 0.8 }}>
          {branchInfo ? (
            <>
              Merging branch <strong>{branchInfo.from}</strong> into{" "}
              <strong>{branchInfo.into}</strong>
            </>
          ) : mergeState?.isMerging ? (
            <>Merge in progress</>
          ) : (
            <>No merge in progress</>
          )}
        </p>
        {conflictFiles.length > 0 && (
          <p style={{ margin: 0, marginTop: 4, fontSize: 12, opacity: 0.6 }}>
            {conflictFiles.length} file{conflictFiles.length > 1 ? "s" : ""}{" "}
            with conflicts
          </p>
        )}
        <label
          style={{
            display: "flex",
            alignItems: "center",
            gap: 6,
            fontSize: 12,
            marginTop: 8,
          }}
        >
          <input
            type="checkbox"
            checked={groupByDir}
            onChange={(e) => setGroupByDir(e.target.checked)}
          />
          Group files by directory
        </label>
      </div>

      {/* Main body */}
      {conflictFiles.length === 0 ? (
        <div
          style={{
            flex: 1,
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            opacity: 0.5,
          }}
        >
          All conflicts resolved
        </div>
      ) : (
        <div
          style={{
            flex: 1,
            display: "flex",
            minHeight: 0,
            borderTop: "1px solid var(--border)",
          }}
        >
          {/* Left: column headers + file tree */}
          <div
            style={{
              flex: 1,
              display: "flex",
              flexDirection: "column",
              minWidth: 0,
              overflow: "hidden",
            }}
          >
            {/* Column header */}
            <div
              style={{
                display: "flex",
                alignItems: "center",
                padding: "4px 12px",
                fontSize: 12,
                fontWeight: 600,
                opacity: 0.7,
                borderBottom: "1px solid var(--border)",
                flexShrink: 0,
              }}
            >
              <span style={{ flex: 1 }}>Name</span>
              <span
                style={{
                  minWidth: 60,
                  textAlign: "center",
                  flexShrink: 0,
                }}
              >
                Yours
              </span>
              <span
                style={{
                  minWidth: 60,
                  textAlign: "center",
                  flexShrink: 0,
                }}
              >
                Theirs
              </span>
            </div>
            {/* File tree */}
            <div style={{ flex: 1, overflow: "auto" }}>
              <FileTree
                files={diffFiles}
                viewMode={viewMode}
                selectedFiles={selectedFiles}
                onFileClick={handleFileClick}
                onFileDoubleClick={(file) => {
                  const filePath = file.newPath || file.oldPath;
                  openMergeEditor(filePath);
                }}
                collapsed={collapsed}
                onToggle={toggleCollapse}
                renderExtraColumns={renderExtraColumns}
                statusColorOverride={() => STATUS_COLORS.conflicts}
              />
            </div>
          </div>

          {/* Right: action buttons */}
          <div
            style={{
              width: 130,
              flexShrink: 0,
              display: "flex",
              flexDirection: "column",
              gap: 6,
              padding: "12px 12px",
              borderLeft: "1px solid var(--border)",
            }}
          >
            <ActionButton disabled={!hasSelection} onClick={handleAcceptYours}>
              Accept Yours
            </ActionButton>
            <ActionButton disabled={!hasSelection} onClick={handleAcceptTheirs}>
              Accept Theirs
            </ActionButton>
            <ActionButton
              disabled={!hasSelection}
              onClick={handleMerge}
              primary
            >
              Merge...
            </ActionButton>
          </div>
        </div>
      )}
    </div>
  );
}

function ActionButton({
  onClick,
  children,
  primary,
  disabled,
}: {
  onClick: () => void;
  children: React.ReactNode;
  primary?: boolean;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      style={{
        padding: "4px 10px",
        fontSize: 12,
        fontFamily: "var(--font-family)",
        border: "1px solid var(--border)",
        background: primary ? "var(--button-bg)" : "transparent",
        color: primary ? "var(--button-fg)" : "var(--app-fg)",
        cursor: disabled ? "default" : "pointer",
        borderRadius: 3,
        lineHeight: "20px",
        whiteSpace: "nowrap",
        opacity: disabled ? 0.4 : 1,
        width: "100%",
      }}
    >
      {children}
    </button>
  );
}
