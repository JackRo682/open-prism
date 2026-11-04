#!/usr/bin/env node
/** Deterministic, credential-free source exports for the two supplied PNGs. */
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, readdir, rename, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const options = new Set(process.argv.slice(2));
if ([...options].some(option => !['--check', '--manifest', '--help'].includes(option))) {
  throw new Error('Usage: node scripts/export-screen-source.mjs [--check] [--manifest]');
}
if (options.has('--help')) {
  console.log('Generate exactly two screen TXT source exports. --check validates without writing; --manifest also prints included paths.');
  process.exit(0);
}

const compare = (a, b) => a < b ? -1 : a > b ? 1 : 0;
const hash = bytes => createHash('sha256').update(bytes).digest('hex');
const directories = ['app', 'components/workspace', 'lib', 'db', 'drizzle', 'tests', 'build', 'scripts'];
const fixed = [
  '.gitignore', '.openai/hosting.json', 'README.md',
  'docs/gemini-design-implementation.md', 'docs/verification-2026-11-04.md',
  'package.json', 'pnpm-workspace.yaml', 'tsconfig.json', 'cloudflare-env.d.ts',
  'next.config.ts', 'vite.config.ts', 'postcss.config.mjs', 'eslint.config.mjs', 'drizzle.config.ts',
  'public/manifest.webmanifest', 'public/favicon.svg',
];
const extensions = new Set(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.mts', '.css', '.json', '.sql', '.sh', '.md', '.yaml']);
const disallowed = /(?:^|\/)(?:node_modules|dist|\.git|\.env[^/]*|\.dev\.vars[^/]*|\.sites-runtime|\.wrangler|\.next|\.vinext|coverage|vendor)(?:\/|$)|\.(?:pem|key|p12|pfx)$/i;

async function walk(directory) {
  const entries = await readdir(path.join(root, directory), { withFileTypes: true });
  const found = [];
  for (const entry of entries.sort((a, b) => compare(a.name, b.name))) {
    const relative = `${directory}/${entry.name}`;
    if (disallowed.test(relative)) continue;
    if (entry.isDirectory()) found.push(...await walk(relative));
    else if (entry.isFile() && (extensions.has(path.extname(relative)) || relative.endsWith('.LICENSE'))) found.push(relative);
    else if (entry.isSymbolicLink()) throw new Error(`Source exports do not follow symlinks: ${relative}`);
  }
  return found;
}

async function record(relative) {
  if (disallowed.test(relative) || path.isAbsolute(relative) || relative.split('/').includes('..')) {
    throw new Error(`Disallowed export path: ${relative}`);
  }
  const absolute = path.join(root, relative);
  const stat = await lstat(absolute);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > 1_000_000) throw new Error(`Unexpected source file: ${relative}`);
  const bytes = await readFile(absolute);
  const content = bytes.toString('utf8');
  if (bytes.includes(0) || !Buffer.from(content, 'utf8').equals(bytes)) throw new Error(`Non-UTF-8 source file: ${relative}`);
  // Reject recognizable live provider key/private-key material without printing it.
  if (/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----|\bsk-(?:proj-|ant-api\d+-)?[A-Za-z0-9_-]{32,}\b|\bAIza[0-9A-Za-z_-]{35}\b/.test(content)) {
    throw new Error(`Potential credential material; export stopped: ${relative}`);
  }
  return { path: relative, bytes: bytes.length, sha256: hash(bytes), content };
}

const paths = [...new Set([...fixed, ...(await Promise.all(directories.map(walk))).flat()])].sort(compare);
const records = await Promise.all(paths.map(record));
const source = new Map(records.map(item => [item.path, item]));
const lock = await record('pnpm-lock.yaml');
const packageInfo = JSON.parse(source.get('package.json').content);

