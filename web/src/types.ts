export type ThreadStatus = "idle" | "running" | "interrupt_requested" | "failed";

export type ArtifactKind = "text" | "markdown" | "table" | "chart" | "graph";

export type SkillScope = "workspace" | "tenant";

export type MessageBlock =
  | { type: "text"; text: string }
  | { type: "tool_use"; id: string; name: string; input: string }
  | {
      type: "tool_result";
      tool_use_id: string;
      tool_name: string;
      output: string;
      is_error: boolean;
    };

export interface MessageSnapshot {
  role: "system" | "user" | "assistant" | "tool";
  blocks: MessageBlock[];
}

export interface MemoryNote {
  id: string;
  scope: "thread" | "workspace" | "tenant";
  note: string;
  tags: string[];
  created_at_ms: number;
}

export interface ArtifactRecord {
  id: string;
  kind: ArtifactKind;
  title: string | null;
  payload: unknown;
  metadata?: Record<string, unknown> | null;
  created_at_ms: number;
}

export interface AuditRecord {
  id: string;
  run_id: number | null;
  kind: string;
  created_at_ms: number;
  payload: unknown;
}

export interface TableArtifactColumn {
  key: string;
  label?: string;
}

export interface TableArtifactPayload {
  columns: Array<string | TableArtifactColumn>;
  rows: Array<Record<string, unknown> | unknown[]>;
}

export type ChartArtifactType = "line" | "bar" | "area" | "pie";

export interface ChartArtifactSeries {
  key: string;
  label?: string;
  color?: string;
  stackId?: string;
}

export interface ChartArtifactPayload {
  type: ChartArtifactType;
  title?: string;
  description?: string;
  xKey?: string;
  labelKey?: string;
  valueKey?: string;
  height?: number;
  data: Array<Record<string, number | string | null>>;
  series?: ChartArtifactSeries[];
}

export interface GraphArtifactNode {
  id: string;
  label: string;
  kind?: string;
  x?: number;
  y?: number;
}

export interface GraphArtifactEdge {
  id?: string;
  source: string;
  target: string;
  label?: string;
}

export interface GraphArtifactPayload {
  title?: string;
  description?: string;
  nodes: GraphArtifactNode[];
  edges: GraphArtifactEdge[];
}

export interface ThreadSnapshot {
  id: string;
  workspace_root: string;
  session_path: string;
  project_id: string | null;
  project_name: string | null;
  knowledge_base_id: string | null;
  knowledge_base_name: string | null;
  model: string;
  permission_mode: string;
  topic: string | null;
  status: ThreadStatus;
  last_error: string | null;
  draft_assistant_text: string;
  created_at_ms: number;
  updated_at_ms: number;
  messages: MessageSnapshot[];
  memory_notes: MemoryNote[];
  artifacts: ArtifactRecord[];
  audit_records: AuditRecord[];
}

export interface ThreadSummary {
  id: string;
  workspace_root: string;
  project_id: string | null;
  project_name: string | null;
  knowledge_base_id: string | null;
  knowledge_base_name: string | null;
  model: string;
  topic: string | null;
  status: ThreadStatus;
  updated_at_ms: number;
}

export interface CreateThreadRequest {
  workspace_root?: string;
  project_id?: string;
  knowledge_base_id?: string;
  model?: string;
  model_base_url?: string;
  model_api_key?: string;
  permission_mode?: string;
  topic?: string;
}

export interface ProjectSummary {
  id: string;
  name: string;
  description: string | null;
  workspace_root: string;
  default_topic: string | null;
  default_model: string | null;
  model_base_url: string | null;
  model_base_url_env: string | null;
  model_api_key_env: string | null;
  model_api_key_configured: boolean;
  default_permission_mode: string | null;
  starter_prompt: string | null;
  default_instructions: string | null;
  default_skill_names: string[];
  created_at_ms: number;
  updated_at_ms: number;
}

export type DataSourceKind =
  | "local_dir"
  | "upload"
  | "web"
  | "git"
  | "s3"
  | "es"
  | "db"
  | "notion"
  | "confluence";

export interface KnowledgeBaseSummary {
  id: string;
  name: string;
  description: string | null;
  default_project_id: string | null;
  data_source_count: number;
  created_at_ms: number;
  updated_at_ms: number;
}

export interface CreateKnowledgeBaseRequest {
  name: string;
  description?: string;
  default_project_id?: string;
  legacy_workspace_root?: string;
}

