import * as path from "node:path";
import * as vscode from "vscode";
import type { GitCache } from "../git/cache";
import type { RepositoryPaths } from "../git/repoRegistry";
import type { MessageRouter } from "../messages/messageRouter";

type Scope = "all" | "branches" | "status" | "mergeState" | "log";

export interface GitWatchSpec {
  basePath: string;
  pattern: string;
  scope: Scope;
}

/**
 * Build file-watch specs routing worktree-local state to the repo's real gitDir
 * (so a worktree watches its own per-worktree files) and shared refs to commonDir
 * (so a worktree also observes the shared repository state). Identical
 * basePath+pattern pairs are deduplicated (normal repos where gitDir===commonDir
 * get exactly one watcher per file).
 */
export function buildGitWatchSpecs(paths: RepositoryPaths): GitWatchSpec[] {
  const specs: GitWatchSpec[] = [
    { basePath: paths.gitDir, pattern: "HEAD", scope: "all" },
    { basePath: paths.gitDir, pattern: "index", scope: "status" },
    { basePath: paths.gitDir, pattern: "MERGE_HEAD", scope: "mergeState" },
    {
      basePath: paths.gitDir,
      pattern: "CHERRY_PICK_HEAD",
      scope: "mergeState",
    },
    { basePath: paths.gitDir, pattern: "rebase-merge/**", scope: "mergeState" },
    { basePath: paths.gitDir, pattern: "rebase-apply/**", scope: "mergeState" },
    { basePath: paths.gitDir, pattern: "COMMIT_EDITMSG", scope: "log" },
    { basePath: paths.gitDir, pattern: "config.worktree", scope: "all" },
    { basePath: paths.commonDir, pattern: "refs/heads/**", scope: "branches" },
    {
      basePath: paths.commonDir,
      pattern: "refs/remotes/**",
      scope: "branches",
    },
    { basePath: paths.commonDir, pattern: "refs/tags/**", scope: "branches" },
    { basePath: paths.commonDir, pattern: "packed-refs", scope: "branches" },
    { basePath: paths.commonDir, pattern: "config", scope: "all" },
  ];
  const seen = new Set<string>();
  return specs.filter((spec) => {
    const key = `${spec.basePath}\0${spec.pattern}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

export class GitWatcher implements vscode.Disposable {
  private disposables: vscode.Disposable[] = [];
  private debounceTimers = new Map<Scope, ReturnType<typeof setTimeout>>();

  constructor(
    private readonly paths: RepositoryPaths,
    private readonly workTreeRoot: string,
    private readonly messageRouter: MessageRouter,
    private readonly cache: GitCache,
    private readonly repoId: string,
  ) {
    this.setupFileWatchers();
    this.setupEditorWatchers();
  }

  private setupFileWatchers(): void {
    for (const spec of buildGitWatchSpecs(this.paths)) {
      const watcher = vscode.workspace.createFileSystemWatcher(
        new vscode.RelativePattern(spec.basePath, spec.pattern),
      );
      watcher.onDidChange(() => this.notify(spec.scope));
      watcher.onDidCreate(() => this.notify(spec.scope));
      watcher.onDidDelete(() => this.notify(spec.scope));
      this.disposables.push(watcher);
    }
  }

  private setupEditorWatchers(): void {
    this.disposables.push(
      vscode.workspace.onDidSaveTextDocument((document) => {
        if (document.uri.scheme !== "file") return;
        const relative = path.relative(this.workTreeRoot, document.uri.fsPath);
        if (
          relative === "" ||
          (!relative.startsWith("..") && !path.isAbsolute(relative))
        ) {
          this.notify("status");
        }
      }),
    );
  }

  private notify(scope: Scope): void {
    // Debounce per scope, 300ms
    const existing = this.debounceTimers.get(scope);
    if (existing) {
      clearTimeout(existing);
    }

    this.debounceTimers.set(
      scope,
      setTimeout(() => {
        this.debounceTimers.delete(scope);
        this.cache.invalidate();
        this.messageRouter.broadcastEvent("gitStateChanged", {
          scope,
          repoId: this.repoId,
        });
      }, 300),
    );
  }

  dispose(): void {
    for (const timer of this.debounceTimers.values()) {
      clearTimeout(timer);
    }
    this.debounceTimers.clear();
    for (const d of this.disposables) {
      d.dispose();
    }
    this.disposables = [];
  }
}
