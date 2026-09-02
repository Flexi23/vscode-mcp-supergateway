import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { SemanticEdgeResolutionStrategyDispatcher, TypeScriptDependencyResolver } from './services/semanticEdgeResolutionStrategyDispatcher';
import { PythonCallChainResolver } from './services/pythonCallChainResolver';
import { requireEnv } from './config/env';

const workspaceRoot = '/workspace';

const listFilesSchema = z.object({
  root: z.string().optional().describe('Directory to scan for C# files. Defaults to /workspace.'),
  include: z.array(z.string()).optional().describe('Optional list of directory prefixes to include.'),
});

const dependencyGraphSchema = z.object({
  root: z.string().optional().describe('Directory to scan for C# files. Defaults to /workspace.'),
  maxEdges: z.number().int().positive().max(5000).optional().describe('Maximum number of edges to return.'),
});

const typescriptListFilesSchema = z.object({
  root: z.string().optional().describe('Directory to scan for TypeScript/JavaScript files. Defaults to /workspace.'),
  include: z.array(z.string()).optional().describe('Optional list of directory prefixes to include.'),
});

const typescriptDependencyGraphSchema = z.object({
  root: z.string().optional().describe('Directory to scan for TypeScript/JavaScript files. Defaults to /workspace.'),
  maxEdges: z.number().int().positive().max(5000).optional().describe('Maximum number of edges to return.'),
});

const pythonListFilesSchema = z.object({
  root: z.string().optional().describe('Directory to scan for Python files. Defaults to /workspace.'),
  include: z.array(z.string()).optional().describe('Optional list of directory prefixes to include.'),
});

const pythonCallChainSchema = z.object({
  root: z.string().optional().describe('Directory to scan for Python files. Defaults to /workspace.'),
  maxEdges: z.number().int().positive().max(5000).optional().describe('Maximum number of edges to return.'),
});

const listFilesShape = listFilesSchema.shape as any;
const dependencyGraphShape = dependencyGraphSchema.shape as any;
const typescriptListFilesShape = typescriptListFilesSchema.shape as any;
const typescriptDependencyGraphShape = typescriptDependencyGraphSchema.shape as any;
const pythonListFilesShape = pythonListFilesSchema.shape as any;
const pythonCallChainShape = pythonCallChainSchema.shape as any;

const server = new McpServer(
  {
    name: 'semantic-bridge-mcp',
    version: '0.1.0',
  },
  {
    capabilities: {},
  },
);

server.registerTool('csharp_list_workspace_files', {
  description: 'List all semantic source files under the configured workspace root.',
  inputSchema: listFilesShape,
}, async (args: Record<string, unknown> = {}, _extra: unknown) => {
  const parsed = listFilesSchema.parse(args ?? {});
  const root = parsed.root || workspaceRoot;
  const extractor = new SemanticEdgeResolutionStrategyDispatcher(root);
  const files = extractor.collectSemanticFiles(root);
  const included = parsed.include && parsed.include.length > 0
    ? files.filter((file: { fsPath: string }) => parsed.include!.some((prefix: string) => file.fsPath.includes(prefix)))
    : files;

  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({ root, total: included.length, files: included.map((file: { fsPath: string }) => file.fsPath) }, null, 2),
    }],
  };
});

server.registerTool('csharp_extract_dependency_graph', {
  description: 'Extract a semantic dependency graph from the workspace and return the graph links as JSON.',
  inputSchema: dependencyGraphShape,
}, async (args: Record<string, unknown> = {}, _extra: unknown) => {
  const parsed = dependencyGraphSchema.parse(args ?? {});
  const root = parsed.root || workspaceRoot;
  const extractor = new SemanticEdgeResolutionStrategyDispatcher(root);
  const allLinks = await extractor.extractEdgesFromFilesystem(root);
  const limited = typeof parsed.maxEdges === 'number' ? allLinks.slice(0, parsed.maxEdges) : allLinks;

  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({ root, totalEdges: allLinks.length, edges: limited }, null, 2),
    }],
  };
});

server.registerTool('typescript_list_workspace_files', {
  description: 'List TypeScript and JavaScript source files in the configured workspace root.',
  inputSchema: typescriptListFilesShape,
}, async (args: Record<string, unknown> = {}, _extra: unknown) => {
  const parsed = typescriptListFilesSchema.parse(args ?? {});
  const root = parsed.root || workspaceRoot;
  const extractor = new TypeScriptDependencyResolver();
  const files = extractor.collectTypeScriptFiles(root);
  const included = parsed.include && parsed.include.length > 0
    ? files.filter((file: { fsPath: string }) => parsed.include!.some((prefix: string) => file.fsPath.includes(prefix)))
    : files;

  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({ root, total: included.length, files: included.map((file: { fsPath: string }) => file.fsPath) }, null, 2),
    }],
  };
});

server.registerTool('typescript_extract_dependency_graph', {
  description: 'Extract a TypeScript/JavaScript import dependency graph from the workspace and return the graph links as JSON.',
  inputSchema: typescriptDependencyGraphShape,
}, async (args: Record<string, unknown> = {}, _extra: unknown) => {
  const parsed = typescriptDependencyGraphSchema.parse(args ?? {});
  const root = parsed.root || workspaceRoot;
  const extractor = new TypeScriptDependencyResolver();
  const allLinks = await extractor.extractTypeScriptEdgesFromFilesystem(root);
  const limited = typeof parsed.maxEdges === 'number' ? allLinks.slice(0, parsed.maxEdges) : allLinks;

  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({ root, totalEdges: allLinks.length, edges: limited }, null, 2),
    }],
  };
});

server.registerTool('python_list_workspace_files', {
  description: 'List Python source files in the configured workspace root.',
  inputSchema: pythonListFilesShape,
}, async (args: Record<string, unknown> = {}, _extra: unknown) => {
  const parsed = pythonListFilesSchema.parse(args ?? {});
  const root = parsed.root || workspaceRoot;
  const extractor = new PythonCallChainResolver();
  const files = extractor.collectPythonFiles(root);
  const included = parsed.include && parsed.include.length > 0
    ? files.filter((file: string) => parsed.include!.some((prefix: string) => file.includes(prefix)))
    : files;

  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({ root, total: included.length, files: included }, null, 2),
    }],
  };
});

server.registerTool('python_extract_call_chain_graph', {
  description: 'Resolve Python call chains via the stdlib ast module and return the resulting file-level call graph as JSON.',
  inputSchema: pythonCallChainShape,
}, async (args: Record<string, unknown> = {}, _extra: unknown) => {
  const parsed = pythonCallChainSchema.parse(args ?? {});
  const root = parsed.root || workspaceRoot;
  const extractor = new PythonCallChainResolver();
  const allLinks = await extractor.extractCallChainEdges(root);
  const limited = typeof parsed.maxEdges === 'number' ? allLinks.slice(0, parsed.maxEdges) : allLinks;

  return {
    content: [{
      type: 'text' as const,
      text: JSON.stringify({ root, totalEdges: allLinks.length, edges: limited }, null, 2),
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
