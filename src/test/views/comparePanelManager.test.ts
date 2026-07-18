import * as assert from "node:assert";
import * as vscode from "vscode";
import type { GitRefIdentity } from "../../git/branchDashboardState";
import type { GitService } from "../../git/gitService";
import type {
  CommandHandler,
  MessageRouter,
} from "../../messages/messageRouter";
import type { RequestContext } from "../../messages/protocol";
import {
  ComparePanelManager,
  registerComparePanelHandlers,
  resolveCurrentCompareRef,
} from "../../views/comparePanelManager";

interface FakePanel extends vscode.WebviewPanel {
  fireDispose(): void;
  postedMessages: unknown[];
  revealCount: number;
}

const selected: GitRefIdentity = {
  type: "remote",
  name: "origin/topic",
  fullRef: "refs/remotes/origin/topic",
};
const current: GitRefIdentity = {
  type: "local",
  name: "main",
  fullRef: "refs/heads/main",
};

describe("ComparePanelManager", () => {
  const originalCreateWebviewPanel = vscode.window.createWebviewPanel;
  let panels: FakePanel[];
  let routerRegistrations: vscode.Webview[];
  let routerDisposeCounts: number[];
  let panelOptions: Array<vscode.WebviewPanelOptions & vscode.WebviewOptions>;

  beforeEach(() => {
    panels = [];
    routerRegistrations = [];
    routerDisposeCounts = [];
    panelOptions = [];
    (
      vscode.window as unknown as {
        createWebviewPanel: typeof vscode.window.createWebviewPanel;
      }
    ).createWebviewPanel = ((_viewType, _title, _column, _options) => {
      const panelIndex = panels.length;
      let disposeHandler: (() => void) | undefined;
      const postedMessages: unknown[] = [];
      const webview = {
        cspSource: "vscode-webview:",
        html: "",
        asWebviewUri: (uri: vscode.Uri) => uri,
        onDidReceiveMessage: () => ({ dispose() {} }),
        postMessage: (message: unknown) => {
          postedMessages.push(message);
          return Promise.resolve(true);
        },
      } as unknown as vscode.Webview;
      const panel = {
        webview,
        postedMessages,
        revealCount: 0,
        reveal() {
          panel.revealCount += 1;
        },
        onDidDispose(listener: () => void) {
          disposeHandler = listener;
          return { dispose() {} };
        },
        fireDispose() {
          disposeHandler?.();
        },
      } as unknown as FakePanel;
      panels.push(panel);
      assert.ok(_options);
      panelOptions.push(_options);
      routerDisposeCounts[panelIndex] = 0;
      return panel;
    }) as typeof vscode.window.createWebviewPanel;
  });

  afterEach(() => {
    (
      vscode.window as unknown as {
        createWebviewPanel: typeof vscode.window.createWebviewPanel;
      }
    ).createWebviewPanel = originalCreateWebviewPanel;
  });

  function manager(): ComparePanelManager {
    const router = {
      registerWebview(webview: vscode.Webview) {
        const panelIndex = routerRegistrations.length;
        routerRegistrations.push(webview);
        return {
          dispose() {
            routerDisposeCounts[panelIndex] += 1;
          },
        };
      },
    } as unknown as MessageRouter;
    return new ComparePanelManager(vscode.Uri.file("/extension"), router);
  }

  it("reveals and refreshes an existing ordered repository/ref panel", () => {
    const comparePanels = manager();

    comparePanels.open("repo-a", selected, current);
    comparePanels.open("repo-a", selected, current);

    assert.strictEqual(panels.length, 1);
    assert.strictEqual(panels[0].revealCount, 1);
    assert.deepStrictEqual(panels[0].postedMessages.at(-1), {
      type: "event",
      event: "comparePanelRefresh",
      data: {},
    });
    assert.strictEqual(routerRegistrations.length, 1);
    assert.strictEqual(panelOptions[0].enableScripts, true);
    assert.strictEqual(panelOptions[0].retainContextWhenHidden, true);
    assert.deepStrictEqual(
      panelOptions[0].localResourceRoots?.map((uri) => uri.fsPath),
      ["/extension/dist"],
    );
  });

  it("creates distinct panels for selected, current, order, or repository changes", () => {
    const comparePanels = manager();
    const otherSelected: GitRefIdentity = {
      type: "tag",
      name: "v1.0.0",
      fullRef: "refs/tags/v1.0.0",
    };

    comparePanels.open("repo-a", selected, current);
    comparePanels.open("repo-a", otherSelected, current);
    comparePanels.open("repo-a", selected, otherSelected);
    comparePanels.open("repo-b", selected, current);

    assert.strictEqual(panels.length, 4);
    assert.strictEqual(routerRegistrations.length, 4);
    assert.strictEqual(panels[0].revealCount, 0);
    assert.deepStrictEqual(panels[0].postedMessages, []);
  });

  it("disposal removes exactly its ordered key and router registration", () => {
    const comparePanels = manager();
    const otherSelected: GitRefIdentity = {
      type: "local",
      name: "topic",
      fullRef: "refs/heads/topic",
    };

    comparePanels.open("repo-a", selected, current);
    comparePanels.open("repo-a", otherSelected, current);
    panels[0].fireDispose();
    comparePanels.open("repo-a", otherSelected, current);
    comparePanels.open("repo-a", selected, current);

    assert.strictEqual(panels.length, 3);
    assert.strictEqual(panels[1].revealCount, 1);
    assert.strictEqual(routerDisposeCounts[0], 1);
    assert.strictEqual(routerDisposeCounts[1], 0);
  });

  it("escapes repository and ref values in the initial HTML dataset", () => {
    const comparePanels = manager();
    const unsafeSelected: GitRefIdentity = {
      type: "remote",
      name: 'origin/<topic>&"',
      fullRef: 'refs/remotes/origin/<topic>&"',
    };
    const unsafeCurrent: GitRefIdentity = {
      type: "local",
      name: 'main<&"',
      fullRef: 'refs/heads/main<&"',
    };

    comparePanels.open('repo<&"', unsafeSelected, unsafeCurrent);

    const html = panels[0].webview.html;
    assert.match(html, /data-mode="compare"/);
    assert.match(html, /data-repo-id="repo&lt;&amp;&quot;"/);
    assert.match(html, /data-selected-ref-type="remote"/);
    assert.match(
      html,
      /data-selected-ref-name="origin\/&lt;topic&gt;&amp;&quot;"/,
    );
    assert.match(
      html,
      /data-selected-ref-full-ref="refs\/remotes\/origin\/&lt;topic&gt;&amp;&quot;"/,
    );
    assert.match(html, /data-current-ref-type="local"/);
    assert.match(html, /data-current-ref-name="main&lt;&amp;&quot;"/);
    assert.match(
      html,
      /data-current-ref-full-ref="refs\/heads\/main&lt;&amp;&quot;"/,
    );
    assert.doesNotMatch(html, /<topic>/);
  });
});

