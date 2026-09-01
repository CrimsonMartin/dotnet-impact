// Impact delta service.
//
// Resident process holding ONE Roslyn workspace reconstructed from complogs
// (Basic.CompilerLog), spanning every loaded project (#22). Edits are
// evaluated by Roslyn's own Edit-and-Continue engine (the one behind
// dotnet-watch hot reload) via the vendored ImpactHotReloadService facade:
// everything the runtime supports — method bodies, added methods/fields/
// types, lambdas, and with the solution-wide session cross-project changes —
// becomes deltas the extension pushes into live testhosts; rude edits are
// refused with their ENC diagnostic so the caller falls back to a real build.
//
// Protocol: JSON lines on stdin/stdout.
//   -> {"id":1,"cmd":"load","binlog":"/abs/x.complog","csproj":"/abs/Lib.csproj","dll":"/abs/Lib.dll",
//       "caps":["Baseline","AddMethodToExistingType",...]}   caps optional: live-host capability intersection
//   <- {"id":1,"type":"done","ok":true,"assembly":"Lib"}
//   -> {"id":2,"cmd":"delta","files":["/abs/Calc.cs","/abs/Consumer.cs"],
//       "apiGuardExempt":["/abs/Lib.csproj"]}
//      ("file":"/abs/Calc.cs" also accepted for a single edit; "csproj" accepted and ignored
//       for lookup — documents resolve across the whole loaded solution)
//   <- {"id":2,"type":"done","ok":true,
//       "updates":[{"assembly":"Lib","md":"<b64>","il":"<b64>","pdb":"<b64>"}, ...]}
//      (plus legacy top-level assembly/md/il/pdb when exactly one update)
//      or {"id":2,"type":"done","ok":false,"reason":"rude edit ENC0023: ..."}
//   -> {"id":3,"cmd":"reset"}   drop all state (after a real rebuild)
//
// Baselines chain across generations inside the EnC session. Loading a
// project REBUILDS the merged solution and RESTARTS the session, which
// re-reads baselines from disk — safe only while no delta has been committed
// this epoch. A load after a committed delta is therefore refused
// ("mid-epoch load"), and the caller takes the build path, which resets the
// epoch and reloads everything fresh.

using System.Collections.Immutable;
using System.Text;
using System.Text.Json;
using Basic.CompilerLog.Util;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.ExternalAccess.HotReload.Api;
using Microsoft.CodeAnalysis.Text;

var solution = new EncSolution();
var stdout = Console.Out;
void Emit(object payload) => stdout.WriteLine(JsonSerializer.Serialize(payload));

