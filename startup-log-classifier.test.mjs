import test from 'node:test';
import assert from 'node:assert/strict';

const { classifyStartupLogLine, formatConnectedUpstreamSummary } = await import('./dist/startupLogClassifier.js');

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
