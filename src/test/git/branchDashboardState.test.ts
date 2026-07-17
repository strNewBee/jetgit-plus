import * as assert from "node:assert";
import { BranchDashboardStateStore } from "../../git/branchDashboardState";

class MemoryState {
  private readonly values = new Map<string, unknown>();

  get<T>(key: string, defaultValue: T): T {
    return (this.values.get(key) as T | undefined) ?? defaultValue;
  }

  async update(key: string, value: unknown): Promise<void> {
    this.values.set(key, value);
  }
}

describe("BranchDashboardStateStore", () => {
  it("uses JetBrains-compatible default favorites without favoriting tags", () => {
    const store = new BranchDashboardStateStore(new MemoryState());

    assert.strictEqual(store.isFavorite("repo-a", "local", "main"), true);
    assert.strictEqual(store.isFavorite("repo-a", "local", "master"), true);
    assert.strictEqual(
      store.isFavorite("repo-a", "remote", "origin/main"),
      true,
    );
    assert.strictEqual(
      store.isFavorite("repo-a", "remote", "origin/master"),
      true,
    );
    assert.strictEqual(store.isFavorite("repo-a", "local", "feature/a"), false);
    assert.strictEqual(store.isFavorite("repo-a", "tag", "main"), false);
  });

  it("persists explicit favorite overrides without crossing repo or ref type", async () => {
    const state = new MemoryState();
    const store = new BranchDashboardStateStore(state);

    await store.setFavorite("repo-a", "local", "main", false);
    await store.setFavorite("repo-a", "tag", "main", true);
    await store.setFavorite("repo-a", "remote", "upstream/main", true);

    const restored = new BranchDashboardStateStore(state);
    assert.strictEqual(restored.isFavorite("repo-a", "local", "main"), false);
    assert.strictEqual(restored.isFavorite("repo-a", "tag", "main"), true);
    assert.strictEqual(
      restored.isFavorite("repo-a", "remote", "upstream/main"),
      true,
    );
    assert.strictEqual(restored.isFavorite("repo-b", "local", "main"), true);
    assert.strictEqual(restored.isFavorite("repo-b", "tag", "main"), false);
  });

  it("persists workspace-level tag visibility and single-click behavior", async () => {
    const state = new MemoryState();
    const store = new BranchDashboardStateStore(state);

    assert.deepStrictEqual(store.getPreferences(), {
      showTags: true,
      singleClickAction: "filter",
    });

    await store.updatePreferences({
      showTags: false,
      singleClickAction: "navigate",
    });

    assert.deepStrictEqual(
      new BranchDashboardStateStore(state).getPreferences(),
      {
        showTags: false,
        singleClickAction: "navigate",
      },
    );
  });
});
