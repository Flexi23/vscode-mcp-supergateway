import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { listEntrypointFilesForResolver, ResolverStrategyType } from './resolverStrategy';

export const DEFAULT_DOTNET_ROOT = '/usr/share/dotnet';

export interface DotNetRoslynRunner {
  projectDir: string;
  projectFile: string;
  programFile: string;
  dotnetExecutable: string;
  entryPointFile: string;
}

export function listDotNetEntrypointFiles(rootDir: string): string[] {
  return listEntrypointFilesForResolver(rootDir, ResolverStrategyType.DotNet, resolveRuntimeWorkspaceRoot(rootDir));
}

export function createDotNetRoslynRunner(rootDir: string, explicitEntryPointFile?: string): DotNetRoslynRunner {
  const runtimeRoot = resolveRuntimeWorkspaceRoot(rootDir);
  const candidateEntrypoints = explicitEntryPointFile && fs.existsSync(explicitEntryPointFile)
    ? [explicitEntryPointFile]
    : listDotNetEntrypointFiles(runtimeRoot || rootDir);

  const entryPointFile = candidateEntrypoints[0] ?? path.join(runtimeRoot || rootDir || '/workspace', 'DotNetDependencyResolver.csproj');
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dotnet-dependency-resolver-'));
  const projectDir = path.join(tempRoot, 'resolver');
  fs.mkdirSync(projectDir, { recursive: true });

  const projectFile = path.join(projectDir, `${sanitizeProjectName(entryPointFile)}.Resolver.csproj`);
  const programFile = path.join(projectDir, 'Program.cs');
  const dotnetExecutable = resolveDotNetExecutable();

  console.info(`[DotNet] initializing Roslyn runner for ${path.relative(runtimeRoot || rootDir || '/workspace', entryPointFile) || path.basename(entryPointFile)}; runtimeRoot=${runtimeRoot || rootDir || '/workspace'}; dotnet=${dotnetExecutable}; project=${projectFile}`);

  fs.writeFileSync(projectFile, readRoslynProjectFile(), 'utf8');
  fs.writeFileSync(programFile, readRoslynProgramSource(), 'utf8');
  console.info(`[DotNet] Roslyn runner ready; project=${path.basename(projectFile)}; program=${path.basename(programFile)}; entrypoint=${path.relative(runtimeRoot || rootDir || '/workspace', entryPointFile) || path.basename(entryPointFile)}`);

  return { projectDir, projectFile, programFile, dotnetExecutable, entryPointFile };
}

function resolveRuntimeWorkspaceRoot(rootDir: string | undefined): string | undefined {
  const candidate = (rootDir ?? '').trim();
  if (!candidate) {
    const fallback = process.env.WORKSPACE_ROOT || '/workspace';
    return fs.existsSync(fallback) ? fallback : undefined;
  }

  if (fs.existsSync(candidate)) {
    return candidate;
  }

  if (/^[A-Za-z]:[\\/]/.test(candidate)) {
    const fallback = process.env.WORKSPACE_ROOT || '/workspace';
    return fs.existsSync(fallback) ? fallback : undefined;
  }

  if (process.env.WORKSPACE_ROOT && fs.existsSync(process.env.WORKSPACE_ROOT)) {
    return process.env.WORKSPACE_ROOT;
  }

  return candidate;
}

function readRoslynProgramSource(): string {
  const candidatePaths = [
    path.join(__dirname, 'dotnetRoslynProgramSource.cs'),
    path.join(process.cwd(), 'src', 'services', 'dotnetRoslynProgramSource.cs'),
  ];

  for (const candidate of candidatePaths) {
    if (fs.existsSync(candidate)) {
      return fs.readFileSync(candidate, 'utf8');
    }
  }

  throw new Error('Roslyn program source file is missing. Expected dotnetRoslynProgramSource.cs in the runtime or source tree.');
}

function readRoslynProjectFile(): string {
  const candidatePaths = [
    path.join(__dirname, 'dotnetRoslynProject.csproj'),
    path.join(process.cwd(), 'src', 'services', 'dotnetRoslynProject.csproj'),
    path.join(process.cwd(), 'dist', 'services', 'dotnetRoslynProject.csproj'),
  ];

  for (const candidate of candidatePaths) {
    if (fs.existsSync(candidate)) {
      return fs.readFileSync(candidate, 'utf8');
    }
  }

  throw new Error('Roslyn project file is missing. Expected dotnetRoslynProject.csproj in the runtime or source tree.');
}

function sanitizeProjectName(entryPointFile: string): string {
  const basename = path.basename(entryPointFile, path.extname(entryPointFile)) || 'DotNetDependencyResolver';
  return basename
    .replace(/[^A-Za-z0-9_.-]+/g, '-')
    .replace(/-+/g, '-')
    || 'DotNetDependencyResolver';
}

export function resolveDotNetExecutable(): string {
  const executableName = 'dotnet';
  const searchRoots = [
    process.env.DOTNET_ROOT,
    DEFAULT_DOTNET_ROOT,
    '/usr/local/share/dotnet',
    path.join(os.homedir(), '.dotnet'),
    ...((process.env.PATH ?? '')
      .split(path.delimiter)
      .map((value) => value.trim())
      .filter(Boolean)),
  ];

  const buildCandidate = (root: string): string => {
    const normalized = root.replace(/\\/g, '/').replace(/\/+$/, '');
    if (normalized.startsWith('/')) {
      return `${normalized}/${executableName}`;
    }
    return path.join(root, executableName);
  };

  for (const root of searchRoots) {
    if (!root) {
      continue;
    }

    const candidate = buildCandidate(root);
    if (fs.existsSync(candidate)) {
      return candidate;
    }
  }

  const lookup = spawnSync(executableName, ['--version'], {
    encoding: 'utf8',
    env: process.env,
    shell: false,
  });

  if (lookup.status === 0) {
    return executableName;
  }

  return `${DEFAULT_DOTNET_ROOT.replace(/\\/g, '/').replace(/\/+$/, '')}/${executableName}`;
}
