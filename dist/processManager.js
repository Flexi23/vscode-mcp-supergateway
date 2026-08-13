"use strict";
var __importDefault = (this && this.__importDefault) || function (mod) {
    return (mod && mod.__esModule) ? mod : { "default": mod };
};
Object.defineProperty(exports, "__esModule", { value: true });
exports.ProcessManager = void 0;
const child_process_1 = require("child_process");
const fs_1 = __importDefault(require("fs"));
const path_1 = __importDefault(require("path"));
const os_1 = __importDefault(require("os"));
class ProcessManager {
    gatewayProcess = null;
    configPath;
    workspaceRoot;
    constructor(configPath) {
        this.workspaceRoot = path_1.default.resolve(path_1.default.dirname(configPath || path_1.default.join(process.cwd(), 'vscode', 'supergateway.config.json')));
        this.configPath = configPath ? path_1.default.resolve(configPath) : path_1.default.join(this.workspaceRoot, 'vscode', 'supergateway.config.json');
    }
    getConfig() {
        const raw = fs_1.default.readFileSync(this.configPath, 'utf8');
        return JSON.parse(raw);
    }
    async start() {
        const config = this.getConfig();
        let publicPort = 8080;
        if (config.ports && config.ports.public)
            publicPort = config.ports.public;
        else if (config.ports && config.ports.publicPort)
            publicPort = config.ports.publicPort;
        else if (config.publicPort)
            publicPort = config.publicPort;
        let adminPort = 3100;
        if (config.ports && config.ports.admin)
            adminPort = config.ports.admin;
        else if (config.ports && config.ports.adminPort)
            adminPort = config.ports.adminPort;
        else if (config.adminPort)
            adminPort = config.adminPort;
        const upstreams = config.upstreams || [];
        // Apply upstream configurations
        for (const entry of upstreams) {
            if (entry.id === 'codebase-memory') {
                if (entry.config) {
                    for (const [key, value] of Object.entries(entry.config)) {
                        (0, child_process_1.spawnSync)('npx', ['-y', 'codebase-memory-mcp', 'config', 'set', key, String(value)], { stdio: 'ignore' });
                    }
                }
            }
        }
        // Set environment variables
        const env = { ...process.env };
        env.DEV_ALLOW_UNAUTHENTICATED = 'true';
        env.MCP_GATEWAY_PORT = String(adminPort);
        env.PORT = String(adminPort);
        env.DB_PATH = this.getAdminDbPath();
        env.CI = 'true';
        env.CBM_LOG_LEVEL = 'error';
        env.CBM_CACHE_DIR = this.getCbmCacheDir();
        // Start gateway
        const gatewayArgs = ['-y', 'mcp-gateway'];
        this.gatewayProcess = (0, child_process_1.spawn)('npx', gatewayArgs, {
            env,
            cwd: this.workspaceRoot,
            stdio: 'inherit',
        });
        this.gatewayProcess.on('error', (err) => {
            console.error('Gateway process error:', err);
        });
        this.gatewayProcess.on('exit', (code) => {
            console.log(`Gateway process exited with code ${code}`);
            this.gatewayProcess = null;
        });
    }
    async stop() {
        if (this.gatewayProcess) {
            this.gatewayProcess.kill();
            this.gatewayProcess = null;
        }
    }
    async status() {
        const config = this.getConfig();
        const upstreams = config.upstreams || [];
        const status = {
            gateway: this.gatewayProcess ? { status: 'running', pid: this.gatewayProcess.pid } : { status: 'stopped' },
            upstreams: upstreams.map((entry) => ({
                id: entry.id,
                transport: entry.transport,
                command: entry.command,
                args: entry.args
            }))
        };
        return status;
    }
    async resetCodebaseMemory() {
        const cacheDir = this.getCbmCacheDir();
        if (fs_1.default.existsSync(cacheDir)) {
            const files = fs_1.default.readdirSync(cacheDir);
            for (const file of files) {
                if (file.startsWith('gateway.db')) {
                    fs_1.default.unlinkSync(path_1.default.join(cacheDir, file));
                }
            }
        }
        console.log('Codebase memory reset.');
    }
    getAdminDbPath() {
        const adminConfigDir = path_1.default.join(this.workspaceRoot, 'vscode', 'data');
        if (!fs_1.default.existsSync(adminConfigDir)) {
            fs_1.default.mkdirSync(adminConfigDir, { recursive: true });
        }
        return path_1.default.join(adminConfigDir, 'gateway.db');
    }
    getCbmCacheDir() {
        const baseDir = os_1.default.platform() === 'win32' ? process.env.LOCALAPPDATA : process.env.TMP;
        const cacheDir = path_1.default.join(baseDir || os_1.default.tmpdir(), 'supergateway-cbm-cache');
        if (!fs_1.default.existsSync(cacheDir)) {
            fs_1.default.mkdirSync(cacheDir, { recursive: true });
        }
        return cacheDir;
    }
}
exports.ProcessManager = ProcessManager;
