import * as path from 'path';
import type { GraphLink, GraphUri } from './semanticEdgeResolutionStrategyDispatcher';

export enum ResolverStrategyType {
  DotNet = 'dotnet',
  TypeScript = 'typescript',
  Generic = 'generic',
}

export abstract class ResolverStrategy {
  abstract readonly type: ResolverStrategyType;
  abstract readonly label: string;

  protected abstract readonly supportedExtensions: readonly string[];
  protected rootDir: string = process.cwd();

  public supports(filePath: string): boolean {
    const extension = path.extname(filePath).toLowerCase();
    return this.supportedExtensions.includes(extension);
  }

  public setRootDir(rootDir: string): this {
    this.rootDir = rootDir || process.cwd();
    return this;
  }

  protected normalizeFilePaths(files: ReadonlyArray<GraphUri | string> | undefined): string[] {
    return (files ?? []).map((file) => (typeof file === 'string' ? file : file.fsPath));
  }

  protected toGraphPath(filePath: string, rootDir: string = this.rootDir): string {
    if (rootDir) {
      const relative = path.relative(rootDir, filePath).replace(/\\/g, '/');
      if (relative && !relative.startsWith('..') && !path.isAbsolute(relative)) {
        return relative;
      }
    }

    return path.basename(filePath);
  }

  public abstract resolveFile(filePath: string): Promise<GraphLink[]>;
}
