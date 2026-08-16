import express from 'express';
import { registerLMStudioTools } from './tools/lmstudioLoopback';
import { siyuanClient } from './services/siyuanClient';

// Exported so gateway.ts can run this in the same process instead of a second container.
export function startBackendServer(port: number = Number(process.env.PORT || 8081)) {
  const mcpServer = {
    registerTool: (tool: any) => {
      console.log(`Registering tool: ${tool.name}`);
    },
  };

  const app = express();
  app.use(express.json());
  app.use((req, res, next) => {
    console.log(`${req.method} ${req.url}`);
    next();
  });

  // Register tools
  registerLMStudioTools(mcpServer.registerTool, siyuanClient);

  return app.listen(port, () => {
    console.log(`MCP Supergateway backend running on port ${port}`);
  });
}

// Allow `node dist/server.js` to keep working standalone for local dev.
if (require.main === module) {
  startBackendServer();
}