Emit(new { type = "ready" });
string? line;
while ((line = Console.ReadLine()) != null)
{
    int id = 0;
    try
    {
        using var doc = JsonDocument.Parse(line);
        var root = doc.RootElement;
        id = root.TryGetProperty("id", out var idEl) ? idEl.GetInt32() : 0;
        switch (root.GetProperty("cmd").GetString())
        {
            case "shutdown":
                solution.Reset();
                return 0;
            case "reset":
                solution.Reset();
                Emit(new { id, type = "done", ok = true });
                break;
            case "snapshot":
            {
                // Freeze a binlog into a complog RIGHT AFTER a build: complogs
                // embed source text, so later edits to the files on disk can't
                // corrupt the baseline the way raw binlogs (path-only) would.
                var binlog = root.GetProperty("binlog").GetString()!;
                var complog = root.GetProperty("complog").GetString()!;
                // A loaded project's SolutionReader keeps its complog open
                // (it backs the solution's lazy text loaders), and FileShare
                // is enforced even intra-process — on Linux via advisory
                // locks — so converting over it would fail with a sharing
                // violation. The rebuild that produced this binlog stales
                // those baselines anyway: evict before rewriting.
                solution.EvictComplog(complog);
                // An up-to-date build skips the compiler entirely; its binlog
                // holds zero calls and converting it would replace a good
                // baseline with an empty one. Count first, convert only if real.
                int calls;
                using (var callReader = CompilerCallReaderUtil.Create(binlog, BasicAnalyzerKind.OnDisk))
                    calls = callReader.ReadAllCompilerCalls().Count;
                var warnings = 0;
                if (calls > 0)
                    warnings = CompilerLogUtil.ConvertBinaryLog(binlog, complog).Count;
                Emit(new { id, type = "done", ok = true, calls, warnings });
                break;
            }
            case "guard":
            {
                // Pure API-surface check (old source -> new source): the
                // unit-test surface for the cross-project safety valve.
                var oldText = root.GetProperty("old").GetString()!;
                var newText = root.GetProperty("new").GetString()!;
                var removed = ApiGuard.RemovedVisibleDeclaration(oldText, newText);
                var addedTest = removed == null ? ApiGuard.AddedTestMethod(oldText, newText) : null;
                if (removed != null) Emit(new { id, type = "done", ok = false, reason = $"api change: {removed}" });
                else if (addedTest != null) Emit(new { id, type = "done", ok = false, reason = $"new test method: {addedTest}" });
                else Emit(new { id, type = "done", ok = true });
                break;
            }
            case "load":
            {
                var binlog = root.GetProperty("binlog").GetString()!;
                var csproj = root.GetProperty("csproj").GetString()!;
                var dll = root.GetProperty("dll").GetString()!;
                // Optional live capability set (#11 P2): the intersection of
                // what the registered testhost runtimes report they can apply.
                // Absent → the safe modern-runtime default.
                ImmutableArray<string>? caps = null;
                if (root.TryGetProperty("caps", out var capsEl) && capsEl.ValueKind == JsonValueKind.Array)
                {
                    var list = capsEl.EnumerateArray()
                        .Select(c => c.GetString())
                        .Where(c => !string.IsNullOrWhiteSpace(c))
                        .Select(c => c!)
                        .ToImmutableArray();
                    if (list.Length > 0) caps = list;
                }
                var (ok, reason, assembly) = solution.Load(binlog, csproj, dll, caps);
                if (ok) Emit(new { id, type = "done", ok = true, assembly });
                else Emit(new { id, type = "done", ok = false, reason });
                break;
            }
            case "delta":
            {
                // One save can touch several files across several projects
                // (#11 P3, #22): all of them enter a single solution-wide
                // emit so interdependent edits are analyzed together.
                var files = new List<string>();
                if (root.TryGetProperty("files", out var filesEl) && filesEl.ValueKind == JsonValueKind.Array)
                    files.AddRange(filesEl.EnumerateArray().Select(f => f.GetString()!).Where(f => f != null));
                else if (root.TryGetProperty("file", out var fileEl))
                    files.Add(fileEl.GetString()!);
                if (files.Count == 0)
                {
                    Emit(new { id, type = "done", ok = false, reason = "no files in delta request" });
                    break;
                }
                // Projects whose in-repo dependents are ALL in the session:
                // the engine sees the whole picture, so the cross-project
                // API-surface valve steps aside and the engine decides.
                var exempt = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
                if (root.TryGetProperty("apiGuardExempt", out var exemptEl) && exemptEl.ValueKind == JsonValueKind.Array)
                    foreach (var e in exemptEl.EnumerateArray())
                        if (e.GetString() is { } s)
                            exempt.Add(s);

                var (updates, reason2) = solution.DeltaAsync(files, exempt).GetAwaiter().GetResult();
                if (updates == null)
                {
                    Emit(new { id, type = "done", ok = false, reason = reason2 });
                }
                else
                {
                    var list = updates
                        .Select(u => new
                        {
                            assembly = u.Assembly,
                            md = Convert.ToBase64String(u.Md),
                            il = Convert.ToBase64String(u.Il),
                            pdb = Convert.ToBase64String(u.Pdb),
                        })
                        .ToArray();
                    // Legacy single-update fields kept for protocol/test
                    // compatibility when the emit spans exactly one module.
                    if (list.Length == 1)
                        Emit(new
                        {
                            id,
                            type = "done",
                            ok = true,
                            updates = list,
                            assembly = list[0].assembly,
                            md = list[0].md,
                            il = list[0].il,
                            pdb = list[0].pdb,
                        });
                    else
                        Emit(new { id, type = "done", ok = true, updates = list });
                }
                break;
            }
            default:
                Emit(new { id, type = "done", ok = false, reason = "unknown cmd" });
                break;
        }
    }
    catch (Exception e)
    {
        Emit(new { id, type = "done", ok = false, reason = e.Message });
    }
}
solution.Reset();
return 0;

