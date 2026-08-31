// Impact delta service.
//
// Resident process holding Roslyn workspaces reconstructed from complogs
// (Basic.CompilerLog). Edits are evaluated by Roslyn's own Edit-and-Continue
// engine (the one behind dotnet-watch hot reload) via the vendored
// ImpactHotReloadService facade: everything the runtime supports — method
// bodies, added methods/fields/types, lambdas — becomes deltas the extension
// pushes into live testhosts; rude edits are refused with their ENC
// diagnostic so the caller falls back to a real build.
//
// Protocol: JSON lines on stdin/stdout.
//   -> {"id":1,"cmd":"load","binlog":"/abs/x.complog","csproj":"/abs/Lib.csproj","dll":"/abs/Lib.dll",
//       "caps":["Baseline","AddMethodToExistingType",...]}   caps optional: live-host capability intersection
//   <- {"id":1,"type":"done","ok":true,"assembly":"Lib"}
//   -> {"id":2,"cmd":"delta","csproj":"/abs/Lib.csproj","files":["/abs/Calc.cs","/abs/Extra.cs"]}
//      ("file":"/abs/Calc.cs" also accepted for a single edit)
//   <- {"id":2,"type":"done","ok":true,"assembly":"Lib","md":"<b64>","il":"<b64>","pdb":"<b64>"}
//      or {"id":2,"type":"done","ok":false,"reason":"rude edit ENC0023: ..."}
//   -> {"id":3,"cmd":"reset"}   drop all state (after a real rebuild)
//
// Baselines chain across generations inside the EnC session; a "load" for an
// already-loaded project re-initializes it (fresh dll after a rebuild).

using System.Collections.Immutable;
using System.Text;
using System.Text.Json;
using Basic.CompilerLog.Util;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.ExternalAccess.HotReload.Api;
using Microsoft.CodeAnalysis.Text;

var projects = new Dictionary<string, EncProject>(StringComparer.OrdinalIgnoreCase);
var stdout = Console.Out;
void Emit(object payload) => stdout.WriteLine(JsonSerializer.Serialize(payload));

