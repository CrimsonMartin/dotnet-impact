// Impact static map builder.
//
// Reads the solution's BUILT assemblies (IL metadata via System.Reflection.Metadata)
// plus their portable PDBs, builds the compiler-resolved type-reference graph, and
// emits source file sets for each test class's transitive closure:
//
// One-shot mode:
//   ImpactStaticMap --repo-root <shadowRoot> --assemblies <assemblies.json>
//     assemblies.json: [{ "csproj": "tests/X/X.csproj", "dll": "/abs/path/X.dll", "isTest": true }]
//   stdout: { "classes": { "Ns.TestClass": { "csproj": "...", "files": ["src/A.cs"] } },
//            "skipped": [{ "assembly": "...", "reason": "..." }], ... }
//
// Serve mode (resident, H12):
//   ImpactStaticMap --serve
//   stdin:  one JSON request per line:
//     {"id":1,"op":"map","repoRoot":"/shadow","godPercent":30,
//      "assemblies":[{"csproj":"tests/X/X.csproj","dll":"/abs/X.dll","isTest":true}]}
//   stdout: one JSON response per line:
//     {"id":1,"ok":true,"result":{...map...},"stats":{"parsed":k,"cached":n}}
//     {"id":1,"ok":false,"error":"..."}
//   Startup emits {"ready":true,"protocol":1}; op "shutdown" responds then exits.
//   The serve mode keeps each assembly's parsed type records in memory, keyed
//   by (path, mtime, size) + PDB stat, so a rebuild that touches a subset of
//   assemblies re-parses only those. The parsed records are pure data
//   (string FQNs + file sets), so they are safe to reuse across requests.
//
// Test classes are detected by IL attributes (xunit Fact/Theory, NUnit Test/TestCase,
// MSTest TestMethod) on methods of types in test assemblies. Edges cover base types,
// interfaces, member signatures, custom attributes, and every metadata token in
// method bodies (calls, field access, typeof, generic instantiations). The result is
// a safe superset of dynamic coverage: every file a test class *could* reach.

using System.Diagnostics;
using System.Reflection.Emit;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Reflection.PortableExecutable;
using System.Text.Json;

bool PhaseTimers = Environment.GetEnvironmentVariable("IMPACT_STATIC_PHASES") == "1";
static double TicksMs(long a, long b) => (b - a) * 1000.0 / System.Diagnostics.Stopwatch.Frequency;
static void LogPhase(string name, double ms) => Console.Error.WriteLine($"[phase] {name}: {ms:F1}ms");
var JsonOpts = new JsonSerializerOptions { PropertyNameCaseInsensitive = true };

string? repoRoot = null, assembliesPath = null;
var godPercent = 30; // cap expansion through types referenced by >=N% of all types
var serve = false;
for (int i = 0; i < args.Length; i++)
{
    if (args[i] == "--serve")
    {
        serve = true;
        continue;
    }
    if (i >= args.Length - 1) continue;
    if (args[i] == "--repo-root") repoRoot = args[i + 1];
    else if (args[i] == "--assemblies") assembliesPath = args[i + 1];
    else if (args[i] == "--god-percent") godPercent = int.Parse(args[i + 1]);
}

if (serve)
{
    RunServe(godPercent);
    return 0;
}

if (repoRoot == null || assembliesPath == null)
{
    Console.Error.WriteLine("usage: ImpactStaticMap --repo-root <dir> --assemblies <json> | --serve");
    return 2;
}
repoRoot = Path.GetFullPath(repoRoot);

var inputs = JsonSerializer.Deserialize<List<AssemblyInput>>(
    File.ReadAllText(assembliesPath),
    JsonOpts)!;

var engine = new MapEngine(PhaseTimers);
if (PhaseTimers) engine.Mark("startup");
var result = engine.Compute(repoRoot, godPercent, inputs);
var tOneCompute = System.Diagnostics.Stopwatch.GetTimestamp();
var oneJson = JsonSerializer.Serialize(result);
var tOneSer = System.Diagnostics.Stopwatch.GetTimestamp();
Console.WriteLine(oneJson);
Console.Out.Flush();
if (PhaseTimers)
{
    LogPhase("oneshot-serialize", TicksMs(tOneCompute, tOneSer));
    LogPhase("oneshot-write", TicksMs(tOneSer, System.Diagnostics.Stopwatch.GetTimestamp()));
}
return 0;