// Detect omitted literal local imports. Packages, generated runtime modules, and
// dynamic URLs are supplied by the pinned repository/runtime described below.
function resolveImport(from, specifier) {
  const base = specifier.startsWith('@/') ? specifier.slice(2) : path.posix.normalize(path.posix.join(path.posix.dirname(from), specifier));
  const candidates = [base, ...['.ts', '.tsx', '.js', '.jsx', '.mjs', '.mts', '.css', '.json', '.d.ts'].map(ext => base + ext), ...['.ts', '.tsx', '.js', '.mjs'].map(ext => `${base}/index${ext}`)];
  if (base.endsWith('.mjs')) candidates.push(base.slice(0, -4) + '.mts', base.slice(0, -4) + '.d.mts');
  if (base.endsWith('.js')) candidates.push(base.slice(0, -3) + '.ts', base.slice(0, -3) + '.tsx');
  return candidates.find(candidate => source.has(candidate));
}
for (const item of records) {
  if (!/\.(?:[cm]?jsx?|tsx?)$/.test(item.path) || item.path === 'scripts/export-screen-source.mjs') continue;
  const patterns = [
    /\b(?:import|export)\s+(?:[^;]*?\s+from\s+)?["']([^"']+)["']/g,
    /\b(?:import|require)\s*\(\s*["']([^"']+)["']/g,
  ];
  for (const expression of patterns) for (const match of item.content.matchAll(expression)) {
    const specifier = match[1];
    if ((specifier.startsWith('.') || specifier.startsWith('@/')) && !resolveImport(item.path, specifier)) {
      throw new Error(`Missing local import in export: ${item.path} -> ${specifier}`);
    }
  }
}

const fingerprint = hash([...records, lock].sort((a, b) => compare(a.path, b.path)).map(item => `${item.path}\0${item.sha256}\n`).join(''));
const screens = [
  {
    output: 'docs/implementation/01-home-screen.txt',
    title: 'HOME SCREEN', reference: 'image(20261104-110547).png (1440 x 703)',
    scope: 'Workspace shell, sidebar, centered composer, Chat/Work states, real model selection and streaming, attachments, Markdown notebooks, speech input, print/install actions, and responsive navigation.',
    priority: ['app/layout.tsx', 'app/page.tsx', 'app/[...path]/page.tsx', 'app/workspace.tsx', 'app/reference-shell.css', 'app/workspace-details.css', 'components/workspace/composer.tsx', 'components/workspace/chrome.tsx', 'app/api/[...path]/route.ts', 'lib/provider.ts', 'lib/models.ts'],
    geometry: 'Desktop sidebar: 288px. Composer: 660 x 64px, 32px radius, centered in the remaining workspace (x534 at 1440px viewport width). Layered CSS radial gradients reproduce the blue-violet glow. Mobile drawer and reduced-motion behavior are adaptations.',
  },
  {
    output: 'docs/implementation/02-settings-screen.txt',
    title: 'SETTINGS SCREEN', reference: 'image(20261104-110717).png (1440 x 699)',
    scope: 'Anchored Settings menu and submenus, system/light/dark themes, search dialog, personalization and memory, reusable skills, Work preferences, import preview, public share creation/revocation, and explicit unavailable capability pages.',
    priority: ['components/workspace/settings-menu.tsx', 'components/workspace/theme.tsx', 'components/workspace/settings.css', 'components/workspace/chat-search.tsx', 'components/workspace/settings-pages.tsx', 'lib/workspace-settings.ts', 'app/api/[...path]/route.ts', 'db/schema.ts', 'drizzle/0003_workspace_settings_and_shares.sql', 'app/workspace.tsx', 'app/reference-shell.css'],
    geometry: 'Desktop menu: 240px wide with a 664px natural height, 20px radius, 8px padding, and 36px rows. Reference position: x244, y0. Radix collision handling constrains the menu to the viewport; submenus overlap by 8px. Entrance duration: 120ms.',
  },
];

function render(screen) {
  const ordered = [...new Set([...screen.priority, ...paths])].map(relative => {
    const item = source.get(relative);
    if (!item) throw new Error(`Missing screen source: ${relative}`);
    return item;
  });
  const instructions = [
    `OPEN PRISM — ${screen.title} IMPLEMENTATION`,
    `Reference PNG: ${screen.reference}`,
    'Repository: https://github.com/JackRo682/open-prism',
    `Source snapshot SHA-256: ${fingerprint}`,
    `Included files: ${ordered.length}`,
    '',
    'SCREEN SCOPE', screen.scope, screen.geometry,
    '',
    'HOW TO USE THIS BUNDLE',
    'Each BEGIN FILE block contains the actual UTF-8 source at its explicit repository-relative path. UTF8_BYTES and SHA256 describe the original bytes; CRLF line endings, where present, are preserved. The separator before END FILE is not source content.',
    'Both screen bundles include the shared application, authentication, API, storage, tests, and configuration because these screens run in one app. Focus-specific files appear first. Use one consistent version of shared files rather than combining divergent snapshots.',
    'The source manifest below permits integrity checks. This is an implementation export, not an archive of Google application code, customer conversations, or runtime credentials.',
    '',
    'INSTALL, VERIFY, AND RUN',
    `Use Node.js ${packageInfo.engines.node} and ${packageInfo.packageManager}, as pinned in package.json.`,
    'Retain pnpm-lock.yaml from the same repository snapshot before installation; its hash is listed under EXTERNAL REPOSITORY DEPENDENCY.',
    '  pnpm install --frozen-lockfile',
    '  node node_modules/typescript/bin/tsc --noEmit',
    '  node --test tests/integration.mjs',
    '  pnpm build',
    '  pnpm dev',
    'Portable development uses the checked-in Sites/Vinext build helpers. A managed Sites environment should use its existing preview and deployment workflow. Node modules and generated runtime state are recreated by the package manager and build.',
    'Apply every included drizzle/*.sql migration in lexical order to the configured D1 database before enabling the new settings/share endpoints. Drizzle schema, metadata snapshots, and migration journal are included.',
    'The integration suite uses isolated SQLite fixtures and mocked provider transports. It verifies server behavior without proving live credentials, live provider availability, browser permissions, or hosted authentication.',
    '',
    'EXTERNAL SERVICES AND CONFIGURATION',
    'Runtime: ChatGPT Sites / Cloudflare Workers. Authentication: Sign in with ChatGPT. Database binding: DB (D1). Private file binding: BUCKET (R2). Preserve the existing .openai/hosting.json project mapping for this project.',
    'Server secrets: OPENAI_API_KEY for the current GPT-6.1 Sol free beta; ANTHROPIC_API_KEY and GEMINI_API_KEY only when enabling additional adapters with actual provider access and quota. API use may be billable independently of consumer chat subscriptions.',
    'Runtime policy: BETA_MODE=true and PAYMENTS_MODE=disabled for the existing beta; optional ADMIN_USER_ID for administrator access. This redesign adds no provider secret, OAuth client, webhook, or payment subscription.',
    'The existing commercial billing implementation remains guarded. TOSS_SECRET_KEY, TOSS_CLIENT_KEY, and LAUNCH_APPROVED are separate launch requirements, not prerequisites for the disabled-payment beta.',
    'Remote browser/code execution, Google Drive OAuth, media generation, and scheduled/background tasks are not integrated. Work mode changes response instructions. Speech recognition and app installation depend on browser capability and user permission. PDF export uses the browser print dialog.',
    'README.md and docs/gemini-design-implementation.md contain limits, routes, configuration contracts, and implementation details. docs/verification-2026-11-04.md records the performed checks and remaining verification limits.',
    '',
    'REGENERATION',
    '  node scripts/export-screen-source.mjs',
    '  node scripts/export-screen-source.mjs --check',
    'Generation is deterministic: no timestamps, absolute workspace paths, credentials, binary screenshots, generated dist, or runtime caches are embedded. --check fails if checked-in exports differ from current source.',
    '',
    'EXTERNAL REPOSITORY DEPENDENCY',
    `pnpm-lock.yaml | ${lock.bytes} bytes | SHA256 ${lock.sha256}`,
    'The lockfile is deliberately referenced rather than duplicated. Binary verification screenshots are also omitted; their repository paths are documented in the verification report.',
    '',
    'SOURCE MANIFEST — path | original UTF-8 bytes | SHA-256',
    ...ordered.map(item => `${item.path} | ${item.bytes} | ${item.sha256}`),
    '',
  ].join('\n');
  const blocks = ordered.map(item => `\n===== BEGIN FILE: ${item.path} =====\nUTF8_BYTES: ${item.bytes}\nSHA256: ${item.sha256}\nCONTENT:\n${item.content}\n===== END FILE: ${item.path} =====\n`).join('');
  return { text: instructions + blocks, manifest: ordered.map(({ content, ...metadata }) => metadata) };
}

const summaries = [];
for (const screen of screens) {
  const { text, manifest } = render(screen);
  const destination = path.join(root, screen.output);
  if (options.has('--check')) {
    const actual = await readFile(destination, 'utf8').catch(error => {
      if (error.code === 'ENOENT') throw new Error(`Missing export: ${screen.output}`);
      throw error;
    });
    if (actual !== text) throw new Error(`Stale export: ${screen.output}. Run node scripts/export-screen-source.mjs.`);
  } else {
    await mkdir(path.dirname(destination), { recursive: true });
    const temporary = destination + '.tmp';
    await writeFile(temporary, text, 'utf8');
    await rename(temporary, destination);
  }
  summaries.push({ file: screen.output, bytes: Buffer.byteLength(text, 'utf8'), sha256: hash(text), sourceFiles: manifest.length, sourceSnapshot: fingerprint, ...(options.has('--manifest') ? { manifest } : {}) });
}
console.log(JSON.stringify({ mode: options.has('--check') ? 'verified' : 'generated', files: summaries }, null, 2));
