/**
 * Public repo identity as seen by the webview. The host-only `RepositoryPaths`
 * (workTreeRoot/gitDir/commonDir) is intentionally NOT mirrored here.
 */
export interface RepoDescriptor {
  id: string;
  name: string;
  rootPath: string;
}

export interface RequestMessage {
  type: "request";
  id: string;
  command: CommandType;
  params: Record<string, unknown>;
  repoId?: string;
}

export interface ResponseMessage {
  type: "response";
  id: string;
  success: boolean;
  data?: unknown;
  error?: { code: string; message: string };
}

export interface EventMessage {
  type: "event";
  event: string;
  data: unknown;
}

export type Message = RequestMessage | ResponseMessage | EventMessage;

export type CommandType =
  | "getLog"
  | "getGraphData"
  | "loadMoreLog"
  | "getBranches"
  | "getTags"
  | "getDiff"
  | "getFileContent"
  | "getCommitFiles"
  | "getStatus"
  | "openDiffEditor"
  | "openMergeEditor"
  | "getMergeState"
  | "getCherryPickState"
  | "getConflictFiles"
  | "getFileVersions"
  | "saveMergedContent"
  | "stageFile"
  | "unstageFile"
  | "stageAll"
  | "unstageAll"
  | "acceptOurs"
  | "acceptTheirs"
  | "confirmCancelMerge"
  | "closeMergeEditor"
  | "openFile"
  | "checkoutBranch"
  | "createBranch"
  | "createBranchFromCommit"
  | "deleteBranch"
  | "renameBranch"
  | "mergeBranch"
  | "rebaseBranch"
  | "checkoutAndRebase"
  | "pushBranch"
  | "pullBranch"
  | "pullRebase"
  | "pullMerge"
  | "fetchBranch"
  | "commitChanges"
  | "commitAndPush"
  | "amendCommit"
  | "rollbackFile"
  | "rollbackFiles"
  | "getWorkingTreeChanges"
  | "getShelves"
  | "shelveChanges"
  | "unshelveChanges"
  | "unshelveFile"
  | "deleteShelve"
  | "showShelfFileDiff"
  | "showDiffForWorkingFile"
  | "getAmendMessage"
  | "getIdeaShelves"
  | "ideaShelveChanges"
  | "ideaUnshelveChanges"
  | "deleteIdeaShelf"
  | "showIdeaShelfFileDiff"
  | "createPatchFromShelf"
  | "copyShelfPatchToClipboard"
  | "importPatches"
  | "deleteFiles"
  | "revealInSystemExplorer"
  | "getRecentCommitMessages"
  | "refreshGitState"
  | "getRebaseState"
  | "rebaseAction"
  | "mergeAction"
  | "cherryPickAction"
  | "checkoutCommit"
  | "cherryPick"
  | "cherryPickFileChanges"
  | "createTag"
  | "resetToCommit"
  | "revertCommit"
  | "revertFileChanges"
  | "openFileAtRevision"
  | "copyToClipboard"
  | "showConfirmMessage"
  | "showInputBox"
  | "showErrorNotification"
  | "showInfoNotification"
  | "openConflictsPanel"
  | "importPatchFromClipboard"
  | "createBranchPrompt"
  | "deleteBranchPrompt"
  | "compareWithCurrent"
  | "showMyBranches"
  | "fetchAll"
  | "toggleFavorite"
  | "navigateToHead"
  | "toggleBranchGroupByDirectory"
  | "setSingleClickAction"
  | "toggleShowTags"
  | "getAheadCommits"
  | "getCommitRangeFiles"
  | "executePush"
  | "openPushPanel"
  | "getRemoteBranches"
  | "dropCommit"
  | "closePushPanel"
  | "openRollbackPanel"
  | "executeRollback"
  | "closeRollbackPanel"
  | "getRepos"
  | "selectRepo";

/**
 * Request scope. "repo" (default) binds the call to the active repo context;
 * "global" opts out of repo-binding for control-plane calls (e.g. getRepos,
 * selectRepo) so they survive a repo switch without a hard-coded command list.
 */
export interface BridgeRequestOptions {
  scope?: "repo" | "global";
}

export interface Bridge {
  request(
    command: CommandType,
    params?: Record<string, unknown>,
    options?: BridgeRequestOptions,
  ): Promise<unknown>;
  onEvent(handler: (event: string, data: unknown) => void): () => void;
  setRepoContext(repoId: string | null): void;
}
