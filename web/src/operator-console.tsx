import type { FormEvent } from "react";

import { AuditPanel } from "./audit-panel";
import { presentDirectoryName, presentPermissionMode } from "./presentation";
import { ServiceAccessPanel } from "./service-access-panel";
import type {
  ApiKeySummary,
  AuthSession,
  ClawdConfig,
  CreatedApiKey,
  RequestAuth,
  ThreadSnapshot,
} from "./types";

export type EventLogEntry = {
  id: string;
  kind: string;
  at: number;
  detail: string;
};

type OperatorConsoleProps = {
  activeAuth: RequestAuth | null;
  apiKey: string;
  apiKeyDisplayName: string;
  apiKeysBusy: boolean;
  apiKeysLoading: boolean;
  authSession: AuthSession | null;
  config: ClawdConfig | null;
  events: EventLogEntry[];
  latestCreatedApiKey: CreatedApiKey | null;
  managedApiKeys: ApiKeySummary[];
  onApiKeyChange: (value: string) => void;
  onApiKeyDisplayNameChange: (value: string) => void;
  onCreateApiKey: (event: FormEvent<HTMLFormElement>) => void;
  onDisableApiKey: (apiKeyId: string) => Promise<void>;
  onDismissLatestCreatedApiKey: () => void;
  onUseLatestCreatedApiKey: () => void;
  onUserIdChange: (value: string) => void;
  selectedThread: ThreadSnapshot | null;
  userId: string;
};

function formatTime(epochMs: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    month: "2-digit",
    day: "2-digit",
  }).format(epochMs);
}

