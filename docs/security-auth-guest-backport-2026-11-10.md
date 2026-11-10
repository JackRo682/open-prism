# Authentication, guest-abuse and supply-chain security backport

## Scope and provenance

This backport starts from GitHub `a1d9dd1db035fd9969644b5f4d5d88a5b0b0784a`, including the merged external integration, storage and upload security controls from PR #2. It adapts the November 10 Sites security work to this repository's existing model, UI and database baseline. It does not import the newer PDF export/fonts, model switch, billing UI or pending Google-login implementation, and is not a byte-for-byte mirror of the live Sites source.

## Runtime configuration

- Set `APP_ORIGIN=https://getopenprism.com` for production. The actual request URL and Host must match this canonical HTTPS origin before identity assertions can reach the framework. Missing or malformed configuration fails closed for signed-in identity.
- Configure an independent `GUEST_SESSION_SIGNING_SECRET` containing 32–256 characters. The provider key cannot substitute for this secret. Provider-key rotation then leaves guest identities and network quota buckets stable. Introducing a new signing secret invalidates old guest cookies; the browser renews once before fetching a challenge. Historical global spending remains in the durable ledger.
- `GUEST_BOT_PROTECTION=proof-of-work` is the default. The signed two-minute challenge binds session and network bucket, requires bounded SHA-256 work, and can be redeemed once across Workers. This adds computational cost; it is not proof that a visitor is human.
- Optional `turnstile` mode requires real production `TURNSTILE_SITE_KEY`, `TURNSTILE_SECRET_KEY` and the canonical origin. Invalid/test/partial configuration has no permissive fallback. Verification checks hostname and action and atomically rejects replay before inference.

The existing Sites dispatcher remains the identity trust boundary. Canonical host checks and header parsing do not cryptographically authenticate a proxy. The dispatcher must strip caller assertions, and alternate ingress must not bypass it. See [the boundary and verification requirements](platform-identity-boundary.md).

## Guest and account budgets

The original total lifetime ceiling remains $8. Guests have a $2 lifetime portion and signed-in beta usage has a $6 portion. Text and media reservations include their respective portion and the total in one conditional SQL write; historical reservations continue to count. The existing session/network/day and active-job caps remain enforced. Challenge/guest request issuance also shares atomic global and network limits. Guest responses retain the GitHub baseline's fixed GPT-6.1 Sol protocol and pricing.

The frontend obtains and solves a fresh challenge only when sending, supports cancellation, displays managed Turnstile when configured and resets the inference timeout after verification. It does not retry an AI request automatically.

## Ownership and existing protections

A fixed-query `findOwnedResource` helper is used for private conversations, files, shares, browser captures, media, tasks and generated artifacts. Child message reads/deletes repeat the account predicate. Existing storage namespace checks, upload decoding/bounds, request deadlines, API admission, remote-browser restrictions and Drive credential handling from PR #2 remain in place.

The authorization matrix exercises denied anonymous/foreign-account operations and cross-account IDs inside request bodies, verifies that storage/provider calls do not occur, and confirms owner reads still work. Header parsing is tested separately from real Worker ingress sanitization. Guest tests solve actual signed proofs and cover replay, tampering, expiry, key rotation, parallel quotas and the final available reservation.

## Verification

Run from this repository with Node 24.22.1 and pnpm 11.25.0:

```sh
node node_modules/typescript/bin/tsc --noEmit
node --test --test-concurrency=1 tests/*.mjs
node scripts/run-framework.mjs build
node scripts/security-audit.mjs
node scripts/security-sbom.mjs
node scripts/security-secrets.mjs
node scripts/security-secrets.mjs --artifacts-only
```

Verified locally on November 10, 2026:

- 217 tests passed; zero failed, cancelled or skipped.
- TypeScript and the production Worker build passed.
- Both production and full dependency audits reported zero vulnerabilities in every severity category.
- Source, available Git history and built browser/Worker artifacts produced zero secret candidates. The single generated private framework prerender guard passed its strict boundary check; 21 public asset files were checked.
- The CycloneDX inventory contains 775 unique components, including 241 production components.
- The inspected lockfile SHA-256 is `a1308653b047d3f797aaba0320a3f05e1ee82aedcd1a6c08163065ad85594d3b`.

Dependency installation uses the frozen lockfile and reviewed package build-script allowlist. GitHub CI uses immutable action commits, read-only repository permissions, no production credentials, complete available history scans, dependency audit reports and a resolved-lockfile CycloneDX inventory. See [supply-chain details and remaining operational controls](security-supply-chain.md).

These checks do not establish every external provider's network isolation, GitHub branch protection, production proxy configuration or managed Turnstile deployment. No external service, payment capability, additional spend or new login provider is enabled by this source backport.
