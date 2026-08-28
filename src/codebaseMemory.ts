import * as childProcess from 'child_process';
import fs from 'fs';
import path from 'path';
import { SemanticEdgeResolutionStrategyDispatcher } from './services/semanticEdgeResolutionStrategyDispatcher';

export type IndexJobStatus = 'indexing' | 'enriching' | 'success' | 'error' | 'idle' | 'unchecked';

export interface IndexJobState {
  status: IndexJobStatus;
  message?: string;
  progress?: number;
  updatedAt: number;
}

const indexJobs = new Map<string, IndexJobState>();
type IndexJobUpdateListener = (repoPath: string, job: IndexJobState) => void;
let indexJobUpdateListener: IndexJobUpdateListener | null = null;

export function getPersistedProjectIndexStates(cacheDir: string): Record<string, IndexJobState> {
  const records = listCodebaseMemoryProjects(cacheDir);
  const persistedStates: Record<string, IndexJobState> = {};

  for (const record of records) {
    const projectRoot = String(record.root_path || record.path || '').trim();
    if (!projectRoot) {
      continue;
    }

    const status = normalizePersistedProjectStatus(record.status);
    persistedStates[projectRoot] = {
      status,
      message: status === 'success' ? `indexed (${record.name || path.basename(projectRoot)})` : `pending (${record.name || path.basename(projectRoot)})`,
      updatedAt: Date.now(),
    };
  }

  return persistedStates;
}

export function getIndexJobsSnapshot(cacheDir?: string): Record<string, IndexJobState> {
  const jobs = Object.fromEntries(indexJobs.entries());
  if (!cacheDir) {
    return jobs;
  }

  return {
    ...getPersistedProjectIndexStates(cacheDir),
    ...jobs,
  };
}

export interface CodebaseMemoryProjectRecord {
  name?: string;
  project?: string;
  path?: string;
  root_path?: string;
  status?: string;
}

export interface WorkspaceProjectRow extends CodebaseMemoryProjectRecord {
  indexed: boolean;
}

function normalizePersistedProjectStatus(status?: unknown): IndexJobStatus {
  const normalized = String(status ?? '').trim().toLowerCase();
  if (normalized === 'indexing') return 'indexing';
  if (normalized === 'enriching') return 'enriching';
  if (normalized === 'success' || normalized === 'indexed' || normalized === 'ready') return 'success';
  if (normalized === 'error') return 'error';
  if (normalized === 'unchecked') return 'unchecked';
  if (normalized === 'idle') return 'idle';
  return 'unchecked';
}

function isIndexedProjectStatus(status?: string | null): boolean {
  const normalized = String(status ?? '').trim().toLowerCase();
  return normalized === 'success' || normalized === 'indexed' || normalized === 'ready';
}

function normalizeProjectRecord(project: Record<string, unknown>): CodebaseMemoryProjectRecord | null {
  const rawName = typeof project.name === 'string' ? project.name : typeof project.project === 'string' ? project.project : undefined;
  const rawPath = typeof project.root_path === 'string' ? project.root_path : typeof project.path === 'string' ? project.path : undefined;
  const fallbackName = rawPath ? path.basename(rawPath) : 'project';

  if (!rawPath && !rawName) {
    return null;
  }

  return {
    name: rawName ?? fallbackName,
    project: rawName ?? fallbackName,
    path: rawPath ?? rawName ?? fallbackName,
    root_path: rawPath ?? rawName ?? fallbackName,
    status: typeof project.status === 'string' ? project.status : 'unchecked',
  };
}

export function getPersistedProjectRecords(cacheDir: string): CodebaseMemoryProjectRecord[] {
  return listCodebaseMemoryProjects(cacheDir);
}

export function listCodebaseMemoryProjects(cacheDir?: string): CodebaseMemoryProjectRecord[] {
  if (!cacheDir) {
    return [];
  }

  const envOverride = process.env.CBM_LIST_PROJECTS_FIXTURE;
  if (envOverride) {
    try {
      const payload = JSON.parse(envOverride) as Record<string, unknown>;
      const entries = Array.isArray(payload?.projects) ? payload.projects : Array.isArray(payload) ? payload : [];
      const normalized = (entries as Array<Record<string, unknown>>)
        .map((entry: Record<string, unknown>) => normalizeProjectRecord(entry ?? {}))
        .filter((entry): entry is CodebaseMemoryProjectRecord => !!entry);

      if (normalized.length > 0) {
        return normalized.sort((left, right) => (left.name ?? '').localeCompare(right.name ?? ''));
      }
    } catch {
      // fall through to live CBM CLI lookup below
    }
  }

  try {
    const result = childProcess.spawnSync(
      'npx',
      ['-y', 'codebase-memory-mcp', 'cli', 'list_projects', '--json', '{}'],
      { env: { ...process.env, CBM_CACHE_DIR: cacheDir }, encoding: 'utf8' },
    );

    if (result.status === 0 && result.stdout.trim()) {
      const payload = JSON.parse(result.stdout) as Record<string, unknown>;
      const entries = Array.isArray(payload?.projects) ? payload.projects : Array.isArray(payload) ? payload : [];
      const normalized = (entries as Array<Record<string, unknown>>)
        .map((entry: Record<string, unknown>) => normalizeProjectRecord(entry ?? {}))
        .filter((entry): entry is CodebaseMemoryProjectRecord => !!entry);

      if (normalized.length > 0) {
        return normalized.sort((left, right) => (left.name ?? '').localeCompare(right.name ?? ''));
      }
    }
  } catch {
    // fall back to empty list — the runtime list must come from the CBM CLI, not from the SQLite cache.
  }

  return [];
}

