import * as fs from 'fs';
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

const ENTRYPOINT_PATTERNS: Record<ResolverStrategyType, readonly string[]> = {
  [ResolverStrategyType.DotNet]: ['.sln', '.csproj', '.fsproj'],
  [ResolverStrategyType.TypeScript]: ['tsconfig.json', 'jsconfig.json', 'package.json'],
  [ResolverStrategyType.Python]: ['pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt', 'Pipfile', 'poetry.lock'],
  [ResolverStrategyType.Generic]: ['.sln', '.csproj', '.fsproj', 'tsconfig.json', 'jsconfig.json', 'package.json', 'pyproject.toml', 'setup.py', 'setup.cfg', 'requirements.txt', 'Pipfile', 'poetry.lock'],
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

export function getResolverTypeNameForLogs(type?: string | ResolverStrategyType): string {
  const normalized = normalizeResolverType(type ?? ResolverStrategyType.Generic);
  switch (normalized) {
    case ResolverStrategyType.DotNet:
      return 'DotNet';
    case ResolverStrategyType.TypeScript:
      return 'TypeScript';
    case ResolverStrategyType.Python:
      return 'Python';
    case ResolverStrategyType.Generic:
    default:
      return 'Generic';
  }
}

export function listEntrypointFilesForResolver(rootDir: string, type?: string | ResolverStrategyType, fallbackRootDir?: string): string[] {
  const normalized = normalizeResolverType(type ?? ResolverStrategyType.Generic);
  const resolvedRoot = resolveResolverRoot(rootDir, fallbackRootDir);
  if (!resolvedRoot || !fs.existsSync(resolvedRoot)) {
    return [];
  }

  const patterns = new Set((ENTRYPOINT_PATTERNS[normalized] ?? []).map((entry) => entry.toLowerCase()));
  if (patterns.size === 0) {
    return [];
  }

  const results: string[] = [];
  const stack = [resolvedRoot];
  const seen = new Set<string>();
  const ignoredNames = new Set(['.git', 'node_modules', 'bin', 'obj', 'dist', '.venv', 'venv', '.next', '.nuget', '__pycache__', '.mypy_cache', '.pytest_cache']);

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
        if (ignoredNames.has(entry.name)) {
          continue;
        }
        stack.push(path.join(current, entry.name));
      }
      continue;
    }

    const fileName = path.basename(current).toLowerCase();
    const extension = path.extname(current).toLowerCase();
    const matchesPattern = Array.from(patterns).some((pattern) => {
      if (pattern.startsWith('.')) {
        return extension === pattern;
      }
      return fileName === pattern || fileName.endsWith(path.basename(pattern).toLowerCase());
    });

    if (matchesPattern) {
      results.push(current);
    }
  }

  return results.sort((left, right) => left.localeCompare(right, undefined, { sensitivity: 'base' }));
}

function resolveResolverRoot(rootDir: string | undefined, fallbackRootDir?: string): string | undefined {
  const candidate = (rootDir ?? '').trim();
  if (!candidate) {
    return fallbackRootDir && fs.existsSync(fallbackRootDir) ? fallbackRootDir : undefined;
  }

  if (fs.existsSync(candidate)) {
    return candidate;
  }

  if (/^[A-Za-z]:[\\/]/.test(candidate)) {
    if (fallbackRootDir && fs.existsSync(fallbackRootDir)) {
      return fallbackRootDir;
    }
    return undefined;
  }

  if (fallbackRootDir && fs.existsSync(fallbackRootDir)) {
    return fallbackRootDir;
  }

  return candidate;
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
