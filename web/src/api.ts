import type {
  ApiKeySummary,
  AuthSession,
  ClawdConfig,
  CreateDataSourceRequest,
  CreateKnowledgeBaseRequest,
  CreateProjectRequest,
  CreatedApiKey,
  CreateThreadRequest,
  DataSourceDetail,
  DataSourceSummary,
  DiscoveredModelOption,
  KnowledgeBaseSummary,
  ModelListResponse,
  ProjectSummary,
  RequestAuth,
  SkillDetail,
  SkillSummary,
  ThreadCommand,
  TestDataSourceRequest,
  TestDataSourceResponse,
  ThreadSnapshot,
  ThreadSummary,
  UpdateDataSourceRequest,
  UpdateProjectRequest,
  UploadedDocumentSummary,
  UpsertSkillRequest,
} from "./types";

const API_BASE = import.meta.env.VITE_CLAWD_BASE_URL ?? "http://127.0.0.1:3210";

function requestHeaders(auth?: RequestAuth, headers?: HeadersInit): HeadersInit {
  const apiKey = auth?.apiKey?.trim();
  const userId = auth?.userId?.trim();
  return {
    "content-type": "application/json",
    ...(apiKey ? { authorization: `Bearer ${apiKey}` } : {}),
    ...(!apiKey && userId ? { "x-clawd-user-id": userId } : {}),
    ...(headers ?? {}),
  };
}

function threadPath(path: string, auth?: RequestAuth): string {
  const apiKey = auth?.apiKey?.trim();
  const userId = auth?.userId?.trim();
  if (!apiKey && !userId) {
    return path;
  }
  const separator = path.includes("?") ? "&" : "?";
  const query = new URLSearchParams();
  if (apiKey) {
    query.set("api_key", apiKey);
  } else if (userId) {
    query.set("user_id", userId);
  }
  return `${path}${separator}${query.toString()}`;
}

async function request<T>(path: string, init?: RequestInit, auth?: RequestAuth): Promise<T> {
  const response = await fetch(`${API_BASE}${path}`, {
    headers: requestHeaders(auth, init?.headers),
    ...init,
  });

  if (!response.ok) {
    const body = await response.text();
    if (body) {
      let message = body;
      try {
        const payload = JSON.parse(body) as { error?: string };
        if (payload.error) {
          message = payload.error;
        }
      } catch {
        // fall back to the raw body
      }
      throw new Error(message);
    }
    throw new Error(`Request failed: ${response.status}`);
  }

  if (response.status === 204) {
    return undefined as T;
  }

  return (await response.json()) as T;
}

export function apiBaseUrl(): string {
  return API_BASE;
}

function normalizeModelListUrl(baseUrl: string): string {
  const trimmed = baseUrl.trim();
  if (!trimmed) {
    throw new Error("缺少模型 API 地址。");
  }

  if (/\/models\/?$/i.test(trimmed)) {
    return trimmed.replace(/\/+$/, "");
  }

  return `${trimmed.replace(/\/+$/, "")}/models`;
}

export async function fetchProviderModels(baseUrl: string, apiKey: string): Promise<DiscoveredModelOption[]> {
  const response = await fetch(normalizeModelListUrl(baseUrl), {
    headers: {
      authorization: `Bearer ${apiKey.trim()}`,
    },
  });

  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || `模型列表获取失败: ${response.status}`);
  }

  const payload = (await response.json()) as ModelListResponse;
  const items = (payload.data ?? [])
    .map((item) => ({
      id: item.id?.trim() ?? "",
      label: item.id?.trim() ?? "",
      owner: item.owned_by?.trim() && item.owned_by?.trim() !== item.id?.trim()
        ? item.owned_by.trim()
        : null,
    }))
    .filter((item) => item.id)
    .sort((left, right) => left.label.localeCompare(right.label));

  if (!items.length) {
    throw new Error("模型接口未返回可用模型。");
  }

  return items;
}

export async function getConfig(): Promise<ClawdConfig> {
  return request<ClawdConfig>("/v1/config");
}

export async function getAuthSession(auth: RequestAuth): Promise<AuthSession> {
  return request<AuthSession>("/v1/auth/session", undefined, auth);
}

export async function listApiKeys(auth: RequestAuth): Promise<ApiKeySummary[]> {
  const data = await request<{ api_keys: ApiKeySummary[] }>("/v1/api-keys", undefined, auth);
  return data.api_keys;
}

