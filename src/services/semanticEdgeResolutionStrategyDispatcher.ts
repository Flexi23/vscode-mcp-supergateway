import * as fs from 'fs';
import * as path from 'path';
import { DotNetDependencyResolver } from './dotnetDependencyResolver';
import { GenericSemanticFileDependencyResolver } from './genericSemanticFileDependencyResolver';
import { ResolverStrategy, ResolverStrategyType } from './resolverStrategy';
import { TypeScriptDependencyResolver } from './typescriptDependencyResolver';

export interface GraphLink {
  source: string;
  target: string;
  weight: number;
}

export type GraphUri = { fsPath: string; toString(): string };

const strategyOrder: ResolverStrategyType[] = [
  ResolverStrategyType.DotNet,
  ResolverStrategyType.TypeScript,
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
    const total = uniqueNodes.length;

    for (let index = 0; index < uniqueNodes.length; index += 1) {
      const node = uniqueNodes[index];
      const strategy = SemanticEdgeResolutionStrategyDispatcher.getStrategyForFile(node.fsPath).setRootDir(workspaceRoot);
      const percent = Math.round(((index + 1) / total) * 100);
      onProgress?.(`[${strategy.label}] ${path.basename(node.fsPath)} (${index + 1}/${total})`, percent, index + 1, total);

      const strategyLinks = await strategy.resolveFile(node.fsPath);
      this.mergeLinks(links, strategyLinks);
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
    const total = files.length;

    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      const strategy = SemanticEdgeResolutionStrategyDispatcher.getStrategyForFile(file.fsPath).setRootDir(rootDir);
      const percent = Math.round(((index + 1) / total) * 100);
      onProgress?.(`[${strategy.label}] ${path.basename(file.fsPath)} (${index + 1}/${total})`, percent, index + 1, total);

      const strategyLinks = await strategy.resolveFile(file.fsPath);
      this.mergeLinks(links, strategyLinks);
    }

    return Array.from(links.values());
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
      const key = `${link.source}\u0000${link.target}`;
      if (!seen.has(key)) {
        seen.add(key);
        unique.push({ ...link, weight: Math.max(1, link.weight || 1) });
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
      const key = `${link.source}\u0000${link.target}`;
      if (!target.has(key)) {
        target.set(key, link);
      }
    }
  }

}

export { TypeScriptDependencyResolver };

