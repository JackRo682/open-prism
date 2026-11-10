import { acquireRequestLease, releaseRequestLease } from './request-lease';
export type BrowserEnvironment = {
  BROWSERLESS_API_TOKEN?: string;
  BROWSERLESS_ENDPOINT?: string;
  /** Operator attestation after testing the provider's outbound firewall; not a firewall itself. */
  BROWSERLESS_EGRESS_POLICY_VERIFIED?: string;
};

export type BrowserCapture = {
  id: string; url: string; title: string; text: string;
  screenshot?: string; links: Array<{ url: string; title: string }>; created_at: number;
};

class BrowserRequestError extends Error {
  constructor(message: string, readonly status = 400, readonly code = 'BROWSER_REQUEST_INVALID') {
    super(message);
  }
}

const json = (data: unknown, status = 200) => Response.json(data, {
  status, headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' },
});
const browserlessHosts = new Set([
  'production-sfo.browserless.io', 'production-lon.browserless.io', 'production-ams.browserless.io',
]);

/** A pure predicate: also serialized into the fixed Browserless program below. */
export function isPublicBrowserUrl(value: unknown): boolean {
  if (typeof value !== 'string' || !value.trim() || value.length > 4096 || /[\u0000-\u0020\u007f\\]/.test(value)) return false;
  try {
    const url = new URL(value);
    const hostname = url.hostname.toLowerCase();
    return ['http:', 'https:'].includes(url.protocol) && !url.username && !url.password
      && (!url.port || (url.protocol === 'http:' ? url.port === '80' : url.port === '443'))
      && hostname.length <= 253 && hostname.includes('.') && !hostname.endsWith('.')
      && !/^[\d.]+$/.test(hostname) && !hostname.includes(':')
      && !/(?:^|\.)(?:localhost|local|internal|intranet|lan|home|arpa|test|invalid|onion)$/.test(hostname)
      && hostname.split('.').every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label));
  } catch { return false; }
}

/** Public website navigation only. Literal IPs and nonstandard ports are excluded. */
export function normalizeBrowserUrl(value: unknown): string {
  const trimmed = typeof value === 'string' ? value.trim() : value;
  // Reject controls in the original input too, including leading/trailing newlines.
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f]/.test(value) || !isPublicBrowserUrl(trimmed)) {
    throw new BrowserRequestError('공개된 웹사이트의 주소만 열 수 있습니다. 로컬 주소, IP 주소, 로그인 정보가 포함된 주소는 사용할 수 없습니다.');
  }
  return new URL(trimmed as string).href;
}

/** Conservative global-unicast classification, not only an RFC1918 check. */
export function isPublicBrowserAddress(value: unknown): boolean {
  if (typeof value !== 'string' || !value || value.length > 64 || value.trim() !== value) return false;
  if (/^(?:[0-9]{1,3}\.){3}[0-9]{1,3}$/.test(value)) {
    const octets = value.split('.');
    if (octets.some(part => (part.length > 1 && part[0] === '0') || Number(part) > 255)) return false;
    const [a, b, c] = octets.map(Number);
    return !(a === 0 || a === 10 || a === 127 || a >= 224
      || (a === 100 && b >= 64 && b <= 127)
      || (a === 169 && b === 254)
      || (a === 172 && b >= 16 && b <= 31)
      || (a === 192 && ((b === 0 && (c === 0 || c === 2)) || (b === 88 && c === 99) || b === 168))
      || (a === 198 && (b === 18 || b === 19 || (b === 51 && c === 100)))
      || (a === 203 && b === 0 && c === 113)
      // Azure's virtual platform endpoint is public-looking but not a website.
      || value === '168.63.129.16');
  }
  if (!value.includes(':') || /[^0-9a-fA-F:.]/.test(value)) return false;
  try {
    const host = new URL('http://[' + value + ']/').hostname.slice(1, -1);
    const [first, second = '0'] = host.split(':').map(part => part || '0');
    const a = parseInt(first, 16), b = parseInt(second, 16);
    // Only ordinary global unicast. Excludes mapped/compatible IPv4, NAT64,
    // local/link-local/multicast, Teredo/other special-use and 6to4 ranges.
    return a >= 0x2000 && a <= 0x3fff && a !== 0x2002
      && !(a === 0x2001 && (b < 0x0200 || b === 0x0db8))
      && !(a === 0x3fff && b < 0x1000);
  } catch { return false; }
}

/**
 * Fixed HTTPS resolver, also run inside the provider's isolated function realm.
 * No positive result is cached: only simultaneous lookups for a hostname share
 * a promise. DNS preflight cannot pin Chromium's socket, so an independently
 * verified network-layer block remains mandatory for capture to be enabled.
 */
