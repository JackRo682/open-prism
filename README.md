# Open Prism

Prism is an AI workspace running on **ChatGPT Sites, Cloudflare Workers, D1, and R2**, with a separate guest chat and Sign in with ChatGPT for the saved workspace. The current free beta uses GPT-6.1 Sol for text. Provider integrations make real requests; missing connections, unsupported models, and exhausted allowances return explicit errors.

The November 5 guest-flow update separates the public landing/chat experience from the existing authenticated workspace. See [guest flow and authentication](docs/guest-flow.md) for the responsive states, API boundaries, guest allowances, and explicit transcript-import workflow.

The November 2026 audit fixes add service adapters and correct the composer, navigation, and responsive layout. [Audit fixes and operations](docs/audit-fixes.md) is the current feature/configuration reference. [Earlier design notes](docs/gemini-design-implementation.md) and the implementation TXT bundles describe the earlier design delivery and are historical snapshots.

## Feature status

| Feature | Implemented behavior | Runtime requirement |
| --- | --- | --- |
| Chat and Canvas | Streaming, stop, saved history, search, editable Canvas drafts, and private Markdown saving. Canvas/tool selection hides the Chat/Work switch. | Sign-in, D1, and an allowed text model; R2 for saved files. |
| Deep Research | Web search defaults on when configured, with actual provider citations; users can choose supplied-document analysis. | OpenAI Responses web search and beta allowance. |
| Work | Applied response preferences, hidden text model selector, optional isolated Code Interpreter, and authenticated downloads for generated files. | OpenAI tool access, beta mode, and R2 for downloads. |
| Image | Prompt generation, image-reference editing, actual result display, and private downloads. | OpenAI image-model access, beta mode, and sufficient allowance. |
| Video | Reference images, aspect ratio, provider job polling, private playback, and range downloads. | Google Gemini access **and an approved media budget change**; the default beta cap blocks video. |
| Music | Dedicated prompt/result page, real audio generation, playback, and downloads. | Google Gemini/Lyria access, beta mode, and the full current daily media allowance. |
| Scheduled tasks | Create/edit/delete, once/daily/weekly recurrence, time zones, manual execution, result links, and authenticated due-task runner. | Manual runs use normal model limits; automatic runs require a configured external scheduler and runner credential. |
| Browser | Saved preferences, local-link permission, remote-only routing, real remote page text/screenshots, and owner-scoped history deletion. | Browserless token and verified provider egress isolation for new remote captures. Public-page reading is supported; interactive remote login/form control is not implemented. |
| Google Drive | User-authorized Picker selection and real document export/upload. | Google OAuth client, restricted Picker API key, and Cloud project number. |
| Notebook | Dedicated create/open/search/save/delete page and “save and attach”; private Markdown documents with selected text sources. | Sign-in, D1, and R2. |

Personalization, memory, reusable skills, share snapshots/revocation, theme persistence, browser speech recognition, and print/install actions remain available where the browser/runtime supports them. Guests have a separate limited text-chat endpoint, browser-tab transcript retention, and sign-in draft handoff. Guest headers do not expose PDF export; authenticated workspace controls retain their existing behavior.

## Runtime configuration

| Setting or binding | Purpose |
| --- | --- |
| `DB` | D1 database. Apply all migrations through `0005_media_and_browser.sql`. |
| `BUCKET` | Private R2 storage for documents, notebooks, media, references, and generated files. |
| `OPENAI_API_KEY` | Server secret for the beta text model, web search, Code Interpreter, and images; actual account/model access still applies. |
| `GUEST_CHAT_ENABLED=false` | Optional kill switch for anonymous inference. Without this override, guest chat uses the existing key and shared beta lifetime allowance. |
| `BETA_MODE=true`, `PAYMENTS_MODE=disabled` | Existing bounded beta configuration. Customer payments remain disabled. |
| `BETA_USER_DAILY_LIMIT_MICROS` | Optional server-only approved daily allowance in micro-USD; default `200000` ($0.20). No runtime increase was made in this change. |
| `GEMINI_API_KEY` | Optional server secret for Google video/music and other allowed Google models. |
| `ANTHROPIC_API_KEY` | Optional secret for the existing Anthropic adapter; it does not override the beta text-model policy. |
| `BROWSERLESS_API_TOKEN`, `BROWSERLESS_ENDPOINT` | Optional remote-browser secret and approved official HTTPS endpoint. |
| `BROWSERLESS_EGRESS_POLICY_VERIFIED=true` | Operator attestation that private-network blocking, browser isolation and provider resource limits have been verified. Remote capture stays disabled without it; see [verification requirements](docs/browser-egress-security.md). |
| `GOOGLE_DRIVE_CLIENT_ID`, `GOOGLE_DRIVE_PICKER_KEY`, `GOOGLE_DRIVE_APP_ID` | Browser OAuth client ID, restricted browser API key, and numeric Cloud project number. These public configuration values are returned only to signed-in clients. |
| `SCHEDULE_RUNNER_ENABLED=true`, `SCHEDULE_RUNNER_SECRET` | Enable the authenticated runner; the secret must be at least 32 characters. An external scheduled caller is also required. |
| `ADMIN_USER_ID` | Optional exact Sites application user ID for administrator access. |

