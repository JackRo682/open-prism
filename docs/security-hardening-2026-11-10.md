# Browser, sessions, sharing, and AI security hardening

Date: 2026-11-10 (Asia/Seoul)

Scope: the browser and AI threat assessment items 6–10. The assessment's
percentages are not used as measured incident rates.

## Release and authentication status

Production retains ChatGPT Sites sign-in. The authentication split was
established in live version 35 (`92106f929fe8a218dbc7ee6b31a84dd5e28f058e`).
The Google migration remains saved in version 34
(`5d3dc906b7fbb1fe8c50a94e0585676865d876da`); its security-strengthened combined
source is also preserved at commit `2754847a3914221c094908b1653938b7456e8593`.
Those checkpoints require separate activation and live Google callback
validation; they do not make Google sign-in part of the production runtime.

This release retains the browser, CSRF, sharing, and AI protections below.
The additive, dormant `0008_google_auth.sql` migration remains before
`0009_public_share_expiry.sql` to preserve migration-order compatibility.
Retaining its tables does not activate Google authentication or change
existing ChatGPT Sites sessions.

## XSS and browser policy

The current production Worker already enforces a per-response nonce-based CSP.
It overwrites untrusted inbound nonce/policy headers and supplies the nonce to
Vinext and the constant theme bootstrap. Production script policy allows neither
`unsafe-inline` nor `unsafe-eval`; inline event handlers, objects, and base-tag
changes are denied. These controls live in `lib/http-security.ts` and
`build/sites-worker.ts`, rather than `next.config.ts`.

The live version 32 home page was checked during this change: CSP was enforced,
all eight executable script elements had the matching nonce, and the response carried
`Cache-Control: private, no-store` and `Referrer-Policy: no-referrer`.

Chat, prompt, shared-message, and print rendering continues to escape untrusted
text through React. Markdown links now accept internal artifact links only as
`/api/artifacts/<opaque-id>` with an ASCII identifier; encoded separators,
traversal, query strings, fragments, and unrelated internal routes remain text.
Link labels cannot recursively produce anchors. External HTTP(S) references
remain explicit links with `noopener noreferrer`; Markdown does not create
remote images or frames.

Regression fixtures cover scripts, event-handler markup, SVG/MathML, `srcdoc`,
closing-tag payloads, encoded HTML, unsafe URL schemes, hostile attributes,
tables, code blocks, saved prompts, and print exports.

## Production sessions and CSRF

Production identity comes from ChatGPT Sites' authentication boundary through
its trusted identity headers. Session issuance, cookie attributes, rotation,
expiry, and logout invalidation therefore remain platform-dependent. Correct
operation requires the hosting ingress to reject caller-supplied identity and
prevent direct access around that boundary. This patch does not independently
establish those platform guarantees or replace them with Google sessions.

Authenticated application mutations require an exact matching Origin. The
Fetch Metadata check is now an allowlist: `same-origin` or absent (for older
clients) is accepted; other values are rejected. Missing, null, and foreign
Origin values are rejected for these operations. Independently authenticated
webhook and scheduled-service paths retain their own authorization checks.
Local handler and Workerd tests cover malformed metadata without side effects.
A transport may normalize an empty Fetch Metadata header to absence; the
mandatory exact Origin check remains in force.

### Pending Google migration — not production

The pending implementation and its local regression tests cover:

- Browser-bound, single-use OAuth state with S256 PKCE.
- Google signature, issuer, audience, nonce, expiry, and verified-email checks.
- Opaque tokens stored as hashes, with a 30-day absolute session lifetime.
- Host-only `__Host-` cookies with Secure, HttpOnly, SameSite=Lax, and Path=/.
- Session rotation on sign-in/account switching and server-side logout
  invalidation, including cancellation of pending OAuth transactions.
- No authentication fallback to caller-supplied platform identity headers.

Its authentication POSTs also require the exact same-origin policy. Tests use
real handlers, JWT cryptography, native Workerd, and local database fixtures to
exercise expired/duplicated cookies, logout-token reuse, session rotation, and
concurrent OAuth callback replay. These results apply to the pending Google
implementation; they do not verify the live ChatGPT Sites session lifecycle.
Before runtime reversion, the combined Google-source checkpoint passed 427
tests and the production build. That historical result is pending-source
verification, not the test count for the final production runtime.

## Public conversation links

Creating a link now requires an authenticated preview of the exact public
snapshot and explicit privacy confirmation. The server compares a SHA-256 hash
of the reviewed title and messages when creating the link. If content has
changed, the user must refresh and review it again.

New links expire after seven days by default. The user may explicitly choose
one day, seven days, thirty days, or no expiry. The management page shows link
status and supports changing the expiry of active links or revoking them.
Expired links cannot be revived; sharing again creates a new random token.

Migration `0009_public_share_expiry.sql` adds one nullable column. Existing
links retain their previous no-expiry behavior and can be assigned an expiry
or revoked in the management page. Both the public JSON endpoint and the
server-rendered page use the same expiry/availability check. Reads also verify
that the associated conversation still exists and belongs to the share owner.
Revocation is an atomic owner-scoped deletion.

Snapshots allowlist public message fields on both creation and read, including
legacy snapshots. Appended source-document bodies, private metadata, and
non-message roles are excluded. Text the user wrote or the AI quoted directly
in messages can still contain confidential information; the preview and warning
make that public content reviewable before sharing. Expiry/revocation cannot
recall copies that recipients already saved.

## Prompt injection and tool boundaries

All three text providers receive a constant application security policy in
their native trusted instruction field: OpenAI `instructions`, Anthropic
`system`, and Google Interactions `system_instruction`. User settings and
document content are never interpolated into that trusted policy.

For inference, appended documents are encoded into a JSON source envelope,
including filenames and the complete suffix of legacy document markers. This
also applies to previous conversation turns and regeneration. Attacker-provided
closing tags or role-like JSON remain source text. Stored conversations and
user-visible prompts retain their original representation.

The provider boundary accepts only user/assistant text turns and an explicit
set of server-selected options. Requests cannot add model functions, MCP
servers, custom endpoints, credentials, or a network policy. Unexpected tool
outputs are rejected instead of being interpreted as application actions.
The only offered text-provider tools are the application-selected built-in web
search and isolated code execution; code execution retains disabled network
access. Billing, account, session, sharing, and permission changes are not
model tools. Added instruction bytes are included in usage reservation bounds.

Text instructions and source envelopes reduce confusion but do not guarantee
that an AI answer cannot be manipulated. Provider-managed web search still
depends on the model choosing appropriate public queries. These tests establish
application authorization and capability boundaries, not universal model
resistance to indirect prompt injection. Adversarial fixtures use local data
and mocked provider transport, without Google login, paid inference, or an
external write action.

## Verification entry points

- `npm run check:types`
- `npm run test:security`
- Sites production build and migration packaging
- `tests/http-security.test.mjs`, `tests/xss-rendering.test.mjs`
- `tests/request-security-worker.test.mjs`, `tests/api-security.test.mjs`
- Public-share and prompt-injection regression suites alongside existing tests

Live verification here is limited to the public-page CSP and headers described
above. An authenticated browser sign-in, logout invalidation, session reuse,
and Google OAuth round trip were not performed against production.

## Primary guidance

- [OWASP Content Security Policy](https://cheatsheetseries.owasp.org/cheatsheets/Content_Security_Policy_Cheat_Sheet.html)
- [OWASP CSRF Prevention](https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html)
- [OWASP LLM Prompt Injection Prevention](https://cheatsheetseries.owasp.org/cheatsheets/LLM_Prompt_Injection_Prevention_Cheat_Sheet.html)