export async function createApiKey(
  displayName: string,
  auth: RequestAuth,
): Promise<CreatedApiKey> {
  return request<CreatedApiKey>("/v1/api-keys", {
    method: "POST",
    body: JSON.stringify({
      display_name: displayName.trim() || undefined,
    }),
  }, auth);
}

export async function disableApiKey(apiKeyId: string, auth: RequestAuth): Promise<void> {
  await request<void>(`/v1/api-keys/${apiKeyId}/disable`, {
    method: "POST",
  }, auth);
}

export async function listProjects(auth: RequestAuth): Promise<ProjectSummary[]> {
  const data = await request<{ projects: ProjectSummary[] }>("/v1/projects", undefined, auth);
  return data.projects;
}

export async function listKnowledgeBases(auth: RequestAuth): Promise<KnowledgeBaseSummary[]> {
  const data = await request<{ knowledge_bases: KnowledgeBaseSummary[] }>(
    "/v1/knowledge-bases",
    undefined,
    auth,
  );
  return data.knowledge_bases;
}

export async function createKnowledgeBase(
  payload: CreateKnowledgeBaseRequest,
  auth: RequestAuth,
): Promise<KnowledgeBaseSummary> {
  return request<KnowledgeBaseSummary>("/v1/knowledge-bases", {
    method: "POST",
    body: JSON.stringify(payload),
  }, auth);
}

export async function listDataSources(auth: RequestAuth): Promise<DataSourceSummary[]> {
  const data = await request<{ data_sources: DataSourceSummary[] }>(
    "/v1/data-sources",
    undefined,
    auth,
  );
  return data.data_sources;
}

export async function createDataSource(
  payload: CreateDataSourceRequest,
  auth: RequestAuth,
): Promise<DataSourceSummary> {
  return request<DataSourceSummary>("/v1/data-sources", {
    method: "POST",
    body: JSON.stringify(payload),
  }, auth);
}

export async function getDataSource(
  dataSourceId: string,
  auth: RequestAuth,
): Promise<DataSourceDetail> {
  return request<DataSourceDetail>(`/v1/data-sources/${encodeURIComponent(dataSourceId)}`, undefined, auth);
}

