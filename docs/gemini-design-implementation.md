# Gemini-reference interface implementation

## Scope and platform

This change applies the two supplied Gemini screenshots to **Open Prism**, preserving its authentication, provider adapters, storage, quota enforcement, and model availability rules. Styling is an independent reproduction of the supplied references. Gemini's private backend and application source are not used.

| Project | Configuration evidence | Runtime |
| --- | --- | --- |
| `JackRo682/open-prism` | `.openai/hosting.json`, `vite.config.ts`, `app/chatgpt-auth.ts`, `lib/provider.ts` | ChatGPT Sites; Cloudflare Workers; D1 `DB`; R2 `BUCKET`; Sign in with ChatGPT. Sites project: `appgprj_6ad1c380cba88191a9a68b9138409d20`. |
| `JackRo682/SignalBrief` | `apps/web/vercel.json`, `apps/web/package.json`, `apps/web/src/lib/supabase.ts`, `supabase/hosted/README.md` in that separate repository | Vercel and Supabase. No changes to that project are included here. |

GitHub discovery found nine accessible repositories under `JackRo682`; `open-prism` contained this multi-model chat application. Its remote branch inventory contained `main` at inspection time. No Supabase or Vercel migration is required for this redesign.

## Visual reference

The attached home PNG is **1440 × 703**; the settings PNG is **1440 × 699**. The accompanying inspection notes describe a separate 1440 × 709 browser session.

| Element | Reference measurement or treatment |
| --- | --- |
| Sidebar | 288px wide; `#1f1f1f`; icon centers approximately x26, labels starting at x48, and 32px main-navigation row pitch. |
| Workspace | Starts at x288. Base `#0f0f0f` with a broad blue-violet glow reproduced with layered radial gradients. |
| Heading | Workspace center x864; approximately 36px regular type with 44px line height. Home glyph bounds approximately x687–1032, y238–271. |
| Composer | x534, y321, width660, height64 in the home PNG; y320 in the settings PNG. `#1e1f20`, radius32, no border. |
| Centering | `288 + (1152 - 660) / 2 = 534`; centered inside the workspace. |
| Composer layout | `36px minmax(0, 1fr) auto` grid, 12px padding, 17px/24px prompt typography. Longer model labels and extra controls use the available space. |
| Composer shadow | `0 2px 8px -2px rgb(0 0 0 / 16%)`; 100ms transition. |
| Chat/Work control | 14px below the composer; selected pill approximately 56 × 38px with `#343537` fill. |
| Settings menu | x244, y0, width240, height664 in the settings PNG; radius20, padding8, `#1f1f1f`. |
| Menu rows | 224 × 36px, 14px/20px text. Fifteen rows plus three 36px headings and 16px outer padding produce the 664px natural height. |
| Menu effects | `0 0 20px rgb(0 0 0 / 28%)`; 120ms entrance with `cubic-bezier(0, 0, .2, 1)`; 8px submenu overlap. |

Original animation keyframes and a mobile reference were not supplied. The opacity/scale entrance, reduced-motion behavior, collapsed sidebar, and mobile drawer are implementation choices. Menus use collision handling and internal scrolling rather than fixed screenshot coordinates. Typography uses local fallbacks and does not bundle proprietary Google font files.

## Source organization

| Source | Responsibility |
| --- | --- |
| `app/workspace.tsx` | Shared navigation, route composition, chat state, streaming lifecycle, uploads, notebooks, and sharing. |
| `app/reference-shell.css` | Reference layout, colors, glow, composer, navigation, and responsive shell. |
| `app/workspace-details.css` | Supporting pages, tool/model menus, dialogs, and printing. |
| `components/workspace/composer.tsx` | Autosizing prompt, Korean IME-safe submission, model/reasoning selection, attachments, speech recognition, stop/send, and `@` skills. |
| `components/workspace/chrome.tsx` | Prism mark, browser print/install actions, and Markdown notebook creation. |
| `components/workspace/settings-menu.tsx` | Radix settings menu with Theme, Help, and Location submenus. |
| `components/workspace/theme.tsx` | Theme persistence, system changes, and cross-tab updates. |
| `components/workspace/chat-search.tsx` | Debounced search, cancellation, keyboard navigation, and focus restoration. |
| `components/workspace/settings-pages.tsx`, `settings.css` | Settings forms, skills, memory import, sharing, feedback, capability states, and portal styling. |
| `lib/workspace-settings.ts` | Bounded validation, atomic patches, request-time context, and attachment omission in public snapshots. |
| `app/api/[...path]/route.ts` | Existing API plus settings, search, and public shares. |
| `drizzle/0003_workspace_settings_and_shares.sql` | `workspace_settings`, `public_shares`, indexes, and the conversation relationship. |

## Routes and actual behavior

