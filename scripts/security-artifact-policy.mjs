import { lstat, readFile, readdir } from 'node:fs/promises';
import path from 'node:path';

/**
 * Vinext emits a random private prerender guard into its Worker and server
 * manifest. Accept that one expected artifact only after proving the asset
 * directory excludes the server and the exact value is absent from its files.
 * Source and Git-history scans never use this exception.
 */
export async function verifyFrameworkArtifactBoundary(buildDirectory) {
  const server = path.resolve(buildDirectory, 'server');
  const client = path.resolve(buildDirectory, 'client');
  const manifestPath = path.join(server, 'vinext-server.json');
  for (const location of [buildDirectory, server, client]) {
    const info = await lstat(location);
    if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Build directories must be real, separate directories.');
  }
  const manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (!manifest || Array.isArray(manifest) || Object.keys(manifest).length !== 1 ||
    typeof manifest.prerenderSecret !== 'string' || !/^[a-f0-9]{64}$/.test(manifest.prerenderSecret)) {
    throw new Error('Unexpected Vinext server metadata; review every field before allowing a generated guard.');
  }
  const worker = JSON.parse(await readFile(path.join(server, 'wrangler.json'), 'utf8'));
  if (typeof worker.assets?.directory !== 'string' || path.resolve(server, worker.assets.directory) !== client) {
    throw new Error('The public asset boundary does not exclude private Worker metadata.');
  }
  const secret = Buffer.from(manifest.prerenderSecret);
  if (!(await readFile(path.join(server, 'index.js'))).includes(secret)) {
    throw new Error('The prerender guard is inconsistent with the compiled Worker.');
  }
  let clientFiles = 0;
  async function visit(directory) {
    for (const name of await readdir(directory)) {
      const location = path.join(directory, name), info = await lstat(location);
      if (info.isSymbolicLink()) throw new Error('Public assets must not use links to private build files.');
      if (info.isDirectory()) { await visit(location); continue; }
      if (!info.isFile()) throw new Error('Unexpected non-file public asset.');
      clientFiles++;
      if ((await readFile(location)).includes(secret)) throw new Error('A private framework guard is exposed in public assets.');
    }
  }
  await visit(client);
  if (clientFiles === 0) throw new Error('Cannot verify an empty public asset directory.');
  return {
    clientFiles,
    isExpectedFinding(row) {
      return row.RuleID === 'generic-api-key' && path.resolve(row.File) === manifestPath &&
        row.Secret === 'REDACTED' && /^prerenderSecret"\s*:\s*"REDACTED"$/.test(row.Match);
    },
  };
}