export async function updateDataSource(
  dataSourceId: string,
  payload: UpdateDataSourceRequest,
  auth: RequestAuth,
): Promise<DataSourceSummary> {
  return request<DataSourceSummary>(`/v1/data-sources/${encodeURIComponent(dataSourceId)}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  }, auth);
}

export async function testDataSource(
  payload: TestDataSourceRequest,
  auth: RequestAuth,
): Promise<TestDataSourceResponse> {
  return request<TestDataSourceResponse>("/v1/data-sources/test", {
    method: "POST",
    body: JSON.stringify(payload),
  }, auth);
}

export async function testSavedDataSource(
  dataSourceId: string,
  auth: RequestAuth,
): Promise<TestDataSourceResponse> {
  return request<TestDataSourceResponse>(`/v1/data-sources/${encodeURIComponent(dataSourceId)}/test`, {
    method: "POST",
  }, auth);
}

export async function deleteDataSource(
  dataSourceId: string,
  auth: RequestAuth,
): Promise<void> {
  await request<void>(`/v1/data-sources/${encodeURIComponent(dataSourceId)}`, {
    method: "DELETE",
  }, auth);
}

export async function uploadDataSourceFile(
  dataSourceId: string,
  file: File,
  auth: RequestAuth,
): Promise<UploadedDocumentSummary> {
  const headers: HeadersInit = {};
  const apiKey = auth?.apiKey?.trim();
  const userId = auth?.userId?.trim();
  if (apiKey) {
    headers.authorization = `Bearer ${apiKey}`;
  } else if (userId) {
    headers["x-clawd-user-id"] = userId;
  }
  const form = new FormData();
  form.set("file", file);
  const response = await fetch(`${API_BASE}/v1/data-sources/${encodeURIComponent(dataSourceId)}/upload`, {
    method: "POST",
    headers,
    body: form,
  });
  if (!response.ok) {
    const body = await response.text();
    throw new Error(body || `上传失败: ${response.status}`);
  }
  return (await response.json()) as UploadedDocumentSummary;
}

export async function deleteDataSourceFile(
  dataSourceId: string,
  fileId: string,
  auth: RequestAuth,
): Promise<void> {
  await request<void>(
    `/v1/data-sources/${encodeURIComponent(dataSourceId)}/files/${encodeURIComponent(fileId)}`,
    {
      method: "DELETE",
    },
    auth,
  );
}

export async function getProject(projectId: string, auth: RequestAuth): Promise<ProjectSummary> {
  return request<ProjectSummary>(`/v1/projects/${encodeURIComponent(projectId)}`, undefined, auth);
}

export async function createProject(
  payload: CreateProjectRequest,
  auth: RequestAuth,
): Promise<ProjectSummary> {
  return request<ProjectSummary>("/v1/projects", {
    method: "POST",
    body: JSON.stringify(payload),
  }, auth);
}

export async function updateProject(
  projectId: string,
  payload: UpdateProjectRequest,
  auth: RequestAuth,
): Promise<ProjectSummary> {
  return request<ProjectSummary>(`/v1/projects/${encodeURIComponent(projectId)}`, {
    method: "PATCH",
    body: JSON.stringify(payload),
  }, auth);
}

export async function listSkills(
  options: {
    projectId?: string;
    workspaceRoot?: string;
  },
  auth: RequestAuth,
): Promise<SkillSummary[]> {
  const params = new URLSearchParams();
  if (options.projectId?.trim()) {
    params.set("project_id", options.projectId.trim());
  } else if (options.workspaceRoot?.trim()) {
    params.set("workspace_root", options.workspaceRoot.trim());
  }
  const suffix = params.toString() ? `?${params.toString()}` : "";
  const data = await request<{ skills: SkillSummary[] }>(`/v1/skills${suffix}`, undefined, auth);
  return data.skills;
}

export async function getSkill(
  name: string,
  options: {
    scope?: "workspace" | "tenant";
    projectId?: string;
    workspaceRoot?: string;
  },
  auth: RequestAuth,
): Promise<SkillDetail> {
  const params = new URLSearchParams();
  if (options.scope) {
    params.set("scope", options.scope);
  }
  if (options.projectId?.trim()) {
    params.set("project_id", options.projectId.trim());
  } else if (options.workspaceRoot?.trim()) {
    params.set("workspace_root", options.workspaceRoot.trim());
  }
  const suffix = params.toString() ? `?${params.toString()}` : "";
  return request<SkillDetail>(`/v1/skills/${encodeURIComponent(name)}${suffix}`, undefined, auth);
}

export async function saveSkill(
  payload: UpsertSkillRequest,
  auth: RequestAuth,
): Promise<SkillDetail> {
  return request<SkillDetail>("/v1/skills", {
    method: "POST",
    body: JSON.stringify(payload),
  }, auth);
}

export async function deleteSkill(
  name: string,
  options: {
    scope?: "workspace" | "tenant";
    projectId?: string;
    workspaceRoot?: string;
  },
  auth: RequestAuth,
): Promise<void> {
  const params = new URLSearchParams();
  if (options.scope) {
    params.set("scope", options.scope);
  }
  if (options.projectId?.trim()) {
    params.set("project_id", options.projectId.trim());
  } else if (options.workspaceRoot?.trim()) {
    params.set("workspace_root", options.workspaceRoot.trim());
  }
  const suffix = params.toString() ? `?${params.toString()}` : "";
  await request<void>(`/v1/skills/${encodeURIComponent(name)}${suffix}`, {
    method: "DELETE",
  }, auth);
}

export function threadEventsUrl(threadId: string, auth: RequestAuth): string {
  return `${API_BASE}${threadPath(`/v1/threads/${threadId}/events`, auth)}`;
}

export async function listThreads(auth: RequestAuth): Promise<ThreadSummary[]> {
  const data = await request<{ threads: ThreadSummary[] }>("/v1/threads", undefined, auth);
  return data.threads;
}

export async function createThread(
  payload: CreateThreadRequest,
  auth: RequestAuth,
): Promise<ThreadSnapshot> {
  return request<ThreadSnapshot>("/v1/threads", {
    method: "POST",
    body: JSON.stringify(payload),
  }, auth);
}

export async function getThread(threadId: string, auth: RequestAuth): Promise<ThreadSnapshot> {
  return request<ThreadSnapshot>(`/v1/threads/${threadId}`, undefined, auth);
}

export async function sendThreadCommand(
  threadId: string,
  command: ThreadCommand,
  auth: RequestAuth,
): Promise<ThreadSnapshot> {
  return request<ThreadSnapshot>(`/v1/threads/${threadId}/commands`, {
    method: "POST",
    body: JSON.stringify(command),
  }, auth);
}