void RunServe(int defaultGodPercent)
{
    var engine = new MapEngine(PhaseTimers);
    // Pre-JIT the request-deserialization path so the first real map request
    // does not pay the one-time serializer JIT (measured ~20ms).
    try { _ = JsonSerializer.Deserialize<ServeRequest>("{\"id\":0,\"op\":\"warmup\"}", JsonOpts); } catch { }
    Console.WriteLine(JsonSerializer.Serialize(new { ready = true, protocol = 1 }));
    Console.Out.Flush();
    while (Console.In.ReadLine() is { } line)
    {
        if (line.Trim() == "") continue;
        try
        {
            var tReq = System.Diagnostics.Stopwatch.GetTimestamp();
            var req = JsonSerializer.Deserialize<ServeRequest>(line, JsonOpts);
            if (req == null) continue;
            if (PhaseTimers) LogPhase("serve-deserialize", TicksMs(tReq, System.Diagnostics.Stopwatch.GetTimestamp()));
            if (req.Op == "shutdown")
            {
                Console.WriteLine(JsonSerializer.Serialize(new { id = req.Id, ok = true }));
                Console.Out.Flush();
                return;
            }
            if (req.Op != "map" || req.RepoRoot == null || req.Assemblies == null)
            {
                Console.WriteLine(JsonSerializer.Serialize(new { id = req.Id, ok = false, error = "bad request" }));
                Console.Out.Flush();
                continue;
            }
            var res = engine.Compute(Path.GetFullPath(req.RepoRoot), req.GodPercent ?? defaultGodPercent, req.Assemblies);
            var tCompute = System.Diagnostics.Stopwatch.GetTimestamp();
            var respJson = JsonSerializer.Serialize(new
            {
                id = req.Id,
                ok = true,
                result = res,
                stats = new { parsed = engine.ParsedCount, cached = engine.CachedCount },
            });
            var tSer = System.Diagnostics.Stopwatch.GetTimestamp();
            // Write the (multi-MB) response as ONE raw write(): Console's
            // buffered writer emits many small chunks, and a line-based pipe
            // reader pays an event-loop iteration per chunk — measured ~300ms
            // on a full-map response vs ~7ms for a single write.
            var respBytes = System.Text.Encoding.UTF8.GetBytes(respJson);
            var stdout = Console.OpenStandardOutput();
            stdout.Write(respBytes, 0, respBytes.Length);
            stdout.WriteByte((byte)'\n');
            stdout.Flush();
            var tWrite = System.Diagnostics.Stopwatch.GetTimestamp();
            if (PhaseTimers)
            {
                LogPhase("serve-serialize", TicksMs(tCompute, tSer));
                LogPhase("serve-write", TicksMs(tSer, tWrite));
            }
        }
        catch (Exception e)
        {
            try
            {
                var id = JsonSerializer.Deserialize<ServeRequest>(line, JsonOpts)?.Id ?? -1;
                Console.WriteLine(JsonSerializer.Serialize(new { id, ok = false, error = e.Message }));
            }
            catch
            {
                // unparseable line: nothing to correlate with; drop it
            }
        }
        Console.Out.Flush();
    }
}

record ServeRequest(long Id, string Op, string? RepoRoot, int? GodPercent, List<AssemblyInput>? Assemblies);

record AssemblyInput(string Csproj, string Dll, bool IsTest);

/// <summary>Immutable per-top-level-type parse record (cache unit).</summary>
sealed class RecordedType
{
    public required string AsmName;
    public required string Fqn;
    public required string Csproj;
    public bool IsTestClass;
    public bool IsEnum;
    public bool IsConstOnly;
    public bool IsInterface;
    public bool IsAbstract;
    public required HashSet<string> Files;
    public required HashSet<string> RefNames;
}

/// <summary>Cached parse of one assembly dll (validation: path + mtime + size + PDB stat).</summary>
sealed class AssemblyRecord
{
    public long DllTicks;
    public long DllSize;
    public long PdbTicks;
    public long PdbSize;
    public string? Skip;
    public required RecordedType[] Types;
}

sealed class TypeNode
{
    public required string Fqn;
    public required string Csproj;
    public bool IsTestClass;
    public bool IsEnum;
    public bool IsConstOnly;
    public bool IsInterface;
    public bool IsAbstract;
    public readonly HashSet<string> Files = new(StringComparer.Ordinal);
    public readonly HashSet<string> RefNames = new(StringComparer.Ordinal);
    public readonly HashSet<TypeNode> Edges = new();
}

/// <summary>
/// Builds the map. In serve mode the per-assembly parse results and the
/// name-union file texts are cached between requests; one-shot mode runs a
/// single Compute with cold caches (identical output to the pre-H12 helper).
/// </summary>
sealed class MapEngine
{
    private readonly bool _timers;
    private readonly Stopwatch _sw = Stopwatch.StartNew();
    private double _prev;
    private readonly Dictionary<string, AssemblyRecord> _assemblies = new(StringComparer.OrdinalIgnoreCase);
    private readonly Dictionary<string, (long Ticks, string Text)> _text = new(StringComparer.Ordinal);

    public int ParsedCount;
    public int CachedCount;

    public MapEngine(bool timers) => _timers = timers;

