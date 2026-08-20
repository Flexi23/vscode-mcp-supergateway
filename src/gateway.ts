// Container entrypoint: bundles the mcp-gateway process, all MCP upstreams,
// and the public forward proxy into a single self-contained process.
import { spawn } from 'child_process';
import fs from 'fs';
import path from 'path';
import { startBackendServer } from './server';
import { requireEnv, requirePort } from './config/env';
import {
  classifyStartupLogLine,
  formatConnectedUpstreamSummary,
  splitStartupLogLines,
} from './startupLogClassifier';
import {
  buildAdminConfig,
  cleanupStaleCodebaseMemoryDaemon,
  ensureDir,
  normalizeContainerPath,
  resetGatewayPersistentState,
} from './gatewayConfig';
import {
  autoIndexCodebaseMemory,
  configureCodebaseMemoryUi,
} from './codebaseMemory';
import { startForwardProxy } from './proxy';

const dataDir = requireEnv('GATEWAY_DATA_DIR');
const adminPort = requirePort('MCP_GATEWAY_ADMIN_PORT');
const adminUiPort = requirePort('ADMIN_UI_PORT');
const publicPort = requirePort('MCP_GATEWAY_PUBLIC_PORT');
const cbmUiPort = requirePort('CBM_UI_PORT');
const cbmUiBackendPort = requirePort('CBM_UI_BACKEND_PORT');
const cbmCacheDir = requireEnv('CBM_CACHE_DIR');
const cbmHostWorkspaceDir = requireEnv('CBM_HOST_WORKSPACE_DIR');
const cbmDefaultPath = normalizeContainerPath('CBM_DEFAULT_PATH', '/workspace');

function main() {
  ensureDir(dataDir);
  ensureDir(cbmCacheDir);
  resetGatewayPersistentState(dataDir, cbmCacheDir);
  cleanupStaleCodebaseMemoryDaemon();

  configureCodebaseMemoryUi(cbmCacheDir, cbmUiBackendPort, cbmDefaultPath);

  const adminConfig = buildAdminConfig(cbmCacheDir);
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
  const proxyRuntimeConfig = {
    adminUiPort,
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

  const startupBanner = `
__________________________________________________________________________________
      __                                  __                                      
    /    )                              /    )                                    
----\-----------------__----__---)__---/---------__--_/_----__-----------__-------
     \     /   /    /   ) /___) /   ) /  --,   /   ) /    /___)| /| /  /   ) /   /
_(____/___(___(____/___/_(___ _/_____(____/___(___(_(_ __(___ _|/_|/__(___(_(___/_
                  /                                                            /  
                 /                                                         (_ /   
`;
  const publicEndpointLog  = `          RBAC-MCP: http://localhost:${publicPort}/mcp`;
  const adminUiEndpointLog = `          Admin UI: http://localhost:${adminUiPort}`;
  let adminUiEndpointLogged = false;
  let publicEndpointLogged = false;

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
    console.error(startupBanner);
    console.error(publicEndpointLog);
  };

  let startupLogBuffer = '';

  const queueStartupLogs = (text: string) => {
    const { lines, pending } = splitStartupLogLines(text, startupLogBuffer);
    startupLogBuffer = pending;

    for (const line of lines) {
      const event = classifyStartupLogLine(line);
      switch (event.kind) {
        case 'upstream-connected':
          console.error(formatConnectedUpstreamSummary(event.upstreamId, event.transport));
          break;
        case 'ignored':
          break;
        case 'plain':
          process.stderr.write(`${event.text}\n`);
          break;
      }
    }
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
    if (startupLogBuffer.trim().length > 0) {
      queueStartupLogs(startupLogBuffer);
      startupLogBuffer = '';
    }
    console.log(`mcp-gateway exited with code ${code}`);
    process.exit(code ?? 1);
  });

  startForwardProxy(cbmUiPort, cbmUiBackendPort, {
    ...proxyRuntimeConfig,
    rewriteOriginToLoopback: true,
    dashboardEnabled: false,
    stripFrameHeaders: true,
  });
  startForwardProxy(adminUiPort, adminPort, {
    ...proxyRuntimeConfig,
    dashboardEnabled: true,
  });
  startForwardProxy(publicPort, adminPort, {
    ...proxyRuntimeConfig,
    dashboardEnabled: false,
  });
  startBackendServer(Number(process.env.BACKEND_PORT || 8081));

  emitPublicEndpointLog();
  emitAdminUiEndpointLog();
}

if (require.main === module) {
  main();
}
