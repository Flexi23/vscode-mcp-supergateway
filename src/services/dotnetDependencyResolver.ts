import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { createDotNetRoslynRunner, listDotNetEntrypointFiles } from './dotnetRoslynProgram';
import { ResolverStrategy, ResolverStrategyType } from './resolverStrategy';

export interface GraphLink {
  source: string;
  target: string;
  weight: number;
  edgeType: string;
}

export class DotNetDependencyResolver extends ResolverStrategy {
  static readonly roslynResultCache = new Map<string, { fingerprint: string; links: GraphLink[] }>();
  static readonly roslynProjectCache = new Map<string, { projectDir: string; projectFile: string; programFile: string; dotnetExecutable: string; entryPointFile: string }>();

  readonly type = ResolverStrategyType.DotNet;
  readonly label = 'DotNetDependencyResolver (Roslyn .NET strategy)';
  protected readonly supportedExtensions = ['.cs', '.razor'];

  async resolveFile(filePath: string): Promise<GraphLink[]> {
    if (!this.supports(filePath)) {
      return [];
    }

    const rootDir = this.rootDir || process.cwd();
    const relevantFiles = this.collectRelevantFiles(rootDir)
      .filter((candidate: string) => this.supports(candidate));

    if (relevantFiles.length === 0) {
      return [];
    }

    const links = await this.extractEdges(rootDir, undefined, relevantFiles);
    const source = this.toGraphPath(filePath, rootDir);
    return links.filter((link) => link.source === source);
  }

  async extractEdges(
    rootDir: string = process.cwd(),
    onProgress?: (message: string, percent: number, processed: number, total: number) => void,
    fileOverride?: readonly string[],
  ): Promise<GraphLink[]> {
    const files = fileOverride && fileOverride.length > 0 ? [...fileOverride] : this.collectRelevantFiles(rootDir);
    if (files.length === 0) {
      return [];
    }

    const roslynLinks = this.resolveWithRoslyn(rootDir, files, onProgress);
    const razorLinks = this.resolveRazorLinks(rootDir, files);
    return this.dedupeLinks([...roslynLinks, ...razorLinks]);
  }

  private collectRelevantFiles(rootDir: string): string[] {
    if (!rootDir || !fs.existsSync(rootDir)) {
      return [];
    }

    const stack = [rootDir];
    const seen = new Set<string>();
    const result: string[] = [];

    while (stack.length > 0) {
      const current = stack.pop();
      if (!current || seen.has(current)) {
        continue;
      }

      seen.add(current);

      if (!fs.existsSync(current)) {
        continue;
      }

      const stat = fs.statSync(current);
      if (stat.isDirectory()) {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
          const fullPath = path.join(current, entry.name);
          if (['.git', 'node_modules', 'bin', 'obj', '.vs', 'dist', 'Debug', 'Release'].includes(entry.name)) {
            continue;
          }

          stack.push(fullPath);
        }
        continue;
      }

      if (this.isSupportedDotNetFile(current)) {
        result.push(current);
      }
    }

