import http from 'http';
import path from 'path';
import { WebSocketServer } from 'ws';
import { buildCbmOverviewHtml, buildDashboardHtml } from './dashboard';
import {
  discoverProjectRoots,
  enrichRepositorySemanticEdges,
  getIndexJobsSnapshot,
  indexRepository,
  mergeWorkspaceProjectRows,
  setIndexJobUpdateListener,
} from './codebaseMemory';

export interface ProxyRuntimeConfig {
  adminUiPort: number;
  mspGatewayPort: number;
  siyuanPort: number;
  cbmUiPort: number;
  cbmDefaultPath: string;
  cbmCacheDir: string;
  cbmHostWorkspaceDir: string;
}

export interface StartForwardProxyOptions extends ProxyRuntimeConfig {
  bindHost?: string;
  rewriteOriginToLoopback?: boolean;
  redirectRootToAdmin?: boolean;
  dashboardEnabled?: boolean;
  stripFrameHeaders?: boolean;
}

function isCbmUiRequest(req: http.IncomingMessage, requestUrl: URL): boolean {
  const referer = req.headers.referer ?? '';
  const isCbmReferer = referer.includes('/cbm/');
  const pathname = requestUrl.pathname;
  const cbmAssetOrApi = pathname.startsWith('/assets/') || pathname.startsWith('/api/') || pathname.startsWith('/@') || pathname.startsWith('/_') || pathname.startsWith('/favicon');
  return isCbmReferer && cbmAssetOrApi;
}

function handleDashboardRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  requestUrl: URL,
  runtime: ProxyRuntimeConfig,
  dashboardEnabled: boolean,
) {
  if (!dashboardEnabled || req.method !== 'GET') {
    return false;
  }

  if (requestUrl.pathname === '/' || requestUrl.pathname === '/dashboard') {
    const tab = requestUrl.searchParams.get('tab') ?? 'msp';
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(buildDashboardHtml({
      activeTab: tab,
      adminUiPort: runtime.adminUiPort,
      mspGatewayPort: runtime.mspGatewayPort,
      cbmUiPort: runtime.cbmUiPort,
      siyuanPort: runtime.siyuanPort,
    }));
    return true;
  }

  if (requestUrl.pathname === '/msp' || requestUrl.pathname === '/cbm' || requestUrl.pathname === '/siyuan') {
    const tab = requestUrl.pathname.slice(1) as 'msp' | 'cbm' | 'siyuan';
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(buildDashboardHtml({
      activeTab: tab,
      adminUiPort: runtime.adminUiPort,
      mspGatewayPort: runtime.mspGatewayPort,
      cbmUiPort: runtime.cbmUiPort,
      siyuanPort: runtime.siyuanPort,
    }));
    return true;
  }

  if (requestUrl.pathname === '/msp-admin' || requestUrl.pathname.startsWith('/msp-admin/')) {
    const upstreamSuffix = requestUrl.pathname.replace(/^\/msp-admin/, '') || '/';
    const upstreamPath = `/admin${upstreamSuffix === '/' ? '' : upstreamSuffix}${requestUrl.search}`;
    proxyRequestToUpstream(req, res, runtime.mspGatewayPort, requestUrl, true, false, true, upstreamPath);
    return true;
  }

  if (requestUrl.pathname === '/cbm/overview') {
    const initialProjects = mergeWorkspaceProjectRows(runtime.cbmHostWorkspaceDir || runtime.cbmDefaultPath, runtime.cbmCacheDir);

    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(buildCbmOverviewHtml({ cbmUiPort: runtime.cbmUiPort, initialProjects }));
    return true;
  }

  if (requestUrl.pathname === '/cbm/projects') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ projects: mergeWorkspaceProjectRows(runtime.cbmHostWorkspaceDir || runtime.cbmDefaultPath, runtime.cbmCacheDir) }));
    return true;
  }

  if (requestUrl.pathname === '/cbm/index-status') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(getIndexJobsSnapshot(runtime.cbmCacheDir)));
    return true;
  }

  if (isCbmUiRequest(req, requestUrl)) {
    proxyRequestToUpstream(req, res, runtime.cbmUiPort, requestUrl, true, false, true);
    return true;
  }

  return false;
}

function handleCbmActionRoutes(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  requestUrl: URL,
  runtime: ProxyRuntimeConfig,
  dashboardEnabled: boolean,
) {
  if (!dashboardEnabled || req.method !== 'POST') {
    return false;
  }

  if (requestUrl.pathname === '/cbm/index') {
    const requestedPath = decodeURIComponent(requestUrl.searchParams.get('path') ?? '');
    const allowedRoots = discoverProjectRoots(runtime.cbmDefaultPath);
    if (!requestedPath || !allowedRoots.includes(requestedPath)) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unknown or disallowed project path' }));
      return true;
    }
    void indexRepository(runtime.cbmCacheDir, requestedPath);
    res.writeHead(202, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'started', path: requestedPath }));
    return true;
  }

  if (requestUrl.pathname === '/cbm/enrich') {
    const requestedPath = decodeURIComponent(requestUrl.searchParams.get('path') ?? '');
    const allowedRoots = discoverProjectRoots(runtime.cbmDefaultPath);
    if (!requestedPath || !allowedRoots.includes(requestedPath)) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unknown or disallowed project path' }));
      return true;
    }
    void enrichRepositorySemanticEdges(runtime.cbmCacheDir, requestedPath);
    res.writeHead(202, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'started', path: requestedPath }));
    return true;
  }

  return false;
}

