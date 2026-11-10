import test from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { verifyFrameworkArtifactBoundary } from '../scripts/security-artifact-policy.mjs';

async function fixture(run) {
  const directory = await mkdtemp(path.join(tmpdir(), 'prism-artifacts-'));
  const secret = randomBytes(32).toString('hex');
  try {
    await mkdir(path.join(directory, 'server'));
    await mkdir(path.join(directory, 'client'));
    await writeFile(path.join(directory, 'server/vinext-server.json'), JSON.stringify({ prerenderSecret: secret }));
    await writeFile(path.join(directory, 'server/index.js'), 'const guard=' + JSON.stringify(secret) + ';');
    await writeFile(path.join(directory, 'server/wrangler.json'), JSON.stringify({ assets: { directory: '../client' } }));
    await writeFile(path.join(directory, 'client/app.js'), 'console.log("public");');
    await run(directory, secret);
  } finally { await rm(directory, { recursive: true, force: true }); }
}

test('the artifact exception recognizes only the exact generated server field after a boundary check', async () => {
  await fixture(async directory => {
    const policy = await verifyFrameworkArtifactBoundary(directory);
    const finding = { RuleID: 'generic-api-key', File: path.join(directory, 'server/vinext-server.json'),
      Secret: 'REDACTED', Match: 'prerenderSecret":"REDACTED"' };
    assert.equal(policy.clientFiles, 1);
    assert.equal(policy.isExpectedFinding(finding), true);
    assert.equal(policy.isExpectedFinding({ ...finding, Match: 'apiKey":"REDACTED"' }), false);
    assert.equal(policy.isExpectedFinding({ ...finding, File: path.join(directory, 'client/app.js') }), false);
    assert.equal(policy.isExpectedFinding({ ...finding, RuleID: 'github-pat' }), false);
  });
});

test('a generated guard copied into browser assets is rejected even without a key-shaped assignment', async () => {
  await fixture(async (directory, secret) => {
    await writeFile(path.join(directory, 'client/app.js'), 'window.values=[' + JSON.stringify(secret) + '];');
    await assert.rejects(() => verifyFrameworkArtifactBoundary(directory), /exposed in public assets/);
  });
});

test('unexpected metadata fields and public server directories are never broadly excluded', async () => {
  await fixture(async (directory, secret) => {
    await writeFile(path.join(directory, 'server/vinext-server.json'), JSON.stringify({ prerenderSecret: secret, apiKey: 'fixture-only' }));
    await assert.rejects(() => verifyFrameworkArtifactBoundary(directory), /Unexpected Vinext/);
    await writeFile(path.join(directory, 'server/vinext-server.json'), JSON.stringify({ prerenderSecret: secret }));
    await writeFile(path.join(directory, 'server/wrangler.json'), JSON.stringify({ assets: { directory: '..' } }));
    await assert.rejects(() => verifyFrameworkArtifactBoundary(directory), /public asset boundary/);
  });
});
