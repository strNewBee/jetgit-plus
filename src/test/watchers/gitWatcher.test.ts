import * as assert from "node:assert";
import { buildGitWatchSpecs } from "../../watchers/gitWatcher";

describe("buildGitWatchSpecs", () => {
  it("uses gitDir for worktree state and commonDir for shared refs", () => {
    const specs = buildGitWatchSpecs({
      workTreeRoot: "/wt",
      gitDir: "/repo/.git/worktrees/wt",
      commonDir: "/repo/.git",
    });
    assert.ok(
      specs.some(
        (s) => s.basePath.endsWith("worktrees/wt") && s.pattern === "HEAD",
      ),
    );
    assert.ok(
      specs.some(
        (s) => s.basePath === "/repo/.git" && s.pattern === "refs/heads/**",
      ),
    );
    assert.ok(!specs.some((s) => s.basePath === "/wt/.git"));
  });

  it("does not duplicate identical base/pattern pairs for a normal repo", () => {
    const specs = buildGitWatchSpecs({
      workTreeRoot: "/repo",
      gitDir: "/repo/.git",
      commonDir: "/repo/.git",
    });
    const keys = specs.map((s) => `${s.basePath}\0${s.pattern}`);
    assert.strictEqual(new Set(keys).size, keys.length);
  });
});
