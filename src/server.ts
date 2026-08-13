import express from 'express';
import { registerLMStudioTools } from './tools/lmstudioLoopback';
import { VaultService } from './services/vaultService';

const mcpServer = {
  registerTool: (tool: any) => {
    console.log(`Registering tool: ${tool.name}`);
  },
};

const app = express();
app.use(express.json());

const vaultService = new VaultService();

// Register tools
registerLMStudioTools(mcpServer.registerTool, vaultService);

const port = Number(process.env.PORT || 8080);
app.listen(port, () => {
  console.log(`MCP Supergateway server running on port ${port}`);
});
