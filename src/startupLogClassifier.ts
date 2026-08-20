export type StartupLogClassification =
  | { kind: 'upstream-connected'; upstreamId: string; transport: string }
  | { kind: 'ignored'; reason: 'empty' | 'public-rbac-endpoint' }
  | { kind: 'plain'; text: string };

export type StartupLogSplitResult = {
  lines: string[];
  pending: string;
};

export const formatConnectedUpstreamSummary = (upstreamId: string, transport: string): string => {
  return `[upstream:${upstreamId}] connected (${transport})`;
};

export const splitStartupLogLines = (chunk: string, pending = ''): StartupLogSplitResult => {
  const combined = `${pending}${chunk}`;

  if (!combined.includes('\n') && !combined.includes('\r')) {
    if (pending.length > 0) {
      return { lines: [], pending: combined };
    }

    return {
      lines: combined.trim() ? [combined.trim()] : [],
      pending: '',
    };
  }

  const parts = combined.split(/\r?\n/);
  const lastPart = parts.pop() ?? '';
  const lines = parts
    .map((entry) => entry.trim())
    .filter((entry) => entry.length > 0);

  return {
    lines,
    pending: lastPart.trim() ? lastPart : '',
  };
};

export const classifyStartupLogLine = (line: string): StartupLogClassification => {
  const normalized = line.replace(/\u001b\[[0-9;]*m/g, '').trim();

  if (!normalized) {
    return { kind: 'ignored', reason: 'empty' };
  }

  if (/^\[gateway\] public RBAC-MCP endpoint.*$/i.test(normalized)) {
    return { kind: 'ignored', reason: 'public-rbac-endpoint' };
  }

  const connectedMatch = normalized.match(/^\[upstream:([^\]]+)\] connected \(([^)]+)\)(?:\s+.*)?$/i);
  if (connectedMatch) {
    const [, upstreamId, transport] = connectedMatch;
    return {
      kind: 'upstream-connected',
      upstreamId,
      transport,
    };
  }

  return { kind: 'plain', text: normalized };
};
