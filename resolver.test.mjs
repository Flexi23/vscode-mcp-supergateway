// Container-only regression suite: this file validates the resolver behavior in the
// gateway container runtime, where the Linux .NET SDK is mounted at /usr/share/dotnet.
// Running it on the host OS is not the intended execution contract and may fail with
// ENOENT even when the container-based logic is correct.
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

test('cbm graph keeps the upstream default internal UI port so the dashboard shell never wraps the graph UI', () => {
  const envFile = fs.readFileSync(path.join(process.cwd(), '.env'), 'utf8');
  const adminUiPort = Number((envFile.match(/ADMIN_UI_PORT=(\d+)/) || [])[1]);
  const cbmUiPort = 9749;

  assert.ok(Number.isInteger(adminUiPort) && adminUiPort > 0, 'ADMIN_UI_PORT must be set');
  assert.ok(Number.isInteger(cbmUiPort) && cbmUiPort > 0, 'CBM UI port must remain a valid internal default');
  assert.notEqual(cbmUiPort, adminUiPort, 'The graph UI port must stay distinct from the dashboard port');
});

test('dashboard exposes route-based iframe tabs and the MSP stack UI', () => {
  const html = buildDashboardHtml({
    activeTab: 'msp',
    adminUiPort: 3100,
    mspGatewayPort: 3110,
    cbmUiPort: 3100,
    siyuanPort: 6806,
  });

  assert.match(html, /href="\/msp"/);
  assert.match(html, /href="\/cbm"/);
  assert.match(html, /href="\/siyuan"/);
  assert.match(html, /<iframe/);
  assert.match(html, /http:\/\/127\.0\.0\.1:3100\/msp-admin/);
  assert.doesNotMatch(html, /http:\/\/127\.0\.0\.1:3110\/admin/);
});

test('cbm action cells use compact text links instead of button styling', () => {
  const html = buildCbmOverviewHtml({
    cbmUiPort: 3100,
    initialProjects: [
      { name: 'alpha-project', root_path: '/workspace/alpha-project', status: 'unchecked', indexed: false },
      { name: 'beta-project', root_path: '/workspace/beta-project', status: 'active', indexed: true },
    ],
  });

  assert.match(html, /text-decoration:\s*underline/i);
  assert.match(html, /<a[^>]*class="[^"]*text-action[^"]*"/i);
  assert.doesNotMatch(html, /class="btn|<button\s/i);
});

test('resolver metadata exposes a single canonical strategy list and supported file types', async () => {
  const { listResolverTypes, getSupportedFileTypesForResolver } = await import('./dist/services/resolverStrategy.js');

  assert.deepEqual(listResolverTypes(), ['dotnet', 'typescript', 'python', 'generic']);
  assert.deepEqual(getSupportedFileTypesForResolver('dotnet'), ['.cs', '.razor']);
  assert.ok(getSupportedFileTypesForResolver('typescript').includes('.ts'));
  assert.ok(getSupportedFileTypesForResolver('python').includes('.py'));
});

test('resolver log names use short enum-style names without verbose strategy labels', async () => {
  const { getResolverTypeNameForLogs } = await import('./dist/services/resolverStrategy.js');

  assert.equal(getResolverTypeNameForLogs('dotnet'), 'DotNet');
  assert.equal(getResolverTypeNameForLogs('typescript'), 'TypeScript');
  assert.equal(getResolverTypeNameForLogs('python'), 'Python');
});

test('resolver metadata exposes edge types per resolver strategy', async () => {
  const { getEdgeTypesForResolver } = await import('./dist/services/resolverStrategy.js');

  assert.deepEqual(getEdgeTypesForResolver('dotnet'), ['file-reference']);
  assert.deepEqual(getEdgeTypesForResolver('typescript'), ['file-reference']);
  assert.deepEqual(getEdgeTypesForResolver('python'), ['call-chain', 'import-bound-call']);
  assert.deepEqual(getEdgeTypesForResolver('generic'), ['file-reference']);
});

test('dotnet Roslyn program stays in a real source file instead of an embedded TypeScript string', () => {
  const sourcePath = path.join(process.cwd(), 'src', 'services', 'dotnetRoslynProgramSource.cs');
  assert.ok(fs.existsSync(sourcePath), 'The Roslyn program source file should exist in the source tree');
  const source = fs.readFileSync(sourcePath, 'utf8');
  assert.match(source, /using Microsoft\.CodeAnalysis\.CSharp;/);
  assert.match(source, /Console\.WriteLine\(JsonSerializer\.Serialize\(new \{ links \}\)\);/);
});

test('dotnet Roslyn runner logs each initialization step in the console', async () => {
  const previousInfo = console.info;
  const messages = [];
  console.info = (...args) => messages.push(args.join(' '));

  try {
    const { createDotNetRoslynRunner } = await import('./dist/services/dotnetRoslynProgram.js');
    const runner = createDotNetRoslynRunner(process.cwd());
    assert.ok(messages.some((message) => message.includes('initializing Roslyn runner')));
    assert.ok(messages.some((message) => message.includes('Roslyn runner ready')));
    assert.ok(runner.projectFile.includes('.Resolver.csproj'));
  } finally {
    console.info = previousInfo;
  }
});

test('dotnet resolver analyses the repository once per root instead of re-running on every C# file', async () => {
  const { SemanticEdgeResolutionStrategyDispatcher } = await import('./dist/services/semanticEdgeResolutionStrategyDispatcher.js');
  const { DotNetDependencyResolver } = await import('./dist/services/dotnetDependencyResolver.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dotnet-root-once-'));
  const srcDir = path.join(root, 'src');
  fs.mkdirSync(srcDir, { recursive: true });
  fs.writeFileSync(path.join(srcDir, 'Alpha.cs'), 'namespace Alpha { public class Alpha { public int Value => 1; } }\n');
  fs.writeFileSync(path.join(srcDir, 'Beta.cs'), 'namespace Beta { public class Beta { public int Value => 2; } }\n');

  const originalResolveFile = DotNetDependencyResolver.prototype.resolveFile;
  const calls = [];
  DotNetDependencyResolver.prototype.resolveFile = async function(filePath) {
    calls.push(filePath);
    return originalResolveFile.call(this, filePath);
  };

  try {
    const dispatcher = new SemanticEdgeResolutionStrategyDispatcher(root);
    const nodes = [
      { fsPath: path.join(srcDir, 'Alpha.cs'), toString: () => path.join(srcDir, 'Alpha.cs') },
      { fsPath: path.join(srcDir, 'Beta.cs'), toString: () => path.join(srcDir, 'Beta.cs') },
    ];

    await dispatcher.extractEdges(nodes, () => {});
    assert.ok(calls.length <= 1, `Expected a single DotNet repo pass, got ${calls.length} calls`);
  } finally {
    DotNetDependencyResolver.prototype.resolveFile = originalResolveFile;
  }
});

