import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

execSync('npm run build', { stdio: 'inherit' });
const { SemanticEdgeResolutionStrategyDispatcher, TypeScriptDependencyResolver } = await import('./dist/services/semanticEdgeResolutionStrategyDispatcher.js');
const { DotNetDependencyResolver } = await import('./dist/services/dotnetDependencyResolver.js');
const { setIndexJobUpdateListener, updateIndexJobState } = await import('./dist/codebaseMemory.js');
const { matchToolToUpstream } = await import('./dist/startupLogClassifier.js');
const { buildCbmOverviewHtml, buildDashboardHtml } = await import('./dist/dashboard.js');

test('dashboard exposes route-based iframe tabs and the MSP stack UI', () => {
  const html = buildDashboardHtml({
    activeTab: 'msp',
    adminUiPort: 3100,
    mspGatewayPort: 3110,
    cbmUiPort: 9749,
    siyuanPort: 6806,
  });

  assert.match(html, /href="\/msp"/);
  assert.match(html, /href="\/cbm"/);
  assert.match(html, /href="\/siyuan"/);
  assert.match(html, /<iframe/);
  assert.match(html, /http:\/\/127\.0\.0\.1:3100\/msp-admin/);
  assert.doesNotMatch(html, /http:\/\/127\.0\.0\.1:3110\/admin/);
});

test('status enum distinguishes unchecked, idle, checking and active, and hides actions for unchecked rows', () => {
  const html = buildCbmOverviewHtml({
    cbmUiPort: 9749,
    initialProjects: [
      { name: 'vre', root_path: '/workspace/vre', status: 'unchecked', indexed: false },
      { name: 'limati-blazor-ui-kit', root_path: '/workspace/limati-blazor-ui-kit', status: 'idle', indexed: false },
      { name: 'vrm', root_path: '/workspace/vrm', status: 'success', indexed: true },
    ],
  });

  assert.match(html, /\.status-pill\.active/);
  assert.match(html, /\.status-pill\.ingesting-semantics/);
  assert.match(html, /state === 'unchecked'/);
  assert.match(html, /state === 'idle'/);
  assert.match(html, /state === 'checking'/);
  assert.match(html, /state === 'active'/);
  assert.match(html, /if \(state === 'active'\)/);
  assert.match(html, /if \(state === 'idle'\)/);
  assert.match(html, /if \(state === 'unchecked'\)/);
  assert.match(html, /actionsEl\.innerHTML = '';/);
});

