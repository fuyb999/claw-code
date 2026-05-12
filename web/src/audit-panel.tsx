import type { AuditRecord, ThreadSnapshot } from "./types";
import { presentExpertPanelStage } from "./expert-panels";
import { presentArtifactKind } from "./presentation";
import { presentRuntimeError } from "./runtime-error";

function formatTime(epochMs: number): string {
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    month: "2-digit",
    day: "2-digit",
  }).format(epochMs);
}

function asObject(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return null;
  }

  return value as Record<string, unknown>;
}

function previewText(value: unknown): string | null {
  if (typeof value === "string") {
    return value;
  }

  const object = asObject(value);
  if (!object || typeof object.preview !== "string") {
    return null;
  }

  return object.preview;
}

function truncate(value: string, maxLength = 140): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function auditHeadline(record: AuditRecord): string {
  const payload = asObject(record.payload);
  const toolName = typeof payload?.tool_name === "string" ? payload.tool_name : null;
  const artifactKind = typeof payload?.kind === "string" ? payload.kind : null;

  switch (record.kind) {
    case "thread_created":
      return "已创建会话";
    case "topic_updated":
      return "已更新主题";
    case "replan_queued":
      return "已请求重规划";
    case "interrupt_requested":
      return "已请求停止";
    case "run_started":
      return "开始新一轮分析";
    case "run_completed":
      return "本轮分析完成";
    case "run_interrupted":
      return "本轮分析已停止";
    case "run_failed":
      return "本轮分析未完成";
    case "tool_use":
      return toolName ? `调用 ${toolName}` : "调用工具";
    case "tool_result":
      return toolName ? `${toolName} 已返回` : "工具已返回结果";
    case "memory_written":
      return "已写入记忆";
    case "artifact_added":
      return artifactKind ? `已生成${presentArtifactKind(artifactKind)}` : "已生成结构化结果";
    case "expert_panel_emit":
      return "已登记专家会诊进展";
    default:
      return record.kind;
  }
}

function summarizeAudit(record: AuditRecord): string {
  const payload = asObject(record.payload);
  const topic = typeof payload?.topic === "string" ? payload.topic : null;
  const reason = typeof payload?.reason === "string" ? payload.reason : null;
  const toolName = typeof payload?.tool_name === "string" ? payload.tool_name : null;
  const artifactKind = typeof payload?.kind === "string" ? payload.kind : null;
  const error = typeof payload?.error === "string" ? payload.error : null;
  const note = previewText(payload?.note);
  const prompt = previewText(payload?.prompt);
  const expertName = typeof payload?.expert_name === "string" ? payload.expert_name : null;
  const stage = typeof payload?.stage === "string" ? payload.stage : null;
  const stageLabel = presentExpertPanelStage(stage);
  const summary = typeof payload?.summary === "string" ? payload.summary : null;

  switch (record.kind) {
    case "thread_created":
      return `会话已创建${topic ? `，主题：${topic}` : ""}`;
    case "topic_updated":
      return topic ? `主题更新为：${topic}` : "主题已更新";
    case "replan_queued":
      return `已排队重规划${reason ? `：${reason}` : ""}`;
    case "interrupt_requested":
      return reason ? `请求打断：${reason}` : "请求打断当前运行";
    case "run_started":
      return prompt ? `开始新一轮分析：${prompt}` : "开始新一轮分析";
    case "run_completed":
      return "当前这轮任务已完成。";
    case "run_interrupted":
      return "当前这轮任务已按请求停止。";
    case "run_failed":
      if (error) {
        const presented = presentRuntimeError(error);
        if (presented?.shortLabel) {
          return `本轮分析未完成：${presented.shortLabel}`;
        }
        return `本轮分析失败：${truncate(presented?.userMessage ?? error)}`;
      }
      return "本轮分析失败。";
    case "tool_use":
      return toolName ? `调用工具 ${toolName}` : "调用工具";
    case "tool_result":
      return toolName ? `工具 ${toolName} 已返回结果` : "工具已返回结果";
    case "memory_written":
      return note ? `写入记忆：${note}` : "写入了新的记忆";
    case "artifact_added":
      return artifactKind
        ? `新增${presentArtifactKind(artifactKind)}结果`
        : "新增结构化结果";
    case "expert_panel_emit":
      if (expertName) {
        return `${expertName} 已完成${stageLabel ? ` ${stageLabel}` : ""}${summary ? `：${truncate(summary)}` : ""}`;
      }
      if (stageLabel) {
        return `专家会诊进入 ${stageLabel}${summary ? `：${truncate(summary)}` : ""}`;
      }
      return "已记录一条专家会诊进展";
    default:
      return record.kind;
  }
}

function payloadJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return "unserializable payload";
  }
}

function auditKindMeta(record: AuditRecord): string {
  switch (record.kind) {
    case "run_started":
    case "run_completed":
    case "run_interrupted":
    case "run_failed":
      return "运行";
    case "tool_use":
    case "tool_result":
      return "工具";
    case "replan_queued":
    case "topic_updated":
    case "interrupt_requested":
      return "控制";
    case "artifact_added":
      return "结果";
    case "expert_panel_emit":
      return "专家会诊";
    case "memory_written":
      return "记忆";
    default:
      return "会话";
  }
}

type AuditPanelProps = {
  thread: ThreadSnapshot | null;
  operatorMode?: boolean;
  embedded?: boolean;
  title?: string;
};

export function AuditPanel({
  thread,
  operatorMode = false,
  embedded = false,
  title,
}: AuditPanelProps) {
  const records = thread?.audit_records ?? [];
  const ordered = [...records].reverse();
  const heading = title ?? (operatorMode ? "审计轨迹" : "工作轨迹");
  const content = ordered.length ? (
    <div className="audit-list">
      {ordered.map((record) => (
        <article className="audit-item" key={record.id}>
          <header>
            <span className="audit-kind">{auditKindMeta(record)}</span>
            <span>{formatTime(record.created_at_ms)}</span>
          </header>
          <strong className="audit-headline">{auditHeadline(record)}</strong>
          <p className="audit-summary">{summarizeAudit(record)}</p>
          <div className="audit-meta">
            {record.run_id !== null ? <span>第 {record.run_id} 轮</span> : <span>会话</span>}
          </div>
          {operatorMode ? (
            <details className="audit-payload">
              <summary>原始数据</summary>
              <pre>{payloadJson(record.payload)}</pre>
            </details>
          ) : null}
        </article>
      ))}
    </div>
  ) : (
    <div className="empty-state">
      {operatorMode
        ? "运行和工具事件会以持久审计轨迹的形式显示在这里。"
        : "开始运行后，这里会显示主题更新、重规划和结构化产出等关键进展。"}
    </div>
  );

  if (embedded) {
    return (
      <>
        <div className="section-title">{heading}</div>
        {content}
      </>
    );
  }

  return (
    <article className="card audit-card">
      <div className="section-title">{heading}</div>
      {content}
    </article>
  );
}
