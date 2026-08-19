// Container entrypoint that replaces host-side supergateway.ps1: bundles the
// mcp-gateway process, all four MCP upstreams, and the public forward proxy
// into a single self-contained process (no host npm/pip installs required).
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import http from 'http';
import os from 'os';
import { startBackendServer } from './server';
import { SemanticDependencyResolver } from './services/semanticDependencyResolver';
import { requireEnv, requirePort } from './config/env';

interface UpstreamConfig {
  id: string;
  namespace: string;
  transport: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

interface GatewayConfig {
  upstreams: UpstreamConfig[];
}

const dataDir = requireEnv('GATEWAY_DATA_DIR');
const adminPort = requirePort('MCP_GATEWAY_ADMIN_PORT');
const adminUiPort = requirePort('ADMIN_UI_PORT');
const publicPort = requirePort('MCP_GATEWAY_PUBLIC_PORT');
const cbmUiPort = requirePort('CBM_UI_PORT');
const cbmUiBackendPort = requirePort('CBM_UI_BACKEND_PORT');
const cbmCacheDir = requireEnv('CBM_CACHE_DIR');
const cbmHostWorkspaceDir = requireEnv('CBM_HOST_WORKSPACE_DIR');

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // Some mounts may reject chmod; ignore, the important thing is the exact
    // path stays private and root-owned in the container.
  }
}

function normalizeContainerPath(envName: string, fallback: string): string {
  const rawValue = requireEnv(envName);
  if (/^[A-Za-z]:[\\/]/.test(rawValue)) {
    console.warn(`[config] ${envName} points at a host Windows path (${rawValue}); using ${fallback} inside the container instead so the CBM UI resolves the Linux workspace root correctly.`);
    return fallback;
  }
  return rawValue || fallback;
}

const cbmDefaultPath = normalizeContainerPath('CBM_DEFAULT_PATH', '/workspace');

function resetGatewayPersistentState() {
  const staleFiles = ['gateway.db', 'gateway.db-shm', 'gateway.db-wal', 'admin-gateway-config.json'];
  let removed = 0;

  for (const fileName of staleFiles) {
    const filePath = path.join(dataDir, fileName);
    if (fs.existsSync(filePath)) {
      fs.rmSync(filePath, { force: true, recursive: true });
      removed += 1;
      console.log(`[gateway] removed stale gateway state: ${fileName}`);
    }
  }

  const cbmCachePath = path.join(dataDir, 'cbm-cache');
  if (fs.existsSync(cbmCachePath)) {
    fs.rmSync(cbmCachePath, { force: true, recursive: true });
    removed += 1;
    console.log(`[gateway] removed stale cbm cache: ${cbmCachePath}`);
  }

  if (fs.existsSync(cbmCacheDir)) {
    const runtimeStateFiles = ['config.json', '_config.db', '_config.db-shm', '_config.db-wal'];
    for (const fileName of runtimeStateFiles) {
      const filePath = path.join(cbmCacheDir, fileName);
      if (fs.existsSync(filePath)) {
        fs.rmSync(filePath, { force: true, recursive: true });
        removed += 1;
        console.log(`[gateway] removed stale CBM runtime state: ${filePath}`);
      }
    }

    for (const entry of fs.readdirSync(cbmCacheDir)) {
      if (/^(cbm-|.*\.(sock|lock|anc))$/.test(entry)) {
        const filePath = path.join(cbmCacheDir, entry);
        fs.rmSync(filePath, { force: true, recursive: true });
        removed += 1;
        console.log(`[gateway] removed stale CBM daemon state: ${filePath}`);
      }
    }
  }

  if (removed > 0) {
    console.log(`[gateway] reset persisted gateway state (${removed} item(s)) so the current config is reloaded from scratch.`);
  }
}