export function createBrowserDnsPolicy(
  publicUrl: (value: unknown) => boolean,
  publicAddress: (value: unknown) => boolean,
  fetcher: typeof fetch = fetch,
) {
  const pending = new Map<string, Promise<boolean>>();
  const hosts = new Set<string>();
  let queries = 0;
  // Use a method, rather than a nested named function: keepNames minifiers
  // otherwise inject a module-scoped naming helper into serialized code.
  const resolver = { async resolve(hostname: string, type: 'A' | 'AAAA', signal?: AbortSignal): Promise<string[]> {
    if (++queries > 256) throw new Error('DNS lookup limit exceeded');
    const endpoint = new URL('https://cloudflare-dns.com/dns-query');
    endpoint.searchParams.set('name', hostname);
    endpoint.searchParams.set('type', type);
    const response = await fetcher(endpoint.href, {
      headers: { Accept: 'application/dns-json' }, redirect: 'error', credentials: 'omit',
      referrerPolicy: 'no-referrer', cache: 'no-store',
      signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(3000)]) : AbortSignal.timeout(3000),
    });
    if (!response.ok || !response.body || !/^application\/dns-json(?:;|$)/i.test(response.headers.get('content-type') || '')) {
      await response.body?.cancel();
      throw new Error('DNS resolution unavailable');
    }
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let bytes = 0, text = '';
    try {
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        bytes += chunk.value.byteLength;
        if (bytes > 16384) { await reader.cancel(); throw new Error('DNS response too large'); }
        text += decoder.decode(chunk.value, { stream: true });
      }
      text += decoder.decode();
    } finally { reader.releaseLock(); }
    const data = JSON.parse(text);
    const question = data?.Question;
    if (data?.Status !== 0 || data.TC !== false || data.CD === true || !Array.isArray(question) || question.length !== 1
      || question[0]?.name?.toLowerCase().replace(/\.$/, '') !== hostname
      || question[0]?.type !== (type === 'A' ? 1 : 28)
      || (data.Answer !== undefined && (!Array.isArray(data.Answer) || data.Answer.length > 64))) {
      throw new Error('DNS response invalid');
    }
    const addresses: string[] = [];
    for (const record of data.Answer || []) {
      if (record?.type === 1 || record?.type === 28) {
        if (!publicAddress(record.data)) throw new Error('Private or reserved destination');
        addresses.push(record.data);
      } else if (record?.type === 5) {
        if (typeof record.data !== 'string' || !publicUrl('https://' + record.data.replace(/\.$/, '') + '/')) {
          throw new Error('Unsupported DNS alias');
        }
      } else throw new Error('Unsupported DNS answer');
    }
    return addresses;
  } };
  return async (value: unknown, signal?: AbortSignal): Promise<boolean> => {
    if (!publicUrl(value)) return false;
    const hostname = new URL(value as string).hostname.toLowerCase();
    if (!hosts.has(hostname) && hosts.size >= 32) return false;
    hosts.add(hostname);
    if (signal?.aborted) return false;
    const existing = pending.get(hostname);
    if (existing) return existing;
    const check = Promise.all([resolver.resolve(hostname, 'A', signal), resolver.resolve(hostname, 'AAAA', signal)])
      .then(records => records.flat().length > 0).catch(() => false);
    pending.set(hostname, check);
    try { return await check; } finally { if (pending.get(hostname) === check) pending.delete(hostname); }
  };
}

export function browserlessEndpoint(env: BrowserEnvironment): URL {
  let endpoint: URL;
  try { endpoint = new URL(env.BROWSERLESS_ENDPOINT || 'https://production-sfo.browserless.io/function'); }
  catch { throw new BrowserRequestError('원격 브라우저 연결 주소를 확인해 주세요.', 503, 'BROWSER_NOT_CONFIGURED'); }
  if (endpoint.protocol !== 'https:' || !browserlessHosts.has(endpoint.hostname)
    || endpoint.username || endpoint.password || endpoint.port || endpoint.search || endpoint.hash
    || !['/', '/function'].includes(endpoint.pathname)) {
    throw new BrowserRequestError('공식 Browserless HTTPS 연결 주소가 필요합니다.', 503, 'BROWSER_NOT_CONFIGURED');
  }
  endpoint.pathname = '/function';
  return endpoint;
}

