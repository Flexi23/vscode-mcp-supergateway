// Container entrypoint: bundles the mcp-gateway process, all MCP upstreams,
// and the public forward proxy into a single self-contained process.
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { requireEnv, requirePort } from './config/env';
import {
  classifyStartupLogLine,
  formatConnectedUpstreamSummary,
  formatToolCatalogTable,
  matchToolToUpstream,
  splitStartupLogLines,
} from './startupLogClassifier';
import {
  buildAdminConfig,
  cleanupStaleCodebaseMemoryDaemon,
  ensureDir,
  normalizeContainerPath,
  resetGatewayPersistentState,
  type GatewayConfig,
} from './gatewayConfig';
import {
  autoIndexCodebaseMemory,
  configureCodebaseMemoryUi,
  startCodebaseMemoryUi,
} from './codebaseMemory';
import { startDashboardServer, startForwardProxy } from './proxy';

const dataDir = requireEnv('GATEWAY_DATA_DIR');
const adminPort = requirePort('MCP_GATEWAY_ADMIN_PORT');
const adminUiPort = requirePort('ADMIN_UI_PORT');
const publicPort = requirePort('MCP_GATEWAY_PUBLIC_PORT');
const mspGatewayPort = adminPort;
const siyuanPort = requirePort('SIYUAN_PORT');
const cbmUiPort = 9749;
const cbmCacheDir = requireEnv('CBM_CACHE_DIR');
const cbmHostWorkspaceDir = requireEnv('CBM_HOST_WORKSPACE_DIR');
const cbmContainerWorkspacePath = '/workspace';
const cbmDefaultPath = '/workspace';

const sleep = (delayMs: number) => new Promise((resolve) => setTimeout(resolve, delayMs));

async function discoverGatewayToolRows(adminPort: number, upstreams: GatewayConfig['upstreams']) {
  const client = new Client({ name: 'supergateway-log-viewer', version: '1.0.0' });

  try {
    await client.connect(new StreamableHTTPClientTransport(new URL(`http://localhost:${adminPort}/mcp`)));
    const page = await client.listTools();
    const rows = [] as Array<{ upstreamId: string; toolName: string; transport: string }>;
    const seen = new Set<string>();

    for (const tool of page.tools ?? []) {
      if (!tool || typeof tool.name !== 'string') {
        continue;
      }

      const match = matchToolToUpstream(tool.name, upstreams);
      if (!match || !match.toolName) {
        continue;
      }

      const key = `${match.upstreamId}:${match.toolName}`;
      if (seen.has(key)) {
        continue;
      }
      seen.add(key);
      rows.push(match);
    }

    return rows.sort((left, right) => {
      const upstreamCompare = left.upstreamId.localeCompare(right.upstreamId);
      if (upstreamCompare !== 0) {
        return upstreamCompare;
      }
      return left.toolName.localeCompare(right.toolName);
    });
  } finally {
    await client.close().catch(() => undefined);
  }
}

