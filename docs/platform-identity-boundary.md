# Platform identity boundary

This guard applies to the existing Sites-authenticated release. The pending Google-only release instead uses independently verified OAuth identity and its opaque application sessions.

## Hosting contract and limitation

Sites supplies `oai-authenticated-user-id` and `oai-authenticated-user-email` for authenticated visitors. The site-specific stable user ID determines record ownership; email and optional full name are display/contact information. Public visitors without platform identity remain anonymous. Service-bypass access does not establish a visitor identity.

`readPlatformIdentity` accepts these platform assertions only when `APP_ORIGIN` is a valid canonical HTTPS origin and the request Host matches it. Missing or invalid configuration, alternate hosts, ambiguous/duplicate required headers, control characters and malformed identity values produce no authenticated user. An invalid optional display name falls back to the email.

**Host matching is not cryptographic authentication.** The guard cannot distinguish a genuine platform assertion from forged, well-formed headers delivered with the same allowed Host. Safe operation still requires the trusted Sites dispatcher to strip caller identity headers and insert authenticated values, and requires preventing direct origin access around that dispatcher. This code does not configure or independently prove those hosting properties.

Neither `request.cf`, `CF-Ray`, `CF-Connecting-IP`, `X-Forwarded-Host`, nor `Origin` is accepted as proof that the authenticated identity headers are authentic. Cloudflare metadata can also exist on a direct Worker entry point, and an ordinary HTTP header is not a signed identity assertion. IP metadata remains useful for supplementary throttling only.

## Integration

For the platform-authenticated application helper, pass the request headers and runtime environment to `readPlatformIdentity`. The environment must contain the exact canonical `APP_ORIGIN`, for example `https://getopenprism.com`; never populate it from request headers.

At the Worker entry point, pass the real Request through `sanitizePlatformIdentity` before the framework consumes identity headers. The sanitizer calls `platformRequestMatchesOrigin`, which also compares `Request.url` with the configured origin. If it fails, every `oai-authenticated-user-*` header is removed before continuing as an anonymous visitor. The request body stream, URL, method, cancellation signal, other headers and ordinary Request settings are preserved. Canonical requests are returned unchanged. This catches a mismatched entry URL with an overwritten Host; it does not replace the trusted dispatcher.

Do not infer identity from forwarded headers, permit a wildcard host, add a request-controlled bypass, or relax missing-configuration behavior for production. If another Site hostname needs authenticated access, validate that hostname's ingress contract explicitly before changing the allowlist design. The canonical-host rule intentionally excludes preview and direct `workers.dev` URLs.

This backport wires the helper into both the Worker entry point and platform authentication helper. Hosting configuration remains separate, and the pending Google release retains its own verified-session implementation.

## Verification

The unit suite verifies canonical-host normalization, absent/invalid configuration, alternate-host and URL/Host mismatch rejection, duplicate/malformed required fields, safe optional display-name handling, and sanitizer preservation of the request body and unrelated headers. These are parser and allowlist tests; they are not evidence that the platform strips attacker-supplied headers.

During the 2026-11-10 patch review, a read-only anonymous `GET https://getopenprism.com/api/bootstrap` with deliberately fabricated `oai-authenticated-user-id` and `oai-authenticated-user-email` headers returned HTTP 200 with `user: null` and `isAdmin: false`. This check ran against the existing live release before this patch. The runtime `APP_ORIGIN` was also confirmed as `https://getopenprism.com`. These observations show that the supplied assertions did not establish a user in that single canonical-route check; they do not establish every possible ingress configuration or validate a genuine signed-in session.

Before declaring the live ingress boundary verified, send a non-mutating anonymous request through the actual public Sites route with forged identity headers and confirm it remains anonymous. Check authenticated access separately with a genuine platform session. Direct alternative Worker hosts must not yield authenticated application access. A single successful public-route test does not establish every possible ingress configuration.

## Primary references

- [Cloudflare HTTP headers](https://developers.cloudflare.com/fundamentals/reference/http-headers/): edge IP semantics and Worker subrequest limitations.
- [Cloudflare Workers Request API](https://developers.cloudflare.com/workers/runtime-apis/request/): the platform-specific `cf` metadata property.
- [OWASP Authorization Cheat Sheet](https://cheatsheetseries.owasp.org/cheatsheets/Authorization_Cheat_Sheet.html): deny-by-default authorization and validation on every request.