function cleanupStaleCodebaseMemoryDaemon() {
  try {
    const tmpRoot = '/tmp';
    if (!fs.existsSync(tmpRoot)) {
      return;
    }

    const entries = fs.readdirSync(tmpRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.name.startsWith('cbm-daemon-')) {
        continue;
      }

      const target = path.join(tmpRoot, entry.name);
      try {
        fs.rmSync(target, { recursive: true, force: true });
        console.log(`[codebase-memory] cleaned stale daemon state at ${target}`);
      } catch (error) {
        console.warn(`[codebase-memory] failed to remove stale daemon state at ${target}:`, error);
      }
    }
  } catch (error) {
    console.warn('[codebase-memory] failed to inspect stale daemon state:', error);
  }
}

function buildAdminConfig(): GatewayConfig {
  const configPath = path.join(__dirname, '..', 'docker', 'gateway.config.json');
  const config: GatewayConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const siYuanTokenRequired = process.env.SIYUAN_TOKEN_REQUIRED === 'true';

  for (const upstream of config.upstreams) {
    if (upstream.id === 'gitlab') {
      const gitlabApiUrl = requireEnv('GITLAB_API_URL');
      const gitlabToken = requireEnv('GITLAB_PERSONAL_ACCESS_TOKEN');
      upstream.env = { ...upstream.env, GITLAB_API_URL: gitlabApiUrl, GITLAB_PERSONAL_ACCESS_TOKEN: gitlabToken };
    }
    if (upstream.id === 'siyuan-note') {
      const siYuanToken = process.env.SIYUAN_TOKEN ?? '';
      upstream.env = {
        ...upstream.env,
        SIYUAN_HOST: 'siyuan',
        SIYUAN_PORT: '6806',
        SIYUAN_TOKEN: siYuanToken,
        SIYUAN_TOKEN_REQUIRED: String(siYuanTokenRequired),
      };
      if (siYuanTokenRequired && (!siYuanToken || ['Supergateway', 'siyuan_api_token_here', 'your-api-token-here'].includes(siYuanToken))) {
        throw new Error('[siyuan-note] SIYUAN_TOKEN_REQUIRED=true but SIYUAN_TOKEN is missing or still a placeholder value. Set the real token in the active .env file and compose environment.');
      }
    }
    if (upstream.id === 'codebase-memory') {
      upstream.env = { ...upstream.env, CBM_CACHE_DIR: cbmCacheDir };
    }
  }

  return config;
}

