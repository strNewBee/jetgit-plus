import * as assert from "node:assert";
import { broadcastActiveRepoLogRefresh } from "../../extension";
import type { RepoRegistry } from "../../git/repoRegistry";
import type { MessageRouter } from "../../messages/messageRouter";

describe("refreshLog repository scope", () => {
  it("broadcasts only for the active repository", () => {
    const broadcasts: Array<{ event: string; data: unknown }> = [];
    const router = {
      broadcastEvent(event: string, data: unknown) {
        broadcasts.push({ event, data });
      },
    } as unknown as MessageRouter;
    const registry = {
      getActive: () => ({ descriptor: { id: "repo-a" } }),
    } as unknown as RepoRegistry;

    broadcastActiveRepoLogRefresh(router, registry);

    assert.deepStrictEqual(broadcasts, [
      {
        event: "gitStateChanged",
        data: { scope: "all", repoId: "repo-a" },
      },
    ]);
  });

  it("does not emit an unscoped global refresh when no repository is active", () => {
    const broadcasts: unknown[] = [];
    const router = {
      broadcastEvent(event: string, data: unknown) {
        broadcasts.push({ event, data });
      },
    } as unknown as MessageRouter;
    const registry = {
      getActive: () => null,
    } as unknown as RepoRegistry;

    broadcastActiveRepoLogRefresh(router, registry);

    assert.deepStrictEqual(broadcasts, []);
  });
});