describe("resolveCurrentCompareRef", () => {
  it("uses a full local branch ref when HEAD is attached", async () => {
    const gitService = {
      getCurrentBranch: async () => "feature/topic",
      resolveCommitRef: async () => {
        throw new Error("attached HEAD must not resolve a commit hash");
      },
    };

    assert.deepStrictEqual(await resolveCurrentCompareRef(gitService), {
      type: "local",
      name: "feature/topic",
      fullRef: "refs/heads/feature/topic",
    });
  });

  it("uses literal HEAD with a short hash display when detached", async () => {
    const resolvedRefs: string[] = [];
    const gitService = {
      getCurrentBranch: async () => null,
      resolveCommitRef: async (ref: string) => {
        resolvedRefs.push(ref);
        return "1234567890abcdef";
      },
    };

    assert.deepStrictEqual(await resolveCurrentCompareRef(gitService), {
      type: "detached",
      name: "1234567",
      fullRef: "HEAD",
    });
    assert.deepStrictEqual(resolvedRefs, ["HEAD"]);
  });

  it("returns null when an unborn or unavailable HEAD cannot resolve", async () => {
    const gitService = {
      getCurrentBranch: async () => null,
      resolveCommitRef: async () => null,
    };

    assert.strictEqual(await resolveCurrentCompareRef(gitService), null);
  });
});

describe("openCompareWithCurrent handler", () => {
  it("keeps the request's captured repo and Git service across an async repo switch", async () => {
    let handler: CommandHandler | undefined;
    const router = {
      handle(command: string, candidate: CommandHandler) {
        assert.strictEqual(command, "openCompareWithCurrent");
        handler = candidate;
      },
    } as unknown as MessageRouter;
    const opened: Array<{
      repoId: string;
      selectedRef: GitRefIdentity;
      currentRef: GitRefIdentity;
    }> = [];
    const panelManager = {
      open(
        repoId: string,
        selectedRef: GitRefIdentity,
        currentRef: GitRefIdentity,
      ) {
        opened.push({ repoId, selectedRef, currentRef });
      },
    };
    registerComparePanelHandlers(router, panelManager);

    let resolveBranch!: (branch: string | null) => void;
    const pendingBranch = new Promise<string | null>((resolve) => {
      resolveBranch = resolve;
    });
    const serviceA = {
      getCurrentBranch: () => pendingBranch,
      resolveCommitRef: async () => null,
    } as unknown as GitService;
    let serviceBCalls = 0;
    const serviceB = {
      getCurrentBranch: async () => {
        serviceBCalls += 1;
        return "wrong-branch";
      },
      resolveCommitRef: async () => null,
    } as unknown as GitService;
    const context = {
      repoId: "repo-a",
      gitService: serviceA,
    } as RequestContext;

    assert.ok(handler);
    const request = handler({ ref: selected }, context);
    context.repoId = "repo-b";
    context.gitService = serviceB;
    resolveBranch("main");
    await request;

    assert.strictEqual(serviceBCalls, 0);
    assert.deepStrictEqual(opened, [
      {
        repoId: "repo-a",
        selectedRef: selected,
        currentRef: {
          type: "local",
          name: "main",
          fullRef: "refs/heads/main",
        },
      },
    ]);
  });
});
