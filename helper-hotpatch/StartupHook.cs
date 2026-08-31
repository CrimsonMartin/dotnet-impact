// Impact hot-patch startup hook.
//
// Injected into testhost processes via DOTNET_STARTUP_HOOKS (with
// DOTNET_MODIFIABLE_ASSEMBLIES=debug). Hosts a named-pipe server the extension
// pushes metadata deltas to; each delta is applied to the matching loaded
// assembly with MetadataUpdater.ApplyUpdate, so tests re-run against edited
// code with no rebuild and no testhost restart.
//
// Frame (little-endian lengths): [nameLen][utf8 assembly simple name]
//   [mdLen][md] [ilLen][il] [pdbLen][pdb]  ->  reply: 1 byte (1 ok, 0 fail)
//
// The pipe name comes from IMPACT_HOTPATCH_PIPE; without it the hook is inert.

using System.IO.Pipes;
using System.Reflection;
using System.Reflection.Metadata;
using System.Text;

internal sealed class StartupHook
{
    public static void Initialize()
    {
        // Each testhost gets its own pipe: <base>-<pid>, announced by touching a
        // pid-named file in IMPACT_HOTPATCH_DIR so the extension can find every
        // live testhost and push deltas to all of them. Line 1 is the pipe
        // name; line 2 reports this runtime's hot-reload capability set
        // (space-separated) so delta generation is gated on what the hosts can
        // actually apply, not an assumed list.
        var baseName = Environment.GetEnvironmentVariable("IMPACT_HOTPATCH_PIPE");
        if (string.IsNullOrEmpty(baseName)) return;
        var pipeName = baseName + "-" + Environment.ProcessId;
        var dir = Environment.GetEnvironmentVariable("IMPACT_HOTPATCH_DIR");
        try
        {
            if (!string.IsNullOrEmpty(dir))
            {
                Directory.CreateDirectory(dir);
                File.WriteAllText(
                    Path.Combine(dir, Environment.ProcessId.ToString()),
                    pipeName + "\n" + RuntimeCapabilities());
            }
        }
        catch
        {
            /* registration is best effort */
        }
        var thread = new Thread(() => Serve(pipeName)) { IsBackground = true, Name = "impact-hotpatch" };
        thread.Start();
    }

    /// <summary>
    /// The runtime's own hot-reload capability set. GetCapabilities is
    /// internal by design; dotnet-watch's delta applier reads it the same way.
    /// An unreadable or empty answer degrades to "Baseline" — the delta
    /// service then refuses anything beyond body edits, which the build path
    /// covers, so a wrong guess can only cost speed, never correctness.
    /// </summary>
    private static string RuntimeCapabilities()
    {
        try
        {
            var m = typeof(MetadataUpdater).GetMethod(
                "GetCapabilities",
                System.Reflection.BindingFlags.NonPublic | System.Reflection.BindingFlags.Static);
            var caps = m?.Invoke(null, null) as string;
            return string.IsNullOrWhiteSpace(caps) ? "Baseline" : caps.Trim();
        }
        catch
        {
            return "Baseline";
        }
    }

    private static void Serve(string pipeName)
    {
        // .NET on Unix unlinks the pipe's socket file when a connection is
        // accepted, so a single instance can never accept twice. Accept, hand
        // the connection to a worker, and bind a fresh instance immediately so
        // the socket always exists for the next push.
        for (;;)
        {
            try
            {
                var server = new NamedPipeServerStream(
                    pipeName, PipeDirection.InOut,
                    NamedPipeServerStream.MaxAllowedServerInstances, PipeTransmissionMode.Byte);
                server.WaitForConnection();
                var conn = server;
                new Thread(() => Handle(conn)) { IsBackground = true }.Start();
            }
            catch
            {
                Thread.Sleep(200); // bind/accept error: retry
            }
        }
    }

    private static void Handle(NamedPipeServerStream conn)
    {
        try
        {
            using var reader = new BinaryReader(conn, Encoding.UTF8, leaveOpen: true);
            using var writer = new BinaryWriter(conn, Encoding.UTF8, leaveOpen: true);
            for (;;)
            {
                string name;
                byte[] md, il, pdb;
                try
                {
                    name = Encoding.UTF8.GetString(reader.ReadBytes(reader.ReadInt32()));
                    md = reader.ReadBytes(reader.ReadInt32());
                    il = reader.ReadBytes(reader.ReadInt32());
                    pdb = reader.ReadBytes(reader.ReadInt32());
                }
                catch
                {
                    return; // client hung up
                }
                byte status = 0;
                try
                {
                    var asm = AppDomain.CurrentDomain.GetAssemblies()
                        .FirstOrDefault(a => string.Equals(a.GetName().Name, name, StringComparison.OrdinalIgnoreCase));
                    if (asm != null)
                    {
                        MetadataUpdater.ApplyUpdate(asm, md, il, pdb);
                        status = 1;
                    }
                }
                catch (Exception e)
                {
                    Console.Error.WriteLine($"[impact-hotpatch] apply failed for {name}: {e.Message}");
                }
                writer.Write(status);
                writer.Flush();
            }
        }
        catch
        {
            /* connection error: worker exits */
        }
        finally
        {
            conn.Dispose();
        }
    }
}
