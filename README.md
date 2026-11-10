# Open Prism

Prism is an AI workspace running on **ChatGPT Sites, Cloudflare Workers, D1, and R2**, with a separate guest chat and Sign in with ChatGPT for the saved workspace. The default free model is Gemini 3.5 Flash-Lite. GPT-6.1 Sol, GPT-6 Astra, Claude Fable 5.1 and Gemini 4 Argon require live paid credit, independently of beta mode. Provider integrations make real requests; missing connections, unsupported models, and exhausted allowances return explicit errors.

The November 5 guest-flow update separates the public landing/chat experience from the existing authenticated workspace. See [guest flow and authentication](docs/guest-flow.md) for the responsive states, API boundaries, guest allowances, and explicit transcript-import workflow.

The November 2026 audit fixes add service adapters and correct the composer, navigation, and responsive layout. [Audit fixes and operations](docs/audit-fixes.md) is the current feature/configuration reference. [Earlier design notes](docs/gemini-design-implementation.md) and the implementation TXT bundles describe the earlier design delivery and are historical snapshots.

The November 7 upgrade flow adds a separate responsive `/upgrade` page, purchase/consent records, Toss SDK v2 integration, recoverable payment approval, and refund reconciliation. See [Toss setup and activation](docs/toss-payments-setup.md). Missing credentials leave checkout disabled while the catalog and dialogs remain available.

The [November 8 security review](docs/security-review-2026-11-08.md) records the tailored 20-category checklist, new preventive controls, dependency remediation, existing safeguards, and remaining operational boundaries. It also separates advisory counts from incident statistics and records the verification evidence.

The [November 9 model-access update](docs/model-access-2026-11-09.md) records the free/paid model split, durable usage accounting, current payment/provider setup blockers, guest-import compatibility, and sequenced desktop welcome animation.

The [security hardening for review items 15–20](docs/security-hardening-15-20.md) adds bounded uploads, durable security alerts, append-only credit accounting, runner rotation, lease ownership, and resumable workspace deletion. The [retention policy](docs/data-retention.md) documents retained accounting records, interrupted-worker recovery, and backup limitations. These changes preserve the production authentication and existing usage budgets.

## Feature status

| Feature | Implemented behavior | Runtime requirement |
| --- | --- | --- |
| Upgrade and billing | New-tab upgrade flow, stacked plan/terms dialogs, real Toss checkout when configured, owned-order recovery, separate test ledger, and administrator refunds. | Merchant key pair and policy configuration for checkout; explicit approval for live sales. |
| Chat and Canvas | Streaming, stop, saved history, search, editable Canvas drafts, and private Markdown saving. Canvas/tool selection hides the Chat/Work switch. | Sign-in, D1, and an allowed text model; R2 for saved files. |
| Deep Research | Supplied-document analysis remains available. External web search is disabled until paid tool tariffs are configured. | A supported text model; paid credit for premium models. |
| Work | Applied response preferences and existing private artifact downloads. New Code Interpreter jobs remain disabled until paid tool tariffs are configured. | Supported text model; R2 for existing downloads. |
| Image | Prompt generation, image-reference editing, actual result display, and private downloads. | OpenAI image-model access, beta mode, and sufficient allowance. |
| Video | Reference images, aspect ratio, provider job polling, private playback, and range downloads. | Google Gemini access **and an approved media budget change**; the default beta cap blocks video. |
| Music | Dedicated prompt/result page, real audio generation, playback, and downloads. | Google Gemini/Lyria access, beta mode, and the full current daily media allowance. |
| Scheduled tasks | Create/edit/delete, once/daily/weekly recurrence, time zones, manual execution, result links, and authenticated due-task runner. | Manual runs use normal model limits; automatic runs require a configured external scheduler and runner credential. |
| Browser | Saved preferences, local-link permission, remote-only routing, real remote page text/screenshots, and owner-scoped history deletion. | Browserless token for new remote captures. Public-page reading is supported; interactive remote login/form control is not implemented. |
| Google Drive | User-authorized Picker selection and real document export/upload. | Google OAuth client, restricted Picker API key, and Cloud project number. |
| Notebook | Dedicated create/open/search/save/delete page and “save and attach”; private Markdown documents with selected text sources. | Sign-in, D1, and R2. |