void ResetAll()
{
    foreach (var p in projects.Values) p.Dispose();
    projects.Clear();
}

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
                ResetAll();
                return 0;
            case "reset":
                ResetAll();
                Emit(new { id, type = "done", ok = true });
                break;
            case "snapshot":
            {
                // Freeze a binlog into a complog RIGHT AFTER a build: complogs
                // embed source text, so later edits to the files on disk can't
                // corrupt the baseline the way raw binlogs (path-only) would.
                var binlog = root.GetProperty("binlog").GetString()!;
                var complog = root.GetProperty("complog").GetString()!;
                // A loaded session's SolutionReader keeps its complog open
                // (it backs the solution's lazy text loaders), and FileShare
                // is enforced even intra-process — on Linux via advisory
                // locks — so converting over it would fail with a sharing
                // violation. The rebuild that produced this binlog stales
                // those baselines anyway: evict them before rewriting.
                foreach (var stale in projects
                    .Where(p => string.Equals(p.Value.ComplogPath, complog, StringComparison.OrdinalIgnoreCase))
                    .Select(p => p.Key)
                    .ToList())
                {
                    projects[stale].Dispose();
                    projects.Remove(stale);
                }
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
                var (state, reason) = EncProject.LoadAsync(binlog, csproj, dll, caps).GetAwaiter().GetResult();
                if (state == null)
                {
                    Emit(new { id, type = "done", ok = false, reason });
                    break;
                }
                if (projects.TryGetValue(csproj, out var old)) old.Dispose();
                projects[csproj] = state;
                Emit(new { id, type = "done", ok = true, assembly = state.AssemblyName });
                break;
            }
            case "delta":
            {
                var csproj = root.GetProperty("csproj").GetString()!;
                // One save can touch several files of a project (#11 P3): all
                // of them go into a single emit so interdependent edits are
                // analyzed together. "file" stays accepted for single edits.
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
                if (!projects.TryGetValue(csproj, out var state))
                {
                    Emit(new { id, type = "done", ok = false, reason = "not loaded" });
                    break;
                }
                var (delta, reason) = state.DeltaAsync(files).GetAwaiter().GetResult();
                if (delta == null)
                {
                    Emit(new { id, type = "done", ok = false, reason });
                }
                else
                {
                    Emit(new
                    {
                        id,
                        type = "done",
                        ok = true,
                        assembly = state.AssemblyName,
                        md = Convert.ToBase64String(delta.Value.Md),
                        il = Convert.ToBase64String(delta.Value.Il),
                        pdb = Convert.ToBase64String(delta.Value.Pdb),
                    });
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
ResetAll();
return 0;

/// <summary>
/// One project's EnC session: workspace + solution reconstructed from its
/// complog, driven through Roslyn's Edit-and-Continue engine.
/// </summary>
sealed class EncProject : IDisposable
{
    /// <summary>
    /// Fallback CoreCLR (.NET 8+) hot-reload capabilities, used when no live
    /// host reported a set (cold preload before the first host registers).
    /// Live hosts report MetadataUpdater.GetCapabilities() through their
    /// registration files and the caller sends the intersection with "load";
    /// anything a host can't do beyond this guess would still be refused at
    /// ApplyUpdate, and that push failure already forces the build path.
    /// </summary>
    private static readonly ImmutableArray<string> Capabilities = ImmutableArray.Create(
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

    public required string AssemblyName;
    /// <summary>The complog this session was loaded from (its reader holds the file open).</summary>
    public required string ComplogPath;
    private AdhocWorkspace _workspace = null!;
    private ImpactHotReloadService _service = null!;
    private Solution _current = null!;
    private Dictionary<string, DocumentId> _documents = null!;
    /// <summary>Backs the solution's lazy text loaders; must outlive the session.</summary>
    private SolutionReader _reader = null!;

    public static async Task<(EncProject?, string)> LoadAsync(
        string complogPath, string csproj, string dll, ImmutableArray<string>? capabilities = null)
    {
        var reader = SolutionReader.Create(complogPath, BasicAnalyzerKind.OnDisk);
        var workspace = ImpactEncWorkspace.Create();
        var solution = workspace.AddSolution(reader.ReadSolutionInfo());

        var project = solution.Projects.FirstOrDefault(p =>
            string.Equals(p.FilePath, csproj, StringComparison.OrdinalIgnoreCase)
            || Path.GetFileName(p.FilePath ?? "") == Path.GetFileName(csproj));
        if (project == null)
        {
            workspace.Dispose();
            reader.Dispose();
            return (null, "project not found in binlog");
        }

        // The EnC engine reads the baseline module from the project's output
        // path; the complog doesn't carry one, so point it at the built dll.
        solution = solution
            .WithProjectOutputFilePath(project.Id, dll)
            .WithProjectCompilationOutputInfo(project.Id, project.CompilationOutputInfo.WithAssemblyPath(dll));

        // The engine trusts a baseline document only when its text checksum
        // matches the PDB's. SolutionReader materializes texts from strings
        // with no encoding, so GetChecksum() is empty and every document reads
        // as out-of-sync (ENC1008 "stale project"). Rebuild each text from the
        // complog tree's string WITH its encoding + checksum algorithm.
        using (var callReader = CompilerCallReaderUtil.Create(complogPath, BasicAnalyzerKind.OnDisk))
        {
            var data = callReader
                .ReadAllCompilationData()
                .FirstOrDefault(d =>
                    string.Equals(d.CompilerCall.ProjectFilePath, csproj, StringComparison.OrdinalIgnoreCase)
                    || Path.GetFileName(d.CompilerCall.ProjectFilePath ?? "") == Path.GetFileName(csproj));
            if (data != null)
            {
                var byPath = new Dictionary<string, SourceText>(StringComparer.OrdinalIgnoreCase);
                foreach (var tree in data.Compilation.SyntaxTrees)
                {
                    if (string.IsNullOrEmpty(tree.FilePath)) continue;
                    var text = tree.GetText();
                    byPath[tree.FilePath] = SourceText.From(
                        text.ToString(),
                        text.Encoding ?? tree.Encoding ?? new UTF8Encoding(encoderShouldEmitUTF8Identifier: false),
                        text.ChecksumAlgorithm);
                }
                foreach (var docu in solution.GetProject(project.Id)!.Documents)
                    if (docu.FilePath != null && byPath.TryGetValue(docu.FilePath, out var text))
                        solution = solution.WithDocumentText(docu.Id, text);
                // The dll may postdate the complog: any build that bypasses the
                // snapshot path (test discovery's solution build, a manual
                // dotnet build) rewrites outputs without refreshing the
                // baseline. The engine then treats every baseline document as
                // out-of-sync and reports each edit as "no changes" — the
                // caller would keep running the stale assembly GREEN. Compare
                // the complog texts' checksums against the PDB that shipped
                // with the dll and refuse the pair outright: the build path
                // rebuilds and re-snapshots, restoring a matched baseline.
                var stale = StaleBaselineFile(dll, byPath);
                if (stale != null)
                {
                    workspace.Dispose();
                    reader.Dispose();
                    return (null, $"baseline mismatch: {stale} differs between the built pdb and the complog "
                        + "— dll and complog come from different builds; rebuild needed");
                }
            }
        }

        var service = new ImpactHotReloadService(workspace.Services, capabilities ?? Capabilities);
        await service.StartSessionAsync(solution, CancellationToken.None).ConfigureAwait(false);

        var documents = new Dictionary<string, DocumentId>(StringComparer.OrdinalIgnoreCase);
        foreach (var d in solution.GetProject(project.Id)!.Documents)
            if (d.FilePath != null)
                documents[d.FilePath] = d.Id;

        return (new EncProject
        {
            // The hook routes deltas by simple assembly name; SolutionReader
            // carries the /out file name ("Lib.dll") here.
            AssemblyName = project.AssemblyName.EndsWith(".dll", StringComparison.OrdinalIgnoreCase)
                ? Path.GetFileNameWithoutExtension(project.AssemblyName)
                : project.AssemblyName,
            ComplogPath = complogPath,
            _workspace = workspace,
            _service = service,
            _current = solution,
            _documents = documents,
            _reader = reader,
        }, "");
    }

    public async Task<((byte[] Md, byte[] Il, byte[] Pdb)?, string)> DeltaAsync(IReadOnlyList<string> files)
    {
        // All of a save's edits to this project enter one emit (#11 P3):
        // per-file emits would analyze each edit against a solution missing
        // its siblings, refusing interdependent edits (a method added in one
        // file, called from another) that the engine accepts together.
        var updated = _current;
        foreach (var file in files)
        {
            var docId = FindDocument(file);
            if (docId == null) return (null, $"{Path.GetFileName(file)}: file not in compilation");

            var text = SourceText.From(File.ReadAllText(file), Encoding.UTF8);

            // Cross-project safety valve. The EnC session spans one project, so
            // the engine happily models a changed public signature as "add new,
            // keep old alive in metadata" — dependent test assemblies would keep
            // calling the old member and stay green even though the solution no
            // longer compiles. Any disappeared non-private declaration therefore
            // forces the build path, where the dependent compile failure surfaces.
            var oldText = (await _current.GetDocument(docId)!.GetTextAsync().ConfigureAwait(false)).ToString();
            var removed = ApiGuard.RemovedVisibleDeclaration(oldText, text.ToString());
            if (removed != null)
                return (null, $"api change: {removed} removed or signature changed — dependents must rebuild");

            // A brand-new test method hot-patches cleanly but invisibly: the test
            // runner discovers tests from the assembly on disk (a fresh testhost
            // enumerates the un-patched dll), so the new [Fact] would neither run
            // nor appear in the tree. Only a rebuild makes it discoverable.
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

        if (updates.ProjectUpdates.Length != 1)
        {
            // The hook protocol pushes one assembly per delta; multi-module
            // updates from a single-project session would mean generators
            // fanned out — refuse and let the build path handle it.
            Discard();
            return (null, $"multi-module update ({updates.ProjectUpdates.Length}) not supported");
        }

        var u = updates.ProjectUpdates[0];
        _service.CommitUpdate();
        _current = updated;
        return ((u.MetadataDelta.ToArray(), u.ILDelta.ToArray(), u.PdbDelta.ToArray()), "");
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

    private DocumentId? FindDocument(string file)
    {
        if (_documents.TryGetValue(file, out var exact)) return exact;
        var suffix = Path.DirectorySeparatorChar + Path.GetFileName(file);
        foreach (var (path, docId) in _documents)
            if (path.EndsWith(suffix, StringComparison.OrdinalIgnoreCase))
                return docId;
        return null;
    }

    private void Discard()
    {
        try
        {
            _service.DiscardUpdate();
        }
        catch
        {
            // Nothing pending (e.g. Blocked before an emit): fine.
        }
    }

    public void Dispose()
    {
        try
        {
            _service.EndSession();
        }
        catch
        {
            /* session never started or already ended */
        }
        _workspace.Dispose();
        _reader.Dispose();
    }
}

/// <summary>
/// Cross-project safety valve for the per-project EnC sessions: detects
/// declarations visible outside the file's own assembly-private scope that
/// DISAPPEAR between two versions of a file. Additions and body edits pass;
/// a removed/renamed/re-signatured non-private declaration must rebuild so
/// dependent assemblies (tests, IVT friends) recompile against the new API.
/// Trivia never participates (keys are token/signature based).
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
