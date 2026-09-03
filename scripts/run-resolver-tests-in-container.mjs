import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dockerfile = path.join(projectRoot, 'Dockerfile');

if (!existsSync(dockerfile)) {
  throw new Error(`Dockerfile not found at ${dockerfile}`);
}

const imageName = 'vscode-mcp-supergateway:test-runtime';

const buildArgs = [
  'build',
  '-t', imageName,
  '--target', 'test',
  projectRoot,
];

console.log('Building test image with the gateway runtime environment...');
execFileSync('docker', buildArgs, { stdio: 'inherit' });

console.log('Running resolver tests inside the built image...');
execFileSync('docker', ['run', '--rm', '--init', imageName], { stdio: 'inherit' });
