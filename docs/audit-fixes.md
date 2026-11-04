# November 2026 audit fixes

This document describes the implemented source changes and their operational requirements as of **2026-11-04**. It supersedes unavailable-feature statements in the earlier design notes and generated implementation TXT snapshots. It does not certify a production deployment or successful live provider calls.

## Feature matrix

| Audited area | Result in source | Remaining connection or acceptance requirement |
| --- | --- | --- |
| Deep Research | Configured research defaults to web search. OpenAI Responses receives the actual `web_search` tool; returned citation annotations/sources are rendered and saved. Document-only research remains selectable. A run without a real search result cannot claim successful web research. | OpenAI model/tool access, beta mode, and remaining allowance. This is a bounded search response, not continuous or exhaustive background research. |
| Image | Images API generation and reference-image editing, real image rendering, private storage/downloads, errors, cancellation, and retained draft/reference state. | Valid OpenAI image access, storage, enabled beta policy, and sufficient allowance. |
| Video | Google Interactions adapter, reference input, 16:9/9:16 selection, pending-job refresh, durable media records, private playback/downloads, and byte ranges. | Missing Google key in the inspected runtime. The default daily budget also blocks the USD 1.50 reservation. Both API access and an approved sufficient budget are required. |
| Music | Dedicated page with actual Google audio generation, saved results, playback, downloads, and errors. | Missing Google key. A music request reserves USD 0.20, consuming the entire unused default daily allowance. |
| Scheduled tasks | Owner-scoped CRUD, once/daily/weekly recurrence, IANA time zones/DST handling, draft/pause controls, manual runs, result conversation links, lease protection, and authenticated due-task endpoint. | Automatic execution requires an external recurring caller plus the runner settings below. A saved draft or readiness flag does not create a hosted scheduler. |
| Browser settings | Persisted local/remote-only preference, confirmation policy, safe remote routing, and actual deletion of the owner's saved captures. | New remote captures require Browserless. When unavailable, remote-only navigation stays inside Prism and never silently opens a local external tab. |
| Remote browser page | Genuine rendered screenshot/text/link capture using an isolated Browserless request; owner-only stored history. | Public-page reading only. No persistent remote login, arbitrary commands, form filling, or interactive desktop-control session is implemented. |
| Canvas and Work | Canvas/selected tools hide Chat/Work. Work hides the text model picker, applies saved response instructions, and can use real isolated Python execution and generated-file downloads. | Work execution requires OpenAI access and beta mode. Network access in the configured Code Interpreter container is disabled; this cannot operate external apps or deploy sites. |
| Drive | Real Google Identity Services consent, Picker selection, direct selected-file export/download, and upload into the user's private files. | Google Cloud configuration below is absent in the inspected runtime. No simulated Drive files or OAuth tokens are supplied. |
| Notebook | Dedicated creation/library page, source selection, private Markdown saving, reopening, search, delete, and attachment to Chat. | Sign-in, D1, and R2. This is a document workspace, not a replica of every Gemini notebook feature. |
| Signed-out Send | Keeps the draft and relevant mode/source context; sign-in guidance is in Korean. | Signed-in streaming/history/Canvas acceptance needs a real authenticated session. |
| Desktop/mobile layout | Heading 36px/48px, initial prompt content height 24px, selected-tool layout, corrected dialog stacking, small-width menu layout, mobile 44px controls, safe areas, and visual-viewport keyboard sizing. Image notice dismissal preserves the image route. | Responsive CSS and synthetic viewport checks do not establish real touch/keyboard behavior on iOS or Android. Keep real-device verification separate. |

Media composition only shows inputs actually used by the media request. Text attachments and saved skills are preserved for returning to Chat but hidden in Image/Video, avoiding an implication that those inputs affect generation.

## Configuration

The inspected deployment had `OPENAI_API_KEY`, `BETA_MODE=true`, and `PAYMENTS_MODE=disabled`. No Google, Drive, Browserless, or automatic-runner credentials were present. This implementation does not add credentials, provision accounts, authorize additional provider spending, or increase the deployed budget.