function buildDashboardHtml(activeTab: string = 'admin') {
  const tabs: Record<string, { label: string; url: string }> = {
    admin: { label: 'MSPStack', url: `http://127.0.0.1:${adminUiPort}/admin` },
    cbm: { label: 'CBM', url: `http://127.0.0.1:${adminUiPort}/cbm/overview` },
    siyuan: { label: 'SiYuan', url: 'http://127.0.0.1:6806/' },
  };

  const safeTab = tabs[activeTab] ? activeTab : 'admin';
  const buttons = Object.entries(tabs)
    .map(([key, value]) => {
      const selected = key === safeTab ? 'selected' : '';
      return `<a class="nav-button ${selected}" href="http://127.0.0.1:${adminUiPort}/?tab=${key}">${value.label}</a>`;
    })
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Supergateway Dashboard</title>
    <style>
      :root {
        color-scheme: light dark;
        --bg: #0f172a;
        --panel: rgba(15, 23, 42, 0.75);
        --panel-alt: rgba(30, 41, 59, 0.95);
        --border: rgba(148, 163, 184, 0.3);
        --text: #e2e8f0;
        --muted: #cbd5e1;
        --accent: #38bdf8;
        --accent-strong: #0ea5e9;
      }
      * { box-sizing: border-box; }
      body {
        margin: 0;
        font-family: "Segoe UI", sans-serif;
        background: linear-gradient(180deg, #020817 0%, #0f172a 100%);
        color: var(--text);
      }
      .topbar {
        position: sticky;
        top: 0;
        z-index: 20;
        display: flex;
        align-items: center;
        gap: 0.75rem;
        padding: 0.9rem 1.25rem;
        background: rgba(15, 23, 42, 0.92);
        border-bottom: 1px solid var(--border);
        backdrop-filter: blur(8px);
      }
      .brand {
        margin-right: 1rem;
        font-weight: 700;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        color: var(--accent);
      }
      .nav-button {
        padding: 0.65rem 1rem;
        border: 1px solid var(--border);
        border-radius: 999px;
        background: rgba(15, 23, 42, 0.8);
        color: var(--text);
        text-decoration: none;
        transition: 0.2s ease;
        font-size: 0.92rem;
      }
      .nav-button:hover { border-color: var(--accent); }
      .nav-button.selected {
        background: linear-gradient(135deg, var(--accent), var(--accent-strong));
        color: #082f49;
        border-color: transparent;
        font-weight: 700;
      }
      .frame-shell {
        height: calc(100vh - 72px);
        padding: 1rem;
      }
      iframe {
        width: 100%;
        height: 100%;
        border: 1px solid var(--border);
        border-radius: 16px;
        background: white;
      }
    </style>
  </head>
  <body>
    <header class="topbar">
      <div class="brand">Supergateway</div>
      ${buttons}
    </header>
    <div class="frame-shell">
      <iframe
        title="hosted ui"
        src="${tabs[safeTab].url}"
        referrerpolicy="no-referrer-when-downgrade"
      ></iframe>
    </div>
  </body>
</html>`;
}

// Project-picker landing page for the CBM dashboard tab: lists the same
// project roots `autoIndexCodebaseMemory` would index, each with a button to
// kick off indexing for just that directory, plus the actual graph UI below.
function buildCbmOverviewHtml(): string {
  const repoPaths = discoverProjectRoots(cbmDefaultPath);
  const jobs = getIndexJobsSnapshot();

  const rows = repoPaths
    .map((repoPath) => {
      const name = path.basename(repoPath) || 'workspace';
      const encodedPath = encodeURIComponent(repoPath);
      const status = jobs[repoPath]?.status ?? 'idle';
      const isIndexed = status === 'success';
      const indexButton = isIndexed ? '' : `<button type="button" class="index-button" data-path="${encodedPath}">Index</button>`;
      const enrichButton = isIndexed
        ? `<button type="button" class="semantic-button" data-path="${encodedPath}">Transfer semantic edges</button>`
        : '';
      const graphLink = isIndexed
        ? `<a class="graph-link" href="http://127.0.0.1:${cbmUiPort}/" target="_blank" rel="noopener noreferrer">Open graph</a>`
        : '';

      return `<tr data-path="${encodedPath}">
        <td>${name}</td>
        <td class="path">${repoPath}</td>
        <td class="status">${status}</td>
        <td class="actions">
          ${indexButton}
          ${enrichButton}
          ${graphLink}
        </td>
      </tr>`;
    })
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>Codebase Memory — Project Overview</title>
    <style>
      body { margin: 0; font-family: "Segoe UI", sans-serif; background: #0f172a; color: #e2e8f0; }
      .panel { padding: 1rem 1.25rem; }
      h1 { font-size: 1.1rem; margin: 0 0 0.75rem; }
      table { width: 100%; border-collapse: collapse; margin-bottom: 1rem; }
      th, td { text-align: left; padding: 0.5rem 0.6rem; border-bottom: 1px solid rgba(148, 163, 184, 0.25); font-size: 0.9rem; }
      td.path { color: #94a3b8; font-family: monospace; }
      td.status { text-transform: capitalize; }
      td.actions { display: flex; gap: 0.5rem; align-items: center; flex-wrap: wrap; }
      button.index-button, button.semantic-button {
        padding: 0.35rem 0.9rem;
        border-radius: 999px;
        border: 1px solid rgba(148, 163, 184, 0.4);
        background: #38bdf8;
        color: #082f49;
        font-weight: 600;
        cursor: pointer;
      }
      button.semantic-button {
        background: #a78bfa;
        color: #1f113d;
      }
      button.index-button:disabled, button.semantic-button:disabled { opacity: 0.5; cursor: default; }
      a.graph-link {
        color: #bae6fd;
        text-decoration: none;
        font-weight: 600;
      }
      a.graph-link:hover { text-decoration: underline; }
      iframe { width: 100%; height: 70vh; border: 1px solid rgba(148, 163, 184, 0.3); border-radius: 12px; background: white; }
    </style>
  </head>
  <body>
    <div class="panel">
      <h1>${cbmHostWorkspaceDir}</h1>
      <table>
        <thead><tr><th>Project</th><th>Path</th><th>Status</th><th>Actions</th></tr></thead>
        <tbody>${rows}</tbody>
      </table>
      <iframe title="codebase memory graph" src="http://127.0.0.1:${cbmUiPort}/?tab=stats"></iframe>
    </div>
    <script>
      async function refreshStatus() {
        const res = await fetch('/cbm/index-status');
        const jobs = await res.json();
        document.querySelectorAll('tr[data-path]').forEach((row) => {
          const path = decodeURIComponent(row.dataset.path || '');
          const job = jobs[path];
          row.querySelector('.status').textContent = job ? job.status : 'idle';
        });
      }
      document.querySelectorAll('.index-button').forEach((button) => {
        button.addEventListener('click', async () => {
          button.disabled = true;
          try {
            await fetch('/cbm/index?path=' + button.dataset.path, { method: 'POST' });
          } finally {
            button.disabled = false;
            refreshStatus();
          }
        });
      });
      document.querySelectorAll('.semantic-button').forEach((button) => {
        button.addEventListener('click', async () => {
          button.disabled = true;
          try {
            await fetch('/cbm/enrich?path=' + button.dataset.path, { method: 'POST' });
          } finally {
            button.disabled = false;
            refreshStatus();
          }
        });
      });
      setInterval(refreshStatus, 2000);
      refreshStatus();
    </script>
  </body>
</html>`;
}

function startForwardProxy(
  port: number,
  targetPort: number,
  options: {
    bindHost?: string;
    rewriteOriginToLoopback?: boolean;
    redirectRootToAdmin?: boolean;
    dashboardEnabled?: boolean;
    stripFrameHeaders?: boolean;
  } = {},
) {
  const {
    bindHost = '0.0.0.0',
    rewriteOriginToLoopback = false,
    redirectRootToAdmin = false,
    dashboardEnabled = true,
    stripFrameHeaders = false,
  } = options;

  const server = http.createServer((req, res) => {
    const requestUrl = new URL(req.url ?? '/', 'http://127.0.0.1');

    if (req.method === 'GET' && req.url === '/ping') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
      return;
    }

    if (req.method === 'GET' && dashboardEnabled && (requestUrl.pathname === '/' || requestUrl.pathname === '/dashboard')) {
      const tab = requestUrl.searchParams.get('tab') ?? 'admin';
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(buildDashboardHtml(tab));
      return;
    }

    if (req.method === 'GET' && dashboardEnabled && requestUrl.pathname === '/cbm/overview') {
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end(buildCbmOverviewHtml());
      return;
    }

    if (req.method === 'GET' && dashboardEnabled && requestUrl.pathname === '/cbm/index-status') {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(getIndexJobsSnapshot()));
      return;
    }

    if (req.method === 'POST' && dashboardEnabled && requestUrl.pathname === '/cbm/index') {
      const requestedPath = requestUrl.searchParams.get('path') ?? '';
      const allowedRoots = discoverProjectRoots(cbmDefaultPath);
      if (!allowedRoots.includes(requestedPath)) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'unknown or disallowed project path' }));
        return;
      }
      indexRepository(cbmCacheDir, requestedPath);
      res.writeHead(202, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'started', path: requestedPath }));
      return;
    }

    if (req.method === 'POST' && dashboardEnabled && requestUrl.pathname === '/cbm/enrich') {
      const requestedPath = requestUrl.searchParams.get('path') ?? '';
      const allowedRoots = discoverProjectRoots(cbmDefaultPath);
      if (!allowedRoots.includes(requestedPath)) {
        res.writeHead(400, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ error: 'unknown or disallowed project path' }));
        return;
      }
      enrichRepositorySemanticEdges(cbmCacheDir, requestedPath);
      res.writeHead(202, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ status: 'started', path: requestedPath }));
      return;
    }

    const headers = { ...req.headers, host: `127.0.0.1:${targetPort}` };
    let targetPath = req.url ?? '/';
    if (redirectRootToAdmin && requestUrl.pathname === '/') {
      targetPath = '/admin';
    }
    if (rewriteOriginToLoopback && requestUrl.pathname === '/api/browse') {
      const requestedPath = requestUrl.searchParams.get('path');
      const isEmptyOrStaleRoot = !requestedPath || requestedPath === '/' || requestedPath === '/root';
      if (isEmptyOrStaleRoot) {
        requestUrl.searchParams.set('path', '/workspace');
        targetPath = `${requestUrl.pathname}?${requestUrl.searchParams.toString()}`;
      }
    }
    // The CBM UI's same-origin check only accepts an Origin/Referer whose host is
    // literally 127.0.0.1 (its own bind address) — it rejects the browser's
    // "localhost" Origin even though it resolves to the same address.
    if (rewriteOriginToLoopback) {
      if (headers.origin) headers.origin = `http://127.0.0.1:${targetPort}`;
      if (headers.referer) headers.referer = `http://127.0.0.1:${targetPort}/`;
    }

    const upstreamRequest = http.request(
      {
        hostname: '127.0.0.1',
        port: targetPort,
        method: req.method,
        path: targetPath,
        headers,
      },
      (upstreamResponse) => {
        const responseHeaders = { ...upstreamResponse.headers };
        // Codebase Memory's own UI ships X-Frame-Options/CSP frame-ancestors that
        // only allow same-origin framing, blocking it from our dashboard iframe
        // (a different origin/port). Strip them on this proxy so embedding works.
        if (stripFrameHeaders) {
          delete responseHeaders['x-frame-options'];
          delete responseHeaders['content-security-policy'];
        }
        res.writeHead(upstreamResponse.statusCode || 502, responseHeaders);
        upstreamResponse.pipe(res);
      },
    );

    upstreamRequest.on('error', (error: Error) => {
      if (!res.headersSent) {
        res.writeHead(502, { 'content-type': 'application/json' });
      }
      res.end(
        JSON.stringify({
          jsonrpc: '2.0',
          error: { code: -32000, message: `Gateway upstream unavailable: ${error.message}` },
          id: null,
        }),
      );
    });

    req.on('aborted', () => upstreamRequest.destroy());
    req.pipe(upstreamRequest);
  });

  server.listen(port, bindHost, () => {
    console.log(`[proxy] forwarding ${bindHost}:${port} -> 127.0.0.1:${targetPort}`);
  });
}

