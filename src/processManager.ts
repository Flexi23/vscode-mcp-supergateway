import { spawn, spawnSync, ChildProcess } from 'child_process';
import fs from 'fs';
import path from 'path';
import os from 'os';

export class ProcessManager {
  private gatewayProcess: ChildProcess | null = null;
  private readonly configPath: string;
  private readonly workspaceRoot: string;

  constructor(configPath?: string) {
    this.workspaceRoot = path.resolve(path.dirname(configPath || path.join(process.cwd(), 'docker', 'gateway.config.json')));
    this.configPath = configPath ? path.resolve(configPath) : path.join(this.workspaceRoot, 'docker', 'gateway.config.json');
  }

  private getConfig() {
    const raw = fs.readFileSync(this.configPath, 'utf8');
    return JSON.parse(raw);
  }

  async start() {
    const config = this.getConfig();
    
    let publicPort = 8080;
    if (config.ports && config.ports.public) publicPort = config.ports.public;
    else if (config.ports && config.ports.publicPort) publicPort = config.ports.publicPort;
    else if (config.publicPort) publicPort = config.publicPort;

    let adminPort = 3100;
    if (config.ports && config.ports.admin) adminPort = config.ports.admin;
    else if (config.ports && config.ports.adminPort) adminPort = config.ports.adminPort;
    else if (config.adminPort) adminPort = config.adminPort;

    const upstreams = config.upstreams || [];
    
    // Apply upstream configurations
    for (const entry of upstreams) {
      if (entry.id === 'codebase-memory') {
        if (entry.config) {
          for (const [key, value] of Object.entries(entry.config)) {
            spawnSync('npx', ['-y', 'codebase-memory-mcp', 'config', 'set', key, String(value)], { stdio: 'ignore' });
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
    this.gatewayProcess = spawn('npx', gatewayArgs, {
      env,
      cwd: this.workspaceRoot,
      stdio: 'inherit',
    });

    this.gatewayProcess.on('error', (err: Error) => {
      console.error('Gateway process error:', err);
    });

    this.gatewayProcess.on('exit', (code: number | null) => {
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
      upstreams: upstreams.map((entry: any) => ({
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
    if (fs.existsSync(cacheDir)) {
      const files = fs.readdirSync(cacheDir);
      for (const file of files) {
        if (file.startsWith('gateway.db')) {
          fs.unlinkSync(path.join(cacheDir, file));
        }
      }
    }
    console.log('Codebase memory reset.');
  }

  private getAdminDbPath() {
    const adminConfigDir = path.join(this.workspaceRoot, 'vscode', 'data');
    if (!fs.existsSync(adminConfigDir)) {
      fs.mkdirSync(adminConfigDir, { recursive: true });
    }
    return path.join(adminConfigDir, 'gateway.db');
  }

  private getCbmCacheDir() {
    const baseDir = os.platform() === 'win32' ? process.env.LOCALAPPDATA : process.env.TMP;
    const cacheDir = path.join(baseDir || os.tmpdir(), 'supergateway-cbm-cache');
    if (!fs.existsSync(cacheDir)) {
      fs.mkdirSync(cacheDir, { recursive: true });
    }
    return cacheDir;
  }
}