### Core runtime and models

Use the existing Sites authentication, D1 `DB`, and private R2 `BUCKET` bindings. Apply every migration in order through `0005_media_and_browser.sql` before exposing the new routes. The new tables are `scheduled_tasks`, `media_assets`, `browser_sessions`, and `work_artifacts`; [db/schema.ts](../db/schema.ts) includes the matching columns, defaults, checks, and indexes. Migration 0005 does not declare foreign keys for its tables; cleanup remains application-owned.

| Environment setting | Meaning |
| --- | --- |
| `OPENAI_API_KEY` | Server secret for beta text, OpenAI web search/Code Interpreter, and image generation. Account access and quota are checked by the real provider. |
| `GEMINI_API_KEY` | Server secret for Google video/music. Consumer Gemini access alone does not configure this API. |
| `OPENAI_IMAGE_MODEL` | Optional; default `gpt-image-2.5-flare`. Accepted families are constrained in [media-provider.ts](../lib/media-provider.ts). |
| `GEMINI_VIDEO_MODEL` | Optional; default `gemini-omni-1.1-flash`. |
| `GEMINI_MUSIC_MODEL` | Optional; default `lyria-3-clip-preview`; the adapter also accepts `lyria-3.5`. |
| `WEB_RESEARCH_ENABLED`, `WORK_CODE_EXECUTION_ENABLED`, `IMAGE_GENERATION_ENABLED`, `VIDEO_GENERATION_ENABLED`, `MUSIC_GENERATION_ENABLED` | Server kill switches: the exact value `false` disables that feature. Enabling a flag does not bypass credentials, beta policy, allowance, or provider access. |
| `BETA_USER_DAILY_LIMIT_MICROS` | Optional approved per-user UTC-day allowance in micro-USD. Default `200000`; decimal integers are capped at `20000000`; malformed or unsafe-integer values fall back to the default. `0` stops new beta spending. |
| `ANTHROPIC_API_KEY` | Optional existing provider adapter. The free-beta text policy still allows only GPT-6.1 Sol standard mode. |

Video requires an approved daily limit of at least `1500000` and enough unused allowance, alongside the Google key, model access, and feature flag. The site-wide lifetime cap still applies. The environment variable provides an operator control; no value was changed in the deployment during this work. Image, music, web research, and Work execution also remain subject to the implemented beta billing policy. Non-beta media/search tariffs have not been approved.

Provider accounts may require billing and model access. Do not treat the application's reservation amounts as provider price quotes. The implementation follows the current official [OpenAI image API](https://developers.openai.com/api/docs/guides/image-generation), [web search](https://developers.openai.com/api/docs/guides/tools-web-search), [Code Interpreter](https://developers.openai.com/api/docs/guides/tools-code-interpreter), [Gemini Omni](https://aistudio.google.com/docs/omni), and [Lyria](https://aistudio.google.com/docs/music-generation) contracts. Model availability must be rechecked before a future model change.

### Google Drive

Create a Google Cloud project with Google Picker and Drive APIs enabled, configure the OAuth consent audience, and create a **Web application** OAuth client. Set:

- `GOOGLE_DRIVE_CLIENT_ID`: the browser OAuth client ID.
- `GOOGLE_DRIVE_PICKER_KEY`: an API key restricted to the required APIs and browser referrers.
- `GOOGLE_DRIVE_APP_ID`: the numeric Cloud **project number**, not its project-name string.

Authorize the exact deployed JavaScript origins, including preview origins only when those previews need OAuth. For Picker website restrictions include the application origins and `https://docs.google.com/*`, as required by Google's current [Picker setup guide](https://developers.google.com/workspace/drive/picker/guides/web-picker). These identifiers are public browser configuration, not a server OAuth client secret.

