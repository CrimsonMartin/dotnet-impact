// dotnet-impact hot-patch startup hook.
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
        var pipeName = Environment.GetEnvironmentVariable("IMPACT_HOTPATCH_PIPE");
        if (string.IsNullOrEmpty(pipeName)) return;
        var thread = new Thread(() => Serve(pipeName)) { IsBackground = true, Name = "impact-hotpatch" };
        thread.Start();
    }

    private static void Serve(string pipeName)
    {
        for (;;)
        {
            try
            {
                using var server = new NamedPipeServerStream(
                    pipeName, PipeDirection.InOut, 1, PipeTransmissionMode.Byte);
                server.WaitForConnection();
                using var reader = new BinaryReader(server, Encoding.UTF8, leaveOpen: true);
                using var writer = new BinaryWriter(server, Encoding.UTF8, leaveOpen: true);
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
                        break; // client hung up
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
                Thread.Sleep(200); // pipe error: recreate the server
            }
        }
    }
}
