import { FormEvent, Suspense, lazy, useEffect, useMemo, useRef, useState } from "react";

import {
  apiBaseUrl,
  createDataSource,
  createKnowledgeBase,
  createThread,
  createApiKey,
  deleteDataSource,
  deleteDataSourceFile,
  disableApiKey,
  fetchProviderModels,
  getDataSource,
  getAuthSession,
  getConfig,
  getProject,
  getThread,
  listApiKeys,
  listDataSources,
  listKnowledgeBases,
  listProjects,
  listSkills,
  listThreads,
  sendThreadCommand,
  testDataSource,
  testSavedDataSource,
  threadEventsUrl,
  uploadDataSourceFile,
  updateDataSource,
  updateProject,
} from "./api";
import { resolveAppSurface, type RequestedAppSurface } from "./app-surface";
import { collectEvidenceEntries } from "./evidence";
import {
  BUILTIN_EXPERT_SKILLS,
  buildExpertPanelContext,
  expertDisplayName,
  isExpertSkill,
} from "./expert-brainstorm";
import { WorkbenchShell } from "./features/workbench/workbench-shell";
import { OperatorConsole, type EventLogEntry } from "./operator-console";
import {
  presentDirectoryName,
  presentPermissionMode,
  presentSkillReference,
} from "./presentation";
import { ServiceAccessPanel } from "./service-access-panel";
import { presentRuntimeError, presentThreadAlert } from "./runtime-error";
import {
  filterKeyForThread,
  groupThreadsByProject,
  projectFilterKey,
} from "./thread-groups";
import type { WorkbenchTabId } from "./workbench-panel";
import type {
  ArtifactRecord,
  ApiKeySummary,
  AuthSession,
  AuditRecord,
  ClawdConfig,
  CreateDataSourceRequest,
  DataSourceKind,
  DataSourceSummary,
  DataSourceDetail,
  DataSourceTestResult,
  KnowledgeBaseSummary,
  ProjectSummary,
  CreatedApiKey,
  DiscoveredModelOption,
  MessageBlock,
  RequestAuth,
  SkillSummary,
  TestDataSourceResponse,
  ThreadEventEnvelope,
  ThreadSnapshot,
  ThreadStatus,
  ThreadSummary,
  UpdateProjectRequest,
} from "./types";

type InlineBoundaryMode = "topic" | "replan" | null;

const DEFAULT_WORKSPACE = "";
const OPERATOR_UI_ENABLED = import.meta.env.VITE_CLAWD_OPERATOR_UI === "1";
const API_KEY_STORAGE_KEY = "clawd.apiKey";
const USER_ID_STORAGE_KEY = "clawd.userId";
const MODEL_BASE_URL_STORAGE_KEY = "clawd.modelBaseUrl";
const MODEL_API_KEY_STORAGE_KEY = "clawd.modelApiKey";
const MODEL_NAME_STORAGE_KEY = "clawd.modelName";

const FALLBACK_MODEL_OPTION_GROUPS = [
  {
    label: "OpenAI",
    options: ["gpt-5.4", "gpt-5.4-mini", "gpt-5.2", "gpt-5", "gpt-4.1-mini", "gpt-4o"],
  },
  {
    label: "Anthropic",
    options: ["claude-opus-4-6", "claude-sonnet-4-6", "claude-haiku-4-5-20251213"],
  },
  {
    label: "xAI",
    options: ["grok-3", "grok-3-mini", "grok-2"],
  },
  {
    label: "Qwen",
    options: ["qwen-max", "qwen-plus", "qwen-turbo", "qwen-qwq"],
  },
];

type ModelDiscoveryState = "idle" | "loading" | "ready" | "fallback" | "error";

const LazyAssistantThreadPanel = lazy(async () => {
  const module = await import("./assistant-thread-panel");
  return { default: module.AssistantThreadPanel };
});

const LazySkillsPanel = lazy(async () => {
  const module = await import("./skills-panel");
  return { default: module.SkillsPanel };
});

const LazyWorkbenchPanel = lazy(async () => {
  const module = await import("./workbench-panel");
  return { default: module.WorkbenchPanel };
});

function generateUserId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `browser-${crypto.randomUUID().slice(0, 8)}`;
  }

  return `browser-${Math.random().toString(36).slice(2, 10)}`;
}

function loadStoredUserId(): string {
  if (typeof window === "undefined") {
    return "browser-local";
  }

  const existing = window.localStorage.getItem(USER_ID_STORAGE_KEY)?.trim();
  if (existing) {
    return existing;
  }

  const generated = generateUserId();
  window.localStorage.setItem(USER_ID_STORAGE_KEY, generated);
  return generated;
}

function loadStoredApiKey(): string {
  if (typeof window === "undefined") {
    return "";
  }

  return window.localStorage.getItem(API_KEY_STORAGE_KEY)?.trim() ?? "";
}

function readClientEnv(...names: string[]): string {
  for (const name of names) {
    const value = import.meta.env[name];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return "";
}

function loadStoredModelBaseUrl(): string {
  if (typeof window === "undefined") {
    return "";
  }

  const stored = window.localStorage.getItem(MODEL_BASE_URL_STORAGE_KEY)?.trim();
  if (stored) {
    return stored;
  }

  return readClientEnv("VITE_CLAWD_MODEL_BASE_URL", "VITE_MODEL_BASE_URL");
}

function loadStoredModelApiKey(): string {
  if (typeof window === "undefined") {
    return "";
  }

  const stored = window.localStorage.getItem(MODEL_API_KEY_STORAGE_KEY)?.trim();
  if (stored) {
    return stored;
  }

  return readClientEnv("VITE_CLAWD_MODEL_API_KEY", "VITE_MODEL_API_KEY");
}

function loadStoredModelName(): string {
  if (typeof window === "undefined") {
    return "";
  }

  return window.localStorage.getItem(MODEL_NAME_STORAGE_KEY)?.trim() ?? "";
}

function fallbackModelOptions(modelName: string): DiscoveredModelOption[] {
  const normalizedModelName = modelName.trim();
  const groupedOptions = FALLBACK_MODEL_OPTION_GROUPS.flatMap((group) =>
    group.options.map((option) => ({
      id: option,
      label: option,
      owner: group.label,
    })),
  );

  if (!normalizedModelName || groupedOptions.some((item) => item.id === normalizedModelName)) {
    return groupedOptions;
  }

  return [
    { id: normalizedModelName, label: normalizedModelName, owner: "当前值" },
    ...groupedOptions,
  ];
}

function formatTime(epochMs: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    month: "2-digit",
    day: "2-digit",
  }).format(epochMs);
}

function summarizePayload(payload: unknown): string {
  if (typeof payload === "string") {
    return payload.length > 240 ? `${payload.slice(0, 240)}...` : payload;
  }

  if (isThreadSnapshot(payload)) {
    return `thread:${payload.id} status=${payload.status} messages=${payload.messages.length} artifacts=${payload.artifacts.length}`;
  }

  if (payload && typeof payload === "object") {
    const record = payload as Record<string, unknown>;
    const kind = typeof record.kind === "string" ? record.kind : null;
    const toolName =
      typeof record.tool_name === "string"
        ? record.tool_name
        : typeof record.name === "string"
          ? record.name
          : null;
    const artifactId = typeof record.id === "string" ? record.id : null;
    const summaryParts = [
      kind,
      toolName,
      artifactId,
    ].filter((value): value is string => Boolean(value));
    if (summaryParts.length) {
      return summaryParts.join(" · ");
    }
  }

  try {
    const serialized = JSON.stringify(payload);
    return serialized.length > 240 ? `${serialized.slice(0, 240)}...` : serialized;
  } catch {
    return "unserializable payload";
  }
}

const INTERNAL_VISUAL_TOOL_NAMES = new Set(["MemoryWrite", "MemorySearch", "TopicDriftCheck", "Skill", "ExpertPanelEmit"]);

function truncateLargeText(value: string, maxLength = 4000): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function sanitizeThreadSnapshot(snapshot: ThreadSnapshot): ThreadSnapshot {
  return {
    ...snapshot,
    draft_assistant_text: truncateLargeText(snapshot.draft_assistant_text, 12000),
    messages: snapshot.messages.map((message) => ({
      ...message,
      blocks: message.blocks.reduce<MessageBlock[]>((blocks, block) => {
        if (block.type === "tool_use") {
          if (INTERNAL_VISUAL_TOOL_NAMES.has(block.name)) {
            return blocks;
          }
          blocks.push({
            ...block,
            input: truncateLargeText(block.input, 1200),
          });
          return blocks;
        }
        if (block.type === "tool_result") {
          if (INTERNAL_VISUAL_TOOL_NAMES.has(block.tool_name)) {
            return blocks;
          }
          blocks.push({
            ...block,
            output: truncateLargeText(block.output, 6000),
          });
          return blocks;
        }
        if (block.type === "text") {
          blocks.push({ ...block, text: truncateLargeText(block.text, 12000) });
          return blocks;
        }
        blocks.push(block);
        return blocks;
      }, []),
    })),
    audit_records: snapshot.audit_records
      .filter((record) => record.kind !== "tool_result" && record.kind !== "tool_use")
      .slice(-120),
    artifacts: snapshot.artifacts.slice(-80),
  };
}

function isThreadSnapshot(payload: unknown): payload is ThreadSnapshot {
  return Boolean(
    payload &&
      typeof payload === "object" &&
      "id" in payload &&
      "messages" in payload &&
      "artifacts" in payload,
  );
}

function mergeSummary(
  list: ThreadSummary[],
  snapshot: ThreadSnapshot,
): ThreadSummary[] {
  const next = {
    id: snapshot.id,
    workspace_root: snapshot.workspace_root,
    project_id: snapshot.project_id,
    project_name: snapshot.project_name,
    knowledge_base_id: snapshot.knowledge_base_id,
    knowledge_base_name: snapshot.knowledge_base_name,
    model: snapshot.model,
    topic: snapshot.topic,
    status: snapshot.status,
    updated_at_ms: snapshot.updated_at_ms,
  };

  const index = list.findIndex((item) => item.id === snapshot.id);
  if (index === -1) {
    return [next, ...list].sort((left, right) => right.updated_at_ms - left.updated_at_ms);
  }

  const updated = [...list];
  updated[index] = next;
  return updated.sort((left, right) => right.updated_at_ms - left.updated_at_ms);
}

function threadProjectLabel(thread: Pick<ThreadSnapshot, "project_name" | "knowledge_base_name" | "workspace_root">): string {
  return thread.project_name ?? thread.knowledge_base_name ?? presentDirectoryName(thread.workspace_root);
}

function activeKnowledgeLabel(options: {
  projectName?: string | null;
  knowledgeBaseName?: string | null;
  workspaceRoot?: string | null;
  project_name?: string | null;
  knowledge_base_name?: string | null;
  workspace_root?: string | null;
}): string {
  const projectName = options.projectName ?? options.project_name;
  const knowledgeBaseName = options.knowledgeBaseName ?? options.knowledge_base_name;
  const workspaceRoot = options.workspaceRoot ?? options.workspace_root;

  if (projectName?.trim()) {
    return projectName.trim();
  }

  if (knowledgeBaseName?.trim()) {
    return knowledgeBaseName.trim();
  }

  if (workspaceRoot?.trim()) {
    return presentDirectoryName(workspaceRoot);
  }

  return "纯聊天";
}

function contextBadgeLabel(options: {
  projectName?: string | null;
  knowledgeBaseName?: string | null;
  workspaceRoot?: string | null;
  project_name?: string | null;
  knowledge_base_name?: string | null;
  workspace_root?: string | null;
}): string {
  const label = activeKnowledgeLabel(options);
  return label === "纯聊天" ? "模式 纯聊天" : `资料库 ${label}`;
}

const DATA_SOURCE_KIND_OPTIONS: DataSourceKindOption[] = [
  {
    kind: "upload",
    title: "上传资料",
    label: "上传文档",
    description: "适合 PDF、Markdown、表格和文本，创建后直接拖入资料即可使用。",
  },
  {
    kind: "web",
    title: "网页来源",
    label: "网页链接",
    description: "适合官网、文档页或公开报告，会话只会访问你明确列出的链接。",
  },
  {
    kind: "es",
    title: "Elasticsearch",
    label: "Elasticsearch",
    description: "适合已经建好索引的检索系统，让 Agent 直接从 ES 搜索资料。",
  },
  {
    kind: "db",
    title: "数据库",
    label: "数据库",
    description: "适合运营、分析或业务数据，只开放只读查询，不允许写入。",
  },
  {
    kind: "local_dir",
    title: "服务器目录",
    label: "本地目录",
    description: "仅管理员使用的高级接入，适合托管在服务端的受控资料目录。",
    adminOnly: true,
  },
];

function dataSourceKindLabel(kind: DataSourceKind): string {
  return DATA_SOURCE_KIND_OPTIONS.find((item) => item.kind === kind)?.label ?? kind;
}

function appendArtifact(artifacts: ThreadSnapshot["artifacts"], artifact: ThreadSnapshot["artifacts"][number]): ThreadSnapshot["artifacts"] {
  if (artifacts.some((item) => item.id === artifact.id)) {
    return artifacts;
  }

  return [artifact, ...artifacts];
}

function appendAuditRecord(records: ThreadSnapshot["audit_records"], record: ThreadSnapshot["audit_records"][number]): ThreadSnapshot["audit_records"] {
  if (records.some((item) => item.id === record.id)) {
    return records;
  }

  const next = [...records, record];
  return next.slice(Math.max(0, next.length - 200));
}

function threadStatusLabel(status: ThreadStatus): string {
  switch (status) {
    case "running":
      return "运行中";
    case "interrupt_requested":
      return "停止中";
    case "failed":
      return "失败";
    case "idle":
    default:
      return "就绪";
  }
}

function formatFileSize(sizeBytes: number): string {
  if (sizeBytes >= 1024 * 1024) {
    return `${(sizeBytes / (1024 * 1024)).toFixed(1)} MB`;
  }
  if (sizeBytes >= 1024) {
    return `${(sizeBytes / 1024).toFixed(1)} KB`;
  }
  return `${sizeBytes} B`;
}

function dataSourceKindDescription(kind: DataSourceKind): string {
  return (
    DATA_SOURCE_KIND_OPTIONS.find((item) => item.kind === kind)?.description ??
    "用于扩展会话的资料接入范围。"
  );
}

function dataSourceTestStatusLabel(status: string): string {
  switch (status) {
    case "ready":
      return "已验证";
    case "unsupported":
      return "无需测试";
    default:
      return status;
  }
}

function dataSourceCardStateLabel(source: DataSourceSummary): string {
  if (source.kind === "upload") {
    return source.uploaded_files.length ? "已接入" : "待上传";
  }
  if (source.last_test?.status === "ready") {
    return "已验证";
  }
  if (source.last_test?.status === "unsupported") {
    return "已接入";
  }
  if (source.status === "empty") {
    return "待补资料";
  }
  if (source.status === "ready") {
    return "已接入";
  }
  return "待检查";
}

function dataSourceCardStateMeta(source: DataSourceSummary): string {
  if (source.kind === "upload") {
    return source.last_synced_at_ms ? `最近上传 ${formatTime(source.last_synced_at_ms)}` : "创建后可直接上传";
  }
  if (source.last_test) {
    return `验证于 ${formatTime(source.last_test.checked_at_ms)}`;
  }
  if (source.kind === "local_dir") {
    return "后台受控接入";
  }
  return "建议先测试连接";
}

function dataSourceCardStateCopy(source: DataSourceSummary): string {
  if (source.kind === "upload") {
    return source.uploaded_files.length
      ? `当前已接入 ${source.uploaded_files.length} 份资料，可继续补充上传。`
      : "当前还没有上传资料。创建后可直接拖入 PDF、Markdown、文本或表格文件。";
  }
  if (source.last_test) {
    return source.last_test.summary;
  }
  if (source.kind === "web") {
    return "建议先验证网页可读性，再在会话中引用网页来源。";
  }
  if (source.kind === "es") {
    return "建议先验证索引是否可访问，再将它作为检索入口开放给 Agent。";
  }
  if (source.kind === "db") {
    return "建议先验证只读连接，再让 Agent 发起数据库查询。";
  }
  if (source.kind === "local_dir") {
    return "这是后台受控资料目录，不会把服务器路径直接暴露给普通用户。";
  }
  return source.source_detail ?? "当前来源已接入。";
}

function firstUploadSourceForKnowledgeBase(
  knowledgeBaseId: string,
  dataSources: DataSourceSummary[],
): DataSourceSummary | null {
  return dataSources.find(
    (source) => source.knowledge_base_id === knowledgeBaseId && source.kind === "upload",
  ) ?? null;
}

function defaultDataSourceName(kind: DataSourceKind, knowledgeBaseName?: string | null): string {
  const prefix = knowledgeBaseName?.trim();
  switch (kind) {
    case "upload":
      return prefix ? `${prefix} 上传资料` : "上传资料";
    case "web":
      return prefix ? `${prefix} 网页来源` : "网页来源";
    case "es":
      return prefix ? `${prefix} 检索索引` : "检索索引";
    case "db":
      return prefix ? `${prefix} 数据库` : "数据库";
    case "local_dir":
      return prefix ? `${prefix} 服务器目录` : "服务器目录";
    default:
      return prefix ? `${prefix} 资料来源` : "资料来源";
  }
}

