import * as fs from 'fs';
import * as path from 'path';
import type * as VSCode from 'vscode';

const vscodeModule: typeof import('vscode') | undefined = (() => {
  try {
    return require('vscode');
  } catch {
    return undefined;
  }
})();

export interface GraphLink {
  source: string;
  target: string;
  weight: number;
}

type GraphUri = { fsPath: string; toString(): string };
type PositionLike = { line: number; character: number };
type SymbolLike = { selectionRange?: { start: PositionLike }; range?: { start: PositionLike }; children?: SymbolLike[]; name?: string };
type ReferenceLike = { uri?: GraphUri; range?: { start: PositionLike }; targetUri?: GraphUri; targetRange?: { start: PositionLike } };

export class SemanticDependencyResolver {
  private readonly concurrencyLimit = 4;
  private readonly batchSize = 8;

  constructor(private readonly workspaceRoot: string = this.getWorkspaceRoot()) {}

  /**
   * Extracts cross-file dependencies for a batch of C# file URIs.
   *
   * Each file is processed using the active C# language service, which resolves
   * broad symbol references and definitions via the same semantic pipeline Roslyn
   * uses internally. The result is a graph link list that can be fed directly into
   * the codebase-memory indexer.
   */
  async extractEdges(nodes: GraphUri[], onProgress?: (message: string, percent: number, processed: number, total: number) => void): Promise<GraphLink[]> {
    const uniqueNodes = this.dedupeNodes(nodes);
    if (uniqueNodes.length === 0) {
      return [];
    }

    if (!this.isCSharpExtensionReady()) {
      console.warn('[SemanticDependencyResolver] language-service extension is not active or not ready yet.');
      return this.extractEdgesFromFilesystem(this.workspaceRoot || this.getDefaultRepositoryRoot(uniqueNodes), onProgress);
    }

    const edges = new Map<string, Set<string>>();
    const total = uniqueNodes.length;

    for (let index = 0; index < uniqueNodes.length; index += this.batchSize) {
      const batch = uniqueNodes.slice(index, index + this.batchSize);
      const batchResults = await Promise.all(
        batch.map((uri) => this.extractLinksForFile(uri).catch((error) => {
          console.error(`[SemanticDependencyResolver] Failed to process ${uri.fsPath}:`, error);
          return [] as GraphLink[];
        })),
      );

      for (const links of batchResults) {
        for (const link of links) {
          const key = `${link.source}\u0000${link.target}`;
          if (!edges.has(key)) {
            edges.set(key, new Set());
          }
          edges.get(key)!.add(link.target);
        }
      }

      const processed = Math.min(index + batch.length, total);
      const percent = Math.round((processed / total) * 100);
      onProgress?.(`[SemanticDependencyResolver] processing semantic dependency graph: ${processed}/${total} files (${percent}%)`, percent, processed, total);
    }

    return Array.from(edges.entries()).map(([key, targets]) => {
      const [source, target] = key.split('\u0000');
      return {
        source,
        target,
        weight: targets.size,
      };
    });
  }

  /**
   * Serializes the extracted links into the JSON artifact format expected by the
   * codebase-memory graph import pipeline. The file is intentionally simple so it
   * can be consumed by downstream tooling without requiring a local DB schema.
   */
  writeLinksFile(links: GraphLink[], outputPath: string): number {
    const normalized = this.dedupeLinks(links);
    const payload = JSON.stringify(normalized, null, 2);
    fs.writeFileSync(outputPath, payload, 'utf8');
    return normalized.length;
  }

  /**
   * Queries the active C# language server for every symbol in a file and follows
   * the symbol's references to other files. This is the main semantic dependency
   * extraction step and mirrors the way Roslyn resolves cross-file type usage.
   */
  private async extractLinksForFile(uri: GraphUri): Promise<GraphLink[]> {
    const sourcePath = this.toGraphPath(uri);
    const links = new Map<string, GraphLink>();
    const symbols = await this.getSymbolsForFile(uri);

    for (const symbol of symbols) {
      const position = this.getSymbolPosition(symbol);
      if (!position) {
        continue;
      }

      const references = await this.queryReferences(uri, position);
      for (const reference of references) {
        const targetUri = 'uri' in reference ? reference.uri : undefined;
        if (!targetUri || targetUri.toString() === uri.toString()) {
          continue;
        }

        const targetPath = this.toGraphPath(targetUri);
        if (sourcePath === targetPath) {
          continue;
        }

        const key = `${sourcePath}\u0000${targetPath}`;
        if (!links.has(key)) {
          links.set(key, { source: sourcePath, target: targetPath, weight: 1 });
        }
      }

      if (references.length === 0) {
        const definitions = await this.queryDefinitions(uri, position);
        for (const definition of definitions) {
          const targetUri = 'uri' in definition ? definition.uri : definition.targetUri;
          if (!targetUri || targetUri.toString() === uri.toString()) {
            continue;
          }

          const targetPath = this.toGraphPath(targetUri);
          if (sourcePath === targetPath) {
            continue;
          }

          const key = `${sourcePath}\u0000${targetPath}`;
          if (!links.has(key)) {
            links.set(key, { source: sourcePath, target: targetPath, weight: 1 });
          }
        }
      }
    }

    return Array.from(links.values());
  }

