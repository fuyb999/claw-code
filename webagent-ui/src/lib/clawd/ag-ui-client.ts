import { HttpAgent } from "@ag-ui/client";

import { apiBaseUrl } from "./api";
import type { RequestAuth } from "./types";

export function agUiEndpointUrl(auth: RequestAuth): string {
  const params = new URLSearchParams();
  if (auth.userId) params.set("user_id", auth.userId);
  if (auth.apiKey) params.set("api_key", auth.apiKey);
  const query = params.toString();
  return `${apiBaseUrl()}/v1/agent/ag-ui${query ? `?${query}` : ""}`;
}

export function createWebAgentHttpAgent(
  auth: RequestAuth,
  conversationId: string,
): HttpAgent {
  return new HttpAgent({
    threadId: conversationId,
    url: agUiEndpointUrl(auth),
  });
}
