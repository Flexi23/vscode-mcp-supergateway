import * as fs from 'fs';
import * as path from 'path';
import { DotNetDependencyResolver } from './dotnetDependencyResolver';
import { GenericSemanticFileDependencyResolver } from './genericSemanticFileDependencyResolver';
import { PythonCallChainResolver } from './pythonCallChainResolver';
import { getResolverTypeNameForLogs, ResolverStrategy, ResolverStrategyType } from './resolverStrategy';
import { TypeScriptDependencyResolver } from './typescriptDependencyResolver';

export interface GraphLink {
  source: string;
  target: string;
  weight: number;
  edgeType: string;
}

export type GraphUri = { fsPath: string; toString(): string };

const strategyOrder: ResolverStrategyType[] = [
  ResolverStrategyType.DotNet,
  ResolverStrategyType.TypeScript,
  ResolverStrategyType.Python,
  ResolverStrategyType.Generic,
];

export class SemanticEdgeResolutionStrategyDispatcher {
  constructor(private readonly workspaceRoot: string = process.cwd()) {}

  static getStrategyByType(type: ResolverStrategyType): ResolverStrategy {
    switch (type) {
      case ResolverStrategyType.DotNet:
        return new DotNetDependencyResolver();
      case ResolverStrategyType.TypeScript:
        return new TypeScriptDependencyResolver();
      case ResolverStrategyType.Python:
        return new PythonCallChainResolver();
      case ResolverStrategyType.Generic:
      default:
        return new GenericSemanticFileDependencyResolver();
    }
  }

  static getStrategyForFile(filePath: string): ResolverStrategy {
    const strategy = strategyOrder
      .map((type) => SemanticEdgeResolutionStrategyDispatcher.getStrategyByType(type))
      .find((candidate) => candidate.supports(filePath));

    if (strategy) {
      return strategy;
    }

    return SemanticEdgeResolutionStrategyDispatcher.getStrategyByType(ResolverStrategyType.Generic);
  }

  collectSemanticFiles(rootDir: string): GraphUri[] {
    if (!rootDir || !fs.existsSync(rootDir)) {
      return [];
    }

    const results: GraphUri[] = [];
    const stack = [rootDir];

    while (stack.length > 0) {
      const current = stack.pop();
      if (!current || !fs.existsSync(current)) {
        continue;
      }

      const stat = fs.statSync(current);
      if (stat.isDirectory()) {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
          const fullPath = path.join(current, entry.name);
          if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'bin' || entry.name === 'obj' || entry.name === 'dist') {
            continue;
          }
          stack.push(fullPath);
        }
        continue;
      }

