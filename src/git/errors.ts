export const JetGitErrorCode = {
  REPO_NOT_FOUND: "REPO_NOT_FOUND",
  INVALID_REF: "INVALID_REF",
  BRANCH_NOT_FOUND: "BRANCH_NOT_FOUND",
  BRANCH_NO_UPSTREAM: "BRANCH_NO_UPSTREAM",
  BRANCH_CHECKED_OUT_IN_WORKTREE: "BRANCH_CHECKED_OUT_IN_WORKTREE",
  BRANCH_NON_FAST_FORWARD: "BRANCH_NON_FAST_FORWARD",
} as const;

export type JetGitErrorCode =
  (typeof JetGitErrorCode)[keyof typeof JetGitErrorCode];

export class JetGitError extends Error {
  constructor(
    readonly code: JetGitErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "JetGitError";
  }
}