sealed record AssemblyUpdate(string Assembly, byte[] Md, byte[] Il, byte[] Pdb);

/// <summary>
/// The merged EnC session: every loaded project lives in one AdhocWorkspace
/// solution with metadata references to sibling outputs rewired into
/// ProjectReferences, so a change in a library flows into its dependents'
/// compilations and one emit can span modules (#22).
/// </summary>
sealed class EncSolution
{
    /// <summary>
    /// Fallback CoreCLR (.NET 8+) hot-reload capabilities, used when no live
    /// host reported a set (cold preload before the first host registers).
    /// Live hosts report MetadataUpdater.GetCapabilities() through their
    /// registration files and the caller sends the intersection with "load";
    /// anything a host can't do beyond this guess would still be refused at
    /// ApplyUpdate, and that push failure already forces the build path.
    /// </summary>
    private static readonly ImmutableArray<string> DefaultCapabilities = ImmutableArray.Create(
        "Baseline",
        "AddMethodToExistingType",
        "AddStaticFieldToExistingType",
        "AddInstanceFieldToExistingType",
        "NewTypeDefinition",
        "ChangeCustomAttributes",
        "UpdateParameters",
        "GenericUpdateMethod",
        "GenericAddMethodToExistingType",
        "GenericAddFieldToExistingType");

    private sealed class LoadedProject : IDisposable
    {
        public required string Csproj;
        public required string ComplogPath;
        public required string Dll;
        public required string AssemblyName;
        /// <summary>Project skeleton from the complog; re-added on every session rebuild.</summary>
        public required ProjectInfo Info;
        /// <summary>Checksummed source texts keyed by build-time file path.</summary>
        public required Dictionary<string, SourceText> Texts;
        /// <summary>Backs the solution's lazy loaders; must outlive every session using Info.</summary>
        public required SolutionReader Reader;
        /// <summary>File path -> document id, valid for the CURRENT session build.</summary>
        public Dictionary<string, DocumentId> Documents = new(StringComparer.OrdinalIgnoreCase);
        public void Dispose() => Reader.Dispose();
    }

    private readonly Dictionary<string, LoadedProject> _projects = new(StringComparer.OrdinalIgnoreCase);
    private AdhocWorkspace? _workspace;
    private ImpactHotReloadService? _service;
    private Solution? _current;
    private ImmutableArray<string> _caps = DefaultCapabilities;
    /// <summary>True once a delta has been committed this epoch: session restarts would
    /// re-read disk baselines the hosts have already moved past, so loads are refused.</summary>
    private bool _committed;

