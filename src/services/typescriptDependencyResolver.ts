import * as fs from 'fs';
import * as path from 'path';
import * as ts from 'typescript';
import type { GraphLink, GraphUri } from './semanticEdgeResolutionStrategyDispatcher';
import { ResolverStrategy, ResolverStrategyType } from './resolverStrategy';

export class TypeScriptDependencyResolver extends ResolverStrategy {
  readonly type = ResolverStrategyType.TypeScript;
  readonly label = 'TypeScriptDependencyResolver (TypeScript compiler strategy)';
  protected readonly supportedExtensions = ['.js', '.jsx', '.ts', '.tsx', '.mjs', '.cjs', '.mts', '.cts'];

  collectTypeScriptFiles(rootDir: string): GraphUri[] {
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
          if (entry.name === '.git' || entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'bin' || entry.name === 'obj') {
            continue;
          }
          stack.push(fullPath);
        }
        continue;
      }

      if (this.isSupportedTypeScriptFile(current)) {
        results.push({ fsPath: current, toString: () => `file://${current}` });
      }
    }

    return results;
  }

  async resolveFile(filePath: string): Promise<GraphLink[]> {
    if (!this.supports(filePath)) {
      return [];
    }

    const rootDir = this.rootDir || process.cwd();
    const relevantFiles = this.collectTypeScriptFiles(rootDir)
      .map((candidate) => candidate.fsPath)
      .filter((candidate) => this.supports(candidate));

    if (relevantFiles.length === 0) {
      return [];
    }

    const strategyLinks = await this.extractTypeScriptEdgesFromFilesystem(rootDir, undefined, relevantFiles);
    const source = this.toGraphPath(filePath, rootDir);
    return strategyLinks.filter((link) => link.source === source);
  }

  async extractTypeScriptEdgesFromFilesystem(
    rootDir: string,
    onProgress?: (message: string, percent: number, processed: number, total: number) => void,
    filesOverride?: readonly string[],
  ): Promise<GraphLink[]> {
    const files = filesOverride && filesOverride.length > 0 ? filesOverride.map((fsPath) => ({ fsPath, toString: () => `file://${fsPath}` })) : this.collectTypeScriptFiles(rootDir);
    if (files.length === 0) {
      return [];
    }

    const compilerLinks = this.extractLinksFromTypeScriptCompiler(rootDir, files);
    if (compilerLinks.length > 0) {
      console.log(`[TypeScriptDependencyResolver] compiler strategy resolved ${compilerLinks.length} TypeScript graph links.`);
      return compilerLinks;
    }

    const links = new Map<string, GraphLink>();
    const total = files.length;

    for (let index = 0; index < files.length; index += 1) {
      const file = files[index];
      const fileLinks = this.extractLinksFromTypeScriptFile(file.fsPath);
      for (const link of fileLinks) {
        const key = `${link.source}\u0000${link.target}`;
        if (!links.has(key)) {
          links.set(key, link);
        }
      }

      const percent = Math.round(((index + 1) / total) * 100);
      onProgress?.(`[TypeScriptDependencyResolver] processing TypeScript dependency graph: ${index + 1}/${total} (${percent}%)`, percent, index + 1, total);
    }

    return Array.from(links.values());
  }

  private extractLinksFromTypeScriptCompiler(rootDir: string, files: GraphUri[]): GraphLink[] {
    const sourceFiles = files
      .map((file) => file.fsPath)
      .filter((filePath) => !filePath.endsWith('.d.ts'));

    if (sourceFiles.length === 0) {
      return [];
    }

    const compilerOptions = this.getCompilerOptions(rootDir);
    const program = ts.createProgram(sourceFiles, compilerOptions, ts.createCompilerHost(compilerOptions, true));
    const links = new Map<string, GraphLink>();

    for (const sourceFile of program.getSourceFiles()) {
      if (sourceFile.isDeclarationFile || !this.isSupportedTypeScriptFile(sourceFile.fileName)) {
        continue;
      }

      const source = this.toGraphPath(sourceFile.fileName, rootDir);
      if (!source || source === '.') {
        continue;
      }

      for (const statement of sourceFile.statements) {
        const moduleSpecifiers = this.collectModuleSpecifiers(statement);
        for (const moduleSpecifier of moduleSpecifiers) {
          const resolved = this.resolveModuleSpecifier(sourceFile, moduleSpecifier, compilerOptions);
          if (!resolved) {
            continue;
          }

          const target = this.toGraphPath(resolved, rootDir);
          if (!target || source === target) {
            continue;
          }

          const key = `${source}\u0000${target}`;
          if (!links.has(key)) {
            links.set(key, { source, target, weight: 1 });
          }
        }
      }
    }

    return Array.from(links.values());
  }

  private getCompilerOptions(rootDir: string): ts.CompilerOptions {
    const configPath = ts.findConfigFile(rootDir, ts.sys.fileExists, 'tsconfig.json');
    if (!configPath) {
      return {
        allowJs: true,
        checkJs: false,
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        moduleResolution: ts.ModuleResolutionKind.Node10,
        resolveJsonModule: true,
        esModuleInterop: true,
      };
    }

    const configFile = ts.readConfigFile(configPath, ts.sys.readFile);
    const parsed = ts.parseJsonConfigFileContent(configFile.config, ts.sys, path.dirname(configPath));
    return parsed.options;
  }

  private collectModuleSpecifiers(statement: ts.Statement): string[] {
    const specifiers: string[] = [];

    if (ts.isImportDeclaration(statement) || ts.isExportDeclaration(statement)) {
      const moduleSpecifier = statement.moduleSpecifier;
      if (moduleSpecifier && ts.isStringLiteral(moduleSpecifier)) {
        specifiers.push(moduleSpecifier.text);
      }
      return specifiers;
    }

    if (ts.isExpressionStatement(statement)) {
      const expression = statement.expression;
      if (ts.isCallExpression(expression)) {
        const callee = expression.expression;
        const firstArg = expression.arguments[0];
        const literalArgument = firstArg && ts.isSpreadElement(firstArg) ? firstArg.expression : firstArg;
        const isRequireCall = ts.isIdentifier(callee) && callee.text === 'require';
        const isDynamicImportCall = !!(callee && (callee as ts.Expression).kind === ts.SyntaxKind.ImportKeyword);

        if ((isRequireCall || isDynamicImportCall) && literalArgument && ts.isStringLiteral(literalArgument)) {
          specifiers.push(literalArgument.text);
        }
      }
    }

    return specifiers;
  }

  private resolveModuleSpecifier(sourceFile: ts.SourceFile, moduleSpecifier: string, compilerOptions: ts.CompilerOptions): string | undefined {
    if (!moduleSpecifier || moduleSpecifier.startsWith('node:') || moduleSpecifier.startsWith('http:') || moduleSpecifier.startsWith('https:')) {
      return undefined;
    }

    const resolution = ts.resolveModuleName(moduleSpecifier, sourceFile.fileName, compilerOptions, ts.sys);
    const resolvedFileName = resolution.resolvedModule?.resolvedFileName;
    if (!resolvedFileName || resolvedFileName.endsWith('.d.ts')) {
      return undefined;
    }

    if (this.isSupportedTypeScriptFile(resolvedFileName) || this.isSupportedSemanticFile(resolvedFileName)) {
      return resolvedFileName;
    }

    return undefined;
  }

  private isSupportedTypeScriptFile(filePath: string): boolean {
    const extension = path.extname(filePath).toLowerCase();
    return ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'].includes(extension);
  }

  private isSupportedSemanticFile(filePath: string): boolean {
    const extension = path.extname(filePath).toLowerCase();
    return ['.cs', '.razor', '.js', '.jsx', '.ts', '.tsx', '.md', '.markdown'].includes(extension);
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

  private extractLinksFromTypeScriptFile(filePath: string): GraphLink[] {
    const content = fs.readFileSync(filePath, 'utf8');
    const source = this.toGraphPath(filePath, path.dirname(filePath));
    const fileLinks: GraphLink[] = [];

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

      fileLinks.push({ source, target, weight: 1 });
    };

    const importPattern = /(?:import|export)\s+(?:[\w*{}\s,]+\s+from\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)|require\(\s*['"]([^'"]+)['"]\s*\)/g;
    for (const match of content.matchAll(importPattern)) {
      const candidate = match[1] ?? match[2] ?? match[3];
      addLink(candidate);
    }

    return this.dedupeLinks(fileLinks);
  }
}
