// Container entrypoint that replaces host-side supergateway.ps1: bundles the
// mcp-gateway process, all four MCP upstreams, and the public forward proxy
// into a single self-contained process (no host npm/pip installs required).
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import http from 'http';
import os from 'os';
import { startBackendServer } from './server';
import { CsharpDependencyExtractor } from './services/csharpDependencyExtractor';

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

const dataDir = process.env.GATEWAY_DATA_DIR || '/app/data';
const adminPort = Number(process.env.MCP_GATEWAY_ADMIN_PORT || 3100);
const publicPort = Number(process.env.MCP_GATEWAY_PUBLIC_PORT || 8080);
const cbmUiPort = Number(process.env.CBM_UI_PORT || 9749);
const cbmCacheDir = process.env.CBM_CACHE_DIR || '/root/cbm-cache';
const cbmDefaultPath = process.env.CBM_DEFAULT_PATH || process.env.WORKSPACE_ROOT || '/workspace';

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // Some mounts may reject chmod; ignore, the important thing is the exact
    // path stays private and root-owned in the container.
  }
}

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
  const siYuanTokenRequired = String(process.env.SIYUAN_TOKEN_REQUIRED ?? 'false').toLowerCase() === 'true';

  for (const upstream of config.upstreams) {
    if (upstream.id === 'gitlab' && process.env.GITLAB_PERSONAL_ACCESS_TOKEN) {
      upstream.env = { ...upstream.env, GITLAB_PERSONAL_ACCESS_TOKEN: process.env.GITLAB_PERSONAL_ACCESS_TOKEN };
    }
    if (upstream.id === 'siyuan-note') {
      const siYuanToken = process.env.SIYUAN_TOKEN || '';
      upstream.env = {
        ...upstream.env,
        SIYUAN_HOST: 'siyuan',
        SIYUAN_PORT: '6806',
        SIYUAN_TOKEN: siYuanToken,
        SIYUAN_TOKEN_REQUIRED: String(siYuanTokenRequired),
      };
      if (siYuanTokenRequired && (!siYuanToken || ['Supergateway', 'siyuan_api_token_here', 'your-api-token-here'].includes(siYuanToken))) {
        console.warn('[siyuan-note] SIYUAN_TOKEN_REQUIRED=true but the token is empty or placeholder. Set the real API token from SiYuan: Settings -> About -> API Token.');
      }
    }
    if (upstream.id === 'codebase-memory') {
      upstream.env = { ...upstream.env, CBM_CACHE_DIR: cbmCacheDir };
    }
  }

  return config;
}

