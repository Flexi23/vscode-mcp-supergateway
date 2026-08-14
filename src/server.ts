import express from 'express';
import { registerLMStudioTools } from './tools/lmstudioLoopback';
import { VaultManager } from './services/vaultManager';

const mcpServer = {
  registerTool: (tool: any) => {
    console.log(`Registering tool: ${tool.name}`);
  },
};

const app = express();
app.use(express.json());

const vaultManager = new VaultManager();

// Register tools
registerLMStudioTools(mcpServer.registerTool, vaultManager);

app.listen(8080, () => {
  console.log('MCP Supergateway server running on port 8080');
});
