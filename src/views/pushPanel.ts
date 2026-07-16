import * as vscode from "vscode";
import type { MessageRouter } from "../messages/messageRouter";
import { getWebviewHtml } from "./html";

/**
 * Opens a "Push Commits" webview panel in an editor tab,
 * similar to IntelliJ IDEA's push dialog.
 */
export class PushPanel {
  private panel: vscode.WebviewPanel | undefined;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly messageRouter: MessageRouter,
  ) {}

  open(repoId: string, branchName: string, remoteName = "origin"): void {
    if (this.panel) {
      this.panel.reveal();
      // Re-send init data. The panel is reused (not recreated), so main.tsx
      // never re-runs; this re-init is what rebinds the bridge to the new repo
      // via bindRepo(payload.repoId). The remote key is `remote` to match the
      // create-time `data-remote` dataset (and the frontend's `payload.remote`
      // read) — previously this posted `remoteName`, which the frontend never
      // read, silently falling back to "origin".
      this.panel.webview.postMessage({
        type: "event",
        event: "pushPanelInit",
        data: { repoId, branchName, remote: remoteName },
      });
      return;
    }

    this.panel = vscode.window.createWebviewPanel(
      "jetgit-plus.pushPanel",
      `Push Commits to ${branchName}`,
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist")],
        retainContextWhenHidden: false,
      },
    );

    this.panel.webview.html = getWebviewHtml(
      this.panel.webview,
      this.extensionUri,
      "push",
      { "repo-id": repoId, branch: branchName, remote: remoteName },
    );

    const routerDisposable = this.messageRouter.registerWebview(
      this.panel.webview,
    );

    this.panel.onDidDispose(() => {
      routerDisposable.dispose();
      this.panel = undefined;
    });
  }

  close(): void {
    this.panel?.dispose();
  }
}