    return result.sort();
  }

  private resolveWithRoslyn(
    rootDir: string,
    files: string[],
    onProgress?: (message: string, percent: number, processed: number, total: number) => void,
  ): GraphLink[] {
    const csFiles = files.filter((file) => path.extname(file).toLowerCase() === '.cs');
    if (csFiles.length === 0) {
      return [];
    }

    const entryPointFiles = listDotNetEntrypointFiles(rootDir);
    const resolverEntryPoints = entryPointFiles.length > 0 ? entryPointFiles : [path.join(rootDir, 'DotNetDependencyResolver.csproj')];
    console.info(`[DotNet] discovered ${csFiles.length} C# file(s) and ${resolverEntryPoints.length} entrypoint candidate(s) for ${rootDir}`);
    const mergedLinks = new Map<string, GraphLink>();

    for (const [index, entryPointFile] of resolverEntryPoints.entries()) {
      const relativeEntryPoint = path.relative(rootDir, entryPointFile) || path.basename(entryPointFile);
      const fingerprint = this.computeFingerprint([...csFiles, entryPointFile]);
      const cacheKey = `${rootDir}\u0000${entryPointFile}\u0000${fingerprint}`;
      const cached = DotNetDependencyResolver.roslynResultCache.get(cacheKey);
      if (cached) {
        onProgress?.(`[DotNetDependencyResolver] reusing cached Roslyn graph for ${csFiles.length} C# file(s) (${path.basename(entryPointFile)})`, 100, csFiles.length, Math.max(csFiles.length, 1));
        for (const link of cached.links) {
          const dedupeKey = `${link.source}\u0000${link.target}\u0000${link.edgeType}`;
          if (!mergedLinks.has(dedupeKey)) {
            mergedLinks.set(dedupeKey, link);
          }
        }
        continue;
      }

      try {
        const runner = this.getOrCreateRoslynRunner(rootDir, entryPointFile);
        console.info(`[DotNet] starting Roslyn compile for entrypoint ${relativeEntryPoint} (${index + 1}/${resolverEntryPoints.length}); using ${path.basename(runner.projectFile)}; dotnet=${runner.dotnetExecutable}`);
        onProgress?.(`[DotNet] ${relativeEntryPoint}: building graph for ${csFiles.length} C# file(s)`, 5, 0, Math.max(csFiles.length, 1));

        const command = ['run', '--project', runner.projectFile, '--', '--root', rootDir, '--entrypoint', runner.entryPointFile];
        console.info(`[DotNet] invoking ${path.basename(runner.dotnetExecutable)} ${command.join(' ')}`);

        const result = spawnSync(runner.dotnetExecutable, command, {
          encoding: 'utf8',
          cwd: runner.projectDir,
          env: {
            ...process.env,
            DOTNET_ROOT: path.dirname(runner.dotnetExecutable),
            PATH: [path.dirname(runner.dotnetExecutable), process.env.PATH ?? ''].filter(Boolean).join(path.delimiter),
          },
          maxBuffer: 100 * 1024 * 1024,
        });

        const stderr = typeof result.stderr === 'string' ? result.stderr.trim() : String(result.stderr ?? '').trim();
        const stdout = typeof result.stdout === 'string' ? result.stdout.trim() : String(result.stdout ?? '').trim();

        if (result.error) {
          const errorMessage = result.error instanceof Error ? result.error.message : String(result.error);
          const details = [
            `spawn: ${errorMessage}`,
            stderr ? `stderr: ${stderr}` : undefined,
            stdout ? `stdout: ${stdout}` : undefined,
          ].filter(Boolean).join(' | ');

          console.warn(`[DotNet] ${path.relative(rootDir, entryPointFile) || path.basename(entryPointFile)}: failed to start (${details || 'dotnet could not be started'})`);
          continue;
        }

        if (result.status !== 0) {
          const details = [
            `exitCode: ${result.status}`,
            stderr ? `stderr: ${stderr}` : undefined,
            stdout ? `stdout: ${stdout}` : undefined,
          ].filter(Boolean).join(' | ');

          console.warn(`[DotNet] ${path.relative(rootDir, entryPointFile) || path.basename(entryPointFile)}: failed (exit ${result.status}) ${details || 'dotnet exited with a non-zero status'}`);
          continue;
        }

        if (!stdout) {
          console.warn(`[DotNet] ${relativeEntryPoint}: no stdout from Roslyn worker; stderr=${stderr || '(empty)'}`);
          continue;
        }

        console.info(`[DotNet] Roslyn worker for ${relativeEntryPoint} finished with ${stdout.length} bytes of output`);

        const payload = JSON.parse(stdout) as { links?: Array<{ source: string; target: string; weight?: number; edgeType?: string }> };
        const links = Array.isArray(payload.links) ? payload.links.map((entry) => ({
          source: entry.source,
          target: entry.target,
          weight: Math.max(1, entry.weight ?? 1),
          edgeType: entry.edgeType || 'file-reference',
        })) : [];

        DotNetDependencyResolver.roslynResultCache.set(cacheKey, { fingerprint, links });
        onProgress?.(`[DotNet] ${path.relative(rootDir, entryPointFile) || path.basename(entryPointFile)}: ${links.length} edge(s) ready`, 100, csFiles.length, Math.max(csFiles.length, 1));

        for (const link of links) {
          const dedupeKey = `${link.source}\u0000${link.target}\u0000${link.edgeType}`;
          if (!mergedLinks.has(dedupeKey)) {
            mergedLinks.set(dedupeKey, link);
          }
        }
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        console.warn(`[DotNet] ${rootDir}: Roslyn resolution skipped (${message})`);
      }
    }

    return this.dedupeLinks(Array.from(mergedLinks.values()));
  }

  private getOrCreateRoslynRunner(rootDir: string, entryPointFile?: string): { projectDir: string; projectFile: string; programFile: string; dotnetExecutable: string; entryPointFile: string } {
    const cacheKey = `${rootDir}\u0000${entryPointFile || ''}`;
    const existing = DotNetDependencyResolver.roslynProjectCache.get(cacheKey);
    if (existing) {
      return existing;
    }

    const runner = createDotNetRoslynRunner(rootDir, entryPointFile);
    DotNetDependencyResolver.roslynProjectCache.set(cacheKey, runner);
    return runner;
  }

  private computeFingerprint(files: readonly string[]): string {
    const samples = files
      .slice()
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }))
      .map((file) => {
        try {
          const stat = fs.statSync(file);
          return `${file}:${stat.size}:${Number(stat.mtimeMs.toFixed(0))}`;
        } catch {
          return `${file}:0:0`;
        }
      });

    return samples.join(';');
  }

  private resolveRazorLinks(rootDir: string, files: string[]): GraphLink[] {
    const razorFiles = files.filter((file) => path.extname(file).toLowerCase() === '.razor');
    if (razorFiles.length === 0) {
      return [];
    }

    const result: GraphLink[] = [];
    for (const filePath of razorFiles) {
      const content = fs.readFileSync(filePath, 'utf8');
      const matches = [...content.matchAll(/<([A-Z][A-Za-z0-9_.]*)\b/g)];
      const source = this.normalizedPath(rootDir, filePath);

      for (const match of matches) {
        const tagName = match[1]?.split('.').pop();
        if (!tagName) {
          continue;
        }

        const resolved = this.findRazorComponent(rootDir, path.dirname(filePath), tagName);
        if (!resolved || source === this.normalizedPath(rootDir, resolved)) {
          continue;
        }

        result.push({ source, target: this.normalizedPath(rootDir, resolved), weight: 1, edgeType: 'file-reference' });
      }
    }

    return this.dedupeLinks(result);
  }

  private findRazorComponent(rootDir: string, baseDir: string, componentName: string): string | undefined {
    const candidates = [
      path.join(baseDir, `${componentName}.razor`),
      path.join(baseDir, `${componentName}.cs`),
      path.join(rootDir, `${componentName}.razor`),
      path.join(rootDir, `${componentName}.cs`),
    ];

    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        return candidate;
      }
    }

    return undefined;
  }

  private normalizedPath(rootDir: string, filePath: string): string {
    const relative = path.relative(rootDir, filePath).replace(/\\/g, '/');
    return relative.startsWith('..') ? filePath.replace(/\\/g, '/') : relative;
  }

  private dedupeLinks(links: readonly GraphLink[]): GraphLink[] {
    const seen = new Set<string>();
    const result: GraphLink[] = [];

    for (const link of links) {
      const key = `${link.source}\u0000${link.target}\u0000${link.edgeType}`;
      if (!seen.has(key)) {
        seen.add(key);
        result.push({ ...link, weight: Math.max(1, link.weight || 1), edgeType: link.edgeType || 'file-reference' });
      }
    }

    return result;
  }

  private isSupportedDotNetFile(filePath: string): boolean {
    const extension = path.extname(filePath).toLowerCase();
    return ['.cs', '.razor'].includes(extension);
  }
}
