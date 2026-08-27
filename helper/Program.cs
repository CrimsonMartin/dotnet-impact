// dotnet-impact persistent test runner.
//
// Keeps vstest.console and per-assembly test sessions (pre-warmed testhosts)
// alive between runs, so an incremental test run costs milliseconds of
// dispatch instead of seconds of process startup.
//
// Protocol: JSON lines on stdin/stdout (stdout carries ONLY protocol lines).
//   -> {"id":1,"cmd":"run","dll":"/abs/Tests.dll","filter":"FullyQualifiedName~Ns.Cls."}
//   <- {"id":1,"type":"results","tests":[{"fqn":"...","display":"...","outcome":"passed|failed|skipped","durationMs":12,"message":null}]}
//   <- {"id":1,"type":"done","ok":true}
//   -> {"id":2,"cmd":"release","dll":"..."}   stop the session for a dll (before rebuild)
//   <- {"id":2,"type":"done","ok":true}
//   -> {"id":3,"cmd":"shutdown"}
//
// Sessions are keyed by dll path; a run against a dll whose mtime changed
// since its session started gets a fresh session automatically (never runs
// stale assemblies).

using System.Text.Json;
using Microsoft.TestPlatform.VsTestConsole.TranslationLayer;
using Microsoft.VisualStudio.TestPlatform.ObjectModel;
using Microsoft.VisualStudio.TestPlatform.ObjectModel.Client;
using Microsoft.VisualStudio.TestPlatform.ObjectModel.Client.Interfaces;
using Microsoft.VisualStudio.TestPlatform.ObjectModel.Logging;

var vstestPath = args.Length > 0 ? args[0] : throw new ArgumentException("usage: ImpactRunner <vstest.console.dll> [runsettings-file]");
// Optional runsettings file (hot-patch env injection for testhosts lives there).
var RunSettings = args.Length > 1 && File.Exists(args[1])
    ? File.ReadAllText(args[1])
    : "<RunSettings><RunConfiguration></RunConfiguration></RunSettings>";

var wrapper = new VsTestConsoleWrapper(vstestPath);
wrapper.StartSession();
// SIGTERM/host death must still tear down vstest.console + warm testhosts.
AppDomain.CurrentDomain.ProcessExit += (_, _) =>
{
    try
    {
        wrapper.EndSession();
    }
    catch
    {
        /* best effort */
    }
};
var sessions = new Dictionary<string, (TestSessionInfo Info, DateTime DllTime)>();
var stdout = Console.Out;
var writeLock = new object();

void Emit(object payload)
{
    lock (writeLock) stdout.WriteLine(JsonSerializer.Serialize(payload));
}

// Freshness token for a test assembly: newest write time across every dll in
// its output directory. An incremental build of a referenced project rewrites
// only the dependency dll (the test dll itself keeps its mtime), so keying on
// the test dll alone would happily reuse a testhost holding stale assemblies.
static DateTime FreshnessToken(string dll)
{
    var newest = File.GetLastWriteTimeUtc(dll);
    try
    {
        var dir = Path.GetDirectoryName(Path.GetFullPath(dll));
        if (dir != null)
            foreach (var f in Directory.EnumerateFiles(dir, "*.dll"))
            {
                var t = File.GetLastWriteTimeUtc(f);
                if (t > newest) newest = t;
            }
    }
    catch
    {
        /* fall back to the dll's own mtime */
    }
    return newest;
}

TestSessionInfo? EnsureSession(string dll)
{
    var mtime = FreshnessToken(dll);
    if (sessions.TryGetValue(dll, out var s))
    {
        if (s.DllTime == mtime) return s.Info;
        TryStop(dll, s.Info); // dll rebuilt: never reuse the stale testhost
    }
    var handler = new SessionHandler();
    wrapper.StartTestSession(new[] { dll }, RunSettings, handler);
    handler.Done.Wait(TimeSpan.FromSeconds(60));
    if (handler.Info == null) return null; // platform refused; caller runs sessionless
    sessions[dll] = (handler.Info, mtime);
    return handler.Info;
}