test('cbm overview renders the full workspace directory list immediately and starts every row unchecked', () => {
  const html = buildCbmOverviewHtml({
    cbmUiPort: 9749,
    initialProjects: [
      { name: 'vre', root_path: '/workspace/vre', status: 'unchecked', indexed: false },
      { name: 'limati-blazor-ui-kit', root_path: '/workspace/limati-blazor-ui-kit', status: 'unchecked', indexed: false },
      { name: 'vrm', root_path: '/workspace/vrm', status: 'unchecked', indexed: false },
    ],
  });

  assert.match(html, /vre/);
  assert.match(html, /limati-blazor-ui-kit/);
  assert.match(html, /vrm/);
  assert.match(html, /data-state="unchecked"/);
  assert.match(html, /if \(state === 'unchecked'\) \{\s*actionsEl\.innerHTML = '';/s);
  assert.match(html, /if \(state === 'idle'\) \{/);
  assert.doesNotMatch(html, /Loading projects/i);
  assert.match(html, /<tbody id="project-table-body">/);
});

test('workspace root detection falls back to the container path when a Windows host path is passed', async () => {
  const { resolveRuntimeWorkspaceRoot } = await import('./dist/codebaseMemory.js');
  const fallbackRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cbm-runtime-root-'));
  const resolved = resolveRuntimeWorkspaceRoot('C:\\gitlab.uni-rostock.de\\limati-inf', fallbackRoot);
  assert.equal(resolved, fallbackRoot);
});

test('dashboard project rows keep all workspace directories and mark only success rows as graph-ready', async () => {
  const { mergeWorkspaceProjectRows } = await import('./dist/codebaseMemory.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-project-rows-'));
  const cacheDir = path.join(root, 'cache');
  fs.mkdirSync(path.join(root, 'alpha'), { recursive: true });
  fs.mkdirSync(path.join(root, 'beta'), { recursive: true });
  fs.mkdirSync(path.join(root, 'gamma'), { recursive: true });
  fs.mkdirSync(cacheDir, { recursive: true });

  const previousFixture = process.env.CBM_LIST_PROJECTS_FIXTURE;
  process.env.CBM_LIST_PROJECTS_FIXTURE = JSON.stringify({
    projects: [
      { name: 'alpha', project: 'alpha', path: path.join(root, 'alpha'), root_path: path.join(root, 'alpha'), status: 'success' },
      { name: 'beta', project: 'beta', path: path.join(root, 'beta'), root_path: path.join(root, 'beta'), status: 'idle' },
      { name: 'gamma', project: 'gamma', path: path.join(root, 'gamma'), root_path: path.join(root, 'gamma'), status: 'checking' },
    ],
  });

  try {
    const rows = mergeWorkspaceProjectRows(root, cacheDir);
    const rowMap = new Map(rows.map((row) => [String(row.root_path ?? row.path ?? row.project), row]));

    assert.equal(rows.length, 3);
    assert.ok(rowMap.has(path.join(root, 'alpha')));
    assert.equal(rowMap.get(path.join(root, 'alpha'))?.indexed, true);
    assert.equal(rowMap.get(path.join(root, 'beta'))?.indexed, false);
    assert.equal(rowMap.get(path.join(root, 'gamma'))?.indexed, false);
  } finally {
    if (previousFixture === undefined) delete process.env.CBM_LIST_PROJECTS_FIXTURE;
    else process.env.CBM_LIST_PROJECTS_FIXTURE = previousFixture;
  }
});

test('idle project rows returned by the CBM CLI are not treated as indexed just because they exist', async () => {
  const { mergeWorkspaceProjectRows } = await import('./dist/codebaseMemory.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-cli-idle-'));
  const cacheDir = path.join(root, 'cache');
  fs.mkdirSync(path.join(root, 'alpha'), { recursive: true });
  fs.mkdirSync(path.join(root, 'beta'), { recursive: true });
  fs.mkdirSync(cacheDir, { recursive: true });

  const alphaPath = path.join(root, 'alpha');
  const betaPath = path.join(root, 'beta');
  const previousFixture = process.env.CBM_LIST_PROJECTS_FIXTURE;
  process.env.CBM_LIST_PROJECTS_FIXTURE = JSON.stringify({
    projects: [
      { name: 'alpha', project: 'alpha', path: alphaPath, root_path: alphaPath, status: 'idle' },
      { name: 'beta', project: 'beta', path: betaPath, root_path: betaPath, status: 'idle' },
    ],
  });

  try {
    const rows = mergeWorkspaceProjectRows(root, cacheDir);
    const rowMap = new Map(rows.map((row) => [String(row.root_path ?? row.path ?? row.project), row]));
    assert.equal(rowMap.get(alphaPath)?.indexed, false);
    assert.equal(rowMap.get(betaPath)?.indexed, false);
  } finally {
    if (previousFixture === undefined) delete process.env.CBM_LIST_PROJECTS_FIXTURE;
    else process.env.CBM_LIST_PROJECTS_FIXTURE = previousFixture;
  }
});