function normalizeWorkspaceProjectPath(candidatePath: string, workspaceRoot?: string): string {
  const raw = String(candidatePath ?? '').trim();
  if (!raw) {
    return '';
  }

  const normalizedCandidate = raw.replace(/\\/g, '/');
  const normalizedWorkspaceRoot = String(workspaceRoot ?? '').trim().replace(/\\/g, '/');

  if (normalizedCandidate.startsWith('/workspace')) {
    const suffix = normalizedCandidate === '/workspace' ? '' : normalizedCandidate.slice('/workspace'.length);
    if (normalizedWorkspaceRoot && normalizedWorkspaceRoot !== '/workspace') {
      return path.resolve(path.join(normalizedWorkspaceRoot, suffix.replace(/^\/+/, '')));
    }
  }

  if (normalizedWorkspaceRoot && normalizedWorkspaceRoot !== '/workspace' && normalizedCandidate.startsWith(normalizedWorkspaceRoot)) {
    return path.resolve(normalizedCandidate);
  }

  return path.resolve(raw);
}

export function mergeWorkspaceProjectRows(workspaceRoot: string, cacheDir?: string): WorkspaceProjectRow[] {
  const resolvedRoot = resolveRuntimeWorkspaceRoot(workspaceRoot, '/workspace');
  const discoveredRoots = discoverProjectRoots(resolvedRoot);
  const persisted = cacheDir ? getPersistedProjectIndexStates(cacheDir) : {};
  const persistedRecords = cacheDir ? getPersistedProjectRecords(cacheDir) : [];
  const merged = new Map<string, WorkspaceProjectRow>();

  for (const rootPath of discoveredRoots) {
    const resolvedProjectRoot = normalizeWorkspaceProjectPath(rootPath, resolvedRoot);
    const persistedStatus = persisted[normalizeWorkspaceProjectPath(rootPath, resolvedRoot)]?.status ?? persisted[normalizeWorkspaceProjectPath(rootPath, '/workspace')]?.status;
    const rowStatus = persistedStatus ?? 'unchecked';
    const row: WorkspaceProjectRow = {
      name: path.basename(resolvedProjectRoot) || 'project',
      project: path.basename(resolvedProjectRoot) || 'project',
      path: resolvedProjectRoot,
      root_path: resolvedProjectRoot,
      status: rowStatus,
      indexed: isIndexedProjectStatus(rowStatus),
    };
    merged.set(resolvedProjectRoot, row);
  }

  for (const record of persistedRecords) {
    const candidateRoot = String(record.root_path || record.path || '').trim();
    if (!candidateRoot) {
      continue;
    }

    const resolvedCandidate = normalizeWorkspaceProjectPath(candidateRoot, resolvedRoot);
    const existing = merged.get(resolvedCandidate);
    const status = normalizePersistedProjectStatus(record.status);

    if (existing) {
      const nextStatus = status || existing.status || 'unchecked';
      const updatedRow: WorkspaceProjectRow = {
        ...existing,
        name: record.name || existing.name || path.basename(resolvedCandidate) || 'project',
        project: record.project || existing.project || path.basename(resolvedCandidate) || 'project',
        path: resolvedCandidate,
        root_path: resolvedCandidate,
        status: nextStatus,
        indexed: isIndexedProjectStatus(nextStatus),
      };
      merged.set(resolvedCandidate, updatedRow);
      continue;
    }

    merged.set(resolvedCandidate, {
      name: record.name || path.basename(resolvedCandidate) || 'project',
      project: record.project || path.basename(resolvedCandidate) || 'project',
      path: resolvedCandidate,
      root_path: resolvedCandidate,
      status,
      indexed: isIndexedProjectStatus(status),
    });
  }

  return Array.from(merged.values()).sort((left, right) => (left.name || '').localeCompare(right.name || ''));
}

export function clearIndexJobs(): void {
  indexJobs.clear();
}

export function setIndexJobUpdateListener(listener: IndexJobUpdateListener | null): IndexJobUpdateListener | null {
  const previous = indexJobUpdateListener;
  indexJobUpdateListener = listener;
  return previous;
}

