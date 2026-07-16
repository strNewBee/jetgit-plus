import * as vscode from "vscode";
import type { RepoRegistry } from "../git/repoRegistry";
import type { MessageRouter } from "../messages/messageRouter";
import { getWebviewHtml } from "./html";

export class CommitViewProvider implements vscode.WebviewViewProvider {
  public static readonly viewType = "jetgit-plus.commitPanel";

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly messageRouter: MessageRouter,
    private readonly repoRegistry: RepoRegistry,
  ) {}

  resolveWebviewView(
    webviewView: vscode.WebviewView,
    _context: vscode.WebviewViewResolveContext,
    _token: vscode.CancellationToken,
  ): void {
    const webview = webviewView.webview;

    webview.options = {
      enableScripts: true,
      localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist")],
    };

    webview.html = getWebviewHtml(webview, this.extensionUri, "commit");

    const routerDisposable = this.messageRouter.registerWebview(webview);
    webviewView.onDidDispose(() => routerDisposable.dispose());

    // First time opening: focus git log panel after a delay
    setTimeout(() => {
      if (webviewView.visible) {
        void vscode.commands.executeCommand("jetgit-plus.gitLog.focus");
        const runtime = this.repoRegistry.getActive();
        runtime?.gitService.cache.invalidate();
        this.messageRouter.broadcastEvent("commitStateChanged", {
          repoId: runtime?.descriptor.id,
        });
        this.messageRouter.broadcastEvent("gitStateChanged", {
          scope: "all",
          repoId: runtime?.descriptor.id,
        });
      }
    }, 200);

    // When commit panel becomes visible, also show the Git Log panel and refresh both
    // When hidden (clicked again to collapse), hide the Git Log panel too
    webviewView.onDidChangeVisibility(() => {
      if (webviewView.visible) {
        // Small delay to ensure panels are ready
        setTimeout(() => {
          void vscode.commands.executeCommand("jetgit-plus.gitLog.focus");
          // Invalidate the active repo's git cache to ensure fresh data
          const runtime = this.repoRegistry.getActive();
          runtime?.gitService.cache.invalidate();
          this.messageRouter.broadcastEvent("commitStateChanged", {
            repoId: runtime?.descriptor.id,
          });
          this.messageRouter.broadcastEvent("gitStateChanged", {
            scope: "all",
            repoId: runtime?.descriptor.id,
          });
        }, 100);
      } else {
        void vscode.commands.executeCommand("workbench.action.closePanel");
      }
    });
  }
}
