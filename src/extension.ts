import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import * as vscode from "vscode";
import { classOf } from "./core/discover";
import { locateClasses, locateMethod, locateMethods, SourceLocation, stripNesting } from "./core/locate";
import { testProjects } from "./core/projects";
import { KnownResult, pruneKnownResults, replayEvents } from "./core/replay";
import { AffectedSet, Runner, TestOutcome } from "./core/runner";
import { cacheDirFor, setDotnetPath, toRepoRelative } from "./core/util";
import { HotPatcher } from "./core/hotpatch";
import { SessionRunner } from "./core/vstestSession";

let runner: Runner | undefined;
let controller: vscode.TestController | undefined;
let statusBar: vscode.StatusBarItem;
let output: vscode.OutputChannel;
let mapBuildCancelled = false;
/** Active continuous-run sessions; while > 0 the plain auto-run-on-save listener stands down. */
let continuousSessions = 0;

/** class FQN -> repo-relative csproj of the owning test project */
const classOwners = new Map<string, string>();
/** class FQN -> source location in the real repo */
const classLocations = new Map<string, SourceLocation>();

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const ws = vscode.workspace.workspaceFolders?.[0];
  if (!ws) return;
  const repoRoot = ws.uri.fsPath;
  // The channel must exist before anything can log: hot-patch init logs
  // synchronously on a cold cache, and an undefined `output` there used to
  // crash the whole session-runner setup silently (first run on a fresh
  // machine never got a fast path).
  output = vscode.window.createOutputChannel("Impact");
  runner = new Runner(repoRoot);
  runner.logSink = (m) => output.appendLine(m);

  const applyDotnetPath = () =>
    setDotnetPath(vscode.workspace.getConfiguration("dotnetImpact").get<string>("dotnetPath", ""));
  applyDotnetPath();

  if (vscode.workspace.getConfiguration("dotnetImpact").get<boolean>("persistentTestSessions", true)) {
    // Hot-patch fast path: hook env goes into every session via runsettings.
    const hot = new HotPatcher(
      repoRoot,
      context.asAbsolutePath("helper-deltas"),
      context.asAbsolutePath("helper-hotpatch"),
      (m) => output.appendLine(m)
    );
    void hot
      .prepareRunsettings()
      .catch((e) => {
        output.appendLine(`hot-patch: init error: ${String(e)}`);
        return false;
      })
      .then((ok) => {
        // Sessions are useful even without the hot-patch hook: warm testhosts
        // still cut per-run startup. Never let hook trouble block them.
        runner!.sessions = new SessionRunner(
          repoRoot,
          context.asAbsolutePath("helper"),
          (m) => output.appendLine(m),
          ok ? hot.runsettingsFile : undefined
        );
        if (ok) runner!.hotpatch = hot;
        output.appendLine(
          ok
            ? "hot-patch: ready (runsettings prepared, delta service on demand)"
            : "hot-patch: UNAVAILABLE — hook helper failed to build; runs use warm sessions + build path"
        );
      });
  } else {
    output.appendLine("persistent sessions disabled by setting — build path every run");
  }
  context.subscriptions.push(
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration("dotnetImpact.dotnetPath")) applyDotnetPath();
    })
  );

  statusBar = vscode.window.createStatusBarItem(vscode.StatusBarAlignment.Left, 50);
  statusBar.command = "dotnetImpact.showStatus";
  updateStatus("idle");
  statusBar.show();

  controller = vscode.tests.createTestController("dotnetImpact", "Impact (affected tests)");
  context.subscriptions.push(controller, statusBar, output);

  populateTreeFromCache();
  void eagerDiscover(); // background: build shadow, discover classes, refresh tree

  // When C# Dev Kit is present it registers its own test controller over the
  // same projects; staying a default profile there would make the Testing
  // view's Run All execute every test twice. Non-default keeps Impact's tree
  // runnable explicitly while Dev Kit owns Run All.
  const devKitPresent = !!vscode.extensions.getExtension("ms-dotnettools.csdevkit");
  const profile = controller.createRunProfile(
    "Affected tests",
    vscode.TestRunProfileKind.Run,
    (request, token) => runHandler(request, token),
    !devKitPresent
  );
  profile.supportsContinuousRun = true;

  // Explicit "run with coverage" (the button Dev Kit users lose): collector
  // run feeding VS Code's native coverage view. Never the default profile —
  // coverage is an ask, not the save loop.
  const coverageProfile = controller.createRunProfile(
    "Coverage",
    vscode.TestRunProfileKind.Coverage,
    (request, token) => coverageRunHandler(request, token),
    false
  );
  coverageProfile.loadDetailedCoverage = async (run, fileCoverage) =>
    coverageDetails.get(run)?.get(fileCoverage.uri.toString()) ?? [];

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
      if (!/\.(cs|razor|cshtml)$/i.test(doc.fileName)) return;
      if (continuousSessions > 0) return; // continuous run already watches saves
      if (!vscode.workspace.getConfiguration("dotnetImpact").get<boolean>("autoRunOnSave", true))
        return;
      pending.add(doc.fileName);
      if (debounce) clearTimeout(debounce);
      const ms = vscode.workspace.getConfiguration("dotnetImpact").get<number>("debounceMs", 300);
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

