import * as assert from "node:assert";
import * as fs from "node:fs";
import * as path from "node:path";
import * as ts from "typescript";

/**
 * Fix-6 (finding F7): structural URI guard.
 *
 * Every functional `jetgit-plus:/` URI constructed in the host sources must
 * carry `?repo=<repoId>`. Without it, GitContentProvider / editSource fall back
 * to the *active* repo, so after a multi-repo switch a bare URI silently
 * resolves against the wrong repository (this is exactly the shelf-diff bug
 * F7 fixed, and the bug that made `compareWithCurrent` resolve nothing).
 *
 * This test is a non-vacuous guard: it greps the on-disk source of *every*
 * host TypeScript file under src/ (excluding tests) and fails the moment anyone
 * introduces a constructed URI lacking `repo=`. It deliberately reads source
 * from disk (rather than importing behavior) because the hazard is a
 * *string-construction* defect, not a runtime-behavior defect — a bare template
 * literal compiles and runs fine but resolves to the wrong repo.
 *
 * Coverage / marker scope:
 * - The marker `${JETGIT_PLUS_SCHEME}:/` matches URI *string construction* —
 *   the `:/` separator immediately follows the scheme constant. This is the
 *   only construction form in use today, and the form the sanctioned builder
 *   (`buildGitContentUri` in src/views/gitUri.ts) emits.
 * - Provider registrations (`registerTextDocumentContentProvider(JETGIT_PLUS_SCHEME, …)`,
 *   `registerFileSystemProvider(JETGIT_PLUS_SCHEME, …)`) pass the scheme as a
 *   bare arg with no `:/`, so they are correctly NOT matched.
 * - Comments/docstrings that mention the literal `jetgit-plus:/` do not use the
 *   `${JETGIT_PLUS_SCHEME}:/` template marker, so they are also excluded.
 * - A separate TypeScript-AST pass below catches direct `Uri.parse` and
 *   `Uri.from` calls that reference the JetGit scheme and requires them to live
 *   in gitUri.ts. If a future implementation uses another URI-construction
 *   API, extend collectDirectUriConstructions so this remains exhaustive.
 */

/**
 * Marker for a constructed jetgit-plus:/ URI (scheme + path separator).
 * This is the *literal* source text we grep for — it must not be a real
 * template literal, so the curly braces are intentional.
 */
// biome-ignore lint/suspicious/noTemplateCurlyInString: literal source substring being grepped, not a template
const URI_MARKER = "${JETGIT_PLUS_SCHEME}:/";

/**
 * Enumerate every host TypeScript source under src/, excluding src/test/**
 * (the audit file itself contains URI_MARKER as a literal in its own source +
 * test fixtures, so scanning tests would false-positive). Returns paths
 * relative to the repo root, prefixed with `src/`.
 */
function listHostTsFiles(): string[] {
  // Host tests run under @vscode/test-cli with the repo root as cwd.
  const root = path.join(process.cwd(), "src");
  // recursive read (Node 18.17+/20+); filter to .ts, drop src/test/**.
  const entries = fs.readdirSync(root, { recursive: true }) as string[];
  return entries
    .filter((rel) => rel.endsWith(".ts"))
    .filter((rel) => !rel.split(path.sep).includes("test"))
    .map((rel) => path.join("src", rel));
}

function readLines(rel: string): string[] {
  const abs = path.join(process.cwd(), rel);
  return fs.readFileSync(abs, "utf8").split(/\r?\n/);
}

/** Lines that construct a jetgit-plus:/ URI (across all host sources). */
function collectUriLines(): { file: string; line: string }[] {
  const out: { file: string; line: string }[] = [];
  for (const rel of listHostTsFiles()) {
    for (const line of readLines(rel)) {
      if (line.includes(URI_MARKER)) {
        out.push({ file: rel, line });
      }
    }
  }
  return out;
}

interface DirectUriConstruction {
  file: string;
  line: number;
  source: string;
}

/**
 * Find direct vscode.Uri.parse/Uri.from constructions whose arguments mention
 * the JetGit content scheme. Unlike URI_MARKER, this also catches component
 * construction such as `vscode.Uri.from({ scheme: JETGIT_PLUS_SCHEME, ... })`.
 */
function collectDirectUriConstructions(): DirectUriConstruction[] {
  const out: DirectUriConstruction[] = [];
  for (const rel of listHostTsFiles()) {
    const source = fs.readFileSync(path.join(process.cwd(), rel), "utf8");
    const sourceFile = ts.createSourceFile(
      rel,
      source,
      ts.ScriptTarget.Latest,
      true,
      ts.ScriptKind.TS,
    );

    const visit = (node: ts.Node): void => {
      if (
        ts.isCallExpression(node) &&
        ts.isPropertyAccessExpression(node.expression) &&
        (node.expression.name.text === "parse" ||
          node.expression.name.text === "from") &&
        /(?:^|\.)Uri$/.test(node.expression.expression.getText(sourceFile))
      ) {
        const args = node.arguments
          .map((argument) => argument.getText(sourceFile))
          .join(", ");
        if (
          args.includes("JETGIT_PLUS_SCHEME") ||
          args.includes("jetgit-plus:")
        ) {
          const { line } = sourceFile.getLineAndCharacterOfPosition(
            node.getStart(sourceFile),
          );
          out.push({
            file: rel,
            line: line + 1,
            source: node.getText(sourceFile),
          });
        }
      }
      ts.forEachChild(node, visit);
    };
    visit(sourceFile);
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
        "construction across all host TypeScript sources under src/ (excluding " +
        "tests). Did the construction pattern change? Update URI_MARKER so this " +
        "guard keeps meaning something.",
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

  it("centralizes every direct JetGit content URI construction in gitUri.ts", () => {
    const builderFile = path.normalize("src/views/gitUri.ts");
    const offenders = collectDirectUriConstructions().filter(
      (entry) => path.normalize(entry.file) !== builderFile,
    );
    assert.strictEqual(
      offenders.length,
      0,
      "Construct JetGit content URIs through buildGitContentUri instead of " +
        "calling Uri.parse/Uri.from directly:\n" +
        offenders
          .map(
            (entry) =>
              `  ${entry.file}:${entry.line}: ${entry.source.replace(/\s+/g, " ")}`,
          )
          .join("\n"),
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