// Fixed code only; user input is passed as context data. Serialized helpers are
// self-contained and their actual emitted program is exercised by security tests.
// The provider closes its isolated session after execution. Its network firewall
// must still reject rebinding/private routes; a hostname allowlist cannot prove it.
export const BROWSER_CAPTURE_PROGRAM = `export default async ({ page, context }) => {
  const publicUrl = ${isPublicBrowserUrl.toString()};
  const publicAddress = ${isPublicBrowserAddress.toString()};
  const verify = (${createBrowserDnsPolicy.toString()})(publicUrl, publicAddress);
  const lifetime = new AbortController();
  const deadline = lifetime.signal;
  let active = true, requests = 0, closing;
  const closePage = () => {
    active = false;
    return closing ||= Promise.resolve().then(() => page.close()).catch(() => {});
  };
  let rejectDeadline;
  const interrupted = new Promise((_, reject) => { rejectDeadline = reject; });
  const onDeadline = () => {
    void closePage();
    rejectDeadline(new Error('Remote page capture timed out'));
  };
  deadline.addEventListener('abort', onDeadline, { once: true });
  const timer = setTimeout(() => lifetime.abort(), 30000);
  const withinDeadline = operation => Promise.race([operation, interrupted]);
  try {
    if (!publicUrl(context.url) || !await withinDeadline(verify(context.url, deadline))) throw new Error('Unsupported navigation address');
    await withinDeadline(page.setViewport({ width: 1280, height: 800, deviceScaleFactor: 1 }));
    // This tool reads public pages. Disabling page scripts removes un-intercepted
    // worker/WebSocket/WebRTC traffic and prevents arbitrary remote-site actions.
    await withinDeadline(page.setJavaScriptEnabled(false));
    await withinDeadline(page.setBypassServiceWorker(true));
    await withinDeadline(page.setCacheEnabled(false));
    const cdp = await withinDeadline(page.createCDPSession());
    await withinDeadline(cdp.send('Browser.setDownloadBehavior', { behavior: 'deny' }));
    await withinDeadline(page.setRequestInterception(true));
    page.on('request', async request => {
      try {
        const kind = request.resourceType();
        const permitted = active && !deadline.aborted && ++requests <= 128 && publicUrl(request.url())
          && ['GET', 'HEAD'].includes(request.method()) && request.redirectChain().length <= 5
          && ['document', 'stylesheet', 'image', 'font'].includes(kind)
          && (kind !== 'document' || request.frame() === page.mainFrame())
          && await verify(request.url(), deadline);
        if (permitted && active && !deadline.aborted) await request.continue();
        else await request.abort();
      } catch { await request.abort().catch(() => {}); }
    });
    page.on('dialog', dialog => dialog.dismiss().catch(() => {}));
    page.on('popup', popup => popup.close().catch(() => {}));
    const response = await withinDeadline(page.goto(context.url, { waitUntil: 'domcontentloaded', timeout: 20000 }));
    if (!response || response.status() >= 400) throw new Error('The website could not be opened');
    try { await withinDeadline(page.waitForNetworkIdle({ idleTime: 400, timeout: 2500 })); } catch {}
    if (!await withinDeadline(verify(page.url(), deadline))) throw new Error('Unsupported redirect');
    const result = await withinDeadline(page.evaluate(() => ({
      url: location.href,
      title: document.title.slice(0, 300),
      text: (document.body?.innerText || '').slice(0, 48000),
      links: Array.from(document.querySelectorAll('a[href]')).slice(0, 200)
        .map(a => ({ url: a.href, title: (a.innerText || a.getAttribute('aria-label') || a.href).trim().slice(0, 160) }))
    })));
    result.links = result.links.filter(link => publicUrl(link.url)).slice(0, 60);
    const image = await withinDeadline(page.screenshot({ type: 'jpeg', quality: 55, encoding: 'base64', fullPage: false }));
    if (image.length <= 480000) result.screenshot = image;
    return { data: result, type: 'application/json' };
  } finally {
    // The watchdog closes the page even when a CDP command is stuck. Do not
    // allow a stuck close command to keep this function alive beyond the budget.
    try { await withinDeadline(closePage()); } catch {}
    clearTimeout(timer);
    deadline.removeEventListener('abort', onDeadline);
    lifetime.abort();
  }
};`;

async function boundedJson(response: Response): Promise<Record<string, unknown>> {
  if (!response.body) throw new BrowserRequestError('원격 브라우저가 응답을 반환하지 않았습니다.', 502, 'BROWSER_RESPONSE_INVALID');
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let bytes = 0, body = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > 1_000_000) {
        await reader.cancel();
        throw new BrowserRequestError('웹페이지 결과가 저장 한도를 넘었습니다.', 413, 'BROWSER_RESULT_TOO_LARGE');
      }
      body += decoder.decode(value, { stream: true });
    }
    body += decoder.decode();
  } finally { reader.releaseLock(); }
  try {
    const parsed: unknown = JSON.parse(body);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>;
  } catch { /* Return only the application error, never upstream diagnostics. */ }
  throw new BrowserRequestError('원격 브라우저 결과를 읽지 못했습니다.', 502, 'BROWSER_RESPONSE_INVALID');
}

