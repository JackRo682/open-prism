import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

const load = createRequire(import.meta.url);
const nextLoad = createRequire(load.resolve('eslint-config-next'));
const parser = nextLoad('@typescript-eslint/parser');
const parserLoad = createRequire(nextLoad.resolve('@typescript-eslint/parser'));
const estreeLoad = createRequire(parserLoad.resolve('@typescript-eslint/typescript-estree'));
const { minimatch, Minimatch } = estreeLoad('minimatch');

test('the TypeScript parser receives the scoped patched minimatch API and bounded preprocessing', () => {
  assert.equal(estreeLoad('minimatch/package.json').version, '11.0.4');
  assert.equal(minimatch('.config.ts', '*.ts', { dot: true }), true);
  assert.equal(minimatch('nested/private.ts', '*.ts', { dot: true }), false);
  assert.equal(minimatch('config.js', '*.{js,ts}', { dot: true }), true);
  const matcher = new Minimatch(Array(30).fill('**/../a/b').join('/'), { optimizationLevel: 2, braceExpandMax: 64 });
  assert.ok(matcher.set.length <= 64);
});

test('the real parser project service still permits only explicitly matched default-project files', async () => {
  const directory = await mkdtemp(path.join(tmpdir(), 'prism-parser-'));
  const content = 'export const value: string = "verified";';
  try {
    await writeFile(path.join(directory, 'tsconfig.json'), JSON.stringify({ compilerOptions: { strict: true }, files: ['included.ts'] }));
    await writeFile(path.join(directory, 'included.ts'), 'export const included = true;');
    for (const name of ['.config.ts', 'not-allowed.ts']) await writeFile(path.join(directory, name), content);
    const options = file => ({ filePath: path.join(directory, file), tsconfigRootDir: directory,
      projectService: { allowDefaultProject: ['.config.ts'], defaultProject: 'tsconfig.json' },
      sourceType: 'module', loc: true, range: true, tokens: true, comment: true });
    const result = parser.parseForESLint(content, options('.config.ts'));
    assert.ok(result.services.program);
    assert.throws(() => parser.parseForESLint(content, options('not-allowed.ts')), /not found by the project service|allowDefaultProject/i);
  } finally {
    parser.clearCaches();
    await rm(directory, { recursive: true, force: true });
  }
});
