import { Allotment } from "allotment";
import { useCallback, useEffect, useRef, useState } from "react";
import CodiconListFlat from "~icons/codicon/list-flat";
import CodiconListTree from "~icons/codicon/list-tree";
import { bridge } from "../shared/bridge";
import { CommitInfo } from "../shared/components/CommitInfo";
import { FileTree } from "../shared/components/FileTree";
import { useRepoBoundOperation } from "../shared/hooks/useRepoBoundOperation";
import type { BranchInfo, Commit, DiffFile } from "../shared/types/git";
import { RemoteBranchSelector } from "./components/RemoteBranchSelector";
import { useDraggableDivider } from "./hooks/useDraggableDivider";
import { formatRemoteBranchLabel } from "./utils/branchUtils";
import "./push.css";

interface PushRejectedState {
  show: boolean;
  branchName: string;
}

function PushRejectedDialog({
  branchName,
  onRebase,
  onMerge,
  onCancel,
}: {
  branchName: string;
  onRebase: () => void;
  onMerge: () => void;
  onCancel: () => void;
}) {
  return (
    <div className="push-rejected-overlay">
      <div className="push-rejected-dialog">
        <div className="push-rejected-header">
          <span className="push-rejected-icon">⚠️</span>
          <span className="push-rejected-title">Push Rejected</span>
        </div>
        <p className="push-rejected-message">
          Push of the current branch "{branchName}" was rejected. Remote changes
          need to be merged before pushing.
        </p>
        <div className="push-rejected-actions">
          <button
            type="button"
            className="push-btn push-btn-secondary"
            onClick={onCancel}
          >
            Cancel
          </button>
          <button
            type="button"
            className="push-btn push-btn-rebase"
            onClick={onRebase}
          >
            Rebase
          </button>
          <button
            type="button"
            className="push-btn push-btn-merge"
            onClick={onMerge}
          >
            Merge
          </button>
        </div>
      </div>
    </div>
  );
}

