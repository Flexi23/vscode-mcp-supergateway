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
  resolveRuntimeWorkspaceRoot,
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
  const cbmAssetOrApi = pathname === '/rpc' || pathname.startsWith('/assets/') || pathname.startsWith('/api/') || pathname.startsWith('/@') || pathname.startsWith('/_') || pathname.startsWith('/favicon');
  return isCbmReferer && cbmAssetOrApi;
}

// The msp-admin app is inlined directly into the dashboard (no iframe), so its own
// fetch calls to root-absolute paths (/api/*, /auth/*, /health) need a plain, always-on
// passthrough to the upstream — these prefixes are never used by our own dashboard routes.
function isMspAdminApiRequest(requestUrl: URL): boolean {
  const pathname = requestUrl.pathname;
  return pathname === '/api' || pathname.startsWith('/api/') || pathname === '/auth/login' || pathname === '/auth/logout' || pathname === '/health';
}

function fetchUpstreamBody(port: number, requestPath: string): Promise<string> {
  return new Promise((resolve, reject) => {
    const request = http.get({ hostname: '127.0.0.1', port, path: requestPath }, (response) => {
      let data = '';
      response.setEncoding('utf8');
      response.on('data', (chunk: string) => { data += chunk; });
      response.on('end', () => resolve(data));
    });
    request.on('error', reject);
  });
}

// The admin app's stylesheet is a flat, non-nested block (no @media/@supports), so a
// simple selector-by-selector rewrite is enough to scope it under our container div
// instead of the document root — this couples us to that structural assumption holding
// across upstream mcp-gateway versions.
function scopeAdminCss(css: string, scope: string): string {
  return css.replace(/([^{}]+)\{([^{}]*)\}/g, (_match, selectorList: string, body: string) => {
    const scoped = selectorList
      .split(',')
      .map((raw) => raw.trim())
      .filter(Boolean)
      .map((selector) => {
        if (selector === ':root' || selector === 'body') return scope;
        if (selector === '*') return `${scope}, ${scope} *`;
        return `${scope} ${selector}`;
      })
      .join(', ');
    return `${scoped} {${body}}`;
  });
}

async function renderMspAdminInline(mspGatewayPort: number): Promise<{ css: string; body: string } | null> {
  try {
    const html = await fetchUpstreamBody(mspGatewayPort, '/admin/');
    const styleMatch = html.match(/<style>([\s\S]*?)<\/style>/);
    const bodyMatch = html.match(/<body[^>]*>([\s\S]*?)<\/body>/);
    if (!bodyMatch) {
      return null;
    }
    return {
      css: styleMatch ? scopeAdminCss(styleMatch[1], '#msp-admin-root') : '',
      body: bodyMatch[1],
    };
  } catch {
    return null;
  }
}

async function handleDashboardRoutes(
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
    const inlineMspAdmin = tab === 'msp' ? (await renderMspAdminInline(runtime.mspGatewayPort)) ?? undefined : undefined;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(buildDashboardHtml({
      activeTab: tab,
      adminUiPort: runtime.adminUiPort,
      mspGatewayPort: runtime.mspGatewayPort,
      cbmUiPort: runtime.cbmUiPort,
      siyuanPort: runtime.siyuanPort,
      inlineMspAdmin,
    }));
    return true;
  }

  if (requestUrl.pathname === '/msp' || requestUrl.pathname === '/cbm' || requestUrl.pathname === '/siyuan') {
    const tab = requestUrl.pathname.slice(1) as 'msp' | 'cbm' | 'siyuan';
    const inlineMspAdmin = tab === 'msp' ? (await renderMspAdminInline(runtime.mspGatewayPort)) ?? undefined : undefined;
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(buildDashboardHtml({
      activeTab: tab,
      adminUiPort: runtime.adminUiPort,
      mspGatewayPort: runtime.mspGatewayPort,
      cbmUiPort: runtime.cbmUiPort,
      siyuanPort: runtime.siyuanPort,
      inlineMspAdmin,
    }));
    return true;
  }

  if (requestUrl.pathname === '/cbm/overview') {
    // Render directory names immediately from a fast fs scan; the persisted
    // index status (which shells out to the CBM CLI) is fetched async by the client.
    const resolvedRoot = resolveRuntimeWorkspaceRoot(runtime.cbmHostWorkspaceDir || runtime.cbmDefaultPath, runtime.cbmDefaultPath);
    const initialProjects = discoverProjectRoots(resolvedRoot).map((rootPath) => {
      const name = path.basename(rootPath) || 'project';
      return { name, project: name, path: rootPath, root_path: rootPath, status: 'checking', indexed: false };
    });

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

  if (requestUrl.pathname === '/cbm/graph' || requestUrl.pathname.startsWith('/cbm/graph/')) {
    // The graph UI process only binds to the container's loopback interface, so its own
    // port isn't reachable via the docker port mapping; proxy it through the dashboard port.
    const upstreamPath = `${requestUrl.pathname.replace(/^\/cbm\/graph/, '') || '/'}${requestUrl.search}`;
    proxyRequestToUpstream(req, res, runtime.cbmUiPort, requestUrl, true, false, true, upstreamPath);
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
  locationRewrite?: { upstreamPrefix: string; mountPrefix: string },
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
      if (locationRewrite && typeof responseHeaders.location === 'string') {
        const { upstreamPrefix, mountPrefix } = locationRewrite;
        if (responseHeaders.location === upstreamPrefix || responseHeaders.location.startsWith(`${upstreamPrefix}/`)) {
          responseHeaders.location = mountPrefix + responseHeaders.location.slice(upstreamPrefix.length);
        }
      }
      const statusCode = upstreamResponse.statusCode || 502;
      if (statusCode >= 300 && statusCode < 400) {
        // Browsers cache redirects indefinitely even without explicit headers;
        // without this, a stale Location survives long after a routing fix.
        responseHeaders['cache-control'] = 'no-store';
      }
      res.writeHead(statusCode, responseHeaders);
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

  const server = http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url ?? '/', 'http://127.0.0.1');

    if (req.method === 'GET' && req.url === '/ping') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
      return;
    }

    if (await handleDashboardRoutes(req, res, requestUrl, runtime, dashboardEnabled)) {
      return;
    }

    if (handleCbmActionRoutes(req, res, requestUrl, runtime, dashboardEnabled)) {
      return;
    }

    if (dashboardEnabled && isCbmUiRequest(req, requestUrl)) {
      proxyRequestToUpstream(req, res, runtime.cbmUiPort, requestUrl, true, false, true);
      return;
    }

    if (dashboardEnabled && isMspAdminApiRequest(requestUrl)) {
      proxyRequestToUpstream(req, res, runtime.mspGatewayPort, requestUrl, true, false, true);
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

  const server = http.createServer(async (req, res) => {
    const requestUrl = new URL(req.url ?? '/', 'http://127.0.0.1');

    if (req.method === 'GET' && req.url === '/ping') {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('ok');
      return;
    }

    if (await handleDashboardRoutes(req, res, requestUrl, runtime, dashboardEnabled)) {
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
