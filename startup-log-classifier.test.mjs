import test from 'node:test';
import assert from 'node:assert/strict';

const { classifyStartupLogLine, formatConnectedUpstreamSummary, formatToolCatalogTable } = await import('./dist/startupLogClassifier.js');

test('classifies upstream connection logs without brittle string comparisons', () => {
  assert.deepEqual(classifyStartupLogLine('[upstream:codebase-memory] connected (stdio)'), {
    kind: 'upstream-connected',
    upstreamId: 'codebase-memory',
    transport: 'stdio',
  });

  assert.equal(
    formatConnectedUpstreamSummary('codebase-memory', 'stdio'),
    '[upstream:codebase-memory] connected (stdio)',
  );

  assert.deepEqual(classifyStartupLogLine('gateway started on :8080'), {
    kind: 'plain',
    text: 'gateway started on :8080',
  });

  assert.deepEqual(classifyStartupLogLine('gateway-1  | [gateway] admin UI      http://localhost:3110/admin'), {
    kind: 'gateway-admin-ui',
    url: 'http://localhost:3110/admin',
    text: 'gateway-1  | [gateway] admin UI      http://localhost:3110/admin',
  });

  assert.deepEqual(classifyStartupLogLine('[gateway] public RBAC-MCP endpoint ready'), {
    kind: 'ignored',
    reason: 'public-rbac-endpoint',
  });
});

test('keeps upstream connect lines when the runtime splits a chunk mid-message', async () => {
  const { splitStartupLogLines } = await import('./dist/startupLogClassifier.js');

  const first = '[upstream:codebase-memory] connected (stdio)';
  const second = '\n[upstream:siyuan-note] connected (stdio)\n';
  const state = { pending: '' };

  const firstBatch = splitStartupLogLines(first, state.pending);
  const secondBatch = splitStartupLogLines(second, firstBatch.pending);

  assert.deepEqual(firstBatch.lines, [first]);
  assert.deepEqual(secondBatch.lines, ['[upstream:siyuan-note] connected (stdio)']);
  assert.equal(secondBatch.pending, '');
});

test('matches real tool names across hyphen and underscore variants without brittle namespace strings', async () => {
  const { matchToolToUpstream } = await import('./dist/startupLogClassifier.js');

  assert.deepEqual(
    matchToolToUpstream('codebase_memory_index_repository', [
      { id: 'codebase-memory', namespace: 'codebasememory', transport: 'stdio', command: 'node', args: [] },
      { id: 'siyuan-note', namespace: 'siyuannote', transport: 'stdio', command: 'node', args: [] },
    ]),
    {
      upstreamId: 'codebase-memory',
      toolName: 'index_repository',
      transport: 'stdio',
    },
  );

  assert.deepEqual(
    matchToolToUpstream('siyuan_search_notes', [
      { id: 'codebase-memory', namespace: 'codebasememory', transport: 'stdio', command: 'node', args: [] },
      { id: 'siyuan-note', namespace: 'siyuannote', transport: 'stdio', command: 'node', args: [] },
    ]),
    {
      upstreamId: 'siyuan-note',
      toolName: 'search_notes',
      transport: 'stdio',
    },
  );
});

test('formats grouped upstream tool catalog rows without transport column', () => {
  const rows = [
    { upstreamId: 'codebase-memory', toolName: 'index_repository', transport: 'stdio' },
    { upstreamId: 'gitlab', toolName: 'merge_requests', transport: 'stdio' },
    { upstreamId: 'gitlab', toolName: 'project_search', transport: 'stdio' },
    { upstreamId: 'siyuan-note', toolName: 'read_doc', transport: 'stdio' },
  ];

  assert.equal(
    formatToolCatalogTable(rows),
    [
      '',
      '# gated aggregate agent tools for context sharing, documentation, and task management #',
      '',
      'codebase-memory:',
      '  index_repository',
      '',
      'gitlab:',
      '  merge_requests    project_search',
      '',
      'siyuan-note:',
      '  read_doc',
    ].join('\n'),
  );
});
