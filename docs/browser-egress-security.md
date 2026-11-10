# Remote-browser outbound network policy

## Enablement and remaining infrastructure requirement

Remote captures require `BROWSERLESS_API_TOKEN` and `BROWSERLESS_EGRESS_POLICY_VERIFIED=true`. Without both, the API returns a configuration error before reserving quota or contacting DNS or Browserless, and the workspace reports the capability as unavailable. The flag is **an operator attestation**, not an outbound firewall or a claim that the application's DNS checks pin network connections.

Before setting the flag, verify the selected Browserless fleet's actual outbound controls using authorized test destinations. The browser network must reject private, loopback, link-local, reserved and metadata endpoints on IPv4 and IPv6, including when a public hostname changes its DNS answer, follows a redirect, embeds a subresource, or resolves differently in the provider's network. Session isolation must prevent access to other users' browser contexts and credentials. Record the provider policy and controlled test evidence in the deployment's operational records. A managed endpoint hostname alone is insufficient evidence.

If those controls cannot be established, leave the flag unset. Saved captures can still be viewed and deleted. No paid provider request is needed to verify this fail-closed behavior.

This boundary follows [OWASP's SSRF prevention guidance](https://cheatsheetseries.owasp.org/cheatsheets/Server_Side_Request_Forgery_Prevention_Cheat_Sheet.html), which treats application validation and network restrictions as complementary controls. Application DNS preflight can differ from the DNS answer used by Chromium and cannot by itself prevent DNS rebinding or split-horizon resolution.

## Implemented application controls

`lib/browser-workspace.ts` now applies these checks:

- Only HTTP on port 80 and HTTPS on port 443; no credentials, literal IPs, malformed DNS labels, local/private suffixes, parser-confusing backslashes or control characters.
- Only the three explicit Browserless shared HTTPS endpoints. The provider request still rejects redirects and has a 35-second application timeout.
- A and AAAA DNS preflight in the Worker before the authenticated provider call. All returned addresses must be ordinary public addresses. A mixed public/private answer is rejected. CNAME targets must pass the hostname policy.
- The same checks before every intercepted remote request, including redirected requests and image, stylesheet and font subresources. A fresh DNS check is performed after previously completed lookups; only simultaneous lookups for one hostname share a pending promise.
- A fixed `https://cloudflare-dns.com/dns-query` transport. It sends only the hostname and address family, omits credentials and referrers, refuses redirects, and has no fallback resolver. DNS errors, unsupported responses, truncation, no addresses or oversized responses fail closed.
- Page JavaScript is disabled before navigation; service workers and the browser cache are bypassed. Only main-frame documents and static image/style/font resources using GET or HEAD are allowed. Subframes, page scripts, media, XHR/fetch and other resource classes are blocked. Downloads are denied through CDP and popups are closed.
- At most 128 intercepted requests, 5 redirects per request, 32 distinct hostnames and 256 DNS questions per capture policy; each DNS response is limited to 16 KiB and each lookup to 3 seconds. A 30-second whole-capture watchdog aborts DNS, requests page closure and rejects stuck browser operations, including evaluation, screenshots and page closure. Its timer and listener are removed when the capture finishes. Existing per-owner locks, daily limits, output bounds and owner-only history are retained.

IPv4 and IPv6 classification is intentionally conservative. It rejects the relevant [IANA IPv4 special-purpose ranges](https://www.iana.org/assignments/iana-ipv4-special-registry/) and [IANA IPv6 special-purpose ranges](https://www.iana.org/assignments/iana-ipv6-special-registry/), including CGNAT, documentation ranges, mapped IPv4, NAT64, 6to4 and Teredo. It also rejects Azure's platform endpoint. An unusual legitimate destination may consequently be unavailable.

## Provider resource ceilings

The application limits request counts, output size and elapsed capture time. It does **not** set a byte ceiling on every remote HTML, stylesheet, image or font response, and it cannot cap Chromium's DOM size, image-decoding memory or rendering CPU. A single large resource can consume significant browser resources before the watchdog fires. The watchdog itself runs in the provider's JavaScript environment and is not a substitute for an independently enforced session timeout or process termination.

Before enabling captures, verify that the Browserless account/fleet enforces suitable session duration, browser/process memory and CPU limits, concurrency limits, and network/response-size restrictions. Test that an oversized or stalled resource and an unresponsive browser process are terminated at the provider boundary. The Worker stops waiting for Browserless after 35 seconds, but that alone does not prove that the upstream browser stopped consuming resources. These provider settings and termination behavior remain unverified until the configured integration is tested.

## Compatibility and verification

This is a public-page reading tool. JavaScript-only pages may return limited text or an incomplete screenshot; interactive login and form actions remain unsupported. Enabling scripts would require a separate review of workers, sockets, new targets and other traffic that can bypass ordinary page interception.

Browserless's [Function API](https://docs.browserless.io/rest-apis/function) runs in its browser JavaScript environment rather than Node.js, as documented in its [migration guide](https://docs.browserless.io/baas/migrate). The DNS checks therefore use the fixed HTTPS resolver rather than `node:dns`. Cloudflare documents its [DoH transport](https://developers.cloudflare.com/1.1.1.1/encryption/dns-over-https/make-api-requests/). The parser deliberately accepts a narrow A/AAAA/CNAME JSON schema; an incompatible resolver format change disables the affected capture rather than skipping validation. Puppeteer's documentation describes [request interception](https://pptr.dev/api/puppeteer.page.setrequestinterception), [service-worker bypass](https://pptr.dev/api/puppeteer.page.setbypassserviceworker) and [disabling page JavaScript](https://pptr.dev/api/puppeteer.page.setjavascriptenabled).

Run:

```sh
node --test tests/browser-workspace.mjs tests/browser-network-security.test.mjs
```

The tests cover encoded addresses, private and reserved IPv4/IPv6 answers, mixed DNS records, resolver failures and malformed/oversized responses, DNS answer changes, quotas, disabled-by-default configuration, and the actual emitted remote function with a controlled request/CDP harness. They verify redirect/subresource decisions, ensure rejected initial DNS never reaches Browserless, and trigger the whole-capture watchdog against never-resolving evaluation, screenshot and close operations. Minified builds are also exercised with and without preserved function names. These are local regression tests; they do not establish the live provider's network policy or a completed real Browserless capture.
