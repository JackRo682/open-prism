# Toss Payments: upgrade flow and activation

**November 9 update:** only Gemini 3.5 Flash-Lite remains free. Premium text always requires a live wallet, even with `BETA_MODE=true`. Checkout activation gates remain separate. See [current access policy](model-access-2026-11-09.md).

Implementation date: November 7, 2026. This change prepares GetOpenPrism for one-time prepaid credit sales. It does not register a merchant, enable live charging, establish provider model access, or choose commercial policies for the operator.

## What visitors can do before registration

Open `/upgrade` directly, or use **Settings → 업그레이드** in the signed-in workspace. The settings entry is a normal link with `target="_blank"` and `rel="noopener noreferrer"`; it preserves the chat tab. The new page uses a separate white layout without the workspace sidebar or composer.

The page reads the canonical catalog from `GET /api/upgrade`. Its landing card opens a plan dialog; choosing a product opens a second terms dialog over the plan dialog. Cancel returns to the selected plan. Closing the plan dialog restores focus to the landing action. Narrow layouts keep 16 px outer clearance and scroll within the available viewport.

The merchant UI follows the saved Gemini desktop and 390 × 844 responsive references. It uses GetOpenPrism's branding and existing KRW 10,000 / 30,000 / 50,000 prepaid products. These are not recurring subscriptions, storage plans, or promises of consumer Gemini/ChatGPT features. Exact Google fonts, motion timing, mobile settings behavior, and payment screens beyond the captured terms dialog were not evidenced by those references.

When credentials are absent, visitors can inspect the products and terms. The checkout state explains that payments are being prepared. It does not load a fake provider, pretend a payment succeeded, create spendable credit, or require card details.

## Routes

| Route | Purpose |
| --- | --- |
| `/upgrade` | Public catalog; account state is personalized only after sign-in. |
| `/upgrade/success` | Server approval, owned-order recovery, final verified balance. |
| `/upgrade/fail` | Cancellation/failure guidance and an owned-order status check. |
| `/billing` | Account-owned balance, payment history, refund status, usage ledger, and purchase policies. Visible during beta too. |
| `/billing/success`, `/billing/fail` | Legacy redirects preserving only bounded, allowlisted callback fields. |
| `/admin` | Existing administrator page, launch settings, recent payment list, and partial/full refund form. Requires the existing administrator identity. |

## Server API

All JSON responses are uncached. Purchase and account routes require the site's existing ChatGPT sign-in. Mutations reject another browser origin. The browser does not choose the payable amount, credit amount, account ID, payment mode, or approval result.

| API | Contract |
| --- | --- |
| `GET /api/upgrade` | Product catalog, displayed policy version/hash, sale availability, public seller information, and the signed-in user's balances when present. No secret or payment key. |
| `GET /api/billing` | The signed-in user's payment and ledger records. |
| `POST /api/payments/orders` | `{productId, requestId, consent:{accepted:true, version, policyHash}}`. The server selects the catalog amount and persists the purchase snapshot. Reusing the same valid request identifies the same order. |
| `POST /api/payments/confirm` | `{orderId, paymentKey, amount}`. Ownership and the stored amount are checked before provider confirmation. |
| `GET /api/payments/orders/:orderId` | Owned order status without returning its provider payment key. |
| `POST /api/payments/reconcile` | `{orderId}`. Recover and recheck an owned order against the provider; never infer success from the callback URL. |
| `POST /api/payments/webhook` | Provider notifications initiate a bounded server-side state lookup. Notification amount/status are not trusted for crediting. A configured webhook security key also requires raw-body HMAC verification. |
| `GET /api/admin/payments` | Recent 100 orders and refund operations with non-secret operational fields; administrator only. |
| `POST /api/admin/payments/cancel` | `{orderId, amount, reason, requestId}`; administrator only. Persists cancellation progress and reconciles credit removal. Retry an uncertain operation with its original request ID. |

## Credentials and operating modes

