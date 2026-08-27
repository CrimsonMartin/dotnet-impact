// Workspace factory for the EnC engine. Lives in this assembly because the
// MEF composition needs the Features assembly, whose only reliable handle is
// an internal type — accessible here via the InternalsVisibleTo identity.

using System.Reflection;
using Microsoft.CodeAnalysis.EditAndContinue;
using Microsoft.CodeAnalysis.Host.Mef;

namespace Microsoft.CodeAnalysis.ExternalAccess.HotReload.Api;

public static class ImpactEncWorkspace
{
    /// <summary>
    /// AdhocWorkspace whose MEF composition includes the Edit-and-Continue
    /// services (Features + CSharp.Features on top of the default set).
    /// </summary>
    public static AdhocWorkspace Create()
    {
        var assemblies = MefHostServices.DefaultAssemblies
            .Add(typeof(EditAndContinueService).Assembly)
            .Add(Assembly.Load("Microsoft.CodeAnalysis.CSharp.Features"));
        return new AdhocWorkspace(MefHostServices.Create(assemblies));
    }
}
