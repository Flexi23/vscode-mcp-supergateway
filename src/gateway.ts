// Container entrypoint that replaces host-side supergateway.ps1: bundles the
// mcp-gateway process, all four MCP upstreams, and the public forward proxy
// into a single self-contained process (no host npm/pip installs required).
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import http from 'http';

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
const vaultDir = process.env.VAULT_PATH || '/app/vault';
const adminPort = Number(process.env.MCP_GATEWAY_ADMIN_PORT || 3100);
const publicPort = Number(process.env.MCP_GATEWAY_PUBLIC_PORT || 8080);

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
    if (upstream.id === 'markdown-vault') {
      upstream.env = { ...upstream.env, VAULT_PATH: vaultDir };
    }
    if (upstream.id === 'codebase-memory') {
      upstream.env = { ...upstream.env, CBM_CACHE_DIR: path.join(dataDir, 'cbm-cache') };
    }
  }

  return config;
}

function startForwardProxy(port: number, targetPort: number) {
  const server = http.createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/ping') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
      return;
    }

    const upstreamRequest = http.request(
      {
        hostname: '127.0.0.1',
        port: targetPort,
        method: req.method,
        path: req.url,
        headers: { ...req.headers, host: `127.0.0.1:${targetPort}` },
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

  server.listen(port, '0.0.0.0', () => {
    console.log(`[proxy] forwarding 0.0.0.0:${port} -> 127.0.0.1:${targetPort}`);
  });
}

function main() {
  ensureDir(vaultDir);
  ensureDir(dataDir);
  ensureDir(path.join(dataDir, 'cbm-cache'));

  const adminConfig = buildAdminConfig();
  const adminConfigPath = path.join(dataDir, 'admin-gateway-config.json');
  fs.writeFileSync(adminConfigPath, JSON.stringify(adminConfig, null, 2));

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
}

main();