Configure these values in the existing site's server runtime. Do not put secret values into React code, source control, public environment variables, or screenshots.

| Setting | Purpose |
| --- | --- |
| `PAYMENTS_MODE=disabled` | Default preparation state. The catalog remains usable, while new orders are blocked. |
| `PAYMENTS_MODE=test` | Allows Toss test checkout only with a matching pair of test keys. |
| `TOSS_CLIENT_KEY` | Public client identifier, supplied to the checkout only after creating an owned order. |
| `TOSS_SECRET_KEY` | Server-only key for provider lookup, confirmation and cancellation. |
| `TOSS_WEBHOOK_SECURITY_KEY` | Optional merchant-issued hexadecimal webhook security key. When configured, valid signed deliveries are required. This is distinct from the API secret key. |
| `BETA_MODE=true` | Keeps the existing free-beta inference policy. Test payments can be exercised separately; live purchases must stay disabled while beta is active. |
| `LAUNCH_APPROVED=false` | Keeps live checkout closed even if live keys are present. |
| `ADMIN_USER_ID` | The exact site-scoped administrator user ID. Email addresses are not substituted for this ID. |

Preferred integration: `test_gck_…` + `test_gsk_…` for the order-page widget. The client uses `widgets()`, `setAmount()`, `renderPaymentMethods()`, `renderAgreement()`, then `requestPayment()`. The matching `live_gck_…` + `live_gsk_…` pair is for approved live operation.

Compatibility integration: `test_ck_…` + `test_sk_…` for the existing individual card payment-window API. Its matching live pair is `live_ck_…` + `live_sk_…`. Do not mix environments or key families. Prefix checks detect those mismatches; only a real provider round trip can verify that keys actually belong to the same merchant.

The provider UI is loaded from the official SDK only when a real order can proceed. Card/app authentication remains controlled by Toss and the payment provider. Callback URLs use this application's own origin. The supported redirect flow is used for mobile; the application does not embed the authentication flow in a custom iframe.

## Records, recovery and refunds

The existing `payments`, `wallet_events`, `billing_config`, and account-flag storage are retained. The additive migration `0006_upgrade_billing.sql` adds purchase/consent snapshots and cancellation tracking. Inspect its generated schema and journal alongside `db/schema.ts`.

Server-approved payments create one ledger credit with a unique order reference. Replayed redirects, webhook delivery, and manual status refresh must not issue another credit. Money values use integer KRW; wallet arithmetic retains the existing micro-KRW unit (`1 KRW = 1,000,000 ledger units`). Test ledger entries cannot fund live inference.

Browser notifications carry only a balance-invalidation signal. The chat and billing pages use `BroadcastChannel`, storage events, and focus/visibility refresh to fetch the current server balance. The receiving tab does not accept a balance from another tab's message.

A failed browser return is not treated as a failed charge. Recovery checks the owned order and provider state. If sign-in expires before the server receives the callback, the validated callback values are retained in the same tab’s sessionStorage for at most ten minutes. The sign-in return URL contains only the order ID; the callback is restored and verified after sign-in. This matters because widget (`gsk`) keys cannot call Toss’s order-ID lookup endpoint. Once the server has a known payment key it can recover directly. If the tab storage is unavailable, keep the original callback tab open during sign-in. No API secret or payment key is placed in the authentication return URL.

Partial/full refunds reconcile the provider's total cancellation state with the ledger. An uncertain provider outcome stays recoverable instead of creating a second cancellation. The administrator's refund history retains the original request ID and payload so that a pending operation can be checked again after a refresh. A pending or failed refund is not displayed as completed. External refunds that leave the wallet underfunded prevent further spending pending reconciliation. A provider-reported deposit reversal also blocks live spending while the order is reviewed. The administrator must confirm the specific order, amount, and reason before a new cancellation request is submitted.

## Activation sequence