function proxyRequestToUpstream(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  targetPort: number,
  requestUrl: URL,
  rewriteOriginToLoopback: boolean,
  redirectRootToAdmin: boolean,
  stripFrameHeaders: boolean,
  overridePath?: string,
) {
  const headers = { ...req.headers, host: `127.0.0.1:${targetPort}` };
  let targetPath = overridePath ?? req.url ?? '/';

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
}

export function startDashboardServer(
  port: number,
  options: StartForwardProxyOptions,
) {
  const {
    bindHost = '0.0.0.0',
    dashboardEnabled = true,
    adminUiPort,
    mspGatewayPort,
    siyuanPort,
    cbmUiPort,
    cbmDefaultPath,
    cbmCacheDir,
    cbmHostWorkspaceDir,
  } = options;

  const runtime: ProxyRuntimeConfig = {
    adminUiPort,
    mspGatewayPort,
    siyuanPort,
    cbmUiPort,
    cbmDefaultPath,
    cbmCacheDir,
    cbmHostWorkspaceDir,
  };

  const server = http.createServer((req, res) => {
    const requestUrl = new URL(req.url ?? '/', 'http://127.0.0.1');

    if (req.method === 'GET' && req.url === '/ping') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
      return;
    }

    if (handleDashboardRoutes(req, res, requestUrl, runtime, dashboardEnabled)) {
      return;
    }

    if (handleCbmActionRoutes(req, res, requestUrl, runtime, dashboardEnabled)) {
      return;
    }

    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ error: 'route not handled by the local dashboard' }));
  });

  const shouldServeProgressStream = dashboardEnabled && port === Number(process.env.ADMIN_UI_PORT);

  if (shouldServeProgressStream) {
    const socketServer = new WebSocketServer({ noServer: true });
    const sockets = new Set<import('ws')>();

    server.on('upgrade', (req, socket, head) => {
      const requestUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (requestUrl.pathname !== '/cbm/progress') {
        socket.destroy();
        return;
      }

      socketServer.handleUpgrade(req, socket, head, (ws) => {
        sockets.add(ws as import('ws'));
        ws.send(JSON.stringify({ type: 'snapshot', jobs: getIndexJobsSnapshot() }));

        ws.on('close', () => {
          sockets.delete(ws as import('ws'));
        });
      });
    });

    setIndexJobUpdateListener((repoPath, job) => {
      if (sockets.size === 0) {
        return;
      }

      const payload = JSON.stringify({ type: 'update', repoPath, job });
      for (const socket of sockets) {
        if (socket.readyState === 1) {
          socket.send(payload);
        }
      }
    });
  }

  server.listen(port, bindHost, () => {
    console.log(`[dashboard] serving ${bindHost}:${port} locally`);
  });
}

export function startForwardProxy(
  port: number,
  targetPort: number,
  options: StartForwardProxyOptions,
) {
  const {
    bindHost = '0.0.0.0',
    rewriteOriginToLoopback = false,
    redirectRootToAdmin = false,
    dashboardEnabled = true,
    stripFrameHeaders = false,
    adminUiPort,
    mspGatewayPort,
    siyuanPort,
    cbmUiPort,
    cbmDefaultPath,
    cbmCacheDir,
    cbmHostWorkspaceDir,
  } = options;

  const runtime: ProxyRuntimeConfig = {
    adminUiPort,
    mspGatewayPort,
    siyuanPort,
    cbmUiPort,
    cbmDefaultPath,
    cbmCacheDir,
    cbmHostWorkspaceDir,
  };

  const server = http.createServer((req, res) => {
    const requestUrl = new URL(req.url ?? '/', 'http://127.0.0.1');

    if (req.method === 'GET' && req.url === '/ping') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
      return;
    }

    if (handleDashboardRoutes(req, res, requestUrl, runtime, dashboardEnabled)) {
      return;
    }

    if (handleCbmActionRoutes(req, res, requestUrl, runtime, dashboardEnabled)) {
      return;
    }

    proxyRequestToUpstream(req, res, targetPort, requestUrl, rewriteOriginToLoopback, redirectRootToAdmin, stripFrameHeaders);
  });

  const shouldServeProgressStream = dashboardEnabled && port === Number(process.env.ADMIN_UI_PORT);

  if (shouldServeProgressStream) {
    const socketServer = new WebSocketServer({ noServer: true });
    const sockets = new Set<import('ws')>();

    server.on('upgrade', (req, socket, head) => {
      const requestUrl = new URL(req.url ?? '/', 'http://127.0.0.1');
      if (requestUrl.pathname !== '/cbm/progress') {
        socket.destroy();
        return;
      }

      socketServer.handleUpgrade(req, socket, head, (ws) => {
        sockets.add(ws as import('ws'));
        ws.send(JSON.stringify({ type: 'snapshot', jobs: getIndexJobsSnapshot() }));

        ws.on('close', () => {
          sockets.delete(ws as import('ws'));
        });
      });
    });

    setIndexJobUpdateListener((repoPath, job) => {
      if (sockets.size === 0) {
        return;
      }

      const payload = JSON.stringify({ type: 'update', repoPath, job });
      for (const socket of sockets) {
        if (socket.readyState === 1) {
          socket.send(payload);
        }
      }
    });
  }

  server.listen(port, bindHost, () => {
    console.log(`[proxy] forwarding ${bindHost}:${port} -> 127.0.0.1:${targetPort}`);
  });
}
