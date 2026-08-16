import * as vscode from 'vscode';
import * as path from 'path';

export interface GraphLink {
  source: string;
  target: string;
  weight: number;
}

export class CsharpDependencyExtractor {
  private readonly concurrencyLimit = 5;

  /**
   * Extracts cross-file dependencies (edges) between C# files.
   * @param nodes A list of C# file URIs.
   * @returns A promise resolving to an array of GraphLinks.
   */
  async extractEdges(nodes: vscode.Uri[]): Promise<GraphLink[]> {
    const edges = new Map<string, Set<string>>();
    const results: GraphLink[] = [];

    // Check if C# extension is active
    if (!this.isCSharpExtensionActive()) {
      console.error('[CsharpDependencyExtractor] C# extension is not active.');
      return [];
    }

    // Process nodes in batches to avoid overloading the LSP
    const queue = [...nodes];
    const workers = Array(Math.min(this.concurrencyLimit, queue.length)).fill(null).map(async () => {
      while (queue.length > 0) {
        const uri = queue.shift();
        if (!uri) continue;

        try {
          const links = await this.extractLinksForFile(uri);
          for (const link of links) {
            const key = `${link.source}|${link.target}`;
            if (!edges.has(key)) {
              edges.set(key, new Set());
            }
            edges.get(key)!.add(link.target);
          }
        } catch (err) {
          console.error(`[CsharpDependencyExtractor] Failed to process ${uri.fsPath}:`, err);
        }
      }
    });

    await Promise.all(workers);

    for (const [key, targets] of edges.entries()) {
      const [source, target] = key.split('|');
      results.push({
        source,
        target,
        weight: targets.size,
      });
    }

    return results;
  }

  /**
   * Extracts links for a single file by querying symbols and their references.
   */
  private async extractLinksForFile(uri: vscode.Uri): Promise<GraphLink[]> {
    const links: GraphLink[] = [];
    
    // Get all symbols in the current file
    const symbols = await vscode.commands.executeCommand<vscode.DocumentSymbolProviderResult>(
      'vscode.executeDocumentSymbolProvider',
      uri
    );

    if (!symbols || !symbols.symbols) return links;

    for (const symbol of symbols.symbols) {
      // For each symbol, find its references
      const references = await vscode.commands.executeCommand<vscode.ReferenceProviderResult>(
        'vscode.executeReferenceProvider',
        uri,
        symbol.range
      );

      if (references && references.references) {
        for (const ref of references.references) {
          const refUri = ref.range.start.uri;
          // Only care about references in different files
          if (refUri && refUri.toString() !== uri.toString()) {
            links.push({
              source: uri.fsPath,
              target: refUri.fsPath,
              weight: 1,
            });
          }
        }
      }
    }

    return links;
  }

  /**
   * Checks if a C# language server is active.
   */
  private isCsharpExtensionActive(): boolean {
    const extensions = vscode.extensions.getExtension('ms-dotnettools.csharp');
    return !!extensions;
  }
}