The UI loads Google scripts only after Drive is opened. It requests `drive.file` access and keeps the returned token in memory for this dialog. The token is sent directly to Google, never to Prism's API or persistent browser storage. The selected document content is uploaded to Prism only after a successful download/export. See Google's [token model](https://developers.google.com/identity/oauth2/web/guides/use-token-model).

Supported Google Docs/Slides export to text; Sheets export the first sheet as CSV. Other allowed inputs are UTF-8 text/source files. Download restrictions are respected, and the exported file must fit the 128KB upload limit. These bounds follow the implementation and the [Drive download/export](https://developers.google.com/workspace/drive/api/guides/manage-downloads) and [export-format](https://developers.google.com/workspace/drive/api/guides/ref-export-formats) contracts. PDF parsing, folder import, full-drive indexing, and synchronization are not implemented.

### Remote browser

Set the server secret `BROWSERLESS_API_TOKEN`. Optional `BROWSERLESS_ENDPOINT` accepts only an official HTTPS shared endpoint on `production-sfo.browserless.io`, `production-lon.browserless.io`, or `production-ams.browserless.io`, at the root or `/function`. The default is `https://production-sfo.browserless.io/function`; custom hosts and embedded credentials are rejected.

The server sends a fixed capture program to the [Browserless Function API](https://docs.browserless.io/rest-apis/function), with the requested URL as data. It rejects local/IP/credential-bearing destinations, blocks unsupported methods, closes popups, bounds output, and uses the managed provider's network protections. The isolated browser closes after the request. Prism retains only the capture's URL, title, body, links, screenshot, and timestamp.

Connection URLs and plan access are described in the [official endpoint guide](https://docs.browserless.io/overview/connection-urls). Browserless has its own account, access, and usage charges. It is not supplied by the OpenAI key. Deleting browser data deletes the owner's saved Prism captures; it does not clear the user's local browser history.

### Scheduled runner

Set a cryptographically generated `SCHEDULE_RUNNER_SECRET` of at least 32 characters and `SCHEDULE_RUNNER_ENABLED=true`. Configure an external scheduler to send `POST /api/tasks/run-due` with that secret as a Bearer credential. Store the credential in that scheduler's secret facility; never put it in a URL, browser code, or logs.

The endpoint executes at most three due tasks sequentially per invocation through the same authenticated-owner chat pipeline and allowance checks. Frequency controls scheduling delay; provision the caller with a timeout suitable for real model responses. There is no scheduler resource or recurring trigger automatically provisioned by this repository. Without it, drafts and manual Run now remain available, while enabling automatic execution is rejected. No email or push notification service is configured; results appear as saved conversations.

## Limits and accounting

The source of truth is [beta.ts](../lib/beta.ts), [media-workspace.ts](../lib/media-workspace.ts), [browser-workspace.ts](../lib/browser-workspace.ts), and [scheduled-tasks.ts](../lib/scheduled-tasks.ts).

| Area | Current application bound |
| --- | --- |
| Shared beta text/media allowance | 20 requests/user/UTC day; two pending requests/user; default USD 0.20/user/day; USD 8 across the site's entire beta lifetime. |
| Text | 1,024 output tokens; 16,000 UTF-8 bytes of supplied conversation/context; the server also reserves instruction/token overhead. |
| Web/Work tools | At most two tool calls per response; separate conservative tool reservations. Code Interpreter uses an isolated 1GB container with network disabled. |
| Media | USD 0.15/image, USD 0.20/music, USD 1.50/video reservation; prompts up to 2,000 characters. The cap is checked before provider access. |
| Reference/generated media | References: PNG/JPEG/WebP up to 4MiB, at most 20 saved references/user. Generated media responses are bounded to 16MiB. |
| Text/Drive/notebook files | 128KiB/file, 100 stored files/user, at most three attachments per chat request. Notebook source content counts toward its total saved size. |
| Work files | At most three generated files saved per response, each up to 5MiB, with owner-authenticated download routes. |
| Browser | Five visits/user/day, 50/site/day, one in-flight request/user, 100 saved captures/user; provider fetch timeout 35 seconds. |
| Tasks | 30 saved tasks/user, prompt up to 8,000 characters, five-minute execution lease, at most three due tasks per runner call. |

Text success settles against reported usage and measured tool events. Media keeps its conservative reservation pending reconciliation. Started but uncertain/failed provider requests can retain reservations; a pre-provider preparation failure does not invent billable success. Browser visits have separate count limits. Deleting chats or files does not reset usage. Payment launch, subscriptions, and wider budgets remain separate approvals/configurations.

## Routes and data

New authenticated APIs are `/api/media`, `/api/media/reference`, `/api/media/:id[/content|/refresh]`, `/api/browser/sessions[/id]`, `/api/integrations/drive`, `/api/tasks[/id]`, `/api/tasks/:id/run`, and `/api/artifacts/:id`. The runner is the separately credentialed `POST /api/tasks/run-due`.

Media bodies and generated files live in private R2; their ownership metadata lives in D1. Browser capture content lives in D1. Documents and notebook bodies use the existing private file store. Account deletion removes the workspace records/objects, including tasks, browser captures, media, and generated files, while usage/accounting records remain. Public share snapshots do not grant permission to private artifact/media endpoints.

The readiness probe checks access to usage and the four new tables plus the presence of the OpenAI key. It does not verify live provider access or every column in the schema. Verify migrations and each required integration independently before release.

## Verification and release boundary

Completed during implementation: targeted TypeScript checks, a Drizzle-metadata comparison against SQLite-applied migrations for all four new tables (columns, primary keys/nullability, defaults, checks, and indexes), and automated suites against isolated SQLite/storage with mocked external transports. The browser helper's five tests cover configuration rejection before provider access, URL/endpoint validation, owned captures/deletion, quota enforcement, and failure cleanup. Other suites cover chat/tool contracts, media persistence/downloads, ownership, task scheduling/leases, and accounting. Test fixtures are not production fallback responses.

Before publication, TypeScript checking and all 89 automated tests passed (54 integrated API tests, 15 provider tests, 15 scheduling tests, and 5 browser-service tests). The final provider accounting fallback also passed its 15-test focused suite. In desktop Chrome, the managed preview verified 36 px / 48 px headings, 17 px / 24 px initial prompt sizing, hidden Work model controls, Canvas mode controls, and Korean signed-out errors with the draft retained. Real application frames at 320, 360, and 390 CSS pixels showed no horizontal overflow across Chat, Tasks, Notebook, Customize, Browser settings, Images, and Video. The 320 px drawer and tool menu remained inside their viewport.

Hosted publication and the production build are recorded by the release workflow separately. These checks do not claim live paid-provider success, Google OAuth/Picker completion, real Browserless capture, or deployed recurring-runner execution. Existing keys alone do not prove model access. The frame harness verifies responsive CSS layout, not physical mobile touch, on-screen keyboards, or mobile browser engines.

Run the following from the repository, using Node.js 22.13+ and the pinned pnpm version:

```sh
pnpm install --frozen-lockfile
node node_modules/typescript/bin/tsc --noEmit
node --test tests/integration.mjs
node --test tests/provider-features.mjs
node --test tests/scheduled-tasks.test.mjs
node --test tests/browser-workspace.mjs
git diff --check
pnpm build
```

Execute these suites sequentially because some compile overlapping fixtures. A successful test result proves the exercised local behavior, not access to an external account. Use `pnpm dev` for a portable checkout or the managed `sites-preview start <absolute-checkout>` command and its returned URL. Apply the repository migrations through the existing Sites deployment workflow, then publish the exact reviewed source commit. Do not infer that documenting these commands applied migrations or published a release.

For acceptance, verify the signed-in Chat/research/Work/Canvas flows, image creation/editing and downloads, task manual execution and an actual external runner tick, Drive consent/selection, and Browserless capture/deletion with real configured accounts. Check 320/360/390px layouts and actual mobile keyboard/touch behavior independently. Leave an integration marked unverified when the needed account, credentials, allowance, or device is unavailable.
