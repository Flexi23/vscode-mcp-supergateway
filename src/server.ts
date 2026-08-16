import express from 'express';
import { registerLMStudioTools } from './tools/lmstudioLoopback';
import { VaultManager } from './services/vaultManager';

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

  const vaultManager = new VaultManager();

  // Register tools
  registerLMStudioTools(mcpServer.registerTool, vaultManager);

  // Test Routes
  app.get('/api/vault/notes', async (req, res) => {
    try {
      const notes = await vaultManager.listNotes();
      res.json({ success: true, notes });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.post('/api/vault/notes', async (req, res) => {
    try {
      const { path, content } = req.body;
      if (!path || !content) {
        return res.status(400).json({ success: false, error: 'Missing path or content' });
      }
      await vaultManager.writeNote(path, content);
      res.json({ success: true });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  app.get('/api/vault/notes/:path', async (req, res) => {
    try {
      const content = await vaultManager.readNote(req.params.path);
      res.json({ success: true, content });
    } catch (err: any) {
      res.status(500).json({ success: false, error: err.message });
    }
  });

  return app.listen(port, () => {
    console.log(`MCP Supergateway backend running on port ${port}`);
  });
}

// Allow `node dist/server.js` to keep working standalone for local dev.
if (require.main === module) {
  startBackendServer();
}
