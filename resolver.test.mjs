import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';

execSync('npm run build', { stdio: 'inherit' });
const { SemanticDependencyResolver } = await import('./dist/services/semanticDependencyResolver.js');

test('collects and links .razor, .js, .ts and .md files', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'semantic-resolver-'));
  fs.mkdirSync(path.join(root, 'lib'), { recursive: true });
  fs.mkdirSync(path.join(root, 'Pages'), { recursive: true });

  fs.writeFileSync(path.join(root, 'app.js'), "import './shared.js';\nimport { helper } from './lib/utils.ts';\n");
  fs.writeFileSync(path.join(root, 'shared.js'), 'export const flag = true;\n');
  fs.writeFileSync(path.join(root, 'lib', 'utils.ts'), 'export const helper = 1;\n');
  fs.writeFileSync(path.join(root, 'Pages', 'Demo.razor'), '<PageTitle>Demo</PageTitle>\n<SharedWidget />\n');
  fs.writeFileSync(path.join(root, 'Pages', 'SharedWidget.razor'), '<div>widget</div>\n');
  fs.writeFileSync(path.join(root, 'README.md'), '[Demo](./Pages/Demo.razor)\n\nSee [shared script](./shared.js)\n');

  const extractor = new SemanticDependencyResolver(root);
  const files = extractor.collectCSharpFiles(root);

  assert.ok(files.some((file) => file.fsPath.endsWith('.razor')));
  assert.ok(files.some((file) => file.fsPath.endsWith('.js')));
  assert.ok(files.some((file) => file.fsPath.endsWith('.ts')));
  assert.ok(files.some((file) => file.fsPath.endsWith('.md')));

  const links = await extractor.extractEdgesFromFilesystem(root);
  assert.ok(links.some((link) => link.source.endsWith('app.js') && link.target.endsWith('shared.js')));
  assert.ok(links.some((link) => link.source.endsWith('README.md') && link.target.endsWith('Pages/Demo.razor')));
  assert.ok(links.some((link) => link.source.endsWith('app.js') && link.target.endsWith('lib/utils.ts')));
});