void TryStop(string dll, TestSessionInfo info)
{
    try
    {
        wrapper.StopTestSession(info, new SessionHandler());
    }
    catch
    {
        /* best effort */
    }
    sessions.Remove(dll);
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
        var cmd = root.GetProperty("cmd").GetString();

        if (cmd == "shutdown") break;

        if (cmd == "release")
        {
            var dll = root.GetProperty("dll").GetString()!;
            if (sessions.TryGetValue(dll, out var s)) TryStop(dll, s.Info);
            Emit(new { id, type = "done", ok = true });
            continue;
        }

        if (cmd == "run")
        {
            var dll = root.GetProperty("dll").GetString()!;
            var filter = root.TryGetProperty("filter", out var f) ? f.GetString() : null;
            if (!File.Exists(dll))
            {
                Emit(new { id, type = "done", ok = false, error = $"not found: {dll}" });
                continue;
            }
            var sessionInfo = EnsureSession(dll);
            var run = new RunHandler(id, Emit);
            var options = new TestPlatformOptions { TestCaseFilter = string.IsNullOrEmpty(filter) ? null : filter };
            if (sessionInfo != null)
                wrapper.RunTests(new[] { dll }, RunSettings, options, sessionInfo, run);
            else
                wrapper.RunTests(new[] { dll }, RunSettings, options, run);
            var finished = run.Done.Wait(TimeSpan.FromMinutes(10));
            if (run.Aborted && sessions.TryGetValue(dll, out var st)) TryStop(dll, st.Info);
            // An aborted run (testhost crash) must never read as green.
            Emit(new { id, type = "done", ok = finished && !run.HadError && !run.Aborted, error = run.Error });
            if (!finished)
            {
                // The wrapper is still busy with the timed-out run and is not
                // reentrant: exit so the client respawns a clean helper.
                Environment.Exit(3);
            }
            continue;
        }

        Emit(new { id, type = "done", ok = false, error = $"unknown cmd: {cmd}" });
    }
    catch (Exception e)
    {
        Emit(new { id, type = "done", ok = false, error = e.Message });
    }
}

foreach (var (dll, s) in sessions.ToArray()) TryStop(dll, s.Info);
wrapper.EndSession();

sealed class SessionHandler : ITestSessionEventsHandler
{
    public TestSessionInfo? Info;
    public readonly ManualResetEventSlim Done = new();

    public void HandleStartTestSessionComplete(StartTestSessionCompleteEventArgs? eventArgs)
    {
        Info = eventArgs?.TestSessionInfo;
        Done.Set();
    }

    public void HandleStopTestSessionComplete(StopTestSessionCompleteEventArgs? eventArgs) { }
    public void HandleLogMessage(TestMessageLevel level, string? message)
    {
        if (level == TestMessageLevel.Error) Console.Error.WriteLine($"[session] {message}");
    }
    public void HandleRawMessage(string rawMessage) { }
}

sealed class RunHandler : ITestRunEventsHandler
{
    private readonly int _id;
    private readonly Action<object> _emit;
    public readonly ManualResetEventSlim Done = new();
    public bool HadError;
    public bool Aborted;
    public string? Error;

    public RunHandler(int id, Action<object> emit)
    {
        _id = id;
        _emit = emit;
    }

    private void Send(IEnumerable<TestResult>? results)
    {
        if (results == null) return;
        var tests = results.Select(r => new
        {
            fqn = r.TestCase.FullyQualifiedName,
            display = r.TestCase.DisplayName,
            outcome = r.Outcome switch
            {
                TestOutcome.Passed => "passed",
                TestOutcome.Failed => "failed",
                _ => "skipped",
            },
            durationMs = (int)r.Duration.TotalMilliseconds,
            message = r.ErrorMessage == null && r.ErrorStackTrace == null
                ? null
                : $"{r.ErrorMessage}{(r.ErrorStackTrace != null ? "\n" + r.ErrorStackTrace : "")}".Trim(),
        }).ToArray();
        if (tests.Length > 0) _emit(new { id = _id, type = "results", tests });
    }

    public void HandleTestRunComplete(
        TestRunCompleteEventArgs completeArgs,
        TestRunChangedEventArgs? lastChunk,
        ICollection<AttachmentSet>? attachments,
        ICollection<string>? executorUris)
    {
        Send(lastChunk?.NewTestResults);
        HadError = completeArgs.Error != null;
        Aborted = completeArgs.IsAborted;
        Error = completeArgs.Error?.Message;
        Done.Set();
    }

    public void HandleTestRunStatsChange(TestRunChangedEventArgs? testRunChangedArgs) =>
        Send(testRunChangedArgs?.NewTestResults);

    public void HandleLogMessage(TestMessageLevel level, string? message)
    {
        if (level == TestMessageLevel.Error) Console.Error.WriteLine($"[vstest] {message}");
    }

    public void HandleRawMessage(string rawMessage) { }
    public int LaunchProcessWithDebuggerAttached(TestProcessStartInfo testProcessStartInfo) => -1;
}
