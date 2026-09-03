import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ResolverStrategy, ResolverStrategyType } from './resolverStrategy';

export interface GraphLink {
  source: string;
  target: string;
  weight: number;
  edgeType: string;
}

export class DotNetDependencyResolver extends ResolverStrategy {
  readonly type = ResolverStrategyType.DotNet;
  readonly label = 'DotNetDependencyResolver (Roslyn .NET strategy)';
  protected readonly supportedExtensions = ['.cs', '.razor'];

  async resolveFile(filePath: string): Promise<GraphLink[]> {
    if (!this.supports(filePath)) {
      return [];
    }

    const rootDir = this.rootDir || process.cwd();
    const relevantFiles = this.collectRelevantFiles(rootDir)
      .filter((candidate: string) => this.supports(candidate));

    if (relevantFiles.length === 0) {
      return [];
    }

    const links = await this.extractEdges(rootDir, undefined, relevantFiles);
    const source = this.toGraphPath(filePath, rootDir);
    return links.filter((link) => link.source === source);
  }

  async extractEdges(
    rootDir: string = process.cwd(),
    onProgress?: (message: string, percent: number, processed: number, total: number) => void,
    fileOverride?: readonly string[],
  ): Promise<GraphLink[]> {
    const files = fileOverride && fileOverride.length > 0 ? [...fileOverride] : this.collectRelevantFiles(rootDir);
    if (files.length === 0) {
      return [];
    }

    const roslynLinks = this.resolveWithRoslyn(rootDir, files, onProgress);
    const razorLinks = this.resolveRazorLinks(rootDir, files);
    return this.dedupeLinks([...roslynLinks, ...razorLinks]);
  }

  private collectRelevantFiles(rootDir: string): string[] {
    if (!rootDir || !fs.existsSync(rootDir)) {
      return [];
    }

    const stack = [rootDir];
    const seen = new Set<string>();
    const result: string[] = [];

    while (stack.length > 0) {
      const current = stack.pop();
      if (!current || seen.has(current)) {
        continue;
      }

      seen.add(current);

      if (!fs.existsSync(current)) {
        continue;
      }

      const stat = fs.statSync(current);
      if (stat.isDirectory()) {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
          const fullPath = path.join(current, entry.name);
          if (['.git', 'node_modules', 'bin', 'obj', '.vs', 'dist', 'Debug', 'Release'].includes(entry.name)) {
            continue;
          }

          stack.push(fullPath);
        }
        continue;
      }

      if (this.isSupportedDotNetFile(current)) {
        result.push(current);
      }
    }