Optional model selectors and feature kill switches are documented in [the configuration guide](docs/audit-fixes.md#configuration). Store secrets in the server runtime; never commit credentials. Provider API billing/access is separate from consumer chat subscriptions. Cloud storage, provider generation, remote-browser usage, and an external scheduler can incur charges.

The deployment configuration inspected for this audit contained `OPENAI_API_KEY`, `BETA_MODE`, and `PAYMENTS_MODE`. Google, Drive, Browserless, and an automatic task runner were not connected. A configuration flag is not proof that a provider request succeeds.

## Free-beta limits

The default atomic limits remain: **20 text/media requests per user per UTC day**, **USD 0.20 of reserved usage per user/day**, **two pending requests per user**, and **USD 8 total lifetime beta usage across the site**. Text output is limited to 1,024 tokens and supplied context to 16,000 UTF-8 bytes. Web search and Code Interpreter reserve their additional tool allowance before access.

Media reserves **USD 0.15/image**, **USD 0.20/music request**, or **USD 1.50/video request**. These are conservative application allowances, not advertised provider prices. **Video therefore cannot run under the present USD 0.20 daily cap, even with a valid Google key.** An approved operator configuration can set `BETA_USER_DAILY_LIMIT_MICROS` to at least `1500000`; decimal integers are accepted and capped at `20000000`, malformed or unsafe-integer values fall back to the default, and `0` prevents new beta spending. The site-wide USD 8 lifetime cap still applies. No deployment allowance was raised. Music requires the entire unused default daily allowance. Media reservations remain until provider reconciliation; uncertain started requests retain their reservation. Deleting content does not reset usage.

Remote browsing has separate limits of five visits per user/day, 50 across the site/day, one in-flight request per user, and 100 saved pages. See [all bounds](docs/audit-fixes.md#limits-and-accounting) for files, tasks, and tool execution.

## Development and verification

Use Node.js 22.13 or newer and the package manager pinned in `package.json`.

```sh
pnpm install --frozen-lockfile
node node_modules/typescript/bin/tsc --noEmit
node --test tests/integration.mjs
node --test tests/provider-features.mjs
node --test tests/scheduled-tasks.test.mjs
node --test tests/browser-workspace.mjs
node --test tests/guest-chat.test.mjs
node --test tests/guest-routing.mjs
pnpm build
```

Run the suites sequentially: some fixtures compile overlapping source modules into a temporary test directory. They use isolated SQLite/storage and mocked provider transports, and do **not** prove live credentials, model access, OAuth consent, background scheduling, or real-device mobile behavior. The audit-fix guide records the verification boundary; no release or live provider success is implied by this README.

For development use `pnpm dev`, or `sites-preview start <absolute-checkout>` in the managed Sites environment and open its returned URL. Hosted releases must use the existing Sites build/publish workflow and the exact reviewed source commit.

## Data and operations

Conversations, documents, media, generated files, settings, browser captures, and scheduled tasks require sign-in and server-side ownership checks. Public share tokens expose a conversation snapshot until revoked; attached file bodies are omitted, but text included in the conversation remains visible. Account-data deletion removes owned workspace data and stored objects while preserving usage/accounting records and the separate ChatGPT account.

`/api/health/live` probes the service; `/api/health/ready` checks the five existing critical tables, storage binding and OpenAI key. Readiness requests share an in-flight check, briefly cache its health result, and have a three-second response deadline. These probes do not establish live provider access or fully validate every table column/migration. API responses use request IDs and cache controls; logs must not contain credentials or prompt contents.

Commercial billing remains gated by its separate rate/launch configuration, `TOSS_SECRET_KEY`, `TOSS_CLIENT_KEY`, and `LAUNCH_APPROVED`. This change does not enable customer payments or approve additional spend.

The [November 10 security backport](docs/security-backport-2026-11-10.md) documents the integration, storage, request-capacity and upload safeguards added to this GitHub baseline, their verification commands, and the remaining infrastructure checks.
