using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Text.Json;
using Microsoft.CodeAnalysis;
using Microsoft.CodeAnalysis.CSharp;
using Microsoft.CodeAnalysis.CSharp.Syntax;

var rootDir = string.Empty;
for (var i = 0; i < args.Length; i++)
{
    if (args[i] == "--root" && i + 1 < args.Length)
    {
        rootDir = args[i + 1];
        break;
    }
}

if (string.IsNullOrWhiteSpace(rootDir) || !Directory.Exists(rootDir))
{
    Console.WriteLine("{\"links\": []}");
    return;
}

var files = Directory.EnumerateFiles(rootDir, "*.*", SearchOption.AllDirectories)
    .Where(file => file.EndsWith(".cs", StringComparison.OrdinalIgnoreCase))
    .Where(file => !file.Contains("/bin/", StringComparison.OrdinalIgnoreCase))
    .Where(file => !file.Contains("/obj/", StringComparison.OrdinalIgnoreCase))
    .Where(file => !file.Contains("/node_modules/", StringComparison.OrdinalIgnoreCase))
    .Where(file => !file.Contains("\\bin\\", StringComparison.OrdinalIgnoreCase))
    .Where(file => !file.Contains("\\obj\\", StringComparison.OrdinalIgnoreCase))
    .Where(file => !file.Contains("\\node_modules\\", StringComparison.OrdinalIgnoreCase))
    .OrderBy(file => file, StringComparer.OrdinalIgnoreCase)
    .ToList();

if (files.Count == 0)
{
    Console.WriteLine("{\"links\": []}");
    return;
}

var trustedAssemblies = ((string?)AppContext.GetData("TRUSTED_PLATFORM_ASSEMBLIES"))
    ?? string.Empty;
var metadataReferences = trustedAssemblies
    .Split(Path.PathSeparator)
    .Where(path => !string.IsNullOrWhiteSpace(path))
    .Select(path => MetadataReference.CreateFromFile(path))
    .ToList();

var syntaxTrees = files.Select(file => CSharpSyntaxTree.ParseText(File.ReadAllText(file), path: file)).ToList();
var compilation = CSharpCompilation.Create(
    assemblyName: "dotnet-dependency-resolver",
    syntaxTrees: syntaxTrees,
    references: metadataReferences,
    options: new CSharpCompilationOptions(OutputKind.DynamicallyLinkedLibrary));

var linksByKey = new Dictionary<string, HashSet<string>>(StringComparer.OrdinalIgnoreCase);

foreach (var tree in syntaxTrees)
{
    var currentFile = tree.FilePath;
    if (string.IsNullOrWhiteSpace(currentFile))
    {
        continue;
    }

    var model = compilation.GetSemanticModel(tree);
    var nodes = tree.GetRoot().DescendantNodes();

    foreach (var node in nodes)
    {
        var symbol = node switch
        {
            IdentifierNameSyntax identifier => model.GetSymbolInfo(identifier).Symbol ?? model.GetTypeInfo(identifier).Type ?? model.GetTypeInfo(identifier).ConvertedType,
            GenericNameSyntax generic => model.GetSymbolInfo(generic).Symbol ?? model.GetTypeInfo(generic).Type ?? model.GetTypeInfo(generic).ConvertedType,
            QualifiedNameSyntax qualified => model.GetSymbolInfo(qualified).Symbol ?? model.GetTypeInfo(qualified).Type ?? model.GetTypeInfo(qualified).ConvertedType,
            MemberAccessExpressionSyntax memberAccess => model.GetSymbolInfo(memberAccess).Symbol ?? model.GetTypeInfo(memberAccess).Type ?? model.GetTypeInfo(memberAccess).ConvertedType,
            _ => null
        };

        if (symbol is null)
        {
            continue;
        }

        if (symbol is INamespaceSymbol or IAssemblySymbol or ILocalSymbol or IParameterSymbol or IRangeVariableSymbol or ITypeParameterSymbol or IAliasSymbol)
        {
            continue;
        }

        if (symbol.ContainingAssembly != null && symbol.ContainingAssembly.Name != null && symbol.ContainingAssembly.Name.StartsWith("System", StringComparison.Ordinal))
        {
            continue;
        }

        var targetFile = symbol.DeclaringSyntaxReferences.FirstOrDefault()?.SyntaxTree.FilePath;
        if (string.IsNullOrWhiteSpace(targetFile) || string.Equals(targetFile, currentFile, StringComparison.OrdinalIgnoreCase))
        {
            continue;
        }

        var sourcePath = Path.GetRelativePath(rootDir, currentFile).Replace('\\', '/');
        var targetPath = Path.GetRelativePath(rootDir, targetFile).Replace('\\', '/');

        if (string.Equals(sourcePath, targetPath, StringComparison.OrdinalIgnoreCase))
        {
            continue;
        }

        var key = sourcePath + "\u0000" + targetPath + "\u0000file-reference";
        if (!linksByKey.ContainsKey(key))
        {
            linksByKey[key] = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        }

        linksByKey[key].Add(targetPath);
    }
}

var links = linksByKey
    .Select(pair => new
    {
        source = pair.Key.Split("\u0000", 3)[0],
        target = pair.Key.Split("\u0000", 3)[1],
        edgeType = pair.Key.Split("\u0000", 3)[2],
        weight = Math.Max(1, pair.Value.Count)
    })
    .OrderBy(link => link.source, StringComparer.OrdinalIgnoreCase)
    .ThenBy(link => link.target, StringComparer.OrdinalIgnoreCase)
    .ToList();

Console.WriteLine(JsonSerializer.Serialize(new { links }));
