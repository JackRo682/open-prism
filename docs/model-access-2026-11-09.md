# Model access, prepaid usage and welcome motion

## Access policy

New text requests use exactly five models. Gemini 3.5 Flash-Lite
(`gemini-3.5-flash-lite`) is the default, both before and after sign-in. It
uses Google's Interactions API with minimal thinking by default. Guests cannot
select a different model through request parameters. Signed-in free requests
use the existing bounded owner-funded allowance and never debit purchased credit.

GPT-6.1 Sol, GPT-6 Astra, Claude Fable 5.1 and Gemini 4 Argon require sign-in and
positive **live** wallet credit. The server then atomically reserves the maximum
request charge; a merely positive but insufficient balance still rejects before
provider access. `BETA_MODE` no longer bypasses paid-model access. Test payment
credits cannot fund production generation. Retired model metadata is retained
for old conversations, but cannot start new requests.

Guest transcript import preserves the model on each old/new answer, uses Sol
only for legacy transcripts without recorded provenance, and selects Flash-Lite
for subsequent messages. Starting a new conversation with no paid credit also
returns to Flash-Lite. Model menus label free/paid choices and paid locks.

## Existing payment accounting and this release

Toss-confirmed purchases already create durable, idempotent wallet credits in
D1. Products remain KRW 10,000 / 30,000 / 50,000 one-off top-ups. Values use integer
micro-KRW; there is no invented fixed number of messages per purchase.

For paid generation, input/output token counts and the operator's model tariff
determine the final debit. The reservation is settled and unused credit returned.
Duplicate callbacks, repeated generation request IDs and concurrent requests do
not duplicate credit or overspend a wallet. Test/live ledgers and user ownership
remain separate. A started request without verified usage retains its hold for
reconciliation; it is not falsely shown as free or automatically refunded.

The account menu now shows the server-confirmed balance even during beta. Chat
completion invalidates balance views across tabs, while all balance values are
refetched from the server. Browser messages never set a balance directly.

Free guest cost accounting uses the verified Flash-Lite provider rate of USD
0.30 input / 2.50 output per million tokens, rounded up to whole micro-USD.
Reasoning tokens are included by the provider adapter. These owner-cost values
are separate from the operator's customer tariffs. Existing request limits and
the site-wide USD 8 lifetime beta budget were not increased or reset.

## Runtime requirements and observed blockers

- Google: `GEMINI_API_KEY`; currently present in production. A key's presence
  alone does not prove a particular model request succeeds.
- OpenAI: `OPENAI_API_KEY`; currently present in production. Sol and Astra use
  the Responses API and require provider account access.
- Anthropic: `ANTHROPIC_API_KEY`; absent during this release inspection. Claude
  is represented in the selector and access policy, but cannot produce replies
  until the server secret and provider account are connected.
- Payments: matching `TOSS_CLIENT_KEY` / `TOSS_SECRET_KEY`, payment operating
  mode, approved live launch, customer model tariffs, refund and validity
  policies, registration number, business address and support email. No Toss
  keys were present; `/api/upgrade` reported `mode: disabled` and
  `checkoutAvailable: false`, with empty policies and seller fields.
- Toss webhook: the existing endpoint is `/api/payments/webhook`; provider
  notifications are revalidated server-side. Register it with the merchant;
  configure the merchant-issued signature key when applicable.
- Paid external tools: web research and code-interpreter generation remain
  unavailable until their paid charge tariffs are implemented/configured. The
  provider adapters and authenticated artifact storage/download code remain.
  Supplied-document research and ordinary text/Canvas remain available.

This release does not create provider/merchant accounts, purchase subscriptions,
invent commercial prices or terms, or turn on live charges. Provider API usage
and hosting may cost the operator money even when visitors chat for free.

## Welcome design

The desktop entrance reconstructs the observed Gemini sequence while keeping
Prism branding. A broad blue/purple radial glow expands first (1.4 seconds);
the greeting starts at 280 ms and composer at 400 ms, with a 520 ms reveal.
Layout space is reserved. Existing guest history is restored before selecting
the empty-state animation; subsequent renders and new chats do not replay it.
Reduced-motion preferences and mobile widths show content immediately, and
keyboard focus takes priority over decorative motion. The implementation uses
local CSS and React; it does not embed Gemini or require its assets.

## Verification

- 297 tests passed with `node --test --test-concurrency=1 tests/*.mjs`.
- TypeScript and the production Worker build passed.
- Browser preview verified the five choices, paid lock labels, desktop layout,
  320/360/390 CSS-pixel layouts, and active bloom/content animation names and
  delays. Preview has no production inference credentials.
- Billing tests use isolated SQLite and controlled provider/payment responses.
  They verify crediting, settlement, concurrency, replay, refunds, access control,
  paid access during beta, missing credentials, import and legacy provenance.
  They do not constitute a real bank/card payment or merchant approval.

Primary model references: https://ai.google.dev/gemini-api/docs/models/gemini-3.5-flash-lite
and https://ai.google.dev/gemini-api/docs/pricing .
