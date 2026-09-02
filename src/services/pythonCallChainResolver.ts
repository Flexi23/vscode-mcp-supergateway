import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { ResolverStrategy, ResolverStrategyType } from './resolverStrategy';

export interface GraphLink {
  source: string;
  target: string;
  weight: number;
  edgeType: string;
}

const IGNORED_DIR_NAMES = new Set(['.git', 'node_modules', '__pycache__', 'venv', '.venv', 'env', 'dist', 'build', '.mypy_cache', '.pytest_cache']);

// Runs under the container's python3 and uses the stdlib `ast` module (the real Python
// parser) to resolve imports, then walks each file's call expressions and resolves callees
// against import bindings and a project-wide (unambiguous) symbol table, emitting file-level
// call-chain edges in the same {source, target, weight} shape as the other resolvers.
const PYTHON_RESOLVER_SCRIPT = String.raw`
import ast
import json
import os
import sys

IGNORED_DIRS = {'.git', 'node_modules', '__pycache__', 'venv', '.venv', 'env', 'dist', 'build', '.mypy_cache', '.pytest_cache'}


def parse_root():
    args = sys.argv[1:]
    for i, arg in enumerate(args):
        if arg == '--root' and i + 1 < len(args):
            return args[i + 1]
    return None


def collect_files(root):
    files = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in IGNORED_DIRS]
        for name in filenames:
            if name.endswith('.py'):
                files.append(os.path.join(dirpath, name))
    return sorted(files)


def module_name_for(root, file_path):
    rel = os.path.relpath(file_path, root)
    if rel.endswith('.py'):
        rel = rel[:-3]
    parts = rel.replace(os.sep, '/').split('/')
    if parts and parts[-1] == '__init__':
        parts = parts[:-1]
    return '.'.join(p for p in parts if p)


def main():
    root = parse_root()
    if not root or not os.path.isdir(root):
        print(json.dumps({'links': []}))
        return

    files = collect_files(root)
    if not files:
        print(json.dumps({'links': []}))
        return

    module_to_file = {}
    trees = {}
    for file_path in files:
        try:
            with open(file_path, 'r', encoding='utf-8', errors='replace') as handle:
                source = handle.read()
            trees[file_path] = ast.parse(source, filename=file_path)
        except SyntaxError:
            continue
        module_to_file[module_name_for(root, file_path)] = file_path

    def resolve_module(mod_name, level, current_file):
        if level and level > 0:
            base_parts = module_name_for(root, current_file).split('.')[:-1]
            for _ in range(level - 1):
                if base_parts:
                    base_parts.pop()
            full = '.'.join([p for p in base_parts if p] + ([mod_name] if mod_name else []))
            return module_to_file.get(full)
        if mod_name:
            return module_to_file.get(mod_name)
        return None

    symbol_files = {}
    file_import_bindings = {}

    for file_path, tree in trees.items():
        bindings = {}
        for node in ast.iter_child_nodes(tree):
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                symbol_files.setdefault(node.name, set()).add(file_path)
            elif isinstance(node, ast.Import):
                for alias in node.names:
                    target_file = resolve_module(alias.name, 0, file_path)
                    if target_file:
                        bindings[alias.asname or alias.name.split('.')[0]] = target_file
            elif isinstance(node, ast.ImportFrom):
                target_file = resolve_module(node.module, node.level, file_path)
                if target_file:
                    for alias in node.names:
                        bindings[alias.asname or alias.name] = target_file
        file_import_bindings[file_path] = bindings

    link_weights = {}

    for file_path, tree in trees.items():
        bindings = file_import_bindings.get(file_path, {})
        for node in ast.walk(tree):
            if not isinstance(node, ast.Call):
                continue

            func = node.func
            callee_name = None
            root_name = None
            if isinstance(func, ast.Name):
                callee_name = func.id
                root_name = func.id
            elif isinstance(func, ast.Attribute):
                callee_name = func.attr
                cursor = func.value
                while isinstance(cursor, ast.Attribute):
                    cursor = cursor.value
                if isinstance(cursor, ast.Name):
                    root_name = cursor.id

            target_file = None
            if root_name and root_name in bindings:
                target_file = bindings[root_name]
            elif callee_name and callee_name in bindings:
                target_file = bindings[callee_name]
            elif callee_name in symbol_files and len(symbol_files[callee_name]) == 1:
                target_file = next(iter(symbol_files[callee_name]))

            if not target_file or target_file == file_path:
                continue

            source_rel = os.path.relpath(file_path, root).replace(os.sep, '/')
            target_rel = os.path.relpath(target_file, root).replace(os.sep, '/')
            if source_rel == target_rel:
                continue

            edge_type = 'call-chain' if root_name and root_name in bindings else 'import-bound-call'
            key = (source_rel, target_rel, edge_type)
            link_weights[key] = link_weights.get(key, 0) + 1

    links = [{'source': s, 'target': t, 'weight': w, 'edgeType': edge_type} for (s, t, edge_type), w in sorted(link_weights.items())]
    print(json.dumps({'links': links}))


main()
`.trim();