1. Create the merchant/developer account and select the intended Toss integration. Obtain the merchant's test client and secret keys as a matching pair.
2. Configure the test keys and `PAYMENTS_MODE=test`. Keep `BETA_MODE=true` and live approval off. Ensure the desired widget/payment methods are enabled in that merchant's Toss settings.
3. Register the webhook endpoint `https://getopenprism.com/api/payments/webhook` for the payment events supported by this implementation. Use test and live merchant settings deliberately; they are separate environments.
4. Run a merchant test payment and verify the provider dashboard, order record, isolated test ledger, callback retry, and refund. Exercise a lost return by revisiting the same owned order. Test on physical iPhone Safari and Android Chrome, including payment-app return.
5. Finalize the actual model deduction rates, refund policy, credit validity, business registration/address and support contact in the existing administrator configuration. The code does not infer these commercial decisions.
6. Confirm the actual provider account can serve the models sold by the product. Paid text inference already reserves and settles the live wallet. A consumer AI subscription does not grant API access. Media, tools and Pro settings keep their existing separate capability and pricing restrictions.
7. After merchant approval and successful end-to-end verification, configure the matching live key pair, disable free beta for the paid service, and explicitly approve live launch. Do not switch operating modes solely to make a UI button active.

Stopping new sales does not erase already purchased credits or refund records. Recovery should remain possible with the matching server secret for an existing order. A single configured key pair can service its own mode; keep access to the corresponding merchant environment when resolving historical test/live orders.

Toss scopes idempotency to the API key as well as the endpoint and method. Each refund therefore stores a one-way fingerprint of the original server key within its private idempotency identifier. Changing that key while a refund is unresolved moves the operation to manual review and retains its reservation; it does not issue another cancellation with the new credential. A provider response that says the original request is still processing likewise retains the hold and original request.

## Verification boundaries

Local tests use isolated SQLite ledgers and controlled provider responses. They exercise order/consent validation, amount tampering, ownership, idempotency, test/live isolation, provider errors, recovery and cancellations without charging a person. They do not prove merchant approval, working credentials, actual bank/card authorization, provider model access, or physical-device payment-app behavior.

Browser QA exercised the actual local application at desktop width and in a measured 390 × 844 CSS-pixel iframe viewport. The iframe was a temporary layout test harness, removed before release; payment authentication is never embedded by the production application. Checks covered plan/terms stacking, mobile scrolling and margins, cancellation/Escape/focus return, the preparation screen, Settings opening a separate upgrade tab, billing history, and rejection of an invalid success callback. This does not emulate a phone's browser or payment-app transitions.

Release checks: 124 tests passed across `tests/integration.mjs`, `tests/billing.test.mjs`, `tests/upgrade-client.test.mjs`, `tests/guest-chat.test.mjs`, and `tests/chat-deletion.test.mjs`. All seven migrations applied successfully to a fresh local D1 database; the billing suite separately verifies an upgrade with existing rows. TypeScript and the production Worker build are release gates. The 28 payment-specific tests use controlled provider responses, not merchant sandbox credentials.

Use the repository's documented verification commands, then the existing Sites build/deploy workflow. Sites applies pending hosted D1 migrations before uploading the Worker. Local previews use their own database; do not treat a local migration as a production migration.

## Official integration references

Checked November 7, 2026:

- [SDK initialization and supported key types](https://docs.tosspayments.com/sdk/v2/js/environment)
- [API key pairs and test/live environments](https://docs.tosspayments.com/reference/using-api/api-keys)
- [Order-page widget integration](https://docs.tosspayments.com/guides/v2/payment-widget/integration)
- [Widget SDK reference](https://docs.tosspayments.com/sdk/v2/js/payment-widget)
- [Core payment lookup, approval and cancellation API](https://docs.tosspayments.com/reference)
- [API authorization and idempotency](https://docs.tosspayments.com/reference/using-api/authorization)
- [Webhook events and signature documentation](https://docs.tosspayments.com/reference/using-api/webhook-events)
- [Webhook registration and retries](https://docs.tosspayments.com/guides/v2/webhook)
