const http = require('http');

function parseArgs(argv) {
  const options = { port: 8080, target: 'http://127.0.0.1:3100' };

  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] === '--port' && argv[index + 1]) {
      options.port = Number(argv[index + 1]);
      index += 1;
    } else if (argv[index] === '--target' && argv[index + 1]) {
      options.target = argv[index + 1];
      index += 1;
    }
  }

  return options;
}

function startProxy(options) {
  const target = new URL(options.target);
  const server = http.createServer((request, response) => {
    if (request.method === 'GET' && request.url === '/ping') {
      response.writeHead(200, { 'content-type': 'text/plain' });
      response.end('ok');
      return;
    }

    const headers = { ...request.headers, host: target.host };
    const upstreamRequest = http.request({
      protocol: target.protocol,
      hostname: target.hostname,
      port: target.port,
      method: request.method,
      path: request.url,
      headers
    }, (upstreamResponse) => {
      response.writeHead(upstreamResponse.statusCode || 502, upstreamResponse.headers);
      upstreamResponse.pipe(response);
    });

    upstreamRequest.on('error', (error) => {
      if (!response.headersSent) {
        response.writeHead(502, { 'content-type': 'application/json' });
      }
      response.end(JSON.stringify({
        jsonrpc: '2.0',
        error: { code: -32000, message: `Gateway upstream unavailable: ${error.message}` },
        id: null
      }));
    });

    request.on('aborted', () => upstreamRequest.destroy());
    request.pipe(upstreamRequest);
  });

  server.listen(options.port, '127.0.0.1', () => {
    console.log(`[proxy] forwarding http://127.0.0.1:${options.port} to ${target.origin}`);
  });

  return server;
}

if (require.main === module) {
  startProxy(parseArgs(process.argv.slice(2)));
}

module.exports = { parseArgs, startProxy };