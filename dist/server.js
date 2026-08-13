"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
const express_1 = __importDefault(require("express"));
const lmstudioLoopback_1 = require("./tools/lmstudioLoopback");
const vaultService_1 = require("./services/vaultService");
const mcpServer = {
    registerTool: (tool) => {
        console.log(`Registering tool: ${tool.name}`);
    },
};
const app = (0, express_1.default)();
app.use(express_1.default.json());
const vaultService = new vaultService_1.VaultService();
// Register tools
(0, lmstudioLoopback_1.registerLMStudioTools)(mcpServer.registerTool, vaultService);
app.listen(8080, () => {
    console.log('MCP Supergateway server running on port 8080');
});