test('project list uses the CBM list_projects command instead of reading the SQLite cache', async () => {
  const { listCodebaseMemoryProjects } = await import('./dist/codebaseMemory.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-cache-fast-'));
  const cacheDir = path.join(root, 'cache');
  fs.mkdirSync(cacheDir, { recursive: true });

  const alphaPath = path.join(root, 'alpha');
  const betaPath = path.join(root, 'beta');
  const previousFixture = process.env.CBM_LIST_PROJECTS_FIXTURE;
  process.env.CBM_LIST_PROJECTS_FIXTURE = JSON.stringify({
    projects: [
      { name: 'alpha', project: 'alpha', path: alphaPath, root_path: alphaPath, status: 'idle' },
      { name: 'beta', project: 'beta', path: betaPath, root_path: betaPath, status: 'success' },
    ],
  });

  try {
    const projects = listCodebaseMemoryProjects(cacheDir);
    assert.equal(projects.length, 2);
    assert.deepEqual(projects.map((project) => project.name).sort(), ['alpha', 'beta']);
    assert.equal(projects.find((project) => project.name === 'alpha')?.status, 'idle');
    assert.equal(projects.find((project) => project.name === 'beta')?.status, 'success');
  } finally {
    if (previousFixture === undefined) delete process.env.CBM_LIST_PROJECTS_FIXTURE;
    else process.env.CBM_LIST_PROJECTS_FIXTURE = previousFixture;
  }
});

test('stale persisted project rows are not treated as indexed unless a real success status exists', async () => {
  const { mergeWorkspaceProjectRows } = await import('./dist/codebaseMemory.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-stale-db-'));
  const cacheDir = path.join(root, 'cache');
  fs.mkdirSync(path.join(root, 'alpha'), { recursive: true });
  fs.mkdirSync(path.join(root, 'beta'), { recursive: true });
  fs.mkdirSync(cacheDir, { recursive: true });

  const alphaPath = path.join(root, 'alpha');
  const betaPath = path.join(root, 'beta');
  const previousFixture = process.env.CBM_LIST_PROJECTS_FIXTURE;
  process.env.CBM_LIST_PROJECTS_FIXTURE = JSON.stringify({
    projects: [
      { name: 'alpha', project: 'alpha', path: alphaPath, root_path: alphaPath, status: 'idle' },
      { name: 'beta', project: 'beta', path: betaPath, root_path: betaPath, status: 'idle' },
    ],
  });

  try {
    const rows = mergeWorkspaceProjectRows(root, cacheDir);
    const rowMap = new Map(rows.map((row) => [String(row.root_path ?? row.path ?? row.project), row]));

    assert.equal(rowMap.get(path.join(root, 'alpha'))?.indexed, false);
    assert.equal(rowMap.get(path.join(root, 'beta'))?.indexed, false);
    assert.equal(rowMap.get(path.join(root, 'alpha'))?.status, 'idle');
  } finally {
    if (previousFixture === undefined) delete process.env.CBM_LIST_PROJECTS_FIXTURE;
    else process.env.CBM_LIST_PROJECTS_FIXTURE = previousFixture;
  }
});

