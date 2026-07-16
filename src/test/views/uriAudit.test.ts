import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";

/**
 * Fix-6 (finding F7): structural URI guard.
 *
 * Every functional `jetgit-plus:/` URI constructed in the host sources must
 * carry `?repo=<repoId>`. Without it, GitContentProvider / editSource fall back
 * to the *active* repo, so after a multi-repo switch a bare URI silently
 * resolves against the wrong repository (this is exactly the shelf-diff bug
 * F7 fixed, and the bug that made `compareWithCurrent` resolve nothing).
 *
 * This test is a non-vacuous guard: it greps the on-disk source of the files
 * that build `jetgit-plus:/` URIs and fails the moment anyone introduces a
 * constructed URI lacking `repo=`. It deliberately reads source from disk
 * (rather than importing behavior) because the hazard is a *string-construction*
 * defect, not a runtime-behavior defect — a bare template literal compiles and
 * runs fine but resolves to the wrong repo.
 */

/** Files known to construct `jetgit-plus:/` URIs (keep in sync with src/). */
const HOST_FILES = ["src/extension.ts", "src/views/gitUri.ts"];

/**
 * Marker for a constructed jetgit-plus:/ URI (scheme + path separator).
 * This is the *literal* source text we grep for — it must not be a real
 * template literal, so the curly braces are intentional.
 */
// biome-ignore lint/suspicious/noTemplateCurlyInString: literal source substring being grepped, not a template
const URI_MARKER = "${JETGIT_PLUS_SCHEME}:/";

function readLines(rel: string): string[] {
  // Host tests run under @vscode/test-cli with the repo root as cwd.
  const abs = path.join(process.cwd(), rel);
  return fs.readFileSync(abs, "utf8").split(/\r?\n/);
}

/** Lines that construct a jetgit-plus:/ URI (anywhere in HOST_FILES). */
function collectUriLines(): { file: string; line: string }[] {
  const out: { file: string; line: string }[] = [];
  for (const rel of HOST_FILES) {
    for (const line of readLines(rel)) {
      if (line.includes(URI_MARKER)) {
        out.push({ file: rel, line });
      }
    }
  }
  return out;
}

describe("Fix-6 URI audit — every jetgit-plus:/ URI carries repo=", () => {
  it("the host sources actually construct jetgit-plus:/ URIs (guard is non-vacuous)", () => {
    const uriLines = collectUriLines();
    assert.ok(
      uriLines.length > 0,
      // biome-ignore lint/suspicious/noTemplateCurlyInString: literal substring in message, not a template
      "URI audit is vacuous — expected at least one `${JETGIT_PLUS_SCHEME}:/` " +
        "construction in HOST_FILES. Did the construction pattern change? Update " +
        "URI_MARKER/HOST_FILES so this guard keeps meaning something.",
    );
  });

  it("every constructed jetgit-plus:/ URI line contains repo=", () => {
    const uriLines = collectUriLines();
    const offenders = uriLines.filter((entry) => !entry.line.includes("repo="));
    assert.strictEqual(
      offenders.length,
      0,
      "Found jetgit-plus:/ URI(s) without `repo=` — these resolve against the " +
        "active repo and break after a multi-repo switch:\n" +
        offenders.map((o) => `  ${o.file}: ${o.line.trim()}`).join("\n"),
    );
  });

  it("the sanctioned builder (buildGitContentUri) output parses with repo present", () => {
    // Imported lazily so a module-load error is attributed to this test, not the
    // describe-body. Confirms the shelf-style path round-trips a repo param.
    const { buildGitContentUri } =
      require("../../views/gitUri") as typeof import("../../views/gitUri");
    const uri = buildGitContentUri("base", "shelved/myshelf/src/a.ts", "RID");
    const params = new URLSearchParams(uri.query);
    assert.strictEqual(params.get("repo"), "RID");
    assert.strictEqual(params.get("ref"), "base");
  });
});