function captureContent(raw: Record<string, unknown>) {
  const data = raw.data && typeof raw.data === 'object' && !Array.isArray(raw.data)
    ? raw.data as Record<string, unknown> : raw;
  if (typeof data.text !== 'string' || typeof data.title !== 'string' || typeof data.url !== 'string') {
    throw new BrowserRequestError('원격 브라우저가 페이지 내용을 반환하지 않았습니다.', 502, 'BROWSER_RESPONSE_INVALID');
  }
  const url = normalizeBrowserUrl(data.url);
  const links: BrowserCapture['links'] = [];
  const seen = new Set<string>();
  for (const rawLink of Array.isArray(data.links) ? data.links.slice(0, 200) : []) {
    if (!rawLink || typeof rawLink !== 'object' || typeof rawLink.title !== 'string') continue;
    try {
      const linkUrl = normalizeBrowserUrl(rawLink.url);
      if (!seen.has(linkUrl)) { links.push({ url: linkUrl, title: rawLink.title.slice(0, 160) }); seen.add(linkUrl); }
    } catch { /* Drop unsupported navigation targets from page-provided links. */ }
    if (links.length >= 60) break;
  }
  const screenshot = typeof data.screenshot === 'string' && data.screenshot.length <= 480000
    && /^\/9j\/[A-Za-z0-9+/]*={0,2}$/.test(data.screenshot)
    ? 'data:image/jpeg;base64,' + data.screenshot : undefined;
  return { url, title: data.title.slice(0, 300) || new URL(url).hostname, text: data.text.slice(0, 48000), links, screenshot };
}

async function reserveDailyVisit(sql: D1Database, owner: string, now: number) {
  const day = Math.floor(now / 86_400_000), expiresAt = (day + 1) * 86_400_000;
  for (const [key, limit] of [[`browser:day:user:${owner}:${day}`, 5], [`browser:day:global:${day}`, 50]] as const) {
    const reserved = await sql.prepare('INSERT INTO rate_limits (key,count,expires_at) VALUES (?,1,?) ON CONFLICT(key) DO UPDATE SET count=count+1 WHERE count<? RETURNING count')
      .bind(key, expiresAt, limit).first<{ count: number }>();
    if (!reserved) throw new BrowserRequestError('오늘의 원격 브라우저 이용 한도에 도달했습니다. 내일 다시 시도해 주세요.', 429, 'BROWSER_DAILY_LIMIT');
  }
}