function startForwardProxy(
  port: number,
  targetPort: number,
  options: { bindHost?: string; rewriteOriginToLoopback?: boolean } = {},
) {
  const { bindHost = '0.0.0.0', rewriteOriginToLoopback = false } = options;

  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/ping') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
      return;
    }

    const headers = { ...req.headers, host: `127.0.0.1:${targetPort}` };
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
        path: req.url,
        headers,
      },
      (upstreamResponse) => {
        res.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
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

// Auto-indexes the actual project folders under the mounted WORKSPACE_ROOT
// instead of treating the whole monorepo as one single repo. Codebase Memory
// shows project folders on its start page when each repository is indexed
// individually.
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

function autoIndexCodebaseMemory(cacheDir: string, workspaceRoot: string) {
  if (!fs.existsSync(workspaceRoot)) {
    console.warn(`[codebase-memory] auto-index skipped, path not found: ${workspaceRoot}`);
    return;
  }

  const repoPaths = discoverProjectRoots(workspaceRoot);
  console.log(`[codebase-memory] auto-indexing ${repoPaths.length} project root(s) under ${workspaceRoot}...`);

  repoPaths.forEach((repoPath, index) => {
    const projectName = path.basename(repoPath) || 'workspace';
    const child = spawn(
      'npx',
      ['-y', 'codebase-memory-mcp', 'cli', 'index_repository', '--repo-path', repoPath, '--name', projectName, '--mode', 'moderate'],
      { env: { ...process.env, CBM_CACHE_DIR: cacheDir }, stdio: 'inherit' },
    );

    child.on('exit', async (code) => {
      if (code === 0) {
        console.log(`[codebase-memory] auto-index completed for ${repoPath} (${index + 1}/${repoPaths.length})`);
        try {
          await enrichCodebaseMemoryWithCSharpEdges(cacheDir, repoPath);
        } catch (error) {
          console.warn(`[codebase-memory] C# edge enrichment failed for ${repoPath}:`, error);
        }
        return;
      }

      console.warn(`[codebase-memory] auto-index exited for ${repoPath} with code ${code}`);
    });
  });
}

async function enrichCodebaseMemoryWithCSharpEdges(cacheDir: string, repoPath: string) {
  const extractor = new CsharpDependencyExtractor(repoPath);
  const files = extractor.collectCSharpFiles(repoPath);

  if (files.length === 0) {
    console.log('[codebase-memory] no C# files found for edge enrichment');
    return;
  }

  console.log(`[codebase-memory] starting C# edge enrichment for ${path.basename(repoPath)} (${files.length} files)...`);

  const graphLinks = await extractor.extractEdges(files, (message, percent) => {
    console.log(`[codebase-memory] ${message} [${percent}%]`);
  });

  if (graphLinks.length === 0) {
    console.log('[codebase-memory] no C# graph links produced');
    return;
  }

  const projectName = path.basename(repoPath) || 'workspace';
  const linksFile = path.join(cacheDir, 'csharp-edges.json');
  extractor.writeLinksFile(graphLinks, linksFile);

  console.log(`[codebase-memory] ingesting ${graphLinks.length} C# graph links into project ${projectName}...`);
  const child = spawn(
    'npx',
    ['-y', 'codebase-memory-mcp', 'cli', 'ingest_traces', '--project', projectName, '--traces', JSON.stringify(graphLinks)],
    { env: { ...process.env, CBM_CACHE_DIR: cacheDir }, stdio: 'inherit' },
  );

  child.on('exit', (exitCode) => {
    if (exitCode === 0) {
      console.log(`[codebase-memory] injected ${graphLinks.length} C# graph links into project ${projectName}`);
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
  // Keep configured/published ports identical: the CBM UI rejects requests whose
  // Origin/Referer port doesn't match its own configured ui_port (403).
  configureCodebaseMemoryUi(cbmCacheDir, cbmUiPort, cbmDefaultPath);

  const adminConfig = buildAdminConfig();
  const adminConfigPath = path.join(dataDir, 'admin-gateway-config.json');
  fs.writeFileSync(adminConfigPath, JSON.stringify(adminConfig, null, 2));

  const runtimeWorkspaceRoot = process.env.WORKSPACE_ROOT || '/workspace';
  const enableStartupAutoIndex = process.env.CBM_AUTO_INDEX_ENABLED === 'true';
  const startupIndexPath = process.env.CBM_AUTO_INDEX_PATH || runtimeWorkspaceRoot;
  if (enableStartupAutoIndex && startupIndexPath) {
    autoIndexCodebaseMemory(cbmCacheDir, startupIndexPath);
  } else {
    console.log('[codebase-memory] startup auto-index is disabled; run index_repository manually for the first project index.');
  }

  const dbPath = path.join(dataDir, 'gateway.db');
  const env = { ...process.env, DEV_ALLOW_UNAUTHENTICATED: 'true', CI: 'true' };

  const gatewayProcess = spawn(
    'npx',
    ['-y', '@mspstack/mcp-gateway', '--port', String(adminPort), '--config', adminConfigPath, '--db-path', dbPath],
    { env, stdio: 'inherit' },
  );

  gatewayProcess.on('exit', (code) => {
    console.log(`mcp-gateway exited with code ${code}`);
    process.exit(code ?? 1);
  });

  startForwardProxy(publicPort, adminPort);
  startBackendServer(Number(process.env.BACKEND_PORT || 8081));
  startForwardProxy(cbmUiPort, cbmUiPort, {
    bindHost: getContainerAddress(),
    rewriteOriginToLoopback: true,
  });
}

main();