Personalization, memory, reusable skills, share snapshots/revocation, theme persistence, browser speech recognition, and print/install actions remain available where the browser/runtime supports them. Guests have a separate limited text-chat endpoint, browser-tab transcript retention, and sign-in draft handoff. Both chat experiences expose the conversation menu and PDF download. Guest pinning and server-side legal reporting require sign-in; guest titles and feedback remain in the current browser session.

## Conversation controls

The November 8 update removes answer avatars, uses the same Prism mark for the site and favicon, and adds the animated three-dot thinking state. Conversation menus provide pin, rename, PDF download, Docs export, and delete. Response controls provide positive/negative feedback, optional feedback details, copy with completion feedback, listening, export, legal reports, and actual response metadata. The latest answer can be regenerated longer, shorter, without saved personalization, or with the default retry behavior. Editing a saved prompt or retrying replaces the relevant suffix only after a successful generation; previous content is archived, and interrupted revisions reconcile their operation status before allowing another send.

PDF download builds the whole selected conversation directly rather than printing the current viewport. It embeds subsetted Korean/Latin/CJK fonts, keeps ordinary text selectable, paginates tables and code, and includes the original Markdown transcript as an attachment. Fonts are loaded only on export; their licenses and provenance are in `public/fonts/README.txt`.

Native Google Docs creation requires `GOOGLE_DRIVE_CLIENT_ID`, an enabled Google Drive API, and an OAuth web client permitting the deployed origin. This export uses a user-approved `drive.file` token held only in memory; Picker keys are not required for this particular action. When the OAuth client is not configured, the dialog clearly offers copying the content and opening a new Google Doc instead. Gmail opens a populated compose window for review and does not send mail. For content too large for a compose URL, it offers complete-text copying without silent truncation.

Signed-in feedback and legal-report receipts are stored in D1 with ownership checks. Legal-report review is available through the existing administrator gate (`ADMIN_USER_ID`); no external email is sent automatically. Response details use stored provider/model/time/usage metadata and explicitly identify missing historical data.

## Runtime configuration

| Setting or binding | Purpose |
| --- | --- |
| `DB` | D1 database. Apply all migrations through `0012_account_deletion.sql`; the normal hosted deployment applies the bundled migrations before uploading the Worker. |
| `BUCKET` | Private R2 storage for documents, notebooks, media, references, and generated files. |
| `OPENAI_API_KEY` | Server secret for paid Sol/Astra and image generation; actual account/model access still applies. |
| `GUEST_CHAT_ENABLED=false` | Optional kill switch for anonymous inference. Without this override, guest chat uses the existing key and shared beta lifetime allowance. |
| `BETA_MODE=true`, `PAYMENTS_MODE=disabled` | Existing bounded beta configuration. Customer payments remain disabled. |
| `BETA_USER_DAILY_LIMIT_MICROS` | Optional server-only approved daily allowance in micro-USD; default `200000` ($0.20). No runtime increase was made in this change. |
| `GEMINI_API_KEY` | Required server secret for free Flash-Lite, plus Google Argon/video/music access where enabled. |
| `ANTHROPIC_API_KEY` | Required server secret for paid Claude Fable 5.1; live credit and tariff configuration are also required. |
| `BROWSERLESS_API_TOKEN`, `BROWSERLESS_ENDPOINT`, `BROWSERLESS_EGRESS_POLICY_VERIFIED` | Optional remote-browser secret, approved official HTTPS endpoint, and explicit confirmation of a tested outbound network policy. Captures stay disabled until the policy flag is `true`; see [browser egress requirements](docs/browser-egress-security.md). |
| `GOOGLE_DRIVE_CLIENT_ID`, `GOOGLE_DRIVE_PICKER_KEY`, `GOOGLE_DRIVE_APP_ID` | Browser OAuth client ID, restricted browser API key, and numeric Cloud project number. These public configuration values are returned only to signed-in clients. |
| `SCHEDULE_RUNNER_ENABLED=true`, `SCHEDULE_RUNNER_SECRET` | Enable the authenticated runner; the secret must be at least 32 characters. An external scheduled caller is also required. |
| `ADMIN_USER_ID` | Optional exact Sites application user ID for administrator access. |

