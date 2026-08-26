import * as fs from "fs";
import * as path from "path";
import * as vscode from "vscode";
import { discoverTestClasses } from "./core/discover";
import { locateClasses, locateMethod, SourceLocation } from "./core/locate";
import { testProjects } from "./core/projects";
import { AffectedSet, Runner, TestOutcome } from "./core/runner";
import { cacheDirFor, toRepoRelative } from "./core/util";

let runner: Runner | undefined;
let controller: vscode.TestController | undefined;
let statusBar: vscode.StatusBarItem;
let output: vscode.OutputChannel;
let mapBuildCancelled = false;

/** class FQN -> repo-relative csproj of the owning test project */
const classOwners = new Map<string, string>();
/** class FQN -> source location in the real repo */
const classLocations = new Map<string, SourceLocation>();

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

  populateTreeFromCache();
  void eagerDiscover(); // background: build shadow, discover classes, refresh tree

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
      output.appendLine(`discovered: ${classOwners.size} test classes`);
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
        void executeRun(new vscode.TestRunRequest(), files);
      }, ms);
    })
  );
}

function updateStatus(text: string, spin = false): void {
  statusBar.text = `$(${spin ? "sync~spin" : "beaker"}) impact: ${text}`;
}

// ---------- tree population ----------

function discoveryCachePath(): string {
  return path.join(cacheDirFor(runner!.repoRoot), "discovered.json");
}

/** Instant tree from the previous session's discovery, so the panel is never empty. */
function populateTreeFromCache(): void {
  let cached: Record<string, string[]> = {};
  try {
    cached = JSON.parse(fs.readFileSync(discoveryCachePath(), "utf8"));
  } catch {
    /* first session */
  }
  rebuildTree(cached);
}

/** Discover all test classes in the shadow worktree and refresh the tree. */
async function eagerDiscover(): Promise<void> {
  if (!runner || !controller) return;
  try {
    updateStatus("discovering tests…", true);
    const shadow = await runner.prepare();
    const graph = runner.projectGraph();
    const discovered: Record<string, string[]> = {};
    for (const p of testProjects(graph)) {
      const rel = toRepoRelative(runner.repoRoot, p.csproj);
      const shadowCsproj = path.join(shadow.dir, rel);
      try {
        discovered[rel] = await discoverTestClasses(shadowCsproj, shadow.dir);
      } catch (e) {
        output.appendLine(`discovery failed for ${p.name}: ${(e as Error).message}`);
      }
    }
    fs.mkdirSync(path.dirname(discoveryCachePath()), { recursive: true });
    fs.writeFileSync(discoveryCachePath(), JSON.stringify(discovered, null, 1));
    rebuildTree(discovered);
    updateStatus(`${classOwners.size} test classes`);
  } catch (e) {
    updateStatus("discovery error");
    output.appendLine(String(e));
  }
}

/** (Re)build project + class items, attaching source locations from the real repo. */
function rebuildTree(discovered: Record<string, string[]>): void {
  if (!runner || !controller) return;
  const graph = runner.projectGraph();
  classOwners.clear();
  classLocations.clear();
  controller.items.replace([]);

  for (const p of testProjects(graph)) {
    const rel = toRepoRelative(runner.repoRoot, p.csproj);
    const projItem = controller.createTestItem(p.csproj, p.name, vscode.Uri.file(p.csproj));
    controller.items.add(projItem);

    const locations = locateClasses(p.dir);
    const classes = new Set<string>([
      ...(discovered[rel] ?? []),
      ...runner.map.classes().filter((c) => runner!.map.entry(c)?.csproj === rel),
    ]);
    for (const cls of [...classes].sort()) {
      classOwners.set(cls, rel);
      const loc = locations.get(cls) ?? locations.get(stripNesting(cls));
      const item = controller.createTestItem(
        cls,
        cls.split(".").pop() ?? cls,
        loc ? vscode.Uri.file(loc.file) : undefined
      );
      if (loc) {
        classLocations.set(cls, loc);
        item.range = new vscode.Range(loc.line, 0, loc.line, 0);
      }
      item.canResolveChildren = false; // methods appear after first run
      projItem.children.add(item);
    }
  }
}

/** xUnit nested classes render as Ns.Outer+Inner; our locator keys on Ns.Inner. */
function stripNesting(cls: string): string {
  const plus = cls.lastIndexOf("+");
  if (plus < 0) return cls;
  const ns = cls.slice(0, cls.lastIndexOf(".", cls.indexOf("+")));
  return `${ns}.${cls.slice(plus + 1)}`;
}

// ---------- running ----------

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
      affected = affectedFromSelection(request.include);
    } else {
      affected = runner.computeAffected(await runner.changedFiles());
    }
    affected.classOwners = Object.fromEntries(classOwners);

    if (affected.classes.length === 0 && affected.fallbackProjects.length === 0) {
      run.appendOutput("no tests affected\r\n");
      updateStatus("no tests affected");
      return;
    }

    for (const cls of affected.classes) {
      const item = findClassItem(cls);
      if (item) run.enqueued(item);
    }
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