/** Instant tree from the previous session's discovery, so the panel is never empty. */
function populateTreeFromCache(): void {
  const cached: Record<string, string[]> = {};
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(cacheDirFor(runner!.repoRoot), "discovery-cache.json"), "utf8")
    );
    if (raw?.version === 3) {
      for (const [rel, entry] of Object.entries<{ methods: string[] }>(raw?.projects ?? {})) {
        cached[rel] = entry.methods;
      }
    }
    // Older cache versions held classes only; the map still seeds class items
    // below, and eager discovery refills methods moments later.
  } catch {
    /* first session */
  }
  rebuildTree(cached);
}

/** Discover all test classes (freshness-skipped, parallel) and refresh the tree. */
async function eagerDiscover(): Promise<void> {
  if (!runner || !controller) return;
  try {
    updateStatus("discovering tests…", true);
    await runner.prepare();
    const discovered = await runner.discoverAll({
      parallel: discoveryParallel(),
      onPhase: (m) => updateStatus(m, true),
    });
    rebuildTree(discovered);
    const methodCount = Object.values(discovered).reduce((n, m) => n + m.length, 0);
    updateStatus(`${methodCount} tests in ${classOwners.size} classes`);

    // Auto-build the map for any classes it doesn't cover yet.
    const cfg = vscode.workspace.getConfiguration("dotnetImpact");
    const unmapped = [...classOwners.keys()].filter((c) => !runner!.map.has(c));
    if (cfg.get<boolean>("autoBuildMap", true) && unmapped.length > 0) {
      output.appendLine(`auto-building impact map for ${unmapped.length} unmapped test classes`);
      // Pass this discovery along so pruning sees vstest's class naming too.
      void buildMapWithProgress(vscode.ProgressLocation.Window, discovered);
    }
  } catch (e) {
    updateStatus("discovery error");
    output.appendLine(String(e));
  }
}

/**
 * (Re)build project + class + method items, attaching source locations from
 * the real repo. Discovery lists full method FQNs, so every class's dropdown
 * is populated up front — no run needed to see the methods.
 */
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

    // Group discovered method FQNs under their classes.
    const methodsByClass = new Map<string, string[]>();
    for (const m of discovered[rel] ?? []) {
      const cls = classOf(m);
      if (!cls) continue;
      if (!methodsByClass.has(cls)) methodsByClass.set(cls, []);
      methodsByClass.get(cls)!.push(m);
    }

    const locations = locateClasses(p.dir);
    const classes = new Set<string>([
      ...methodsByClass.keys(),
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
      item.canResolveChildren = false; // children are added eagerly below
      projItem.children.add(item);

      // Pre-populate method children (one file read locates them all).
      const methods = (methodsByClass.get(cls) ?? []).sort();
      const names = methods.map((m) => m.slice(cls.length + 1) || m);
      const lines = loc ? locateMethods(loc.file, names) : new Map<string, number>();
      for (let i = 0; i < methods.length; i++) {
        const child = controller.createTestItem(
          methods[i],
          names[i],
          loc ? vscode.Uri.file(loc.file) : undefined
        );
        const line = lines.get(names[i]);
        if (line !== undefined) child.range = new vscode.Range(line, 0, line, 0);
        item.children.add(child);
      }
    }
  }

  // Forget results for methods that just left the tree, or replay re-reports
  // deleted tests at their last state after every subset run (#17).
  pruneKnownResults(knownResults, new Set(Object.values(discovered).flat()));
}

