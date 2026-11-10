# External integrations, storage and upload hardening

This patch addresses security review items 11–15. It adds application controls and testable fail-closed behavior. It does not equate a passing local test with a verified provider firewall, bucket policy, OAuth console configuration, or malware scan.

## 11. Remote-browser SSRF

See [the remote-browser policy](browser-egress-security.md). Remote capture requires both its provider token and `BROWSERLESS_EGRESS_POLICY_VERIFIED=true`. This flag records the operator's verification of actual outbound network restrictions; it does not install those restrictions.

The application checks public URL syntax, A and AAAA DNS answers, redirects, and intercepted static subresources. It rejects private/reserved destinations, uses a fixed HTTPS DNS resolver, limits request/host/query counts, disables page JavaScript and service-worker use, denies downloads, and keeps the existing authenticated owner and spending controls. DNS rebinding and split-horizon resolution still require provider-side enforcement. JavaScript-only sites may render incompletely under this public-page reader policy.

## 12. Google Drive tokens

Picker import and Docs export use a single cancellable `DriveAccessSession` for each explicit action. It accepts only `drive.file`, a valid token lifetime and a Bearer token, refuses duplicate/late authorization callbacks, and keeps the token in a JavaScript private field. Sessions last at most five minutes; transfer deadlines are shorter, and the provider's actual token expiry always takes precedence.

Close, cancellation, unmount, navigation and expiry clear application token references and abort the operation. Picker disposal happens before re-entrant callbacks can use the instance again. Imported content is handed to the application only after releasing the Drive token. Requests with that credential target fixed Google Drive API paths, omit cookies/referrers, and reject redirects. Text downloads have explicit size and UTF-8 boundaries. No token is intentionally written to storage, URLs, logs, or application API payloads.

Clearing the application's copy does not revoke a token already stolen by an attacker or change Google's issued token lifetime. OAuth-grant revocation is not performed on normal dialog close because it can revoke the application's broader grant. Production still needs the dedicated Drive client, exact authorized origin, enabled Drive/Picker APIs, restricted Picker key and real consent/selection/export verification. Existing nonce-based CSP remains enabled.

## 13. D1/R2 access boundaries

Database ownership checks remain required before every private object operation. Object reads/deletes and chat attachment retrieval additionally validate that the stored key is in the authenticated owner's prefix, with namespace checks for media, reference images and generated artifacts. A corrupted or mismatched database key cannot direct those paths to another owner's object. Object names alone are not considered authorization.

Untrusted files and generated artifacts have explicit attachment disposition, safe filenames, `nosniff`, private/no-store caching and a restrictive sandbox policy. Media routes accept only supported stored types for the asset kind. Application code does not expose raw R2 URLs or credentials.

Local D1/R2 bindings explicitly use `remote: false` and retain placeholder/local names. No production database ID or bucket name is added to preview configuration. The Sites control plane continues to provision production bindings declared by `.openai/hosting.json`.

The available Sites API does not expose the Cloudflare account's R2 public-domain settings, service-token grants or WAF configuration. Those settings have **not** been independently verified or changed by this patch. The platform owner should confirm both `r2.dev` and custom-domain public access are disabled, preview resources are separate, and administrative/API-token permissions are restricted to the required resources. Disabling only `r2.dev` does not disable an independently attached public custom domain. See [Cloudflare public bucket guidance](https://developers.cloudflare.com/r2/buckets/public-buckets/) and [local development isolation](https://developers.cloudflare.com/workers/local-development/).

## 14. Resource exhaustion

Authenticated requests now use atomic D1 read quotas, in addition to the existing chat and mutation limits:

| Resource class | Allowance | Key scope |
| --- | --- | --- |
| Search | 30 per 60 seconds | Authenticated account |
| File/artifact/media-content reads | 120 per 60 seconds | Authenticated account |
| Other authenticated API reads | 180 per 60 seconds | Authenticated account |
| Guest bootstrap, shared snapshots, upgrade overview | 600 per 60 seconds for each class | Site-wide resource ceiling |

Counters use one stable row per account/class or public class, reset atomically on expiry, and do not include caller-selected URLs, resource IDs or tokens. Exceeded quotas return `429` and `Retry-After`. The public ceilings protect backend capacity; they are not fair per-network quotas and can temporarily affect other visitors when consumed.

Before the framework reads a request body, each Worker isolate allows at most 32 simultaneous API preparations and reserves at most 16 MiB of **per-request allowed body sizes**, independent of a caller's declared length. Saturation rejects additional work with `503` and a short retry hint and cancels the rejected input. Existing streaming generation, browser and media locks remain responsible for downstream work after response headers are returned. This reservation is a bound on admitted payload sizes, not a measurement of all runtime memory.

Readiness probes coalesce into one actual D1 batch per isolate/binding, cache successful results for ten seconds and unavailable results for two seconds, and respond within three seconds. A timed-out database operation remains tracked until it really settles, so retries cannot create overlapping replacement probes. No account data is cached.

These controls do not constitute a global edge firewall. Worker isolates do not share the request-preparation counter, and rejected requests still reach the Worker. Production WAF/per-network throttling and alerts for elevated `429`/`503`, latency and provider failures remain infrastructure work. No stress test is run against production, and no new claim about supported concurrent-user capacity is made.

## 15. Untrusted uploads

- Text files remain capped at 128 KiB and now require strict UTF-8, an allowed extension and a safe filename. Invalid binary/control-character content fails before storage.
- Reference images remain capped at 4 MiB. Their filename extension, reported MIME and actual PNG/JPEG/WebP structure must agree. Malformed/truncated containers, unsupported animation, oversized metadata and inconsistent dimensions are rejected.
- PNG validation checks chunk ordering, lengths and CRCs and consumes its zlib scanline stream with exact bounded row sizes and valid filter bytes. It does not reconstruct pixels or promise a complete image-decoder security audit.
- JPEG/WebP validation checks the complete container structure and dimension consistency. It is not full entropy/pixel decoding. A future local transformation pipeline must use a maintained isolated decoder with CPU/memory limits.
- Uploaded source remains stored and served as inert text. Untrusted generated artifacts remain binary attachments. No antivirus service or malware-free guarantee is introduced.

## Verification and rollout

Regression suites exercise malformed and mislabeled images, PNG compressed-data boundaries and bombs, strict text handling, safe attachment headers, corrupted storage-owner keys, Drive expiry/cancellation/scope/redirect boundaries, SSRF DNS/redirect/subresource decisions, atomic read quotas, upload admission and readiness coalescing. Native Workerd checks cover runtime-specific request cancellation and PNG decompression. General security and integration tests, TypeScript and the deploy build must also pass.

The source repository contains a separately pending Google-only login release whose dedicated OAuth client is not configured. The security release must be applied to the currently deployed authentication baseline; preserve the pending login work separately and do not activate it incidentally. Browserless and Drive were not configured in the inspected production environment, so live provider egress and Google consent cannot be certified by these tests.
