/** Browser defenses shared by the production Worker and its regression tests. */
export const SCRIPT_NONCE_HEADER = 'x-prism-script-nonce';

function scriptNonce(): string {
  // 192 random bits; never accept a caller's nonce or reuse a cached HTML nonce.
  const bytes = crypto.getRandomValues(new Uint8Array(24));
  return btoa(String.fromCharCode(...bytes));
}

export function pageContentSecurityPolicy(nonce: string, development = false): string {
  if (!/^[A-Za-z0-9+/]{32}$/.test(nonce)) throw new Error('Invalid script nonce.');
  return [
    "default-src 'self'",
    // Vinext propagates the request CSP nonce to hydration/bootstrap scripts.
    // The three external SDKs are loaded by trusted code only after user action.
    `script-src 'self' 'nonce-${nonce}' 'strict-dynamic'${development ? " 'unsafe-eval'" : ''} https://js.tosspayments.com https://apis.google.com https://accounts.google.com`,
    "script-src-attr 'none'",
    // React/Radix use inline style attributes for positioning and responsive UI.
    "style-src 'self' 'unsafe-inline' https://accounts.google.com https://fonts.googleapis.com",
    "img-src 'self' data: blob: https://*.gstatic.com https://*.googleusercontent.com https://*.tosspayments.com https://*.toss.im",
    "font-src 'self' data: https://fonts.gstatic.com",
    `connect-src 'self' https://*.googleapis.com https://accounts.google.com https://apis.google.com https://*.tosspayments.com https://*.toss.im${development ? ' ws: wss:' : ''}`,
    "media-src 'self' blob:",
    "frame-src 'self' https://accounts.google.com https://docs.google.com https://drive.google.com https://*.tosspayments.com https://*.toss.im",
    "worker-src 'self' blob:",
    "manifest-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'self' https://*.tosspayments.com https://*.toss.im",
    // Sites can be opened inside ChatGPT. Other sites cannot frame the app.
    "frame-ancestors 'self' https://chatgpt.com",
    ...(!development ? ['upgrade-insecure-requests'] : []),
  ].join('; ');
}

export function prepareSecureRequest(request: Request, development = false) {
  const nonce = scriptNonce();
  const policy = pageContentSecurityPolicy(nonce, development);
  const headers = new Headers(request.headers);
  // Overwrite untrusted inbound policy/nonce headers before SSR reads them.
  headers.set(SCRIPT_NONCE_HEADER, nonce);
  headers.set('Content-Security-Policy', policy);
  headers.delete('Content-Security-Policy-Report-Only');
  return { request: new Request(request, { headers }), policy };
}

export function rejectUnsupportedPageMutation(request: Request): Response | null {
  const path = new URL(request.url).pathname;
  // All mutations in this application are explicit /api routes. No React
  // Server Actions are exposed, so never decode unsolicited action payloads.
  if (!['GET', 'HEAD', 'OPTIONS'].includes(request.method) && path !== '/api' && !path.startsWith('/api/')) {
    return Response.json({ error: 'Method not allowed.', code: 'METHOD_NOT_ALLOWED' }, {
      status: 405, headers: { Allow: 'GET, HEAD, OPTIONS' },
    });
  }
  return null;
}

export function secureResponse(request: Request, response: Response, policy: string): Response {
  // Preserve a Worker WebSocket upgrade unchanged (development HMR only).
  if (response.status === 101) return response;
  const url = new URL(request.url);
  const headers = new Headers(response.headers);
  const type = (headers.get('Content-Type') || '').split(';', 1)[0].trim().toLowerCase();
  const api = url.pathname === '/api' || url.pathname.startsWith('/api/');
  const document = type === 'text/html' || type === 'application/xhtml+xml';
  const component = type === 'text/x-component';
  const redirect = response.status >= 300 && response.status < 400 && headers.has('Location');

  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Referrer-Policy', 'no-referrer');
  headers.set('X-Permitted-Cross-Domain-Policies', 'none');
  headers.set('X-XSS-Protection', '0');
  headers.delete('X-Powered-By');
  if (url.protocol === 'https:') headers.set('Strict-Transport-Security', 'max-age=31536000');

  if (document) {
    headers.set('Content-Security-Policy', policy);
    // A SAMEORIGIN X-Frame-Options would contradict the supported ChatGPT frame.
    headers.delete('X-Frame-Options');
    headers.set('Cross-Origin-Opener-Policy', 'same-origin-allow-popups');
    headers.set('Permissions-Policy', 'camera=(), geolocation=(), microphone=(self), usb=(), serial=(), bluetooth=(), accelerometer=(), gyroscope=(), magnetometer=()');
  } else if (api) {
    headers.set('Content-Security-Policy', "default-src 'none'; base-uri 'none'; frame-ancestors 'none'; sandbox");
    headers.set('X-Frame-Options', 'DENY');
  }

  if (document || component || api || redirect) {
    const noTransform = /(?:^|,)\s*no-transform\s*(?:,|$)/i.test(headers.get('Cache-Control') || '');
    headers.set('Cache-Control', 'private, no-store' + (noTransform ? ', no-transform' : ''));
    headers.set('CDN-Cache-Control', 'no-store');
    headers.set('Cloudflare-CDN-Cache-Control', 'no-store');
    headers.set('Pragma', 'no-cache');
    headers.set('Cross-Origin-Resource-Policy', 'same-origin');
    headers.delete('ETag');
    headers.delete('Last-Modified');
  }
  if (api || component || (document && !['/', '/about', '/privacy', '/terms', '/faq'].includes(url.pathname))) {
    // Shared links are bearer capabilities, not content for search indexing.
    headers.set('X-Robots-Tag', 'noindex, nofollow, noarchive, nosnippet');
  }
  // Keep streaming bodies streaming; do not buffer SSE or generated files.
  return new Response(response.body, { status: response.status, statusText: response.statusText, headers });
}