// ---------- running ----------

async function runHandler(
  request: vscode.TestRunRequest,
  token: vscode.CancellationToken
): Promise<void> {
  if (!runner || !controller) return;

  if (request.continuous) {
    // Native continuous run: watch saves until the user toggles the eye off.
    continuousSessions++;
    const listener = vscode.workspace.onDidSaveTextDocument(async (doc) => {
      if (!/\.(cs|razor|cshtml)$/i.test(doc.fileName)) return;
      await executeRun(request, [doc.fileName]);
    });
    token.onCancellationRequested(() => {
      continuousSessions--;
      listener.dispose();
    });
    return;
  }

  await executeRun(request, undefined);
}

/** Per-run line coverage details, served lazily via loadDetailedCoverage. */
const coverageDetails = new WeakMap<vscode.TestRun, Map<string, vscode.StatementCoverage[]>>();

/**
 * Last known result per method item, so a subset run can report the rest of
 * the suite at its previous state — the Testing view's counter then reads
 * "3/all" while running and settles back at "all/all" instead of "3/3".
 */
const knownResults = new Map<string, KnownResult>();

/** The in-flight run, so a newer save can supersede it. */
let activeRun: { ctrl: AbortController; files: string[] | undefined } | undefined;
/** Serializes shadow access: runs execute one at a time, in order. */
let runChain: Promise<void> = Promise.resolve();
let refreshAbort: AbortController | undefined;
let refreshing = false;

/** Run either explicitly requested test items, or the affected set for changed files. */
async function executeRun(
  request: vscode.TestRunRequest,
  changedFiles: string[] | undefined
): Promise<void> {
  if (!runner || !controller) return;

  // Preempt background work: pause map refresh, supersede the in-flight run.
  refreshAbort?.abort();
  if (activeRun) {
    activeRun.ctrl.abort();
    // Carry the superseded run's files into this one so its tests still run.
    if (activeRun.files && changedFiles) {
      changedFiles = [...new Set([...activeRun.files, ...changedFiles])];
    }
  }
  const ctrl = new AbortController();
  const mine = { ctrl, files: changedFiles };
  activeRun = mine;

  const prev = runChain;
  runChain = (async () => {
    await prev.catch(() => undefined);
    if (ctrl.signal.aborted) return; // superseded while queued
    await doRun(request, changedFiles, ctrl.signal);
  })();
  await runChain;
  if (activeRun === mine) activeRun = undefined;
}

async function doRun(
  request: vscode.TestRunRequest,
  changedFiles: string[] | undefined,
  signal: AbortSignal
): Promise<void> {
  const run = controller!.createTestRun(request);
  updateStatus("running…", true);
  try {
    await runner!.prepare();
    let affected: AffectedSet;
    if (changedFiles) {
      affected = runner!.computeAffected(changedFiles);
    } else if (request.include && request.include.length > 0) {
      affected = affectedFromSelection(request.include);
    } else {
      // Top-level "Run Tests" with nothing selected: the whole suite, like any
      // other test extension. Affected selection lives on save-triggered runs
      // and the "Run affected tests now" command.
      affected = {
        classes: [],
        fallbackProjects: testProjects(runner!.projectGraph()),
        changedFiles: [],
      };
    }
    affected.classOwners = Object.fromEntries(classOwners);

    if (affected.classes.length === 0 && affected.fallbackProjects.length === 0) {
      run.appendOutput("no tests affected\r\n");
      updateStatus("no tests affected");
      return;
    }

    markRunning(run, affected);
    const subset = affected.classes.length > 0;
    const reported = new Set<string>();
    // Stream results into Test Explorer as each test invocation finishes
    // (failure-first pass lands red results in the first seconds).
    const result = await runner!.runAffected(affected, signal, (partial) =>
      reportOutcomes(run, partial, reported)
    );
    if (result.cancelled) {
      updateStatus("superseded");
    } else {
      // Settle the counter at all/all: everything not run reports its last state.
      if (subset) replayKnownSuite(run, reported);
      updateStatus(
        result.ok
          ? `✓ ${result.outcomes.length} tests (${affected.classes.length} classes)`
          : `✗ ${result.outcomes.filter((o) => !o.passed && !o.skipped).length} failing`
      );
      // Live map refresh: re-collect coverage for what just ran, in the background.
      const cfg = vscode.workspace.getConfiguration("dotnetImpact");
      if (cfg.get<boolean>("liveMapRefresh", true)) {
        runner!.queueRefreshFromOutcomes(result.outcomes, Object.fromEntries(classOwners));
        void kickRefresh();
      }
    }
    output.appendLine(result.output);
  } catch (e) {
    updateStatus("error");
    output.appendLine(String(e));
  } finally {
    run.end();
  }
}

