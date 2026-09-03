import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { DotNetDependencyResolver } from './services/dotnetDependencyResolver';
import { PythonCallChainResolver } from './services/pythonCallChainResolver';
import { getEdgeTypesForResolver, getSupportedFileTypesForResolver, listEntrypointFilesForResolver as findEntrypointFilesForResolver, listResolverTypes, normalizeResolverType, ResolverStrategyType } from './services/resolverStrategy';
import { SemanticEdgeResolutionStrategyDispatcher, TypeScriptDependencyResolver } from './services/semanticEdgeResolutionStrategyDispatcher';

const workspaceRoot = '/workspace';

const resolverTypeSchema = z.enum(['dotnet', 'typescript', 'python', 'generic']);

const filesByResolverSchema = z.object({
  project: z.string().optional().describe('Project directory to inspect.'),
  root: z.string().optional().default(workspaceRoot).describe('Deprecated alias for project directory to inspect.'),
  resolver: resolverTypeSchema.optional().default('generic'),
  include: z.array(z.string()).optional().describe('Optional list of directory prefixes to include.'),
});

const entrypointFilesByResolverSchema = z.object({
  project: z.string().optional().describe('Project directory to inspect.'),
  root: z.string().optional().default(workspaceRoot).describe('Deprecated alias for project directory to inspect.'),
  resolver: resolverTypeSchema.optional().default('generic'),
  include: z.array(z.string()).optional().describe('Optional list of directory prefixes to include.'),
});

const resolveSemanticEdgesSchema = z.object({
  root: z.string().optional().default(workspaceRoot),
  resolver: resolverTypeSchema.optional().default('generic'),
  maxEdges: z.number().int().positive().max(5000).optional().describe('Maximum number of edges to return.'),
});

const edgeTypesByResolverSchema = z.object({
  resolver: resolverTypeSchema.optional().describe('Optional resolver to inspect. If omitted, all resolvers are returned.'),
});

const filesByResolverShape = filesByResolverSchema.shape as any;
const entrypointFilesByResolverShape = entrypointFilesByResolverSchema.shape as any;
const resolveSemanticEdgesShape = resolveSemanticEdgesSchema.shape as any;
const edgeTypesByResolverShape = edgeTypesByResolverSchema.shape as any;

function filterIncludedFiles(files: readonly string[], include?: readonly string[]): string[] {
  if (!include || include.length === 0) {
    return [...files];
  }

  return files.filter((file) => include.some((prefix) => file.includes(prefix)));
}

function listFilesForResolver(root: string, resolver: ResolverStrategyType): string[] {
  switch (resolver) {
    case ResolverStrategyType.DotNet: {
      const dispatcher = new SemanticEdgeResolutionStrategyDispatcher(root);
      return dispatcher.collectSemanticFiles(root)
        .map((file) => file.fsPath)
        .filter((filePath) => new DotNetDependencyResolver().supports(filePath));
    }
    case ResolverStrategyType.TypeScript:
      return new TypeScriptDependencyResolver().collectTypeScriptFiles(root).map((file) => file.fsPath);
    case ResolverStrategyType.Python:
      return new PythonCallChainResolver().collectPythonFiles(root);
    case ResolverStrategyType.Generic:
    default:
      return new SemanticEdgeResolutionStrategyDispatcher(root).collectSemanticFiles(root).map((file) => file.fsPath);
  }
}

function listEntrypointFilesForSemanticBridge(root: string, resolver: ResolverStrategyType): string[] {
  return findEntrypointFilesForResolver(root, resolver);
}

async function resolveSemanticEdgesForResolver(root: string, resolver: ResolverStrategyType): Promise<Array<{ source: string; target: string; weight: number }>> {
  switch (resolver) {
    case ResolverStrategyType.DotNet:
      return new DotNetDependencyResolver().setRootDir(root).extractEdges(root);
    case ResolverStrategyType.TypeScript:
      return new TypeScriptDependencyResolver().setRootDir(root).extractTypeScriptEdgesFromFilesystem(root);
    case ResolverStrategyType.Python:
      return new PythonCallChainResolver().setRootDir(root).extractCallChainEdges(root);
    case ResolverStrategyType.Generic:
    default:
      return new SemanticEdgeResolutionStrategyDispatcher(root).extractEdgesFromFilesystem(root);
  }
}

