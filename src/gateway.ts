// Container entrypoint that replaces host-side supergateway.ps1: bundles the
// mcp-gateway process, all four MCP upstreams, and the public forward proxy
// into a single self-contained process (no host npm/pip installs required).
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import http from 'http';
import os from 'os';
import { startBackendServer } from './server';

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
const cbmCacheDir = path.join(dataDir, 'cbm-cache');

function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
}

function buildAdminConfig(): GatewayConfig {
  const configPath = path.join(__dirname, '..', 'docker', 'gateway.config.json');
  const config: GatewayConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));

  for (const upstream of config.upstreams) {
    if (upstream.id === 'gitlab' && process.env.GITLAB_PERSONAL_ACCESS_TOKEN) {
      upstream.env = { ...upstream.env, GITLAB_PERSONAL_ACCESS_TOKEN: process.env.GITLAB_PERSONAL_ACCESS_TOKEN };
    }
    if (upstream.id === 'siyuan-note' && process.env.SIYUAN_TOKEN) {
      upstream.env = { ...upstream.env, SIYUAN_TOKEN: process.env.SIYUAN_TOKEN };
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
function configureCodebaseMemoryUi(cacheDir: string, port: number) {
  // ui_enabled/ui_port live in CBM_CACHE_DIR/config.json (not the `config set` store).
  // Writing it before the codebase-memory upstream's stdio session starts its
  // coordination daemon makes that daemon serve the graph UI on this port —
  // running a second `--ui=true` CLI invocation just starts/stops its own stdio
  // session immediately (EOF on stdin) without leaving anything listening.
  const configPath = path.join(cacheDir, 'config.json');
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  } catch {
    // no existing config yet
  }
  fs.writeFileSync(configPath, JSON.stringify({ ...existing, ui_enabled: true, ui_port: port }, null, 2));
}

// Auto-indexes CBM_AUTO_INDEX_PATH (the mounted WORKSPACE_ROOT, see docker-compose.yml)
// on startup, since codebase-memory-mcp otherwise requires a manual "Index this
// project" tool call per session. Runs detached/non-blocking so a large first
// index (can take minutes on a big monorepo) doesn't delay the gateway/proxy
// from coming up.
function autoIndexCodebaseMemory(cacheDir: string, repoPath: string) {
  if (!fs.existsSync(repoPath)) {
    console.warn(`[codebase-memory] auto-index skipped, path not found: ${repoPath}`);
    return;
  }
  console.log(`[codebase-memory] auto-indexing ${repoPath} in background...`);
  const child = spawn(
    'npx',
    ['-y', 'codebase-memory-mcp', 'cli', 'index_repository', JSON.stringify({ repo_path: repoPath })],
    { env: { ...process.env, CBM_CACHE_DIR: cacheDir }, stdio: 'inherit' },
  );
  child.on('exit', (code) => {
    if (code === 0) console.log('[codebase-memory] auto-index completed');
    else console.warn(`[codebase-memory] auto-index exited with code ${code}`);
  });
}

function main() {
  ensureDir(dataDir);
  ensureDir(cbmCacheDir);
  // Keep configured/published ports identical: the CBM UI rejects requests whose
  // Origin/Referer port doesn't match its own configured ui_port (403).
  configureCodebaseMemoryUi(cbmCacheDir, cbmUiPort);

  const adminConfig = buildAdminConfig();
  const adminConfigPath = path.join(dataDir, 'admin-gateway-config.json');
  fs.writeFileSync(adminConfigPath, JSON.stringify(adminConfig, null, 2));

  if (process.env.CBM_AUTO_INDEX_PATH) {
    autoIndexCodebaseMemory(cbmCacheDir, process.env.CBM_AUTO_INDEX_PATH);
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