export async function handleBrowser(req: Request, path: string[], sql: D1Database, owner: string, env: BrowserEnvironment): Promise<Response | null> {
  if (path[0] !== 'browser' || path[1] !== 'sessions') return null;
  try {
    if (path.length === 2 && req.method === 'GET') {
      const sessions = (await sql.prepare('SELECT id,url,title,created_at FROM browser_sessions WHERE user_id=? ORDER BY created_at DESC LIMIT 100').bind(owner).all()).results;
      return json({ configured: !!env.BROWSERLESS_API_TOKEN && env.BROWSERLESS_EGRESS_POLICY_VERIFIED === 'true', sessions });
    }
    if (path.length === 2 && req.method === 'DELETE') {
      await sql.prepare('DELETE FROM browser_sessions WHERE user_id=?').bind(owner).run();
      return json({ deleted: true });
    }
    if (path.length === 3 && ['GET', 'DELETE'].includes(req.method)) {
      const row = await sql.prepare('SELECT id,url,title,content,created_at FROM browser_sessions WHERE id=? AND user_id=?').bind(path[2], owner)
        .first<{ id: string; url: string; title: string; content: string; created_at: number }>();
      if (!row) return json({ error: '저장된 원격 페이지를 찾을 수 없습니다.' }, 404);
      if (req.method === 'DELETE') {
        await sql.prepare('DELETE FROM browser_sessions WHERE id=? AND user_id=?').bind(path[2], owner).run();
        return json({ deleted: true });
      }
      const content = JSON.parse(row.content) as Pick<BrowserCapture, 'text' | 'screenshot' | 'links'>;
      return json({ id: row.id, url: row.url, title: row.title, created_at: row.created_at, ...content });
    }
    if (path.length !== 2 || req.method !== 'POST') return json({ error: '지원하지 않는 브라우저 요청입니다.' }, 405);
    const body: unknown = await req.json();
    if (!body || typeof body !== 'object' || Array.isArray(body) || Object.keys(body).some(key => key !== 'url')) {
      throw new BrowserRequestError('열 웹페이지의 주소만 전달해 주세요.');
    }
    const url = normalizeBrowserUrl((body as Record<string, unknown>).url);
    if (!env.BROWSERLESS_API_TOKEN) throw new BrowserRequestError('원격 브라우저가 연결되지 않았습니다. AI 연결 설정에서 Browserless 연결 상태를 확인해 주세요. 현재 브라우저에서는 이 링크를 열지 않았습니다.', 503, 'BROWSER_NOT_CONFIGURED');
    if (env.BROWSERLESS_EGRESS_POLICY_VERIFIED !== 'true') throw new BrowserRequestError('원격 브라우저의 네트워크 보호 설정을 확인한 뒤 사용할 수 있습니다.', 503, 'BROWSER_NETWORK_POLICY_REQUIRED');
    const endpoint = browserlessEndpoint(env);
    endpoint.searchParams.set('token', env.BROWSERLESS_API_TOKEN);
    const now = Date.now(), lockKey = `browser:active:${owner}`;
    const lock = await acquireRequestLease(sql, lockKey, 45000, now);
    if (!lock) throw new BrowserRequestError('열고 있는 원격 페이지가 있습니다. 완료 후 다시 시도해 주세요.', 409, 'BROWSER_BUSY');
    try {
      const count = await sql.prepare('SELECT COUNT(*) AS n FROM browser_sessions WHERE user_id=?').bind(owner).first<{ n: number }>();
      if ((count?.n || 0) >= 100) throw new BrowserRequestError('원격 페이지를 최대 100개까지 저장할 수 있습니다. 브라우저 설정에서 이전 기록을 삭제해 주세요.', 409, 'BROWSER_HISTORY_LIMIT');
      await reserveDailyVisit(sql, owner, now);
      const verify = createBrowserDnsPolicy(isPublicBrowserUrl, isPublicBrowserAddress);
      if (!await verify(url, req.signal)) throw new BrowserRequestError('공개 네트워크 주소로 확인할 수 없는 웹페이지입니다.', 400, 'BROWSER_DESTINATION_REJECTED');
      const response = await fetch(endpoint.href, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ code: BROWSER_CAPTURE_PROGRAM, context: { url } }),
        signal: AbortSignal.any([req.signal, AbortSignal.timeout(35000)]), redirect: 'manual',
      });
      // Reject 3xx here too; the authenticated endpoint must never redirect.
      if (!response.ok) {
        await response.body?.cancel();
        const unavailable = response.status === 401 || response.status === 403;
        throw new BrowserRequestError(unavailable ? '원격 브라우저 인증 또는 사용 권한을 확인해 주세요.' : response.status === 429 ? '원격 브라우저 사용 한도에 도달했습니다. 잠시 후 다시 시도해 주세요.' : '원격 페이지를 열지 못했습니다. 주소와 웹사이트 접근 권한을 확인해 주세요.', unavailable ? 503 : 502, 'BROWSER_PROVIDER_ERROR');
      }
      const capture = captureContent(await boundedJson(response));
      const id = crypto.randomUUID(), created_at = Date.now();
      const content = JSON.stringify({ text: capture.text, screenshot: capture.screenshot, links: capture.links });
      if (new TextEncoder().encode(content).length > 850000) throw new BrowserRequestError('웹페이지가 저장 한도를 넘었습니다.', 413, 'BROWSER_RESULT_TOO_LARGE');
      await sql.prepare('INSERT INTO browser_sessions (id,user_id,url,title,content,created_at) VALUES (?,?,?,?,?,?)')
        .bind(id, owner, capture.url, capture.title, content, created_at).run();
      return json({ id, ...capture, created_at }, 201);
    } finally {
      await releaseRequestLease(sql, lock);
    }
  } catch (error) {
    if (error instanceof BrowserRequestError) return json({ error: error.message, code: error.code }, error.status);
    if (error instanceof SyntaxError) return json({ error: '요청 내용을 읽을 수 없습니다.' }, 400);
    if (error instanceof Error && ['AbortError', 'TimeoutError'].includes(error.name)) return json({ error: '원격 페이지 요청이 중지되었거나 시간이 초과되었습니다.', code: 'BROWSER_TIMEOUT' }, 504);
    return json({ error: '원격 페이지를 처리하지 못했습니다. 잠시 후 다시 시도해 주세요.', code: 'BROWSER_UNAVAILABLE' }, 502);
  }
}