    public void Mark(string name)
    {
        if (!_timers) return;
        var now = _sw.Elapsed.TotalMilliseconds;
        Console.Error.WriteLine($"[phase] {name}: {now - _prev:F1}ms");
        _prev = now;
    }

    public object Compute(string repoRoot, int godPercent, List<AssemblyInput> inputs)
    {
        if (_timers)
        {
            _sw.Restart();
            _prev = 0;
        }

        var skipped = new List<object>();
        var world = new Dictionary<string, TypeNode>(); // key: assemblySimpleName + "|" + fqn
        var byName = new Dictionary<string, List<TypeNode>>(); // fqn -> nodes (cross-assembly resolve)
        var testClasses = new List<TypeNode>();

        ParsedCount = 0;
        CachedCount = 0;
        foreach (var input in inputs)
        {
            var (cached, dt, ds, pt, ps) = TryCached(input);
            if (cached != null)
            {
                CachedCount++;
                if (cached.Skip != null) skipped.Add(new { assembly = input.Dll, reason = cached.Skip });
                AddNodes(world, byName, cached.Types);
            }
            else
            {
                ParsedCount++;
                var (parsedTypes, skip) = ParseAssembly(input, repoRoot);
                if (skip != null) skipped.Add(new { assembly = input.Dll, reason = skip });
                AddNodes(world, byName, parsedTypes);
                if (ds >= 0) // "not built" re-checks cheaply each request
                {
                    _assemblies[input.Dll] = new AssemblyRecord
                    {
                        DllTicks = dt,
                        DllSize = ds,
                        PdbTicks = pt,
                        PdbSize = ps,
                        Skip = skip,
                        Types = parsedTypes,
                    };
                }
            }
        }

        Mark("load-assemblies");

        // Test classes: [Fact]/[Theory]/... on any nested type marks the
        // top-level node (compiler-generated types excluded at parse time).
        foreach (var node in world.Values)
            if (node.IsTestClass) testClasses.Add(node);

        // Resolve edges now that every solution type is known.
        foreach (var node in world.Values)
        {
            foreach (var refName in node.RefNames)
            {
                if (byName.TryGetValue(refName, out var targets))
                {
                    foreach (var t in targets) node.Edges.Add(t);
                }
            }
        }
        Mark("edge-resolution");

        // Name-graph union for enum / const-holder types: consumers inline their
        // values, so the consumer IL carries no TypeRef and the defining file is
        // invisible to the closure. Bridge with a source-text pass: any node whose
        // own source mentions the candidate's name gets an edge to it.
        var nameCandidates = world.Values
            .Where(n => (n.IsEnum || n.IsConstOnly) && n.Files.Count > 0)
            .Select(n =>
            {
                var shortName = n.Fqn[(n.Fqn.LastIndexOf('.') + 1)..];
                return (Node: n, ShortName: shortName);
            })
            .Where(c => c.ShortName.Length >= 3 && !c.ShortName.Contains('<'))
            .ToList();
        if (nameCandidates.Count > 0)
        {
            // Refresh file texts once per request (one stat per distinct file)
            // so the hot loop below is a pure dictionary lookup. A changed file
            // (new mtime) is re-read; unchanged files keep their cached text.
            foreach (var node in world.Values)
                foreach (var f in node.Files)
                    RefreshText(repoRoot, f);
            string TextOf(string rel) => _text.TryGetValue(rel, out var hit) ? hit.Text : "";
            static bool MentionsWord(string text, string word)
            {
                for (var at = text.IndexOf(word, StringComparison.Ordinal); at >= 0;
                     at = text.IndexOf(word, at + 1, StringComparison.Ordinal))
                {
                    var before = at == 0 ? '\0' : text[at - 1];
                    var afterIx = at + word.Length;
                    var after = afterIx >= text.Length ? '\0' : text[afterIx];
                    if (!char.IsLetterOrDigit(before) && before != '_' && !char.IsLetterOrDigit(after) && after != '_')
                        return true;
                }
                return false;
            }
            foreach (var node in world.Values)
            {
                foreach (var (candidate, shortName) in nameCandidates)
                {
                    if (candidate == node || node.Edges.Contains(candidate)) continue;
                    if (node.Files.Any(f => !candidate.Files.Contains(f) && MentionsWord(TextOf(f), shortName)))
                        node.Edges.Add(candidate);
                }
            }
        }
        Mark("name-graph-union");

