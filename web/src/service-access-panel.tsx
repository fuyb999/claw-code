import type { AuthSession, ClawdConfig } from "./types";

type ServiceAccessPanelProps = {
  apiKey: string;
  authSession: AuthSession | null;
  config: ClawdConfig | null;
  onApiKeyChange: (value: string) => void;
  onUserIdChange: (value: string) => void;
  showProtocolHints?: boolean;
  title?: string;
  userId: string;
};

export function ServiceAccessPanel({
  apiKey,
  authSession,
  config,
  onApiKeyChange,
  onUserIdChange,
  showProtocolHints = false,
  title = "服务接入",
  userId,
}: ServiceAccessPanelProps) {
  return (
    <article className="card operator-card">
      <div className="section-title">{title}</div>
      <div className="stack-form">
        <label>
          API 密钥
          <input
            value={apiKey}
            onChange={(event) => onApiKeyChange(event.target.value)}
            placeholder="输入用于访问服务的 API 密钥"
            type="password"
          />
        </label>
        {config?.dev_user_header_auth_enabled ? (
          <label>
            用户标识
            <input
              value={userId}
              onChange={(event) => onUserIdChange(event.target.value)}
              placeholder="开发模式下可直接填写用户标识"
            />
          </label>
        ) : null}
        <div className="input-hint">正式环境建议使用 API 密钥接入。</div>
        {showProtocolHints ? (
          <div className="input-hint">
            浏览器流式连接会通过 query 参数携带 `api_key`，普通请求继续走 `Authorization:
            Bearer`。
          </div>
        ) : null}
        {authSession ? (
          <div className="input-hint">
            当前会话：{authSession.user_id}
            {authSession.tenant_id ? ` @ ${authSession.tenant_id}` : ""}
            {authSession.display_name ? ` (${authSession.display_name})` : ""}
          </div>
        ) : null}
        {!config?.dev_user_header_auth_enabled ? (
          <div className="input-hint">当前服务未开启备用用户标识接入。</div>
        ) : null}
      </div>
    </article>
  );
}
