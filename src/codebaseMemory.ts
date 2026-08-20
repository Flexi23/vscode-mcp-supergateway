import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { SemanticDependencyResolver } from './services/semanticDependencyResolver';

export type IndexJobStatus = 'indexing' | 'enriching' | 'success' | 'error';

export interface IndexJobState {
  status: IndexJobStatus;
  message?: string;
  progress?: number;
  updatedAt: number;
}

const indexJobs = new Map<string, IndexJobState>();

export function getIndexJobsSnapshot(): Record<string, IndexJobState> {
  return Object.fromEntries(indexJobs.entries());
}

export function configureCodebaseMemoryUi(cacheDir: string, port: number, defaultPath: string = '/workspace') {
  const configPath = path.join(cacheDir, 'config.json');
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    // no existing config yet
  }

  const nextConfig = {
    ...existing,
    ui_enabled: true,
    ui_port: port,
    default_path: defaultPath,
    selected_path: defaultPath,
    defaultPath,
    workspace_path: defaultPath,
    root_path: defaultPath,
    project_root: defaultPath,
  };

  fs.writeFileSync(configPath, JSON.stringify(nextConfig, null, 2));
}

export function discoverProjectRoots(workspaceRoot: string): string[] {
  if (!fs.existsSync(workspaceRoot)) {
    return [];
  }

  const entries = fs.readdirSync(workspaceRoot, { withFileTypes: true });
  const roots = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(workspaceRoot, entry.name))
    .filter((candidate) => {
      const gitDir = path.join(candidate, '.git');
      const agentFile = path.join(candidate, 'AGENT.md');
      const readmeFile = path.join(candidate, 'README.md');
      const packageJson = path.join(candidate, 'package.json');
      return fs.existsSync(gitDir) || fs.existsSync(agentFile) || fs.existsSync(readmeFile) || fs.existsSync(packageJson);
    })
    .sort();

  return roots.length > 0 ? roots : [workspaceRoot];
}

export function autoIndexCodebaseMemory(cacheDir: string, workspaceRoot: string) {
  if (!fs.existsSync(workspaceRoot)) {
    console.warn(`[codebase-memory] auto-index skipped, path not found: ${workspaceRoot}`);
    return;
  }

  const repoPaths = discoverProjectRoots(workspaceRoot);
  console.log(`[codebase-memory] auto-indexing ${repoPaths.length} project root(s) under ${workspaceRoot}...`);

  repoPaths.forEach((repoPath) => {
    indexRepository(cacheDir, repoPath);
  });
}

export function indexRepository(cacheDir: string, repoPath: string): Promise<void> {
  const projectName = path.basename(repoPath) || 'workspace';
  indexJobs.set(repoPath, { status: 'indexing', updatedAt: Date.now() });

  return new Promise((resolve) => {
    const child = spawn(
      'npx',
      ['-y', 'codebase-memory-mcp', 'cli', 'index_repository', '--repo-path', repoPath, '--name', projectName, '--mode', 'moderate'],
      { env: { ...process.env, CBM_CACHE_DIR: cacheDir }, stdio: 'inherit' },
    );

    child.on('exit', async (code) => {
      if (code === 0) {
        console.log(`[codebase-memory] index completed for ${repoPath}`);
        try {
          await enrichRepositorySemanticEdges(cacheDir, repoPath);
        } catch (error) {
          console.warn(`[codebase-memory] C# edge enrichment failed for ${repoPath}:`, error);
          indexJobs.set(repoPath, { status: 'success', message: 'indexed (edge enrichment failed)', updatedAt: Date.now() });
        }
        resolve();
        return;
      }

      console.warn(`[codebase-memory] index exited for ${repoPath} with code ${code}`);
      indexJobs.set(repoPath, { status: 'error', message: `exit code ${code}`, updatedAt: Date.now() });
      resolve();
    });
  });
}

export async function enrichRepositorySemanticEdges(cacheDir: string, repoPath: string): Promise<void> {
  const projectName = path.basename(repoPath) || 'workspace';
  indexJobs.set(repoPath, { status: 'enriching', message: `transferring semantic edges for ${projectName}`, updatedAt: Date.now() });

  try {
    await enrichCodebaseMemoryWithSemanticEdges(cacheDir, repoPath);
    indexJobs.set(repoPath, { status: 'success', message: 'semantic edges transferred', updatedAt: Date.now() });
  } catch (error) {
    indexJobs.set(repoPath, {
      status: 'error',
      message: error instanceof Error ? error.message : 'semantic edge transfer failed',
      updatedAt: Date.now(),
    });
    throw error;
  }
}

async function enrichCodebaseMemoryWithSemanticEdges(cacheDir: string, repoPath: string) {
  const extractor = new SemanticDependencyResolver(repoPath);
  const files = extractor.collectSemanticFiles(repoPath);

  if (files.length === 0) {
    console.log('[codebase-memory] no semantic source files found for edge enrichment');
    return;
  }

  console.log(`[codebase-memory] starting semantic edge enrichment for ${path.basename(repoPath)} (${files.length} files)...`);

  const graphLinks = await extractor.extractEdges(files, (message: string, percent: number) => {
    const progress = Math.min(100, Math.max(0, Math.round(percent)));
    indexJobs.set(repoPath, {
      status: 'enriching',
      message,
      progress,
      updatedAt: Date.now(),
    });
    console.log(`[codebase-memory] ${message} [${progress}%]`);
  });

  if (graphLinks.length === 0) {
    indexJobs.set(repoPath, {
      status: 'success',
      message: 'semantic resolution finished with no graph links',
      progress: 100,
      updatedAt: Date.now(),
    });
    console.log('[codebase-memory] no semantic graph links produced');
    return;
  }

  const projectName = path.basename(repoPath) || 'workspace';
  const linksFile = path.join(cacheDir, 'semantic-edges.json');
  extractor.writeLinksFile(graphLinks, linksFile);

  console.log(`[codebase-memory] ingesting ${graphLinks.length} semantic graph links into project ${projectName}...`);
  const child = spawn(
    'npx',
    ['-y', 'codebase-memory-mcp', 'cli', 'ingest_traces', '--project', projectName, '--traces', JSON.stringify(graphLinks)],
    { env: { ...process.env, CBM_CACHE_DIR: cacheDir }, stdio: 'inherit' },
  );

  child.on('exit', (exitCode) => {
    if (exitCode === 0) {
      console.log(`[codebase-memory] injected ${graphLinks.length} semantic graph links into project ${projectName}`);
      return;
    }
    console.warn(`[codebase-memory] ingest_traces exited with code ${exitCode}`);
  });
}

export { indexJobs };