        // God-type cap: a hub type referenced by a large share of the world drags its
        // entire dependency fan into every closure (~7x over-selection measured on a
        // real repo). Keep the hub's OWN files in closures but stop transitive
        // expansion through it. Safe: files that become unmapped fall back to
        // project-level selection at the runner, which only ever runs MORE tests.
        var capped = new HashSet<TypeNode>();
        if (world.Count >= 20)
        {
            var referrers = new Dictionary<TypeNode, int>();
            foreach (var node in world.Values)
                foreach (var e in node.Edges)
                    referrers[e] = referrers.GetValueOrDefault(e) + 1;
            var threshold = Math.Max(10, world.Count * godPercent / 100);
            foreach (var (node, count) in referrers)
                if (count >= threshold && !node.IsTestClass)
                    capped.Add(node);
        }
        Mark("god-cap");

        // BFS closure per test class -> file union. Alongside the closure, each test
        // class's DIRECT references to abstractions (interfaces / abstract classes):
        // the self-tuning map (#31) attributes dynamically-discovered files to the
        // abstractions a class references, so a learned binding transfers to every
        // other class referencing the same abstraction.
        var classes = new Dictionary<string, object>();
        foreach (var tc in testClasses)
        {
            var files = new SortedSet<string>(StringComparer.Ordinal);
            var abstractFiles = new SortedSet<string>(StringComparer.Ordinal);
            foreach (var e in tc.Edges)
                if (e.IsInterface || e.IsAbstract) foreach (var f in e.Files) abstractFiles.Add(f);
            var seen = new HashSet<TypeNode> { tc };
            var queue = new Queue<TypeNode>();
            queue.Enqueue(tc);
            while (queue.Count > 0)
            {
                var n = queue.Dequeue();
                foreach (var f in n.Files) files.Add(f);
                if (capped.Contains(n) && n != tc) continue; // hub: files yes, fan-out no
                foreach (var e in n.Edges)
                {
                    if (seen.Add(e)) queue.Enqueue(e);
                }
            }
            classes[tc.Fqn] = new { csproj = tc.Csproj, files = files.ToArray(), abstractFiles = abstractFiles.ToArray() };
        }
        Mark("bfs-closure");

        // Solution type -> source files, for resolving registration-seed type names
        // (#31) back to files on the extension side. Files-only (types without PDB
        // source carry no selection signal).
        var types = new Dictionary<string, string[]>();
        foreach (var (fqn, nodes) in byName)
        {
            var f = new SortedSet<string>(StringComparer.Ordinal);
            foreach (var n in nodes) foreach (var file in n.Files) f.Add(file);
            if (f.Count > 0) types[fqn] = f.ToArray();
        }

        Mark("types-map");
        return new
        {
            classes,
            types,
            skipped,
            capped = capped.Select(c => c.Fqn).OrderBy(f => f, StringComparer.Ordinal).ToArray(),
        };
    }

    /// <summary>Validates the cache entry for `input` (stats the dll + side-by-side PDB).</summary>
    private (AssemblyRecord? Rec, long DllTicks, long DllSize, long PdbTicks, long PdbSize) TryCached(AssemblyInput input)
    {
        var (dt, ds) = Stat(input.Dll);
        var pdbPath = Path.ChangeExtension(input.Dll, ".pdb");
        var (pt, ps) = Stat(pdbPath);
        if (ds >= 0
            && _assemblies.TryGetValue(input.Dll, out var rec)
            && rec.DllTicks == dt && rec.DllSize == ds && rec.PdbTicks == pt && rec.PdbSize == ps)
            return (rec, dt, ds, pt, ps);
        return (null, dt, ds, pt, ps);
    }

    private void RefreshText(string repoRoot, string rel)
    {
        if (_text.TryGetValue(rel, out var existing))
        {
            // fast path: stat to detect a change (cheap when unchanged)
            long ticks;
            try { ticks = File.GetLastWriteTimeUtc(Path.Combine(repoRoot, rel)).Ticks; }
            catch { return; } // vanished: keep the last known text
            if (existing.Ticks == ticks) return;
        }
        var p = Path.Combine(repoRoot, rel);
        long t;
        string text;
        try { t = File.GetLastWriteTimeUtc(p).Ticks; } catch { t = 0; }
        try { text = File.ReadAllText(p); } catch { text = ""; }
        _text[rel] = (t, text);
    }

    private static (long Ticks, long Size) Stat(string p)
    {
        try
        {
            var fi = new FileInfo(p);
            return (fi.LastWriteTimeUtc.Ticks, fi.Length);
        }
        catch
        {
            return (0, -1);
        }
    }

    private static void AddNodes(Dictionary<string, TypeNode> world, Dictionary<string, List<TypeNode>> byName, RecordedType[] types)
    {
        foreach (var r in types)
        {
            var key = r.AsmName + "|" + r.Fqn;
            if (!world.TryGetValue(key, out var node))
            {
                node = new TypeNode { Fqn = r.Fqn, Csproj = r.Csproj };
                world[key] = node;
                if (!byName.TryGetValue(r.Fqn, out var list)) byName[r.Fqn] = list = new();
                list.Add(node);
            }
            node.Files.UnionWith(r.Files);
            node.RefNames.UnionWith(r.RefNames);
            node.IsTestClass |= r.IsTestClass;
            node.IsEnum |= r.IsEnum;
            node.IsConstOnly |= r.IsConstOnly;
            node.IsInterface |= r.IsInterface;
            node.IsAbstract |= r.IsAbstract;
        }
    }