    public (bool Ok, string Reason, string Assembly) Load(
        string complogPath, string csproj, string dll, ImmutableArray<string>? caps)
    {
        if (_committed)
            // Restarting the session now would re-baseline from disk while the
            // hosts run committed generations — the caller must rebuild
            // (which resets the epoch) instead.
            return (false, "mid-epoch load — rebuild needed", "");

        var reader = SolutionReader.Create(complogPath, BasicAnalyzerKind.OnDisk);
        ProjectInfo? info = null;
        foreach (var candidate in reader.ReadSolutionInfo().Projects)
        {
            if (string.Equals(candidate.FilePath, csproj, StringComparison.OrdinalIgnoreCase)
                || Path.GetFileName(candidate.FilePath ?? "") == Path.GetFileName(csproj))
            {
                info = candidate;
                break;
            }
        }
        if (info == null)
        {
            reader.Dispose();
            return (false, "project not found in binlog", "");
        }

        // The engine trusts a baseline document only when its text checksum
        // matches the PDB's. SolutionReader materializes texts from strings
        // with no encoding, so GetChecksum() is empty and every document reads
        // as out-of-sync (ENC1008 "stale project"). Rebuild each text from the
        // complog tree's string WITH its encoding + checksum algorithm.
        var texts = new Dictionary<string, SourceText>(StringComparer.OrdinalIgnoreCase);
        using (var callReader = CompilerCallReaderUtil.Create(complogPath, BasicAnalyzerKind.OnDisk))
        {
            var data = callReader
                .ReadAllCompilationData()
                .FirstOrDefault(d =>
                    string.Equals(d.CompilerCall.ProjectFilePath, csproj, StringComparison.OrdinalIgnoreCase)
                    || Path.GetFileName(d.CompilerCall.ProjectFilePath ?? "") == Path.GetFileName(csproj));
            if (data != null)
            {
                foreach (var tree in data.Compilation.SyntaxTrees)
                {
                    if (string.IsNullOrEmpty(tree.FilePath)) continue;
                    var text = tree.GetText();
                    texts[tree.FilePath] = SourceText.From(
                        text.ToString(),
                        text.Encoding ?? tree.Encoding ?? new UTF8Encoding(encoderShouldEmitUTF8Identifier: false),
                        text.ChecksumAlgorithm);
                }
            }
        }

        // The dll may postdate the complog: any build that bypasses the
        // snapshot path (test discovery's solution build, a manual
        // dotnet build) rewrites outputs without refreshing the
        // baseline. The engine then treats every baseline document as
        // out-of-sync and reports each edit as "no changes" — the
        // caller would keep running the stale assembly GREEN. Compare
        // the complog texts' checksums against the PDB that shipped
        // with the dll and refuse the pair outright: the build path
        // rebuilds and re-snapshots, restoring a matched baseline.
        var stale = StaleBaselineFile(dll, texts);
        if (stale != null)
        {
            reader.Dispose();
            return (false, $"baseline mismatch: {stale} differs between the built pdb and the complog "
                + "— dll and complog come from different builds; rebuild needed", "");
        }

        var loaded = new LoadedProject
        {
            Csproj = csproj,
            ComplogPath = complogPath,
            Dll = dll,
            // The hook routes deltas by simple assembly name; SolutionReader
            // carries the /out file name ("Lib.dll") here.
            AssemblyName = TrimDll(string.IsNullOrEmpty(info.AssemblyName)
                ? Path.GetFileNameWithoutExtension(csproj)
                : info.AssemblyName),
            Info = info,
            Texts = texts,
            Reader = reader,
        };
        if (caps.HasValue) _caps = caps.Value;
        if (_projects.TryGetValue(csproj, out var old)) old.Dispose();
        _projects[csproj] = loaded;

        var (ok, reason) = RebuildSession();
        if (!ok)
        {
            _projects.Remove(csproj);
            loaded.Dispose();
            RebuildSession(); // best effort back to the previous set
            return (false, reason, "");
        }
        return (true, "", loaded.AssemblyName);
    }

