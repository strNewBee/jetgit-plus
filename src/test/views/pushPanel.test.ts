import * as assert from "node:assert";
import * as vscode from "vscode";
import type { GitService } from "../../git/gitService";
import type { DiscoveredRepo } from "../../git/repoRegistry";
import { RepoRegistry } from "../../git/repoRegistry";
import type { MessageRouter } from "../../messages/messageRouter";
import { PushPanel } from "../../views/pushPanel";

function makeRepo(id: string): DiscoveredRepo {
  const rootPath = `/repos/${id}`;
  return {
    descriptor: { id, name: id, rootPath },
    paths: {
      workTreeRoot: rootPath,
      gitDir: `${rootPath}/.git`,
      commonDir: `${rootPath}/.git`,
    },
  };
}

describe("PushPanel repository binding", () => {
  it("ignores a late open for a repo that is no longer globally active", () => {
    const registry = new RepoRegistry();
    const gitService = {} as GitService;
    registry.add(makeRepo("repoA"), gitService);
    registry.add(makeRepo("repoB"), gitService);

    let revealCount = 0;
    const postedMessages: unknown[] = [];
    const existingPanel = {
      reveal: () => {
        revealCount += 1;
      },
      webview: {
        postMessage: (message: unknown) => {
          postedMessages.push(message);
        },
      },
    };

    const pushPanel = new PushPanel(
      vscode.Uri.file("/extension"),
      {} as MessageRouter,
      registry,
    );
    // Seed an existing panel so the test exercises the reveal/re-init path
    // without creating a real VS Code editor tab.
    (
      pushPanel as unknown as {
        panel: typeof existingPanel;
      }
    ).panel = existingPanel;

    // Simulate openPushPanel(A) awaiting Git while the global selection moves
    // to B. The late continuation must not reveal/rebind the idle panel to A.
    assert.strictEqual(registry.setActive("repoB"), true);
    pushPanel.open("repoA", "main", "origin");

    assert.strictEqual(revealCount, 0);
    assert.deepStrictEqual(postedMessages, []);
  });
});
