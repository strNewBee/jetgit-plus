import { execFile } from "node:child_process";
import { realpath } from "node:fs/promises";
import { promisify } from "node:util";
import type { DiscoveredRepo, RepositoryPaths } from "./repoRegistry";

const execFileAsync = promisify(execFile);

export interface WorkspaceFolderEntry {
  fsPath: string;
  name: string;
}

export type InspectRepo = (candidateRoot: string) => Promise<RepositoryPaths>;
export type CanonicalizePath = (candidate: string) => Promise<string>;

export async function inspectGitRepo(
  candidateRoot: string,
): Promise<RepositoryPaths> {
  const { stdout } = await execFileAsync(
    "git",
    [
      "-C",
      candidateRoot,
      "rev-parse",
      "--path-format=absolute",
      "--show-toplevel",
      "--absolute-git-dir",
      "--git-common-dir",
    ],
    { env: { ...process.env, LC_ALL: "C", GIT_TERMINAL_PROMPT: "0" } },
  );
  const [workTreeRoot, gitDir, commonDir] = stdout.trim().split("\n");
  if (!workTreeRoot || !gitDir || !commonDir)
    throw new Error("Incomplete git rev-parse output");
  const [realRoot, realGitDir, realCommonDir] = await Promise.all([
    realpath(workTreeRoot),
    realpath(gitDir),
    realpath(commonDir),
  ]);
  return {
    workTreeRoot: realRoot,
    gitDir: realGitDir,
    commonDir: realCommonDir,
  };
}

export async function discoverRepos(
  entries: WorkspaceFolderEntry[],
  inspectRepo: InspectRepo = inspectGitRepo,
  canonicalize: CanonicalizePath = realpath,
): Promise<DiscoveredRepo[]> {
  const seen = new Set<string>();
  const result: DiscoveredRepo[] = [];
  for (const entry of entries) {
    try {
      const [candidateRoot, paths] = await Promise.all([
        canonicalize(entry.fsPath),
        inspectRepo(entry.fsPath),
      ]);
      if (candidateRoot !== paths.workTreeRoot || seen.has(paths.workTreeRoot))
        continue;
      seen.add(paths.workTreeRoot);
      result.push({
        descriptor: {
          id: paths.workTreeRoot,
          name: entry.name,
          rootPath: paths.workTreeRoot,
        },
        paths,
      });
    } catch {
      // A missing/non-Git workspace folder is not a repository candidate.
    }
  }
  return result;
}
