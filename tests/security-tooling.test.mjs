import test from 'node:test';
import assert from 'node:assert/strict';
import { createSbom } from '../scripts/security-sbom.mjs';

test('SBOM keeps dependency edges through repeated peer instances and separates production inventory', () => {
  const one = { from: '@scope/one', version: '1.2.3', dependencies: { shared: { from: 'shared', version: '2.0.0' } } };
  const two = { from: 'two', version: '3.0.0', dependencies: { shared: { from: 'shared', version: '2.0.0', dependencies: { leaf: { from: 'leaf', version: '4.0.0' } } } } };
  const all = [{ name: 'app', version: '1.0.0', dependencies: { one }, devDependencies: { two } }];
  const prod = [{ name: 'app', version: '1.0.0', dependencies: { one } }];
  const bom = createSbom(all, prod, { pnpmVersion: '11.25.0', lockfileSha256: 'abc', revision: 'test' });
  assert.equal(bom.components.length, 4);
  assert.ok(bom.components.some(row => row.purl === 'pkg:npm/%40scope/one@1.2.3' && row.group === '@scope'));
  assert.equal(bom.components.find(row => row.name === 'shared').properties[0].value, 'true');
  assert.equal(bom.components.find(row => row.name === 'two').properties[0].value, 'false');
  assert.deepEqual(bom.dependencies.find(row => row.ref === 'pkg:npm/shared@2.0.0').dependsOn, ['pkg:npm/leaf@4.0.0']);
  const refs = new Set([bom.metadata.component['bom-ref'], ...bom.components.map(row => row['bom-ref'])]);
  for (const edge of bom.dependencies) for (const target of edge.dependsOn) assert.ok(refs.has(target));
});

test('SBOM fails for an empty or unsupported graph instead of inventing dependency evidence', () => {
  const metadata = { pnpmVersion: '11.25.0', lockfileSha256: 'abc', revision: 'test' };
  assert.throws(() => createSbom([], [], metadata));
  assert.throws(() => createSbom([{ name: 'app', version: '1.0.0' }], [{}], metadata), /empty/);
  assert.throws(() => createSbom([{ name: 'app', version: '1.0.0', dependencies: { bad: { from: 'bad', version: 'https://example.test/archive' } } }], [{}], metadata), /Unsupported/);
});
