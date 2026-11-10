# External integrations, infrastructure and uploads: security backport

This change backports the November 10 integration/upload safeguards onto GitHub
main `291b7ee247febea62fb7f50fe762e1b221675d07`. It is a security backport, not
an exact snapshot of the newer production source. The baseline's authentication,
models, UI features, assets, fonts, package versions and database schema remain
in place. Newer Docs-export UI and pending Google sign-in work are outside this
branch.

## Application protections

### Remote browser and SSRF

Remote captures require both a Browserless token and
`BROWSERLESS_EGRESS_POLICY_VERIFIED=true`. Set the latter only after the operator
has checked the provider's private-network blocking, browser/process isolation,
restricted outbound access, and resource limits. The application validates
public HTTP(S) URLs, resolves A and AAAA records, rejects non-public and mixed
answers, and validates intercepted navigation and subresource requests. It
restricts request methods/types, disables JavaScript and service workers,
rejects subframes, limits requests/hosts/DNS work, and bounds capture time.

DNS checks and request interception cannot prove what addresses the remote
provider actually connects to. The flag records an operator decision; it does
not create a network firewall. See [the provider acceptance procedure and
remaining limits](browser-egress-security.md).

### Google Drive selection

The existing picker uses one authorization session per action. It validates the
exact `drive.file` grant, clears token references on cancel/completion/error,
unmount and page exit, and ignores stale or duplicate SDK callbacks. Local token
retention is capped at five minutes and ends before Google's reported expiry.
Transfers have deadlines and bounded responses, strict UTF-8 and supported MIME
handling. Tokens are private in-memory fields and travel only in the
Authorization header to explicitly allowed Google Drive API paths; redirects,
cookies, caching and referrers are disabled for those calls.

This is a cap on application retention, not a change to Google's issued token
lifetime. Closing the picker does not revoke the project's entire Google grant.
Authorized origins, Picker key restrictions and live OAuth behavior still need
to be verified in the Google project and configured application.

### Storage and downloads

R2 operations require both an owned database record and the correct owner key
prefix. References, generated media and work artifacts also require their
expected namespace. This guards download, deletion, reference reuse, chat
attachments and account-data deletion. Text and generated work artifacts force
safe attachment behavior; media uses a kind-specific MIME allowlist. Private
file responses include `nosniff`, private no-store caching, sandbox CSP and a
same-origin resource policy.

Local D1/R2 preview configuration explicitly sets `remote: false`. Private bucket
exposure, production/preview binding separation and administrative permissions
still require control-plane verification; filename prefixes alone are not an
authorization boundary.

### API flooding and bounded preparation

The Worker admits at most 32 simultaneous API preparations per isolate and
reserves at most 16 MiB of enforced body allowances. It rejects overflow before
reading the request body, cancels unread input, returns 503 with `Retry-After`,
and releases capacity on success or failure. Original request streams are read
once, with an enforced byte ceiling and a 30-second upload deadline; a false
Content-Length cannot bypass the limit. JSON must be UTF-8 and unsupported body
encodings/content types are rejected.

Atomic D1 counters allow 30 searches, 120 file/media downloads, 180 other reads
and 120 mutations per account per minute. D1-free authenticated bootstrap is
exempt. Anonymous guest bootstrap and valid public-share reads use fixed
site-wide counters of 600 per minute. Counter keys do not contain attacker-chosen
search strings, paths, IP headers or share tokens. Existing chat/guest/provider
quotas remain in force. File-count insertion is atomic so concurrent uploads
cannot exceed the 100-file limit.

Readiness probes coalesce and briefly cache only health state, with a three-second
response deadline. The check preserves this branch's five-table schema and
OpenAI-key requirement. Timed-out database work stays coalesced until it settles.

These per-isolate and database safeguards do not replace edge WAF rules,
distributed connection limits, provider process limits or capacity monitoring.
No production load test is implied by deterministic fixtures.

### Uploads

Text files are nonempty, at most 128 KiB, strictly decoded as UTF-8 and stored as
inert plain text. Image references must be PNG/JPEG/WebP, at most 4 MiB and 2,048
pixels per side, with matching filename/MIME/container. Container lengths,
terminal markers, metadata/count bounds and static-image policy are checked.
PNG also receives bounded zlib and scanline validation, including CRCs and exact
expansion limits. Generated PNG output has a 4,096-pixel per-side ceiling.

The application does not execute uploaded source code. These are not malware
scans or full semantic pixel decoding: JPEG/WebP entropy streams, PNG filter
reconstruction and every palette value are not decoded. See [upload protections
and limits](upload-security.md) before adding higher-risk parsing.

## Verification

Install this branch's unchanged lockfile with the pinned package manager, then
run the affected suites and baseline regressions:

```sh
bash scripts/install-pnpm.sh
node node_modules/typescript/bin/tsc --noEmit --pretty false
node --test tests/api-security.test.mjs tests/api-resource-guards.test.mjs tests/api-admission-worker.test.mjs
node --test tests/upload-security.test.mjs tests/upload-worker.test.mjs
node --test tests/browser-workspace.mjs tests/browser-network-security.test.mjs
node --test tests/drive-security.test.mjs tests/drive-dialogs.test.mjs
node --test tests/integration.mjs
node --test tests/provider-features.mjs
node --test tests/scheduled-tasks.test.mjs
node --test tests/guest-chat.test.mjs
node --test tests/guest-routing.mjs
pnpm build
```

The backport was verified on November 10 with the unchanged frozen lockfile:
173 tests passed, TypeScript reported no errors, and the production build
completed. Installed versions included Next 16.3.4, React 19.2.6,
Vinext 1.0.0-beta.5 and Vite 8.0.13.

Tests use isolated SQLite, storage and transport fixtures. Workerd tests execute
real request-admission and image-validation code in the target runtime. They do
not establish live OAuth, live provider isolation, public bucket privacy or edge
capacity. No new secret, provider connection, paid allowance or deployment is
created by this backport.
