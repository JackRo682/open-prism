# Guest chat and authenticated workspace

## Purpose

The public root now follows the supplied November 5 Gemini signed-out reference while retaining Prism branding, its actual configured provider, and its existing ChatGPT authentication. The original workspace is rendered only for authenticated visitors. The reference is a visual and interaction specification; its Google model names and account chooser do not establish Prism's provider access or identity integration.

## Routes

| Route | Anonymous visitor | Signed-in visitor |
| --- | --- | --- |
| `/`, `/chat` | Guest home or current tab's guest conversation | Existing workspace |
| `/chat/:id`, `/history`, `/files`, settings and other workspace routes | Real sign-in with a same-origin return path | Existing workspace; API ownership checks remain |
| `/privacy`, `/terms`, `/faq` | Public information without the workspace shell | Existing information pages |
| `/about` | Public introduction | Existing workspace routing |
| `/help`, `/docs` | Public help | Existing routing |
| `/share/:token` | Public snapshot, if valid and not revoked | Existing workspace's shared-conversation view |
| `/signin-with-chatgpt`, `/callback`, `/signout-with-chatgpt` | Managed by Sites | Managed by Sites |

Identity-dependent pages are force-dynamic. The server resolves identity before rendering either shell. Client visibility is not the authorization boundary: all existing owner-scoped APIs still enforce account identity and object ownership.

## Reference behavior implemented

- Dedicated desktop empty layout with centered greeting/composer and a blue radial glow; transcript layout removes the glow and keeps the composer docked.
- Mobile layout at 390 × 844 and other narrow widths moves the model picker to the header, uses a modal sidebar drawer and docks the composer above the safe area.
- Input and user-message text use the measured 17px font / 24px line height. Other geometric values are visual adaptations, not claims of measured Gemini source code.
- User turns appear immediately. A real provider stream drives submitting, streaming, completed, stopped and error states.
- Enter sends; Shift+Enter inserts a newline; IME composition is guarded. Rapid submissions are guarded client-side and duplicate request IDs are enforced server-side.
- New Chat is unavailable while empty or generating. Clearing an existing guest conversation requires confirmation.
- Response retry/copy/help, prompt copy/edit, tools and model menus, theme choices, sign-in reminders and installation guidance have actual handlers.
- The guest header has no PDF-export control. The signed-in workspace retains its prior controls.

## Guest API

`GET /api/guest/bootstrap` establishes a signed `__Host-prism-guest` HttpOnly, Secure, SameSite=Lax cookie. It returns real service availability, the guest model, remaining allowance and input limits. The cookie is bound to the request origin and expires after seven days.

`POST /api/guest/chat` accepts only:

```json
{
  "requestId": "a-client-generated-v4-uuid",
  "prompt": "The current user question",
  "history": [
    { "role": "user", "content": "Earlier question" },
    { "role": "assistant", "content": "Earlier response" }
  ]
}
```

The server fixes `gpt-6.1-sol`, low reasoning effort, no Pro mode and no external tools. It rejects model overrides, arbitrary roles, files, system messages, account IDs and other extra fields. Browser mutations require a same-origin Origin header. Requests stream `start`, `delta`, `done` or `error` events. Disconnect/Stop cancels the provider request; a timeout bounds processing. Duplicate IDs cannot start a second inference.

Input limits: 4,000 UTF-8 bytes per prompt, 12,000 total supplied content bytes, at most eight preceding turns, 80,000 bytes for the JSON body, and 1,024 output tokens. History must alternate user and assistant turns. The client trims older complete pairs to fit the public history limits.

## Durable limits and operational boundaries

The existing D1 `usage` ledger enforces all guest reservations in a single conditional SQL statement:

- 5 requests per browser session per UTC day.
- 20 requests per network bucket per UTC day, including fresh cookies.
- 100 guest requests per site per UTC day.
- 1 active request per guest session, 2 per network, 4 guest requests across the site.
- A conservative guest daily reservation ceiling and the existing shared lifetime beta ceiling. No existing lifetime allowance is raised.

Network identifiers are HMAC hashes; raw addresses are not stored. IPv6 privacy addresses share a /64 bucket. Only the edge `CF-Connecting-IP` header is used; arbitrary `X-Forwarded-For` is ignored. If the edge address is unavailable, affected requests share a conservative fallback bucket. A proxy that collapses addresses can therefore limit multiple visitors together. Cloudflare's [header documentation](https://developers.cloudflare.com/fundamentals/reference/http-headers/#cf-connecting-ip-in-worker-subrequests) explains why Worker subrequests may share or alter that edge value; the site-wide allowance remains enforced independently.

Daily quotas reset at UTC midnight (09:00 Asia/Seoul). The shared lifetime ceiling does not reset daily. Failures and cancellations retain their conservative reservation because provider usage may have occurred. Quota cookies and request IDs are not account authentication and cannot grant access to stored data. Guest ledger records store request/usage metadata, not conversation contents.

`OPENAI_API_KEY` and existing D1 are sufficient for the guest path; no additional provider account, OAuth client or secret is introduced. `GUEST_CHAT_ENABLED=false` disables anonymous inference. The code does not enable new model entitlements or customer payment features.

## Sign-in and transcript handoff

Every guest Sign in link performs a normal top-level navigation to Sites' existing `chatGPTSignInPath('/chat')`. Sites remains responsible for OAuth state, callback validation and account sessions. Prism does not imitate Google's password/MFA pages or add a second authentication stack.

Guest state is bounded, versioned tab-local sessionStorage with a one-hour restoration window. A cancelled login can return to that state. The current unsent prompt also uses the existing `prism-signin-draft` handoff.

After sign-in, an explicit choice offers to save a completed guest transcript or discard it. `POST /api/conversations/import-guest` requires identity and same-origin mutation checks, validates alternating text-only turns, caps message/total size and applies an import rate limit. Imported conversations are owner-scoped and the transaction is idempotent for each account/session pair. No new provider request is made when importing. Only the visitor's explicit Save action creates account history.

## Verification boundaries

The integration suites use isolated SQLite/storage and mocked external provider transports. They test server ownership, quotas, duplicate dispatch, cancellation, failure handling and import behavior without using live provider credentials. Browser testing and a real production guest response are recorded separately in the release handoff. A successful build or availability flag alone is not proof of live model access, successful OAuth callback or real-device keyboard behavior.
