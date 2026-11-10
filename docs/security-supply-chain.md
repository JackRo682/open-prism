# Dependency and secret controls — 10 November 2026

The security workflow checks the exact committed source and lockfile. It does not deploy the site or receive production provider, payment, Google OAuth, storage or hosting credentials. The workflow becomes active after this source is pushed to the GitHub repository with Actions enabled; source presence in Sites alone does not establish a completed GitHub Actions run.

## Automatic checks

`.github/workflows/security.yml` runs on main-branch pushes, pull requests, manual dispatch, and weekly. It uses Ubuntu 24.04, Node 24.22.1 (the locally tested runtime), pnpm 11.25.0, and immutable commit pins for checkout, Node setup and artifact upload. The GitHub token has only `contents: read`, checkout does not persist credentials, and the workflow does not use privileged pull-request events. Audit jobs retain evidence for 14 days.

Dependency installation uses the frozen lockfile. The existing seven-day package release-age policy, integrity-checked resolutions and explicit dependency build-script allowlist remain in `pnpm-workspace.yaml`. No `audit --fix`, unrestricted script approval, or automatic dependency merge is enabled. Dependabot proposes weekly dependency and action updates; CODEOWNERS identifies the repository owner for security-sensitive changes. Requiring those checks and owner approval before merge is a separate GitHub branch/ruleset setting, not something the CODEOWNERS file alone enforces.

The pipeline performs these checks:

1. Install Gitleaks 8.30.1 from the exact publisher release and verify its pinned SHA-256 archive checksum before execution.
2. Verify the scanner detects an invented, never-issued GitHub-token-shaped control and redacts its value. Scan all available Git history and the current source, including uncommitted tracked and non-ignored source during local runs.
3. Install the frozen dependency graph, audit production dependencies and the complete build/development graph, and fail on high/critical findings or an unavailable/malformed registry result. Moderate and low findings remain in the full report; they are not suppressed.
4. Generate a CycloneDX 1.6 JSON inventory using `pnpm list --lockfile-only`, including all resolved package versions, dependency relationships, production classification and the SHA-256 of the inspected lockfile.
5. Run TypeScript and security regression tests, build with no production credentials, then scan both browser and Worker artifacts under `dist/`.

The dependency inventory describes the locked graph, including optional packages for other operating systems and development dependencies. It is not a claim that every package is reachable in the deployed Worker. Registry advisory scans and pattern-based secret detection cannot prove the absence of undisclosed vulnerabilities or every possible secret format.

## Dependency remediation

The earlier production audit found a remaining moderate advisory, [GHSA-g3hv-75wg-m249](https://github.com/isaacs/minimatch/security/advisories/GHSA-g3hv-75wg-m249), in `minimatch 10.2.5` through `@typescript-eslint/typescript-estree 8.59.3`. The maintainer identifies a pattern-preprocessing amplification condition and lists `11.0.1` as fixed. There is no patched 10.x release.

The inspected consumer calls only the named `minimatch(filePath, pattern, { dot: true })` function for its configured `allowDefaultProject` patterns. It does not invoke the removed v10 regular-expression APIs or enable the advisory's `optimizationLevel >= 2` condition, and no production request path was identified. To remove the dependency finding without changing unrelated minimatch consumers, a parent-scoped override selects `11.0.4` for that exact parser version. Its November 2 release satisfies the existing seven-day waiting period; the newer November 5 release was not selected.

The focused parser override changes that minimatch instance and its new `@isaacs/nonrecursive-glob-match 1.0.3` dependency. This GitHub backport also carries the reviewed framework and transitive dependency updates from the production security release while omitting unrelated PDF and Google-login dependencies. Compatibility tests exercise the actual TypeScript parser project service: an explicitly allowed default-project file succeeds and a different file remains denied. A separate regression checks that the formerly amplifying preprocessing pattern stays bounded. The override should be removed when the upstream consumer natively supports a fixed release, after checking its replacement lockfile.

## Local verification evidence

This document describes the security controls included in the GitHub compatibility backport. The backport preserves the repository's earlier model, UI and database baseline; it is not a byte-for-byte production snapshot. Verification must use this checkout's own final package and lock files. Audit, inventory and secret-scan reports are generated under ignored `.sites-runtime/security/reports/`; do not reuse package counts, source commit counts, lock hashes or test totals from another checkout.

The history scan initially identified the literal boolean flag `LAUNCH_APPROVED=true` in an old README as a generic-key candidate. This was verified as documentation, not a credential. `.gitleaks.toml` permits only that exact literal; it does not exclude a whole file, test directory, provider-key format or historical commit. Reports retain only rule, location, line and commit, so candidate values and surrounding content are not printed or uploaded. Build-artifact scan results are generated after each successful build and must be checked for the final deployed source.

Vinext also generates a private random prerender guard in `dist/server/vinext-server.json` and the compiled Worker. This is an expected framework secret, not a provider credential or an acceptable browser secret. The artifact scanner accepts only the exact generic-key finding for that single field after validating the manifest's complete shape, confirming it matches the Worker, confirming the public asset directory is exactly `dist/client`, and searching every public file for the value. A leaked client value, additional metadata field, broader asset directory or unrelated finding fails the check. The exception is not used for source or history scans and does not exclude the whole metadata file. The artifact report records the public-file count and expected private framework guard findings for the actual build being checked.

## Run the same checks

```sh
bash scripts/install-security-tools.sh
pnpm run security:secrets
pnpm run audit:security
pnpm run security:sbom
node --test tests/dependency-security.test.mjs tests/security-tooling.test.mjs tests/security-artifact-policy.test.mjs
pnpm run build
node scripts/security-secrets.mjs --artifacts-only
```

Reports are written to ignored `.sites-runtime/security/reports/`. The installer currently supports Linux x86_64; on another platform install the reviewed Gitleaks version independently and set `GITLEAKS_BIN` to its executable. Do not use real provider or account secrets in build/test fixtures.

## Operating boundaries

No provider credential is rotated solely because this scan found no leak. When rotation is needed, provision and validate a replacement in the provider account, update only the server runtime secret, deploy, verify service health, and revoke the old credential. Independent guest signing keys avoid tying that rotation to guest-cookie validity. External account MFA, repository access, cloud IAM, required branch checks, provider spending limits and incident response still depend on their respective services' settings.

References: [GitHub Actions secure use](https://docs.github.com/en/actions/reference/security/secure-use), [pnpm installation](https://pnpm.io/cli/install), [pnpm audit](https://pnpm.io/cli/audit), [Gitleaks](https://github.com/gitleaks/gitleaks), [CycloneDX specification](https://cyclonedx.org/specification/overview/).