    return result.sort();
  }

  private resolveDotNetExecutable(): string {
    const executableName = process.platform === 'win32' ? 'dotnet.exe' : 'dotnet';
    const standardRoots = process.platform === 'win32'
      ? [
          process.env.DOTNET_ROOT,
          process.env.ProgramFiles && path.join(process.env.ProgramFiles, 'dotnet'),
          process.env['ProgramFiles(x86)'] && path.join(process.env['ProgramFiles(x86)'], 'dotnet'),
          'C:\\Program Files\\dotnet',
          'C:\\Program Files (x86)\\dotnet',
        ]
      : [
          process.env.DOTNET_ROOT,
          '/usr/share/dotnet',
          '/usr/local/share/dotnet',
          path.join(os.homedir(), '.dotnet'),
        ];

    const explicitRoots = standardRoots.filter((value): value is string => Boolean(value));
    const pathRoots = (process.env.PATH ?? '')
      .split(path.delimiter)
      .map((value) => value.trim())
      .filter(Boolean);

    for (const root of [...explicitRoots, ...pathRoots]) {
      const candidates = [
        path.join(root, executableName),
        path.join(root, process.platform === 'win32' ? 'dotnet.exe' : 'dotnet'),
      ];

      for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
          return candidate;
        }
      }
    }

    if (process.env.PATH) {
      const lookup = spawnSync(process.platform === 'win32' ? 'where.exe' : 'which', ['dotnet'], {
        encoding: 'utf8',
        env: process.env,
        shell: false,
      });

      const firstMatch = typeof lookup.stdout === 'string'
        ? lookup.stdout
            .split(/\r?\n/)
            .map((line) => line.trim())
            .find((line) => line.length > 0)
        : undefined;

      if (firstMatch) {
        return firstMatch;
      }
    }

    return executableName;
  }

  private resolveWithRoslyn(
    rootDir: string,
    files: string[],
    onProgress?: (message: string, percent: number, processed: number, total: number) => void,
  ): GraphLink[] {
    const csFiles = files.filter((file) => path.extname(file).toLowerCase() === '.cs');
    if (csFiles.length === 0) {
      return [];
    }

    try {
      const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dotnet-dependency-resolver-'));
      const projectDir = path.join(tempRoot, 'resolver');
      fs.mkdirSync(projectDir, { recursive: true });

      const projectFile = path.join(projectDir, 'DotNetDependencyResolver.csproj');
      const programFile = path.join(projectDir, 'Program.cs');

      const projectXml = `
<Project Sdk="Microsoft.NET.Sdk">
  <PropertyGroup>
    <OutputType>Exe</OutputType>
    <TargetFramework>net10.0</TargetFramework>
    <ImplicitUsings>enable</ImplicitUsings>
    <Nullable>enable</Nullable>
    <LangVersion>latest</LangVersion>
  </PropertyGroup>
  <ItemGroup>
    <PackageReference Include="Microsoft.CodeAnalysis.CSharp" Version="4.13.0" />
  </ItemGroup>
</Project>
`.trim();

      const programCode = String.raw`
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
`.trim();

      fs.writeFileSync(projectFile, projectXml, 'utf8');
      fs.writeFileSync(programFile, programCode, 'utf8');

      onProgress?.(`[DotNetDependencyResolver] building Roslyn graph for ${csFiles.length} C# file(s)`, 5, 0, Math.max(csFiles.length, 1));

      const dotnetExecutable = this.resolveDotNetExecutable();
      const dotnetRoot = path.dirname(dotnetExecutable);
      const childEnv = {
        ...process.env,
        DOTNET_ROOT: dotnetRoot,
        PATH: [dotnetRoot, process.env.PATH ?? ''].filter(Boolean).join(path.delimiter),
      };

      const result = spawnSync(dotnetExecutable, ['run', '--project', projectFile, '--', '--root', rootDir], {
        encoding: 'utf8',
        cwd: projectDir,
        env: childEnv,
        maxBuffer: 100 * 1024 * 1024,
      });

      const stderr = typeof result.stderr === 'string' ? result.stderr.trim() : String(result.stderr ?? '').trim();
      const stdout = typeof result.stdout === 'string' ? result.stdout.trim() : String(result.stdout ?? '').trim();

      if (result.error) {
        const errorMessage = result.error instanceof Error ? result.error.message : String(result.error);
        const details = [
          `spawn: ${errorMessage}`,
          stderr ? `stderr: ${stderr}` : undefined,
          stdout ? `stdout: ${stdout}` : undefined,
        ].filter(Boolean).join(' | ');

        console.warn(`[DotNetDependencyResolver] Roslyn dependency resolver failed: ${details || 'dotnet could not be started'}`);
        return [];
      }

      if (result.status !== 0) {
        const details = [
          `exitCode: ${result.status}`,
          stderr ? `stderr: ${stderr}` : undefined,
          stdout ? `stdout: ${stdout}` : undefined,
        ].filter(Boolean).join(' | ');

        console.warn(`[DotNetDependencyResolver] Roslyn dependency resolver failed: ${details || 'dotnet exited with a non-zero status'}`);
        return [];
      }

      const stdoutText = stdout;
      if (!stdout) {
        return [];
      }

      const payload = JSON.parse(stdout) as { links?: Array<{ source: string; target: string; weight?: number; edgeType?: string }> };
      const links = Array.isArray(payload.links) ? payload.links.map((entry) => ({
        source: entry.source,
        target: entry.target,
        weight: Math.max(1, entry.weight ?? 1),
        edgeType: entry.edgeType || 'file-reference',
      })) : [];

      onProgress?.(`[DotNetDependencyResolver] Roslyn graph ready: ${links.length} edge(s)`, 100, csFiles.length, Math.max(csFiles.length, 1));
      return links;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      console.warn(`[DotNetDependencyResolver] Roslyn dependency resolution failed; continuing without Roslyn results: ${message}`);
      return [];
    }
  }

  private resolveRazorLinks(rootDir: string, files: string[]): GraphLink[] {
    const razorFiles = files.filter((file) => path.extname(file).toLowerCase() === '.razor');
    if (razorFiles.length === 0) {
      return [];
    }

    const result: GraphLink[] = [];
    for (const filePath of razorFiles) {
      const content = fs.readFileSync(filePath, 'utf8');
      const matches = [...content.matchAll(/<([A-Z][A-Za-z0-9_.]*)\b/g)];
      const source = this.normalizedPath(rootDir, filePath);

      for (const match of matches) {
        const tagName = match[1]?.split('.').pop();
        if (!tagName) {
          continue;
        }

        const resolved = this.findRazorComponent(rootDir, path.dirname(filePath), tagName);
        if (!resolved || source === this.normalizedPath(rootDir, resolved)) {
          continue;
        }

        result.push({ source, target: this.normalizedPath(rootDir, resolved), weight: 1, edgeType: 'file-reference' });
      }
    }

    return this.dedupeLinks(result);
  }

  private findRazorComponent(rootDir: string, baseDir: string, componentName: string): string | undefined {
    const candidates = [
      path.join(baseDir, `${componentName}.razor`),
      path.join(baseDir, `${componentName}.cs`),
      path.join(rootDir, `${componentName}.razor`),
      path.join(rootDir, `${componentName}.cs`),
    ];

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }

    return undefined;
  }

  private normalizedPath(rootDir: string, filePath: string): string {
    const relative = path.relative(rootDir, filePath).replace(/\\/g, '/');
    return relative.startsWith('..') ? filePath.replace(/\\/g, '/') : relative;
  }

  private dedupeLinks(links: readonly GraphLink[]): GraphLink[] {
    const seen = new Set<string>();
    const result: GraphLink[] = [];

    for (const link of links) {
      const key = `${link.source}\u0000${link.target}\u0000${link.edgeType}`;
      if (!seen.has(key)) {
        seen.add(key);
        result.push({ ...link, weight: Math.max(1, link.weight || 1), edgeType: link.edgeType || 'file-reference' });
      }
    }

    return result;
  }

  private isSupportedDotNetFile(filePath: string): boolean {
    const extension = path.extname(filePath).toLowerCase();
    return ['.cs', '.razor'].includes(extension);
  }
}
