import * as assert from "node:assert";
import { GitService } from "../../git/gitService";
import { discoverRepos } from "../../git/repoDiscovery";
import {
  type DiscoveredRepo,
  formatRepoLabel,
  RepoRegistry,
  type RepositoryPaths,
} from "../../git/repoRegistry";

function paths(
  root: string,
  gitDir = `${root}/.git`,
  commonDir = gitDir,
): RepositoryPaths {
  return { workTreeRoot: root, gitDir, commonDir };
}

function discovered(id: string, p = paths(id)): DiscoveredRepo {
  return { descriptor: { id, name: id, rootPath: id }, paths: p };
}

describe("RepoRegistry", () => {
  it("stores runtimes in order and falls back when active is removed", () => {
    const registry = new RepoRegistry();
    registry.build(
      [discovered("/a"), discovered("/b")],
      (p) => new GitService(p),
    );
    assert.deepStrictEqual(
      registry.list().map((d) => d.id),
      ["/a", "/b"],
    );
    registry.setActive("/b");
    const removed = registry.remove("/b");
    assert.strictEqual(removed?.descriptor.id, "/b");
    assert.strictEqual(registry.getActiveId(), "/a");
  });

  it("keeps host-only paths on the runtime", () => {
    const registry = new RepoRegistry();
    const worktree = discovered(
      "/wt",
      paths("/wt", "/meta/wt", "/meta/common"),
    );
    registry.build([worktree], (p) => new GitService(p));
    assert.deepStrictEqual(registry.get("/wt")?.paths, worktree.paths);
    assert.deepStrictEqual(registry.list(), [worktree.descriptor]);
  });
});

describe("formatRepoLabel", () => {
  // Mirrors RepoSwitcher's (webview) disambiguation: name when unique across
  // the registry list, else `${name} (${shortPath})` where shortPath is the
  // last 2 path segments split on [\\/].
  it("returns the bare name when the name is unique across all repos", () => {
    const all = [
      { name: "alpha", rootPath: "/work/alpha" },
      { name: "beta", rootPath: "/work/beta" },
    ];
    assert.strictEqual(
      formatRepoLabel({ name: "alpha", rootPath: "/work/alpha" }, all),
      "alpha",
    );
  });

  it("appends the last 2 path segments when the name collides", () => {
    const all = [
      { name: "app", rootPath: "/home/alice/projects/app" },
      { name: "app", rootPath: "/home/bob/projects/app" },
    ];
    // Last 2 segments of each rootPath → "projects/app" for both. The
    // disambiguation still differs because the full label is name + path, but
    // here the last-2-seg path is identical, so both resolve to the same
    // suffixed label (RepoSwitcher has the same behavior).
    assert.strictEqual(
      formatRepoLabel({ name: "app", rootPath: "/home/bob/projects/app" }, all),
      "app (projects/app)",
    );
    assert.strictEqual(
      formatRepoLabel(
        { name: "app", rootPath: "/home/alice/projects/app" },
        all,
      ),
      "app (projects/app)",
    );
    // Distinct last-2-seg paths produce distinct labels.
    const distinct = [
      { name: "app", rootPath: "/a/app" },
      { name: "app", rootPath: "/b/app" },
    ];
    assert.strictEqual(
      formatRepoLabel({ name: "app", rootPath: "/b/app" }, distinct),
      "app (b/app)",
    );
    assert.strictEqual(
      formatRepoLabel({ name: "app", rootPath: "/a/app" }, distinct),
      "app (a/app)",
    );
  });

  it("handles short paths with fewer than 2 segments", () => {
    const all = [
      { name: "x", rootPath: "x" },
      { name: "x", rootPath: "/y/x" },
    ];
    assert.strictEqual(
      formatRepoLabel({ name: "x", rootPath: "x" }, all),
      "x (x)",
    );
  });

  it("splits on both / and \\", () => {
    const all = [
      { name: "r", rootPath: "C:\\dev\\r" },
      { name: "r", rootPath: "/opt/r" },
    ];
    assert.strictEqual(
      formatRepoLabel({ name: "r", rootPath: "C:\\dev\\r" }, all),
      "r (dev/r)",
    );
  });
});

describe("discoverRepos", () => {
  it("keeps only top-level workspace roots and deduplicates real roots", async () => {
    const inspect = async (candidate: string): Promise<RepositoryPaths> => {
      if (candidate === "/a" || candidate === "/alias-a")
        return paths("/real/a");
      if (candidate === "/nested") return paths("/parent");
      throw new Error("not git");
    };
    const canonicalize = async (candidate: string) =>
      candidate === "/a" || candidate === "/alias-a" ? "/real/a" : candidate;
    const result = await discoverRepos(
      [
        { fsPath: "/a", name: "a" },
        { fsPath: "/alias-a", name: "duplicate" },
        { fsPath: "/nested", name: "nested" },
        { fsPath: "/missing", name: "missing" },
      ],
      inspect,
      canonicalize,
    );
    assert.deepStrictEqual(result, [
      {
        descriptor: { id: "/real/a", name: "a", rootPath: "/real/a" },
        paths: paths("/real/a"),
      },
    ]);
  });

  it("preserves separate gitDir/commonDir for a worktree", async () => {
    const p = paths("/wt", "/repo/.git/worktrees/wt", "/repo/.git");
    const result = await discoverRepos(
      [{ fsPath: "/wt", name: "wt" }],
      async () => p,
      async (value) => value,
    );
    assert.deepStrictEqual(result[0]?.paths, p);
  });
});