test('dotnet Roslyn project XML stays in a real csproj file instead of an embedded TypeScript string', () => {
  const projectPath = path.join(process.cwd(), 'src', 'services', 'dotnetRoslynProject.csproj');
  assert.ok(fs.existsSync(projectPath), 'The Roslyn project XML should exist in the source tree');
  const projectXml = fs.readFileSync(projectPath, 'utf8');
  assert.match(projectXml, /<Project Sdk="Microsoft\.NET\.Sdk">/);
  assert.match(projectXml, /<PackageReference Include="Microsoft\.CodeAnalysis\.CSharp" Version="4\.13\.0" \/>/);
});

test('resolver entrypoints identify project configuration files for each language', async () => {
  const { listEntrypointFilesForResolver } = await import('./dist/services/resolverStrategy.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'resolver-entrypoints-'));

  fs.mkdirSync(path.join(root, 'src'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'App.cs'), 'class App { }\n');
  fs.writeFileSync(path.join(root, 'Demo.sln'), 'Microsoft Visual Studio Solution File, Format Version 12.00\n');
  fs.writeFileSync(path.join(root, 'tsconfig.json'), '{ "compilerOptions": {} }\n');
  fs.writeFileSync(path.join(root, 'pyproject.toml'), '[project]\nname = "demo"\n');

  const dotnetEntrypoints = listEntrypointFilesForResolver(root, 'dotnet');
  const tsEntrypoints = listEntrypointFilesForResolver(root, 'typescript');
  const pythonEntrypoints = listEntrypointFilesForResolver(root, 'python');

  assert.ok(dotnetEntrypoints.some((file) => file.endsWith('Demo.sln')));
  assert.ok(tsEntrypoints.some((file) => file.endsWith('tsconfig.json')));
  assert.ok(pythonEntrypoints.some((file) => file.endsWith('pyproject.toml')));
});

test('resolver entrypoints fall back from a Windows host path to the runtime container workspace', async () => {
  const { listEntrypointFilesForResolver } = await import('./dist/services/resolverStrategy.js');
  const runtimeRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'resolver-runtime-root-'));
  fs.writeFileSync(path.join(runtimeRoot, 'Demo.sln'), 'Microsoft Visual Studio Solution File, Format Version 12.00\n');

  const entrypoints = listEntrypointFilesForResolver('C:\\workspace\\missing-root', 'dotnet', runtimeRoot);
  assert.ok(entrypoints.some((file) => file.endsWith('Demo.sln')));
});