export class PythonCallChainResolver extends ResolverStrategy {
  readonly type = ResolverStrategyType.Python;
  readonly label = 'PythonCallChainResolver (ast-based call chain strategy)';
  protected readonly supportedExtensions = ['.py'];

  collectPythonFiles(rootDir: string): string[] {
    if (!rootDir || !fs.existsSync(rootDir)) {
      return [];
    }

    const stack = [rootDir];
    const result: string[] = [];

    while (stack.length > 0) {
      const current = stack.pop();
      if (!current || !fs.existsSync(current)) {
        continue;
      }

      const stat = fs.statSync(current);
      if (stat.isDirectory()) {
        for (const entry of fs.readdirSync(current, { withFileTypes: true })) {
          if (IGNORED_DIR_NAMES.has(entry.name)) {
            continue;
          }
          stack.push(path.join(current, entry.name));
        }
        continue;
      }

      if (path.extname(current).toLowerCase() === '.py') {
        result.push(current);
      }
    }

    return result.sort();
  }

  async resolveFile(filePath: string): Promise<GraphLink[]> {
    if (!this.supports(filePath)) {
      return [];
    }

    const rootDir = this.rootDir || process.cwd();
    const links = await this.extractCallChainEdges(rootDir);
    const source = this.toGraphPath(filePath, rootDir);
    return links.filter((link) => link.source === source);
  }

  async extractCallChainEdges(
    rootDir: string = process.cwd(),
    onProgress?: (message: string, percent: number, processed: number, total: number) => void,
  ): Promise<GraphLink[]> {
    const pyFiles = this.collectPythonFiles(rootDir);
    if (pyFiles.length === 0) {
      return [];
    }

    const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'python-call-chain-resolver-'));
    const scriptPath = path.join(tempRoot, 'resolve_call_chains.py');
    fs.writeFileSync(scriptPath, PYTHON_RESOLVER_SCRIPT, 'utf8');

    onProgress?.(`[PythonCallChainResolver] resolving call chains for ${pyFiles.length} Python file(s)`, 5, 0, Math.max(pyFiles.length, 1));

    try {
      const result = spawnSync('python3', [scriptPath, '--root', rootDir], {
        encoding: 'utf8',
        maxBuffer: 100 * 1024 * 1024,
      });

      if (result.status !== 0) {
        const message = (result.stderr || result.stdout || 'Python call chain resolver failed').trim();
        throw new Error(message || 'Python call chain resolver failed');
      }

      const stdout = (result.stdout || '').trim();
      if (!stdout) {
        return [];
      }

      const payload = JSON.parse(stdout) as { links?: Array<{ source: string; target: string; weight?: number; edgeType?: string }> };
      const links = Array.isArray(payload.links)
        ? payload.links.map((entry) => ({ source: entry.source, target: entry.target, weight: Math.max(1, entry.weight ?? 1), edgeType: entry.edgeType || 'call-chain' }))
        : [];

      onProgress?.(`[PythonCallChainResolver] call chain graph ready: ${links.length} edge(s)`, 100, pyFiles.length, Math.max(pyFiles.length, 1));
      return links;
    } catch (error) {
      if (error instanceof Error) {
        throw error;
      }
      throw new Error(`Failed to run Python call chain resolver: ${String(error)}`);
    } finally {
      fs.rmSync(tempRoot, { recursive: true, force: true });
    }
  }
}
