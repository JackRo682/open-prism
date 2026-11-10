import { execFileSync, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { cp, lstat, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { verifyFrameworkArtifactBoundary } from './security-artifact-policy.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const runtime = path.join(root, '.sites-runtime/security');
const reports = path.join(runtime, 'reports');
const config = path.join(root, '.gitleaks.toml');
const args = process.argv.slice(2);
if (args.some(arg => !['--artifacts', '--artifacts-only'].includes(arg))) {
  throw new Error('Usage: node scripts/security-secrets.mjs [--artifacts|--artifacts-only]');
}
const binary = process.env.GITLEAKS_BIN || path.join(runtime, 'bin/gitleaks');
let scannerVersion;
try { scannerVersion = execFileSync(binary, ['version'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim(); }
catch { throw new Error('Gitleaks is unavailable. Run bash scripts/install-security-tools.sh first.'); }
if (scannerVersion !== '8.30.1') throw new Error('Use the reviewed Gitleaks 8.30.1 scanner.');
await mkdir(reports, { recursive: true });
let failed = false;

// Verify detection and redaction with an invented, never-issued credential.
// A scanner/configuration that silently ignores everything must not pass CI.
const control = await mkdtemp(path.join(runtime, 'control.'));
try {
  const synthetic = 'ghp_' + randomBytes(18).toString('hex');
  await writeFile(path.join(control, 'positive-control.txt'), 'GITHUB_TOKEN=' + synthetic + '\n');
  const checked = spawnSync(binary, ['dir', '--no-banner', '--no-color', '--redact=100',
    '--config', config, '--ignore-gitleaks-allow', '--report-format=json', '--report-path=-', control], {
    cwd: root, encoding: 'utf8', timeout: 10_000, stdio: ['ignore', 'pipe', 'pipe'],
  });
  let detected;
  try { detected = JSON.parse(checked.stdout); } catch { detected = null; }
  if (checked.error || checked.status !== 1 || !Array.isArray(detected) ||
    !detected.some(row => row.RuleID === 'github-pat') ||
    (checked.stdout + checked.stderr).includes(synthetic)) {
    throw new Error('The secret scanner detection/redaction control failed.');
  }
} finally { await rm(control, { recursive: true, force: true }); }

async function scan(name, mode, target, extra = [], artifactPolicy) {
  const reportPath = path.join(reports, 'secrets-' + name + '.json');
  // Remove a previous result so a scanner failure cannot reuse a stale pass.
  await rm(reportPath, { force: true });
  const result = spawnSync(binary, [mode, '--no-banner', '--no-color', '--redact=100',
    '--config', config, '--ignore-gitleaks-allow', '--exit-code=1', '--timeout=180', '--report-format=json',
    '--report-path', reportPath, ...extra, target], {
    cwd: root, encoding: 'utf8', timeout: 190_000, maxBuffer: 8 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let findings;
  try { findings = JSON.parse(await readFile(reportPath, 'utf8')); }
  catch { throw new Error('Secret scan ' + name + ' failed to produce a readable result.'); }
  if (!Array.isArray(findings) || result.error || ![0, 1].includes(result.status)) {
    throw new Error('Secret scan ' + name + ' could not complete.');
  }
  // Persist locations only. Do not emit credential values or surrounding text,
  // even if a future scanner release changes its report redaction behavior.
  const expected = artifactPolicy ? findings.filter(row => artifactPolicy.isExpectedFinding(row)) : [];
  const unexpected = findings.filter(row => !expected.includes(row));
  const locate = row => ({ rule: row.RuleID, file: row.File,
    line: row.StartLine, commit: row.Commit || null });
  const locations = unexpected.map(locate);
  const allowedFrameworkGuards = expected.map(row => ({ ...locate(row),
    reason: 'Generated private framework guard; exact value absent from public assets' }));
  await writeFile(reportPath, JSON.stringify({ scanner: scannerVersion, scope: name, findings: locations,
    ...(artifactPolicy ? { allowedFrameworkGuards, publicFilesChecked: artifactPolicy.clientFiles } : {}) }, null, 2) + '\n');
  console.log(JSON.stringify({ check: 'secrets', scope: name, candidates: locations.length,
    ...(artifactPolicy ? { allowedFrameworkGuards: expected.length, publicFilesChecked: artifactPolicy.clientFiles } : {}) }));
  if (locations.length || result.status !== 0 && findings.length === 0) failed = true;
}

if (!args.includes('--artifacts-only')) {
  await scan('history', 'git', root, ['--log-opts=--all']);
  // Include uncommitted source without scanning ignored caches or dependencies.
  // Tracked files remain included even if a later ignore rule hides their path.
  const files = execFileSync('git', ['ls-files', '-z', '--cached', '--others', '--exclude-standard'], {
    cwd: root, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024,
  }).split('\0').filter(Boolean);
  const staging = await mkdtemp(path.join(runtime, 'source.'));
  try {
    for (const name of new Set(files)) {
      const source = path.resolve(root, name);
      if (!source.startsWith(root) || path.isAbsolute(name) || name.split('/').includes('..')) {
        throw new Error('Unexpected path in source inventory.');
      }
      let info;
      try { info = await lstat(source); } catch (error) { if (error.code === 'ENOENT') continue; throw error; }
      if (info.isSymbolicLink()) continue;
      if (!info.isFile()) throw new Error('Source inventory contains a non-regular file.');
      const destination = path.join(staging, name);
      await mkdir(path.dirname(destination), { recursive: true });
      await cp(source, destination, { dereference: false });
    }
    await scan('source', 'dir', staging);
  } finally { await rm(staging, { recursive: true, force: true }); }
}
if (args.includes('--artifacts') || args.includes('--artifacts-only')) {
  const directory = path.join(root, 'dist');
  if (!(await lstat(directory)).isDirectory()) throw new Error('Build dist before scanning artifacts.');
  const policy = await verifyFrameworkArtifactBoundary(directory);
  await scan('artifacts', 'dir', directory, [], policy);
}
process.exitCode = failed ? 1 : 0;
