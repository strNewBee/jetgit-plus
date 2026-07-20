import * as assert from "node:assert";
import * as vscode from "vscode";
import { getWebviewHtml } from "../../views/html";

describe("getWebviewHtml", () => {
  it("cache-busts the Webview script and stylesheet together", () => {
    const webview = {
      cspSource: "vscode-webview:",
      // VS Code normalizes local-resource URIs and drops the input query.
      // The cache key therefore has to be attached to the converted URI.
      asWebviewUri: (uri: vscode.Uri) => uri.with({ query: "" }),
    } as vscode.Webview;

    const first = getWebviewHtml(
      webview,
      vscode.Uri.file("/extension"),
      "panel",
    );
    const second = getWebviewHtml(
      webview,
      vscode.Uri.file("/extension"),
      "panel",
    );

    const assetKeys = (html: string) => [
      html.match(/style\.css\?([A-Za-z0-9]+)/)?.[1],
      html.match(/main\.js\?([A-Za-z0-9]+)/)?.[1],
    ];

    const firstKeys = assetKeys(first);
    const secondKeys = assetKeys(second);
    assert.ok(firstKeys[0]);
    assert.deepStrictEqual(firstKeys[1], firstKeys[0]);
    assert.ok(secondKeys[0]);
    assert.deepStrictEqual(secondKeys[1], secondKeys[0]);
    assert.notStrictEqual(secondKeys[0], firstKeys[0]);
  });
});
