export const JetGitErrorCode = {
  REPO_NOT_FOUND: "REPO_NOT_FOUND",
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
