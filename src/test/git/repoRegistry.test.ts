import * as assert from "node:assert";
import { GitService } from "../../git/gitService";
import { discoverRepos } from "../../git/repoDiscovery";
import {
  type DiscoveredRepo,
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