  private async getSymbolsForFile(uri: GraphUri): Promise<SymbolLike[]> {
    if (!vscodeModule) {
      return [];
    }

    const result = await vscodeModule.commands.executeCommand<unknown>(
      'vscode.executeDocumentSymbolProvider',
      uri,
    );

    if (!result) {
      return [];
    }

    const rawSymbols = Array.isArray(result) ? result : (result as { symbols?: unknown[] }).symbols ?? [];
    return this.flattenSymbols(rawSymbols as SymbolLike[]);
  }

  private async queryReferences(uri: GraphUri, position: PositionLike): Promise<ReferenceLike[]> {
    if (!vscodeModule) {
      return [];
    }

    const result = await vscodeModule.commands.executeCommand<ReferenceLike[] | undefined>(
      'vscode.executeReferenceProvider',
      uri,
      position,
    );

    return result ?? [];
  }

  private async queryDefinitions(uri: GraphUri, position: PositionLike): Promise<ReferenceLike[]> {
    if (!vscodeModule) {
      return [];
    }

    const result = await vscodeModule.commands.executeCommand<ReferenceLike[] | undefined>(
      'vscode.executeDefinitionProvider',
      uri,
      position,
    );

    return result ?? [];
  }

  private flattenSymbols(symbols: readonly SymbolLike[]): SymbolLike[] {
    const result: SymbolLike[] = [];

    for (const symbol of symbols) {
      if (symbol.children && symbol.children.length > 0) {
        result.push(symbol, ...this.flattenSymbols(symbol.children));
      } else {
        result.push(symbol);
      }
    }

    return result;
  }

  private getSymbolPosition(symbol: SymbolLike): PositionLike | undefined {
    if (symbol.selectionRange) {
      return symbol.selectionRange.start;
    }

    if (symbol.range) {
      return symbol.range.start;
    }

    return undefined;
  }

  private toGraphPath(uri: GraphUri): string {
    if (this.workspaceRoot) {
      const relative = path.relative(this.workspaceRoot, uri.fsPath).replace(/\\/g, '/');
      if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
        return relative;
      }
    }

