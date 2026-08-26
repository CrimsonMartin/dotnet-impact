import * as path from "path";
import * as vscode from "vscode";
import { testProjects } from "./core/projects";
import { AffectedSet, Runner, TestOutcome } from "./core/runner";
import { toRepoRelative } from "./core/util";

let runner: Runner | undefined;
let controller: vscode.TestController | undefined;
let statusBar: vscode.StatusBarItem;
let output: vscode.OutputChannel;
let mapBuildCancelled = false;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const ws = vscode.workspace.workspaceFolders?.[0];
  if (!ws) return;
  const repoRoot = ws.uri.fsPath;
  runner = new Runner(repoRoot);

  output = vscode.window.createOutputChannel("dotnet-impact");
  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  statusBar.command = "dotnetImpact.showStatus";
  updateStatus("idle");
  statusBar.show();

  controller = vscode.tests.createTestController("dotnetImpact", "dotnet-impact (affected tests)");
  context.subscriptions.push(controller, statusBar, output);

  populateTree();

  const profile = controller.createRunProfile(
    "Affected tests",
    vscode.TestRunProfileKind.Run,
    (request, token) => runHandler(request, token),
    true
  );
  profile.supportsContinuousRun = true;

  context.subscriptions.push(
    vscode.commands.registerCommand("dotnetImpact.buildMap", () => buildMapWithProgress()),
    vscode.commands.registerCommand("dotnetImpact.runAffected", () => runAffectedNow()),
    vscode.commands.registerCommand("dotnetImpact.showStatus", () => {
      output.show();
      output.appendLine(`impact map: ${runner!.map.classCount} test classes mapped`);
    }),
    vscode.commands.registerCommand("dotnetImpact.toggleAutoRun", async () => {
      const cfg = vscode.workspace.getConfiguration("dotnetImpact");
      await cfg.update("autoRunOnSave", !cfg.get<boolean>("autoRunOnSave", true));
    })
  );

  // Auto-run on save outside of an explicit continuous-run session, if enabled.
  let debounce: NodeJS.Timeout | undefined;
  const pending = new Set<string>();
  context.subscriptions.push(
    vscode.workspace.onDidSaveTextDocument((doc) => {
      if (!doc.fileName.endsWith(".cs")) return;
      if (!vscode.workspace.getConfiguration("dotnetImpact").get<boolean>("autoRunOnSave", true))
        return;
      pending.add(doc.fileName);
      if (debounce) clearTimeout(debounce);
      const ms = vscode.workspace.getConfiguration("dotnetImpact").get<number>("debounceMs", 1500);
      debounce = setTimeout(() => {
        const files = [...pending];
        pending.clear();
        void runForFiles(files);
      }, ms);
    })
  );
}

function updateStatus(text: string, spin = false): void {
  statusBar.text = `$(${spin ? "sync~spin" : "beaker"}) impact: ${text}`;
}

function populateTree(): void {
  if (!controller || !runner) return;
  controller.items.replace([]);
  const graph = runner.projectGraph();
  for (const p of testProjects(graph)) {
    const projItem = controller.createTestItem(p.csproj, p.name, vscode.Uri.file(p.csproj));
    controller.items.add(projItem);
  }
  // Class items come from the impact map (populated as the map builds).
  addMappedClasses();
}

function addMappedClasses(): void {
  if (!controller || !runner) return;
  const graph = runner.projectGraph();
  const byProject = new Map<string, vscode.TestItem>();
  controller.items.forEach((item) => byProject.set(item.id.toLowerCase(), item));
  for (const p of testProjects(graph)) {
    const projItem = byProject.get(p.csproj.toLowerCase());
    if (!projItem) continue;
    // Walk map entries owned by this project.
    for (const cls of allMappedClasses()) {
      const entry = runner.map.entry(cls);
      if (!entry) continue;
      const abs = path.join(runner.repoRoot, entry.csproj);
      if (abs.toLowerCase() !== p.csproj.toLowerCase()) continue;
      if (!projItem.children.get(cls)) {
        projItem.children.add(controller.createTestItem(cls, cls.split(".").pop() ?? cls));
      }
    }
  }
}

function allMappedClasses(): string[] {
  return runner!.map.classes();
}

async function runHandler(
  request: vscode.TestRunRequest,
  token: vscode.CancellationToken
): Promise<void> {
  if (!runner || !controller) return;

  if (request.continuous) {
    // Native continuous run: watch saves until the user toggles the eye off.
    const listener = vscode.workspace.onDidSaveTextDocument(async (doc) => {
      if (!doc.fileName.endsWith(".cs")) return;
      await executeRun(request, [doc.fileName]);
    });
    token.onCancellationRequested(() => listener.dispose());
    return;
  }

  await executeRun(request, undefined);
}