export interface DataSourceSummary {
  id: string;
  knowledge_base_id: string;
  name: string;
  kind: DataSourceKind;
  description: string | null;
  status: string | null;
  endpoint: string | null;
  index_name: string | null;
  auth_mode: "api_key" | "basic" | "none" | null;
  source_detail: string | null;
  uploaded_files: UploadedDocumentSummary[];
  last_test: DataSourceTestResult | null;
  last_synced_at_ms: number | null;
  created_at_ms: number;
  updated_at_ms: number;
}

export interface DataSourceDetail extends DataSourceSummary {
  config: unknown;
}

export interface TestDataSourceRequest {
  kind: DataSourceKind;
  config?: unknown;
}

export interface DataSourceTestDetail {
  label: string;
  value: string;
}

export interface DataSourceTestResult {
  kind: DataSourceKind;
  status: string;
  summary: string;
  checked_at_ms: number;
  details: DataSourceTestDetail[];
}

export interface TestDataSourceResponse {
  ok: boolean;
  kind: DataSourceKind;
  summary: string;
  result: DataSourceTestResult;
}

export interface UploadedDocumentSummary {
  id: string;
  file_name: string;
  mime_type: string | null;
  size_bytes: number;
  uploaded_at_ms: number;
}

export interface CreateDataSourceRequest {
  knowledge_base_id: string;
  name: string;
  kind: DataSourceKind;
  description?: string;
  config?: unknown;
}

export interface UpdateDataSourceRequest {
  name?: string;
  description?: string;
  config?: unknown;
}

export interface CreateProjectRequest {
  name: string;
  description?: string;
  workspace_root: string;
  default_topic?: string;
  default_model?: string;
  model_base_url?: string;
  model_base_url_env?: string;
  model_api_key?: string;
  model_api_key_env?: string;
  default_permission_mode?: string;
  starter_prompt?: string;
  default_instructions?: string;
  default_skill_names?: string[];
}

export interface UpdateProjectRequest {
  name?: string;
  description?: string;
  default_topic?: string;
  default_model?: string;
  model_base_url?: string;
  model_base_url_env?: string;
  model_api_key?: string;
  model_api_key_env?: string;
  default_permission_mode?: string;
  starter_prompt?: string;
  default_instructions?: string;
  default_skill_names?: string[];
}

export interface RequestAuth {
  apiKey?: string;
  userId?: string;
}

export interface ClawdConfig {
  database_backend: string;
  database_schema_version: number;
  default_model: string;
  default_permission_mode: string;
  run_timeout_secs: number | null;
  max_threads_per_user: number | null;
  max_threads_per_tenant: number | null;
  max_concurrent_runs_global: number | null;
  max_concurrent_runs_per_tenant: number | null;
  max_concurrent_runs_per_user: number | null;
  max_mutation_requests_per_minute_global: number | null;
  max_mutation_requests_per_minute_per_tenant: number | null;
  max_mutation_requests_per_minute_per_user: number | null;
  api_key_auth_enabled: boolean;
  dev_user_header_auth_enabled: boolean;
}

export interface AuthSession {
  auth_mode: "api_key" | "dev_user_header";
  tenant_id: string | null;
  user_id: string;
  api_key_id: string | null;
  api_key_prefix: string | null;
  display_name: string | null;
}

export interface ApiKeySummary {
  id: string;
  display_name: string | null;
  key_prefix: string;
  created_at_ms: number;
  updated_at_ms: number;
  last_used_at_ms: number | null;
  disabled_at_ms: number | null;
}

export interface CreatedApiKey {
  api_key: ApiKeySummary;
  raw_key: string;
}

export interface DiscoveredModelOption {
  id: string;
  label: string;
  owner: string | null;
}

export interface ModelListResponse {
  data?: Array<{
    id?: string;
    owned_by?: string;
  }>;
}

export interface SkillSummary {
  name: string;
  description: string | null;
  tags: string[];
  starter_prompt: string | null;
  scope: SkillScope;
  updated_at_ms: number | null;
}

export interface SkillDetail extends SkillSummary {
  prompt: string;
}

export interface UpsertSkillRequest {
  scope: SkillScope;
  project_id?: string;
  workspace_root?: string;
  name: string;
  description?: string;
  tags?: string[];
  starter_prompt?: string;
  prompt: string;
}

export interface ExpertPanelContext {
  panel_id: string;
  master_skill: string;
  experts: Array<{
    skill: string;
    scope: SkillScope;
    label: string;
    description?: string | null;
  }>;
}

export type ThreadCommand =
  | { type: "user_message"; content: string; expert_panel?: ExpertPanelContext }
  | { type: "interrupt"; reason?: string }
  | { type: "replan"; reason?: string; topic?: string }
  | { type: "set_topic"; topic: string };

export interface ThreadEventEnvelope<T = unknown> {
  kind: string;
  at_ms: number;
  payload: T;
}