export function updateIndexJobState(repoPath: string, job: IndexJobState): IndexJobState {
  indexJobs.set(repoPath, job);
  indexJobUpdateListener?.(repoPath, job);
  return job;
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

export function resolveRuntimeWorkspaceRoot(workspaceRoot: string, fallbackRoot: string = '/workspace'): string {
  const trimmed = (workspaceRoot ?? '').trim();
  if (!trimmed) {
    return fallbackRoot;
  }

  const isWindowsHostPath = /^[A-Za-z]:[\\/]/.test(trimmed);
  if (isWindowsHostPath && fs.existsSync(fallbackRoot)) {
    return fallbackRoot;
  }

  if (!fs.existsSync(trimmed) && fs.existsSync(fallbackRoot)) {
    return fallbackRoot;
  }

  return trimmed;
}

export function discoverProjectRoots(workspaceRoot: string): string[] {
  const resolvedRoot = resolveRuntimeWorkspaceRoot(workspaceRoot, '/workspace');
  if (!fs.existsSync(resolvedRoot)) {
    return [];
  }

  const excludedNames = new Set([
    '.git',
    '.github',
    '.vscode',
    '.idea',
    'bin',
    'obj',
    'node_modules',
    'dist',
    'build',
    'out',
    'logs',
    'tmp',
    'cache',
    'postgres_data',
    'pgdata',
    'supergateway-data',
    'supergateway-cbm-cache',
    'supergateway-cbm-data',
    'supergateway-siyuan-note',
  ]);

  const entries = fs.readdirSync(resolvedRoot, { withFileTypes: true });
  const roots = entries
    .filter((entry) => entry.isDirectory())
    .map((entry) => path.join(resolvedRoot, entry.name))
    .filter((candidate) => {
      const name = path.basename(candidate);
      return !name.startsWith('.') && !excludedNames.has(name);
    })
    .sort();

  return roots.length > 0 ? roots : [resolvedRoot];
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

export function startCodebaseMemoryUi(cacheDir: string, port: number, defaultPath: string = '/workspace') {
  const env = {
    ...process.env,
    CBM_CACHE_DIR: cacheDir,
    CBM_DEFAULT_PATH: defaultPath,
  };

  console.log(`[codebase-memory] starting graph UI on port ${port}`);
  const child = childProcess.spawn(
    'npx',
    ['-y', 'codebase-memory-mcp', '--ui=true', `--port=${port}`],
    { env, stdio: ['ignore', 'pipe', 'pipe'] },
  );

  if (child.stdout) {
    child.stdout.on('data', (chunk: Buffer | string) => {
      const text = chunk.toString().trim();
      if (text) console.log(`[codebase-memory-ui] ${text}`);
    });
  }

  if (child.stderr) {
    child.stderr.on('data', (chunk: Buffer | string) => {
      const text = chunk.toString().trim();
      if (text) console.warn(`[codebase-memory-ui] ${text}`);
    });
  }

  child.on('exit', (code) => {
    console.warn(`[codebase-memory] graph UI exited with code ${code}`);
  });

  return child;
}

export function indexRepository(cacheDir: string, repoPath: string): Promise<void> {
  const projectName = path.basename(repoPath) || 'workspace';
  updateIndexJobState(repoPath, { status: 'indexing', updatedAt: Date.now() });

  return new Promise((resolve) => {
    const child = childProcess.spawn(
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
          updateIndexJobState(repoPath, { status: 'success', message: 'indexed (edge enrichment failed)', updatedAt: Date.now() });
        }
        resolve();
        return;
      }

      console.warn(`[codebase-memory] index exited for ${repoPath} with code ${code}`);
      updateIndexJobState(repoPath, { status: 'error', message: `exit code ${code}`, updatedAt: Date.now() });
      resolve();
    });
  });
}

export async function enrichRepositorySemanticEdges(cacheDir: string, repoPath: string): Promise<void> {
  const projectName = path.basename(repoPath) || 'workspace';
  updateIndexJobState(repoPath, { status: 'enriching', message: `transferring semantic edges for ${projectName}`, updatedAt: Date.now() });

  try {
    await enrichCodebaseMemoryWithSemanticEdges(cacheDir, repoPath);
    updateIndexJobState(repoPath, { status: 'success', message: 'semantic edges transferred', updatedAt: Date.now() });
  } catch (error) {
    updateIndexJobState(repoPath, {
      status: 'error',
      message: error instanceof Error ? error.message : 'semantic edge transfer failed',
      updatedAt: Date.now(),
    });
    throw error;
  }
}

async function enrichCodebaseMemoryWithSemanticEdges(cacheDir: string, repoPath: string) {
  const extractor = new SemanticEdgeResolutionStrategyDispatcher(repoPath);
  const files = extractor.collectSemanticFiles(repoPath);

  if (files.length === 0) {
    console.log('[codebase-memory] no semantic source files found for edge enrichment');
    return;
  }

  console.log(`[codebase-memory] starting semantic edge enrichment for ${path.basename(repoPath)} (${files.length} files)...`);
  
  const graphLinks = await extractor.extractEdges(files, (message: string, percent: number) => {
    const progress = Math.min(100, Math.max(0, Math.round(percent)));
    updateIndexJobState(repoPath, {
      status: 'enriching',
      message,
      progress,
      updatedAt: Date.now(),
    });
    console.log(`[codebase-memory] ${message} [${progress}%]`);
  });

  if (graphLinks.length === 0) {
    updateIndexJobState(repoPath, {
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
  const child = childProcess.spawn(
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