    /// <summary>
    /// Full parse of one assembly (IL + portable PDB) into immutable records.
    /// Mirrors the pre-H12 LoadAssembly exactly: nested/generic types fold into
    /// their top-level declaring type; "no portable pdb" still yields edge
    /// records (just no files).
    /// </summary>
    private (RecordedType[] Types, string? Skip) ParseAssembly(AssemblyInput input, string repoRoot)
    {
        if (!File.Exists(input.Dll))
            return (Array.Empty<RecordedType>(), "not built");

        using var fs = File.OpenRead(input.Dll);
        using var pe = new PEReader(fs);
        var md = pe.GetMetadataReader();
        var asmName = md.GetString(md.GetAssemblyDefinition().Name);

        // Portable PDB: side-by-side file or embedded.
        MetadataReader? pdb = null;
        MetadataReaderProvider? pdbProvider = null;
        var pdbPath = Path.ChangeExtension(input.Dll, ".pdb");
        try
        {
            if (File.Exists(pdbPath))
            {
                pdbProvider = MetadataReaderProvider.FromPortablePdbStream(
                    new MemoryStream(File.ReadAllBytes(pdbPath)));
                pdb = pdbProvider.GetMetadataReader();
            }
            else
            {
                var embedded = pe.ReadDebugDirectory()
                    .FirstOrDefault(d => d.Type == DebugDirectoryEntryType.EmbeddedPortablePdb);
                if (embedded.DataSize > 0)
                {
                    pdbProvider = pe.ReadEmbeddedPortablePdbDebugDirectoryData(embedded);
                    pdb = pdbProvider.GetMetadataReader();
                }
            }
        }
        catch
        {
            pdb = null; // Windows-format or corrupt PDB: types get no files, edges still count
        }
        string? skip = null;
        if (pdb == null) skip = "no portable pdb";

        // Pre-index PDB document paths.
        var docPaths = new Dictionary<DocumentHandle, string?>();
        if (pdb != null)
        {
            foreach (var dh in pdb.Documents)
            {
                var raw = pdb.GetString(pdb.GetDocument(dh).Name);
                var full = raw.Replace('\\', Path.DirectorySeparatorChar);
                string? rel = null;
                if (full.StartsWith(repoRoot!, StringComparison.OrdinalIgnoreCase))
                {
                    rel = Path.GetRelativePath(repoRoot!, full).Replace(Path.DirectorySeparatorChar, '/');
                    if (rel.StartsWith("..") || rel.Split('/').Any(s => s is "obj" or "bin")) rel = null;
                }
                docPaths[dh] = rel;
            }
        }

        var nodes = new Dictionary<string, TypeNode>(); // asmName|fqn within this assembly
        foreach (var tdh in md.TypeDefinitions)
        {
            var td = md.GetTypeDefinition(tdh);
            var fqn = FullName(md, tdh);
            if (fqn == null) continue; // <Module> etc.
            // Nested and compiler-generated types fold into their top-level declaring type.
            TypeNode node;
            var topFqn = TopLevelFqn(md, tdh) ?? fqn;
            if (nodes.TryGetValue(asmName + "|" + topFqn, out var existing)) node = existing;
            else
            {
                node = new TypeNode { Fqn = topFqn, Csproj = input.Csproj };
                nodes[asmName + "|" + topFqn] = node;
            }

            var collector = new RefCollector(md, node.RefNames);
            // Base type + interfaces.
            collector.AddEntity(td.BaseType);
            foreach (var impl in td.GetInterfaceImplementations())
                collector.AddEntity(md.GetInterfaceImplementation(impl).Interface);
            foreach (var cah in td.GetCustomAttributes()) collector.AddAttribute(cah);

            int fieldCount = 0;
            bool allFieldsLiteral = true;
            foreach (var fh in td.GetFields())
            {
                var fd = md.GetFieldDefinition(fh);
                fd.DecodeSignature(collector, null);
                fieldCount++;
                if ((fd.Attributes & System.Reflection.FieldAttributes.Literal) == 0) allFieldsLiteral = false;
            }

            bool isTestClass = false;
            bool anyMethodBody = false;
            foreach (var mh in td.GetMethods())
            {
                var m = md.GetMethodDefinition(mh);
                m.DecodeSignature(collector, null);
                foreach (var cah in m.GetCustomAttributes())
                {
                    var attrName = AttributeTypeName(md, cah);
                    collector.AddAttribute(cah);
                    if (input.IsTest && attrName is "FactAttribute" or "TheoryAttribute" or "TestAttribute"
                        or "TestCaseAttribute" or "TestMethodAttribute" or "DataTestMethodAttribute")
                    {
                        isTestClass = true;
                    }
                }
                // Method body: every metadata token operand (calls, fields, typeof, newobj...).
                if (m.RelativeVirtualAddress > 0)
                {
                    anyMethodBody = true;
                    try
                    {
                        var body = pe.GetMethodBody(m.RelativeVirtualAddress);
                        ScanIl(md, body.GetILBytes() ?? Array.Empty<byte>(), collector);
                        DecodeLocals(md, body, collector);
                    }
                    catch
                    {
                        /* malformed body: skip */
                    }
                }
                // Source files from sequence points.
                if (pdb != null)
                {
                    try
                    {
                        var mdi = pdb.GetMethodDebugInformation(
                            MetadataTokens.MethodDebugInformationHandle(MetadataTokens.GetRowNumber(mh)));
                        foreach (var sp in mdi.GetSequencePoints())
                        {
                            if (!sp.Document.IsNil && docPaths.TryGetValue(sp.Document, out var rel) && rel != null)
                                node.Files.Add(rel);
                        }
                    }
                    catch
                    {
                        /* no debug info for this method */
                    }
                }
            }

            // Types with no method bodies (enums, const holders, interfaces) have
            // no sequence points; Roslyn records their source files in the
            // TypeDefinitionDocuments custom debug info instead.
            if (pdb != null && node.Files.Count == 0)
            {
                try
                {
                    foreach (var cdih in pdb.GetCustomDebugInformation((EntityHandle)tdh))
                    {
                        var cdi = pdb.GetCustomDebugInformation(cdih);
                        if (pdb.GetGuid(cdi.Kind) != Program.TypeDefinitionDocumentsGuid) continue;
                        var blob = pdb.GetBlobReader(cdi.Value);
                        while (blob.RemainingBytes > 0)
                        {
                            var dh = MetadataTokens.DocumentHandle(blob.ReadCompressedInteger());
                            if (docPaths.TryGetValue(dh, out var rel) && rel != null) node.Files.Add(rel);
                        }
                    }
                }
                catch
                {
                    /* absent or malformed: node simply keeps no files */
                }
            }

            // Enum / const-holder detection for the name-graph union: consumers
            // inline these types' values, leaving no IL reference. Top-level
            // types only (nested fold upward and would mislabel their parent).
            if (td.GetDeclaringType().IsNil)
            {
                var baseIsEnum = false;
                if (td.BaseType.Kind == HandleKind.TypeReference)
                {
                    var btr = md.GetTypeReference((TypeReferenceHandle)td.BaseType);
                    baseIsEnum = md.GetString(btr.Name) == "Enum" && md.GetString(btr.Namespace) == "System";
                }
                node.IsEnum = baseIsEnum;
                node.IsConstOnly = fieldCount > 0 && allFieldsLiteral && !anyMethodBody;
            }

            // A [Fact] on a nested class marks the top-level node; skip compiler-generated.
            if (isTestClass && !node.Fqn.Contains('<'))
            {
                node.IsTestClass = true;
            }

            // Abstraction markers for the self-tuning map (#31): which of this
            // node's DIRECTLY referenced types are interfaces / abstract classes.
            // Static classes carry the Abstract flag (Abstract+Sealed) but are
            // never DI targets, so exclude sealed types.
            node.IsInterface = (td.Attributes & System.Reflection.TypeAttributes.Interface) != 0;
            node.IsAbstract =
                (td.Attributes & System.Reflection.TypeAttributes.Abstract) != 0 &&
                (td.Attributes & System.Reflection.TypeAttributes.Sealed) == 0 &&
                !node.IsInterface;
        }

        var recorded = nodes.Values
            .Select(n => new RecordedType
            {
                AsmName = asmName,
                Fqn = n.Fqn,
                Csproj = n.Csproj,
                IsTestClass = n.IsTestClass,
                IsEnum = n.IsEnum,
                IsConstOnly = n.IsConstOnly,
                IsInterface = n.IsInterface,
                IsAbstract = n.IsAbstract,
                Files = new HashSet<string>(n.Files, StringComparer.Ordinal),
                RefNames = new HashSet<string>(n.RefNames, StringComparer.Ordinal),
            })
            .ToArray();
        return (recorded, skip);
    }
    private void DecodeLocals(MetadataReader md, MethodBodyBlock body, RefCollector collector)
    {
        if (body.LocalSignature.IsNil) return;
        try
        {
            md.GetStandaloneSignature(body.LocalSignature).DecodeLocalSignature(collector, null);
        }
        catch
        {
            /* ignore */
        }
    }

