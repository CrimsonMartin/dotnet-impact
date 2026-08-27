// Impact delta service.
//
// Resident process holding Roslyn compilations reconstructed from MSBuild
// binlogs (Basic.CompilerLog). For a saved .cs file it classifies the edit:
// method-body-only changes become EnC metadata deltas (EmitDifference) the
// extension pushes into live testhosts; anything structural is refused so the
// caller falls back to a real build.
//
// Protocol: JSON lines on stdin/stdout.
//   -> {"id":1,"cmd":"load","binlog":"/abs/x.binlog","csproj":"/abs/Lib.csproj","dll":"/abs/Lib.dll"}
//   <- {"id":1,"type":"done","ok":true,"assembly":"Lib"}
//   -> {"id":2,"cmd":"delta","csproj":"/abs/Lib.csproj","file":"/abs/Calc.cs"}
//   <- {"id":2,"type":"done","ok":true,"assembly":"Lib","md":"<b64>","il":"<b64>","pdb":"<b64>"}
//      or {"id":2,"type":"done","ok":false,"reason":"structural: ..."}
//   -> {"id":3,"cmd":"reset"}   drop all state (after a real rebuild)
//
// Baselines chain across generations; a "load" for an already-loaded project
// re-initializes it (fresh dll after a rebuild).

using System.Collections.Immutable;
using System.Reflection.Metadata;
using System.Text;
using System.Text.Json;
using Basic.CompilerLog.Util;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;
using Microsoft.CodeAnalysis.Emit;
using Microsoft.CodeAnalysis.Text;

