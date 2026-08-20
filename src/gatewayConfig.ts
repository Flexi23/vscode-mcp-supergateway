import fs from 'fs';
import path from 'path';
import { requireEnv } from './config/env';

export interface UpstreamConfig {
  id: string;
  namespace: string;
  transport: string;
  command: string;
  args: string[];
  env?: Record<string, string>;
}

export interface GatewayConfig {
  upstreams: UpstreamConfig[];
}

export function ensureDir(dir: string) {
  fs.mkdirSync(dir, { recursive: true });
  try {
    fs.chmodSync(dir, 0o700);
  } catch {
    // Some mounts may reject chmod; ignore, the important thing is the exact
    // path stays private and root-owned in the container.
  }
}

export function normalizeContainerPath(envName: string, fallback: string): string {
  const rawValue = requireEnv(envName);
  if (/^[A-Za-z]:[\\/]/.test(rawValue)) {
    console.warn(`[config] ${envName} points at a host Windows path (${rawValue}); using ${fallback} inside the container instead so the CBM UI resolves the Linux workspace root correctly.`);
    return fallback;
  }
  return rawValue || fallback;
}

export function resetGatewayPersistentState(dataDir: string, cbmCacheDir: string) {
  const staleFiles = ['gateway.db', 'gateway.db-shm', 'gateway.db-wal', 'admin-gateway-config.json'];
  let removed = 0;

  for (const fileName of staleFiles) {
    const filePath = path.join(dataDir, fileName);
    if (fs.existsSync(filePath)) {
      fs.rmSync(filePath, { force: true, recursive: true });
      removed += 1;
      console.log(`[gateway] removed stale gateway state: ${fileName}`);
    }
  }

  const cbmCachePath = path.join(dataDir, 'cbm-cache');
  if (fs.existsSync(cbmCachePath)) {
    fs.rmSync(cbmCachePath, { force: true, recursive: true });
    removed += 1;
    console.log(`[gateway] removed stale cbm cache: ${cbmCachePath}`);
  }

  if (fs.existsSync(cbmCacheDir)) {
    const runtimeStateFiles = ['config.json', '_config.db', '_config.db-shm', '_config.db-wal'];
    for (const fileName of runtimeStateFiles) {
      const filePath = path.join(cbmCacheDir, fileName);
      if (fs.existsSync(filePath)) {
        fs.rmSync(filePath, { force: true, recursive: true });
        removed += 1;
        console.log(`[gateway] removed stale CBM runtime state: ${filePath}`);
      }
    }

    for (const entry of fs.readdirSync(cbmCacheDir)) {
      if (/^(cbm-|.*\.(sock|lock|anc))$/.test(entry)) {
        const filePath = path.join(cbmCacheDir, entry);
        fs.rmSync(filePath, { force: true, recursive: true });
        removed += 1;
        console.log(`[gateway] removed stale CBM daemon state: ${filePath}`);
      }
    }
  }

  if (removed > 0) {
    console.log(`[gateway] reset persisted gateway state (${removed} item(s)) so the current config is reloaded from scratch.`);
  }
}

export function cleanupStaleCodebaseMemoryDaemon() {
  try {
    const tmpRoot = '/tmp';
    if (!fs.existsSync(tmpRoot)) {
      return;
    }

    const entries = fs.readdirSync(tmpRoot, { withFileTypes: true });
    for (const entry of entries) {
      if (!entry.name.startsWith('cbm-daemon-')) {
        continue;
      }

      const target = path.join(tmpRoot, entry.name);
      try {
        fs.rmSync(target, { recursive: true, force: true });
        console.log(`[codebase-memory] cleaned stale daemon state at ${target}`);
      } catch (error) {
        console.warn(`[codebase-memory] failed to remove stale daemon state at ${target}:`, error);
      }
    }
  } catch (error) {
    console.warn('[codebase-memory] failed to inspect stale daemon state:', error);
  }
}

export function buildAdminConfig(cbmCacheDir: string): GatewayConfig {
  const configPath = path.join(__dirname, '..', 'docker', 'gateway.config.json');
  const config: GatewayConfig = JSON.parse(fs.readFileSync(configPath, 'utf8'));
  const siYuanTokenRequired = process.env.SIYUAN_TOKEN_REQUIRED === 'true';

  for (const upstream of config.upstreams) {
    if (upstream.id === 'gitlab') {
      const gitlabApiUrl = requireEnv('GITLAB_API_URL');
      const gitlabToken = requireEnv('GITLAB_PERSONAL_ACCESS_TOKEN');
      upstream.env = { ...upstream.env, GITLAB_API_URL: gitlabApiUrl, GITLAB_PERSONAL_ACCESS_TOKEN: gitlabToken };
    }
    if (upstream.id === 'siyuan-note') {
      const siYuanToken = process.env.SIYUAN_TOKEN ?? '';
      upstream.env = {
        ...upstream.env,
        SIYUAN_HOST: 'siyuan',
        SIYUAN_PORT: '6806',
        SIYUAN_TOKEN: siYuanToken,
        SIYUAN_TOKEN_REQUIRED: String(siYuanTokenRequired),
      };
      if (siYuanTokenRequired && (!siYuanToken || ['Supergateway', 'siyuan_api_token_here', 'your-api-token-here'].includes(siYuanToken))) {
        throw new Error('[siyuan-note] SIYUAN_TOKEN_REQUIRED=true but SIYUAN_TOKEN is missing or still a placeholder value. Set the real token in the active .env file and compose environment.');
      }
    }
    if (upstream.id === 'codebase-memory') {
      upstream.env = { ...upstream.env, CBM_CACHE_DIR: cbmCacheDir };
    }
  }

  return config;
}
