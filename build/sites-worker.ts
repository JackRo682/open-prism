import handler from "vinext/server/fetch-handler";
import { runWithConnectorBinding } from "../lib/connector-context";
import type { ConnectorBinding } from "../lib/connector-contract.mjs";
import { prepareSecureRequest, rejectUnsupportedPageMutation, secureResponse } from "../lib/http-security";
import { createApiAdmissionController } from "../lib/api-resource-guards";

const apiAdmission = createApiAdmissionController();

function cancelUnreadBody(request: Request) {
  // Never wait for an untrusted stream's cancel algorithm to settle. The live
  // body must be cancelled before Request construction transfers/locks it.
  void request.body?.cancel().catch(() => {});
}

export default {
  async fetch(request: Request, env: Cloudflare.Env, ctx: ExecutionContext<{ CONNECTORS?: ConnectorBinding }>) {
    const rejected = rejectUnsupportedPageMutation(request);
    if (rejected) {
      cancelUnreadBody(request);
      return secureResponse(request, rejected, '');
    }
    const release = apiAdmission.acquire(request);
    if (!release) {
      cancelUnreadBody(request);
      return secureResponse(request, Response.json({ error: 'The service is busy. Please retry shortly.', code: 'API_CAPACITY' }, {
        status: 503, headers: { 'Retry-After': '1' },
      }), '');
    }
    let forwarded = request;
    let policy = '';
    try {
      const secure = prepareSecureRequest(request, import.meta.env.DEV);
      forwarded = secure.request;
      policy = secure.policy;
      let binding = ctx.props?.CONNECTORS;
      // Local preview emulates the same request-scoped capability. This branch
      // and the auxiliary service binding are absent from production builds.
      if (import.meta.env.DEV && !binding && env.CONNECTORS) {
        const preview = env.CONNECTORS;
        const expiresAt = Date.now() + 60_000;
        binding = {
          async getContext() {
            if (Date.now() >= expiresAt) return { status: "request_context_expired" };
            return preview.getContext?.() ?? { status: "binding_unavailable" };
          },
          async invoke(connectorId, actionName, args) {
            if (Date.now() >= expiresAt) {
              return { status: "request_context_expired", message: "This request has expired. Please try again." };
            }
            return preview.invoke(connectorId, actionName, args);
          },
        };
      }
      const response = await runWithConnectorBinding(binding, () => handler.fetch(forwarded, env, ctx));
      return secureResponse(request, response, policy);
    } catch {
      cancelUnreadBody(forwarded);
      const requestId = crypto.randomUUID();
      console.error(JSON.stringify({ event: 'worker_request_failed', requestId, method: request.method }));
      return secureResponse(request, Response.json({ error: 'The request could not be completed. Please retry.', requestId }, {
        status: 500, headers: { 'X-Request-ID': requestId, 'Cache-Control': 'no-store' },
      }), policy);
    } finally { release(); }
  },
};
