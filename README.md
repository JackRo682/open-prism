# Open Prism

Prism runs on ChatGPT Sites with Cloudflare Workers, D1 storage, R2 files and Sign in with ChatGPT.

## Free beta

Set BETA_MODE=true to enable GPT-6.1 Sol without purchasing customer credits. Limits are enforced in one conditional D1 write before provider access: 20 requests per user per UTC day, USD 0.20 reserved usage per user/day, two active responses per user, and USD 8 total beta usage across all users. Requests reserve conservative UTF-8 input bounds and 1,024 output tokens. Successful requests settle against actual provider token counts; uncertain requests retain their allowance. Conversation deletion does not reset quotas. Beta conversations support 16 KB of content. Expensive models and Pro mode are rejected server-side.

Customer payments stay disabled (PAYMENTS_MODE=disabled). Existing prepaid billing code is retained for a separately configured commercial release. No subscription is enabled.

## Secrets

Configure OPENAI_API_KEY in native Sites runtime settings as a secret. BETA_MODE and PAYMENTS_MODE are runtime settings. ANTHROPIC_API_KEY and GEMINI_API_KEY are optional for later releases. ADMIN_USER_ID is the exact Sites application user ID, not the workspace user ID. Never commit API keys or local env files.

## Verification

pnpm install --frozen-lockfile
node node_modules/typescript/bin/tsc --noEmit
node --test tests/integration.mjs

Build with the Sites plugin build-site.mjs helper; package and publish the exact pushed source commit using the Sites workflow. On Windows, set SITES_PNPM_BIN to the bundled pnpm.mjs when invoking the build helper. The 29 integration checks use isolated SQLite and mocked provider transports. Live model requests and browser checks are separate acceptance tests.

## Access and privacy

The site may be publicly visited. AI requests and stored conversations require ChatGPT sign-in. Each conversation and attachment operation checks the authenticated owner on the server. Users can delete conversations, files or all conversation/file data in Settings. Usage records remain to enforce quotas and for accounting. Privacy and terms information is available at /privacy and /terms. Provider requests set store=false; provider processing policies still apply.