    public async Task<(List<AssemblyUpdate>?, string)> DeltaAsync(
        IReadOnlyList<string> files, HashSet<string> apiGuardExempt)
    {
        // A snapshot eviction tears the session down but keeps the surviving
        // projects; rebuild lazily so they stay hot-patchable (only ever at
        // gen 0 — eviction resets the committed flag).
        if (_service == null && _projects.Count > 0 && !_committed)
        {
            var (ok, reason) = RebuildSession();
            if (!ok) return (null, reason);
        }
        if (_service == null || _current == null) return (null, "not loaded");

        // All of a save's edits enter one emit (#11 P3, #22): per-file emits
        // would analyze each edit against a solution missing its siblings,
        // refusing interdependent edits the engine accepts together.
        var updated = _current;
        foreach (var file in files)
        {
            var (owner, docId) = FindDocument(file);
            if (owner == null || docId == null) return (null, $"{Path.GetFileName(file)}: file not in compilation");

            var text = SourceText.From(File.ReadAllText(file), Encoding.UTF8);
            var oldText = (await _current.GetDocument(docId)!.GetTextAsync().ConfigureAwait(false)).ToString();

            // Cross-project safety valve. When the changed project's in-repo
            // dependents are NOT all in the session, the engine happily
            // models a changed public signature as "add new, keep old alive
            // in metadata" — absent dependents would keep calling the old
            // member and stay green even though the solution no longer
            // compiles. Exempt projects (all dependents loaded, computed by
            // the caller from the project graph) skip this and let the
            // engine decide — a genuine rude edit still refuses below.
            if (!apiGuardExempt.Contains(owner.Csproj))
            {
                var removed = ApiGuard.RemovedVisibleDeclaration(oldText, text.ToString());
                if (removed != null)
                    return (null, $"api change: {removed} removed or signature changed — dependents must rebuild");
            }

            // A brand-new test method hot-patches cleanly but invisibly: the
            // test runner discovers tests from the assembly on disk (a fresh
            // testhost enumerates the un-patched dll), so the new [Fact]
            // would neither run nor appear in the tree. Never exempt.
            var addedTest = ApiGuard.AddedTestMethod(oldText, text.ToString());
            if (addedTest != null)
                return (null, $"new test method: {addedTest} — rebuilding so the test runner discovers it");

            updated = updated.WithDocumentText(docId, text);
        }

        var updates = await _service.GetUpdatesAsync(
            updated,
            ImmutableDictionary<ProjectId, ImpactHotReloadService.RunningProjectInfo>.Empty,
            CancellationToken.None).ConfigureAwait(false);

        if (updates.Status == ImpactHotReloadService.Status.NoChangesToApply)
        {
            // "No changes" with an ENC diagnostic is not a semantic no-op —
            // it's the engine refusing to see the document (out-of-sync
            // baseline, ENC1005/1008). Reporting it as benign would let the
            // caller keep running the stale assembly green; force the build
            // path instead. The reason must NOT start with "no-op".
            var enc = updates.PersistentDiagnostics
                .Concat(updates.TransientDiagnostics.SelectMany(t => t.diagnostics))
                .FirstOrDefault(d => d.Id.StartsWith("ENC", StringComparison.Ordinal));
            if (enc != null)
                return (null, $"stale baseline ({enc.Id}: {enc.GetMessage()}) — rebuild needed");
            _current = updated;
            var diag = updates.PersistentDiagnostics.FirstOrDefault()
                ?? updates.TransientDiagnostics.SelectMany(t => t.diagnostics).FirstOrDefault();
            return (null,
                $"no-op (engine: no effective changes"
                + $"{(diag != null ? $"; {diag.Id}: {diag.GetMessage()}" : "")}"
                + $"; persistent={updates.PersistentDiagnostics.Length} transient={updates.TransientDiagnostics.Length} rebuild={updates.ProjectsToRebuild.Length})");
        }

        var rude = updates.TransientDiagnostics.SelectMany(t => t.diagnostics).FirstOrDefault();
        if (updates.Status == ImpactHotReloadService.Status.Blocked
            || !updates.ProjectsToRebuild.IsEmpty
            || !updates.ProjectsToRestart.IsEmpty
            || updates.ProjectUpdates.IsEmpty)
        {
            Discard();
            if (rude != null)
                return (null, $"rude edit {rude.Id}: {rude.GetMessage()}");
            var error = updates.PersistentDiagnostics.FirstOrDefault(d => d.Severity == DiagnosticSeverity.Error);
            return (null, error != null ? $"compile error: {error}" : "engine refused the update");
        }

        var result = new List<AssemblyUpdate>();
        foreach (var u in updates.ProjectUpdates)
        {
            var name = _projects.Values.FirstOrDefault(p => ProjectIdOf(p) == u.ProjectId)?.AssemblyName
                ?? TrimDll(_current.GetProject(u.ProjectId)?.AssemblyName ?? "");
            if (string.IsNullOrEmpty(name))
            {
                Discard();
                return (null, "update for an unknown module — using build path");
            }
            result.Add(new AssemblyUpdate(
                name, u.MetadataDelta.ToArray(), u.ILDelta.ToArray(), u.PdbDelta.ToArray()));
        }
        _service.CommitUpdate();
        _current = updated;
        _committed = true;
        return (result, "");
    }

    /// <summary>Drop a project whose complog is about to be rewritten (post-rebuild snapshot).</summary>
    public void EvictComplog(string complog)
    {
        var stale = _projects
            .Where(p => string.Equals(p.Value.ComplogPath, complog, StringComparison.OrdinalIgnoreCase))
            .Select(p => p.Key)
            .ToList();
        if (stale.Count == 0) return;
        foreach (var key in stale)
        {
            _projects[key].Dispose();
            _projects.Remove(key);
        }
        // The rebuild that produced this snapshot stales the whole epoch; the
        // caller resets and reloads right after. Tear down now so the reader
        // handles are gone before the complog is rewritten.
        TearDownSession();
        _committed = false;
    }

