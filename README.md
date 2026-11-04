# Open Prism

Prism is an authenticated AI workspace with provider adapters for OpenAI, Anthropic, and Google. It runs on **ChatGPT Sites, Cloudflare Workers, D1, and R2**, with Sign in with ChatGPT. The current free beta enables GPT-6.1 Sol; the existing model catalog and paid-access checks remain in place.

The November 2026 interface follows the supplied Gemini desktop references, including the 12-screen tool/settings package: a dark 288px sidebar, a blue-violet workspace glow, a centered 660px composer, and a 240px settings menu. Prism keeps its own name, actual account information, and configured model names. See [the implementation notes](docs/gemini-design-implementation.md) for measurements, routes, API contracts, and verification limits.

## Implemented behavior

- Chat and Work welcome states, model selection, reasoning controls, streamed responses, stop, saved conversations, and model comparison when the runtime permits it.
- Canvas, Guided Learning, and supplied-document research through the existing provider; editable Canvas drafts with per-tab recovery and real Markdown-file saving.
- Browser preferences with owner-scoped persistence and actual external-link confirmation; media composer, acknowledgement, and video-introduction states reflect unavailable generation services.
- File upload and attachment; new notebooks are saved Markdown documents in the existing private file store.
- Cookie-initialized System/light/dark themes, nested settings/tool menus, responsive navigation, and a chat-search dialog that searches the signed-in user's conversation titles and message text.
- Saved personalization, memory, work-response preferences, and up to 20 reusable skills. Type `@` in the composer to select a saved skill. The server reads the owner's current settings on each request.
- Memory import with a preview and replacement confirmation; public conversation snapshots with owner-managed revocation.
- Browser speech recognition when supported, print-to-PDF through the browser, and an app-install action when the browser offers installation.

Remote browser control, remote code execution, Google Drive OAuth, media generation, and scheduled/background jobs are not connected. Unavailable features are labeled where exposed. Feedback opens a prefilled GitHub issue for the user to review and submit. No synthetic model answers or successful remote-action results are generated.

## Runtime configuration

| Setting or binding | Purpose |
| --- | --- |
| `DB` | Existing D1 database; apply all migrations in `drizzle/`, including `0003_workspace_settings_and_shares.sql`. |
| `BUCKET` | Existing R2 storage for private text files and Markdown notebooks. |
| `OPENAI_API_KEY` | Server secret required for the current free-beta model. |
| `ANTHROPIC_API_KEY`, `GEMINI_API_KEY` | Optional server secrets for additional provider adapters; model access and runtime policy still apply. |
| `BETA_MODE=true` | Enables the bounded GPT-6.1 Sol beta. |
| `PAYMENTS_MODE=disabled` | Keeps customer payments disabled. |
| `ADMIN_USER_ID` | Optional exact Sites application user ID for administrator access. |

Configure keys in the site's server runtime. Never commit keys or local environment files. The interface changes require no new provider accounts, OAuth clients, API keys, or webhooks. Provider API access and quota are separate from consumer chat subscriptions.

The preserved commercial billing code has its own launch requirements, including `TOSS_SECRET_KEY`, `TOSS_CLIENT_KEY`, and `LAUNCH_APPROVED`. This redesign does not enable payments or subscriptions.

## Free-beta limits

Limits are reserved atomically before provider access: **20 requests per user per UTC day**, **USD 0.20 reserved usage per user/day**, **two active responses per user**, and **USD 8 total beta usage**. Responses are limited to 1,024 output tokens; beta context is bounded to 16,000 bytes, including selected documents and applied preferences. Successful requests settle against provider-reported usage; uncertain requests retain their reservation. Deleting conversations does not reset quotas. Other models and Pro mode are rejected by the beta policy.

## Verification and development

Use Node.js 22.13 or newer and the package manager version pinned in `package.json`.

```sh
pnpm install --frozen-lockfile
node node_modules/typescript/bin/tsc --noEmit
node --test tests/integration.mjs
pnpm build
```

The integration suite contains **40 tests**, using isolated SQLite and mocked provider transports. It covers authentication, ownership, streaming persistence, settings validation and context application, search, share revocation and concurrency, uploads, quotas, accounting, tool validation, unavailable-feature side effects, and monotonic conversation chronology under a frozen or backward clock. Browser behavior and live provider access are separate acceptance checks.

Use the existing Sites build and publishing workflow for hosted releases. Package and publish the exact pushed source commit. Managed preview uses `sites-preview start <absolute-checkout>`; use its returned URL. A portable checkout can use `pnpm dev`.

## Access and operations

Private conversations, files, settings, and share management require ChatGPT sign-in and server-side ownership checks. Public share URLs expose a snapshot to anyone holding the token; revocation is checked when the link is read. Attached file bodies are omitted from snapshots, while text already included in the conversation remains visible. Account-data deletion removes conversations, files, settings, and public shares; usage/accounting records remain.

`/api/health/live` and `/api/health/ready` provide deployment probes. API responses include `X-Request-ID`, `no-store`, and rate-limit `Retry-After` headers where applicable. Operational logs exclude prompts, email addresses, and API keys.

## Project mapping

This repository is the multi-model AI workspace. Its Sites project is declared in [`.openai/hosting.json`](.openai/hosting.json). The separate `JackRo682/SignalBrief` project uses Supabase and Vercel. The redesign preserves Prism's existing Sites/Workers/D1/R2 architecture.