test('workspace host paths and /workspace paths merge to the same project rows and keep success statuses active', async () => {
  const { mergeWorkspaceProjectRows } = await import('./dist/codebaseMemory.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'workspace-host-merge-'));
  const cacheDir = path.join(root, 'cache');
  fs.mkdirSync(path.join(root, 'vrm'), { recursive: true });
  fs.mkdirSync(path.join(root, 'limati-blazor-ui-kit'), { recursive: true });
  fs.mkdirSync(cacheDir, { recursive: true });

  const previousFixture = process.env.CBM_LIST_PROJECTS_FIXTURE;
  process.env.CBM_LIST_PROJECTS_FIXTURE = JSON.stringify({
    projects: [
      { name: 'vrm', project: 'vrm', path: '/workspace/vrm', root_path: '/workspace/vrm', status: 'success' },
      { name: 'limati-blazor-ui-kit', project: 'limati-blazor-ui-kit', path: '/workspace/limati-blazor-ui-kit', root_path: '/workspace/limati-blazor-ui-kit', status: 'success' },
    ],
  });

  try {
    const rows = mergeWorkspaceProjectRows(root, cacheDir);
    const rowMap = new Map(rows.map((row) => [String(row.root_path ?? row.path ?? row.project), row]));

    assert.ok(rowMap.has(path.join(root, 'vrm')));
    assert.ok(rowMap.has(path.join(root, 'limati-blazor-ui-kit')));
    assert.equal(rowMap.get(path.join(root, 'vrm'))?.indexed, true);
    assert.equal(rowMap.get(path.join(root, 'limati-blazor-ui-kit'))?.indexed, true);
    assert.equal(rowMap.get(path.join(root, 'vrm'))?.status, 'success');
    assert.equal(rowMap.get(path.join(root, 'limati-blazor-ui-kit'))?.status, 'success');
  } finally {
    if (previousFixture === undefined) delete process.env.CBM_LIST_PROJECTS_FIXTURE;
    else process.env.CBM_LIST_PROJECTS_FIXTURE = previousFixture;
  }
});

test('supergateway-rpc is registered as an MCP upstream beside semantic-bridge', () => {
  const config = JSON.parse(fs.readFileSync(path.join(process.cwd(), 'docker', 'gateway.config.json'), 'utf8'));
  const rpcUpstream = config.upstreams.find((upstream) => upstream.id === 'supergateway-rpc');

  assert.ok(rpcUpstream, 'supergateway-rpc upstream should exist');
  assert.equal(rpcUpstream.namespace, 'supergatewayrpc');
  assert.equal(rpcUpstream.transport, 'stdio');
  assert.ok(rpcUpstream.args.includes('/app/dist/supergatewayRpcMcp.js'));

  const row = matchToolToUpstream('supergatewayrpc_lmstudio_complete', config.upstreams);
  assert.ok(row);
  assert.equal(row.upstreamId, 'supergateway-rpc');
  assert.equal(row.toolName, 'lmstudio_complete');
});

test('index job changes notify live listeners for dashboard websocket propagation', () => {
  const seen = [];
  const previous = setIndexJobUpdateListener((path, job) => {
    seen.push({ path, job });
  });

  updateIndexJobState('/workspace/demo', {
    status: 'enriching',
    message: 'semantic edges',
    progress: 42,
    updatedAt: Date.now(),
  });

  assert.equal(seen.length, 1);
  assert.equal(seen[0].path, '/workspace/demo');
  assert.equal(seen[0].job.progress, 42);
  setIndexJobUpdateListener(previous);
});

test('persistent CBM project records initialize the overview as already indexed only when they are actually successful', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cbm-project-status-'));
  const cacheDir = path.join(root, 'cache');
  fs.mkdirSync(cacheDir, { recursive: true });

  const previousFixture = process.env.CBM_LIST_PROJECTS_FIXTURE;
  process.env.CBM_LIST_PROJECTS_FIXTURE = JSON.stringify({
    projects: [{ name: 'demo', project: 'demo', path: '/workspace/demo', root_path: '/workspace/demo', status: 'success' }],
  });

  try {
    const { clearIndexJobs, getIndexJobsSnapshot } = await import('./dist/codebaseMemory.js');
    clearIndexJobs();
    const jobs = getIndexJobsSnapshot(cacheDir);

    assert.equal(jobs['/workspace/demo']?.status, 'success');
    assert.equal(jobs['/workspace/demo']?.message, 'indexed (demo)');
  } finally {
    if (previousFixture === undefined) delete process.env.CBM_LIST_PROJECTS_FIXTURE;
    else process.env.CBM_LIST_PROJECTS_FIXTURE = previousFixture;
  }
});