export function PushApp() {
  const root = document.getElementById("root");
  const initialBranch = root?.dataset.branch ?? "";
  const initialRemote = root?.dataset.remote ?? "origin";
  // Disambiguated repo label seeded from the host (Task 25). Updated on re-init.
  // Empty string when absent (single-repo / legacy) → header renders no suffix.
  const [repoName, setRepoName] = useState(
    root?.dataset.repoName?.trim() ?? "",
  );

  // branchName is now state so it can be reloaded when the active repo changes
  // (via useRepoBoundOperation). It is seeded from the host-supplied dataset
  // on first mount. The editable remote target (targetRemote) is derived from
  // the current branch's upstream and updated alongside branchName.
  const [branchName, setBranchName] = useState(initialBranch);

  const [commits, setCommits] = useState<Commit[]>([]);
  const [selectedHash, setSelectedHash] = useState<string | null>(null);
  const [files, setFiles] = useState<DiffFile[]>([]);
  const [pushing, setPushing] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showPushMenu, setShowPushMenu] = useState(false);
  const [pushRejected, setPushRejected] = useState<PushRejectedState>({
    show: false,
    branchName: "",
  });

  // Editable remote branch target state
  const [targetRemote, setTargetRemote] = useState(initialRemote);
  const [targetBranch, setTargetBranch] = useState(initialBranch);
  const [selectorOpen, setSelectorOpen] = useState(false);
  const [viewMode, setViewMode] = useState<"tree" | "flat">("tree");
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const headerRef = useRef<HTMLDivElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const { leftWidthPercent, isDragging, dividerProps } =
    useDraggableDivider(bodyRef);

  // Track pushing in a ref so the re-init event listener can read the latest
  // value without re-subscribing on every render.
  const pushingRef = useRef(pushing);
  pushingRef.current = pushing;

  // Snapshot of the push context captured at the moment a push was rejected.
  // The recovery handlers (rebase/merge-and-push) use THESE captured values via
  // the bound `request` so they target the repo/branch that was rejected even
  // if the active repo changed while the rejected dialog was open. `null` while
  // no recovery is pending.
  const rejectedContextRef = useRef<{
    branchName: string;
    targetRemote: string;
    targetBranch: string;
  } | null>(null);

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
      setBranchName("");
      setTargetBranch("");
      setTargetRemote("origin");
      setCommits([]);
      setSelectedHash(null);
      setFiles([]);
      return;
    }
    // Delegate to the latest loadRepo; no-op if it hasn't been assigned yet.
    // The repoId is ignored here because the bound `request` already carries
    // the authoritative repo (the hook bumped bridge context before calling).
    return loadRepoRef.current?.();
  }, []);

  // Authoritative repo binding + bound request. The busy flag includes the
  // rejected dialog so idle-follow stays suppressed while the user decides how
  // to recover — otherwise switching the active repo mid-dialog would re-bind
  // the bridge away from the rejected repo before the recovery handler runs.
  // `busy = pushing || pushRejected.show`.
  const { request, bindRepo } = useRepoBoundOperation(
    pushing || pushRejected.show,
    onFollowRepo,
  );

  const loadAheadCommits = useCallback(
    async (branch: string, remote: string) => {
      try {
        const result = (await request("getAheadCommits", {
          branchName: branch,
          remote,
        })) as { commits: Commit[] } | null;
        const list = result?.commits ?? [];
        setCommits(list);
        if (list.length > 0) {
          setSelectedHash(list[0].hash);
        } else {
          setSelectedHash(null);
        }
      } catch (err) {
        console.error("Failed to load ahead commits:", err);
      }
    },
    // `request` is stable from the hook (useCallback, [] deps), but it is a
    // render-scoped binding, so list it for correctness if it ever changes.
    [request],
  );

  // (Re)load repo-specific data: current branch, derived remote, ahead commits.
  // Used whenever the active repo changes while idle. Every request goes
  // through the bound `request` so it carries the panel's authoritative repoId.
  const loadRepo = useCallback(async () => {
    try {
      const result = (await request("getBranches")) as
        | BranchInfo[]
        | { status: string }
        | null;
      if (!Array.isArray(result)) {
        setBranchName("");
        setTargetBranch("");
        setTargetRemote("origin");
        setCommits([]);
        setSelectedHash(null);
        setFiles([]);
        return;
      }
      const current = result.find((b) => b.isCurrent);
      const branch = current?.name ?? "";
      const remote = current?.upstream?.split("/")[0] ?? "origin";
      setBranchName(branch);
      setTargetBranch(branch);
      setTargetRemote(remote);
      // Clear commit / file selection before reloading ahead commits.
      setSelectedHash(null);
      setFiles([]);
      setCollapsed({});
      await loadAheadCommits(branch, remote);
    } catch (err) {
      console.error("Failed to load repo for push panel:", err);
    }
  }, [request, loadAheadCommits]);
  // Wire the ref so the hook's onFollow wrapper reaches the real loadRepo.
  loadRepoRef.current = loadRepo;

  // Initial load of ahead commits for the host-supplied branch/remote.
  useEffect(() => {
    if (!initialBranch) return;
    loadAheadCommits(initialBranch, initialRemote);
  }, [initialBranch, initialRemote, loadAheadCommits]);

  // Listen for re-init events (when panel is reused). Ignored while a push is
  // in progress so the in-flight operation is not disturbed. This is the
  // authoritative rebind path: bindRepo(payload.repoId) sets the panel's repo
  // (and bumps the bridge context synchronously) so subsequent requests target
  // the newly revealed repo, not whatever the ambient context was bound to.
  useEffect(() => {
    return bridge.onEvent((event, data) => {
      if (event !== "pushPanelInit") return;
      if (pushingRef.current) return;
      const payload = data as {
        branchName?: string;
        remote?: string;
        repoId?: string;
        repoName?: string;
      };
      // Rebind to the host-supplied repo FIRST (bumps generation so any stale
      // in-flight response from the previous repo is dropped), then apply the
      // branch/remote and reload ahead commits through the bound request.
      if (payload.repoId !== undefined) {
        bindRepo(payload.repoId);
      }
      // Update the header repo label for the newly-targeted repo (Task 25).
      if (payload.repoName !== undefined) {
        setRepoName(payload.repoName.trim());
      }
      const branch = payload.branchName ?? "";
      const remote = payload.remote ?? "origin";
      setBranchName(branch);
      setTargetBranch(branch);
      setTargetRemote(remote);
      setSelectedHash(null);
      setFiles([]);
      setCollapsed({});
      void loadAheadCommits(branch, remote);
    });
  }, [loadAheadCommits, bindRepo]);

  useEffect(() => {
    if (!selectedHash) {
      setFiles([]);
      return;
    }
    async function load() {
      try {
        const result = (await request("getCommitRangeFiles", {
          hashes: [selectedHash],
        })) as DiffFile[] | null;
        setFiles(result ?? []);
      } catch (err) {
        console.error("Failed to load commit files:", err);
      }
    }
    load();
  }, [selectedHash, request]);

  const handlePush = useCallback(
    async (force = false) => {
      setPushing(true);
      setError(null);
      try {
        const result = (await request("executePush", {
          branchName,
          remote: targetRemote,
          targetBranch: targetBranch,
          force,
        })) as { data?: { output?: string; isUpToDate?: boolean } };
        setPushing(false);
        const isUpToDate = result?.data?.isUpToDate;
        const message = isUpToDate
          ? "Everything is up to date"
          : `Pushed ${commits.length} commit${commits.length !== 1 ? "s" : ""} to ${targetRemote}/${targetBranch}`;
        // Show VS Code native notification then close. These are repo-agnostic
        // control-plane calls → { scope: "global" } (no repoId attached).
        bridge
          .request("showInfoNotification", { message }, { scope: "global" })
          .catch(() => {});
        setTimeout(() => {
          bridge.request("closePushPanel", {}, { scope: "global" });
        }, 500);
      } catch (err) {
        setPushing(false);
        const msg = err instanceof Error ? err.message : String(err);
        // Detect push rejected due to non-fast-forward. Capture the push
        // context BEFORE flipping pushing=false so the recovery handlers target
        // exactly the repo/branch that was rejected even if the active repo
        // later changes while the dialog is open.
        if (
          msg.includes("non-fast-forward") ||
          msg.includes("[rejected]") ||
          msg.includes("failed to push some refs")
        ) {
          rejectedContextRef.current = {
            branchName,
            targetRemote,
            targetBranch,
          };
          setPushRejected({ show: true, branchName });
          setError(msg);
        } else {
          setError(msg);
          bridge
            .request(
              "showErrorNotification",
              { message: msg },
              {
                scope: "global",
              },
            )
            .catch(() => {});
        }
      }
    },
    [branchName, targetRemote, targetBranch, commits.length, request],
  );

  const handleRebaseAndPush = useCallback(async () => {
    const ctx = rejectedContextRef.current;
    if (!ctx) return;
    setPushRejected({ show: false, branchName: "" });
    setError(null);
    setPushing(true);
    try {
      await request("pullRebase", { branchName: ctx.branchName });
      // After successful rebase, retry push using the CAPTURED target so the
      // recovery stays on the rejected repo/branch.
      await request("executePush", {
        branchName: ctx.branchName,
        remote: ctx.targetRemote,
        targetBranch: ctx.targetBranch,
        force: false,
      });
      rejectedContextRef.current = null;
      setPushing(false);
      const message = `Rebased and pushed to ${ctx.targetRemote}/${ctx.targetBranch}`;
      bridge
        .request("showInfoNotification", { message }, { scope: "global" })
        .catch(() => {});
      setTimeout(() => {
        bridge.request("closePushPanel", {}, { scope: "global" });
      }, 500);
    } catch (err) {
      setPushing(false);
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      bridge
        .request("showErrorNotification", { message: msg }, { scope: "global" })
        .catch(() => {});
    }
  }, [request]);

  const handleMergeAndPush = useCallback(async () => {
    const ctx = rejectedContextRef.current;
    if (!ctx) return;
    setPushRejected({ show: false, branchName: "" });
    setError(null);
    setPushing(true);
    try {
      await request("pullMerge", { branchName: ctx.branchName });
      // After successful merge, retry push using the CAPTURED target.
      await request("executePush", {
        branchName: ctx.branchName,
        remote: ctx.targetRemote,
        targetBranch: ctx.targetBranch,
        force: false,
      });
      rejectedContextRef.current = null;
      setPushing(false);
      const message = `Merged and pushed to ${ctx.targetRemote}/${ctx.targetBranch}`;
      bridge
        .request("showInfoNotification", { message }, { scope: "global" })
        .catch(() => {});
      setTimeout(() => {
        bridge.request("closePushPanel", {}, { scope: "global" });
      }, 500);
    } catch (err) {
      setPushing(false);
      const msg = err instanceof Error ? err.message : String(err);
      setError(msg);
      bridge
        .request("showErrorNotification", { message: msg }, { scope: "global" })
        .catch(() => {});
    }
  }, [request]);

  const handleBranchSelect = useCallback((branch: string) => {
    setTargetBranch(branch);
    setSelectorOpen(false);
  }, []);

  const handleRemoteSelect = useCallback(
    (remote: string) => {
      setTargetRemote(remote);
      // Reloading ahead commits against the newly chosen remote mirrors the
      // previous effect that was keyed on [branchName, targetRemote].
      void loadAheadCommits(targetBranch, remote);
    },
    [loadAheadCommits, targetBranch],
  );

  const handleSelectorClose = useCallback(() => {
    setSelectorOpen(false);
  }, []);

  const handleLabelClick = useCallback(() => {
    setSelectorOpen((prev) => !prev);
  }, []);

  // Clear the captured recovery context when the rejected dialog is dismissed
  // (Cancel) so a stale snapshot can't be reused by a later recovery attempt.
  const handleRejectedCancel = useCallback(() => {
    rejectedContextRef.current = null;
    setPushRejected({ show: false, branchName: "" });
  }, []);

  const selectedCommit = commits.find((c) => c.hash === selectedHash);

  return (
    <div className="push-container">
      {/* Header */}
      <div className="push-header" ref={headerRef}>
        {repoName && <span className="push-repo-name">{repoName}</span>}
        <span className="push-route">
          {branchName} →{" "}
          <span
            className="push-route-target push-route-target--interactive"
            onClick={handleLabelClick}
            role="button"
            tabIndex={0}
            onKeyDown={(e) => {
              if (e.key === "Enter" || e.key === " ") {
                e.preventDefault();
                handleLabelClick();
              }
            }}
          >
            {formatRemoteBranchLabel(targetRemote, targetBranch)}
            <svg
              className="push-route-target__indicator"
              width="10"
              height="10"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <polyline points="4,6 8,10 12,6" />
            </svg>
          </span>
        </span>
        {selectorOpen && (
          <RemoteBranchSelector
            currentRemote={targetRemote}
            currentBranch={targetBranch}
            onRemoteChange={handleRemoteSelect}
            onBranchChange={handleBranchSelect}
            onClose={handleSelectorClose}
          />
        )}
      </div>

      {/* Main content */}
      <div className="push-body" ref={bodyRef}>
        {/* Left: commit list */}
        <div className="push-commits" style={{ width: `${leftWidthPercent}%` }}>
          {commits.length === 0 ? (
            <div className="push-empty">No commits to push</div>
          ) : (
            commits.map((c) => (
              <div
                key={c.hash}
                className={`push-commit-item${selectedHash === c.hash ? " selected" : ""}`}
                onClick={() => setSelectedHash(c.hash)}
              >
                <span className="push-commit-subject">{c.subject}</span>
              </div>
            ))
          )}
        </div>

        {/* Draggable divider */}
        <div
          className={`push-divider${isDragging ? " push-divider--dragging" : ""}`}
          {...dividerProps}
        />

        {/* Right: file list + commit detail (reusing git log's layout) */}
        <div className="push-detail">
          {selectedCommit && (
            <Allotment vertical>
              <Allotment.Pane minSize={60} preferredSize="40%">
                <div
                  style={{
                    height: "100%",
                    overflow: "hidden",
                    display: "flex",
                    flexDirection: "column",
                  }}
                >
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
                      {files.length} file{files.length !== 1 ? "s" : ""}
                    </span>
                    <span style={{ display: "flex", gap: 2 }}>
                      <button
                        type="button"
                        onClick={() => setViewMode("tree")}
                        style={{
                          background:
                            viewMode === "tree"
                              ? "var(--selected-bg)"
                              : "transparent",
                          border: "none",
                          borderRadius: 3,
                          cursor: "pointer",
                          padding: "2px 4px",
                          display: "flex",
                          alignItems: "center",
                          color: "inherit",
                        }}
                        title="Tree View"
                      >
                        <CodiconListTree />
                      </button>
                      <button
                        type="button"
                        onClick={() => setViewMode("flat")}
                        style={{
                          background:
                            viewMode === "flat"
                              ? "var(--selected-bg)"
                              : "transparent",
                          border: "none",
                          borderRadius: 3,
                          cursor: "pointer",
                          padding: "2px 4px",
                          display: "flex",
                          alignItems: "center",
                          color: "inherit",
                        }}
                        title="Flat List"
                      >
                        <CodiconListFlat />
                      </button>
                    </span>
                  </div>
                  <div
                    style={{ flex: 1, overflow: "auto", overflowX: "hidden" }}
                  >
                    <FileTree
                      files={files}
                      viewMode={viewMode}
                      selectedFiles={[]}
                      onFileClick={(_e, file) => {
                        if (selectedHash) {
                          request("openDiffEditor", {
                            commit: selectedHash,
                            filePath: file.newPath || file.oldPath,
                            file,
                          });
                        }
                      }}
                      collapsed={collapsed}
                      onToggle={(key) =>
                        setCollapsed((prev) => ({
                          ...prev,
                          [key]: !prev[key],
                        }))
                      }
                    />
                  </div>
                </div>
              </Allotment.Pane>
              <Allotment.Pane minSize={60}>
                <div style={{ height: "100%", overflow: "auto", padding: 12 }}>
                  <CommitInfo commit={selectedCommit} />
                </div>
              </Allotment.Pane>
            </Allotment>
          )}
          {!selectedCommit && (
            <div style={{ padding: 12, opacity: 0.5 }}>No commits selected</div>
          )}
        </div>
      </div>

      {/* Footer */}
      <div className="push-footer">
        {error && <span className="push-error">{error}</span>}
        <span style={{ flex: 1 }} />
        <button
          type="button"
          className="push-btn push-btn-secondary"
          onClick={() =>
            bridge.request("closePushPanel", {}, { scope: "global" })
          }
          disabled={pushing}
        >
          Cancel
        </button>
        <div className="push-split-btn">
          <button
            type="button"
            className="push-btn push-btn-primary push-split-main"
            onClick={() => handlePush(false)}
            disabled={pushing || commits.length === 0}
          >
            {pushing ? "Pushing..." : "Push"}
          </button>
          <button
            type="button"
            className="push-btn push-btn-primary push-split-arrow"
            onClick={() => setShowPushMenu(!showPushMenu)}
            disabled={pushing || commits.length === 0}
          >
            <svg
              width="12"
              height="12"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
            >
              <polyline points="4,6 8,10 12,6" />
            </svg>
          </button>
          {showPushMenu && (
            <>
              <div
                className="push-menu-backdrop"
                onClick={() => setShowPushMenu(false)}
              />
              <div className="push-menu">
                <button
                  type="button"
                  className="push-menu-item"
                  onClick={() => {
                    setShowPushMenu(false);
                    handlePush(true);
                  }}
                >
                  Force Push
                </button>
              </div>
            </>
          )}
        </div>
      </div>

      {/* Progress bar */}
      {pushing && (
        <div
          style={{
            position: "absolute",
            top: 0,
            left: 0,
            right: 0,
            height: 3,
            zIndex: 10000,
            overflow: "hidden",
            background: "rgba(0, 122, 204, 0.15)",
          }}
        >
          <div
            style={{
              height: "100%",
              width: "40%",
              background:
                "linear-gradient(90deg, transparent, #007acc 30%, #3794ff 70%, transparent)",
              animation: "progress-slide 1s infinite linear",
            }}
          />
          <style>
            {`@keyframes progress-slide {
              0% { transform: translateX(-100%); }
              100% { transform: translateX(250%); }
            }`}
          </style>
        </div>
      )}

      {/* Push Rejected Dialog */}
      {pushRejected.show && (
        <PushRejectedDialog
          branchName={pushRejected.branchName}
          onRebase={handleRebaseAndPush}
          onMerge={handleMergeAndPush}
          onCancel={handleRejectedCancel}
        />
      )}
    </div>
  );
}