function DataSourceTestResultView({ result }: { result: DataSourceTestResult }) {
  return (
    <div className="data-source-test-panel">
      <div className="data-source-test-header">
        <strong>{dataSourceTestStatusLabel(result.status)}</strong>
        <span>测试于 {formatTime(result.checked_at_ms)}</span>
      </div>
      <div className="data-source-test-summary">{result.summary}</div>
      {result.details.length ? (
        <div className="data-source-test-details">
          {result.details.map((item) => (
            <div className="data-source-test-detail" key={`${item.label}-${item.value}`}>
              <span>{item.label}</span>
              <strong>{item.value}</strong>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

function dataSourceConfigPayload(form: DataSourceFormState): CreateDataSourceRequest["config"] {
  if (form.kind === "es") {
    return {
      endpoint: form.endpoint.trim() || undefined,
      index: form.indexName.trim() || undefined,
      api_key: form.apiKey.trim() || undefined,
      username: form.username.trim() || undefined,
      password: form.password.trim() || undefined,
    };
  }
  if (form.kind === "web") {
    return {
      urls: form.urls
        .split("\n")
        .map((item) => item.trim())
        .filter(Boolean),
    };
  }
  if (form.kind === "db") {
    return {
      url: form.dbUrl.trim() || undefined,
      schema: form.dbSchema.trim() || undefined,
      username: form.username.trim() || undefined,
      password: form.password.trim() || undefined,
    };
  }
  if (form.kind === "local_dir") {
    return {
      path: form.path.trim() || undefined,
    };
  }
  return {
    files: [],
  };
}

function populateDataSourceFormFromDetail(source: DataSourceDetail): DataSourceFormState {
  const config = (source.config && typeof source.config === "object" ? source.config : {}) as Record<string, unknown>;
  const urls = Array.isArray(config.urls)
    ? config.urls.filter((item): item is string => typeof item === "string")
    : [];
  return {
    editingSourceId: source.id,
    knowledgeBaseId: source.knowledge_base_id,
    name: source.name,
    kind: source.kind,
    description: source.description ?? "",
    endpoint:
      typeof config.endpoint === "string"
        ? config.endpoint
        : typeof config.base_url === "string"
          ? config.base_url
          : typeof config.url === "string"
            ? config.url
            : "",
    indexName:
      typeof config.index === "string"
        ? config.index
        : typeof config.default_index === "string"
          ? config.default_index
          : "",
    apiKey: "",
    username: "",
    password: "",
    path: typeof config.path === "string" ? config.path : "",
    urls: urls.join("\n"),
    dbUrl:
      source.kind === "db" && typeof config.url === "string"
        ? config.url
        : "",
    dbSchema:
      source.kind === "db" && typeof config.schema === "string"
        ? config.schema
        : "",
  };
}

function authModeLabel(mode: AuthSession["auth_mode"] | null | undefined): string {
  if (mode === "api_key") {
    return "API 密钥";
  }

  if (mode === "dev_user_header") {
    return "开发态用户标识";
  }

  return "等待认证";
}

function presentWorkbenchError(message: string | null): string | null {
  return presentRuntimeError(message)?.userMessage ?? message?.trim() ?? null;
}

function serviceModelStatusLabel(options: {
  standaloneModelReady: boolean;
  hasStandaloneModelConfig: boolean;
  modelName: string;
}): string {
  if (options.standaloneModelReady) {
    return `模型 ${options.modelName.trim()} 已就绪`;
  }

  if (options.hasStandaloneModelConfig) {
    return "模型配置未完成";
  }

  return "当前跟随服务环境";
}

function buildThreadStarterPrompts(thread: ThreadSnapshot | null): string[] {
  const topic = thread?.topic?.trim();
  if (!topic) {
    return [
      "先梳理最相关的资料范围，并给出研究计划。",
      "读取最关键的本地文件，输出一份结构化摘要。",
      "列出当前已知结论、来源缺口和下一步检索方向。",
    ];
  }

  return [
    `先梳理与“${topic}”最相关的资料范围，并给出研究计划。`,
    `围绕“${topic}”读取最关键的本地文件，输出结构化摘要。`,
    `围绕“${topic}”列出当前结论、来源缺口和下一步方向。`,
  ];
}

function buildRequestAuth(apiKey: string, userId: string): RequestAuth | null {
  const normalizedApiKey = apiKey.trim();
  if (normalizedApiKey) {
    return { apiKey: normalizedApiKey };
  }

  const normalizedUserId = userId.trim();
  if (normalizedUserId) {
    return { userId: normalizedUserId };
  }

  return null;
}

function suggestedTopicFromSkill(name: string, description: string | null | undefined): string {
  const normalizedDescription = description?.trim();
  if (normalizedDescription) {
    return normalizedDescription;
  }

  return `使用 ${name} 技能检索资料并输出结构化结论`;
}

function skillDisplayName(skillName: string): string {
  const normalized = skillName.trim();
  if (!normalized) {
    return "未命名技能";
  }
  const separatorIndex = normalized.indexOf(":");
  return separatorIndex === -1 ? normalized : normalized.slice(separatorIndex + 1).trim() || normalized;
}

function parseSkillNameList(value: string): string[] {
  return value
    .split(/\r?\n|,/)
    .map((item) => item.trim())
    .filter(Boolean);
}

function normalizeEditableText(value: string): string | null {
  const normalized = value.trim();
  return normalized ? normalized : null;
}

function sameStringArray(left: string[], right: string[]): boolean {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

type ProjectSettingsDraft = {
  id: string;
  name: string;
  description: string;
  workspaceRoot: string;
  defaultTopic: string;
  defaultPermissionMode: string;
  starterPrompt: string;
  defaultInstructions: string;
  defaultSkillNames: string;
  createdAtMs: number;
  updatedAtMs: number;
};

type KnowledgeBaseFormState = {
  name: string;
  description: string;
};

type DataSourceFormState = {
  editingSourceId: string;
  knowledgeBaseId: string;
  name: string;
  kind: DataSourceKind;
  description: string;
  endpoint: string;
  indexName: string;
  apiKey: string;
  username: string;
  password: string;
  path: string;
  urls: string;
  dbUrl: string;
  dbSchema: string;
};

type DataSourceKindOption = {
  kind: DataSourceKind;
  title: string;
  label: string;
  description: string;
  adminOnly?: boolean;
};

type ModelAccessSectionProps = {
  baseUrl: string;
  apiKey: string;
  modelName: string;
  discoveredModels: DiscoveredModelOption[];
  discoveryState: ModelDiscoveryState;
  discoveryMessage: string | null;
  hideStatus?: boolean;
  title?: string;
  description?: string;
  onBaseUrlChange: (value: string) => void;
  onApiKeyChange: (value: string) => void;
  onModelNameChange: (value: string) => void;
  compact?: boolean;
};

type DefaultSkillSelectorProps = {
  selectedSkillNames: string[];
  skillOptions: SkillSummary[];
  loading: boolean;
  emptyHint: string;
  onToggleSkill: (skill: SkillSummary) => void;
  rawValue: string;
  onRawValueChange: (value: string) => void;
};

type ThreadSkillStripProps = {
  skills: SkillSummary[];
  loading: boolean;
  onUseSkill: (skill: SkillSummary) => void;
  onOpenSkillManager: () => void;
  expertSkills?: SkillSummary[];
  selectedExperts: SkillSummary[];
  onToggleExpert: (skill: SkillSummary) => void;
};

type SettingsFormSectionProps = {
  title: string;
  description: string;
  defaultOpen?: boolean;
  children: React.ReactNode;
};

function projectSettingsDraftFromProject(project: ProjectSummary): ProjectSettingsDraft {
  return {
    id: project.id,
    name: project.name,
    description: project.description ?? "",
    workspaceRoot: project.workspace_root,
    defaultTopic: project.default_topic ?? "",
    defaultPermissionMode: project.default_permission_mode ?? "",
    starterPrompt: project.starter_prompt ?? "",
    defaultInstructions: project.default_instructions ?? "",
    defaultSkillNames: project.default_skill_names.join("\n"),
    createdAtMs: project.created_at_ms,
    updatedAtMs: project.updated_at_ms,
  };
}

function projectUpdatePayloadFromDraft(draft: ProjectSettingsDraft): UpdateProjectRequest {
  return {
    name: draft.name.trim(),
    description: draft.description,
    default_topic: draft.defaultTopic,
    default_permission_mode: draft.defaultPermissionMode,
    starter_prompt: draft.starterPrompt,
    default_instructions: draft.defaultInstructions,
    default_skill_names: parseSkillNameList(draft.defaultSkillNames),
  };
}

function projectDraftMatchesProject(
  draft: ProjectSettingsDraft,
  project: ProjectSummary,
): boolean {
  return (
    draft.name.trim() === project.name &&
    normalizeEditableText(draft.description) === project.description &&
    normalizeEditableText(draft.defaultTopic) === project.default_topic &&
    normalizeEditableText(draft.defaultPermissionMode) === project.default_permission_mode &&
    normalizeEditableText(draft.starterPrompt) === project.starter_prompt &&
    normalizeEditableText(draft.defaultInstructions) === project.default_instructions &&
    sameStringArray(parseSkillNameList(draft.defaultSkillNames), project.default_skill_names)
  );
}

function upsertProjectSummary(
  list: ProjectSummary[],
  project: ProjectSummary,
): ProjectSummary[] {
  const index = list.findIndex((item) => item.id === project.id);
  if (index === -1) {
    return [project, ...list].sort((left, right) => right.updated_at_ms - left.updated_at_ms);
  }

  const updated = [...list];
  updated[index] = project;
  return updated.sort((left, right) => right.updated_at_ms - left.updated_at_ms);
}

function canonicalSkillName(skill: Pick<SkillSummary, "name" | "scope">): string {
  return `${skill.scope}:${skill.name}`;
}

function findSkillByReference(
  reference: string,
  skillOptions: SkillSummary[],
): SkillSummary | null {
  const normalized = reference.trim();
  if (!normalized) {
    return null;
  }

  const separatorIndex = normalized.indexOf(":");
  const scope = separatorIndex === -1 ? null : normalized.slice(0, separatorIndex);
  const name = separatorIndex === -1 ? normalized : normalized.slice(separatorIndex + 1).trim();
  return (
    skillOptions.find(
      (skill) => skill.name === name && (!scope || skill.scope === scope),
    ) ?? null
  );
}

function ModelAccessSection({
  baseUrl,
  apiKey,
  modelName,
  discoveredModels,
  discoveryState,
  discoveryMessage,
  hideStatus = false,
  title = "模型",
  description,
  onBaseUrlChange,
  onApiKeyChange,
  onModelNameChange,
  compact = false,
}: ModelAccessSectionProps) {
  const normalizedBaseUrl = baseUrl.trim();
  const normalizedApiKey = apiKey.trim();
  const normalizedModelName = modelName.trim();
  const hasPartialConfig = Boolean(normalizedBaseUrl || normalizedApiKey || normalizedModelName);
  const statusLabel =
    discoveryState === "loading"
      ? "正在获取模型"
      : normalizedBaseUrl && normalizedApiKey && normalizedModelName
        ? "独立模型已就绪"
        : hasPartialConfig
          ? "待补全"
          : "跟随服务环境";
  const copy =
    description ??
    "留空时会沿用服务端启动环境；如果当前浏览器要单独接入模型，请先填写 API 地址和 API 密钥，再从返回结果中选择模型。";
  const usingFallbackOptions = discoveryState === "fallback" || discoveryState === "error";
  const selectHint =
    !normalizedBaseUrl || !normalizedApiKey
      ? "先填写 API 地址和 API 密钥，随后自动读取模型。"
      : discoveryState === "loading"
        ? "正在读取模型列表…"
        : discoveryMessage ?? null;

  return (
    <section className={`model-access-card${compact ? " compact" : ""}`}>
      <div className="model-access-header">
        <div>
          <div className="section-title">{title}</div>
          <p className="input-hint">{copy}</p>
        </div>
        {!hideStatus ? <span className="model-access-status">{statusLabel}</span> : null}
      </div>
      <div className="model-access-grid">
        <label>
          API 地址
          <input
            value={baseUrl}
            onChange={(event) => onBaseUrlChange(event.target.value)}
            placeholder="例如 https://api.openai.com/v1 或 …/v1/responses"
          />
        </label>
        <label>
          API 密钥
          <input
            autoComplete="new-password"
            type="password"
            value={apiKey}
            onChange={(event) => onApiKeyChange(event.target.value)}
            placeholder="输入模型 API 密钥"
          />
        </label>
        <label className="model-field-span-2">
          模型
          <select
            disabled={!normalizedBaseUrl || !normalizedApiKey || discoveryState === "loading"}
            value={modelName}
            onChange={(event) => onModelNameChange(event.target.value)}
          >
            <option value="">
              {!normalizedBaseUrl || !normalizedApiKey
                ? "先填写 API 地址和 API 密钥"
                : discoveryState === "loading"
                  ? "正在读取模型…"
                  : "请选择模型"}
            </option>
            {discoveredModels.map((option) => (
              <option key={option.id} value={option.id}>
                {option.owner ? `${option.label} · ${option.owner}` : option.label}
              </option>
            ))}
          </select>
          {selectHint ? (
            <span className={`input-hint model-select-hint${usingFallbackOptions ? " fallback" : ""}`}>
              {selectHint}
            </span>
          ) : null}
        </label>
      </div>
    </section>
  );
}

function DefaultSkillSelector({
  selectedSkillNames,
  skillOptions,
  loading,
  emptyHint,
  onToggleSkill,
  rawValue,
  onRawValueChange,
}: DefaultSkillSelectorProps) {
  const [manualOpen, setManualOpen] = useState(false);

  return (
    <section className="project-skill-card">
      <div className="project-skill-card-header">
        <div>
          <div className="section-title">常用技能</div>
          <p className="input-hint">
            给这个资料库预设常用分析流程。新会话会优先参考这些技能，但用户仍可随时换技能或直接聊天。
          </p>
        </div>
        <span className="project-skill-count">
          {selectedSkillNames.length ? `已选 ${selectedSkillNames.length}` : "未设置"}
        </span>
      </div>
      {selectedSkillNames.length ? (
        <div className="project-selected-skill-list">
          {selectedSkillNames.map((skillName) => {
            const skill = findSkillByReference(skillName, skillOptions);
            return (
              <span className="project-selected-skill-chip" key={skillName}>
                <strong>{skill?.name ?? skillDisplayName(skillName)}</strong>
                <small>{skill?.description ?? presentSkillReference(skillName)}</small>
              </span>
            );
          })}
        </div>
      ) : (
        <div className="input-hint">当前还没有为这个资料库指定常用技能。</div>
      )}
      <div className="project-skill-selector">
        <div className="project-skill-selector-header">
          <strong>可用技能</strong>
          <span className="input-hint">
            {loading ? "正在加载当前资料库可见技能…" : "点击即可加入或移出常用技能。"}
          </span>
        </div>
        {skillOptions.length ? (
          <div className="project-skill-pills">
            {skillOptions.map((skill) => {
              const canonical = canonicalSkillName(skill);
              const active = selectedSkillNames.includes(canonical);
              return (
                <button
                  className={`secondary project-skill-pill ${active ? "active" : ""}`}
                  key={canonical}
                  onClick={() => onToggleSkill(skill)}
                  title={skill.description ?? canonical}
                  type="button"
                >
                  <strong>{skill.name}</strong>
                  {skill.description ? <span>{skill.description}</span> : null}
                </button>
              );
            })}
          </div>
        ) : (
          <div className="input-hint">{emptyHint}</div>
        )}
      </div>
      <details
        className="project-skill-manual"
        open={manualOpen}
        onToggle={(event) => setManualOpen((event.currentTarget as HTMLDetailsElement).open)}
      >
        <summary>高级：手动编辑技能名</summary>
        <label>
          技能清单
          <textarea
            rows={4}
            value={rawValue}
            onChange={(event) => onRawValueChange(event.target.value)}
            placeholder={"每行一个技能，例如\nrepo-map\nworkspace:repo-map\ntenant:report"}
          />
        </label>
        <div className="input-hint">
          通常直接写技能名即可。只有同名技能需要强制指定位置时，管理员才需要使用 `workspace:` 或 `tenant:` 前缀。
        </div>
      </details>
    </section>
  );
}

function ThreadSkillStrip({
  skills,
  loading,
  onUseSkill,
  onOpenSkillManager,
  expertSkills,
  selectedExperts,
  onToggleExpert,
}: ThreadSkillStripProps) {
  const visibleSkills = skills.slice(0, 4);
  const availableExpertSkills = (expertSkills ?? skills.filter(isExpertSkill)).slice(0, 7);
  const hasExperts = availableExpertSkills.length > 0;

  return (
    <section className="thread-skill-strip">
      <div className="thread-skill-strip-main">
        <div className="thread-skill-strip-copy">
          <strong>技能</strong>
          <span>
            {loading
              ? "正在读取可用技能..."
              : visibleSkills.length
                ? "选择一个流程放入输入框，发送前仍可修改。"
                : "还没有可用技能，可先创建常用分析流程。"}
          </span>
        </div>
        <div className="thread-skill-actions">
          {visibleSkills.map((skill) => (
            <button
              className="secondary thread-skill-chip"
              key={`${skill.scope}:${skill.name}`}
              onClick={() => onUseSkill(skill)}
              title={skill.description ?? skill.name}
              type="button"
            >
              <strong>{skill.name}</strong>
              {skill.description ? <span>{skill.description}</span> : null}
            </button>
          ))}
          <button className="secondary thread-skill-manage" onClick={onOpenSkillManager} type="button">
            {visibleSkills.length ? "管理" : "创建技能"}
          </button>
        </div>
      </div>
      {hasExperts ? (
        <div className="thread-expert-strip">
          <div className="thread-expert-copy">
            <strong>分析视角</strong>
            <span>勾选后，本轮消息会由这些专家视角分别检索资料、形成意见，再汇总输出。</span>
          </div>
          <div className="thread-expert-actions">
            {availableExpertSkills.map((skill) => {
              const active = selectedExperts.some(
                (item) => item.name === skill.name && item.scope === skill.scope,
              );
              return (
                <button
                  className={`secondary thread-expert-chip ${active ? "active" : ""}`}
                  key={`expert-${skill.scope}:${skill.name}`}
                  onClick={() => onToggleExpert(skill)}
                  title={skill.description ?? skill.name}
                  type="button"
                >
                  {expertDisplayName(skill.name)}
                </button>
              );
            })}
          </div>
        </div>
      ) : null}
    </section>
  );
}

function SettingsFormSection({
  title,
  description,
  defaultOpen = true,
  children,
}: SettingsFormSectionProps) {
  return (
    <details className="settings-form-section" open={defaultOpen}>
      <summary>
        <div className="settings-form-section-header">
          <strong>{title}</strong>
          <span>{description}</span>
        </div>
      </summary>
      <div className="settings-form-section-body">{children}</div>
    </details>
  );
}

export default function App() {
  const operatorMode = OPERATOR_UI_ENABLED;
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBaseSummary[]>([]);
  const [dataSources, setDataSources] = useState<DataSourceSummary[]>([]);
  const [selectedThread, setSelectedThread] = useState<ThreadSnapshot | null>(null);
  const [config, setConfig] = useState<ClawdConfig | null>(null);
  const [apiKey, setApiKey] = useState(loadStoredApiKey);
  const [userId, setUserId] = useState(loadStoredUserId);
  const [authSession, setAuthSession] = useState<AuthSession | null>(null);
  const [managedApiKeys, setManagedApiKeys] = useState<ApiKeySummary[]>([]);
  const [apiKeyDisplayName, setApiKeyDisplayName] = useState("Web Console");
  const [latestCreatedApiKey, setLatestCreatedApiKey] = useState<CreatedApiKey | null>(null);
  const [modelBaseUrl, setModelBaseUrl] = useState(loadStoredModelBaseUrl);
  const [modelApiKey, setModelApiKey] = useState(loadStoredModelApiKey);
  const [modelName, setModelName] = useState(loadStoredModelName);
  const [discoveredModels, setDiscoveredModels] = useState<DiscoveredModelOption[]>([]);
  const [modelDiscoveryState, setModelDiscoveryState] = useState<ModelDiscoveryState>("idle");
  const [modelDiscoveryMessage, setModelDiscoveryMessage] = useState<string | null>(null);
  const [workspaceRoot, setWorkspaceRoot] = useState(DEFAULT_WORKSPACE);
  const [selectedProjectId, setSelectedProjectId] = useState("");
  const [selectedKnowledgeBaseId, setSelectedKnowledgeBaseId] = useState("");
  const [knowledgeBaseForm, setKnowledgeBaseForm] = useState<KnowledgeBaseFormState>({
    name: "",
    description: "",
  });
  const [dataSourceForm, setDataSourceForm] = useState<DataSourceFormState>({
    editingSourceId: "",
    knowledgeBaseId: "",
    name: "",
    kind: "upload",
    description: "",
    endpoint: "",
    indexName: "",
    apiKey: "",
    username: "",
    password: "",
    path: "",
    urls: "",
    dbUrl: "",
    dbSchema: "",
  });
  const [knowledgeLoading, setKnowledgeLoading] = useState(false);
  const [uploadingDataSourceId, setUploadingDataSourceId] = useState<string | null>(null);
  const [removingDataSourceId, setRemovingDataSourceId] = useState<string | null>(null);
  const [removingDataSourceFileId, setRemovingDataSourceFileId] = useState<string | null>(null);
  const [draggingDataSourceId, setDraggingDataSourceId] = useState<string | null>(null);
  const [dataSourceTesting, setDataSourceTesting] = useState(false);
  const [dataSourceTestResult, setDataSourceTestResult] = useState<TestDataSourceResponse | null>(null);
  const [cardTestingDataSourceId, setCardTestingDataSourceId] = useState<string | null>(null);
  const [topic, setTopic] = useState("");
  const [launchPrompt, setLaunchPrompt] = useState("");
  const [permissionMode, setPermissionMode] = useState("read-only");
  const [replanReason, setReplanReason] = useState("范围偏移时重新收束到当前主题。");
  const [topicDraft, setTopicDraft] = useState("");
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [apiKeysLoading, setApiKeysLoading] = useState(false);
  const [apiKeysBusy, setApiKeysBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [events, setEvents] = useState<EventLogEntry[]>([]);
  const [workbenchTab, setWorkbenchTab] = useState<WorkbenchTabId>("results");
  const [workbenchOpen, setWorkbenchOpen] = useState(false);
  const [inlineBoundaryMode, setInlineBoundaryMode] = useState<InlineBoundaryMode>(null);
  const [highlightedEvidenceId, setHighlightedEvidenceId] = useState<string | null>(null);
  const [highlightedEvidenceAnchor, setHighlightedEvidenceAnchor] = useState<string | null>(null);
  const [highlightedArtifactId, setHighlightedArtifactId] = useState<string | null>(null);
  const [highlightedArtifactAnchor, setHighlightedArtifactAnchor] = useState<string | null>(null);
  const [composerSeed, setComposerSeed] = useState<{
    text: string;
    nonce: number;
    threadId: string;
    mode: "replace" | "append";
  } | null>(null);
  const [activeProjectFilter, setActiveProjectFilter] = useState<string>("all");
  const [requestedSurface, setRequestedSurface] =
    useState<RequestedAppSurface>("workbench");
  const [selectedProjectDetail, setSelectedProjectDetail] = useState<ProjectSummary | null>(null);
  const [projectEditor, setProjectEditor] = useState<ProjectSettingsDraft | null>(null);
  const [projectDetailLoading, setProjectDetailLoading] = useState(false);
  const [projectSaving, setProjectSaving] = useState(false);
  const [projectSkillOptions, setProjectSkillOptions] = useState<SkillSummary[]>([]);
  const [projectSkillOptionsLoading, setProjectSkillOptionsLoading] = useState(false);
  const [threadSkillOptions, setThreadSkillOptions] = useState<SkillSummary[]>([]);
  const [threadSkillOptionsLoading, setThreadSkillOptionsLoading] = useState(false);
  const [selectedExpertSkillKeys, setSelectedExpertSkillKeys] = useState<string[]>([]);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [modelSettingsOpen, setModelSettingsOpen] = useState(false);
  const [managementOpen, setManagementOpen] = useState(false);
  const [dataSourcePanelOpen, setDataSourcePanelOpen] = useState(false);
  const [createThreadMode, setCreateThreadMode] = useState(false);
  const eventSourceRef = useRef<EventSource | null>(null);
  const activeAuth = buildRequestAuth(apiKey, userId);
  const surface = resolveAppSurface(requestedSurface, {
    hasAuth: Boolean(activeAuth),
    operatorUiEnabled: operatorMode,
  });
  const selectedKnowledgeBaseUploadSource = useMemo(
    () =>
      selectedKnowledgeBaseId
        ? firstUploadSourceForKnowledgeBase(selectedKnowledgeBaseId, dataSources)
        : null,
    [dataSources, selectedKnowledgeBaseId],
  );
  const activeThreadUploadSource = useMemo(
    () =>
      selectedThread?.knowledge_base_id
        ? firstUploadSourceForKnowledgeBase(selectedThread.knowledge_base_id, dataSources)
        : null,
    [dataSources, selectedThread?.knowledge_base_id],
  );
  const projectGroups = useMemo(
    () => groupThreadsByProject(threads, projects),
    [projects, threads],
  );
  const visibleThreads = useMemo(
    () =>
      activeProjectFilter === "all"
        ? threads
        : threads.filter((thread) => filterKeyForThread(thread) === activeProjectFilter),
    [activeProjectFilter, threads],
  );
  const evidenceEntries = useMemo(
    () => (selectedThread ? collectEvidenceEntries(selectedThread) : []),
    [selectedThread],
  );
  const hasStandaloneModelConfig = useMemo(
    () => Boolean(modelBaseUrl.trim() || modelApiKey.trim() || modelName.trim()),
    [modelApiKey, modelBaseUrl, modelName],
  );
  const standaloneModelReady = useMemo(
    () => Boolean(modelBaseUrl.trim() && modelApiKey.trim() && modelName.trim()),
    [modelApiKey, modelBaseUrl, modelName],
  );
  const showConversationQuickstart = !selectedThread || createThreadMode;
  const selectedProject = useMemo(
    () => projects.find((project) => project.id === selectedProjectId) ?? null,
    [projects, selectedProjectId],
  );
  const currentProject = useMemo(
    () =>
      selectedProjectDetail?.id === selectedProjectId
        ? selectedProjectDetail
        : selectedProject,
    [selectedProject, selectedProjectDetail, selectedProjectId],
  );
  const activeProjectGroup = useMemo(
    () =>
      activeProjectFilter === "all"
        ? null
        : projectGroups.find((group) => group.filterKey === activeProjectFilter) ?? null,
    [activeProjectFilter, projectGroups],
  );
  const projectEditorDirty = useMemo(
    () => (projectEditor && currentProject ? !projectDraftMatchesProject(projectEditor, currentProject) : false),
    [currentProject, projectEditor],
  );
  const selectedProjectSkillNames = useMemo(
    () => (projectEditor ? parseSkillNameList(projectEditor.defaultSkillNames) : []),
    [projectEditor],
  );
  const availableExpertSkills = useMemo(() => {
    const serviceExperts = threadSkillOptions.filter(isExpertSkill);
    if (serviceExperts.length) {
      return serviceExperts;
    }
    return BUILTIN_EXPERT_SKILLS;
  }, [threadSkillOptions]);
  const selectedExpertSkillRecords = useMemo(() => {
    const byKey = new Map(
      availableExpertSkills.map((skill) => [`${skill.scope}:${skill.name}`, skill] as const),
    );
    return selectedExpertSkillKeys
      .map((key) => byKey.get(key as `${"workspace" | "tenant"}:${string}`) ?? null)
      .filter((skill): skill is SkillSummary => skill !== null);
  }, [availableExpertSkills, selectedExpertSkillKeys]);
  const selectedExpertHelperLabel = useMemo(() => {
    if (!selectedExpertSkillRecords.length) {
      return null;
    }
    return `本轮将按 ${selectedExpertSkillRecords.map((skill) => expertDisplayName(skill.name)).join("、")} 视角分别检索并形成意见`;
  }, [selectedExpertSkillRecords]);
  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(API_KEY_STORAGE_KEY, apiKey.trim());
      window.localStorage.setItem(USER_ID_STORAGE_KEY, userId.trim());
    }
  }, [apiKey, userId]);

  useEffect(() => {
    if (typeof window !== "undefined") {
      window.localStorage.setItem(MODEL_BASE_URL_STORAGE_KEY, modelBaseUrl.trim());
      window.localStorage.setItem(MODEL_API_KEY_STORAGE_KEY, modelApiKey.trim());
      window.localStorage.setItem(MODEL_NAME_STORAGE_KEY, modelName.trim());
    }
  }, [modelApiKey, modelBaseUrl, modelName]);

  useEffect(() => {
    const normalizedBaseUrl = modelBaseUrl.trim();
    const normalizedApiKey = modelApiKey.trim();
    const normalizedModelName = modelName.trim();

    if (!normalizedBaseUrl || !normalizedApiKey) {
      setDiscoveredModels(
        normalizedModelName
          ? [{ id: normalizedModelName, label: normalizedModelName, owner: "当前值" }]
          : [],
      );
      setModelDiscoveryState("idle");
      setModelDiscoveryMessage(null);
      return;
    }

    let cancelled = false;
    setModelDiscoveryState("loading");
    setModelDiscoveryMessage(null);

    void fetchProviderModels(normalizedBaseUrl, normalizedApiKey)
      .then((items) => {
        if (cancelled) {
          return;
        }
        const withCurrent =
          normalizedModelName && !items.some((item) => item.id === normalizedModelName)
            ? [{ id: normalizedModelName, label: normalizedModelName, owner: "当前值" }, ...items]
            : items;
        setDiscoveredModels(withCurrent);
        setModelDiscoveryState("ready");
        setModelDiscoveryMessage(`已读取 ${items.length} 个模型`);
      })
      .catch((cause) => {
        if (cancelled) {
          return;
        }
        setDiscoveredModels(fallbackModelOptions(normalizedModelName));
        setModelDiscoveryState("fallback");
        setModelDiscoveryMessage(
          cause instanceof Error
            ? `自动获取失败，已切换到备用列表：${cause.message}`
            : "自动获取失败，已切换到备用列表。",
        );
      });

    return () => {
      cancelled = true;
    };
  }, [modelApiKey, modelBaseUrl, modelName]);

  useEffect(() => {
    if (!activeAuth || !selectedProjectId) {
      setSelectedProjectDetail(null);
      setProjectEditor(null);
      setProjectDetailLoading(false);
      return;
    }

    const seededProject = projects.find((project) => project.id === selectedProjectId) ?? null;
    if (seededProject) {
      setSelectedProjectDetail(seededProject);
      setProjectEditor(projectSettingsDraftFromProject(seededProject));
    } else {
      setSelectedProjectDetail(null);
      setProjectEditor(null);
    }

    let cancelled = false;
    setProjectDetailLoading(true);
    void getProject(selectedProjectId, activeAuth)
      .then((project) => {
        if (cancelled) {
          return;
        }
        setSelectedProjectDetail(project);
        const nextDraft = projectSettingsDraftFromProject(project);
        setProjectEditor((current) => {
          if (!current || current.id !== project.id) {
            return nextDraft;
          }
          return projectDraftMatchesProject(current, seededProject ?? project) ? nextDraft : current;
        });
      })
      .catch((cause) => {
        if (cancelled) {
          return;
        }
        setError(cause instanceof Error ? cause.message : String(cause));
      })
      .finally(() => {
        if (!cancelled) {
          setProjectDetailLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activeAuth?.apiKey, activeAuth?.userId, selectedProjectId]);

  useEffect(() => {
    if (!currentProject) {
      return;
    }

    setWorkspaceRoot(currentProject.workspace_root);
    if (currentProject.default_permission_mode) {
      setPermissionMode(currentProject.default_permission_mode);
    }
  }, [currentProject]);

  useEffect(() => {
    if (!activeAuth || !currentProject?.workspace_root) {
      setProjectSkillOptions([]);
      setProjectSkillOptionsLoading(false);
      return;
    }

    let cancelled = false;
    setProjectSkillOptionsLoading(true);
    void listSkills(
      {
        projectId: currentProject.id,
        workspaceRoot: currentProject.workspace_root,
      },
      activeAuth,
    )
      .then((items) => {
        if (!cancelled) {
          setProjectSkillOptions(items);
        }
      })
      .catch((cause) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setProjectSkillOptionsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [activeAuth?.apiKey, activeAuth?.userId, currentProject?.id, currentProject?.workspace_root]);

  useEffect(() => {
    if (!activeAuth || !selectedThread) {
      setThreadSkillOptions([]);
      setThreadSkillOptionsLoading(false);
      setSelectedExpertSkillKeys([]);
      return;
    }

    let cancelled = false;
    setThreadSkillOptionsLoading(true);
    void listSkills(
      {
        projectId: selectedThread.project_id ?? undefined,
        workspaceRoot: selectedThread.project_id ? selectedThread.workspace_root : undefined,
      },
      activeAuth,
    )
      .then((items) => {
        if (!cancelled) {
          setThreadSkillOptions(items);
          setSelectedExpertSkillKeys((current) => {
            const knownKeys = new Set(
              [...items, ...BUILTIN_EXPERT_SKILLS].map((skill) => `${skill.scope}:${skill.name}`),
            );
            return current.filter((key) => knownKeys.has(key));
          });
        }
      })
      .catch((cause) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setThreadSkillOptionsLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [
    activeAuth?.apiKey,
    activeAuth?.userId,
    selectedThread?.id,
    selectedThread?.project_id,
    selectedThread?.workspace_root,
  ]);

  useEffect(() => {
    const bootstrap = async () => {
      setLoading(true);
      try {
        const serviceConfig = await getConfig();
        setConfig(serviceConfig);
        setPermissionMode(serviceConfig.default_permission_mode);

        if (!activeAuth) {
          setThreads([]);
          setProjects([]);
          setKnowledgeBases([]);
          setDataSources([]);
          setSelectedThread(null);
          setCreateThreadMode(false);
          setSelectedProjectDetail(null);
          setProjectEditor(null);
          setTopicDraft("");
          setSelectedProjectId("");
          setActiveProjectFilter("all");
          setAuthSession(null);
          setManagedApiKeys([]);
          setLatestCreatedApiKey(null);
          setError(
            serviceConfig.dev_user_header_auth_enabled
              ? "请输入 API 密钥，或在开发模式下填写用户标识。"
              : "请输入 API 密钥。",
          );
          return;
        }

        const [session, items, listedProjects, listedKnowledgeBases, listedDataSources] = await Promise.all([
          getAuthSession(activeAuth),
          listThreads(activeAuth),
          listProjects(activeAuth),
          listKnowledgeBases(activeAuth),
          listDataSources(activeAuth),
        ]);
        setAuthSession(session);
        setProjects(listedProjects);
        setKnowledgeBases(listedKnowledgeBases);
        setDataSources(listedDataSources);
        if (session.tenant_id) {
          setApiKeysLoading(true);
          setManagedApiKeys(await listApiKeys(activeAuth));
        } else {
          setManagedApiKeys([]);
        }
        setThreads(items);
        if (items[0]) {
          const snapshot = sanitizeThreadSnapshot(await getThread(items[0].id, activeAuth));
          setSelectedThread(snapshot);
          setCreateThreadMode(false);
          setTopicDraft(snapshot.topic ?? "");
          setWorkspaceRoot(snapshot.workspace_root);
          setSelectedProjectId(snapshot.project_id ?? "");
          setActiveProjectFilter(filterKeyForThread(snapshot));
        } else if (listedProjects[0]) {
          setSelectedProjectId(listedProjects[0].id);
          setWorkspaceRoot(listedProjects[0].workspace_root);
        } else {
          setSelectedThread(null);
          setCreateThreadMode(false);
          setTopicDraft("");
          setSelectedProjectId("");
          setActiveProjectFilter("all");
        }
        setLatestCreatedApiKey(null);
        setError(null);
      } catch (cause) {
        setThreads([]);
        setProjects([]);
        setKnowledgeBases([]);
        setDataSources([]);
        setSelectedThread(null);
        setCreateThreadMode(false);
        setSelectedProjectDetail(null);
        setProjectEditor(null);
        setTopicDraft("");
        setSelectedProjectId("");
        setActiveProjectFilter("all");
        setAuthSession(null);
        setManagedApiKeys([]);
        setLatestCreatedApiKey(null);
        setError(cause instanceof Error ? cause.message : String(cause));
      } finally {
        setApiKeysLoading(false);
        setLoading(false);
      }
    };

    void bootstrap();
  }, [activeAuth?.apiKey, activeAuth?.userId]);

  useEffect(() => {
    setWorkbenchTab("results");
    setInlineBoundaryMode(null);
    setWorkbenchOpen(false);
    setHighlightedEvidenceId(null);
    setHighlightedEvidenceAnchor(null);
    setHighlightedArtifactId(null);
    setHighlightedArtifactAnchor(null);
  }, [selectedThread?.id]);

  useEffect(() => {
    if (!settingsOpen) {
      return;
    }

    setWorkbenchOpen(false);
    setModelSettingsOpen(false);
    setManagementOpen(false);

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSettingsOpen(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [settingsOpen]);

  useEffect(() => {
    if (!modelSettingsOpen) {
      return;
    }

    setSettingsOpen(false);
    setWorkbenchOpen(false);
    setManagementOpen(false);

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setModelSettingsOpen(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [modelSettingsOpen]);

  useEffect(() => {
    if (!managementOpen) {
      return;
    }

    setSettingsOpen(false);
    setModelSettingsOpen(false);
    setWorkbenchOpen(false);

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setManagementOpen(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [managementOpen]);

  useEffect(() => {
    if (!workbenchOpen) {
      return;
    }

    setSettingsOpen(false);
    setModelSettingsOpen(false);
    setManagementOpen(false);

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setWorkbenchOpen(false);
      }
    };

    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, [workbenchOpen]);

  useEffect(() => {
    if (surface !== "workbench") {
      setSettingsOpen(false);
      setModelSettingsOpen(false);
      setManagementOpen(false);
      setWorkbenchOpen(false);
    }
  }, [surface]);

  useEffect(() => {
    eventSourceRef.current?.close();
    if (!selectedThread || !activeAuth) {
      return;
    }

    const source = new EventSource(threadEventsUrl(selectedThread.id, activeAuth));
    eventSourceRef.current = source;

    const pushEvent = (kind: string, payload: unknown) => {
      setEvents((current) => [
        {
          id: `${Date.now()}-${Math.random()}`,
          kind,
          at: Date.now(),
          detail: summarizePayload(payload),
        },
        ...current,
      ].slice(0, 24));
    };

    source.addEventListener("snapshot", (event) => {
      const rawSnapshot = JSON.parse((event as MessageEvent<string>).data) as ThreadSnapshot;
      const snapshot = sanitizeThreadSnapshot(rawSnapshot);
      setSelectedThread(snapshot);
      setThreads((current) => mergeSummary(current, snapshot));
      setTopicDraft(snapshot.topic ?? "");
      setSelectedProjectId(snapshot.project_id ?? "");
      pushEvent("snapshot", snapshot.status);
    });

    const bindEnvelope = (kind: string) => {
      source.addEventListener(kind, (event) => {
        const envelope = JSON.parse(
          (event as MessageEvent<string>).data,
        ) as ThreadEventEnvelope;
        pushEvent(kind, envelope.payload);

        if (isThreadSnapshot(envelope.payload)) {
          const snapshot = sanitizeThreadSnapshot(envelope.payload);
          setSelectedThread(snapshot);
          setThreads((current) => mergeSummary(current, snapshot));
          setSelectedProjectId(snapshot.project_id ?? "");
          setSelectedKnowledgeBaseId(snapshot.knowledge_base_id ?? "");
          if (kind !== "assistant_text_delta") {
            setTopicDraft(snapshot.topic ?? "");
          }
          return;
        }

        if (kind === "assistant_text_delta") {
          const payload = envelope.payload as { text?: string };
          setSelectedThread((current) =>
            current
              ? {
                  ...current,
                  draft_assistant_text: `${current.draft_assistant_text}${payload.text ?? ""}`,
                }
              : current,
          );
          return;
        }

        if (kind === "artifact_added") {
          const payload = envelope.payload as ArtifactRecord;
          setSelectedThread((current) =>
            current
              ? { ...current, artifacts: appendArtifact(current.artifacts, payload) }
              : current,
          );
          return;
        }

        if (kind === "audit_added") {
          const payload = envelope.payload as AuditRecord;
          setSelectedThread((current) =>
            current
              ? { ...current, audit_records: appendAuditRecord(current.audit_records, payload) }
              : current,
          );
        }
      });
    };

    [
      "run_started",
      "status_changed",
      "assistant_text_delta",
      "tool_use",
      "tool_result",
      "artifact_added",
      "audit_added",
      "run_completed",
      "run_failed",
    ].forEach(bindEnvelope);

    source.onerror = () => {
      pushEvent("sse_error", "event stream disconnected");
    };

    return () => {
      source.close();
    };
  }, [selectedThread?.id, activeAuth?.apiKey, activeAuth?.userId]);

  async function refreshThread(threadId: string) {
    if (!activeAuth) {
      return;
    }
    const snapshot = sanitizeThreadSnapshot(await getThread(threadId, activeAuth));
    setSelectedThread(snapshot);
    setCreateThreadMode(false);
    setThreads((current) => mergeSummary(current, snapshot));
    setTopicDraft(snapshot.topic ?? "");
    setWorkspaceRoot(snapshot.workspace_root);
    setSelectedProjectId(snapshot.project_id ?? "");
    setSelectedKnowledgeBaseId(snapshot.knowledge_base_id ?? "");
    setActiveProjectFilter(filterKeyForThread(snapshot));
  }

  function openCreateThreadMode(options?: {
    topic?: string;
    launchPrompt?: string;
    projectId?: string;
    knowledgeBaseId?: string;
    workspaceRoot?: string;
  }) {
    setManagementOpen(false);
    setModelSettingsOpen(false);
    setSettingsOpen(false);
    setWorkbenchOpen(false);
    setInlineBoundaryMode(null);
    setCreateThreadMode(true);
    setSelectedProjectId(options?.projectId?.trim() ?? "");
    setSelectedKnowledgeBaseId(options?.knowledgeBaseId?.trim() ?? "");
    setWorkspaceRoot(options?.workspaceRoot?.trim() ?? "");
    setTopic(options?.topic?.trim() ?? "");
    setLaunchPrompt(options?.launchPrompt?.trim() ?? "");
    setPermissionMode(config?.default_permission_mode ?? "read-only");
    setActiveProjectFilter("all");
  }

  async function refreshApiKeys(auth: RequestAuth) {
    setApiKeysLoading(true);
    try {
      setManagedApiKeys(await listApiKeys(auth));
    } finally {
      setApiKeysLoading(false);
    }
  }

  async function handleCreateThread(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeAuth) {
      setError("缺少认证信息。");
      return;
    }
    if (hasStandaloneModelConfig && !standaloneModelReady) {
      setError("独立模型配置尚未完成，请同时填写 API 地址、API 密钥，并选择模型。");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const createThreadPayload = {
        workspace_root: selectedProjectId ? undefined : undefined,
        project_id: selectedProjectId || undefined,
        knowledge_base_id: selectedKnowledgeBaseId || undefined,
        model: modelName.trim() || undefined,
        model_base_url: modelBaseUrl.trim() || undefined,
        model_api_key: modelApiKey.trim() || undefined,
        topic,
        permission_mode: permissionMode,
      };
      const created = sanitizeThreadSnapshot(await createThread(createThreadPayload, activeAuth));
      setActiveProjectFilter(filterKeyForThread(created));
      setSelectedThread(created);
      setCreateThreadMode(false);
      setThreads((current) => mergeSummary(current, created));
      setTopicDraft(created.topic ?? "");
      setWorkspaceRoot(created.workspace_root);
      setSelectedProjectId(created.project_id ?? "");
      setSelectedKnowledgeBaseId(created.knowledge_base_id ?? "");

      const seededLaunchPrompt = launchPrompt.trim();
      if (seededLaunchPrompt) {
        const launched = sanitizeThreadSnapshot(await sendThreadCommand(created.id, {
          type: "user_message",
          content: seededLaunchPrompt,
        }, activeAuth));
        setSelectedThread(launched);
        setCreateThreadMode(false);
        setThreads((current) => mergeSummary(current, launched));
        setTopicDraft(launched.topic ?? "");
        setLaunchPrompt("");
      }
      setSettingsOpen(false);
      setModelSettingsOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function handleCreateKnowledgeBase(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeAuth) {
      setError("缺少认证信息。");
      return;
    }
    if (!knowledgeBaseForm.name.trim()) {
      setError("请填写资料库名称。");
      return;
    }

    setKnowledgeLoading(true);
    setError(null);
    try {
      const created = await createKnowledgeBase({
        name: knowledgeBaseForm.name.trim(),
        description: knowledgeBaseForm.description.trim() || undefined,
        default_project_id: selectedProjectId || undefined,
      }, activeAuth);
      setKnowledgeBases((current) => [created, ...current].sort((left, right) => right.updated_at_ms - left.updated_at_ms));
      setKnowledgeBaseForm({ name: "", description: "" });
      setDataSourceForm((current) => ({
        ...current,
        knowledgeBaseId: created.id,
        name: current.name || created.name,
      }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setKnowledgeLoading(false);
    }
  }

  async function handleCreateDataSource() {
    if (!activeAuth) {
      setError("缺少认证信息。");
      return;
    }
    if (!dataSourceForm.knowledgeBaseId.trim()) {
      setError("请先选择资料库。");
      return;
    }
    if (!dataSourceForm.name.trim()) {
      setError("请填写来源名称。");
      return;
    }
    const configPayload = dataSourceConfigPayload(dataSourceForm);

    setKnowledgeLoading(true);
    setError(null);
    try {
      const saved = dataSourceForm.editingSourceId
        ? await updateDataSource(
            dataSourceForm.editingSourceId,
            {
              name: dataSourceForm.name.trim(),
              description: dataSourceForm.description.trim() || undefined,
              config: configPayload,
            },
            activeAuth,
          )
        : await createDataSource({
            knowledge_base_id: dataSourceForm.knowledgeBaseId,
            name: dataSourceForm.name.trim(),
            kind: dataSourceForm.kind,
            description: dataSourceForm.description.trim() || undefined,
            config: configPayload,
          }, activeAuth);
      setDataSources((current) =>
        [saved, ...current.filter((item) => item.id !== saved.id)].sort(
          (left, right) => right.updated_at_ms - left.updated_at_ms,
        ),
      );
      setDataSourceForm((current) => ({
        ...current,
        editingSourceId: "",
        name: "",
        description: "",
        endpoint: "",
        indexName: "",
        apiKey: "",
        username: "",
        password: "",
        path: "",
        urls: "",
        dbUrl: "",
        dbSchema: "",
      }));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setKnowledgeLoading(false);
    }
  }

  function openDataSourceDraft(kind: DataSourceKind, knowledgeBaseId?: string | null) {
    const targetKnowledgeBaseId =
      knowledgeBaseId?.trim() || selectedKnowledgeBaseId || dataSourceForm.knowledgeBaseId;
    const knowledgeBaseName =
      knowledgeBases.find((item) => item.id === targetKnowledgeBaseId)?.name ?? null;
    setDataSourceTestResult(null);
    setDataSourceForm({
      editingSourceId: "",
      knowledgeBaseId: targetKnowledgeBaseId,
      name: defaultDataSourceName(kind, knowledgeBaseName),
      kind,
      description: "",
      endpoint: "",
      indexName: "",
      apiKey: "",
      username: "",
      password: "",
      path: "",
      urls: "",
      dbUrl: "",
      dbSchema: "",
    });
    setDataSourcePanelOpen(true);
    setManagementOpen(true);
    setSettingsOpen(false);
  }

  async function handleUploadDataSourceFile(
    source: DataSourceSummary,
    file: File | File[],
  ) {
    if (!activeAuth) {
      setError("缺少认证信息。");
      return;
    }
    setUploadingDataSourceId(source.id);
    setError(null);
    try {
      const files = Array.isArray(file) ? file : [file];
      for (const item of files) {
        await uploadDataSourceFile(source.id, item, activeAuth);
      }
      const refreshed = await listDataSources(activeAuth);
      setDataSources(refreshed.sort((left, right) => right.updated_at_ms - left.updated_at_ms));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setUploadingDataSourceId(null);
    }
  }

  async function handleDeleteDataSource(source: DataSourceSummary) {
    if (!activeAuth) {
      setError("缺少认证信息。");
      return;
    }
    setRemovingDataSourceId(source.id);
    setError(null);
    try {
      await deleteDataSource(source.id, activeAuth);
      const refreshed = await listDataSources(activeAuth);
      setDataSources(refreshed.sort((left, right) => right.updated_at_ms - left.updated_at_ms));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRemovingDataSourceId(null);
    }
  }

  async function handleDeleteDataSourceFile(source: DataSourceSummary, fileId: string) {
    if (!activeAuth) {
      setError("缺少认证信息。");
      return;
    }
    setRemovingDataSourceFileId(fileId);
    setError(null);
    try {
      await deleteDataSourceFile(source.id, fileId, activeAuth);
      const refreshed = await listDataSources(activeAuth);
      setDataSources(refreshed.sort((left, right) => right.updated_at_ms - left.updated_at_ms));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setRemovingDataSourceFileId(null);
    }
  }

  async function handleEditDataSource(source: DataSourceSummary) {
    if (!activeAuth) {
      setError("缺少认证信息。");
      return;
    }
    setKnowledgeLoading(true);
    setError(null);
    setDataSourceTestResult(null);
    try {
      const detail = await getDataSource(source.id, activeAuth);
      setDataSourceForm(populateDataSourceFormFromDetail(detail));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setKnowledgeLoading(false);
    }
  }

  function handleResetDataSourceForm() {
    setDataSourceForm((current) => ({
      ...current,
      editingSourceId: "",
      name: "",
      description: "",
      endpoint: "",
      indexName: "",
      apiKey: "",
      username: "",
      password: "",
      path: "",
      urls: "",
      dbUrl: "",
      dbSchema: "",
    }));
    setDataSourceTestResult(null);
  }

  async function handleTestDataSource() {
    if (!activeAuth) {
      setError("缺少认证信息。");
      return;
    }
    setDataSourceTesting(true);
    setError(null);
    setDataSourceTestResult(null);
    try {
      const result = await testDataSource(
        {
          kind: dataSourceForm.kind,
          config: dataSourceConfigPayload(dataSourceForm),
        },
        activeAuth,
      );
      setDataSourceTestResult(result);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setDataSourceTesting(false);
    }
  }

  async function handleRetestSavedDataSource(source: DataSourceSummary) {
    if (!activeAuth) {
      setError("缺少认证信息。");
      return;
    }
    setCardTestingDataSourceId(source.id);
    setError(null);
    try {
      const result = await testSavedDataSource(source.id, activeAuth);
      const detail = await getDataSource(source.id, activeAuth);
      setDataSources((current) =>
        current
          .map((item) => (item.id === detail.id ? detail : item))
          .sort((left, right) => right.updated_at_ms - left.updated_at_ms),
      );
      if (dataSourceForm.editingSourceId === source.id) {
        setDataSourceTestResult(result);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setCardTestingDataSourceId(null);
    }
  }

  function updateProjectEditorField<Key extends keyof ProjectSettingsDraft>(
    key: Key,
    value: ProjectSettingsDraft[Key],
  ) {
    setProjectEditor((current) => (current ? { ...current, [key]: value } : current));
  }

  function handleResetProjectEditor() {
    if (!currentProject) {
      return;
    }
    setProjectEditor(projectSettingsDraftFromProject(currentProject));
  }

  function toggleProjectSkill(skill: SkillSummary) {
    const canonical = canonicalSkillName(skill);
    setProjectEditor((current) => {
      if (!current) {
        return current;
      }

      const selected = parseSkillNameList(current.defaultSkillNames);
      const next = selected.includes(canonical)
        ? selected.filter((item) => item !== canonical)
        : [...selected, canonical];
      return {
        ...current,
        defaultSkillNames: next.join("\n"),
      };
    });
  }

  async function handleSaveProjectSettings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeAuth || !projectEditor || !selectedProjectId) {
      setError("缺少项目上下文。");
      return;
    }

    setProjectSaving(true);
    setError(null);
    try {
      const updated = await updateProject(
        selectedProjectId,
        projectUpdatePayloadFromDraft(projectEditor),
        activeAuth,
      );
      setProjects((current) => upsertProjectSummary(current, updated));
      setSelectedProjectDetail(updated);
      setProjectEditor(projectSettingsDraftFromProject(updated));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setProjectSaving(false);
    }
  }

  function handleUseStarterPromptInCurrentThread(prompt: string, _skillName: string) {
    const normalized = prompt.trim();
    if (!normalized || !selectedThread) {
      return;
    }

    setComposerSeed({
      text: normalized,
      nonce: Date.now(),
      threadId: selectedThread.id,
      mode: "replace",
    });
    setSettingsOpen(false);
    setModelSettingsOpen(false);
    setManagementOpen(false);
  }

  function handleUseSkillInCurrentThread(skill: SkillSummary) {
    const prompt =
      skill.starter_prompt?.trim() ||
      `请使用“${skill.name}”技能处理当前问题，并在发送前按我的补充要求调整。`;
    handleUseStarterPromptInCurrentThread(prompt, skill.name);
  }

  function toggleExpertSkill(skill: SkillSummary) {
    const key = `${skill.scope}:${skill.name}`;
    setSelectedExpertSkillKeys((current) =>
      current.includes(key) ? current.filter((item) => item !== key) : [...current, key],
    );
  }

  function openSkillManager() {
    setManagementOpen(true);
    setSettingsOpen(false);
    setModelSettingsOpen(false);
  }

  function handleInsertReferenceIntoCurrentThread(text: string) {
    const normalized = text.trim();
    if (!normalized || !selectedThread) {
      return;
    }

    setComposerSeed({
      text: normalized,
      nonce: Date.now(),
      threadId: selectedThread.id,
      mode: "append",
    });
  }

  function handleUseStarterPromptForNewThread(
    prompt: string,
    skillName: string,
    description: string | null | undefined,
  ) {
    const normalized = prompt.trim();
    if (!normalized) {
      return;
    }

    openCreateThreadMode({
      launchPrompt: normalized,
      topic: suggestedTopicFromSkill(skillName, description),
    });
  }

  async function sendUserMessage(content: string) {
    if (!selectedThread || !content.trim() || !activeAuth) {
      return;
    }
    setError(null);
    const optimisticUserText = content.trim();
    const expertPanel =
      selectedExpertSkillRecords.length > 0 ? buildExpertPanelContext(selectedExpertSkillRecords) : null;
    setSelectedThread((current) =>
      current
        ? {
            ...current,
            status: "running",
            last_error: null,
            updated_at_ms: Date.now(),
            messages: [
              ...current.messages,
              {
                role: "user",
                blocks: [{ type: "text", text: optimisticUserText }],
              },
            ],
          }
        : current,
    );
    try {
      const snapshot = sanitizeThreadSnapshot(await sendThreadCommand(selectedThread.id, {
        type: "user_message",
        content: optimisticUserText,
        expert_panel: expertPanel ?? undefined,
      }, activeAuth));
      setSelectedThread(snapshot);
      setThreads((current) => mergeSummary(current, snapshot));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      await refreshThread(selectedThread.id);
    }
  }

  async function handleInterrupt() {
    if (!selectedThread || !activeAuth) {
      return;
    }

    try {
      const snapshot = sanitizeThreadSnapshot(await sendThreadCommand(selectedThread.id, {
        type: "interrupt",
        reason: "用户在前端请求打断",
      }, activeAuth));
      setSelectedThread(snapshot);
      setThreads((current) => mergeSummary(current, snapshot));
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function handleReplan() {
    if (!selectedThread || !activeAuth) {
      return;
    }

    setBusy(true);
    try {
      const snapshot = sanitizeThreadSnapshot(await sendThreadCommand(selectedThread.id, {
        type: "replan",
        reason: replanReason,
        topic: topicDraft || undefined,
      }, activeAuth));
      setSelectedThread(snapshot);
      setThreads((current) => mergeSummary(current, snapshot));
      setInlineBoundaryMode(null);
      setWorkbenchOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  async function handleSetTopic() {
    if (!selectedThread || !topicDraft.trim() || !activeAuth) {
      return;
    }

    setBusy(true);
    try {
      const snapshot = sanitizeThreadSnapshot(await sendThreadCommand(selectedThread.id, {
        type: "set_topic",
        topic: topicDraft,
      }, activeAuth));
      setSelectedThread(snapshot);
      setThreads((current) => mergeSummary(current, snapshot));
      setInlineBoundaryMode(null);
      setWorkbenchOpen(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(false);
    }
  }

  function handleOpenEvidence(evidenceId: string, anchor: string | null = null) {
    setSettingsOpen(false);
    setModelSettingsOpen(false);
    setManagementOpen(false);
    setWorkbenchOpen(true);
    setWorkbenchTab("evidence");
    setHighlightedEvidenceId(evidenceId);
    setHighlightedEvidenceAnchor(anchor);
    setHighlightedArtifactId(null);
    setHighlightedArtifactAnchor(null);
  }

  function handleOpenArtifact(artifactId: string, anchor: string | null = null) {
    setSettingsOpen(false);
    setModelSettingsOpen(false);
    setManagementOpen(false);
    setWorkbenchOpen(true);
    setWorkbenchTab("results");
    setHighlightedArtifactId(artifactId);
    setHighlightedArtifactAnchor(anchor);
    setHighlightedEvidenceId(null);
    setHighlightedEvidenceAnchor(null);
  }

  function workbenchSummaryLabel() {
    if (!selectedThread) {
      return "暂无结果";
    }

    if (selectedThread.artifacts.length) {
      return `${selectedThread.artifacts.length} 份结果`;
    }

    if (evidenceEntries.length) {
      return `${evidenceEntries.length} 条来源`;
    }

    if (selectedThread.status === "running" || selectedThread.status === "interrupt_requested") {
      return "任务运行中";
    }

    return "查看进展";
  }

  function openWorkbench() {
    if (!selectedThread) {
      return;
    }

    setSettingsOpen(false);
    setModelSettingsOpen(false);
    setManagementOpen(false);
    setWorkbenchOpen(true);
    setWorkbenchTab(
      selectedThread.artifacts.length
        ? "results"
        : evidenceEntries.length
          ? "evidence"
          : "timeline",
    );
  }

  async function handleCreateApiKey(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!activeAuth || !authSession?.tenant_id) {
      setError("当前会话不具备团队级 API 密钥管理能力。");
      return;
    }

    setApiKeysBusy(true);
    setError(null);
    try {
      const created = await createApiKey(apiKeyDisplayName, activeAuth);
      setLatestCreatedApiKey(created);
      setApiKeyDisplayName("");
      await refreshApiKeys(activeAuth);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setApiKeysBusy(false);
    }
  }

  async function handleDisableApiKey(apiKeyId: string) {
    if (!activeAuth || !authSession?.tenant_id) {
      return;
    }

    setApiKeysBusy(true);
    setError(null);
    try {
      await disableApiKey(apiKeyId, activeAuth);
      await refreshApiKeys(activeAuth);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setApiKeysBusy(false);
    }
  }

  function handleResetModelConfig() {
    setModelBaseUrl("");
    setModelApiKey("");
    setModelName("");
  }

  function handleSelectProjectForThread(nextProjectId: string) {
    setSelectedProjectId(nextProjectId);
    if (!nextProjectId) {
      setSelectedKnowledgeBaseId("");
      setWorkspaceRoot("");
      setActiveProjectFilter("all");
      return;
    }
    const project = projects.find((item) => item.id === nextProjectId) ?? null;
    if (!project) {
      return;
    }
    const relatedKnowledgeBase = knowledgeBases.find(
      (item) => item.default_project_id === project.id,
    );
    setSelectedKnowledgeBaseId(relatedKnowledgeBase?.id ?? "");
    setWorkspaceRoot(project.workspace_root);
    setActiveProjectFilter(projectFilterKey(project.id));
  }

  const surfaceTitle =
    surface === "operations"
      ? "管理控制台"
      : surface === "auth"
        ? "连接到 Web Agent 服务"
        : "Web Agent";
  const surfaceCopy =
    surface === "operations"
      ? "接入、限额、事件与审计集中放在独立控制台，默认聊天界面不再混入后台诊断。"
      : surface === "auth"
        ? "先完成 API 密钥接入，再进入面向研究、分析和交付的 Web Agent 界面。"
        : "以聊天为主入口，支持检索、文件阅读、结构化结论、引用追踪、打断与重规划。";

  function clearWorkbenchHighlights(nextTab?: WorkbenchTabId) {
    if (nextTab !== "evidence") {
      setHighlightedEvidenceId(null);
      setHighlightedEvidenceAnchor(null);
    }

    if (nextTab !== "results") {
      setHighlightedArtifactId(null);
      setHighlightedArtifactAnchor(null);
    }
  }

  const selectedThreadAlert = presentThreadAlert(selectedThread);
  const surfaceErrorMessage =
    surface === "workbench" ? presentWorkbenchError(error) : null;

  return (
    <div className="app-shell">
      {surface === "workbench" ? null : (
        <div className="hero-panel">
          <div>
            <p className="eyebrow">Web Agent</p>
            <h1>{surfaceTitle}</h1>
            <p className="hero-copy">{surfaceCopy}</p>
          </div>
          <div className="hero-panel-side">
            {operatorMode ? (
              <div className="surface-switch" role="tablist" aria-label="App surfaces">
                <button
                  aria-selected={false}
                  className="secondary surface-toggle"
                  onClick={() => setRequestedSurface("workbench")}
                  role="tab"
                  type="button"
                >
                  聊天
                </button>
                <button
                  aria-selected={surface === "operations"}
                  className={`secondary surface-toggle ${
                    surface === "operations" ? "active" : ""
                  }`}
                  disabled={!activeAuth}
                  onClick={() => setRequestedSurface("operations")}
                  role="tab"
                  type="button"
                >
                  管理控制台
                </button>
              </div>
            ) : null}
            <div className="hero-meta hero-meta-compact">
              {surface === "operations" ? (
                <>
                  <span>认证</span>
                  <strong>{activeAuth ? authModeLabel(authSession?.auth_mode) : "未接入"}</strong>
                  <span>账号域</span>
                  <strong>{authSession?.tenant_id ?? "个人"}</strong>
                  <span>数据库</span>
                  <strong>{config?.database_backend ?? "未知"}</strong>
                  <span>版本</span>
                  <strong>
                    {config?.database_schema_version
                      ? `v${config.database_schema_version}`
                      : "未知"}
                  </strong>
                </>
              ) : (
                <>
                  <span>API</span>
                  <strong>{apiBaseUrl()}</strong>
                  <span>模式</span>
                  <strong>聊天优先</strong>
                </>
              )}
            </div>
          </div>
        </div>
      )}

      {surface === "auth" ? (
        <div className="auth-layout">
          <ServiceAccessPanel
            apiKey={apiKey}
            authSession={authSession}
            config={config}
            onApiKeyChange={setApiKey}
            onUserIdChange={setUserId}
            title="接入服务"
            userId={userId}
          />
          <article className="card operator-card auth-preview-card">
            <div className="section-title">服务概览</div>
            <div className="service-facts">
              <span>API {apiBaseUrl()}</span>
              <span>默认权限 {presentPermissionMode(config?.default_permission_mode)}</span>
              <span>数据库 {config?.database_backend ?? "未知"}</span>
              <span>资料接入 连接式</span>
            </div>
            <p className="hero-copy">
              完成认证后，主界面会回到聊天优先的研究空间；结果、来源与过程记录会放在抽屉里集中查看。
            </p>
          </article>
        </div>
      ) : surface === "operations" ? (
        <OperatorConsole
          activeAuth={activeAuth}
          apiKey={apiKey}
          apiKeyDisplayName={apiKeyDisplayName}
          apiKeysBusy={apiKeysBusy}
          apiKeysLoading={apiKeysLoading}
          authSession={authSession}
          config={config}
          events={events}
          latestCreatedApiKey={latestCreatedApiKey}
          managedApiKeys={managedApiKeys}
          onApiKeyChange={setApiKey}
          onApiKeyDisplayNameChange={setApiKeyDisplayName}
          onCreateApiKey={handleCreateApiKey}
          onDisableApiKey={handleDisableApiKey}
          onDismissLatestCreatedApiKey={() => setLatestCreatedApiKey(null)}
          onUseLatestCreatedApiKey={() => {
            if (latestCreatedApiKey) {
              setApiKey(latestCreatedApiKey.raw_key);
            }
          }}
          onUserIdChange={setUserId}
          selectedThread={selectedThread}
          userId={userId}
        />
      ) : (
        <WorkbenchShell
          topBar={
            <>
              <div className="web-agent-brand">
                <span className="web-agent-logo" aria-hidden="true">WA</span>
                <div>
                  <strong>Web Agent</strong>
                  <span>{selectedThread?.topic ?? "聊天优先研究工作台"}</span>
                </div>
              </div>
              <div className="web-agent-topbar-actions">
                {operatorMode ? (
                  <button
                    className="secondary web-agent-icon-button"
                    disabled={!activeAuth}
                    onClick={() => setRequestedSurface("operations")}
                    title="打开管理控制台"
                    type="button"
                  >
                    管理台
                  </button>
                ) : null}
                <button
                  className="secondary web-agent-icon-button primary"
                  onClick={() => openCreateThreadMode()}
                  type="button"
                >
                  新建会话
                </button>
                <button
                  className={`secondary web-agent-icon-button ${modelSettingsOpen ? "active" : ""}`}
                  onClick={() => setModelSettingsOpen(true)}
                  type="button"
                >
                  模型
                </button>
                <button
                  className={`secondary web-agent-icon-button ${managementOpen ? "active" : ""}`}
                  onClick={() => setManagementOpen(true)}
                  type="button"
                >
                  管理
                </button>
                <button
                  className={`secondary web-agent-icon-button ${settingsOpen ? "active" : ""}`}
                  onClick={() => setSettingsOpen(true)}
                  type="button"
                >
                  设置
                </button>
              </div>
            </>
          }
          leftRail={
            <div className="context-rail-stack">
              <section className="rail-section">
                <div className="rail-section-header">
                  <div>
                    <span className="eyebrow">会话</span>
                    <strong>最近会话</strong>
                  </div>
                  <button
                    className="secondary rail-mini-action"
                    onClick={() => openCreateThreadMode()}
                    type="button"
                  >
                    新建
                  </button>
                </div>
                <div className="thread-list-header">
                  <button
                    className={`secondary filter-pill ${activeProjectFilter === "all" ? "active" : ""}`}
                    onClick={() => setActiveProjectFilter("all")}
                    type="button"
                  >
                    全部
                  </button>
                  {activeProjectFilter !== "all" && activeProjectGroup ? (
                    <span className="input-hint">{activeProjectGroup.label}</span>
                  ) : null}
                </div>
                {loading ? (
                  <div className="empty-state">加载中...</div>
                ) : visibleThreads.length === 0 ? (
                  <div className="empty-state">还没有会话</div>
                ) : (
                  <div className="rail-thread-list">
                    {visibleThreads.slice(0, 12).map((thread) => (
                      <button
                        className={`rail-thread-item ${selectedThread?.id === thread.id ? "active" : ""}`}
                        key={thread.id}
                        onClick={() => {
                          void refreshThread(thread.id);
                          setCreateThreadMode(false);
                        }}
                        type="button"
                      >
                        <span className={`status-dot status-${thread.status}`} />
                        <div>
                          <strong>{thread.topic ?? "未命名主题"}</strong>
                          <span>{activeKnowledgeLabel(thread)}</span>
                          <span>{formatTime(thread.updated_at_ms)}</span>
                        </div>
                      </button>
                    ))}
                  </div>
                )}
              </section>

              <section className="rail-section">
                <div className="rail-section-header">
                  <div>
                    <span className="eyebrow">资料</span>
                    <strong>上下文</strong>
                  </div>
                  <button
                    className="secondary rail-mini-action"
                    onClick={() => setManagementOpen(true)}
                    type="button"
                  >
                    管理
                  </button>
                </div>
                <article className="rail-context-card">
                  <strong>
                    {activeKnowledgeLabel({
                      projectName: currentProject?.name ?? selectedThread?.project_name,
                      knowledgeBaseName:
                        selectedThread?.knowledge_base_name ??
                        knowledgeBases.find((item) => item.id === selectedKnowledgeBaseId)?.name ??
                        null,
                      workspaceRoot: currentProject?.workspace_root ?? selectedThread?.workspace_root ?? workspaceRoot,
                    })}
                  </strong>
                  <span>
                    {selectedThread?.knowledge_base_name || selectedKnowledgeBaseId
                      ? "已绑定资料库"
                      : selectedThread?.project_name || selectedProjectId
                        ? "项目上下文"
                        : "纯聊天模式"}
                  </span>
                  <div className="rail-context-metrics">
                    <span>{knowledgeBases.length} 个资料库</span>
                    <span>{dataSources.length} 个来源</span>
                    <span>{dataSources.reduce((count, source) => count + source.uploaded_files.length, 0)} 份上传</span>
                  </div>
                </article>
                <div className="rail-source-list">
                  {dataSources.slice(0, 5).map((source) => (
                    <div className="rail-source-item" key={source.id}>
                      <div>
                        <strong>{source.name}</strong>
                        <span>{dataSourceKindLabel(source.kind)}</span>
                      </div>
                      <span>{dataSourceCardStateLabel(source)}</span>
                    </div>
                  ))}
                  {dataSources.length === 0 ? (
                    <div className="empty-state">还没有资料来源</div>
                  ) : null}
                </div>
              </section>
            </div>
          }
          rightRail={
            <div className="insight-rail-stack">
              <section className="rail-section">
                <div className="rail-section-header">
                  <div>
                    <span className="eyebrow">视角</span>
                    <strong>专家会诊</strong>
                  </div>
                  <button
                    className="secondary rail-mini-action"
                    onClick={openSkillManager}
                    type="button"
                  >
                    技能
                  </button>
                </div>
                {threadSkillOptionsLoading ? (
                  <div className="empty-state">加载专家中...</div>
                ) : (
                  <div className="rail-expert-list">
                    {availableExpertSkills.slice(0, 8).map((skill) => {
                      const key = `${skill.scope}:${skill.name}`;
                      const selected = selectedExpertSkillKeys.includes(key);
                      return (
                        <button
                          className={`rail-expert-item ${selected ? "active" : ""}`}
                          key={key}
                          onClick={() => toggleExpertSkill(skill)}
                          type="button"
                        >
                          <strong>{expertDisplayName(skill.name)}</strong>
                          <span>{skill.description ?? presentSkillReference(skill.name)}</span>
                        </button>
                      );
                    })}
                  </div>
                )}
                <div className="rail-selection-note">
                  {selectedExpertSkillRecords.length
                    ? `已选择 ${selectedExpertSkillRecords.length} 位专家`
                    : "不选择专家时按普通聊天运行"}
                </div>
              </section>

              <section className="rail-section rail-workbench-section">
                <div className="rail-section-header">
                  <div>
                    <span className="eyebrow">工作区</span>
                    <strong>{workbenchSummaryLabel()}</strong>
                  </div>
                  <button
                    className="secondary rail-mini-action"
                    disabled={!selectedThread}
                    onClick={openWorkbench}
                    type="button"
                  >
                    放大
                  </button>
                </div>
                <Suspense
                  fallback={(
                    <article className="workbench-card workbench-card-embedded">
                      <div className="empty-pane">加载结果中...</div>
                    </article>
                  )}
                >
                  <LazyWorkbenchPanel
                    activeTab={workbenchTab}
                    embeddedShell
                    highlightedArtifactAnchor={highlightedArtifactAnchor}
                    highlightedArtifactId={highlightedArtifactId}
                    highlightedEvidenceAnchor={highlightedEvidenceAnchor}
                    highlightedEvidenceId={highlightedEvidenceId}
                    onInsertReference={handleInsertReferenceIntoCurrentThread}
                    onOpenArtifact={handleOpenArtifact}
                    onOpenEvidence={handleOpenEvidence}
                    onTabChange={(tab) => {
                      setWorkbenchTab(tab);
                      clearWorkbenchHighlights(tab);
                    }}
                    operatorMode={false}
                    showHeader={false}
                    thread={selectedThread}
                  />
                </Suspense>
              </section>
            </div>
          }
          overlays={
            <>
          {settingsOpen ? (
            <div className="settings-overlay">
              <button
                aria-label="关闭设置"
                className="settings-backdrop"
                onClick={() => setSettingsOpen(false)}
                type="button"
              />
              <aside className="card settings-drawer" role="dialog" aria-modal="true">
                <div className="settings-drawer-header">
                  <div>
                    <p className="eyebrow">设置</p>
                    <h2>会话与资料</h2>
                    <p className="hero-copy">
                      这里负责切换资料上下文和最近会话。中央聊天区仍然是主入口，资料接入与技能放在独立面板。
                    </p>
                  </div>
                  <div className="drawer-header-actions">
                    <button
                      className="secondary"
                      onClick={() => {
                        setSettingsOpen(false);
                        setManagementOpen(true);
                      }}
                      type="button"
                    >
                      打开管理
                    </button>
                    <button
                      className="secondary"
                      onClick={() => setSettingsOpen(false)}
                      type="button"
                    >
                      关闭
                    </button>
                  </div>
                </div>
                <div className="settings-drawer-body">
            <section>
              <div className="section-title">继续当前任务</div>
              {selectedThread ? (
                <article className="workspace-callout">
                  <header>
                    <strong>{threadProjectLabel(selectedThread)}</strong>
                    <span className={`status-pill status-${selectedThread.status}`}>
                      {threadStatusLabel(selectedThread.status)}
                    </span>
                  </header>
                  <p>{selectedThread.topic ?? "未设置主题"}</p>
                  <div className="workspace-meta">
                    <span>{contextBadgeLabel(selectedThread)}</span>
                    <span>{presentPermissionMode(selectedThread.permission_mode)}</span>
                    <span>{formatTime(selectedThread.updated_at_ms)}</span>
                  </div>
                </article>
              ) : (
                <div className="empty-state">
                  先创建或选择一个会话，中央聊天区会围绕这个主题继续分析。
                </div>
              )}
            </section>

            <section>
              <div className="section-title">开始新会话</div>
              <article className="workspace-callout">
                <header>
                  <strong>中央聊天区是主创建入口</strong>
                  <span className="input-hint">
                    {serviceModelStatusLabel({
                      standaloneModelReady,
                      hasStandaloneModelConfig,
                      modelName,
                    })}
                  </span>
                </header>
                <p>
                  在中央直接填写主题和起始消息即可开始。资料接入是可选能力，不再作为会话前提。
                </p>
                <div className="workspace-meta">
                  <span>{contextBadgeLabel({ projectName: currentProject?.name, workspaceRoot })}</span>
                  <span>{presentPermissionMode(permissionMode)}</span>
                </div>
                <div className="inline-actions">
                  <button
                    onClick={() => openCreateThreadMode()}
                    type="button"
                  >
                    新建会话
                  </button>
                  <button
                    className="secondary"
                    onClick={() => {
                      setSettingsOpen(false);
                      setModelSettingsOpen(true);
                    }}
                    type="button"
                  >
                    模型
                  </button>
                  <button
                    className="secondary"
                    onClick={() => {
                      setSettingsOpen(false);
                      setManagementOpen(true);
                    }}
                    type="button"
                  >
                    管理
                  </button>
                </div>
              </article>
            </section>

            <section>
              <div className="section-title">资料上下文</div>
              <div className="thread-list-header">
                <button
                  className={`secondary filter-pill ${activeProjectFilter === "all" ? "active" : ""}`}
                  onClick={() => setActiveProjectFilter("all")}
                  type="button"
                >
                  全部上下文
                </button>
                {activeProjectFilter !== "all" && activeProjectGroup ? (
                  <span className="input-hint">当前只看 {activeProjectGroup.label}</span>
                ) : null}
              </div>
              {activeProjectGroup ? (
                <article className="workspace-callout project-shell-card">
                  <header>
                    <strong>{activeProjectGroup.label}</strong>
                    <span>{activeProjectGroup.threadCount} 个会话</span>
                  </header>
                  <p>
                    {activeProjectGroup.description ??
                      activeProjectGroup.latestTopic ??
                      "最近会话未设置主题"}
                  </p>
                  <div className="project-meta">
                    <span>{activeProjectGroup.isExplicitProject ? "资料库视图" : "纯聊天视图"}</span>
                    <span>运行中 {activeProjectGroup.statusCounts.running}</span>
                    <span>失败 {activeProjectGroup.statusCounts.failed}</span>
                    <span>就绪 {activeProjectGroup.statusCounts.idle}</span>
                  </div>
                  {activeProjectGroup.recentTopics.length ? (
                    <div className="project-topic-chips">
                      {activeProjectGroup.recentTopics.map((recentTopic, index) => (
                        <button
                          className="secondary project-topic-chip"
                          key={`${activeProjectGroup.filterKey}-topic-${index}`}
                          onClick={() => setTopic(recentTopic)}
                          type="button"
                        >
                          {recentTopic}
                        </button>
                      ))}
                    </div>
                  ) : null}
                </article>
              ) : null}
              {projectGroups.length === 0 ? (
                <div className="empty-state">还没有可用资料上下文。</div>
              ) : (
                <div className="project-list">
                  {projectGroups.map((group) => (
                    <button
                      className={`project-card ${
                        activeProjectFilter === group.filterKey ? "active" : ""
                      }`}
                      key={group.filterKey}
                      onClick={() => {
                        setActiveProjectFilter(group.filterKey);
                        setSelectedProjectId(group.projectId ?? "");
                        setWorkspaceRoot(group.workspaceRoot);
                        if (group.latestThreadId && selectedThread?.id !== group.latestThreadId) {
                          void refreshThread(group.latestThreadId);
                        }
                      }}
                      type="button"
                    >
                      <div className="project-card-header">
                        <strong>{group.label}</strong>
                        <span>{group.threadCount} 个会话</span>
                      </div>
                      <p>{group.description ?? group.latestTopic ?? "最近会话未设置主题"}</p>
                      <div className="project-meta">
                        <span>运行中 {group.statusCounts.running}</span>
                        <span>失败 {group.statusCounts.failed}</span>
                        <span>{group.isExplicitProject ? "资料库" : "纯聊天"}</span>
                        <span>{formatTime(group.updatedAtMs)}</span>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </section>

            <section>
              <div className="section-title">最近会话</div>
              <div className="thread-list-header">
                <span className="input-hint">
                  {activeProjectFilter === "all"
                    ? `显示全部 ${threads.length} 个会话`
                    : `显示 ${visibleThreads.length} 个会话`}
                </span>
              </div>
              {loading ? (
                <div className="empty-state">加载中…</div>
              ) : visibleThreads.length === 0 ? (
                <div className="empty-state">还没有会话</div>
              ) : (
              <div className="thread-list">
                  {visibleThreads.map((thread) => (
                    <button
                      className={`thread-item ${selectedThread?.id === thread.id ? "active" : ""}`}
                      key={thread.id}
                      onClick={() => {
                        void refreshThread(thread.id);
                        setSettingsOpen(false);
                        setCreateThreadMode(false);
                      }}
                      type="button"
                    >
                      <span className={`status-dot status-${thread.status}`} />
                      <div>
                        <strong>{thread.topic ?? "未命名主题"}</strong>
                        <div>{activeKnowledgeLabel(thread)}</div>
                        <div>{thread.project_id ? "资料库会话" : "纯聊天会话"}</div>
                        <div>{formatTime(thread.updated_at_ms)}</div>
                      </div>
                    </button>
                  ))}
                </div>
              )}
            </section>

                </div>
              </aside>
            </div>
          ) : null}
          {modelSettingsOpen ? (
            <div className="settings-overlay">
              <button
                aria-label="关闭模型设置"
                className="settings-backdrop"
                onClick={() => setModelSettingsOpen(false)}
                type="button"
              />
              <aside className="card settings-drawer model-settings-drawer" role="dialog" aria-modal="true">
                <div className="settings-drawer-header">
                  <div>
                    <p className="eyebrow">模型</p>
                    <h2>模型接入</h2>
                    <p className="hero-copy">
                      这里单独维护当前浏览器会话使用的模型配置。先填 API 地址和 API 密钥，再从返回的模型列表中选择，不再和任务或项目绑定。
                    </p>
                  </div>
                  <div className="drawer-header-actions">
                    <button
                      className="secondary"
                      onClick={handleResetModelConfig}
                      type="button"
                    >
                      清空配置
                    </button>
                    <button
                      className="secondary"
                      onClick={() => setModelSettingsOpen(false)}
                      type="button"
                    >
                      关闭
                    </button>
                  </div>
                </div>
                <div className="settings-drawer-body">
                  <ModelAccessSection
                    apiKey={modelApiKey}
                    baseUrl={modelBaseUrl}
                    discoveredModels={discoveredModels}
                    discoveryMessage={modelDiscoveryMessage}
                    discoveryState={modelDiscoveryState}
                    description="如果服务启动时已提供环境变量，这里可以保持为空；若希望当前浏览器走独立模型，请先填写 API 地址和 API 密钥，再选择模型。"
                    modelName={modelName}
                    title="浏览器模型"
                    onApiKeyChange={setModelApiKey}
                    onBaseUrlChange={setModelBaseUrl}
                    onModelNameChange={setModelName}
                  />
          <article className="workspace-callout">
            <header>
              <strong>使用方式</strong>
                      <span className={`status-pill ${standaloneModelReady ? "status-idle" : ""}`}>
                        {standaloneModelReady
                          ? "独立模型已就绪"
                          : hasStandaloneModelConfig
                            ? "配置未完成"
                            : "跟随服务环境"}
                      </span>
                    </header>
                    <p>
                      {standaloneModelReady
                        ? `后续新会话将使用 ${modelName.trim()}。`
                        : hasStandaloneModelConfig
                          ? "当前只填写了部分字段。创建会话前需要补全 API 地址、API 密钥和模型。"
                          : "当前没有独立模型配置，会跟随服务启动环境。"}
                    </p>
                    <div className="workspace-meta">
                      <span>{modelBaseUrl.trim() || "API 地址未设置"}</span>
                      <span>{modelApiKey.trim() ? "API 密钥已填写" : "API 密钥未填写"}</span>
                      <span>{modelName.trim() || "模型未选择"}</span>
                      {modelDiscoveryMessage ? <span>{modelDiscoveryMessage}</span> : null}
                    </div>
                  </article>
                </div>
              </aside>
            </div>
          ) : null}
          {managementOpen ? (
            <div className="settings-overlay">
              <button
                aria-label="关闭管理面板"
                className="settings-backdrop"
                onClick={() => setManagementOpen(false)}
                type="button"
              />
              <aside className="card settings-drawer management-drawer" role="dialog" aria-modal="true">
                <div className="settings-drawer-header">
                  <div>
                    <p className="eyebrow">设置</p>
                    <h2>资料接入与技能</h2>
                    <p className="hero-copy">
                      这里管理资料库、数据源接入和技能模板，不打扰默认聊天界面。
                    </p>
                  </div>
                  <div className="drawer-header-actions">
                    <button
                      className="secondary"
                      onClick={() => {
                        setManagementOpen(false);
                        setSettingsOpen(true);
                      }}
                      type="button"
                    >
                      返回会话
                    </button>
                    <button
                      className="secondary"
                      onClick={() => setManagementOpen(false)}
                      type="button"
                    >
                      关闭
                    </button>
                  </div>
                </div>
                <div className="settings-drawer-body management-drawer-body">
            {currentProject && projectEditor ? (
              <section>
                <div className="section-title">资料库策略</div>
                <article className="workspace-callout project-detail-card">
                  <header>
                    <div className="project-detail-headline">
                      <strong>{currentProject.name}</strong>
                      <p>{currentProject.description ?? "为这个资料库补充共享主题、默认权限和默认技能。"}</p>
                    </div>
                    <div className="project-meta">
                      <span>创建于 {formatTime(currentProject.created_at_ms)}</span>
                      <span>更新于 {formatTime(currentProject.updated_at_ms)}</span>
                      <span>{contextBadgeLabel({ projectName: currentProject.name, workspaceRoot: currentProject.workspace_root })}</span>
                    </div>
                  </header>
                  <form className="stack-form project-settings-form" onSubmit={handleSaveProjectSettings}>
                    <SettingsFormSection
                      title="基础信息"
                      description="资料库名称、共享主题说明和默认运行策略。"
                    >
                      <label>
                        资料库名称
                        <input
                          value={projectEditor.name}
                          onChange={(event) => updateProjectEditorField("name", event.target.value)}
                          placeholder="例如 研发知识库"
                        />
                      </label>
                      <label>
                        资料库说明
                        <textarea
                          rows={3}
                          value={projectEditor.description}
                          onChange={(event) =>
                            updateProjectEditorField("description", event.target.value)
                          }
                          placeholder="说明这个资料库沉淀什么主题、知识或交付方向。"
                        />
                      </label>
                      <label>
                        默认主题
                        <input
                          value={projectEditor.defaultTopic}
                          onChange={(event) =>
                            updateProjectEditorField("defaultTopic", event.target.value)
                          }
                          placeholder="例如 分析仓库架构、主题边界与改造建议"
                        />
                      </label>
                    </SettingsFormSection>
                    <SettingsFormSection
                      title="运行策略"
                      description="默认权限和起手指令。模型接入已移到独立模型配置。"
                    >
                      <label>
                        默认权限
                        <select
                          value={projectEditor.defaultPermissionMode}
                          onChange={(event) =>
                            updateProjectEditorField("defaultPermissionMode", event.target.value)
                          }
                        >
                          <option value="">跟随服务默认值</option>
                          <option value="read-only">只读</option>
                          <option value="workspace-write">受限写入</option>
                          <option value="danger-full-access">完全访问</option>
                        </select>
                      </label>
                      <label>
                        起始提示
                        <textarea
                          rows={4}
                          value={projectEditor.starterPrompt}
                          onChange={(event) =>
                            updateProjectEditorField("starterPrompt", event.target.value)
                          }
                          placeholder="例如 先检索仓库资料、建立研究边界，再输出结构化结论。"
                        />
                      </label>
                      <label>
                        默认指令
                        <textarea
                          rows={4}
                          value={projectEditor.defaultInstructions}
                          onChange={(event) =>
                            updateProjectEditorField("defaultInstructions", event.target.value)
                          }
                          placeholder="例如 先梳理主题边界，来源不足时先检索，不要过早下结论。"
                        />
                      </label>
                    </SettingsFormSection>
                    <SettingsFormSection
                      title="技能"
                      description="为资料库指定默认技能，帮助新会话更快进入正确流程。"
                    >
                      <DefaultSkillSelector
                        emptyHint="当前资料库范围内还没有可选技能。先在技能库创建资料库级或团队级技能，这里会自动感知。"
                        loading={projectSkillOptionsLoading}
                        onRawValueChange={(value) => updateProjectEditorField("defaultSkillNames", value)}
                        onToggleSkill={toggleProjectSkill}
                        rawValue={projectEditor.defaultSkillNames}
                        selectedSkillNames={selectedProjectSkillNames}
                        skillOptions={projectSkillOptions}
                      />
                    </SettingsFormSection>
                    <div className="project-settings-toolbar">
                      <span className="input-hint">
                        留空字段表示清空资料库覆盖，重新跟随会话或服务默认值。
                      </span>
                      <div className="inline-actions">
                        <button
                          className="secondary"
                          disabled={!projectEditorDirty || projectSaving}
                          onClick={handleResetProjectEditor}
                          type="button"
                        >
                          重置修改
                        </button>
                        <button
                          disabled={
                            projectSaving ||
                            !activeAuth ||
                            !projectEditor.name.trim() ||
                            !projectEditorDirty
                          }
                          type="submit"
                        >
                          {projectSaving ? "保存中…" : "保存资料库策略"}
                        </button>
                      </div>
                    </div>
                    {projectDetailLoading ? (
                      <div className="input-hint">正在同步最新资料库设置…</div>
                    ) : null}
                  </form>
                </article>
              </section>
            ) : null}

            <details
              className="console-panel"
              open={dataSourcePanelOpen || projects.length === 0}
              onToggle={(event) => setDataSourcePanelOpen(event.currentTarget.open)}
            >
              <summary>资料接入</summary>
              <div className="console-body">
                <form className="stack-form" onSubmit={handleCreateKnowledgeBase}>
                  <SettingsFormSection
                    title="新建资料库"
                    description="资料库是用户可感知的资料容器，可选绑定到当前资料上下文。"
                  >
                    <label>
                      资料库名称
                      <input
                        value={knowledgeBaseForm.name}
                        onChange={(event) =>
                          setKnowledgeBaseForm((current) => ({ ...current, name: event.target.value }))
                        }
                        placeholder="例如 产品研究资料库"
                      />
                    </label>
                    <label>
                      资料库说明
                      <textarea
                        rows={3}
                        value={knowledgeBaseForm.description}
                        onChange={(event) =>
                          setKnowledgeBaseForm((current) => ({
                            ...current,
                            description: event.target.value,
                          }))
                        }
                        placeholder="说明这个资料库沉淀什么主题、知识或交付方向。"
                      />
                    </label>
                  </SettingsFormSection>
                  <SettingsFormSection
                    title={dataSourceForm.editingSourceId ? "编辑资料来源" : "添加资料来源"}
                    description={
                      dataSourceForm.editingSourceId
                        ? "更新来源名称、说明和接入配置。接入方式与归属资料库保持不变。"
                        : "先选一种接入方式，再把网页、文档、ES 或数据库接入到当前资料库。"
                    }
                  >
                    <label>
                      当前资料库
                      <select
                        disabled={Boolean(dataSourceForm.editingSourceId)}
                        value={dataSourceForm.knowledgeBaseId}
                        onChange={(event) =>
                          setDataSourceForm((current) => ({
                            ...current,
                            knowledgeBaseId: event.target.value,
                          }))
                        }
                      >
                        <option value="">先选择资料库</option>
                        {knowledgeBases.map((item) => (
                          <option key={item.id} value={item.id}>
                            {item.name}
                          </option>
                        ))}
                      </select>
                    </label>
                    <div className="source-kind-picker">
                      {DATA_SOURCE_KIND_OPTIONS.map((option) => {
                        const active = dataSourceForm.kind === option.kind;
                        return (
                          <button
                            className={`secondary source-kind-card ${active ? "active" : ""}`}
                            disabled={Boolean(dataSourceForm.editingSourceId)}
                            key={option.kind}
                            onClick={(event) => {
                              event.preventDefault();
                              setDataSourceForm((current) => ({
                                ...current,
                                kind: option.kind,
                              }));
                            }}
                            type="button"
                          >
                            <div className="source-kind-card-header">
                              <strong>{option.title}</strong>
                              {option.adminOnly ? <span>高级</span> : null}
                            </div>
                            <span>{option.description}</span>
                          </button>
                        );
                      })}
                    </div>
                    <div className="source-kind-caption">
                      <strong>{dataSourceKindLabel(dataSourceForm.kind)}</strong>
                      <span>{dataSourceKindDescription(dataSourceForm.kind)}</span>
                    </div>
                    <label>
                      来源名称
                      <input
                        value={dataSourceForm.name}
                        onChange={(event) =>
                          setDataSourceForm((current) => ({ ...current, name: event.target.value }))
                        }
                        placeholder="例如 主索引 / 上传批次 A"
                      />
                    </label>
                    <label>
                      用途说明
                      <textarea
                        rows={3}
                        value={dataSourceForm.description}
                        onChange={(event) =>
                          setDataSourceForm((current) => ({
                            ...current,
                            description: event.target.value,
                          }))
                        }
                        placeholder="说明这份数据源承载什么内容。"
                      />
                    </label>
                    {dataSourceForm.kind === "es" ? (
                      <>
                        <label>
                          检索地址
                          <input
                            value={dataSourceForm.endpoint}
                            onChange={(event) =>
                              setDataSourceForm((current) => ({
                                ...current,
                                endpoint: event.target.value,
                              }))
                            }
                            placeholder="例如 http://es.example.com:9200"
                          />
                        </label>
                        <label>
                          索引
                          <input
                            value={dataSourceForm.indexName}
                            onChange={(event) =>
                              setDataSourceForm((current) => ({
                                ...current,
                                indexName: event.target.value,
                              }))
                            }
                            placeholder="例如 docs"
                          />
                        </label>
                        <label>
                          API Key
                          <input
                            type="password"
                            value={dataSourceForm.apiKey}
                            onChange={(event) =>
                              setDataSourceForm((current) => ({
                                ...current,
                                apiKey: event.target.value,
                              }))
                            }
                            placeholder="可选，优先用于 Bearer 鉴权"
                          />
                        </label>
                        <label>
                          用户名
                          <input
                            value={dataSourceForm.username}
                            onChange={(event) =>
                              setDataSourceForm((current) => ({
                                ...current,
                                username: event.target.value,
                              }))
                            }
                            placeholder="可选，Basic 鉴权用户名"
                          />
                        </label>
                        <label>
                          密码
                          <input
                            type="password"
                            value={dataSourceForm.password}
                            onChange={(event) =>
                              setDataSourceForm((current) => ({
                                ...current,
                                password: event.target.value,
                              }))
                            }
                            placeholder="可选，Basic 鉴权密码"
                          />
                        </label>
                        <div className="input-hint">
                          支持两种认证方式：优先使用 API Key；未填写时回退到用户名 + 密码。
                        </div>
                      </>
                    ) : null}
                    {dataSourceForm.kind === "upload" ? (
                      <div className="input-hint">
                        先创建上传资料入口，然后在下方资料卡片中直接上传 PDF、Markdown、文本或表格文件。
                      </div>
                    ) : null}
                    {dataSourceForm.kind === "web" ? (
                      <>
                        <label>
                          网页链接
                          <textarea
                            rows={4}
                            value={dataSourceForm.urls}
                            onChange={(event) =>
                              setDataSourceForm((current) => ({
                                ...current,
                                urls: event.target.value,
                              }))
                            }
                            placeholder={"每行一个地址\nhttps://example.com/report\nhttps://example.com/docs"}
                          />
                        </label>
                        <div className="input-hint">
                          只会开放这里列出的网页入口，避免让会话随意抓取未知站点。
                        </div>
                      </>
                    ) : null}
                    {dataSourceForm.kind === "db" ? (
                      <>
                        <label>
                          数据库地址
                          <input
                            value={dataSourceForm.dbUrl}
                            onChange={(event) =>
                              setDataSourceForm((current) => ({
                                ...current,
                                dbUrl: event.target.value,
                              }))
                            }
                            placeholder="例如 postgresql://user:pass@host:5432/dbname 或 sqlite:///data/demo.db"
                          />
                        </label>
                        <label>
                          Schema / 数据库名
                          <input
                            value={dataSourceForm.dbSchema}
                            onChange={(event) =>
                              setDataSourceForm((current) => ({
                                ...current,
                                dbSchema: event.target.value,
                              }))
                            }
                            placeholder="例如 analytics / public"
                          />
                        </label>
                        <label>
                          用户名
                          <input
                            value={dataSourceForm.username}
                            onChange={(event) =>
                              setDataSourceForm((current) => ({
                                ...current,
                                username: event.target.value,
                              }))
                            }
                            placeholder="可选，单独覆盖连接串里的用户名"
                          />
                        </label>
                        <label>
                          密码
                          <input
                            type="password"
                            value={dataSourceForm.password}
                            onChange={(event) =>
                              setDataSourceForm((current) => ({
                                ...current,
                                password: event.target.value,
                              }))
                            }
                            placeholder="可选，单独覆盖连接串里的密码"
                          />
                        </label>
                        <div className="input-hint">
                          当前只开放只读查询，Agent 无法执行写入、删除或结构变更。
                        </div>
                      </>
                    ) : null}
                    {dataSourceForm.kind === "local_dir" ? (
                      <>
                        <label>
                          服务器目录
                          <input
                            value={dataSourceForm.path}
                            onChange={(event) =>
                              setDataSourceForm((current) => ({
                                ...current,
                                path: event.target.value,
                              }))
                            }
                            placeholder="/srv/research/docs"
                          />
                        </label>
                        <div className="input-hint">
                          仅管理员侧高级接入使用。这个目录不会直接暴露给普通用户，只作为后台受控数据源。
                        </div>
                      </>
                    ) : null}
                  </SettingsFormSection>
                  <div className="inline-actions">
                    <button
                      disabled={knowledgeLoading || !activeAuth || !knowledgeBaseForm.name.trim()}
                      type="submit"
                    >
                      {knowledgeLoading ? "创建中…" : "新建资料库"}
                    </button>
                    {dataSourceForm.kind !== "upload" ? (
                      <button
                        className="secondary"
                        disabled={dataSourceTesting || knowledgeLoading || !activeAuth}
                        onClick={(event) => {
                          event.preventDefault();
                          void handleTestDataSource();
                        }}
                        type="button"
                      >
                        {dataSourceTesting ? "测试中…" : "测试连接"}
                      </button>
                    ) : null}
                    {dataSourceForm.editingSourceId ? (
                      <button
                        className="secondary"
                        disabled={knowledgeLoading}
                        onClick={(event) => {
                          event.preventDefault();
                          handleResetDataSourceForm();
                        }}
                        type="button"
                      >
                        取消编辑
                      </button>
                    ) : null}
                    <button
                      className="secondary"
                      disabled={knowledgeLoading || !activeAuth || !dataSourceForm.knowledgeBaseId || !dataSourceForm.name.trim()}
                      onClick={(event) => {
                        event.preventDefault();
                        void handleCreateDataSource();
                      }}
                      type="button"
                    >
                      {knowledgeLoading
                        ? dataSourceForm.editingSourceId
                          ? "保存中…"
                          : "创建中…"
                        : dataSourceForm.editingSourceId
                          ? "保存来源"
                          : "添加来源"}
                    </button>
                  </div>
                  {dataSourceTestResult ? (
                    <DataSourceTestResultView result={dataSourceTestResult.result} />
                  ) : null}
                  {knowledgeBases.length ? (
                    <div className="project-list">
                      {knowledgeBases.map((item) => {
                        const sourceItems = dataSources.filter((source) => source.knowledge_base_id === item.id);
                        const uploadSource = firstUploadSourceForKnowledgeBase(item.id, sourceItems);
                        return (
                          <article className="project-card active knowledge-base-card" key={item.id}>
                            <div className="knowledge-base-card-head">
                              <div className="knowledge-base-card-copy">
                                <div className="project-card-header">
                                  <strong>{item.name}</strong>
                                  <span>{sourceItems.length} 个资料来源</span>
                                </div>
                                <p>{item.description ?? "暂未填写资料库说明。"}</p>
                                <div className="project-meta">
                                  <span>{item.default_project_id ? "已关联资料上下文" : "未绑定资料上下文"}</span>
                                  <span>{formatTime(item.updated_at_ms)}</span>
                                </div>
                              </div>
                              <div className="knowledge-base-card-actions">
                                {uploadSource ? (
                                  <label
                                    className={`secondary inline-upload-action knowledge-base-upload-action ${
                                      draggingDataSourceId === uploadSource.id ? "dragging" : ""
                                    }`}
                                    onDragEnter={(event) => {
                                      event.preventDefault();
                                      setDraggingDataSourceId(uploadSource.id);
                                    }}
                                    onDragLeave={(event) => {
                                      event.preventDefault();
                                      if (!(event.currentTarget as HTMLLabelElement).contains(event.relatedTarget as Node | null)) {
                                        setDraggingDataSourceId((current) => (current === uploadSource.id ? null : current));
                                      }
                                    }}
                                    onDragOver={(event) => {
                                      event.preventDefault();
                                      setDraggingDataSourceId(uploadSource.id);
                                    }}
                                    onDrop={(event) => {
                                      event.preventDefault();
                                      setDraggingDataSourceId(null);
                                      const files = Array.from(event.dataTransfer.files ?? []);
                                      if (files.length) {
                                        void handleUploadDataSourceFile(uploadSource, files);
                                      }
                                    }}
                                  >
                                    <input
                                      hidden
                                      multiple
                                      onChange={(event) => {
                                        const files = Array.from(event.target.files ?? []);
                                        if (files.length) {
                                          void handleUploadDataSourceFile(uploadSource, files);
                                        }
                                        event.currentTarget.value = "";
                                      }}
                                      type="file"
                                    />
                                    <span>
                                      {uploadingDataSourceId === uploadSource.id
                                        ? "上传中…"
                                        : draggingDataSourceId === uploadSource.id
                                          ? "松手后上传"
                                          : "快速上传资料"}
                                    </span>
                                  </label>
                                ) : null}
                                <button
                                  className="secondary"
                                  onClick={() => openDataSourceDraft(uploadSource ? "web" : "upload", item.id)}
                                  type="button"
                                >
                                  {uploadSource ? "新增其他来源" : "添加资料来源"}
                                </button>
                              </div>
                            </div>
                            {sourceItems.length ? (
                              <div className="knowledge-source-list">
                                {sourceItems.map((source) => (
                                  <section className="knowledge-source-card" key={source.id}>
                                    <div className="knowledge-source-card-header">
                                      <div className="knowledge-source-card-title">
                                        <strong>{source.name}</strong>
                                        <span>{dataSourceKindLabel(source.kind)}</span>
                                      </div>
                                      <div className="knowledge-source-state">
                                        <strong>{dataSourceCardStateLabel(source)}</strong>
                                        <span>{dataSourceCardStateMeta(source)}</span>
                                      </div>
                                      <div className="knowledge-source-actions">
                                        <button
                                          className="secondary"
                                          onClick={() => handleEditDataSource(source)}
                                          type="button"
                                        >
                                          编辑
                                        </button>
                                        {source.kind !== "upload" ? (
                                          <button
                                            className="secondary"
                                            disabled={cardTestingDataSourceId === source.id}
                                            onClick={() => void handleRetestSavedDataSource(source)}
                                            type="button"
                                          >
                                            {cardTestingDataSourceId === source.id ? "测试中…" : "重新测试"}
                                          </button>
                                        ) : null}
                                        {source.kind === "upload" ? (
                                          <label
                                            className={`inline-upload-action upload-dropzone ${
                                              draggingDataSourceId === source.id ? "dragging" : ""
                                            }`}
                                            onDragEnter={(event) => {
                                              event.preventDefault();
                                              setDraggingDataSourceId(source.id);
                                            }}
                                            onDragLeave={(event) => {
                                              event.preventDefault();
                                              if (!(event.currentTarget as HTMLLabelElement).contains(event.relatedTarget as Node | null)) {
                                                setDraggingDataSourceId((current) => (current === source.id ? null : current));
                                              }
                                            }}
                                            onDragOver={(event) => {
                                              event.preventDefault();
                                              setDraggingDataSourceId(source.id);
                                            }}
                                            onDrop={(event) => {
                                              event.preventDefault();
                                              setDraggingDataSourceId(null);
                                              const files = Array.from(event.dataTransfer.files ?? []);
                                              if (files.length) {
                                                void handleUploadDataSourceFile(source, files);
                                              }
                                            }}
                                          >
                                            <input
                                              hidden
                                              multiple
                                              onChange={(event) => {
                                                const files = Array.from(event.target.files ?? []);
                                                if (files.length) {
                                                  void handleUploadDataSourceFile(source, files);
                                                }
                                                event.currentTarget.value = "";
                                              }}
                                              type="file"
                                            />
                                            <span>
                                              {uploadingDataSourceId === source.id
                                                ? "上传中…"
                                                : draggingDataSourceId === source.id
                                                  ? "松手后上传"
                                                  : "上传文件"}
                                            </span>
                                          </label>
                                        ) : null}
                                        <button
                                          className="secondary inline-danger-action"
                                          disabled={removingDataSourceId === source.id}
                                          onClick={() => void handleDeleteDataSource(source)}
                                          type="button"
                                        >
                                          {removingDataSourceId === source.id ? "移除中…" : "移除"}
                                        </button>
                                      </div>
                                    </div>
                                    <div className="knowledge-source-meta">
                                      {source.kind === "es" && source.index_name ? (
                                        <span>索引 {source.index_name}</span>
                                      ) : null}
                                      {source.endpoint ? <span>{source.endpoint}</span> : null}
                                      {source.source_detail ? <span>{source.source_detail}</span> : null}
                                    </div>
                                    <div className="knowledge-source-summary">
                                      {dataSourceCardStateCopy(source)}
                                    </div>
                                    {source.last_test ? (
                                      <div className="knowledge-source-test-summary">
                                        <div className="knowledge-source-test-summary-header">
                                          <strong>{dataSourceTestStatusLabel(source.last_test.status)}</strong>
                                          <span>{formatTime(source.last_test.checked_at_ms)}</span>
                                        </div>
                                        <span>{source.last_test.summary}</span>
                                      </div>
                                    ) : null}
                                    {source.kind === "upload" ? (
                                      source.uploaded_files.length ? (
                                        <div className="knowledge-upload-list">
                                          {source.uploaded_files
                                            .slice()
                                            .sort((left, right) => right.uploaded_at_ms - left.uploaded_at_ms)
                                            .map((file) => (
                                              <div className="knowledge-upload-item" key={file.id}>
                                                <div className="knowledge-upload-item-header">
                                                  <strong>{file.file_name}</strong>
                                                  <button
                                                    className="secondary inline-danger-action"
                                                    disabled={removingDataSourceFileId === file.id}
                                                    onClick={() => void handleDeleteDataSourceFile(source, file.id)}
                                                    type="button"
                                                  >
                                                    {removingDataSourceFileId === file.id ? "移除中…" : "移除"}
                                                  </button>
                                                </div>
                                                <span>
                                                  {formatFileSize(file.size_bytes)}
                                                  {file.mime_type ? ` · ${file.mime_type}` : ""}
                                                </span>
                                                <span>上传于 {formatTime(file.uploaded_at_ms)}</span>
                                              </div>
                                            ))}
                                        </div>
                                      ) : (
                                        <div className="input-hint">
                                          还没有上传资料。可直接拖入 PDF、Markdown、文本或表格文件。
                                        </div>
                                      )
                                    ) : null}
                                  </section>
                                ))}
                              </div>
                            ) : (
                              <div className="input-hint">当前资料库还没有添加资料来源，仍可先作为纯聊天资料库使用。</div>
                            )}
                          </article>
                        );
                      })}
                    </div>
                  ) : null}
                </form>
              </div>
            </details>

            <Suspense fallback={<div className="empty-state">加载技能库中…</div>}>
              <LazySkillsPanel
                auth={activeAuth}
                hasSelectedThread={Boolean(selectedThread)}
                onError={setError}
                onUseStarterPromptForNewThread={handleUseStarterPromptForNewThread}
                onUseStarterPromptInCurrentThread={handleUseStarterPromptInCurrentThread}
                projectId={selectedProjectId || selectedThread?.project_id || undefined}
                tenantAvailable={Boolean(authSession?.tenant_id)}
                workspaceRoot={selectedProjectId || selectedThread?.project_id ? (selectedThread?.workspace_root ?? workspaceRoot) : ""}
              />
            </Suspense>
                </div>
              </aside>
            </div>
          ) : null}
          {workbenchOpen ? (
            <div className="workbench-overlay">
              <button
                aria-label="关闭结果面板"
                className="workbench-backdrop"
                onClick={() => setWorkbenchOpen(false)}
                type="button"
              />
              <aside className="card workbench-drawer" role="dialog" aria-modal="true">
                <div className="workbench-drawer-header">
                  <div>
                    <p className="eyebrow">结果</p>
                    <h2>{selectedThread?.topic ?? "结果"}</h2>
                    <p className="hero-copy">
                      结论、引用和关键进展集中查看，主聊天界面保持简洁。
                    </p>
                    {highlightedArtifactId || highlightedEvidenceId ? (
                      <p className="workbench-drawer-focus-note">
                        {highlightedArtifactId
                          ? `当前定位到结果 ${highlightedArtifactAnchor ? `· ${highlightedArtifactAnchor}` : ""}`
                          : `当前定位到来源 ${highlightedEvidenceAnchor ? `· ${highlightedEvidenceAnchor}` : ""}`}
                      </p>
                    ) : null}
                  </div>
                  <div className="workbench-drawer-actions">
                    <button
                      className="secondary"
                      onClick={() => setWorkbenchOpen(false)}
                      type="button"
                    >
                      关闭
                    </button>
                  </div>
                </div>
                <div className="workbench-drawer-body">
                  <Suspense
                    fallback={(
                      <article className="workbench-card workbench-card-embedded">
                        <div className="empty-pane">加载结果中…</div>
                      </article>
                    )}
                  >
                    <LazyWorkbenchPanel
                      activeTab={workbenchTab}
                      embeddedShell
                      highlightedArtifactAnchor={highlightedArtifactAnchor}
                      highlightedArtifactId={highlightedArtifactId}
                      highlightedEvidenceAnchor={highlightedEvidenceAnchor}
                      highlightedEvidenceId={highlightedEvidenceId}
                      onInsertReference={handleInsertReferenceIntoCurrentThread}
                      onOpenArtifact={handleOpenArtifact}
                      onOpenEvidence={handleOpenEvidence}
                      onTabChange={(tab) => {
                        setWorkbenchTab(tab);
                        clearWorkbenchHighlights(tab);
                      }}
                      operatorMode={false}
                      showHeader={false}
                      thread={selectedThread}
                    />
                  </Suspense>
                </div>
              </aside>
            </div>
          ) : null}

            </>
          }
          center={
          <main className="minimal-main-column">
            <section
              className={`card conversation-card conversation-card-primary${
                !selectedThread ? " conversation-card-empty" : ""
              }`}
            >
              {showConversationQuickstart && selectedThread ? (
                <div className="conversation-header conversation-header-quickstart">
                  <div className="conversation-header-main">
                    <div className="conversation-title-row">
                      <strong>开始新会话</strong>
                    </div>
                    <div className="conversation-subline">
                      <span>当前会话会保留，你可以直接开启下一条研究线。</span>
                    </div>
                  </div>
                  <div className="conversation-header-actions">
                    <button
                      className="secondary conversation-header-button"
                      onClick={() => setCreateThreadMode(false)}
                      title="返回当前会话"
                      type="button"
                    >
                      返回当前会话
                    </button>
                    <button
                      className={`secondary conversation-header-button ${
                        modelSettingsOpen ? "active" : ""
                      }`}
                      onClick={() => setModelSettingsOpen(true)}
                      title="打开模型接入设置"
                      type="button"
                    >
                      模型
                    </button>
                    <button
                      className={`secondary conversation-header-button ${
                        settingsOpen ? "active" : ""
                      }`}
                      onClick={() => setSettingsOpen(true)}
                      title="打开会话与项目入口"
                      type="button"
                    >
                      更多选项
                    </button>
                  </div>
                </div>
              ) : selectedThread ? (
                <div className="conversation-header">
                  <div className="conversation-header-main">
                    <div className="conversation-title-row">
                      <strong>{selectedThread.topic ?? "开始一个研究会话"}</strong>
                      <span className={`status-pill conversation-status-pill status-${selectedThread.status}`}>
                        {threadStatusLabel(selectedThread.status)}
                      </span>
                    </div>
                    <div className="conversation-subline">
                      <span>{threadProjectLabel(selectedThread)}</span>
                      {selectedThread.project_name ? (
                        <>
                          <span className="conversation-subline-divider">·</span>
                          <span>{contextBadgeLabel(selectedThread)}</span>
                        </>
                      ) : null}
                      {selectedThread.artifacts.length ? (
                        <span className="conversation-meta-chip">
                          结果 {selectedThread.artifacts.length}
                        </span>
                      ) : null}
                      {evidenceEntries.length ? (
                        <span className="conversation-meta-chip">来源 {evidenceEntries.length}</span>
                      ) : null}
                    </div>
                  </div>
                  <div className="conversation-header-actions">
                    <button
                      className="secondary conversation-header-button primary"
                      onClick={() => openCreateThreadMode()}
                      title="开始新会话"
                      type="button"
                    >
                      新建会话
                    </button>
                    <button
                      className={`secondary conversation-header-button ${
                        workbenchOpen ? "active" : ""
                      }`}
                      onClick={openWorkbench}
                      title={workbenchSummaryLabel()}
                      type="button"
                    >
                      打开结果
                    </button>
                    <button
                      className={`secondary conversation-header-button ${
                        modelSettingsOpen ? "active" : ""
                      }`}
                      onClick={() => setModelSettingsOpen(true)}
                      title="打开模型接入设置"
                      type="button"
                    >
                      模型
                    </button>
                    <button
                      className={`secondary conversation-header-button ${
                        managementOpen ? "active" : ""
                      }`}
                      onClick={() => setManagementOpen(true)}
                      title="打开项目与技能"
                      type="button"
                    >
                      管理
                    </button>
                    <button
                      aria-label="打开设置"
                      className={`secondary conversation-header-button ${
                        settingsOpen ? "active" : ""
                      }`}
                      onClick={() => setSettingsOpen(true)}
                      title="打开会话与项目入口"
                      type="button"
                    >
                      设置
                    </button>
                  </div>
                </div>
              ) : null}

              {!showConversationQuickstart && selectedThread && selectedThreadAlert ? (
                <p className="conversation-inline-note conversation-inline-note-warning">
                  {selectedThreadAlert}
                </p>
              ) : null}
              {!showConversationQuickstart && selectedThread && surfaceErrorMessage ? (
                <p className="conversation-inline-note conversation-inline-note-error">
                  {surfaceErrorMessage}
                </p>
              ) : null}

              {!showConversationQuickstart && selectedThread ? (
                <Suspense fallback={<div className="empty-pane">加载会话面板中…</div>}>
                  <LazyAssistantThreadPanel
                    boundaryControls={
                      selectedThread ? (
                        <div className="chat-boundary-shell">
                          <div className="chat-boundary-bar">
                            <div className="chat-boundary-context">
                              <span className="chat-boundary-label">任务边界</span>
                              {selectedThread.status === "running" ? (
                                <span className="chat-boundary-hint">
                                  正在持续检索、整理并写出结果
                                </span>
                              ) : null}
                              {selectedThread.status === "interrupt_requested" ? (
                                <span className="chat-boundary-hint">正在安全停止当前任务</span>
                              ) : null}
                              {selectedThread.status === "idle" && !inlineBoundaryMode ? (
                                <span className="chat-boundary-hint">
                                  需要时可以收紧主题，或要求 agent 重新规划
                                </span>
                              ) : null}
                            </div>
                            <div className="chat-boundary-actions">
                              <button
                                className={`secondary chat-boundary-button ${
                                  inlineBoundaryMode === "topic" ? "active" : ""
                                }`}
                                onClick={() =>
                                  setInlineBoundaryMode((current) =>
                                    current === "topic" ? null : "topic",
                                  )
                                }
                                type="button"
                              >
                                收束主题
                              </button>
                              <button
                                className={`secondary chat-boundary-button ${
                                  inlineBoundaryMode === "replan" ? "active" : ""
                                }`}
                                onClick={() =>
                                  setInlineBoundaryMode((current) =>
                                    current === "replan" ? null : "replan",
                                  )
                                }
                                type="button"
                              >
                                重做计划
                              </button>
                            </div>
                          </div>

                          {inlineBoundaryMode === "topic" ? (
                            <form
                              className="chat-boundary-form"
                              onSubmit={(event) => {
                                event.preventDefault();
                                void handleSetTopic();
                              }}
                            >
                              <div className="chat-boundary-form-copy">
                                <strong>更新主题边界</strong>
                                <p>让后续检索、阅读和总结收敛到新的重点。</p>
                              </div>
                              <label>
                                当前主题
                                <input
                                  onChange={(event) => setTopicDraft(event.target.value)}
                                  placeholder="输入新的主题边界"
                                  value={topicDraft}
                                />
                              </label>
                              <div className="chat-boundary-form-actions">
                                <button
                                  className="secondary"
                                  onClick={() => setInlineBoundaryMode(null)}
                                  type="button"
                                >
                                  取消
                                </button>
                                <button
                                  disabled={!selectedThread || busy || !topicDraft.trim()}
                                  type="submit"
                                >
                                  应用主题
                                </button>
                              </div>
                            </form>
                          ) : null}

                          {inlineBoundaryMode === "replan" ? (
                            <form
                              className="chat-boundary-form"
                              onSubmit={(event) => {
                                event.preventDefault();
                                void handleReplan();
                              }}
                            >
                              <div className="chat-boundary-form-copy">
                                <strong>重新规划接下来的步骤</strong>
                                <p>当范围跑偏、来源不足或输出形式需要变化时使用。</p>
                              </div>
                              <div className="chat-boundary-grid">
                                <label>
                                  可选主题
                                  <input
                                    onChange={(event) => setTopicDraft(event.target.value)}
                                    placeholder="需要时补充新的主题边界"
                                    value={topicDraft}
                                  />
                                </label>
                                <label className="chat-boundary-grid-span">
                                  重规划原因
                                  <textarea
                                    onChange={(event) => setReplanReason(event.target.value)}
                                    rows={3}
                                    value={replanReason}
                                  />
                                </label>
                              </div>
                              <div className="chat-boundary-form-actions">
                                <button
                                  className="secondary"
                                  onClick={() => setInlineBoundaryMode(null)}
                                  type="button"
                                >
                                  取消
                                </button>
                                <button disabled={!selectedThread || busy} type="submit">
                                  重新规划
                                </button>
                              </div>
                            </form>
                          ) : null}
                        </div>
                      ) : null
                    }
                    composerSeed={composerSeed}
                    composerTopSlot={
                      <>
                        <ThreadSkillStrip
                          expertSkills={availableExpertSkills}
                          loading={threadSkillOptionsLoading}
                          onOpenSkillManager={openSkillManager}
                          onToggleExpert={toggleExpertSkill}
                          onUseSkill={handleUseSkillInCurrentThread}
                          selectedExperts={selectedExpertSkillRecords}
                          skills={threadSkillOptions}
                        />
                        {selectedExpertHelperLabel ? (
                          <div className="thread-expert-selection-note">{selectedExpertHelperLabel}</div>
                        ) : null}
                      </>
                    }
                    contextAction={
                      selectedThread.knowledge_base_id ? (
                        <div className="thread-context-actions">
                          {activeThreadUploadSource ? (
                            <label
                              className={`secondary inline-upload-action thread-context-upload-action ${
                                draggingDataSourceId === activeThreadUploadSource.id ? "dragging" : ""
                              }`}
                              onDragEnter={(event) => {
                                event.preventDefault();
                                setDraggingDataSourceId(activeThreadUploadSource.id);
                              }}
                              onDragLeave={(event) => {
                                event.preventDefault();
                                if (!(event.currentTarget as HTMLLabelElement).contains(event.relatedTarget as Node | null)) {
                                  setDraggingDataSourceId((current) =>
                                    current === activeThreadUploadSource.id ? null : current,
                                  );
                                }
                              }}
                              onDragOver={(event) => {
                                event.preventDefault();
                                setDraggingDataSourceId(activeThreadUploadSource.id);
                              }}
                              onDrop={(event) => {
                                event.preventDefault();
                                setDraggingDataSourceId(null);
                                const files = Array.from(event.dataTransfer.files ?? []);
                                if (files.length) {
                                  void handleUploadDataSourceFile(activeThreadUploadSource, files);
                                }
                              }}
                            >
                              <input
                                hidden
                                multiple
                                onChange={(event) => {
                                  const files = Array.from(event.target.files ?? []);
                                  if (files.length) {
                                    void handleUploadDataSourceFile(activeThreadUploadSource, files);
                                  }
                                  event.currentTarget.value = "";
                                }}
                                type="file"
                              />
                              <span>
                                {uploadingDataSourceId === activeThreadUploadSource.id
                                  ? "上传中..."
                                  : draggingDataSourceId === activeThreadUploadSource.id
                                    ? "松手后上传"
                                    : "上传"}
                              </span>
                            </label>
                          ) : (
                            <button
                              className="secondary thread-context-upload-action"
                              onClick={() => openDataSourceDraft("upload", selectedThread.knowledge_base_id)}
                              type="button"
                            >
                              上传
                            </button>
                          )}
                          <button
                            className="secondary thread-context-upload-action"
                            onClick={() => openDataSourceDraft("web", selectedThread.knowledge_base_id)}
                            type="button"
                          >
                            网页
                          </button>
                          <button
                            className="secondary thread-context-upload-action"
                            onClick={() => openDataSourceDraft("es", selectedThread.knowledge_base_id)}
                            type="button"
                          >
                            ES
                          </button>
                          <button
                            className="secondary thread-context-upload-action"
                            onClick={() => openDataSourceDraft("db", selectedThread.knowledge_base_id)}
                            type="button"
                          >
                            数据库
                          </button>
                        </div>
                      ) : null
                    }
                    contextBadge={contextBadgeLabel(selectedThread)}
                    contextHint={
                      selectedThread.knowledge_base_name
                        ? activeThreadUploadSource
                          ? "可继续补充文档，后续检索会覆盖这些新资料。"
                          : "当前会话已绑定资料库；可在管理面板补充来源。"
                        : "当前是纯聊天会话；需要时再挂接资料库或上传资料。"
                    }
                    onError={setError}
                    onOpenArtifact={handleOpenArtifact}
                    onOpenEvidence={handleOpenEvidence}
                    onInterrupt={handleInterrupt}
                    onInsertReference={handleInsertReferenceIntoCurrentThread}
                    onSend={sendUserMessage}
                    operatorMode={false}
                    starterPrompts={buildThreadStarterPrompts(selectedThread)}
                    thread={selectedThread}
                  />
                </Suspense>
            ) : (
                <div className="conversation-empty-state">
                  <div className="conversation-empty-copy">
                    <strong>{selectedThread ? "开始新会话" : "开始一个新的研究会话"}</strong>
                    <p>
                      {selectedThread
                        ? "当前会话不会被打断。你可以在这里直接启动下一条研究线，再随时切回来看旧结果。"
                        : "直接在这里开始聊天或启动 agent。需要资料时再挂接资料库、搜索来源或上传文档，不再要求先绑定服务器目录。"}
                    </p>
                  </div>
                  <form className="conversation-quickstart-card" onSubmit={handleCreateThread}>
                    <div className="conversation-quickstart-grid">
                      <label>
                        项目
                        <select
                          value={selectedProjectId}
                          onChange={(event) => handleSelectProjectForThread(event.target.value)}
                        >
                          <option value="">纯聊天，不绑定项目</option>
                          {projects.map((project) => (
                            <option key={project.id} value={project.id}>
                              {project.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label>
                        资料库
                        <select
                          value={selectedKnowledgeBaseId}
                          onChange={(event) => setSelectedKnowledgeBaseId(event.target.value)}
                        >
                          <option value="">不绑定资料库</option>
                          {knowledgeBases.map((item) => (
                            <option key={item.id} value={item.id}>
                              {item.name}
                            </option>
                          ))}
                        </select>
                      </label>
                      <div className="conversation-quickstart-info">
                        <strong>
                          {activeKnowledgeLabel({
                            projectName: currentProject?.name,
                            knowledgeBaseName:
                              knowledgeBases.find((item) => item.id === selectedKnowledgeBaseId)?.name ?? null,
                            workspaceRoot,
                          })}
                        </strong>
                        <span>
                          {selectedProjectId || selectedKnowledgeBaseId || workspaceRoot.trim()
                            ? contextBadgeLabel({
                                projectName: currentProject?.name,
                                knowledgeBaseName:
                                  knowledgeBases.find((item) => item.id === selectedKnowledgeBaseId)?.name ?? null,
                                workspaceRoot: currentProject?.workspace_root ?? workspaceRoot,
                              })
                            : "当前是纯聊天模式。稍后可在设置里接入资料库、Elasticsearch 或其他数据源。"}
                        </span>
                      </div>
                    </div>
                    <label>
                      主题
                      <input
                        value={topic}
                        onChange={(event) => setTopic(event.target.value)}
                        placeholder="例如 分析某个主题、产品、仓库或研究问题"
                      />
                    </label>
                    <label>
                      起始消息
                      <textarea
                        onChange={(event) => setLaunchPrompt(event.target.value)}
                        placeholder="可选：创建后立即发给 agent 的第一条请求"
                        rows={4}
                        value={launchPrompt}
                      />
                    </label>
                    <div className="conversation-quickstart-meta">
                      <span className="input-hint">
                        {serviceModelStatusLabel({
                          standaloneModelReady,
                          hasStandaloneModelConfig,
                          modelName,
                        })}
                      </span>
                      <div className="conversation-empty-actions">
                        {selectedKnowledgeBaseUploadSource ? (
                          <label
                            className={`secondary inline-upload-action ${
                              draggingDataSourceId === selectedKnowledgeBaseUploadSource.id ? "dragging" : ""
                            }`}
                            onDragEnter={(event) => {
                              event.preventDefault();
                              setDraggingDataSourceId(selectedKnowledgeBaseUploadSource.id);
                            }}
                            onDragLeave={(event) => {
                              event.preventDefault();
                              if (!(event.currentTarget as HTMLLabelElement).contains(event.relatedTarget as Node | null)) {
                                setDraggingDataSourceId((current) =>
                                  current === selectedKnowledgeBaseUploadSource.id ? null : current,
                                );
                              }
                            }}
                            onDragOver={(event) => {
                              event.preventDefault();
                              setDraggingDataSourceId(selectedKnowledgeBaseUploadSource.id);
                            }}
                            onDrop={(event) => {
                              event.preventDefault();
                              setDraggingDataSourceId(null);
                              const files = Array.from(event.dataTransfer.files ?? []);
                              if (files.length) {
                                void handleUploadDataSourceFile(selectedKnowledgeBaseUploadSource, files);
                              }
                            }}
                          >
                            <input
                              hidden
                              multiple
                              onChange={(event) => {
                                const files = Array.from(event.target.files ?? []);
                                if (files.length) {
                                  void handleUploadDataSourceFile(selectedKnowledgeBaseUploadSource, files);
                                }
                                event.currentTarget.value = "";
                              }}
                              type="file"
                            />
                            <span>
                              {uploadingDataSourceId === selectedKnowledgeBaseUploadSource.id
                                ? "上传中..."
                                : draggingDataSourceId === selectedKnowledgeBaseUploadSource.id
                                  ? "松手后上传"
                                  : "先上传资料"}
                            </span>
                          </label>
                        ) : null}
                        {selectedKnowledgeBaseId ? (
                          <>
                            {!selectedKnowledgeBaseUploadSource ? (
                              <button
                                className="secondary"
                                onClick={() => openDataSourceDraft("upload", selectedKnowledgeBaseId)}
                                type="button"
                              >
                                上传资料
                              </button>
                            ) : null}
                            <button
                              className="secondary"
                              onClick={() => openDataSourceDraft("web", selectedKnowledgeBaseId)}
                              type="button"
                            >
                              接入网页
                            </button>
                            <button
                              className="secondary"
                              onClick={() => openDataSourceDraft("es", selectedKnowledgeBaseId)}
                              type="button"
                            >
                              接入 ES
                            </button>
                            <button
                              className="secondary"
                              onClick={() => openDataSourceDraft("db", selectedKnowledgeBaseId)}
                              type="button"
                            >
                              接入数据库
                            </button>
                          </>
                        ) : null}
                        <button disabled={busy || !activeAuth} type="submit">
                          {busy
                            ? launchPrompt.trim()
                              ? "创建并启动中…"
                              : "创建中…"
                            : launchPrompt.trim()
                              ? "创建并启动"
                              : "新建会话"}
                        </button>
                        {selectedThread ? (
                          <button
                            className="secondary"
                            onClick={() => setCreateThreadMode(false)}
                            type="button"
                          >
                            返回当前会话
                          </button>
                        ) : null}
                        <button
                          className="secondary"
                          onClick={() => setModelSettingsOpen(true)}
                          type="button"
                        >
                          模型设置
                        </button>
                        <button
                          className="secondary"
                          onClick={() => setSettingsOpen(true)}
                          type="button"
                        >
                          资料与设置
                        </button>
                      </div>
                    </div>
                  </form>
                  {surfaceErrorMessage ? (
                    <p className="conversation-empty-note">{surfaceErrorMessage}</p>
                  ) : null}
                </div>
              )}
            </section>
          </main>
          }
        />
      )}
    </div>
  );
}
