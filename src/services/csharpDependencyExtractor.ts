import * as path from 'path';
import * as vscode from 'vscode';

export interface GraphLink {
  source: string;
  target: string;
  weight: number;
}

type SymbolLike = vscode.SymbolInformation | vscode.DocumentSymbol;

export class CsharpDependencyExtractor {
  private readonly concurrencyLimit = 4;
  private readonly batchSize = 8;

  constructor(private readonly workspaceRoot: string = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath ?? '') {}

  /**
   * Extracts cross-file dependencies for a batch of C# file URIs.
   *
   * Each file is processed using the active C# language service, which resolves
   * broad symbol references and definitions via the same semantic pipeline Roslyn
   * uses internally. The result is a graph link list that can be fed directly into
   * the codebase-memory indexer.
   */
  async extractEdges(nodes: vscode.Uri[]): Promise<GraphLink[]> {
    const uniqueNodes = this.dedupeNodes(nodes);
    if (uniqueNodes.length === 0) {
      return [];
    }

    if (!this.isCSharpExtensionReady()) {
      console.warn('[CsharpDependencyExtractor] C# extension is not active or not ready yet.');
      return [];
    }

    const edges = new Map<string, Set<string>>();

    for (const batch of this.chunk(uniqueNodes, this.batchSize)) {
      const batchResults = await Promise.all(
        batch.map((uri) => this.extractLinksForFile(uri).catch((error) => {
          console.error(`[CsharpDependencyExtractor] Failed to process ${uri.fsPath}:`, error);
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
   * Queries the active C# language server for every symbol in a file and follows
   * the symbol's references to other files. This is the main semantic dependency
   * extraction step and mirrors the way Roslyn resolves cross-file type usage.
   */
  private async extractLinksForFile(uri: vscode.Uri): Promise<GraphLink[]> {
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

  private async getSymbolsForFile(uri: vscode.Uri): Promise<SymbolLike[]> {
    const result = await vscode.commands.executeCommand<unknown>(
      'vscode.executeDocumentSymbolProvider',
      uri,
    );

    if (!result) {
      return [];
    }

    const rawSymbols = Array.isArray(result) ? result : (result as { symbols?: unknown[] }).symbols ?? [];
    return this.flattenSymbols(rawSymbols as SymbolLike[]);
  }

  private async queryReferences(uri: vscode.Uri, position: vscode.Position): Promise<vscode.Location[]> {
    const result = await vscode.commands.executeCommand<vscode.Location[] | undefined>(
      'vscode.executeReferenceProvider',
      uri,
      position,
    );

    return result ?? [];
  }

  private async queryDefinitions(uri: vscode.Uri, position: vscode.Position): Promise<Array<vscode.Location | vscode.LocationLink>> {
    const result = await vscode.commands.executeCommand<vscode.Location[] | vscode.LocationLink[] | undefined>(
      'vscode.executeDefinitionProvider',
      uri,
      position,
    );

    if (!result) {
      return [];
    }

    return result.map((entry) => {
      if ('uri' in entry) {
        return entry as vscode.Location;
      }

      return entry as vscode.LocationLink;
    });
  }

  private flattenSymbols(symbols: readonly SymbolLike[]): SymbolLike[] {
    const result: SymbolLike[] = [];

    for (const symbol of symbols) {
      if ('children' in symbol && symbol.children) {
        result.push(symbol, ...this.flattenSymbols(symbol.children as SymbolLike[]));
      } else {
        result.push(symbol);
      }
    }

    return result;
  }

  private getSymbolPosition(symbol: SymbolLike): vscode.Position | undefined {
    if ('selectionRange' in symbol && symbol.selectionRange) {
      return symbol.selectionRange.start;
    }

    if ('range' in symbol && symbol.range) {
      return symbol.range.start;
    }

    return undefined;
  }

  private toGraphPath(uri: vscode.Uri): string {
    if (this.workspaceRoot) {
      const relative = path.relative(this.workspaceRoot, uri.fsPath).replace(/\\/g, '/');
      if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
        return relative;
      }
    }

    return path.basename(uri.fsPath);
  }

  private dedupeNodes(nodes: readonly vscode.Uri[]): vscode.Uri[] {
    const seen = new Set<string>();
    const unique: vscode.Uri[] = [];

    for (const node of nodes) {
      const key = node.toString();
      if (!seen.has(key)) {
        seen.add(key);
        unique.push(node);
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
    const csharp = vscode.extensions.getExtension('ms-dotnettools.csharp');
    const csdevkit = vscode.extensions.getExtension('ms-dotnettools.csdevkit');
    const ready = !!(csharp?.isActive || csdevkit?.isActive);
    const hasCSharpFiles = vscode.workspace.textDocuments.some((document: vscode.TextDocument) => document.languageId === 'csharp')
      || !!vscode.workspace.workspaceFolders?.some((folder: vscode.WorkspaceFolder) => {
          const pathToFile = folder.uri.fsPath;
          return pathToFile.length > 0;
        });

    return ready && hasCSharpFiles;
  }
}
