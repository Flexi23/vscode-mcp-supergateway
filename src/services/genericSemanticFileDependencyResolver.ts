import * as fs from 'fs';
import * as path from 'path';
import { ResolverStrategy, ResolverStrategyType } from './resolverStrategy';

export interface GraphLink {
  source: string;
  target: string;
  weight: number;
  edgeType: string;
}

type GraphUri = { fsPath: string; toString(): string };

export class GenericSemanticFileDependencyResolver extends ResolverStrategy {
  readonly type = ResolverStrategyType.Generic;
  readonly label = 'GenericSemanticFileDependencyResolver (generic file-based strategy)';
  protected readonly supportedExtensions = ['.cs', '.razor', '.js', '.jsx', '.ts', '.tsx', '.md', '.markdown'];

  async resolveFile(filePath: string): Promise<GraphLink[]> {
    return this.extractLinksFromRawFile(filePath);
  }

  async extractLinksFromRawFile(filePath: string): Promise<GraphLink[]> {
    const content = fs.readFileSync(filePath, 'utf8');
    const fileLinks: GraphLink[] = [];
    const source = this.toGraphPath(filePath, path.dirname(filePath));

    const addLink = (candidate: string | undefined) => {
      if (!candidate) {
        return;
      }

      const resolved = this.resolveReferenceTarget(filePath, candidate);
      if (!resolved) {
        return;
      }

      const target = this.toGraphPath(resolved, path.dirname(filePath));
      if (!target || source === target) {
        return;
      }

      fileLinks.push({ source, target, weight: 1, edgeType: 'file-reference' });
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
    const targets = matches
      .map((match) => match[0].replace(/using\s+|;|\s+/g, '').replace(/[()]/g, ''))
      .filter(Boolean)
      .map((name) => name.replace(/\.$/, ''));

    for (const target of targets) {
      const targetPath = target.replace(/\./g, '/');
      fileLinks.push({ source, target: targetPath, weight: 1, edgeType: 'file-reference' });
    }

    return this.dedupeLinks(fileLinks.filter((link) => link.source !== link.target));
  }

  protected isSupportedSemanticFile(filePath: string): boolean {
    const extension = path.extname(filePath).toLowerCase();
    return ['.cs', '.razor', '.js', '.jsx', '.ts', '.tsx', '.md', '.markdown'].includes(extension);
  }

  protected resolveReferenceTarget(filePath: string, value: string): string | undefined {
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

  protected resolveComponentTarget(filePath: string, componentName: string): string | undefined {
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
}
