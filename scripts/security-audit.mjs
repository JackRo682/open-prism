import { execFileSync, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const reports = new URL('../.sites-runtime/security/reports/', import.meta.url);
const lockPath = new URL('../pnpm-lock.yaml', import.meta.url);
const digest = () => createHash('sha256').update(readFileSync(lockPath)).digest('hex');
if (execFileSync('pnpm', ['--version'], { cwd: root, encoding: 'utf8' }).trim() !== '11.25.0') {
  throw new Error('Audit the lockfile using the pinned pnpm 11.25.0.');
}
const before = digest();
mkdirSync(reports, { recursive: true });
let failed = false;
for (const scope of ['production', 'all']) {
  // Capture the complete advisory report, including moderate findings. Registry
  // failures are errors, not an empty vulnerability result or an ignored exit.
  const result = spawnSync('pnpm', ['audit', ...(scope === 'production' ? ['--prod'] : []), '--json'], {
    cwd: root, encoding: 'utf8', timeout: 120_000, maxBuffer: 16 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let report;
  try { report = JSON.parse(result.stdout); } catch { report = null; }
  const counts = report?.metadata?.vulnerabilities;
  const severities = ['info', 'low', 'moderate', 'high', 'critical'];
  const valid = !result.error && [0, 1].includes(result.status) && !report?.error &&
    counts && severities.every(key => Number.isSafeInteger(counts[key]) && counts[key] >= 0) &&
    (result.status === 0 || severities.some(key => counts[key] > 0));
  if (!valid) {
    writeFileSync(new URL('audit-' + scope + '.json', reports), JSON.stringify({ status: 'error', lockfileSha256: before }) + '\n');
    console.error('Dependency audit ' + scope + ' could not complete; the security gate fails closed.');
    failed = true;
    continue;
  }
  writeFileSync(new URL('audit-' + scope + '.json', reports), JSON.stringify({ ...report, lockfileSha256: before }, null, 2) + '\n');
  console.log(JSON.stringify({ check: 'dependencies', scope, lockfileSha256: before, ...counts }));
  if (counts.high || counts.critical) failed = true;
}
if (digest() !== before) throw new Error('The lockfile changed during the audit. Repeat against the final source.');
process.exitCode = failed ? 1 : 0;