/** Run either explicitly requested test items, or the affected set for changed files. */
async function executeRun(
  request: vscode.TestRunRequest,
  changedFiles: string[] | undefined
): Promise<void> {
  if (!runner || !controller) return;
  const run = controller.createTestRun(request);
  updateStatus("running…", true);
  try {
    await runner.prepare();
    let affected: AffectedSet;
    if (changedFiles) {
      affected = runner.computeAffected(changedFiles);
    } else if (request.include && request.include.length > 0) {
      const classes = request.include.filter((i) => !i.id.endsWith(".csproj")).map((i) => i.id);
      affected = { classes, fallbackProjects: [], changedFiles: [] };
      // Whole-project items selected → run those projects in full.
      const projs = request.include.filter((i) => i.id.endsWith(".csproj"));
      const graph = runner.projectGraph();
      affected.fallbackProjects = testProjects(graph).filter((p) =>
        projs.some((i) => i.id.toLowerCase() === p.csproj.toLowerCase())
      );
    } else {
      affected = runner.computeAffected(await runner.changedFiles());
    }

    if (affected.classes.length === 0 && affected.fallbackProjects.length === 0) {
      run.appendOutput("no tests affected\r\n");
      updateStatus("no tests affected");
      return;
    }

    markEnqueued(run, affected);
    const result = await runner.runAffected(affected);
    reportOutcomes(run, result.outcomes);
    updateStatus(
      result.ok
        ? `✓ ${result.outcomes.length} tests (${affected.classes.length} classes)`
        : `✗ ${result.outcomes.filter((o) => !o.passed).length} failing`
    );
    output.appendLine(result.output);
  } catch (e) {
    updateStatus("error");
    output.appendLine(String(e));
  } finally {
    run.end();
  }
}

function markEnqueued(run: vscode.TestRun, affected: AffectedSet): void {
  for (const cls of affected.classes) {
    const item = findClassItem(cls);
    if (item) run.enqueued(item);
  }
}

function findClassItem(cls: string): vscode.TestItem | undefined {
  let found: vscode.TestItem | undefined;
  controller!.items.forEach((proj) => {
    const c = proj.children.get(cls);
    if (c) found = c;
  });
  return found;
}

function reportOutcomes(run: vscode.TestRun, outcomes: TestOutcome[]): void {
  const byClass = new Map<string, TestOutcome[]>();
  for (const o of outcomes) {
    if (!byClass.has(o.classFqn)) byClass.set(o.classFqn, []);
    byClass.get(o.classFqn)!.push(o);
  }
  for (const [cls, results] of byClass) {
    const item = findClassItem(cls) ?? ensureClassItem(cls);
    if (!item) continue;
    const failed = results.filter((r) => !r.passed);
    const duration = results.reduce((s, r) => s + (r.durationMs ?? 0), 0);
    if (failed.length === 0) {
      run.passed(item, duration);
    } else {
      const msg = failed.map((f) => `${f.method}: ${f.message ?? "failed"}`).join("\n");
      run.failed(item, new vscode.TestMessage(msg), duration);
    }
  }
}

function ensureClassItem(cls: string): vscode.TestItem | undefined {
  if (!runner || !controller) return undefined;
  const entry = runner.map.entry(cls);
  const projId = entry ? path.join(runner.repoRoot, entry.csproj) : undefined;
  let projItem: vscode.TestItem | undefined;
  if (projId) {
    controller.items.forEach((i) => {
      if (i.id.toLowerCase() === projId.toLowerCase()) projItem = i;
    });
  }
  const item = controller.createTestItem(cls, cls.split(".").pop() ?? cls);
  if (projItem) (projItem as vscode.TestItem).children.add(item);
  else controller.items.add(item);
  return item;
}

async function runAffectedNow(): Promise<void> {
  if (!runner) return;
  await executeRun(new vscode.TestRunRequest(), undefined);
}

async function buildMapWithProgress(): Promise<void> {
  if (!runner) return;
  mapBuildCancelled = false;
  await vscode.window.withProgress(
    {
      location: vscode.ProgressLocation.Notification,
      title: "dotnet-impact: building impact map",
      cancellable: true,
    },
    async (progress, token) => {
      token.onCancellationRequested(() => (mapBuildCancelled = true));
      await runner!.prepare();
      const res = await runner!.buildMap({
        shouldCancel: () => mapBuildCancelled,
        onProgress: (done, total, current) => {
          progress.report({
            message: `${done + 1}/${total} ${current}`,
            increment: 100 / Math.max(total, 1),
          });
        },
      });
      addMappedClasses();
      updateStatus(`map: ${runner!.map.classCount} classes`);
      if (res.failed.length > 0) {
        output.appendLine(`map build finished with ${res.failed.length} failures:`);
        for (const f of res.failed) output.appendLine(`  ${f}`);
      }
    }
  );
}

async function runForFiles(files: string[]): Promise<void> {
  if (!runner || !controller) return;
  const rel = files.map((f) => toRepoRelative(runner!.repoRoot, f));
  output.appendLine(`saved: ${rel.join(", ")}`);
  await executeRun(new vscode.TestRunRequest(), files);
}

export function deactivate(): void {
  /* nothing to clean up; shadow worktree persists intentionally */
}