    return path.basename(uri.fsPath);
  }

  private dedupeNodes(nodes: readonly GraphUri[]): GraphUri[] {
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

  private dedupeLinks(links: readonly GraphLink[]): GraphLink[] {
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

  private chunk<T>(items: readonly T[], size: number): T[][] {
    const result: T[][] = [];
    for (let index = 0; index < items.length; index += size) {
      result.push(items.slice(index, index + size) as T[]);
    }
    return result;
  }

  private isCSharpExtensionReady(): boolean {
    if (!vscodeModule) {
      return false;
    }

    const csharp = vscodeModule.extensions.getExtension('ms-dotnettools.csharp');
    const csdevkit = vscodeModule.extensions.getExtension('ms-dotnettools.csdevkit');
    const ready = !!(csharp?.isActive || csdevkit?.isActive);
    const hasCSharpFiles = vscodeModule.workspace.textDocuments.some((document: { languageId: string }) => document.languageId === 'csharp')
      || !!vscodeModule.workspace.workspaceFolders?.some((folder: { uri: { fsPath: string } }) => {
          const pathToFile = folder.uri.fsPath;
          return pathToFile.length > 0;
        });

    return ready && hasCSharpFiles;
  }

  private getWorkspaceRoot(): string {
    if (!vscodeModule || !vscodeModule.workspace.workspaceFolders?.length) {
      return '';
    }
    return vscodeModule.workspace.workspaceFolders[0].uri.fsPath;
  }

  private getDefaultRepositoryRoot(nodes: readonly GraphUri[]): string {
    if (nodes.length === 0) {
      return '';
    }
    const root = nodes[0].fsPath;
    const parent = path.dirname(root);
    return parent;
  }

  collectCSharpFiles(rootDir: string): GraphUri[] {
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

  private isSupportedSemanticFile(filePath: string): boolean {
    const extension = path.extname(filePath).toLowerCase();
    return ['.cs', '.razor', '.js', '.jsx', '.ts', '.tsx', '.md', '.markdown'].includes(extension);
  }

  async extractEdgesFromFilesystem(rootDir: string, onProgress?: (message: string, percent: number, processed: number, total: number) => void): Promise<GraphLink[]> {
    const files = this.collectCSharpFiles(rootDir);
    if (files.length === 0) {
      return [];
    }

    const links = new Map<string, GraphLink>();
    const total = files.length;
    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      const fileLinks = await this.extractLinksFromRawFile(file.fsPath);
      for (const link of fileLinks) {
        const key = `${link.source}\u0000${link.target}`;
        if (!links.has(key)) {
          links.set(key, link);
        }
      }

      const percent = Math.round(((index + 1) / total) * 100);
      onProgress?.(`[SemanticDependencyResolver] processing semantic files: ${index + 1}/${total} (${percent}%)`, percent, index + 1, total);
    }

    return Array.from(links.values());
  }

  private async extractLinksFromRawFile(filePath: string): Promise<GraphLink[]> {
    const content = fs.readFileSync(filePath, 'utf8');
    const fileLinks: GraphLink[] = [];
    const source = this.toGraphPath({ fsPath: filePath, toString: () => filePath });
    const addLink = (candidate: string | undefined) => {
      if (!candidate) {
        return;
      }

      const resolved = this.resolveReferenceTarget(filePath, candidate);
      if (!resolved) {
        return;
      }

      const target = this.toGraphPath({ fsPath: resolved, toString: () => resolved });
      if (!target || source === target) {
        return;
      }

      fileLinks.push({ source, target, weight: 1 });
    };

    const extension = path.extname(filePath).toLowerCase();

    if (['.js', '.jsx', '.ts', '.tsx'].includes(extension)) {
      const importPattern = /(?:import|export)\s+(?:[\w*{}\s,]+\s+from\s+)?['"]([^'"]+)['"]|require\(\s*['"]([^'"]+)['"]\s*\)|import\(\s*['"]([^'"]+)['"]\s*\)/g;
      for (const match of content.matchAll(importPattern)) {
        addLink(match[1] || match[2] || match[3]);
      }
      return this.dedupeLinks(fileLinks);
    }

    if (extension === '.razor') {
      const componentPattern = /<([A-Z][A-Za-z0-9_.]*)\b/g;
      for (const match of content.matchAll(componentPattern)) {
        const componentName = match[1]?.split('.').pop();
        if (!componentName) {
          continue;
        }
        const candidate = this.resolveComponentTarget(filePath, componentName);
        addLink(candidate ? path.relative(path.dirname(filePath), candidate).replace(/\\/g, '/') : undefined);
      }
      return this.dedupeLinks(fileLinks);
    }

    if (['.md', '.markdown'].includes(extension)) {
      const markdownPattern = /!??\[[^\]]*\]\(([^)]+)\)|^\[[^\]]+\]:\s*(\S+)/gm;
      for (const match of content.matchAll(markdownPattern)) {
        addLink(match[1] || match[2]);
      }
      return this.dedupeLinks(fileLinks);
    }

    const importPattern = /(?:using\s+)(?:[A-Za-z_][\w.]*\s*;|\(.*?\))/g;
    const matches = [...content.matchAll(importPattern)];
    const targets = matches.map((match) => match[0].replace(/using\s+|;|\s+/g, '').replace(/[()]/g, ''))
      .filter(Boolean)
      .map((name) => name.replace(/\.$/, ''));

    for (const target of targets) {
      const targetPath = target.replace(/\./g, '/');
      fileLinks.push({ source, target: targetPath, weight: 1 });
    }

    return this.dedupeLinks(fileLinks.filter((link) => link.source !== link.target));
  }

  private resolveReferenceTarget(filePath: string, value: string): string | undefined {
    const normalized = value.trim().replace(/^['"]|['"]$/g, '').replace(/[?#].*$/, '');
    if (!normalized || normalized.startsWith('http:') || normalized.startsWith('https:') || normalized.startsWith('mailto:') || normalized.startsWith('data:') || normalized.startsWith('#')) {
      return undefined;
    }

    const baseDir = path.dirname(filePath);
    const resolved = path.resolve(baseDir, normalized);
    const candidates: string[] = [resolved];

    if (!path.extname(resolved)) {
      candidates.push(
        `${resolved}.cs`, `${resolved}.razor`, `${resolved}.js`, `${resolved}.jsx`, `${resolved}.ts`, `${resolved}.tsx`, `${resolved}.md`, `${resolved}.markdown`,
        path.join(resolved, 'index.cs'), path.join(resolved, 'index.razor'), path.join(resolved, 'index.js'), path.join(resolved, 'index.ts'), path.join(resolved, 'index.md'),
      );
    }

    for (const candidate of candidates) {
      if (fs.existsSync(candidate) && this.isSupportedSemanticFile(candidate)) {
        return candidate;
      }
    }

    return undefined;
  }

  private resolveComponentTarget(filePath: string, componentName: string): string | undefined {
    const baseDir = path.dirname(filePath);
    const names = [componentName, componentName.replace(/\./g, '/')];
    for (const name of names) {
      const candidates = [
        path.join(baseDir, `${name}.razor`),
        path.join(baseDir, `${name}.cs`),
        path.join(baseDir, `${name}.js`),
        path.join(baseDir, `${name}.ts`),
      ];

      for (const candidate of candidates) {
        if (fs.existsSync(candidate)) {
          return candidate;
        }
      }
    }

    return undefined;
  }
}