/** Map explicitly selected tree items (projects / classes / methods) to an AffectedSet. */
function affectedFromSelection(include: readonly vscode.TestItem[]): AffectedSet {
  const graph = runner!.projectGraph();
  const classes = new Set<string>();
  const projs = new Set<string>();
  for (const item of include) {
    if (item.id.endsWith(".csproj")) projs.add(item.id.toLowerCase());
    else if (classOwners.has(item.id)) classes.add(item.id);
    else if (item.parent && classOwners.has(item.parent.id)) classes.add(item.parent.id); // method item
  }
  return {
    classes: [...classes].sort(),
    fallbackProjects: testProjects(graph).filter((p) => projs.has(p.csproj.toLowerCase())),
    changedFiles: [],
  };
}

// ---------- result reporting ----------

function findClassItem(cls: string): vscode.TestItem | undefined {
  let found: vscode.TestItem | undefined;
  controller!.items.forEach((proj) => {
    const c = proj.children.get(cls);
    if (c) found = c;
  });
  return found;
}

function reportOutcomes(run: vscode.TestRun, outcomes: TestOutcome[]): void {
  // Group theory cases: "Ns.Class.Method(args)" collapses to one method item.
  const byMethod = new Map<string, TestOutcome[]>();
  for (const o of outcomes) {
    const key = o.method.replace(/\(.*\)$/s, "");
    if (!byMethod.has(key)) byMethod.set(key, []);
    byMethod.get(key)!.push(o);
  }

  const classResults = new Map<string, { passed: boolean; duration: number }>();
  for (const [methodFqn, results] of byMethod) {
    const cls = results[0].classFqn;
    const classItem = findClassItem(cls) ?? ensureClassItem(cls);
    if (!classItem) continue;

    const methodItem = ensureMethodItem(classItem, cls, methodFqn);
    const failed = results.filter((r) => !r.passed);
    const duration = results.reduce((s, r) => s + (r.durationMs ?? 0), 0);
    if (failed.length === 0) {
      run.passed(methodItem, duration);
    } else {
      const msg = failed.map((f) => `${f.method}: ${f.message ?? "failed"}`).join("\n");
      run.failed(methodItem, new vscode.TestMessage(msg), duration);
    }

    const agg = classResults.get(cls) ?? { passed: true, duration: 0 };
    agg.passed = agg.passed && failed.length === 0;
    agg.duration += duration;
    classResults.set(cls, agg);
  }

  // Class rollup (VS Code also aggregates children, but explicit results keep
  // classes green/red even when method children were just created).
  for (const [cls, agg] of classResults) {
    const item = findClassItem(cls);
    if (!item) continue;
    if (agg.passed) run.passed(item, agg.duration);
  }
}

function ensureClassItem(cls: string): vscode.TestItem | undefined {
  if (!runner || !controller) return undefined;
  const rel = classOwners.get(cls) ?? runner.map.entry(cls)?.csproj;
  const projAbs = rel ? path.join(runner.repoRoot, rel) : undefined;
  let projItem: vscode.TestItem | undefined;
  if (projAbs) {
    controller.items.forEach((i) => {
      if (i.id.toLowerCase() === projAbs.toLowerCase()) projItem = i;
    });
  }
  const item = controller.createTestItem(cls, cls.split(".").pop() ?? cls);
  if (projItem) (projItem as vscode.TestItem).children.add(item);
  else controller.items.add(item);
  return item;
}

function ensureMethodItem(
  classItem: vscode.TestItem,
  cls: string,
  methodFqn: string
): vscode.TestItem {
  const existing = classItem.children.get(methodFqn);
  if (existing) return existing;
  const methodName = methodFqn.slice(cls.length + 1) || methodFqn;
  const loc = classLocations.get(cls);
  let uri: vscode.Uri | undefined;
  let range: vscode.Range | undefined;
  if (loc) {
    uri = vscode.Uri.file(loc.file);
    const line = locateMethod(loc.file, methodName);
    if (line !== undefined) range = new vscode.Range(line, 0, line, 0);
  }
  const item = controller!.createTestItem(methodFqn, methodName, uri);
  if (range) item.range = range;
  classItem.children.add(item);
  return item;
}

// ---------- commands ----------

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
      updateStatus(`map: ${runner!.map.classCount} classes`);
      if (res.failed.length > 0) {
        output.appendLine(`map build finished with ${res.failed.length} failures:`);
        for (const f of res.failed) output.appendLine(`  ${f}`);
      }
    }
  );
}

export function deactivate(): void {
  /* nothing to clean up; shadow worktree persists intentionally */
}