    private string? FullName(MetadataReader md, TypeDefinitionHandle h)
    {
        var td = md.GetTypeDefinition(h);
        var name = md.GetString(td.Name);
        if (name == "<Module>") return null;
        var declaring = td.GetDeclaringType();
        if (!declaring.IsNil)
        {
            var parent = FullName(md, declaring);
            return parent == null ? null : parent + "+" + name;
        }
        var ns = md.GetString(td.Namespace);
        return ns.Length > 0 ? ns + "." + name : name;
    }

    // Top-level declaring type's FQN (nested + generated types fold upward).
    private string? TopLevelFqn(MetadataReader md, TypeDefinitionHandle h)
    {
        var td = md.GetTypeDefinition(h);
        var declaring = td.GetDeclaringType();
        return declaring.IsNil ? FullName(md, h) : TopLevelFqn(md, declaring);
    }

    private string? AttributeTypeName(MetadataReader md, CustomAttributeHandle cah)
    {
        var ca = md.GetCustomAttribute(cah);
        switch (ca.Constructor.Kind)
        {
            case HandleKind.MemberReference:
            {
                var parent = md.GetMemberReference((MemberReferenceHandle)ca.Constructor).Parent;
                if (parent.Kind == HandleKind.TypeReference)
                    return md.GetString(md.GetTypeReference((TypeReferenceHandle)parent).Name);
                return null;
            }
            case HandleKind.MethodDefinition:
            {
                var mdh = (MethodDefinitionHandle)ca.Constructor;
                var owner = md.GetMethodDefinition(mdh).GetDeclaringType();
                return md.GetString(md.GetTypeDefinition(owner).Name);
            }
            default:
                return null;
        }
    }