function formatLimit(limit: number | null | undefined): string {
  return typeof limit === "number" ? String(limit) : "不限";
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

function memoryScopeLabel(scope: "thread" | "workspace" | "tenant"): string {
  if (scope === "workspace") {
    return "资料集共享";
  }

  if (scope === "tenant") {
    return "团队共享";
  }

  return "当前会话";
}

function threadStatusLabel(status: ThreadSnapshot["status"]): string {
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

export function OperatorConsole({
  activeAuth,
  apiKey,
  apiKeyDisplayName,
  apiKeysBusy,
  apiKeysLoading,
  authSession,
  config,
  events,
  latestCreatedApiKey,
  managedApiKeys,
  onApiKeyChange,
  onApiKeyDisplayNameChange,
  onCreateApiKey,
  onDisableApiKey,
  onDismissLatestCreatedApiKey,
  onUseLatestCreatedApiKey,
  onUserIdChange,
  selectedThread,
  userId,
}: OperatorConsoleProps) {
  return (
    <div className="operator-shell">
      <div className="operator-summary-grid">
        <article className="card metric-card">
          <span className="eyebrow">服务接入</span>
          <strong>{activeAuth ? "已接入" : "未认证"}</strong>
          <p>
            {authModeLabel(authSession?.auth_mode)}
            {authSession?.tenant_id ? ` · ${authSession.tenant_id}` : " · 个人"}
          </p>
        </article>
        <article className="card metric-card">
          <span className="eyebrow">存储后端</span>
          <strong>{config?.database_backend ?? "未知"}</strong>
          <p>
            结构版本{" "}
            {config?.database_schema_version
              ? `v${config.database_schema_version}`
              : "未知"}
          </p>
        </article>
        <article className="card metric-card">
          <span className="eyebrow">运行容量</span>
          <strong>
            G {formatLimit(config?.max_concurrent_runs_global)} / T{" "}
            {formatLimit(config?.max_concurrent_runs_per_tenant)} / U{" "}
            {formatLimit(config?.max_concurrent_runs_per_user)}
          </strong>
          <p>并发运行上限</p>
        </article>
        <article className="card metric-card">
          <span className="eyebrow">治理边界</span>
          <strong>
            T {formatLimit(config?.max_threads_per_tenant)} / U{" "}
            {formatLimit(config?.max_threads_per_user)}
          </strong>
          <p>
            会话配额，写请求 G {formatLimit(config?.max_mutation_requests_per_minute_global)} /
            T {formatLimit(config?.max_mutation_requests_per_minute_per_tenant)} / U{" "}
            {formatLimit(config?.max_mutation_requests_per_minute_per_user)} / min
          </p>
        </article>
      </div>

      <div className="operator-grid">
        <ServiceAccessPanel
          apiKey={apiKey}
          authSession={authSession}
          config={config}
          onApiKeyChange={onApiKeyChange}
          onUserIdChange={onUserIdChange}
          showProtocolHints
          title="认证与接入"
          userId={userId}
        />

        <article className="card operator-card">
          <div className="section-title">服务概况</div>
          <div className="service-facts">
            <span>默认模型 {config?.default_model ?? "未配置"}</span>
            <span>默认权限 {presentPermissionMode(config?.default_permission_mode)}</span>
            <span>运行超时 {config?.run_timeout_secs ? `${config.run_timeout_secs}s` : "未启用"}</span>
            <span>资料接入 连接式</span>
          </div>
          <div className="input-hint">
            管理控制台集中展示接入、配额、事件与持久诊断，不再打扰默认聊天界面。
          </div>
        </article>

        <article className="card operator-card">
          <div className="section-title">API 密钥</div>
          {!authSession ? (
            <div className="empty-state">先完成认证，再加载 API 密钥管理面板。</div>
          ) : !authSession.tenant_id ? (
            <div className="empty-state">
              当前是个人会话。API 密钥管理需要团队级 API 密钥登录。
            </div>
          ) : (
            <>
              <form className="stack-form" onSubmit={onCreateApiKey}>
                <label>
                  名称
                  <input
                    value={apiKeyDisplayName}
                    onChange={(event) => onApiKeyDisplayNameChange(event.target.value)}
                    placeholder="例如 浏览器 / 自动化 / 研究员电脑"
                  />
                </label>
                <button
                  className="secondary"
                  disabled={apiKeysBusy || !activeAuth}
                  type="submit"
                >
                  创建新密钥
                </button>
              </form>
              <div className="input-hint">
                新建密钥只会展示一次。先切换到新密钥，再禁用旧密钥。
              </div>
              {latestCreatedApiKey ? (
                <article className="secret-panel">
                  <header>
                    <strong>
                      {latestCreatedApiKey.api_key.display_name ?? "新建 API 密钥"}
                    </strong>
                    <span>{latestCreatedApiKey.api_key.key_prefix}</span>
                  </header>
                  <pre>{latestCreatedApiKey.raw_key}</pre>
                  <div className="inline-actions">
                    <button
                      className="secondary"
                      onClick={onUseLatestCreatedApiKey}
                      type="button"
                    >
                      切换到这个密钥
                    </button>
                    <button
                      className="secondary"
                      onClick={onDismissLatestCreatedApiKey}
                      type="button"
                    >
                      收起
                    </button>
                  </div>
                </article>
              ) : null}
              {apiKeysLoading ? (
                <div className="empty-state">加载 API 密钥中…</div>
              ) : managedApiKeys.length === 0 ? (
                <div className="empty-state">当前用户还没有 API 密钥。</div>
              ) : (
                <div className="memory-list">
                  {managedApiKeys.map((item) => {
                    const isCurrent = authSession.api_key_id === item.id;
                    const isDisabled = Boolean(item.disabled_at_ms);
                    return (
                      <article className="memory-item" key={item.id}>
                        <header>
                          <strong>{item.display_name ?? item.key_prefix}</strong>
                          <div className="api-key-badges">
                            {isCurrent ? <span className="key-pill current">当前</span> : null}
                            {isDisabled ? (
                              <span className="key-pill disabled">已禁用</span>
                            ) : (
                              <span className="key-pill active">可用</span>
                            )}
                          </div>
                        </header>
                        <div className="api-key-meta">
                          <span>前缀: {item.key_prefix}</span>
                          <span>创建: {formatTime(item.created_at_ms)}</span>
                          <span>
                            最近使用:{" "}
                            {item.last_used_at_ms
                              ? formatTime(item.last_used_at_ms)
                              : "未使用"}
                          </span>
                          {item.disabled_at_ms ? (
                            <span>禁用时间: {formatTime(item.disabled_at_ms)}</span>
                          ) : null}
                        </div>
                        <div className="inline-actions">
                          <button
                            className="secondary"
                            disabled={apiKeysBusy || isDisabled || isCurrent}
                            onClick={() => void onDisableApiKey(item.id)}
                            type="button"
                          >
                            {isCurrent ? "正在使用" : "禁用"}
                          </button>
                        </div>
                      </article>
                    );
                  })}
                </div>
              )}
            </>
          )}
        </article>

        <article className="card operator-card">
          <div className="section-title">当前会话诊断</div>
          {selectedThread ? (
            <div className="operator-thread-stack">
              <div className="workspace-callout">
                <header>
                  <strong>{selectedThread.topic ?? "未设置主题"}</strong>
                  <span className={`status-pill status-${selectedThread.status}`}>
                    {threadStatusLabel(selectedThread.status)}
                  </span>
                </header>
                <p>{selectedThread.project_name ?? "未绑定项目"}</p>
                <div className="workspace-meta">
                  <span>
                    {presentDirectoryName(selectedThread.workspace_root) === "纯聊天"
                      ? "模式 纯聊天"
                      : `资料库 ${presentDirectoryName(selectedThread.workspace_root)}`}
                  </span>
                  <span>模型 {selectedThread.model}</span>
                  <span>权限 {presentPermissionMode(selectedThread.permission_mode)}</span>
                  <span>更新于 {formatTime(selectedThread.updated_at_ms)}</span>
                </div>
              </div>
              <div className="overview-metrics operator-metrics">
                <article>
                  <span>结果</span>
                  <strong>{selectedThread.artifacts.length}</strong>
                </article>
                <article>
                  <span>记忆</span>
                  <strong>{selectedThread.memory_notes.length}</strong>
                </article>
                <article>
                  <span>审计</span>
                  <strong>{selectedThread.audit_records.length}</strong>
                </article>
                <article>
                  <span>消息</span>
                  <strong>{selectedThread.messages.length}</strong>
                </article>
              </div>
            </div>
          ) : (
            <div className="empty-state">先选择一个会话，再查看运行诊断和持久轨迹。</div>
          )}
        </article>

        <article className="card operator-card">
          <div className="section-title">可见记忆</div>
          {selectedThread?.memory_notes.length ? (
            <div className="memory-list">
              {selectedThread.memory_notes.map((note) => (
                <article className="memory-item" key={note.id}>
                  <header>
                    <strong>{formatTime(note.created_at_ms)}</strong>
                    <span className={`scope-pill scope-${note.scope}`}>
                      {memoryScopeLabel(note.scope)}
                    </span>
                  </header>
                  <p>{note.note}</p>
                  {note.tags.length ? (
                    <div className="tags">
                      {note.tags.map((tag) => (
                        <span key={tag}>{tag}</span>
                      ))}
                    </div>
                  ) : null}
                </article>
              ))}
            </div>
          ) : (
            <div className="empty-state">当前会话还没有可见记忆。</div>
          )}
        </article>

        <article className="card operator-card">
          <div className="section-title">事件流</div>
          <div className="event-list">
            {events.length === 0 ? (
              <div className="empty-state">等待事件…</div>
            ) : (
              events.map((item) => (
                <article className="event-item" key={item.id}>
                  <header>
                    <span>{item.kind}</span>
                    <span>{formatTime(item.at)}</span>
                  </header>
                  <pre>{item.detail}</pre>
                </article>
              ))
            )}
          </div>
        </article>

        <AuditPanel operatorMode thread={selectedThread} title="持久审计轨迹" />
      </div>
    </div>
  );
}