Optional model selectors and feature kill switches are documented in [the configuration guide](docs/audit-fixes.md#configuration). Store secrets in the server runtime; never commit credentials. Provider API billing/access is separate from consumer chat subscriptions. Cloud storage, provider generation, remote-browser usage, and an external scheduler can incur charges.

The November 9 configuration inspection found Google and OpenAI keys. Anthropic and Toss keys were absent; live checkout was disabled. Earlier audit snapshots describe their historical configuration. A configuration flag is not proof that a provider request succeeds.

## Free-beta limits

The default atomic limits remain: **20 text/media requests per user per UTC day**, **USD 0.20 of reserved usage per user/day**, **two pending requests per user**, and **USD 8 total lifetime beta usage across the site**. Guest output is limited to 1,024 tokens. Signed-in free output can use up to 8,192 tokens within its reserved budget; supplied context is bounded to 16,000 UTF-8 bytes. Premium text uses the paid wallet instead of the free allowance.

Media reserves **USD 0.15/image**, **USD 0.20/music request**, or **USD 1.50/video request**. These are conservative application allowances, not advertised provider prices. **Video therefore cannot run under the present USD 0.20 daily cap, even with a valid Google key.** An approved operator configuration can set `BETA_USER_DAILY_LIMIT_MICROS` to at least `1500000`; decimal integers are accepted and capped at `20000000`, malformed or unsafe-integer values fall back to the default, and `0` prevents new beta spending. The site-wide USD 8 lifetime cap still applies. No deployment allowance was raised. Music requires the entire unused default daily allowance. Media reservations remain until provider reconciliation; uncertain started requests retain their reservation. Deleting content does not reset usage.

Remote browsing has separate limits of five visits per user/day, 50 across the site/day, one in-flight request per user, and 100 saved pages. See [all bounds](docs/audit-fixes.md#limits-and-accounting) for files, tasks, and tool execution.

## Development and verification

Use Node.js 22.13 or newer and the package manager pinned in `package.json`.

```sh
pnpm install --frozen-lockfile
node node_modules/typescript/bin/tsc --noEmit
node --test tests/integration.mjs
node --test tests/billing.test.mjs
node --test tests/upgrade-client.test.mjs
node --test tests/provider-features.mjs
node --test tests/scheduled-tasks.test.mjs
node --test tests/browser-workspace.mjs
node --test tests/guest-chat.test.mjs
node --test tests/guest-routing.mjs
node --test tests/conversation-actions.test.mjs
node --test tests/conversation-pdf.test.mjs
pnpm build
```

Run the suites sequentially: some fixtures compile overlapping source modules into a temporary test directory. They use isolated SQLite/storage and mocked provider transports, and do **not** prove live credentials, model access, OAuth consent, background scheduling, or real-device mobile behavior. The audit-fix guide records the verification boundary; no release or live provider success is implied by this README.

For development use `pnpm dev`, or `sites-preview start <absolute-checkout>` in the managed Sites environment and open its returned URL. Hosted releases must use the existing Sites build/publish workflow and the exact reviewed source commit.

## Data and operations

Conversations, documents, media, generated files, settings, browser captures, and scheduled tasks require sign-in and server-side ownership checks. Public share tokens expose a conversation snapshot until revoked; attached file bodies are omitted, but text included in the conversation remains visible. Account-data deletion removes owned workspace data and stored objects while preserving usage/accounting records and the separate ChatGPT account.

`/api/health/live` probes the service; `/api/health/ready` checks eight critical tables, the storage binding and the Gemini key. Readiness probes share an in-flight check and briefly cache its health result, with a three-second response deadline. These probes do not establish live provider access or fully validate every table column/migration. API responses use request IDs and cache controls; logs must not contain credentials or prompt contents.

The [integration, storage and upload hardening notes](docs/security-integrations-2026-11-10.md) describe endpoint read quotas, bounded concurrent request preparation, private download handling, strict upload validation and short-lived Drive selection sessions, including the infrastructure checks that cannot be proved by application code alone.

Commercial billing remains gated by its separate rate/launch configuration, `TOSS_SECRET_KEY`, `TOSS_CLIENT_KEY`, and `LAUNCH_APPROVED`. This change does not enable customer payments or approve additional spend.
