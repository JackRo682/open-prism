/**
 * Parser for Sites' platform-asserted identity on the configured public host.
 *
 * This is an ingress allowlist and input-validation guard, NOT a signature
 * verifier. The trusted Sites dispatcher must remove caller identity headers
 * and supply authenticated values, and the Worker must not be reachable around
 * that dispatcher using the allowed host. Neither Host nor request.cf proves
 * those properties. Do not reuse this parser for untrusted proxy assertions.
 */
export type PlatformIdentity = {
  userId: string;
  displayName: string;
  email: string;
  fullName: string | null;
};

type HeaderReader = Pick<Headers, 'get'>;
type PlatformEnvironment = { APP_ORIGIN?: string };
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;
const NAME_ENCODING = 'percent-encoded-utf-8';

function canonicalOrigin(environment: PlatformEnvironment): URL | null {
  const value = environment.APP_ORIGIN;
  if (!value || value.length > 2048 || /[\s\\]/.test(value) || CONTROL.test(value)
    || !/^https:\/\/[^/?#]+\/?$/.test(value)) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.pathname !== '/'
      || url.search || url.hash || url.hostname.endsWith('.')) return null;
    const authority = value.slice('https://'.length).replace(/\/$/, '').toLowerCase();
    if (authority !== url.host && !(url.port === '' && authority === url.hostname + ':443')) return null;
    return url;
  } catch { return null; }
}

function singleHeader(headers: HeaderReader, name: string, limit: number): string | null {
  const value = headers.get(name);
  // Headers combines repeated fields with a comma. These security-relevant
  // values have no comma grammar, so combined duplicates cannot be accepted.
  if (!value || value.length > limit || value !== value.trim() || value.includes(',') || CONTROL.test(value)) return null;
  return value;
}

function canonicalIngress(headers: HeaderReader, environment: PlatformEnvironment, requestUrl?: string): boolean {
  const configured = canonicalOrigin(environment);
  const host = singleHeader(headers, 'host', 320);
  if (!configured || !host || /[\s\\/@?#%]/.test(host)) return false;
  const normalizedHost = host.toLowerCase();
  // DNS case and an explicit default HTTPS port are equivalent. Forwarded
  // host/proto headers are intentionally ignored; they are not an attestation.
  if (normalizedHost !== configured.host
    && !(configured.port === '' && normalizedHost === configured.hostname + ':443')) return false;
  if (requestUrl !== undefined) {
    try {
      const request = new URL(requestUrl);
      if (request.username || request.password || request.origin !== configured.origin) return false;
    } catch { return false; }
  }
  return true;
}

/** Optional Worker-entry check before the framework obtains request headers.
 * Comparing the URL as well as Host rejects an alternate entry URL whose Host
 * header has been overwritten. It still does not authenticate the proxy. */
export function platformRequestMatchesOrigin(request: Pick<Request, 'url' | 'headers'>, environment: PlatformEnvironment): boolean {
  return canonicalIngress(request.headers, environment, request.url);
}

/** Run at Worker ingress before framework processing. A foreign or unresolved
 * entry point may remain publicly accessible, but it cannot carry platform
 * identity assertions into downstream code. Reuses the original body stream
 * without reading or teeing it; all non-identity request data is preserved. */
export function sanitizePlatformIdentity(request: Request, environment: PlatformEnvironment): Request {
  if (platformRequestMatchesOrigin(request, environment)) return request;
  const names = [...request.headers.keys()].filter(name => name.toLowerCase().startsWith('oai-authenticated-user-'));
  if (names.length === 0) return request;
  const headers = new Headers(request.headers);
  for (const name of names) headers.delete(name);
  return new Request(request, { headers });
}

function validEmail(value: string): boolean {
  const parts = value.split('@');
  if (parts.length !== 2 || !parts[0] || parts[0].length > 64
    || parts[0].startsWith('.') || parts[0].endsWith('.') || parts[0].includes('..')
    || /[\s<>()[\]\\:;",]/.test(parts[0])) return false;
  const domain = parts[1];
  return !!domain && domain.length <= 253 && domain.split('.').every(label =>
    /^[a-z\d](?:[a-z\d-]{0,61}[a-z\d])?$/i.test(label));
}

function decodedName(headers: HeaderReader): string | null {
  const encoding = singleHeader(headers, 'oai-authenticated-user-full-name-encoding', 100);
  const encoded = singleHeader(headers, 'oai-authenticated-user-full-name', 2400);
  if (encoding !== NAME_ENCODING || !encoded) return null;
  try {
    const name = decodeURIComponent(encoded);
    return name.trim() && name.length <= 200 && !CONTROL.test(name) ? name.trim() : null;
  } catch { return null; }
}

/** Use only downstream of the trusted Sites dispatcher. requestUrl should be
 * supplied when a real Request is available; framework header-only callers
 * should also use platformRequestMatchesOrigin at their Worker entry point. */
export function readPlatformIdentity(headers: HeaderReader, environment: PlatformEnvironment, requestUrl?: string): PlatformIdentity | null {
  if (!canonicalIngress(headers, environment, requestUrl)) return null;
  const userId = singleHeader(headers, 'oai-authenticated-user-id', 200);
  const email = singleHeader(headers, 'oai-authenticated-user-email', 320);
  if (!userId || !/^[a-z\d._:-]+$/i.test(userId) || !email || !validEmail(email)) return null;
  const fullName = decodedName(headers);
  return { userId, email, fullName, displayName: fullName ?? email };
}