const server = new McpServer(
  {
    name: 'semantic-bridge-mcp',
    version: '0.1.0',
  },
  {
    capabilities: {},
  },
);

server.registerTool('list_resolvers', {
  description: 'List the available semantic resolver types, their supported file extensions, and their edge categories.',
  inputSchema: {},
}, async () => {
  const resolvers = listResolverTypes().map((type) => ({
    type,
    label: `${type} resolver`,
    supportedFileTypes: getSupportedFileTypesForResolver(type),
    edgeTypes: getEdgeTypesForResolver(type),
  }));

  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({ resolvers }, null, 2),
    }],
  };
});

server.registerTool('edge_types_by_resolver', {
  description: 'List the semantic edge categories emitted by one resolver or by all resolvers.',
  inputSchema: edgeTypesByResolverShape,
}, async (args: Record<string, unknown> = {}, _extra: unknown) => {
  const parsed = edgeTypesByResolverSchema.parse(args ?? {});

  if (parsed.resolver) {
    const resolver = normalizeResolverType(parsed.resolver);
    return {
      content: [{
        type: 'text' as const,
        text: JSON.stringify({ resolver, edgeTypes: getEdgeTypesForResolver(resolver) }, null, 2),
      }],
    };
  }

  const resolvers = Object.fromEntries(
    listResolverTypes().map((type) => [type, getEdgeTypesForResolver(type)]),
  );

  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({ resolvers }, null, 2),
    }],
  };
});

server.registerTool('file_types_by_resolver', {
  description: 'List the supported file types for each semantic resolver.',
  inputSchema: {},
}, async () => {
  const types = listResolverTypes().map((type) => ({
    type,
    supportedFileTypes: getSupportedFileTypesForResolver(type),
  }));

  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({ resolvers: types }, null, 2),
    }],
  };
});

server.registerTool('files_by_resolver', {
  description: 'List workspace files for the selected resolver type.',
  inputSchema: filesByResolverShape,
}, async (args: Record<string, unknown> = {}, _extra: unknown) => {
  const parsed = filesByResolverSchema.parse(args ?? {});
  const root = parsed.project ?? parsed.root ?? workspaceRoot;
  const resolver = normalizeResolverType(parsed.resolver);
  const files = listFilesForResolver(root, resolver);
  const included = filterIncludedFiles(files, parsed.include);

  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({ root, resolver, total: included.length, files: included }, null, 2),
    }],
  };
});

server.registerTool('entrypoint_files_by_resolver', {
  description: 'List the project entry point files for the selected resolver type (for example, .sln/.csproj, tsconfig.json, pyproject.toml).',
  inputSchema: entrypointFilesByResolverShape,
}, async (args: Record<string, unknown> = {}, _extra: unknown) => {
  const parsed = entrypointFilesByResolverSchema.parse(args ?? {});
  const root = parsed.project ?? parsed.root ?? workspaceRoot;
  const resolver = normalizeResolverType(parsed.resolver);
  const entrypoints = listEntrypointFilesForSemanticBridge(root, resolver);
  const included = filterIncludedFiles(entrypoints, parsed.include);

  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({ root, resolver, total: included.length, entrypoints: included }, null, 2),
    }],
  };
});

server.registerTool('resolve_semantic_edges', {
  description: 'Resolve a dependency or call graph for the selected resolver type.',
  inputSchema: resolveSemanticEdgesShape,
}, async (args: Record<string, unknown> = {}, _extra: unknown) => {
  const parsed = resolveSemanticEdgesSchema.parse(args ?? {});
  const root = parsed.root || workspaceRoot;
  const resolver = normalizeResolverType(parsed.resolver);
  const allLinks = await resolveSemanticEdgesForResolver(root, resolver);
  const limited = typeof parsed.maxEdges === 'number' ? allLinks.slice(0, parsed.maxEdges) : allLinks;

  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({ root, resolver, totalEdges: allLinks.length, edges: limited }, null, 2),
    }],
  };
});

async function main(): Promise<void> {
  const transport = new StdioServerTransport();
  await server.connect(transport);
  console.error(`[semantic-bridge] ready for ${workspaceRoot}`);
}

main().catch((error) => {
  console.error('[semantic-bridge] failed to start:', error);
  process.exit(1);
});
