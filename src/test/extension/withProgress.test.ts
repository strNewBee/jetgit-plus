import * as assert from "node:assert";
import type * as vscode from "vscode";
import { withProgress } from "../../extension";
import { MessageRouter } from "../../messages/messageRouter";
import type { EventMessage } from "../../messages/protocol";

/**
 * Task 22 (P2#8): withProgress must broadcast operationStart/operationEnd
 * carrying the acting repoId so the webview can filter busy state per repo.
 * This drives the panel-store filter: an op on repo B must not disable the UI
 * while repo A is visible.
 */
function fakeWebview(sink: (msg: EventMessage) => void): vscode.Webview {
  return {
    postMessage: (msg: unknown) => {
      const m = msg as EventMessage;
      if (m?.type === "event") sink(m);
      return Promise.resolve(true);
    },
    onDidReceiveMessage: () => ({ dispose: () => {} }),
  } as unknown as vscode.Webview;
}

describe("withProgress operation event tagging", () => {
  it("broadcasts operationStart/operationEnd carrying the given repoId", async () => {
    const router = new MessageRouter();
    const events: EventMessage[] = [];
    const wv = fakeWebview((m) => events.push(m));
    const reg = router.registerWebview(wv);
    try {
      let ran = false;
      await withProgress(router, "RID", async () => {
        ran = true;
      });
      assert.strictEqual(ran, true);

      const starts = events.filter((e) => e.event === "operationStart");
      const ends = events.filter((e) => e.event === "operationEnd");
      assert.strictEqual(starts.length, 1, "exactly one operationStart");
      assert.strictEqual(ends.length, 1, "exactly one operationEnd");
      assert.deepStrictEqual(starts[0].data, { repoId: "RID" });
      assert.deepStrictEqual(ends[0].data, { repoId: "RID" });

      // Start must be broadcast BEFORE the operation body runs, end AFTER.
      assert.strictEqual(events[0].event, "operationStart");
      assert.strictEqual(events[events.length - 1].event, "operationEnd");
    } finally {
      reg.dispose();
    }
  });

  it("broadcasts repoId:null for a non-repo-bound operation", async () => {
    const router = new MessageRouter();
    const events: EventMessage[] = [];
    const wv = fakeWebview((m) => events.push(m));
    const reg = router.registerWebview(wv);
    try {
      await withProgress(router, null, async () => {});
      const start = events.find((e) => e.event === "operationStart");
      assert.ok(start, "operationStart emitted");
      assert.deepStrictEqual(start?.data, { repoId: null });
    } finally {
      reg.dispose();
    }
  });

  it("emits operationEnd even when the operation throws", async () => {
    const router = new MessageRouter();
    const events: EventMessage[] = [];
    const wv = fakeWebview((m) => events.push(m));
    const reg = router.registerWebview(wv);
    try {
      await assert.rejects(
        withProgress(router, "RID", async () => {
          throw new Error("boom");
        }),
        /boom/,
      );
      assert.strictEqual(
        events.some((e) => e.event === "operationEnd"),
        true,
        "operationEnd emitted despite failure",
      );
    } finally {
      reg.dispose();
    }
  });
});
