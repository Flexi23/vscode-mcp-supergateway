export type StartupLogClassification =
  | { kind: 'upstream-connected'; upstreamId: string; transport: string }
  | { kind: 'gateway-admin-ui'; url: string; text: string }
  | { kind: 'ignored'; reason: 'empty' | 'public-rbac-endpoint' }
  | { kind: 'plain'; text: string };

export type StartupLogSplitResult = {
  lines: string[];
  pending: string;
};

export type ToolCatalogRow = {
  upstreamId: string;
  toolName: string;
  transport: string;
};

export const formatConnectedUpstreamSummary = (upstreamId: string, transport: string): string => {
  return `[upstream:${upstreamId}] connected (${transport})`;
};

const buildPrefixVariants = (value: string): string[] => {
  const cleaned = value.trim();
  if (!cleaned) {
    return [];
  }

  const tokens = cleaned.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  const variants = new Set<string>([
    cleaned.toLowerCase(),
    cleaned.toLowerCase().replace(/[-_]+/g, ''),
    cleaned.toLowerCase().replace(/[-_]+/g, '_'),
    cleaned.toLowerCase().replace(/[-_]+/g, '-'),
  ]);

  for (let index = 1; index <= tokens.length; index += 1) {
    variants.add(tokens.slice(0, index).join(''));
    variants.add(tokens.slice(0, index).join('_'));
    variants.add(tokens.slice(0, index).join('-'));
  }

  return [...variants].filter(Boolean).sort((left, right) => right.length - left.length);
};

export const matchToolToUpstream = (
  toolName: string,
  upstreams: Array<{ id: string; namespace: string; transport: string }>,
): ToolCatalogRow | undefined => {
  const trimmedToolName = toolName.trim();
  if (!trimmedToolName) {
    return undefined;
  }

  const searchableToolName = trimmedToolName.toLowerCase();

  for (const upstream of upstreams) {
    const prefixVariants = [...new Set([
      ...buildPrefixVariants(upstream.namespace),
      ...buildPrefixVariants(upstream.id),
    ])].sort((left, right) => right.length - left.length);

    for (const prefix of prefixVariants) {
      const regex = new RegExp(`^${prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?:[_-]|$)`);
      const match = regex.exec(searchableToolName);
      if (!match) {
        continue;
      }

      const suffix = trimmedToolName.slice(match[0].length).replace(/^[-_]+/, '');
      return {
        upstreamId: upstream.id,
        toolName: suffix,
        transport: upstream.transport,
      };
    }
  }

  return undefined;
};

export const formatToolCatalogTable = (rows: ToolCatalogRow[]): string => {
  if (rows.length === 0) {
    return '[tools] available via the gateway\nNo tools discovered yet.';
  }

  const grouped = new Map<string, string[]>();
  for (const row of rows) {
    const tools = grouped.get(row.upstreamId) ?? [];
    tools.push(row.toolName);
    grouped.set(row.upstreamId, tools);
  }

  const lines = ['', '# gated aggregate agent tools for context sharing, documentation, and task management #'];
  const columnCount = 3;

  for (const upstreamId of [...grouped.keys()].sort()) {
    const tools = [...new Set(grouped.get(upstreamId) ?? [])].sort((left, right) => left.localeCompare(right));
    const toolWidth = Math.max(...tools.map((tool) => tool.length));
    const columns: string[] = [];

    for (let index = 0; index < tools.length; index += columnCount) {
      const chunk = tools.slice(index, index + columnCount);
      const padded = chunk.map((tool) => tool.padEnd(toolWidth, ' '));
      columns.push(`  ${padded.join('    ')}`);
    }

    lines.push('');
    lines.push(`${upstreamId}:`);
    lines.push(...columns);
  }

  return lines.join('\n');
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

  const adminUiMatch = normalized.match(/^(?:[^|]+\s+\|\s+)?\[gateway\]\s+admin UI\s+(https?:\/\/\S+)\s*$/i);
  if (adminUiMatch) {
    return {
      kind: 'gateway-admin-ui',
      url: adminUiMatch[1],
      text: normalized,
    };
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