// Docker's published-port DNAT targets the container's real interface IP, not
// its loopback, so binding here (rather than 0.0.0.0) avoids clashing with a
// same-port 127.0.0.1-only listener (the CBM UI) inside the same container.
function getContainerAddress(): string {
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const addr of addrs ?? []) {
      if (addr.family === 'IPv4' && !addr.internal) {
        return addr.address;
      }
    }
  }
  return '0.0.0.0';
}

// Standalone graph-visualization server, sharing CBM_CACHE_DIR with the stdio
// upstream so it shows the same indexed projects; the coordination daemon
// dedupes this against the MCP upstream's own session instead of double-serving.
function configureCodebaseMemoryUi(cacheDir: string, port: number, defaultPath: string = '/workspace') {
  // ui_enabled/ui_port live in CBM_CACHE_DIR/config.json (not the `config set` store).
  // Writing it before the codebase-memory upstream's stdio session starts its
  // coordination daemon makes that daemon serve the graph UI on this port —
  // running a second `--ui=true` CLI invocation just starts/stops its own stdio
  // session immediately (EOF on stdin) without leaving anything listening.
  // Persist the default workspace root as well so the start page opens at the
  // container's mounted workspace instead of an empty or stale state.
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
    defaultPath: defaultPath,
    workspace_path: defaultPath,
    root_path: defaultPath,
    project_root: defaultPath,
  };
  fs.writeFileSync(configPath, JSON.stringify(nextConfig, null, 2));
}

