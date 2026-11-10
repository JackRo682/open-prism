import { execFileSync } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const packageRef = (name, version) => 'pkg:npm/' + name.split('/').map(encodeURIComponent).join('/') + '@' + encodeURIComponent(version);

/** Aggregate exact package artifacts while retaining every resolved dependency edge. */
export function createSbom(all, production, metadata) {
  if (!Array.isArray(all) || all.length !== 1 || !Array.isArray(production) || production.length !== 1) {
    throw new Error('Expected one standalone project from the frozen pnpm lockfile.');
  }
  const productionRefs = new Set();
  const components = new Map(), edges = new Map();
  const children = node => ['dependencies', 'devDependencies', 'optionalDependencies']
    .flatMap(key => Object.entries(node[key] || {}));
  function info(alias, node) {
    const name = node.from || alias, version = node.version;
    if (typeof name !== 'string' || typeof version !== 'string' || !/^(@[a-z\d._-]+\/)?[a-z\d._-]+$/i.test(name) || !/^\d+\.\d+\.\d+(?:[-+][\w.-]+)?$/.test(version)) {
      throw new Error('Unsupported package locator; update SBOM generation rather than omitting the package.');
    }
    return { name, version, ref: packageRef(name, version) };
  }
  function collectProduction(node) {
    for (const [alias, child] of children(node)) { productionRefs.add(info(alias, child).ref); collectProduction(child); }
  }
  collectProduction(production[0]);
  const application = all[0];
  const rootRef = packageRef(application.name, application.version);
  function collect(node, parentRef) {
    if (!edges.has(parentRef)) edges.set(parentRef, new Set());
    for (const [alias, child] of children(node)) {
      const { name, version, ref } = info(alias, child);
      edges.get(parentRef).add(ref);
      if (!components.has(ref)) {
        const slash = name.startsWith('@') ? name.indexOf('/') : -1;
        components.set(ref, { type: 'library', 'bom-ref': ref, ...(slash < 0 ? {} : { group: name.slice(0, slash) }),
          name: slash < 0 ? name : name.slice(slash + 1), version, purl: ref,
          properties: [{ name: 'openprism:production-dependency', value: String(productionRefs.has(ref)) }] });
      }
      collect(child, ref);
    }
  }
  collect(application, rootRef);
  if (!components.size) throw new Error('Refusing to generate an empty dependency inventory.');
  return {
    bomFormat: 'CycloneDX', specVersion: '1.6', serialNumber: 'urn:uuid:' + randomUUID(), version: 1,
    metadata: { timestamp: metadata.timestamp || new Date().toISOString(),
      tools: [{ vendor: 'GetOpenPrism', name: 'pnpm-lockfile-inventory', version: '1' }],
      component: { type: 'application', 'bom-ref': rootRef, name: application.name, version: application.version },
      properties: [{ name: 'openprism:pnpm-version', value: metadata.pnpmVersion },
        { name: 'openprism:lockfile-sha256', value: metadata.lockfileSha256 },
        { name: 'openprism:source-commit', value: metadata.revision },
        { name: 'openprism:inventory-scope', value: 'all locked production and development packages; not a deployed-bundle reachability claim' }],
    },
    components: [...components.values()].sort((a, b) => a['bom-ref'].localeCompare(b['bom-ref'])),
    dependencies: [...edges].sort(([a], [b]) => a.localeCompare(b))
      .map(([ref, targets]) => ({ ref, dependsOn: [...targets].sort() })),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = fileURLToPath(new URL('../', import.meta.url));
  const run = args => execFileSync('pnpm', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 120_000 });
  const pnpmVersion = run(['--version']).trim();
  if (pnpmVersion !== '11.25.0') throw new Error('Generate the SBOM using the pinned pnpm 11.25.0.');
  const hashLock = () => createHash('sha256').update(readFileSync(new URL('../pnpm-lock.yaml', import.meta.url))).digest('hex');
  const lockfileSha256 = hashLock();
  const all = JSON.parse(run(['list', '--json', '--depth', 'Infinity', '--lockfile-only']));
  const production = JSON.parse(run(['list', '--json', '--depth', 'Infinity', '--lockfile-only', '--prod']));
  if (hashLock() !== lockfileSha256) throw new Error('The lockfile changed during SBOM generation.');
  const revision = execFileSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).trim();
  const bom = createSbom(all, production, { pnpmVersion, lockfileSha256, revision });
  const output = new URL('../.sites-runtime/security/reports/sbom.cdx.json', import.meta.url);
  mkdirSync(path.dirname(fileURLToPath(output)), { recursive: true });
  writeFileSync(output, JSON.stringify(bom, null, 2) + '\n');
  console.log(JSON.stringify({ check: 'sbom', format: 'CycloneDX 1.6', components: bom.components.length,
    productionComponents: bom.components.filter(row => row.properties[0].value === 'true').length, lockfileSha256 }));
}