      if (this.isSupportedSemanticFile(current) && fs.existsSync(current)) {
        results.push({ fsPath: current, toString: () => `file://${current}` });
      }
    }

    return results;
  }

  protected isSupportedSemanticFile(filePath: string): boolean {
    return strategyOrder.some((type) => SemanticEdgeResolutionStrategyDispatcher.getStrategyByType(type).supports(filePath));
  }

  async extractEdges(nodes: GraphUri[], onProgress?: (message: string, percent: number, processed: number, total: number) => void): Promise<GraphLink[]> {
    const uniqueNodes = this.dedupeNodes(nodes);
    if (uniqueNodes.length === 0) {
      return [];
    }

    const workspaceRoot = this.workspaceRoot || this.getDefaultRepositoryRoot(uniqueNodes);
    const links = new Map<string, GraphLink>();
    const rootPassGroups = new Map<string, { strategy: ResolverStrategy; nodes: GraphUri[] }>();
    const perFileGroups = new Map<string, { strategy: ResolverStrategy; nodes: GraphUri[] }>();

    for (const node of uniqueNodes) {
      const strategy = SemanticEdgeResolutionStrategyDispatcher.getStrategyForFile(node.fsPath).setRootDir(workspaceRoot);
      const targetGroups = this.canResolveAsRootPass(strategy) ? rootPassGroups : perFileGroups;
      const key = `${workspaceRoot}\u0000${strategy.type}`;
      const current = targetGroups.get(key);
      if (current) {
        current.nodes.push(node);
      } else {
        targetGroups.set(key, { strategy, nodes: [node] });
      }
    }

    const groupEntries = [...Array.from(rootPassGroups.values()), ...Array.from(perFileGroups.values())];
    for (let index = 0; index < groupEntries.length; index += 1) {
      const group = groupEntries[index];
      const resolverName = getResolverTypeNameForLogs(group.strategy.type);
      const representative = group.nodes[0];
      const summary = `${resolverName} ${path.relative(workspaceRoot || process.cwd(), representative.fsPath) || path.basename(representative.fsPath)} (${index + 1}/${groupEntries.length})`;
      onProgress?.(`[${resolverName}] ${summary}`, Math.round(((index + 1) / groupEntries.length) * 100), index + 1, groupEntries.length);

      if (this.canResolveAsRootPass(group.strategy)) {
        const strategyLinks = await this.resolveStrategyRootGroup(workspaceRoot, group.strategy, group.nodes);
        this.mergeLinks(links, strategyLinks);
        continue;
      }

      for (const node of group.nodes) {
        const strategyLinks = await group.strategy.resolveFile(node.fsPath);
        this.mergeLinks(links, strategyLinks);
      }
    }

    return Array.from(links.values());
  }

  async extractEdgesFromFilesystem(rootDir: string, onProgress?: (message: string, percent: number, processed: number, total: number) => void): Promise<GraphLink[]> {
    const files = this.collectSemanticFiles(rootDir);
    if (files.length === 0) {
      console.log('[SemanticEdgeResolutionStrategyDispatcher] no files found.');
      return [];
    }

    const links = new Map<string, GraphLink>();
    const rootPassGroups = new Map<string, { strategy: ResolverStrategy; nodes: GraphUri[] }>();
    const perFileGroups = new Map<string, { strategy: ResolverStrategy; nodes: GraphUri[] }>();

    for (const file of files) {
      const strategy = SemanticEdgeResolutionStrategyDispatcher.getStrategyForFile(file.fsPath).setRootDir(rootDir);
      const targetGroups = this.canResolveAsRootPass(strategy) ? rootPassGroups : perFileGroups;
      const key = `${rootDir}\u0000${strategy.type}`;
      const current = targetGroups.get(key);
      if (current) {
        current.nodes.push(file);
      } else {
        targetGroups.set(key, { strategy, nodes: [file] });
      }
    }

    const groupEntries = [...Array.from(rootPassGroups.values()), ...Array.from(perFileGroups.values())];
    for (let index = 0; index < groupEntries.length; index += 1) {
      const group = groupEntries[index];
      const resolverName = getResolverTypeNameForLogs(group.strategy.type);
      const summary = `${resolverName} root pass (${index + 1}/${groupEntries.length})`;
      onProgress?.(`[${resolverName}] ${summary}`, Math.round(((index + 1) / groupEntries.length) * 100), index + 1, groupEntries.length);

      if (this.canResolveAsRootPass(group.strategy)) {
        const strategyLinks = await this.resolveStrategyRootGroup(rootDir, group.strategy, group.nodes);
        this.mergeLinks(links, strategyLinks);
        continue;
      }

      for (const file of group.nodes) {
        const strategyLinks = await group.strategy.resolveFile(file.fsPath);
        this.mergeLinks(links, strategyLinks);
      }
    }

    return Array.from(links.values());
  }

  private canResolveAsRootPass(strategy: ResolverStrategy): boolean {
    return strategy.type === ResolverStrategyType.DotNet || strategy.type === ResolverStrategyType.TypeScript;
  }

  private async resolveStrategyRootGroup(rootDir: string, strategy: ResolverStrategy, files: readonly GraphUri[]): Promise<GraphLink[]> {
    const filePaths = files
      .map((file) => file.fsPath)
      .filter((filePath) => strategy.supports(filePath));

    if (filePaths.length === 0) {
      return [];
    }

    if (strategy.type === ResolverStrategyType.DotNet) {
      const resolver = strategy as any;
      if (typeof resolver.extractEdges === 'function') {
        return await resolver.extractEdges(rootDir, undefined, filePaths);
      }
    }

    if (strategy.type === ResolverStrategyType.TypeScript) {
      const resolver = strategy as any;
      if (typeof resolver.extractTypeScriptEdgesFromFilesystem === 'function') {
        return await resolver.extractTypeScriptEdgesFromFilesystem(rootDir, undefined, filePaths);
      }
    }

    const links: GraphLink[] = [];
    for (const filePath of filePaths) {
      const resolvedLinks = await strategy.resolveFile(filePath);
      for (const link of resolvedLinks) {
        const key = `${link.source}\u0000${link.target}\u0000${link.edgeType}`;
        if (!links.some((entry) => `${entry.source}\u0000${entry.target}\u0000${entry.edgeType}` === key)) {
          links.push(link);
        }
      }
    }

    return links;
  }

  writeLinksFile(links: GraphLink[], outputPath: string): number {
    const normalized = this.dedupeLinks(links);
    const payload = JSON.stringify(normalized, null, 2);
    fs.writeFileSync(outputPath, payload, 'utf8');
    return normalized.length;
  }

  protected dedupeNodes(nodes: readonly GraphUri[]): GraphUri[] {
    const seen = new Set<string>();
    const unique: GraphUri[] = [];

    for (const node of nodes) {
      const key = node.toString();
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(node);
      }
    }

    return unique;
  }

  protected dedupeLinks(links: readonly GraphLink[]): GraphLink[] {
    const seen = new Set<string>();
    const unique: GraphLink[] = [];

    for (const link of links) {
      const key = `${link.source}\u0000${link.target}\u0000${link.edgeType}`;
      if (!seen.has(key)) {
        seen.add(key);
        unique.push({ ...link, weight: Math.max(1, link.weight || 1), edgeType: link.edgeType || 'file-reference' });
      }
    }

    return unique;
  }

  protected chunk<T>(items: readonly T[], size: number): T[][] {
    const result: T[][] = [];
    for (let index = 0; index < items.length; index += size) {
      result.push(items.slice(index, index + size) as T[]);
    }
    return result;
  }

  private getDefaultRepositoryRoot(nodes: readonly GraphUri[]): string {
    if (nodes.length === 0) {
      return '';
    }
    const root = nodes[0].fsPath;
    return path.dirname(root);
  }

  private mergeLinks(target: Map<string, GraphLink>, sourceLinks: readonly GraphLink[]): void {
    for (const link of sourceLinks) {
      const key = `${link.source}\u0000${link.target}\u0000${link.edgeType}`;
      if (!target.has(key)) {
        target.set(key, { ...link, edgeType: link.edgeType || 'file-reference' });
      }
    }
  }

}

export { TypeScriptDependencyResolver };
export { PythonCallChainResolver };