// Auto-indexes the actual project folders under the configured Codebase Memory
// root instead of treating the whole monorepo as one single repo. Codebase
// Memory shows project folders on its start page when each repository is
// indexed individually.
function discoverProjectRoots(workspaceRoot: string): string[] {
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

type IndexJobStatus = 'indexing' | 'enriching' | 'success' | 'error';

interface IndexJobState {
  status: IndexJobStatus;
  message?: string;
  updatedAt: number;
}

const indexJobs = new Map<string, IndexJobState>();

function getIndexJobsSnapshot(): Record<string, IndexJobState> {
  return Object.fromEntries(indexJobs.entries());
}

// Indexes a single repo and tracks its progress in `indexJobs`, so both the
// startup auto-index and the per-directory dashboard button can await/observe
// the same underlying job without duplicating the spawn logic.
function indexRepository(cacheDir: string, repoPath: string): Promise<void> {
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

async function enrichRepositorySemanticEdges(cacheDir: string, repoPath: string): Promise<void> {
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

function autoIndexCodebaseMemory(cacheDir: string, workspaceRoot: string) {
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

async function enrichCodebaseMemoryWithSemanticEdges(cacheDir: string, repoPath: string) {
  const extractor = new SemanticDependencyResolver(repoPath);
  const files = extractor.collectSemanticFiles(repoPath);

  if (files.length === 0) {
    console.log('[codebase-memory] no semantic source files found for edge enrichment');
    return;
  }

  console.log(`[codebase-memory] starting semantic edge enrichment for ${path.basename(repoPath)} (${files.length} files)...`);

  const graphLinks = await extractor.extractEdges(files, (message: string, percent: number) => {
    console.log(`[codebase-memory] ${message} [${percent}%]`);
  });

  if (graphLinks.length === 0) {
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

function main() {
  ensureDir(dataDir);
  ensureDir(cbmCacheDir);
  resetGatewayPersistentState();
  cleanupStaleCodebaseMemoryDaemon();
  // Re-apply the canonical workspace root to the mounted CBM cache before the
  // upstream daemon serves the UI. The persistent CBM cache keeps a runtime
  // selection outside the JSON config, so we must clear that stale state to avoid
  // the browser reopening at /root after a restart.
  configureCodebaseMemoryUi(cbmCacheDir, cbmUiBackendPort, cbmDefaultPath);
  // The public port is a proxy in front of the real CBM UI. The upstream UI
  // only accepts a matching Origin/Referer port, so we bind its real loopback
  // listener to a private internal port and proxy 9749 to it instead of trying
  // to self-proxy on the exact same port.

  const adminConfig = buildAdminConfig();
  const adminConfigPath = path.join(dataDir, 'admin-gateway-config.json');
  fs.writeFileSync(adminConfigPath, JSON.stringify(adminConfig, null, 2));

  const enableStartupAutoIndex = process.env.CBM_AUTO_INDEX_ENABLED === 'true';
  if (enableStartupAutoIndex) {
    const startupIndexPath = normalizeContainerPath('CBM_AUTO_INDEX_PATH', '/workspace');
    autoIndexCodebaseMemory(cbmCacheDir, startupIndexPath);
  } else {
    console.log('[codebase-memory] startup auto-index is disabled; run index_repository manually for the first project index.');
  }

  const dbPath = path.join(dataDir, 'gateway.db');
  const env = { ...process.env, DEV_ALLOW_UNAUTHENTICATED: 'true', CI: 'true' };

  const gatewayProcess = spawn(
    'npx',
    ['-y', '@mspstack/mcp-gateway', '--port', String(adminPort), '--config', adminConfigPath, '--db-path', dbPath],
    { env, stdio: ['ignore', 'pipe', 'pipe'] },
  );

  const adminUiEndpointLog = `[gateway] Supergateway RBAC-MCP Admin UI: http://localhost:${adminUiPort}`;
  const publicEndpointLog = `[gateway] Supergateway RBAC-MCP endpoint: http://localhost:${publicPort}/mcp`;
  const publicEndpointLogDelayMs = Number(process.env.PUBLIC_ENDPOINT_LOG_DELAY_MS ?? 25000);
  let adminUiEndpointLogged = false;
  let publicEndpointLogged = false;
  let startupLogBuffer: string[] = [];
  let startupLogFlushTimer: NodeJS.Timeout | undefined;

  const flushStartupLogs = () => {
    if (startupLogBuffer.length === 0) {
      return;
    }

    const buffered = startupLogBuffer;
    startupLogBuffer = [];
    process.stderr.write(`${buffered.join('\n')}\n`);
  };

  const emitAdminUiEndpointLog = () => {
    if (adminUiEndpointLogged) {
      return;
    }
    adminUiEndpointLogged = true;
    console.error(adminUiEndpointLog);
  };

  const emitPublicEndpointLog = () => {
    if (publicEndpointLogged) {
      return;
    }
    publicEndpointLogged = true;
    if (startupLogFlushTimer) {
      clearTimeout(startupLogFlushTimer);
      startupLogFlushTimer = undefined;
    }
    flushStartupLogs();
    console.error(publicEndpointLog);
  };

  const queueStartupLogs = (text: string) => {
    const lines = text
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line.length > 0)
      .filter((line) => !line.includes('[gateway] MCP endpoint') && !line.includes('[gateway] admin UI') && !line.includes('[gateway] serving ') && !line.includes('[gateway] public RBAC-MCP endpoint'));

    if (lines.length === 0) {
      return;
    }

    startupLogBuffer.push(...lines);

    if (startupLogFlushTimer) {
      clearTimeout(startupLogFlushTimer);
    }

    startupLogFlushTimer = setTimeout(() => {
      if (!publicEndpointLogged) {
        flushStartupLogs();
      }
    }, 2500);
  };

  if (gatewayProcess.stdout) {
    gatewayProcess.stdout.on('data', (chunk: Buffer | string) => {
      queueStartupLogs(chunk.toString());
    });
  }

  if (gatewayProcess.stderr) {
    gatewayProcess.stderr.setEncoding('utf8');
    gatewayProcess.stderr.on('data', (chunk: Buffer | string) => {
      queueStartupLogs(chunk.toString());
    });
  }

  gatewayProcess.on('exit', (code) => {
    console.log(`mcp-gateway exited with code ${code}`);
    process.exit(code ?? 1);
  });

  // The CBM UI only listens on loopback in the container; expose it via a
  // public proxy so 9749 is reachable from the host while preserving the same
  // Origin/Referer rewrite required by its browser-side checks.
  startForwardProxy(cbmUiPort, cbmUiBackendPort, { rewriteOriginToLoopback: true, dashboardEnabled: false, stripFrameHeaders: true });
  // The dashboard lives behind the admin port, not the public MCP port: the
  // latter is meant for MCP client (SSE) traffic only, not human browsing.
  startForwardProxy(adminUiPort, adminPort, { dashboardEnabled: true });
  startForwardProxy(publicPort, adminPort, { dashboardEnabled: false });
  startBackendServer(Number(process.env.BACKEND_PORT || 8081));

  setTimeout(() => {
    if (!adminUiEndpointLogged) {
      emitAdminUiEndpointLog();
    }
    if (!publicEndpointLogged) {
      emitPublicEndpointLog();
    }
  }, publicEndpointLogDelayMs);
}

main();
