import * as vscode from "vscode";
import type { MessageRouter } from "../messages/messageRouter";
import { getWebviewHtml } from "./html";

export class ConflictsManager {
  private panel: vscode.WebviewPanel | null = null;

  constructor(
    private readonly extensionUri: vscode.Uri,
    private readonly messageRouter: MessageRouter,
  ) {}

  openConflictsPanel(repoId: string): void {
    if (this.panel) {
      this.panel.reveal();
      // Re-send init data. The panel is reused (not recreated), so main.tsx
      // never re-runs; this re-init is what rebinds the bridge to the new repo
      // via bindRepo(payload.repoId). Mirrors pushPanel/rollbackPanel.
      this.panel.webview.postMessage({
        type: "event",
        event: "conflictsPanelInit",
        data: { repoId },
      });
      return;
    }

    const panel = vscode.window.createWebviewPanel(
      "jetgit-plus.conflicts",
      "Conflicts",
      vscode.ViewColumn.One,
      {
        enableScripts: true,
        retainContextWhenHidden: true,
        localResourceRoots: [vscode.Uri.joinPath(this.extensionUri, "dist")],
      },
    );

    panel.webview.html = getWebviewHtml(
      panel.webview,
      this.extensionUri,
      "conflicts",
      { "repo-id": repoId },
    );

    const routerDisposable = this.messageRouter.registerWebview(panel.webview);

    this.panel = panel;
    panel.onDidDispose(() => {
      this.panel = null;
      routerDisposable.dispose();
    });
  }
}