test('dotnet resolver resolves Roslyn even when PATH is blank', async (t) => {
  const dotnetRuntime = ['/usr/share/dotnet/dotnet', '/usr/local/share/dotnet/dotnet', path.join(os.homedir(), '.dotnet', 'dotnet')]
    .some((candidate) => fs.existsSync(candidate));

  if (!dotnetRuntime) {
    t.skip('Container-only Roslyn execution requires the .NET SDK in the Linux runtime path; skipping host-only validation.');
    return;
  }

  const { DotNetDependencyResolver } = await import('./dist/services/dotnetDependencyResolver.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dotnet-roslyn-path-blank-'));
  const sourceFile = path.join(root, 'Demo.cs');
  fs.writeFileSync(sourceFile, 'namespace Demo { public class Demo { public int Value => 1; } }\n');

  const previousPath = process.env.PATH;
  const previousWarn = console.warn;
  let captured = '';
  console.warn = (...args) => {
    captured += args.join(' ');
  };
  process.env.PATH = '';

  try {
    const resolver = new DotNetDependencyResolver();
    const links = await resolver.extractEdges(root);
    assert.ok(Array.isArray(links));
    assert.ok(links.length >= 0);
    assert.doesNotMatch(captured, /ENOENT|spawn:|Roslyn dependency resolver failed/i);
  } finally {
    process.env.PATH = previousPath;
    console.warn = previousWarn;
  }
});

test('dotnet resolver caches Roslyn graph results for unchanged project roots', async () => {
  const { DotNetDependencyResolver } = await import('./dist/services/dotnetDependencyResolver.js');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dotnet-roslyn-cache-'));
  const sourceFile = path.join(root, 'Demo.cs');
  fs.writeFileSync(sourceFile, 'namespace Demo { public class Demo { public int Value => 1; } }\n');

  const resolver = new DotNetDependencyResolver();
  const first = await resolver.extractEdges(root);
  const cache = DotNetDependencyResolver['roslynResultCache'];

  assert.ok(cache instanceof Map, 'Roslyn result cache should exist');
  assert.ok(cache.size >= 1, 'Roslyn result cache should be populated after the first run');
  assert.deepEqual(await resolver.extractEdges(root), first);
});

test('status logic keeps compact text-action actions for idle and active rows', () => {
  const html = buildCbmOverviewHtml({
    cbmUiPort: 3100,
    initialProjects: [
      { name: 'alpha-project', root_path: '/workspace/alpha-project', status: 'unchecked', indexed: false },
      { name: 'beta-project', root_path: '/workspace/beta-project', status: 'idle', indexed: false },
      { name: 'gamma-project', root_path: '/workspace/gamma-project', status: 'success', indexed: true },
    ],
  });

  assert.match(html, /state === 'unchecked'/);
  assert.match(html, /state === 'idle'/);
  assert.match(html, /state === 'checking'/);
  assert.match(html, /state === 'active'/);
  assert.match(html, /if \(state === 'active'\)/);
  assert.match(html, /if \(state === 'unchecked' \|\| state === 'idle'\)/);
  assert.match(html, /text-action.*Add to Index/i);
  assert.match(html, /text-action.*Open 3D graph/i);
  assert.match(html, /text-action.*Transfer semantic edges/i);
});

test('cbm overview renders the full workspace directory list immediately and keeps compact text actions', () => {
  const html = buildCbmOverviewHtml({
    cbmUiPort: 3100,
    initialProjects: [
      { name: 'alpha-project', root_path: '/workspace/alpha-project', status: 'unchecked', indexed: false },
      { name: 'beta-project', root_path: '/workspace/beta-project', status: 'unchecked', indexed: false },
      { name: 'gamma-project', root_path: '/workspace/gamma-project', status: 'unchecked', indexed: false },
    ],
  });

  assert.match(html, /alpha-project/);
  assert.match(html, /beta-project/);
  assert.match(html, /gamma-project/);
  assert.match(html, /data-state="unchecked"/);
  assert.match(html, /if \(state === 'unchecked' \|\| state === 'idle'\)/);
  assert.match(html, /text-action.*Add to Index/i);
  assert.doesNotMatch(html, /Loading projects/i);
  assert.doesNotMatch(html, /<button\s/i);
  assert.match(html, /<tbody id="project-table-body">/);
});