test('collects and links .razor, .js, .ts and .md files', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-resolver-'));
  fs.mkdirSync(path.join(root, 'lib'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Pages'), { recursive: true });

  fs.writeFileSync(path.join(root, 'app.js'), "import './shared.js';\nimport { helper } from './lib/utils.ts';\n");
  fs.writeFileSync(path.join(root, 'shared.js'), 'export const flag = true;\n');
  fs.writeFileSync(path.join(root, 'lib', 'utils.ts'), 'export const helper = 1;\n');
  fs.writeFileSync(path.join(root, 'Pages', 'Demo.razor'), '<PageTitle>Demo</PageTitle>\n<SharedWidget />\n');
  fs.writeFileSync(path.join(root, 'Pages', 'SharedWidget.razor'), '<div>widget</div>\n');
  fs.writeFileSync(path.join(root, 'README.md'), '[Demo](./Pages/Demo.razor)\n\nSee [shared script](./shared.js)\n');

  const extractor = new SemanticEdgeResolutionStrategyDispatcher(root);
  const files = extractor.collectSemanticFiles(root);

  assert.ok(files.some((file) => file.fsPath.endsWith('.razor')));
  assert.ok(files.some((file) => file.fsPath.endsWith('.js')));
  assert.ok(files.some((file) => file.fsPath.endsWith('.ts')));
  assert.ok(files.some((file) => file.fsPath.endsWith('.md')));

  const links = await extractor.extractEdgesFromFilesystem(root);
  assert.ok(links.some((link) => link.source.endsWith('app.js') && link.target.endsWith('shared.js')));
  assert.ok(links.some((link) => link.source.endsWith('README.md') && link.target.endsWith('Pages/Demo.razor')));
  assert.ok(links.some((link) => link.source.endsWith('app.js') && link.target.endsWith('lib/utils.ts')));
});

test('DotNetDependencyResolver resolves C# references via Roslyn', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dotnet-semantic-resolver-'));
  fs.mkdirSync(path.join(root, 'src'), { recursive: true });

  fs.writeFileSync(path.join(root, 'src', 'Alpha.cs'), 'namespace Demo;\npublic class Alpha { public Beta Value { get; set; } }\n');
  fs.writeFileSync(path.join(root, 'src', 'Beta.cs'), 'namespace Demo;\npublic class Beta { }\n');

  const resolver = new DotNetDependencyResolver(root);
  const links = await resolver.extractEdges(root);
  const normalizedLinks = links.map((link) => ({
    source: link.source.replace(/\\/g, '/'),
    target: link.target.replace(/\\/g, '/'),
    weight: link.weight,
  }));

  assert.ok(normalizedLinks.some((link) => link.source.endsWith('src/Alpha.cs') && link.target.endsWith('src/Beta.cs')));
});

test('TypeScriptDependencyResolver resolves import graph for TS files only', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-semantic-resolver-'));
  fs.mkdirSync(path.join(root, 'src', 'ui'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'index.ts'), "import './ui/button';\nimport { formatDate } from './utils';\n\nconst value = formatDate(new Date());\nexport default value;\n");
  fs.writeFileSync(path.join(root, 'src', 'utils.ts'), 'export function formatDate(date: Date) { return date.toISOString(); }\n');
  fs.writeFileSync(path.join(root, 'src', 'ui', 'button.ts'), "import { formatDate } from '../utils';\nexport const button = formatDate(new Date());\n");

  const resolver = new TypeScriptDependencyResolver(root);
  const files = resolver.collectTypeScriptFiles(root);
  const links = await resolver.extractTypeScriptEdgesFromFilesystem(root);
  const normalizedFiles = files.map((file) => ({ ...file, fsPath: file.fsPath.replace(/\\/g, '/') }));
  const normalizedLinks = links.map((link) => ({
    source: link.source.replace(/\\/g, '/'),
    target: link.target.replace(/\\/g, '/'),
    weight: link.weight,
  }));

  assert.ok(normalizedFiles.some((file) => file.fsPath.endsWith('src/index.ts')));
  assert.ok(normalizedLinks.some((link) => link.source.endsWith('src/index.ts') && link.target.endsWith('src/utils.ts')));
  assert.ok(normalizedLinks.some((link) => link.source.endsWith('src/ui/button.ts') && link.target.endsWith('src/utils.ts')));
});