async function emitGatewayToolCatalog(adminPort: number, upstreams: GatewayConfig['upstreams']) {
  for (let attempt = 0; attempt < 25; attempt += 1) {
    try {
      const rows = await discoverGatewayToolRows(adminPort, upstreams);
      if (rows.length > 0) {
        console.error(formatToolCatalogTable(rows));
        return;
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      if (attempt === 24) {
        console.warn(`[gateway] tool catalog discovery still warming up (${detail})`);
      }
    }

    await sleep(250);
  }

  console.error(formatToolCatalogTable([]));
}

async function main() {
  ensureDir(dataDir);
  ensureDir(cbmCacheDir);
  resetGatewayPersistentState(dataDir, cbmCacheDir);
  cleanupStaleCodebaseMemoryDaemon();

  configureCodebaseMemoryUi(cbmCacheDir, cbmUiPort, cbmDefaultPath);
  startCodebaseMemoryUi(cbmCacheDir, cbmUiPort, cbmDefaultPath);

  const adminConfig = buildAdminConfig(cbmCacheDir);
  const adminConfigPath = path.join(dataDir, 'admin-gateway-config.json');
  fs.writeFileSync(adminConfigPath, JSON.stringify(adminConfig, null, 2));

  const enableStartupAutoIndex = process.env.CBM_AUTO_INDEX_ENABLED === 'true';
  if (enableStartupAutoIndex) {
    const startupIndexPath = cbmContainerWorkspacePath;
    autoIndexCodebaseMemory(cbmCacheDir, startupIndexPath);
  } else {
    console.log('[codebase-memory] startup auto-index is disabled; run index_repository manually for the first project index.');
  }

  const dbPath = path.join(dataDir, 'gateway.db');
  const env = { ...process.env, DEV_ALLOW_UNAUTHENTICATED: 'true', CI: 'true' };
  const proxyRuntimeConfig = {
    adminUiPort,
    mspGatewayPort,
    siyuanPort,
    cbmUiPort,
    cbmDefaultPath,
    cbmCacheDir,
    cbmHostWorkspaceDir,
  };

  const gatewayProcess = spawn(
    'npx',
    ['-y', '@mspstack/mcp-gateway', '--port', String(adminPort), '--config', adminConfigPath, '--db-path', dbPath],
    { env, stdio: ['ignore', 'pipe', 'pipe'] },
  );

// generated using https://patorjk.com/software/taag/#p=display&f=Banshee+Brow&t=SuperGateway&x=none&v=4&h=4&w=80&we=false&ft=thedraw
  const startupBanner = `
  ███████    ██   ██    ██▀▀▀██    ██▀▀▀▀▀    ██▀▀▀██    ██▀▀▀██     ██▀▀▀██    ██████    ██▀▀▀▀▀    ██   ██    ██▀▀▀██    ██   ██  
█ ██ ▄▄▄▄▄██ ██ █ ██ ██ ██ █ ██ ██ ██ ███████ ██ █ ██ ██ ██ █ ██ ███ ██ █ ██ ██▄▄ ██ ▄▄██ ██ ███████ ██ █ ██ ██ ██ █ ██ ██ ██ █ ██ █
█ ██ ▀▀▀▀▀██ ██ █ ██ ██ ██ █ ██ ██ ██ ███████ ██ █ ██ ██ ██ █▄▄▄▄███ ██ ▀ ██ ████ ██ ████ ██ ███████ ██ █ ██ ██ ██ ▀ ██ ██ ██ █ ██ █
█ ███████ ██ ██ █ ██ ██ ██▄▄▄██ ██ ██▄▄▄ ████ ██ ▀ ██ ██ ██ ████████ ███████ ████ ██ ████ ██▄▄▄ ████ ██ █ ██ ██ ███████ ██ ██ ▀ ██ █
█▄▄▄▄▄ ██ ██ ██ █ ██ ██ ██ ▄▄▄▄▄██ ██ ▄▄▄████ ██████  ██ ██ █ ▄▄▄ ██ ██ ▄ ██ ████ ██ ████ ██ ▄▄▄████ ██ █ ██ ██ ██ ▄ ██ ██▄▄ ███ ▄▄█
██████ ██ ██ ██ █ ██ ██ ██ ███████ ██ ███████ ██ ▄ ██ ██ ██ █ ██ ▄██ ██ █ ██ ████ ██ ████ ██ ███████ ██ █ ██ ██ ██ █ ██ ████ ███ ███
██████ ██ ██ ██ █ ██ ██ ██ ███████ ██ ███████ ██ █ ██ ██ ██ █ ██ ███ ██ █ ██ ████ ██ ████ ██ ███████ ██ █ ██ ██ ██ █ ██ ████ ███ ███
█▀▀▀▀▀ ██ ██ ██ ▀ ██ ██ ██ ███████ ██ ███████ ██ █ ██ ██ ██ █ ██ ███ ██ █ ██ ████ ██ ████ ██ ███████ ██ █ ██ ██ ██ █ ██ ████ ███ ███
▀ ███████ ▀▀ ███████ ▀▀ ██ ▀▀▀▀▀▀▀ ██▄▄▄▄▄ ▀▀ ██ ▀ ██ ▀▀ ██▄▄▄██ ▀▀▀ ██ ▀ ██ ▀▀▀▀ ██ ▀▀▀▀ ██▄▄▄▄▄ ▀▀ ███████ ▀▀ ██ ▀ ██ ▀▀▀▀ ███ ▀▀▀`;
  const publicEndpointLog  = `RBAC-MCP: http://localhost:${publicPort}/mcp`;
  const adminUiEndpointLog = `Admin UI: http://localhost:${adminUiPort}`;
  let toolCatalogLogged = false;

  const emitGatewayToolCatalogOnce = async () => {
    if (toolCatalogLogged) {
      return;
    }
    toolCatalogLogged = true;

    try {
      const rows = await discoverGatewayToolRows(adminPort, adminConfig.upstreams);
      console.error(startupBanner);
      console.error(publicEndpointLog);
      console.error(adminUiEndpointLog);
      console.error(formatToolCatalogTable(rows.length > 0 ? rows : []));
      return;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      console.warn(`[gateway] tool catalog discovery still warming up (${detail})`);
    }

    console.error(startupBanner);
    console.error(publicEndpointLog);
    console.error(adminUiEndpointLog);
    console.error(formatToolCatalogTable([]));
  };

  let startupLogBuffer = '';

  const queueStartupLogs = (text: string, caller: string = 'gateway', stream: 'stdout' | 'stderr' = 'stderr') => {
    const streamPrefix = `[${caller}:${stream}] `;
    const emit = (value: string) => {
      if (stream === 'stdout') {
        process.stdout.write(`${streamPrefix}${value}\n`);
        return;
      }

      process.stderr.write(`${streamPrefix}${value}\n`);
    };

    const { lines, pending } = splitStartupLogLines(text, startupLogBuffer);
    startupLogBuffer = pending;

    for (const line of lines) {
      const event = classifyStartupLogLine(line);
      switch (event.kind) {
        case 'upstream-connected':
          emit(formatConnectedUpstreamSummary(event.upstreamId, event.transport));
          break;
        case 'gateway-admin-ui':
          emit(event.text);
          void emitGatewayToolCatalogOnce();
          break;
        case 'ignored':
          break;
        case 'plain':
          emit(event.text);
          break;
      }
    }
  };

  if (gatewayProcess.stdout) {
    gatewayProcess.stdout.on('data', (chunk: Buffer | string) => {
      queueStartupLogs(chunk.toString(), 'gateway', 'stdout');
    });
  }

  if (gatewayProcess.stderr) {
    gatewayProcess.stderr.setEncoding('utf8');
    gatewayProcess.stderr.on('data', (chunk: Buffer | string) => {
      queueStartupLogs(chunk.toString(), 'gateway', 'stderr');
    });
  }

  gatewayProcess.on('exit', (code) => {
    if (startupLogBuffer.trim().length > 0) {
      queueStartupLogs(startupLogBuffer);
      startupLogBuffer = '';
    }
    console.log(`mcp-gateway exited with code ${code}`);
    process.exit(code ?? 1);
  });

  startForwardProxy(publicPort, adminPort, {
    ...proxyRuntimeConfig,
    dashboardEnabled: false,
  });
  startDashboardServer(adminUiPort, {
    ...proxyRuntimeConfig,
    dashboardEnabled: true,
  });
}

if (require.main === module) {
  void main();
}
