import * as path from 'path';
import type { GraphLink, GraphUri } from './semanticEdgeResolutionStrategyDispatcher';

export enum ResolverStrategyType {
  DotNet = 'dotnet',
  TypeScript = 'typescript',
  Python = 'python',
  Generic = 'generic',
}

export const RESOLVER_TYPE_METADATA: Record<ResolverStrategyType, { label: string; supportedExtensions: readonly string[]; edgeTypes: readonly string[] }> = {
  [ResolverStrategyType.DotNet]: {
    label: 'DotNetDependencyResolver (Roslyn .NET strategy)',
    supportedExtensions: ['.cs', '.razor'],
    edgeTypes: ['file-reference'],
  },
  [ResolverStrategyType.TypeScript]: {
    label: 'TypeScriptDependencyResolver (TypeScript compiler strategy)',
    supportedExtensions: ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mts', '.cts'],
    edgeTypes: ['file-reference'],
  },
  [ResolverStrategyType.Python]: {
    label: 'PythonCallChainResolver (ast-based call chain strategy)',
    supportedExtensions: ['.py'],
    edgeTypes: ['call-chain', 'import-bound-call'],
  },
  [ResolverStrategyType.Generic]: {
    label: 'GenericSemanticFileDependencyResolver (generic file-based strategy)',
    supportedExtensions: ['.cs', '.razor', '.js', '.jsx', '.ts', '.tsx', '.md', '.markdown'],
    edgeTypes: ['file-reference'],
  },
};

export function normalizeResolverType(type?: string | ResolverStrategyType): ResolverStrategyType {
  const rawValue = (type ?? ResolverStrategyType.Generic).toString().trim().toLowerCase();
  if (Object.values(ResolverStrategyType).includes(rawValue as ResolverStrategyType)) {
    return rawValue as ResolverStrategyType;
  }

  throw new Error(`Unsupported resolver type: ${type}. Supported values: ${listResolverTypes().join(', ')}`);
}

export function listResolverTypes(): ResolverStrategyType[] {
  return Object.values(ResolverStrategyType);
}

export function getSupportedFileTypesForResolver(type?: string | ResolverStrategyType): string[] {
  const normalized = normalizeResolverType(type);
  return [...RESOLVER_TYPE_METADATA[normalized].supportedExtensions];
}

export function getEdgeTypesForResolver(type?: string | ResolverStrategyType): string[] {
  const normalized = normalizeResolverType(type);
  return [...RESOLVER_TYPE_METADATA[normalized].edgeTypes];
}

export abstract class ResolverStrategy {
  abstract readonly type: ResolverStrategyType;
  abstract readonly label: string;

  protected abstract readonly supportedExtensions: readonly string[];
  protected rootDir: string = process.cwd();

  public supports(filePath: string): boolean {
    const extension = path.extname(filePath).toLowerCase();
    return this.supportedExtensions.includes(extension);
  }

  public setRootDir(rootDir: string): this {
    this.rootDir = rootDir || process.cwd();
    return this;
  }

  protected normalizeFilePaths(files: ReadonlyArray<GraphUri | string> | undefined): string[] {
    return (files ?? []).map((file) => (typeof file === 'string' ? file : file.fsPath));
  }

  protected toGraphPath(filePath: string, rootDir: string = this.rootDir): string {
    if (rootDir) {
      const relative = path.relative(rootDir, filePath).replace(/\\/g, '/');
      if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
        return relative;
      }
    }

    return path.basename(filePath);
  }

  public abstract resolveFile(filePath: string): Promise<GraphLink[]>;
}