test('SemanticEdgeResolutionStrategyDispatcher accepts TypeScript-only repositories as semantic sources', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-ts-only-'));
  fs.mkdirSync(path.join(root, 'src', 'ui'), { recursive: true });

  fs.writeFileSync(path.join(root, 'src', 'index.ts'), "import './ui/button';\nimport { formatDate } from './utils';\nexport const current = formatDate(new Date());\n");
  fs.writeFileSync(path.join(root, 'src', 'utils.ts'), 'export function formatDate(date: Date) { return date.toISOString(); }\n');
  fs.writeFileSync(path.join(root, 'src', 'ui', 'button.ts'), "import { formatDate } from '../utils';\nexport const button = formatDate(new Date());\n");

  const resolver = new SemanticEdgeResolutionStrategyDispatcher(root);
  const files = resolver.collectSemanticFiles(root);
  const links = await resolver.extractEdgesFromFilesystem(root);
  const normalizedFiles = files.map((file) => ({ ...file, fsPath: file.fsPath.replace(/\\/g, '/') }));
  const normalizedLinks = links.map((link) => ({
    source: link.source.replace(/\\/g, '/'),
    target: link.target.replace(/\\/g, '/'),
    weight: link.weight,
  }));

  assert.ok(normalizedFiles.some((file) => file.fsPath.endsWith('src/index.ts')));
  assert.ok(normalizedFiles.some((file) => file.fsPath.endsWith('src/utils.ts')));
  assert.ok(normalizedLinks.some((link) => link.source.endsWith('src/index.ts') && link.target.endsWith('src/utils.ts')));
  assert.ok(normalizedLinks.some((link) => link.source.endsWith('src/ui/button.ts') && link.target.endsWith('src/utils.ts')));
});

test('TypeScriptDependencyResolver resolves tsconfig path aliases via compiler API', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-path-alias-'));
  fs.mkdirSync(path.join(root, 'src', 'features'), { recursive: true });

  fs.writeFileSync(path.join(root, 'tsconfig.json'), JSON.stringify({
    compilerOptions: {
      baseUrl: '.',
      paths: {
        '@app/*': ['src/*'],
      },
    },
    include: ['src/**/*'],
  }, null, 2));

  fs.writeFileSync(path.join(root, 'src', 'features', 'format.ts'), 'export const format = (value: string) => value.toUpperCase();\n');
  fs.writeFileSync(path.join(root, 'src', 'index.ts'), "import { format } from '@app/features/format';\nexport const value = format('demo');\n");

  const resolver = new TypeScriptDependencyResolver(root);
  const links = await resolver.extractTypeScriptEdgesFromFilesystem(root);
  const normalizedLinks = links.map((link) => ({
    source: link.source.replace(/\\/g, '/'),
    target: link.target.replace(/\\/g, '/'),
    weight: link.weight,
  }));

  assert.ok(normalizedLinks.some((link) => link.source.endsWith('src/index.ts') && link.target.endsWith('src/features/format.ts')));
});

test('SemanticEdgeResolutionStrategyDispatcher chooses the strategy per file in one pass', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-single-pass-'));
  fs.mkdirSync(path.join(root, 'src', 'ui'), { recursive: true });

  fs.writeFileSync(path.join(root, 'src', 'index.ts'), "import './ui/button';\nimport { formatDate } from './utils';\nexport const value = formatDate(new Date());\n");
  fs.writeFileSync(path.join(root, 'src', 'utils.ts'), 'export function formatDate(date: Date) { return date.toISOString(); }\n');
  fs.writeFileSync(path.join(root, 'src', 'ui', 'button.ts'), "import { formatDate } from '../utils';\nexport const button = formatDate(new Date());\n");
  fs.writeFileSync(path.join(root, 'README.md'), '[Button](./src/ui/button.ts)\n');

  const resolver = new SemanticEdgeResolutionStrategyDispatcher(root);
  const files = resolver.collectSemanticFiles(root);
  const merged = new Map();

  for (const file of files) {
    const strategy = SemanticEdgeResolutionStrategyDispatcher.getStrategyForFile(file.fsPath).setRootDir(root);
    const fileLinks = await strategy.resolveFile(file.fsPath);
    for (const link of fileLinks) {
      const key = `${link.source}\u0000${link.target}`;
      if (!merged.has(key)) {
        merged.set(key, link);
      }
    }
  }

  const links = Array.from(merged.values()).map((link) => ({
    source: link.source.replace(/\\/g, '/'),
    target: link.target.replace(/\\/g, '/'),
    weight: link.weight,
  }));

  assert.ok(links.some((link) => link.source.endsWith('README.md') && link.target.endsWith('src/ui/button.ts')));
  assert.ok(links.some((link) => link.source.endsWith('src/index.ts') && link.target.endsWith('src/utils.ts')));
});