/** Coverage profile entry: serialized on the same run chain as normal runs. */
async function coverageRunHandler(
  request: vscode.TestRunRequest,
  token: vscode.CancellationToken
): Promise<void> {
  if (!runner || !controller) return;
  refreshAbort?.abort();
  activeRun?.ctrl.abort();
  const ctrl = new AbortController();
  token.onCancellationRequested(() => ctrl.abort());
  const mine = { ctrl, files: undefined as string[] | undefined };
  activeRun = mine;
  const prev = runChain;
  runChain = (async () => {
    await prev.catch(() => undefined);
    if (ctrl.signal.aborted) return;
    await doCoverageRun(request, ctrl.signal);
  })();
  await runChain;
  if (activeRun === mine) activeRun = undefined;
}

async function doCoverageRun(request: vscode.TestRunRequest, signal: AbortSignal): Promise<void> {
  const run = controller!.createTestRun(request);
  updateStatus("coverage run…", true);
  try {
    await runner!.prepare();
    const affected: AffectedSet =
      request.include && request.include.length > 0
        ? affectedFromSelection(request.include)
        : { classes: [], fallbackProjects: testProjects(runner!.projectGraph()), changedFiles: [] };
    affected.classOwners = Object.fromEntries(classOwners);
    if (affected.classes.length === 0 && affected.fallbackProjects.length === 0) {
      run.appendOutput("no tests selected\r\n");
      return;
    }

    markRunning(run, affected);
    const subset = affected.classes.length > 0;
    const reported = new Set<string>();
    const result = await runner!.runCoverage(affected, signal, (partial) =>
      reportOutcomes(run, partial, reported)
    );

    if (result.cancelled) {
      updateStatus("superseded");
    } else {
      const details = new Map<string, vscode.StatementCoverage[]>();
      for (const [file, lines] of result.coverage) {
        if (path.isAbsolute(file)) continue; // generated/SDK sources outside the repo
        const uri = vscode.Uri.file(path.join(runner!.repoRoot, file));
        const statements = [...lines.entries()]
          .sort((a, b) => a[0] - b[0])
          .map(([line, hits]) => new vscode.StatementCoverage(hits, new vscode.Position(line - 1, 0)));
        details.set(uri.toString(), statements);
        run.addCoverage(vscode.FileCoverage.fromDetails(uri, statements));
      }
      coverageDetails.set(run, details);
      if (subset) replayKnownSuite(run, reported);
      updateStatus(
        result.ok
          ? `✓ ${result.outcomes.length} tests, coverage on ${details.size} files`
          : `✗ ${result.outcomes.filter((o) => !o.passed && !o.skipped).length} failing`
      );
    }
    output.appendLine(result.output);
  } catch (e) {
    updateStatus("error");
    output.appendLine(String(e));
  } finally {
    run.end();
  }
}