| Route or action | Behavior |
| --- | --- |
| `/`, `/chat`, `/chat/:id` | Welcome or saved conversation; provider requests follow existing server policy. |
| `/library`, `/history` | Existing saved-conversation library. |
| `/models`, `/compare` | Existing catalog/comparison; beta restricts models and disables comparison. |
| `/files`, new notebook | Private text files; a notebook is a real Markdown file saved through `/api/files`. |
| Search / Ctrl+K / Cmd+K | Searches the owner's titles and message text through `/api/search`. |
| `/personalization-settings` | Saves personalization consent, instructions, and editable memory. |
| `/customize/skills` | Creates, edits, and deletes saved instructions; `@` selects a skill for a request. |
| `/gems/view` | Directs users to saved skills. |
| `/gemini-spark` | Persists plan-first or results-first Work preferences, applied to provider context. |
| `/browser-settings` | Shows the current browser and unconnected remote-browser capability. |
| `/import` | Copies a memory-export prompt, previews pasted text, and replaces memory after confirmation. Chat archive import is unavailable. |
| `/sharing`, `/share/:token` | Owner-managed public snapshots and their public reader. |
| `/usage`, `/billing`, `/settings` | Existing actual usage, account, provider, and beta/billing information. |
| `/feedback` | Prefills a GitHub issue for user review and submission. |
| `/images`, `/videos`, `/scheduled` | Explicit unavailable states; no media provider or scheduler is connected. |
| Microphone | Browser speech recognition when supported; requires the microphone action and browser permission. |
| Save as PDF | Browser printing; the user chooses a PDF destination. |
| App install | Available browser install prompt or installation guidance. |

Google Drive OAuth, remote browser automation, remote code execution, image/video generation, background delivery, and scheduling have no active integrations. Work mode supplies response instructions and does not execute external tasks. The Location submenu can request device coordinates for display; it does not transmit them to an AI provider.

## Backend contracts

Private endpoints use the authenticated Sites application user ID. Existing mutation-origin checks remain in place.

| Endpoint | Contract |
| --- | --- |
| `GET /api/settings` | Owner's flat settings object or defaults. |
| `PATCH /api/settings` | Validates known bounded fields and atomically patches changed fields in D1. Its separate 600 KB request budget accommodates the maximum settings payload. |
| `GET /api/search?q=...` | `{ results }`; title/body search with escaped SQL wildcards and owner scope. At most 50 results, queries up to 200 characters; blank queries return no results. |
| `GET /api/shares` | `{ shares }` for the owner. |
| `POST /api/shares` | `{ conversationId }` creates an owner-checked snapshot; returns `{ id, token, url }`. |
| `DELETE /api/shares/:id` | Owner-checked revocation. |
| `GET /api/public-shares/:token` | Public `{ title, created_at, messages }`; invalid/revoked tokens return 404. |
| `POST /api/chat` | Existing fields plus `workspaceMode: 'chat'` or `'work'` and optional `skillId`. Resolves current settings and the owned skill on every request. |

Settings fields: `personalizationEnabled` (default false), `customInstructions` (up to 4,000 characters), `memory` (up to 8,000), `workResponseStyle` (`plan-first` or `direct`), and `skills` (up to 20; each name up to 60 characters and instructions up to 4,000).

Personalization includes memory/instructions only while enabled. An explicitly selected skill applies independently. Preferences are added to the provider request without insertion into stored user messages. Plan-first and results-first Work choices both affect provider context and grant no external-action permissions.

Public tokens contain 32 cryptographically random bytes encoded as 64 hexadecimal characters. Snapshots are limited to 1 MB and 100 links per owner, including concurrent creation. Attached-document suffixes are omitted; ordinary conversation text, including any quotes in responses, remains visible. Revocation is checked on each read with `no-store` responses.

## Configuration, migration, and verification

The [README](../README.md#runtime-configuration) lists required existing bindings and variables. This UI adds no provider secret or OAuth client. Provider accounts still need model access and quota. Keep `PAYMENTS_MODE=disabled` for the free beta; this change enables no subscription or paid checkout.

Apply all D1 migrations, including `0003_workspace_settings_and_shares.sql`, before using the new endpoints. Preserve the existing Sites project ID and `DB`/`BUCKET` bindings.

```sh
pnpm install --frozen-lockfile
node node_modules/typescript/bin/tsc --noEmit
node --test tests/integration.mjs
pnpm build
```

The **36 integration tests** use isolated SQLite and mocked provider transports. New coverage includes bounded owner-isolated settings, fresh preference/skill application, message-text search and wildcard escaping, public-snapshot ownership/redaction/revocation, the settings-only body-size budget, and concurrent public-link limits. Existing authentication, streaming persistence, uploads, quotas, and accounting checks are retained.

Use `pnpm dev` in a portable checkout. In managed Sites, use `sites-preview start <absolute-checkout>` and its exact returned URL. Build/package hosted releases through the Sites workflow from the pushed source commit. Live provider access and visual/interaction behavior require separate acceptance checks; automated transport tests use no live API credentials.