var projects = new Dictionary<string, ProjectState>(StringComparer.OrdinalIgnoreCase);
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
                return 0;
            case "reset":
                projects.Clear();
                Emit(new { id, type = "done", ok = true });
                break;
            case "snapshot":
            {
                // Freeze a binlog into a complog RIGHT AFTER a build: complogs
                // embed source text, so later edits to the files on disk can't
                // corrupt the baseline the way raw binlogs (path-only) would.
                var binlog = root.GetProperty("binlog").GetString()!;
                var complog = root.GetProperty("complog").GetString()!;
                var diagnostics = CompilerLogUtil.ConvertBinaryLog(binlog, complog);
                Emit(new { id, type = "done", ok = true, warnings = diagnostics.Count });
                break;
            }
            case "load":
            {
                var binlog = root.GetProperty("binlog").GetString()!;
                var csproj = root.GetProperty("csproj").GetString()!;
                var dll = root.GetProperty("dll").GetString()!;
                var (state, detail) = ProjectState.Load(binlog, csproj, dll);
                if (state == null)
                {
                    Emit(new { id, type = "done", ok = false, reason = "project not found in binlog" });
                    break;
                }
                projects[csproj] = state;
                Emit(new { id, type = "done", ok = true, assembly = state.AssemblyName, detail });
                break;
            }
            case "delta":
            {
                var csproj = root.GetProperty("csproj").GetString()!;
                var file = root.GetProperty("file").GetString()!;
                if (!projects.TryGetValue(csproj, out var state))
                {
                    Emit(new { id, type = "done", ok = false, reason = "not loaded" });
                    break;
                }
                var result = state.TryDelta(file);
                if (result.Reason != null)
                {
                    Emit(new { id, type = "done", ok = false, reason = result.Reason });
                }
                else
                {
                    Emit(new
                    {
                        id,
                        type = "done",
                        ok = true,
                        assembly = state.AssemblyName,
                        md = Convert.ToBase64String(result.Md!),
                        il = Convert.ToBase64String(result.Il!),
                        pdb = Convert.ToBase64String(result.Pdb!),
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
return 0;

sealed class ProjectState
{
    public required string AssemblyName;
    private CSharpCompilation _compilation = null!;
    private EmitBaseline _baseline = null!;

    public static (ProjectState?, string) Load(string binlog, string csproj, string dll)
    {
        // OnDisk analyzers: source generators must actually run, or generator-
        // implemented partial members (e.g. [GeneratedRegex]) break the emit.
        using var reader = CompilerCallReaderUtil.Create(binlog, BasicAnalyzerKind.OnDisk);
        var data = reader
            .ReadAllCompilationData()
            .FirstOrDefault(d =>
                string.Equals(d.CompilerCall.ProjectFilePath, csproj, StringComparison.OrdinalIgnoreCase)
                || Path.GetFileName(d.CompilerCall.ProjectFilePath ?? "") == Path.GetFileName(csproj));
        if (data == null) return (null, "");
        var before = data.Compilation.SyntaxTrees.Count();
        var comp = (CSharpCompilation)data.GetCompilationAfterGenerators(out var genDiags);
        var detail =
            $"treesBefore={before} treesAfter={comp.SyntaxTrees.Count()}"
            + (genDiags.IsDefaultOrEmpty ? "" : $" genDiags=[{string.Join("; ", genDiags.Take(2))}]");
        var state = new ProjectState
        {
            AssemblyName = comp.AssemblyName ?? Path.GetFileNameWithoutExtension(dll),
            _compilation = comp,
            _baseline = EmitBaseline.CreateInitialBaseline(
                comp,
                ModuleMetadata.CreateFromFile(dll),
                handle => default,
                handle => default,
                true),
        };
        return (state, detail);
    }

    public (byte[]? Md, byte[]? Il, byte[]? Pdb, string? Reason) TryDelta(string file)
    {
        var oldTree = _compilation.SyntaxTrees.FirstOrDefault(t =>
            string.Equals(t.FilePath, file, StringComparison.OrdinalIgnoreCase)
            || t.FilePath.EndsWith(Path.DirectorySeparatorChar + Path.GetFileName(file), StringComparison.OrdinalIgnoreCase));
        if (oldTree == null) return (null, null, null, "file not in compilation");

        var newTree = CSharpSyntaxTree.ParseText(
            SourceText.From(File.ReadAllText(file), Encoding.UTF8),
            (CSharpParseOptions)oldTree.Options,
            path: oldTree.FilePath);
        var newComp = _compilation.ReplaceSyntaxTree(oldTree, newTree);

        // Classify: identical member skeletons, only method/ctor bodies changed.
        var oldMembers = MemberIndex(oldTree);
        var newMembers = MemberIndex(newTree);
        if (oldMembers.Count != newMembers.Count)
            return (null, null, null,
                $"structural: member count changed ({oldMembers.Count} -> {newMembers.Count}, tree={oldTree.FilePath})");

        var oldModel = _compilation.GetSemanticModel(oldTree);
        var newModel = newComp.GetSemanticModel(newTree);
        var edits = new List<SemanticEdit>();
        foreach (var (key, oldNode) in oldMembers)
        {
            if (!newMembers.TryGetValue(key, out var newNode)) return (null, null, null, $"structural: {key}");
            if (oldNode.ToFullString() == newNode.ToFullString()) continue;
            if (oldNode is not BaseMethodDeclarationSyntax)
                return (null, null, null, $"structural: non-method change at {key}");
            var oldSym = oldModel.GetDeclaredSymbol(oldNode);
            var newSym = newModel.GetDeclaredSymbol(newNode);
            if (oldSym == null || newSym == null) return (null, null, null, $"structural: unresolved {key}");
            edits.Add(new SemanticEdit(SemanticEditKind.Update, oldSym, newSym));
        }
        if (edits.Count == 0)
        {
            var dbgOld = oldMembers.Values.FirstOrDefault()?.ToFullString().Replace("\n", "\\n") ?? "<none>";
            return (null, null, null,
                $"no-op (tree={oldTree.FilePath}, members={oldMembers.Count}, firstOld=[{dbgOld[..Math.Min(90, dbgOld.Length)]}])");
        }

        using var md = new MemoryStream();
        using var il = new MemoryStream();
        using var pdb = new MemoryStream();
        var diff = newComp.EmitDifference(_baseline, edits.ToImmutableArray(), s => false, md, il, pdb);
        var errors = diff.Diagnostics.Where(d => d.Severity == DiagnosticSeverity.Error).ToList();
        if (errors.Count > 0) return (null, null, null, "emit: " + errors[0]);
        if (diff.Baseline == null) return (null, null, null, "emit: no baseline produced");

        _compilation = newComp;
        _baseline = diff.Baseline;
        return (md.ToArray(), il.ToArray(), pdb.ToArray(), null);
    }

    /** Member skeleton index: signature key -> declaration node. */
    private static Dictionary<string, MemberDeclarationSyntax> MemberIndex(SyntaxTree tree)
    {
        var index = new Dictionary<string, MemberDeclarationSyntax>();
        foreach (var node in tree.GetRoot().DescendantNodes().OfType<MemberDeclarationSyntax>())
        {
            if (node is NamespaceDeclarationSyntax or FileScopedNamespaceDeclarationSyntax or TypeDeclarationSyntax)
                continue; // containers tracked through their members
            var typeChain = string.Join("+", node.Ancestors().OfType<TypeDeclarationSyntax>()
                .Reverse().Select(t => t.Identifier.Text + "`" + t.Arity));
            var key = node switch
            {
                MethodDeclarationSyntax m =>
                    $"{typeChain}.M:{m.Identifier.Text}`{m.Arity}({string.Join(",", m.ParameterList.Parameters.Select(p => p.Type?.ToString()))})",
                ConstructorDeclarationSyntax c =>
                    $"{typeChain}.C:({string.Join(",", c.ParameterList.Parameters.Select(p => p.Type?.ToString()))})",
                _ => $"{typeChain}.O:{node.Kind()}:{Snippet(node)}",
            };
            index[key] = node;
        }
        return index;
    }

    /** Identity for non-method members (fields, props): full text — any change is structural. */
    private static string Snippet(MemberDeclarationSyntax node) => node.ToFullString().Trim();
}
