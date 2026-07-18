import * as assert from "node:assert";
import { execFile } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { promisify } from "node:util";
import { GitService } from "../../git/gitService";

const execFileAsync = promisify(execFile);

async function git(cwd: string, ...args: string[]): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    env: { ...process.env, LC_ALL: "C", GIT_TERMINAL_PROMPT: "0" },
  });
  return stdout.trim();
}

async function gitWithDates(
  cwd: string,
  date: string,
  ...args: string[]
): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd,
    env: {
      ...process.env,
      LC_ALL: "C",
      GIT_TERMINAL_PROMPT: "0",
      GIT_AUTHOR_DATE: date,
      GIT_COMMITTER_DATE: date,
    },
  });
  return stdout.trim();
}

function serviceFor(repo: string): GitService {
  return new GitService({
    workTreeRoot: repo,
    gitDir: path.join(repo, ".git"),
    commonDir: path.join(repo, ".git"),
  });
}

async function createComparisonRepository(): Promise<{
  base: string;
  repo: string;
  commonCommitHash: string;
  mainCommitHash: string;
}> {
  const base = await fs.mkdtemp(path.join(os.tmpdir(), "jetgit-comparison-"));
  const repo = path.join(base, "repo");
  await git(base, "init", "-b", "main", repo);
  await git(repo, "config", "user.name", "JetGit Test");
  await git(repo, "config", "user.email", "jetgit@example.com");

  await fs.writeFile(path.join(repo, "common.txt"), "common\n");
  await git(repo, "add", "common.txt");
  await gitWithDates(repo, "2020-01-01T00:00:00Z", "commit", "-m", "common");
  const commonCommitHash = await git(repo, "rev-parse", "HEAD");
  await git(repo, "branch", "feature");

  await fs.writeFile(path.join(repo, "main-only.txt"), "main\n");
  await git(repo, "add", "main-only.txt");
  await gitWithDates(repo, "2021-01-01T00:00:00Z", "commit", "-m", "main only");
  const mainCommitHash = await git(repo, "rev-parse", "HEAD");

  await git(repo, "checkout", "feature");
  await fs.writeFile(path.join(repo, "feature-only.txt"), "feature\n");
  await git(repo, "add", "feature-only.txt");
  await gitWithDates(
    repo,
    "2022-01-01T00:00:00Z",
    "-c",
    "user.name=Feature Author",
    "-c",
    "user.email=feature@example.com",
    "commit",
    "-m",
    "feature only",
  );
  await git(repo, "checkout", "main");

  await git(repo, "update-ref", "refs/remotes/origin/main", mainCommitHash);
  await git(repo, "tag", "lightweight", commonCommitHash);
  await git(
    repo,
    "tag",
    "-a",
    "annotated",
    commonCommitHash,
    "-m",
    "annotated",
  );

  return { base, repo, commonCommitHash, mainCommitHash };
}

describe("GitService structured comparison revisions", () => {
  it("returns only commits selected by each side of a comparison range", async () => {
    const { base, repo } = await createComparisonRepository();
    try {
      const service = serviceFor(repo);
      const selectedOnly = await service.getLog({
        revision: {
          kind: "range",
          excludeRef: "refs/heads/main",
          includeRef: "refs/heads/feature",
        },
      });
      assert.deepStrictEqual(
        selectedOnly.map((commit) => commit.subject),
        ["feature only"],
      );

      const currentOnly = await service.getLog({
        revision: {
          kind: "range",
          excludeRef: "refs/heads/feature",
          includeRef: "refs/heads/main",
        },
      });
      assert.deepStrictEqual(
        currentOnly.map((commit) => commit.subject),
        ["main only"],
      );
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  });

  it("applies every log filter within a comparison range", async () => {
    const { base, repo } = await createComparisonRepository();
    try {
      const service = serviceFor(repo);
      const revision = {
        kind: "range" as const,
        excludeRef: "refs/heads/main",
        includeRef: "refs/heads/feature",
      };

      for (const options of [
        { search: "feature only" },
        { author: "Feature Author" },
        { since: "2021-06-01" },
        { until: "2022-06-01" },
        { file: "feature-only.txt" },
      ]) {
        const commits = await service.getLog({ revision, ...options });
        assert.deepStrictEqual(
          commits.map((commit) => commit.subject),
          ["feature only"],
        );
      }
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  });

  it("resolves commit refs, including annotated tags", async () => {
    const { base, repo, commonCommitHash, mainCommitHash } =
      await createComparisonRepository();
    try {
      const service = serviceFor(repo);
      assert.strictEqual(
        await service.resolveCommitRef("refs/tags/annotated"),
        commonCommitHash,
      );
      assert.strictEqual(
        await service.resolveCommitRef("refs/remotes/origin/main"),
        mainCommitHash,
      );
      assert.strictEqual(
        await service.resolveCommitRef("refs/heads/missing"),
        null,
      );
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  });

  it("rejects revision values that Git could interpret as options", async () => {
    const { base, repo } = await createComparisonRepository();
    try {
      const service = serviceFor(repo);
      await assert.rejects(
        service.getLog({ revision: { kind: "ref", ref: "--all" } }),
      );
      await assert.rejects(
        service.getLog({
          revision: {
            kind: "range",
            excludeRef: "refs/heads/main",
            includeRef: "--all",
          },
        }),
      );
      await assert.rejects(service.resolveCommitRef("--all"));
    } finally {
      await fs.rm(base, { recursive: true, force: true });
    }
  });
});