    public void Reset()
    {
        foreach (var p in _projects.Values) p.Dispose();
        _projects.Clear();
        TearDownSession();
        _committed = false;
    }

    // ---- session assembly ----

    private (bool Ok, string Reason) RebuildSession()
    {
        TearDownSession();
        if (_projects.Count == 0) return (true, "");
        try
        {
            var workspace = ImpactEncWorkspace.Create();
            var merged = workspace.AddSolution(SolutionInfo.Create(
                SolutionId.CreateNewId(),
                VersionStamp.Create(),
                projects: _projects.Values.Select(p => p.Info).ToImmutableArray()));

            var byAssembly = new Dictionary<string, LoadedProject>(StringComparer.OrdinalIgnoreCase);
            foreach (var p in _projects.Values) byAssembly[p.AssemblyName] = p;

            foreach (var lp in _projects.Values)
            {
                var projectId = lp.Info.Id;
                // The EnC engine reads the baseline module from the project's
                // output path; the complog doesn't carry one, so point it at
                // the built dll.
                var project = merged.GetProject(projectId)!;
                merged = merged
                    .WithProjectOutputFilePath(projectId, lp.Dll)
                    .WithProjectCompilationOutputInfo(projectId, project.CompilationOutputInfo.WithAssemblyPath(lp.Dll));

                // Checksummed texts (see Load) replace the reader's raw ones.
                foreach (var docu in merged.GetProject(projectId)!.Documents)
                    if (docu.FilePath != null && lp.Texts.TryGetValue(docu.FilePath, out var text))
                        merged = merged.WithDocumentText(docu.Id, text);

                // Reference rewiring — the heart of the solution-wide session:
                // the complog references sibling projects as built dlls, which
                // freezes them; swap each such metadata reference for a
                // ProjectReference so edits in the sibling flow into THIS
                // project's compilation and one emit can span both modules.
                foreach (var mref in merged.GetProject(projectId)!.MetadataReferences.ToList())
                {
                    if (mref is not PortableExecutableReference pe || pe.FilePath is null) continue;
                    var refName = Path.GetFileNameWithoutExtension(pe.FilePath);
                    if (!byAssembly.TryGetValue(refName, out var target) || target == lp) continue;
                    merged = merged
                        .RemoveMetadataReference(projectId, mref)
                        .AddProjectReference(projectId, new ProjectReference(target.Info.Id));
                }
            }

            var service = new ImpactHotReloadService(workspace.Services, _caps);
            service.StartSessionAsync(merged, CancellationToken.None).GetAwaiter().GetResult();

            foreach (var lp in _projects.Values)
            {
                lp.Documents = new Dictionary<string, DocumentId>(StringComparer.OrdinalIgnoreCase);
                foreach (var d in merged.GetProject(lp.Info.Id)!.Documents)
                    if (d.FilePath != null)
                        lp.Documents[d.FilePath] = d.Id;
            }

            _workspace = workspace;
            _service = service;
            _current = merged;
            return (true, "");
        }
        catch (Exception e)
        {
            TearDownSession();
            return (false, $"session rebuild failed: {e.Message}");
        }
    }

    private void TearDownSession()
    {
        try
        {
            _service?.EndSession();
        }
        catch
        {
            /* session never started or already ended */
        }
        _workspace?.Dispose();
        _service = null;
        _workspace = null;
        _current = null;
    }

    private static ProjectId ProjectIdOf(LoadedProject p) => p.Info.Id;

    private static string TrimDll(string assemblyName) =>
        assemblyName.EndsWith(".dll", StringComparison.OrdinalIgnoreCase)
            ? Path.GetFileNameWithoutExtension(assemblyName)
            : assemblyName;

    private (LoadedProject?, DocumentId?) FindDocument(string file)
    {
        foreach (var lp in _projects.Values)
            if (lp.Documents.TryGetValue(file, out var exact))
                return (lp, exact);
        var suffix = Path.DirectorySeparatorChar + Path.GetFileName(file);
        foreach (var lp in _projects.Values)
            foreach (var (path, docId) in lp.Documents)
                if (path.EndsWith(suffix, StringComparison.OrdinalIgnoreCase))
                    return (lp, docId);
        return (null, null);
    }