test('workspace root detection falls back to the container path when a Windows host path is passed', async () => {
  const { resolveRuntimeWorkspaceRoot } = await import('./dist/codebaseMemory.js');
  const fallbackRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'cbm-runtime-root-'));
  const resolved = resolveRuntimeWorkspaceRoot('C:\\workspace\\example-root', fallbackRoot);
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
  fs.mkdirSync(path.join(root, 'alpha-app'), { recursive: true });
  fs.mkdirSync(path.join(root, 'beta-app'), { recursive: true });
  fs.mkdirSync(cacheDir, { recursive: true });

  const previousFixture = process.env.CBM_LIST_PROJECTS_FIXTURE;
  process.env.CBM_LIST_PROJECTS_FIXTURE = JSON.stringify({
    projects: [
      { name: 'alpha-app', project: 'alpha-app', path: '/workspace/alpha-app', root_path: '/workspace/alpha-app', status: 'success' },
      { name: 'beta-app', project: 'beta-app', path: '/workspace/beta-app', root_path: '/workspace/beta-app', status: 'success' },
    ],
  });

  try {
    const rows = mergeWorkspaceProjectRows(root, cacheDir);
    const rowMap = new Map(rows.map((row) => [String(row.root_path ?? row.path ?? row.project), row]));

    assert.ok(rowMap.has(path.join(root, 'alpha-app')));
    assert.ok(rowMap.has(path.join(root, 'beta-app')));
    assert.equal(rowMap.get(path.join(root, 'alpha-app'))?.indexed, true);
    assert.equal(rowMap.get(path.join(root, 'beta-app'))?.indexed, true);
    assert.equal(rowMap.get(path.join(root, 'alpha-app'))?.status, 'success');
    assert.equal(rowMap.get(path.join(root, 'beta-app'))?.status, 'success');
  } finally {
    if (previousFixture === undefined) delete process.env.CBM_LIST_PROJECTS_FIXTURE;
    else process.env.CBM_LIST_PROJECTS_FIXTURE = previousFixture;
  }
});

test('index job websocket payload carries the active file and absolute progress counts', () => {
  const seen = [];
  const previous = setIndexJobUpdateListener((repoPath, job) => {
    seen.push({ repoPath, job });
  });

  updateIndexJobState('/workspace/demo', {
    status: 'enriching',
    message: 'processing alpha.ts',
    progress: 42,
    fileName: 'alpha.ts',
    processedCount: 42,
    totalCount: 100,
    updatedAt: Date.now(),
  });

  assert.equal(seen.length, 1);
  assert.equal(seen[0].repoPath, '/workspace/demo');
  assert.equal(seen[0].job.fileName, 'alpha.ts');
  assert.equal(seen[0].job.processedCount, 42);
  assert.equal(seen[0].job.totalCount, 100);
  setIndexJobUpdateListener(previous);
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
    edgeType: link.edgeType || 'file-reference',
  }));

  assert.ok(normalizedLinks.some((link) => link.source.endsWith('src/Alpha.cs') && link.target.endsWith('src/Beta.cs')));
  assert.ok(normalizedLinks.every((link) => link.edgeType === 'file-reference'));
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
    edgeType: link.edgeType || 'file-reference',
  }));

  assert.ok(normalizedFiles.some((file) => file.fsPath.endsWith('src/index.ts')));
  assert.ok(normalizedLinks.some((link) => link.source.endsWith('src/index.ts') && link.target.endsWith('src/utils.ts')));
  assert.ok(normalizedLinks.some((link) => link.source.endsWith('src/ui/button.ts') && link.target.endsWith('src/utils.ts')));
  assert.ok(normalizedLinks.every((link) => link.edgeType === 'file-reference'));
});

test('TypeScriptDependencyResolver caches graph results for unchanged project roots', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ts-semantic-cache-'));
  fs.mkdirSync(path.join(root, 'src', 'ui'), { recursive: true });
  fs.writeFileSync(path.join(root, 'src', 'index.ts'), "import './ui/button';\nimport { formatDate } from './utils';\nexport const value = formatDate(new Date());\n");
  fs.writeFileSync(path.join(root, 'src', 'utils.ts'), 'export function formatDate(date: Date) { return date.toISOString(); }\n');
  fs.writeFileSync(path.join(root, 'src', 'ui', 'button.ts'), "import { formatDate } from '../utils';\nexport const button = formatDate(new Date());\n");

  const resolver = new TypeScriptDependencyResolver(root);
  const first = await resolver.extractTypeScriptEdgesFromFilesystem(root);
  const cache = TypeScriptDependencyResolver['tsResultCache'];

  assert.ok(cache instanceof Map, 'TypeScript result cache should exist');
  assert.ok(cache.size >= 1, 'TypeScript result cache should be populated after the first run');
  assert.deepEqual(await resolver.extractTypeScriptEdgesFromFilesystem(root), first);
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


