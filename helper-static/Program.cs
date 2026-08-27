// dotnet-impact static map builder.
//
// Reads the solution's BUILT assemblies (IL metadata via System.Reflection.Metadata)
// plus their portable PDBs, builds the compiler-resolved type-reference graph, and
// emits source file sets for each test class's transitive closure:
//
//   ImpactStaticMap --repo-root <shadowRoot> --assemblies <assemblies.json>
//     assemblies.json: [{ "csproj": "tests/X/X.csproj", "dll": "/abs/path/X.dll", "isTest": true }]
//   stdout: { "classes": { "Ns.TestClass": { "csproj": "...", "files": ["src/A.cs"] } },
//            "skipped": [{ "assembly": "...", "reason": "..." }] }
//
// Test classes are detected by IL attributes (xunit Fact/Theory, NUnit Test/TestCase,
// MSTest TestMethod) on methods of types in test assemblies. Edges cover base types,
// interfaces, member signatures, custom attributes, and every metadata token in
// method bodies (calls, field access, typeof, generic instantiations). The result is
// a safe superset of dynamic coverage: every file a test class *could* reach.

using System.Reflection.Emit;
using System.Reflection.Metadata;
using System.Reflection.Metadata.Ecma335;
using System.Reflection.PortableExecutable;
using System.Text.Json;

string? repoRoot = null, assembliesPath = null;
for (int i = 0; i < args.Length - 1; i++)
{
    if (args[i] == "--repo-root") repoRoot = args[i + 1];
    if (args[i] == "--assemblies") assembliesPath = args[i + 1];
}
if (repoRoot == null || assembliesPath == null)
{
    Console.Error.WriteLine("usage: ImpactStaticMap --repo-root <dir> --assemblies <json>");
    return 2;
}
repoRoot = Path.GetFullPath(repoRoot);

var inputs = JsonSerializer.Deserialize<List<AssemblyInput>>(
    File.ReadAllText(assembliesPath),
    new JsonSerializerOptions { PropertyNameCaseInsensitive = true })!;

var skipped = new List<object>();
var world = new Dictionary<string, TypeNode>(); // key: assemblySimpleName + "|" + fqn
var byName = new Dictionary<string, List<TypeNode>>(); // fqn -> nodes (cross-assembly resolve)
var testClasses = new List<TypeNode>();

foreach (var input in inputs)
{
    try
    {
        LoadAssembly(input);
    }
    catch (Exception e)
    {
        skipped.Add(new { assembly = input.Dll, reason = e.Message });
    }
}

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

// BFS closure per test class -> file union.
var classes = new Dictionary<string, object>();
foreach (var tc in testClasses)
{
    var files = new SortedSet<string>(StringComparer.Ordinal);
    var seen = new HashSet<TypeNode> { tc };
    var queue = new Queue<TypeNode>();
    queue.Enqueue(tc);
    while (queue.Count > 0)
    {
        var n = queue.Dequeue();
        foreach (var f in n.Files) files.Add(f);
        foreach (var e in n.Edges)
        {
            if (seen.Add(e)) queue.Enqueue(e);
        }
    }
    classes[tc.Fqn] = new { csproj = tc.Csproj, files = files.ToArray() };
}

Console.WriteLine(JsonSerializer.Serialize(new { classes, skipped }));
return 0;

void LoadAssembly(AssemblyInput input)
{
    if (!File.Exists(input.Dll))
    {
        skipped.Add(new { assembly = input.Dll, reason = "not built" });
        return;
    }
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
    if (pdb == null) skipped.Add(new { assembly = input.Dll, reason = "no portable pdb" });

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

    foreach (var tdh in md.TypeDefinitions)
    {
        var td = md.GetTypeDefinition(tdh);
        var fqn = FullName(md, tdh);
        if (fqn == null) continue; // <Module> etc.
        // Nested and compiler-generated types fold into their top-level declaring type.
        var node = new TypeNode { Fqn = TopLevelFqn(md, tdh) ?? fqn, Csproj = input.Csproj };
        if (world.TryGetValue(asmName + "|" + node.Fqn, out var existing)) node = existing;
        else
        {
            world[asmName + "|" + node.Fqn] = node;
            if (!byName.TryGetValue(node.Fqn, out var list)) byName[node.Fqn] = list = new();
            list.Add(node);
        }

        var collector = new RefCollector(md, node.RefNames);
        // Base type + interfaces.
        collector.AddEntity(td.BaseType);
        foreach (var impl in td.GetInterfaceImplementations())
            collector.AddEntity(md.GetInterfaceImplementation(impl).Interface);
        foreach (var cah in td.GetCustomAttributes()) collector.AddAttribute(cah);

        foreach (var fh in td.GetFields())
        {
            var fd = md.GetFieldDefinition(fh);
            fd.DecodeSignature(collector, null);
        }

        bool isTestClass = false;
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

        // A [Fact] on a nested class marks the top-level node; skip compiler-generated.
        if (isTestClass && !node.Fqn.Contains('<'))
        {
            if (!testClasses.Contains(node)) testClasses.Add(node);
            node.IsTestClass = true;
        }
    }
}

static void DecodeLocals(MetadataReader md, MethodBodyBlock body, RefCollector collector)
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

static string? FullName(MetadataReader md, TypeDefinitionHandle h)
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
static string? TopLevelFqn(MetadataReader md, TypeDefinitionHandle h)
{
    var td = md.GetTypeDefinition(h);
    var declaring = td.GetDeclaringType();
    return declaring.IsNil ? FullName(md, h) : TopLevelFqn(md, declaring);
}

static string? AttributeTypeName(MetadataReader md, CustomAttributeHandle cah)
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
static void ScanIl(MetadataReader md, byte[] il, RefCollector collector)
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

record AssemblyInput(string Csproj, string Dll, bool IsTest);

sealed class TypeNode
{
    public required string Fqn;
    public required string Csproj;
    public bool IsTestClass;
    public readonly HashSet<string> Files = new(StringComparer.Ordinal);
    public readonly HashSet<string> RefNames = new(StringComparer.Ordinal);
    public readonly HashSet<TypeNode> Edges = new();
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
