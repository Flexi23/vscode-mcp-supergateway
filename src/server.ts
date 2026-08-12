import express from 'express';
import { registerLMStudioTools } from './tools/lmstudioLoopback';

// Mocking an mcpServer object for now as the exact SDK is not specified
const mcpServer = {
  registerTool: (tool: any) => {
    console.log(`Registering tool: ${tool.name}`);
  },
};

const app = express();
app.use(express.json());

// Register tools
registerLMStudioTools(mcpServer);

app.listen(8080, () => {
  console.log('MCP Supergateway server running on port 8080');
});