    // IL walker: uses System.Reflection.Emit.OpCodes for operand sizing; records
    // every InlineMethod/InlineField/InlineType/InlineTok operand.
    private void ScanIl(MetadataReader md, byte[] il, RefCollector collector)
    {
        for (int i = 0; i < il.Length; )
        {
            OpCode op;
            if (il[i] == 0xFE && i + 1 < il.Length)
            {
                op = IlTables.Two[il[i + 1]];
                i += 2;
            }
            else
            {
                op = IlTables.One[il[i]];
                i += 1;
            }
            switch (op.OperandType)
            {
                case OperandType.InlineNone:
                    break;
                case OperandType.ShortInlineBrTarget:
                case OperandType.ShortInlineI:
                case OperandType.ShortInlineVar:
                    i += 1;
                    break;
                case OperandType.InlineVar:
                    i += 2;
                    break;
                case OperandType.InlineBrTarget:
                case OperandType.InlineI:
                case OperandType.ShortInlineR:
                case OperandType.InlineString:
                case OperandType.InlineSig:
                    i += 4;
                    break;
                case OperandType.InlineMethod:
                case OperandType.InlineField:
                case OperandType.InlineType:
                case OperandType.InlineTok:
                {
                    if (i + 4 > il.Length) return;
                    int token = BitConverter.ToInt32(il, i);
                    i += 4;
                    collector.AddToken(token);
                    break;
                }
                case OperandType.InlineI8:
                case OperandType.InlineR:
                    i += 8;
                    break;
                case OperandType.InlineSwitch:
                {
                    if (i + 4 > il.Length) return;
                    int n = BitConverter.ToInt32(il, i);
                    i += 4 + n * 4;
                    break;
                }
                default:
                    i += 4;
                    break;
            }
        }
    }


}

partial class Program
{
    /// <summary>Portable-PDB custom debug info: source documents of a type with no method bodies.</summary>
    internal static readonly Guid TypeDefinitionDocumentsGuid = new("932E74BC-DBA9-4478-8D46-0F32A7BAB3D3");
}

static class IlTables
{
    public static readonly OpCode[] One = new OpCode[256];
    public static readonly OpCode[] Two = new OpCode[256];

    static IlTables()
    {
        foreach (var f in typeof(OpCodes).GetFields())
        {
            if (f.GetValue(null) is OpCode op)
            {
                var v = (ushort)op.Value;
                if (v < 0x100) One[v] = op;
                else if ((v & 0xFF00) == 0xFE00) Two[v & 0xFF] = op;
            }
        }
    }
}

// Collects referenced type full names (nesting folded to the top-level type)
// from signatures, attribute ctors, and IL tokens.
sealed class RefCollector : ISignatureTypeProvider<int, object?>
{
    private readonly MetadataReader _md;
    private readonly HashSet<string> _sink;

    public RefCollector(MetadataReader md, HashSet<string> sink)
    {
        _md = md;
        _sink = sink;
    }

    public void AddToken(int token)
    {
        try
        {
            var h = MetadataTokens.EntityHandle(token);
            AddEntity(h);
        }
        catch
        {
            /* malformed token */
        }
    }

