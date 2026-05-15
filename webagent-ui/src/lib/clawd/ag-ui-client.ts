import { HttpAgent } from "@ag-ui/client";

import type { RequestAuth } from "./types";

export function agUiEndpointUrl(auth: RequestAuth): string {
  const params = new URLSearchParams();
  if (auth.userId) params.set("user_id", auth.userId);
  if (auth.tenantId) params.set("tenant_id", auth.tenantId);
  if (auth.apiKey) params.set("api_key", auth.apiKey);
  const query = params.toString();
  return `/v1/agent/ag-ui${query ? `?${query}` : ""}`;
}

export function createWebAgentHttpAgent(auth: RequestAuth): HttpAgent {
  return new HttpAgent({
    url: agUiEndpointUrl(auth),
  });
}
