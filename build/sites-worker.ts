import handler from "vinext/server/fetch-handler";
import { runWithConnectorBinding } from "../lib/connector-context";
import type { ConnectorBinding } from "../lib/connector-contract.mjs";
import { createApiAdmissionController } from "../lib/api-resource-guards";

const apiAdmission = createApiAdmissionController();
const errorHeaders = { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; sandbox" };

function cancelUnreadBody(request: Request) {
  void request.body?.cancel().catch(() => {});
}

export default {
  async fetch(request: Request, env: Cloudflare.Env, ctx: ExecutionContext<{ CONNECTORS?: ConnectorBinding }>) {
    const release = apiAdmission.acquire(request);
    if (!release) {
      cancelUnreadBody(request);
      return Response.json({ error: 'The service is busy. Please retry shortly.', code: 'API_CAPACITY' }, {
        status: 503, headers: { ...errorHeaders, 'Retry-After': '1' },
      });
    }
    try {
      let binding = ctx.props?.CONNECTORS;
      // Local preview emulates the same request-scoped capability. This branch and
      // the auxiliary service binding are absent from production builds.
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
      return await runWithConnectorBinding(binding, () => handler.fetch(request, env, ctx));
    } catch {
      cancelUnreadBody(request);
      const requestId = crypto.randomUUID();
      console.error(JSON.stringify({ event: 'worker_request_failed', requestId, method: request.method }));
      return Response.json({ error: 'The request could not be completed. Please retry.', requestId }, {
        status: 500, headers: { ...errorHeaders, 'X-Request-ID': requestId },
      });
    } finally { release(); }
  },
};