    public void AddEntity(EntityHandle h)
    {
        if (h.IsNil) return;
        try
        {
            switch (h.Kind)
            {
                case HandleKind.TypeReference:
                    AddTypeRef((TypeReferenceHandle)h);
                    break;
                case HandleKind.TypeDefinition:
                    Add(TopFqnOfDef((TypeDefinitionHandle)h));
                    break;
                case HandleKind.TypeSpecification:
                    _md.GetTypeSpecification((TypeSpecificationHandle)h).DecodeSignature(this, null);
                    break;
                case HandleKind.MemberReference:
                {
                    var mr = _md.GetMemberReference((MemberReferenceHandle)h);
                    AddEntity(mr.Parent);
                    try
                    {
                        if (mr.GetKind() == MemberReferenceKind.Method) mr.DecodeMethodSignature(this, null);
                        else mr.DecodeFieldSignature(this, null);
                    }
                    catch
                    {
                        /* ignore */
                    }
                    break;
                }
                case HandleKind.MethodDefinition:
                {
                    var owner = _md.GetMethodDefinition((MethodDefinitionHandle)h).GetDeclaringType();
                    Add(TopFqnOfDef(owner));
                    break;
                }
                case HandleKind.FieldDefinition:
                {
                    var owner = _md.GetFieldDefinition((FieldDefinitionHandle)h).GetDeclaringType();
                    Add(TopFqnOfDef(owner));
                    break;
                }
                case HandleKind.MethodSpecification:
                {
                    var ms = _md.GetMethodSpecification((MethodSpecificationHandle)h);
                    AddEntity(ms.Method);
                    try
                    {
                        ms.DecodeSignature(this, null);
                    }
                    catch
                    {
                        /* ignore */
                    }
                    break;
                }
            }
        }
        catch
        {
            /* damaged metadata row: skip */
        }
    }

    public void AddAttribute(CustomAttributeHandle cah)
    {
        try
        {
            AddEntity(_md.GetCustomAttribute(cah).Constructor);
        }
        catch
        {
            /* ignore */
        }
    }

    private void AddTypeRef(TypeReferenceHandle h)
    {
        var tr = _md.GetTypeReference(h);
        // Nested TypeRef: resolution scope is the declaring TypeRef.
        if (tr.ResolutionScope.Kind == HandleKind.TypeReference)
        {
            AddTypeRef((TypeReferenceHandle)tr.ResolutionScope);
            return;
        }
        var ns = _md.GetString(tr.Namespace);
        var name = _md.GetString(tr.Name);
        Add(ns.Length > 0 ? ns + "." + name : name);
    }

    private string? TopFqnOfDef(TypeDefinitionHandle h)
    {
        var td = _md.GetTypeDefinition(h);
        var declaring = td.GetDeclaringType();
        if (!declaring.IsNil) return TopFqnOfDef(declaring);
        var ns = _md.GetString(td.Namespace);
        var name = _md.GetString(td.Name);
        if (name == "<Module>") return null;
        return ns.Length > 0 ? ns + "." + name : name;
    }

    private void Add(string? fqn)
    {
        if (fqn != null && !fqn.StartsWith('<')) _sink.Add(fqn);
    }

    // ISignatureTypeProvider: we only care about named types flowing through.
    public int GetTypeFromDefinition(MetadataReader reader, TypeDefinitionHandle handle, byte rawTypeKind)
    {
        Add(TopFqnOfDef(handle));
        return 0;
    }

    public int GetTypeFromReference(MetadataReader reader, TypeReferenceHandle handle, byte rawTypeKind)
    {
        AddTypeRef(handle);
        return 0;
    }

    public int GetTypeFromSpecification(MetadataReader reader, object? ctx, TypeSpecificationHandle handle, byte rawTypeKind)
    {
        try
        {
            reader.GetTypeSpecification(handle).DecodeSignature(this, ctx);
        }
        catch
        {
            /* ignore */
        }
        return 0;
    }

    public int GetSZArrayType(int elementType) => 0;
    public int GetArrayType(int elementType, ArrayShape shape) => 0;
    public int GetByReferenceType(int elementType) => 0;
    public int GetPointerType(int elementType) => 0;
    public int GetPrimitiveType(PrimitiveTypeCode typeCode) => 0;
    public int GetGenericInstantiation(int genericType, System.Collections.Immutable.ImmutableArray<int> typeArguments) => 0;
    public int GetGenericMethodParameter(object? ctx, int index) => 0;
    public int GetGenericTypeParameter(object? ctx, int index) => 0;
    public int GetModifiedType(int modifier, int unmodifiedType, bool isRequired) => 0;
    public int GetPinnedType(int elementType) => 0;
    public int GetFunctionPointerType(MethodSignature<int> signature) => 0;
}