    private void Discard()
    {
        try
        {
            _service?.DiscardUpdate();
        }
        catch
        {
            // Nothing pending (e.g. Blocked before an emit): fine.
        }
    }

    /// <summary>
    /// First complog document whose checksum disagrees with the dll's portable
    /// PDB (file name only), or null when the pair is coherent. A missing or
    /// unreadable PDB verifies nothing — the engine surfaces its own error at
    /// the first delta and the caller falls back to the build path anyway.
    /// </summary>
    private static string? StaleBaselineFile(string dll, Dictionary<string, SourceText> byPath)
    {
        try
        {
            var pdbPath = Path.ChangeExtension(dll, ".pdb");
            if (!File.Exists(pdbPath)) return null;
            using var pdbStream = File.OpenRead(pdbPath);
            using var provider = System.Reflection.Metadata.MetadataReaderProvider.FromPortablePdbStream(pdbStream);
            var pdbReader = provider.GetMetadataReader();
            foreach (var dh in pdbReader.Documents)
            {
                var d = pdbReader.GetDocument(dh);
                var name = pdbReader.GetString(d.Name);
                if (!byPath.TryGetValue(name, out var text)) continue; // generated/foreign doc
                var pdbHash = Convert.ToHexString(pdbReader.GetBlobBytes(d.Hash));
                var textHash = Convert.ToHexString(text.GetChecksum().ToArray());
                if (!string.Equals(pdbHash, textHash, StringComparison.OrdinalIgnoreCase))
                    return Path.GetFileName(name);
            }
            return null;
        }
        catch
        {
            return null; // unreadable pdb: let the engine report it on first use
        }
    }
}

/// <summary>
/// Cross-project safety valve for projects whose dependents are NOT all in
/// the session: detects declarations visible outside the file's own
/// assembly-private scope that DISAPPEAR between two versions of a file.
/// Additions and body edits pass; a removed/renamed/re-signatured non-private
/// declaration must rebuild so dependent assemblies (tests, IVT friends)
/// recompile against the new API. Trivia never participates (keys are
/// token/signature based).
/// </summary>
static class ApiGuard
{
    /// <summary>First removed visible declaration's key, or null if none.</summary>
    public static string? RemovedVisibleDeclaration(string oldSource, string newSource)
    {
        var oldKeys = DeclarationKeys(CSharpSyntaxTree.ParseText(oldSource));
        var newKeys = DeclarationKeys(CSharpSyntaxTree.ParseText(newSource));
        foreach (var key in oldKeys)
            if (!newKeys.Contains(key))
                return key;
        return null;
    }

    /// <summary>Attributes that make a method a discoverable test (xUnit, NUnit, MSTest).</summary>
    private static readonly HashSet<string> TestAttributes = new(StringComparer.Ordinal)
    {
        "Fact", "Theory",                       // xUnit
        "Test", "TestCase", "TestCaseSource",   // NUnit
        "TestMethod", "DataTestMethod",         // MSTest
    };

    /// <summary>
    /// Name of the first test-attributed method present in the new source but
    /// not the old, or null. A hot patch would run such a method fine — but
    /// the test runner discovers tests from the assembly on disk, so it would
    /// never be scheduled; only a rebuild surfaces it (issue #12).
    /// </summary>
    public static string? AddedTestMethod(string oldSource, string newSource)
    {
        var oldTests = TestMethodNames(CSharpSyntaxTree.ParseText(oldSource));
        foreach (var name in TestMethodNames(CSharpSyntaxTree.ParseText(newSource)))
            if (!oldTests.Contains(name))
                return name;
        return null;
    }

    private static HashSet<string> TestMethodNames(SyntaxTree tree)
    {
        var names = new HashSet<string>(StringComparer.Ordinal);
        foreach (var m in tree.GetRoot().DescendantNodes()
                     .OfType<Microsoft.CodeAnalysis.CSharp.Syntax.MethodDeclarationSyntax>())
        {
            var isTest = m.AttributeLists
                .SelectMany(l => l.Attributes)
                .Select(a => a.Name.ToString().Split('.').Last())
                .Any(n => TestAttributes.Contains(n)
                    || (n.EndsWith("Attribute", StringComparison.Ordinal)
                        && TestAttributes.Contains(n[..^"Attribute".Length])));
            if (isTest) names.Add(m.Identifier.Text);
        }
        return names;
    }

