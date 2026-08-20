import http from 'http';
import { buildCbmOverviewHtml, buildDashboardHtml } from './dashboard';
import { discoverProjectRoots, enrichRepositorySemanticEdges, getIndexJobsSnapshot, indexRepository } from './codebaseMemory';

export interface ProxyRuntimeConfig {
  adminUiPort: number;
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
    const tab = requestUrl.searchParams.get('tab') ?? 'admin';
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(buildDashboardHtml({ activeTab: tab, adminUiPort: runtime.adminUiPort, cbmUiPort: runtime.cbmUiPort }));
    return true;
  }

  if (requestUrl.pathname === '/cbm/overview') {
    res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    res.end(buildCbmOverviewHtml({
      cbmDefaultPath: runtime.cbmDefaultPath,
      cbmHostWorkspaceDir: runtime.cbmHostWorkspaceDir,
      cbmUiPort: runtime.cbmUiPort,
    }));
    return true;
  }

  if (requestUrl.pathname === '/cbm/index-status') {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify(getIndexJobsSnapshot()));
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
    const requestedPath = requestUrl.searchParams.get('path') ?? '';
    const allowedRoots = discoverProjectRoots(runtime.cbmDefaultPath);
    if (!allowedRoots.includes(requestedPath)) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unknown or disallowed project path' }));
      return true;
    }
    indexRepository(runtime.cbmCacheDir, requestedPath);
    res.writeHead(202, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ status: 'started', path: requestedPath }));
    return true;
  }

  if (requestUrl.pathname === '/cbm/enrich') {
    const requestedPath = requestUrl.searchParams.get('path') ?? '';
    const allowedRoots = discoverProjectRoots(runtime.cbmDefaultPath);
    if (!allowedRoots.includes(requestedPath)) {
      res.writeHead(400, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: 'unknown or disallowed project path' }));
      return true;
    }
    enrichRepositorySemanticEdges(runtime.cbmCacheDir, requestedPath);
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
) {
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
    cbmUiPort,
    cbmDefaultPath,
    cbmCacheDir,
    cbmHostWorkspaceDir,
  } = options;

  const runtime: ProxyRuntimeConfig = {
    adminUiPort,
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

  server.listen(port, bindHost, () => {
    console.log(`[proxy] forwarding ${bindHost}:${port} -> 127.0.0.1:${targetPort}`);
  });
}