/** Drain the map-refresh queue while the shadow is idle; runs preempt it. */
async function kickRefresh(): Promise<void> {
  if (!runner || refreshing || mapBuilding || runner.pendingRefresh.size === 0) return;
  refreshing = true;
  refreshAbort = new AbortController();
  try {
    const n = await runner.refreshPending({
      signal: refreshAbort.signal,
      onProgress: (remaining, cls) =>
        updateStatus(`refreshing map (${remaining + 1} left): ${cls.split(".").pop()}`, true),
    });
    if (n > 0 && !refreshAbort.signal.aborted) {
      updateStatus(`map: ${runner.map.classCount} classes (fresh)`);
    }
  } catch (e) {
    output.appendLine(`map refresh error: ${String(e)}`);
  } finally {
    refreshing = false;
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

/**
 * Mark everything this run will actually execute as queued+running, down to
 * the method leaves. Only items that are really running spin — the untouched
 * rest of the suite keeps its icons (see core/replay.ts for the v0.1.2
 * lesson). Items that end without a result are reset by run.end().
 */
function markRunning(run: vscode.TestRun, affected: AffectedSet): void {
  const fallbackRels = new Set(
    affected.fallbackProjects.map((p) => toRepoRelative(runner!.repoRoot, p.csproj))
  );
  const classes = new Set(affected.classes);
  for (const [cls, rel] of classOwners) if (fallbackRels.has(rel)) classes.add(cls);
  for (const cls of classes) {
    const item = findClassItem(cls);
    if (!item) continue;
    run.enqueued(item);
    run.started(item);
    item.children.forEach((m) => {
      run.enqueued(m);
      run.started(m);
    });
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

function reportOutcomes(run: vscode.TestRun, outcomes: TestOutcome[], reported?: Set<string>): void {
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
    const failed = results.filter((r) => !r.passed && !r.skipped);
    const duration = results.reduce((s, r) => s + (r.durationMs ?? 0), 0);
    const allSkipped = results.every((r) => r.skipped);
    let message: string | undefined;
    if (allSkipped) {
      run.skipped(methodItem);
    } else if (failed.length === 0) {
      run.passed(methodItem, duration);
    } else {
      message = failed.map((f) => `${f.method}: ${f.message ?? "failed"}`).join("\n");
      run.failed(methodItem, new vscode.TestMessage(message), duration);
    }
    reported?.add(methodFqn);
    knownResults.set(methodFqn, {
      classFqn: cls,
      passed: !allSkipped && failed.length === 0,
      skipped: allSkipped,
      duration,
      message,
    });

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

/** Settle the counter at "all/all" after a subset run; see core/replay.ts. */
function replayKnownSuite(run: vscode.TestRun, skip: Set<string>): void {
  for (const ev of replayEvents(knownResults, skip)) {
    const cls = knownResults.get(ev.methodFqn)!.classFqn;
    const item = findClassItem(cls)?.children.get(ev.methodFqn);
    if (!item) continue;
    if (ev.state === "skipped") run.skipped(item);
    else if (ev.state === "passed") run.passed(item, ev.duration);
    else run.failed(item, new vscode.TestMessage(ev.message ?? "failed"), ev.duration);
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
  await executeRun(new vscode.TestRunRequest(), await runner.changedFiles());
}

let mapBuilding = false;

/** Width for parallel test discovery; each --list-tests run costs roughly a core. */
function discoveryParallel(): number {
  const configured = vscode.workspace
    .getConfiguration("dotnetImpact")
    .get<number>("maxParallelCoverageRuns", 0);
  return configured > 0 ? configured : Math.max(1, Math.min(12, os.cpus().length - 2));
}

async function buildMapWithProgress(
  location: vscode.ProgressLocation = vscode.ProgressLocation.Notification,
  discovered?: Record<string, string[]>
): Promise<void> {
  if (!runner || mapBuilding) return;
  mapBuilding = true;
  mapBuildCancelled = false;
  try {
    await vscode.window.withProgress(
      {
        location,
        title: "Impact: building impact map",
        cancellable: location === vscode.ProgressLocation.Notification,
      },
      async (progress, token) => {
        token.onCancellationRequested(() => (mapBuildCancelled = true));
        await runner!.prepare();
        discovered ??= await runner!.discoverAll({
          parallel: discoveryParallel(),
          onPhase: (message) => {
            progress.report({ message });
            updateStatus(message, true);
          },
        });
        const res = await runner!.buildMap({
          discovered,
          shouldCancel: () => mapBuildCancelled,
          onPhase: (message) => {
            progress.report({ message });
            updateStatus(`map: ${message}`, true);
          },
          onProgress: (done, total, current) => {
            const pct = Math.round((done / Math.max(total, 1)) * 100);
            const cls = current.split(".").pop() ?? current;
            progress.report({
              message: `${pct}% — ${done + 1}/${total} ${cls}`,
              increment: 100 / Math.max(total, 1),
            });
            updateStatus(`map: ${pct}% (${done + 1}/${total})`, true);
          },
        });
        updateStatus(`map: ${runner!.map.classCount} classes`);
        if (res.failed.length > 0) {
          output.appendLine(`map build finished with ${res.failed.length} failures:`);
          for (const f of res.failed) output.appendLine(`  ${f}`);
        }
      }
    );
  } finally {
    mapBuilding = false;
  }
}

export function deactivate(): void {
  runner?.sessions?.dispose(true); // shadow worktree itself persists intentionally
  runner?.hotpatch?.dispose();
}