    private static HashSet<string> DeclarationKeys(SyntaxTree tree)
    {
        var keys = new HashSet<string>(StringComparer.Ordinal);
        foreach (var node in tree.GetRoot().DescendantNodes().OfType<Microsoft.CodeAnalysis.CSharp.Syntax.MemberDeclarationSyntax>())
        {
            if (node is Microsoft.CodeAnalysis.CSharp.Syntax.NamespaceDeclarationSyntax
                or Microsoft.CodeAnalysis.CSharp.Syntax.FileScopedNamespaceDeclarationSyntax)
                continue;
            if (IsPrivate(node)) continue;

            var typeChain = string.Join("+", node.Ancestors()
                .OfType<Microsoft.CodeAnalysis.CSharp.Syntax.TypeDeclarationSyntax>()
                .Reverse().Select(t => t.Identifier.Text + "`" + t.Arity));
            var key = node switch
            {
                Microsoft.CodeAnalysis.CSharp.Syntax.TypeDeclarationSyntax t =>
                    $"{typeChain}{(typeChain.Length > 0 ? "+" : "")}T:{t.Identifier.Text}`{t.Arity}",
                Microsoft.CodeAnalysis.CSharp.Syntax.MethodDeclarationSyntax m =>
                    $"{typeChain}.M:{m.Identifier.Text}`{m.Arity}({string.Join(",", m.ParameterList.Parameters.Select(p => p.Type?.ToString()))})",
                Microsoft.CodeAnalysis.CSharp.Syntax.ConstructorDeclarationSyntax c =>
                    $"{typeChain}.C:({string.Join(",", c.ParameterList.Parameters.Select(p => p.Type?.ToString()))})",
                Microsoft.CodeAnalysis.CSharp.Syntax.PropertyDeclarationSyntax p =>
                    $"{typeChain}.P:{p.Identifier.Text}:{p.Type}",
                Microsoft.CodeAnalysis.CSharp.Syntax.FieldDeclarationSyntax f =>
                    $"{typeChain}.F:{string.Join(",", f.Declaration.Variables.Select(v => v.Identifier.Text))}:{f.Declaration.Type}",
                // Events, indexers, operators, enums…: token-based identity.
                _ => $"{typeChain}.O:{node.Kind()}:{string.Join(" ", node.DescendantTokens().Select(t => t.Text))}",
            };
            keys.Add(key);
        }
        return keys;
    }

    /// <summary>
    /// Private members can't break other assemblies, and same-project files
    /// are recompiled inside the session — only they may vanish freely.
    /// Default member visibility in types is private; explicit modifiers win.
    /// </summary>
    private static bool IsPrivate(Microsoft.CodeAnalysis.CSharp.Syntax.MemberDeclarationSyntax node)
    {
        var mods = node.Modifiers;
        var isPrivate = mods.Any(m => m.IsKind(Microsoft.CodeAnalysis.CSharp.SyntaxKind.PrivateKeyword));
        var isVisible = mods.Any(m =>
            m.IsKind(Microsoft.CodeAnalysis.CSharp.SyntaxKind.PublicKeyword)
            || m.IsKind(Microsoft.CodeAnalysis.CSharp.SyntaxKind.InternalKeyword)
            || m.IsKind(Microsoft.CodeAnalysis.CSharp.SyntaxKind.ProtectedKeyword));
        if (isPrivate && !mods.Any(m => m.IsKind(Microsoft.CodeAnalysis.CSharp.SyntaxKind.ProtectedKeyword)))
            return true; // private (private protected keeps protected → visible)
        if (isVisible) return false;
        // No modifier: top-level types default internal (visible via IVT);
        // members default private.
        return node is not Microsoft.CodeAnalysis.CSharp.Syntax.BaseTypeDeclarationSyntax
            || node.Parent is Microsoft.CodeAnalysis.CSharp.Syntax.TypeDeclarationSyntax;
    }
}
