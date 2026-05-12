import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AssistantRuntimeProvider,
  ComposerPrimitive,
  MessagePrimitive,
  ThreadPrimitive,
  useAuiState,
  useComposerRuntime,
  useExternalStoreRuntime,
  useMessagePartText,
  type AppendMessage,
  type DataMessagePartProps,
  type ThreadMessageLike,
} from "@assistant-ui/react";

import { isRecord, readNumber, readString, stringifyValue } from "./evidence";
import {
  appendMessageReference,
  extractWorkbenchReferencesFromMarkdown,
  formatReferenceAnchor,
  type MessageReference,
} from "./message-links";
import { presentArtifactKind } from "./presentation";
import { appendComposerText, workbenchReferenceMarkdown } from "./reference-utils";
import type { MessageBlock, ThreadSnapshot } from "./types";
import { WorkbenchMarkdown } from "./workbench-markdown";
import { presentRuntimeError } from "./runtime-error";

type AssistantThreadPanelProps = {
  thread: ThreadSnapshot;
  onSend: (content: string) => Promise<void>;
  onInterrupt: () => Promise<void>;
  onError: (message: string) => void;
  contextBadge?: string | null;
  contextHint?: string | null;
  contextAction?: ReactNode;
  composerTopSlot?: ReactNode;
  onOpenEvidence?: (evidenceId: string, anchor?: string | null) => void;
  onOpenArtifact?: (artifactId: string, anchor?: string | null) => void;
  onInsertReference?: (text: string) => void;
  composerSeed?: {
    text: string;
    nonce: number;
    threadId: string;
    mode: "replace" | "append";
  } | null;
  starterPrompts?: string[];
  boundaryControls?: ReactNode;
  operatorMode?: boolean;
};

type ClawdToolUseData = {
  id: string;
  name: string;
  input: string;
};

type ClawdToolResultData = {
  tool_use_id: string;
  tool_name: string;
  output: string;
  is_error: boolean;
};

export type ClawdStepData = {
  toolUseId: string;
  toolName: string;
  title: string;
  requestDetail: string | null;
  requestInput: string | null;
  resultTitle: string | null;
  resultDetail: string | null;
  resultOutput: string | null;
  isError: boolean;
};

function shouldRetainToolResultOutput(toolName: string): boolean {
  return (
    toolName === "EsSearch" ||
    toolName === "SourceSearch" ||
    toolName === "WebFetch" ||
    toolName === "DbQuery"
  );
}

type ClawdMessagePart =
  | { type: "text"; text: string }
  | { type: "data-clawd_step"; data: ClawdStepData };

type ClawdMutableThreadMessage = {
  id: string;
  role: "system" | "user" | "assistant";
  content: ClawdMessagePart[];
  status?: { type: "complete"; reason: "stop" } | { type: "running" };
  metadata: {
    custom: {
      sourceRole: "system" | "user" | "assistant" | "tool";
      draft: boolean;
      evidenceRefs: MessageReference[];
      artifactRefs: MessageReference[];
      steps: ClawdStepData[];
    };
  };
  stepIndexByToolUseId: Map<string, number>;
};

type MessageOutcomeSummary = {
  artifactCount: number;
  evidenceCount: number;
  stepCount: number;
  failedStepCount: number;
  runningStepCount: number;
  previewArtifacts: MessageReference[];
  previewEvidence: MessageReference[];
};

type LiveRunSignal = {
  id: string;
  label: string;
  detail: string | null;
  state: "running" | "done" | "error";
};

type ParsedEsSearchResult = {
  query: string | null;
  index: string | null;
  fields: string[];
  sourceFields: string[];
  total: number | null;
  hits: unknown[];
  message: string | null;
  status: number | null;
  detail: unknown;
};

type ParsedWebFetchResult = {
  url: string | null;
  contentType: string | null;
  text: string | null;
  artifactId: string | null;
  artifactTitle: string | null;
};

type ParsedDbQueryResult = {
  query: string | null;
  columns: string[];
  rows: unknown[];
  rowCount: number | null;
  artifactId: string | null;
  artifactTitle: string | null;
};

type ThreadViewportState =
  | { kind: "welcome" }
  | {
      kind: "running" | "interrupt_requested" | "failed" | "idle_empty";
      eyebrow: string;
      title: string;
      description: string;
    };

const INTERNAL_TOOL_NAMES = new Set([
  "MemoryWrite",
  "MemorySearch",
  "TopicDriftCheck",
  "Skill",
  "ExpertPanelEmit",
]);
const EMPTY_MESSAGE_REFERENCES: MessageReference[] = [];
const EMPTY_MESSAGE_STEPS: ClawdStepData[] = [];

function isUserVisibleTool(name: string): boolean {
  return !INTERNAL_TOOL_NAMES.has(name);
}

function parseInputObject(input: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(input) as unknown;
    return isRecord(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function firstNonEmptyString(
  record: Record<string, unknown> | null,
  keys: readonly string[],
): string | null {
  if (!record) {
    return null;
  }

  for (const key of keys) {
    const value = readString(record[key]);
    if (value) {
      return value;
    }
  }

  return null;
}

function truncate(value: string, maxLength = 180): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
}

function artifactKindDetail(record: Record<string, unknown> | null): string | null {
  const title = firstNonEmptyString(record, ["title"]);
  if (title) {
    return title;
  }

  const kind = firstNonEmptyString(record, ["kind"]);
  return kind ? presentArtifactKind(kind) : null;
}

function presentResourceHint(value: string | null): string | null {
  if (!value) {
    return null;
  }

  const trimmed = value.trim();
  if (!trimmed) {
    return null;
  }

  const segments = trimmed.split("/").filter(Boolean);
  if (segments.length === 0) {
    return trimmed;
  }

  return segments[segments.length - 1] ?? trimmed;
}

function toolLabel(name: string): string {
  switch (name) {
    case "EsSearch":
      return "检索来源";
    case "SourceSearch":
      return "检索文档";
    case "SourceRead":
      return "读取文档";
    case "WebFetch":
      return "读取网页";
    case "DbQuery":
      return "查询数据库";
    case "read_file":
      return "查看文件";
    case "glob_search":
      return "扫描文件";
    case "grep_search":
      return "搜索内容";
    case "ArtifactEmit":
      return "整理结果";
    default:
      return name;
  }
}

function summarizeToolUse(data: ClawdToolUseData): { title: string; detail: string | null } {
  const input = parseInputObject(data.input);

  switch (data.name) {
    case "EsSearch":
    case "SourceSearch":
      return {
        title: toolLabel(data.name),
        detail: firstNonEmptyString(input, ["query"]),
      };
    case "SourceRead":
      return {
        title: toolLabel(data.name),
        detail:
          firstNonEmptyString(input, ["file_name", "file_id"]) ??
          presentResourceHint(firstNonEmptyString(input, ["path"])),
      };
    case "WebFetch":
      return {
        title: toolLabel(data.name),
        detail: firstNonEmptyString(input, ["url"]),
      };
    case "DbQuery":
      return {
        title: toolLabel(data.name),
        detail: firstNonEmptyString(input, ["sql"]),
      };
    case "read_file":
      return {
        title: toolLabel(data.name),
        detail: presentResourceHint(firstNonEmptyString(input, ["path"])),
      };
    case "glob_search":
      return {
        title: toolLabel(data.name),
        detail:
          firstNonEmptyString(input, ["pattern"]) ??
          presentResourceHint(firstNonEmptyString(input, ["path"])),
      };
    case "grep_search":
      return {
        title: toolLabel(data.name),
        detail:
          firstNonEmptyString(input, ["query", "pattern"]) ??
          presentResourceHint(firstNonEmptyString(input, ["path"])),
      };
    case "ArtifactEmit":
      return {
        title: toolLabel(data.name),
        detail: artifactKindDetail(input),
      };
    default:
      return {
        title: toolLabel(data.name),
        detail:
          firstNonEmptyString(input, ["title", "query", "pattern"]) ??
          presentResourceHint(firstNonEmptyString(input, ["path"])),
      };
  }
}

function summarizeToolResult(data: ClawdToolResultData): { title: string; detail: string | null } {
  if (data.tool_name === "EsSearch" || data.tool_name === "SourceSearch") {
    const parsed = parseEsSearchResult(data.output);
    if (!parsed) {
      return {
        title: data.is_error ? "检索失败" : "检索完成",
        detail: truncate(data.output),
      };
    }
    if (data.is_error) {
      return {
        title: data.tool_name === "SourceSearch" ? "文档检索失败" : "检索失败",
        detail: parsed.message ? truncate(parsed.message) : null,
      };
    }
    return {
      title:
        data.tool_name === "SourceSearch"
          ? `找到 ${parsed.total ?? parsed.hits.length} 份文档线索`
          : `找到 ${parsed.total ?? parsed.hits.length} 条来源`,
      detail: parsed.query ? truncate(parsed.query) : null,
    };
  }

  if (data.tool_name === "ArtifactEmit") {
    const parsed = parseInputObject(data.output);
    return {
      title: data.is_error ? "结果整理失败" : "已生成结构化结果",
      detail: artifactKindDetail(parsed) ?? firstNonEmptyString(parsed, ["artifact_id"]),
    };
  }

  if (data.tool_name === "WebFetch") {
    const parsed = parseWebFetchResult(data.output);
    return {
      title: data.is_error ? "网页读取失败" : "已生成网页摘录",
      detail: parsed?.artifactTitle ?? parsed?.url ?? (data.is_error ? truncate(data.output) : null),
    };
  }

  if (data.tool_name === "DbQuery") {
    const parsed = parseDbQueryResult(data.output);
    return {
      title: data.is_error ? "数据库查询失败" : "已生成结果表格",
      detail: parsed?.artifactTitle ?? parsed?.query ?? (data.is_error ? truncate(data.output) : null),
    };
  }

  return {
    title: data.is_error ? `${toolLabel(data.tool_name)}失败` : `${toolLabel(data.tool_name)}完成`,
    detail: data.is_error ? truncate(data.output) : null,
  };
}

function appendReferenceToMessage(
  message: ClawdMutableThreadMessage,
  kind: "evidence" | "artifact",
  reference: MessageReference | null | undefined,
) {
  const key = kind === "evidence" ? "evidenceRefs" : "artifactRefs";
  message.metadata.custom[key] = appendMessageReference(
    message.metadata.custom[key],
    reference,
  );
}

function appendStepToMessage(message: ClawdMutableThreadMessage, step: ClawdStepData) {
  const nextIndex = message.metadata.custom.steps.length;
  message.metadata.custom.steps.push(step);
  message.stepIndexByToolUseId.set(step.toolUseId, nextIndex);
}

function mergeMessages(
  target: ClawdMutableThreadMessage,
  source: ClawdMutableThreadMessage,
) {
  for (const part of source.content) {
    target.content.push(part);
  }

  for (const reference of source.metadata.custom.artifactRefs) {
    appendReferenceToMessage(target, "artifact", reference);
  }

  for (const reference of source.metadata.custom.evidenceRefs) {
    appendReferenceToMessage(target, "evidence", reference);
  }

  for (const step of source.metadata.custom.steps) {
    appendStepToMessage(target, step);
  }
}

function updateStepInMessage(
  message: ClawdMutableThreadMessage,
  toolUseId: string,
  updater: (step: ClawdStepData) => ClawdStepData,
): boolean {
  const index = message.stepIndexByToolUseId.get(toolUseId);
  if (index === undefined) {
    return false;
  }

  const existing = message.metadata.custom.steps[index];
  if (!existing) {
    return false;
  }

  message.metadata.custom.steps[index] = updater(existing);
  return true;
}

function messageHasVisibleContent(message: ClawdMutableThreadMessage): boolean {
  return message.content.length > 0 || message.metadata.custom.steps.length > 0;
}

export function buildMessageOutcomeSummary(options: {
  artifactRefs: MessageReference[];
  evidenceRefs: MessageReference[];
  steps: ClawdStepData[];
}): MessageOutcomeSummary | null {
  const artifactCount = options.artifactRefs.length;
  const evidenceCount = options.evidenceRefs.length;
  const stepCount = options.steps.length;
  const failedStepCount = options.steps.filter((step) => step.isError).length;
  const runningStepCount = options.steps.filter((step) => !step.resultOutput).length;

  if (!artifactCount && !evidenceCount && !stepCount) {
    return null;
  }

  return {
    artifactCount,
    evidenceCount,
    stepCount,
    failedStepCount,
    runningStepCount,
    previewArtifacts: [...options.artifactRefs].slice(-2).reverse(),
    previewEvidence: [...options.evidenceRefs].slice(-2).reverse(),
  };
}

function describeRunSummary(summary: MessageOutcomeSummary): string {
  if (summary.runningStepCount) {
    if (summary.artifactCount) {
      return `正在补齐 ${summary.artifactCount} 份结果的说明与引用来源`;
    }
    if (summary.evidenceCount) {
      return `正在继续核对来源并补充分析`;
    }
    return "正在推进当前分析";
  }

  if (summary.failedStepCount && !summary.artifactCount && !summary.evidenceCount) {
    return `这轮已尝试推进分析，但有部分内容未成功完成`;
  }

  if (summary.artifactCount) {
    return `这轮已整理出 ${summary.artifactCount} 份结果${
      summary.evidenceCount ? `，并关联 ${summary.evidenceCount} 条来源` : ""
    }`;
  }

  if (summary.evidenceCount) {
    return `这轮已定位 ${summary.evidenceCount} 条可引用来源${
      summary.stepCount ? `，并完成初步整理` : ""
    }`;
  }

  return `这轮已完成 ${summary.stepCount} 个处理动作`;
}

export function buildThreadViewportState(
  thread: ThreadSnapshot,
  messageCount: number,
): ThreadViewportState | null {
  const hasDraftText = thread.draft_assistant_text.trim().length > 0;
  if (messageCount > 0 || hasDraftText) {
    return null;
  }

  if (thread.status === "running") {
    return {
      kind: "running",
      eyebrow: "Agent 运行中",
      title: "正在分析资料",
      description: "正在读取上下文、检索来源，并组织首段回复。",
    };
  }

  if (thread.status === "interrupt_requested") {
    return {
      kind: "interrupt_requested",
      eyebrow: "停止中",
      title: "正在停止当前任务",
      description: "当前执行会先安全结束，随后你可以继续追问、收束主题或重新规划。",
    };
  }

  if (thread.status === "failed") {
    const presented = presentRuntimeError(thread.last_error);
    return {
      kind: "failed",
      eyebrow: presented?.shortLabel ?? "本轮未完成",
      title:
        presented?.shortLabel === "额度不足"
          ? "模型服务当前额度不足"
          : presented?.shortLabel === "模型未配置"
            ? "模型服务尚未完成配置"
            : presented?.shortLabel === "鉴权失败"
              ? "模型服务拒绝了当前请求"
              : "这轮任务没有生成可展示回复",
      description:
        presented?.actionHint ??
        "可以直接补充目标、缩小范围，或换一种要求重新发起分析。",
    };
  }

  if (thread.audit_records.length <= 1) {
    return { kind: "welcome" };
  }

  return {
    kind: "idle_empty",
    eyebrow: "等待下一步",
    title: "还没有可展示的回复",
    description: "这轮执行尚未沉淀成结果内容，你可以继续补充线索，或直接重新规划任务。",
  };
}

export function collectLiveRunSignals(thread: ThreadSnapshot): LiveRunSignal[] {
  const signals: LiveRunSignal[] = [];
  const activeToolUses = new Map<string, { name: string; detail: string | null }>();

  for (const message of thread.messages) {
    if (message.role === "tool") {
      for (const block of message.blocks) {
        if (block.type === "tool_result") {
          const current = activeToolUses.get(block.tool_use_id);
          const summary = summarizeToolResult({
            tool_use_id: block.tool_use_id,
            tool_name: block.tool_name,
            output: block.output,
            is_error: block.is_error,
          });
          signals.push({
            id: `tool-${block.tool_use_id}`,
            label: summary.title,
            detail: current?.detail ?? summary.detail,
            state: block.is_error ? "error" : "done",
          });
          activeToolUses.delete(block.tool_use_id);
        }
      }
      continue;
    }

    for (const block of message.blocks) {
      if (block.type !== "tool_use" || !isUserVisibleTool(block.name)) {
        continue;
      }

      const summary = summarizeToolUse({
        id: block.id,
        name: block.name,
        input: block.input,
      });
      activeToolUses.set(block.id, {
        name: summary.title,
        detail: summary.detail,
      });
    }
  }

  for (const [toolUseId, signal] of activeToolUses.entries()) {
    signals.push({
      id: `tool-${toolUseId}`,
      label: signal.name,
      detail: signal.detail,
      state: "running",
    });
  }

  if (thread.status === "running" && thread.draft_assistant_text.trim()) {
    signals.push({
      id: "reply-draft",
      label: "正在生成回复",
      detail: truncate(thread.draft_assistant_text.trim(), 120),
      state: "running",
    });
  }

  return signals.slice(-4).reverse();
}

function ThreadViewportStateBlock({
  onSend,
  starterPrompts,
  state,
}: {
  onSend: (content: string) => Promise<void>;
  starterPrompts: string[];
  state: Exclude<ThreadViewportState, { kind: "welcome" }>;
}) {
  const suggestedPrompts =
    state.kind === "failed" || state.kind === "idle_empty" ? starterPrompts.slice(0, 3) : [];

  const suggestedPromptLabel = (index: number): string => {
    switch (index) {
      case 0:
        return "梳理资料范围";
      case 1:
        return "读取关键文件";
      case 2:
        return "列出来源缺口";
      default:
        return "继续分析";
    }
  };

  return (
    <div className="thread-state-shell">
      <div className={`thread-state-block ${state.kind}`}>
        <span className="thread-state-eyebrow">{state.eyebrow}</span>
        <strong className="thread-state-title">{state.title}</strong>
        <p className="thread-state-copy">{state.description}</p>
        {suggestedPrompts.length ? (
          <div className="thread-state-actions">
            {suggestedPrompts.map((prompt) => (
              <button
                className="secondary thread-state-action"
                key={`${state.kind}-${prompt}`}
                onClick={() => void onSend(prompt)}
                type="button"
              >
                {suggestedPromptLabel(suggestedPrompts.indexOf(prompt))}
              </button>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}

function MessageRunSummary({
  operatorMode,
  onOpenEvidence,
  onOpenArtifact,
  onInsertReference,
}: {
  operatorMode: boolean;
  onOpenEvidence?: (evidenceId: string, anchor?: string | null) => void;
  onOpenArtifact?: (artifactId: string, anchor?: string | null) => void;
  onInsertReference?: (text: string) => void;
}) {
  const role = useAuiState((state) => state.message.role);
  const draft = useAuiState((state) => {
    const custom = state.message.metadata?.custom as
      | { draft?: boolean }
      | undefined;
    return custom?.draft ?? false;
  });
  const artifactRefs = useAuiState((state) => {
    const custom = state.message.metadata?.custom as
      | { artifactRefs?: MessageReference[] }
      | undefined;
    return custom?.artifactRefs ?? EMPTY_MESSAGE_REFERENCES;
  });
  const evidenceRefs = useAuiState((state) => {
    const custom = state.message.metadata?.custom as
      | { evidenceRefs?: MessageReference[] }
      | undefined;
    return custom?.evidenceRefs ?? EMPTY_MESSAGE_REFERENCES;
  });
  const steps = useAuiState((state) => {
    const custom = state.message.metadata?.custom as
      | { steps?: ClawdStepData[] }
      | undefined;
    return custom?.steps ?? EMPTY_MESSAGE_STEPS;
  });
  const summary = useMemo(
    () => buildMessageOutcomeSummary({ artifactRefs, evidenceRefs, steps }),
    [artifactRefs, evidenceRefs, steps],
  );
  const [open, setOpen] = useState(false);

  useEffect(() => {
    if (!summary) {
      return;
    }

    if (summary.runningStepCount || summary.failedStepCount) {
      setOpen(true);
    }
  }, [summary]);

  if (role !== "assistant" || draft || !summary) {
    return null;
  }

  const statusLabel = summary.runningStepCount
    ? "仍在继续"
    : summary.failedStepCount
      ? "部分未完成"
      : "本轮沉淀";
  const summaryMetrics = [
    summary.artifactCount ? `${summary.artifactCount} 份结果` : null,
    summary.evidenceCount ? `${summary.evidenceCount} 条来源` : null,
    !summary.artifactCount && !summary.evidenceCount && summary.stepCount
      ? `${summary.stepCount} 个动作`
      : null,
    summary.failedStepCount ? `${summary.failedStepCount} 处未完成` : null,
    summary.runningStepCount ? "继续处理中" : null,
  ].filter((item): item is string => Boolean(item));

  return (
    <details
      className="message-run-summary"
      onToggle={(event) => setOpen((event.currentTarget as HTMLDetailsElement).open)}
      open={open}
    >
      <summary className="message-run-summary-summary">
        <span className="message-run-summary-main">
          <small>{statusLabel}</small>
          <strong>{describeRunSummary(summary)}</strong>
        </span>
        <span className="message-run-summary-metrics" aria-label="运行摘要">
          {summaryMetrics.map((metric) => (
            <span key={metric}>{metric}</span>
          ))}
        </span>
        <span className="message-run-summary-toggle">{open ? "收起记录" : "查看记录"}</span>
      </summary>
      <div className="message-run-summary-body">
        {summary.previewArtifacts.length || summary.previewEvidence.length ? (
          <div className="message-run-summary-section">
            <span className="message-run-summary-label">本轮可继续查看</span>
            <div className="message-outcome-links">
              {summary.previewArtifacts.map((reference) => (
                <span
                  className="message-outcome-link-stack"
                  key={`outcome-artifact-${reference.id}-${reference.anchor ?? "root"}`}
                >
                  <button
                    className="message-outcome-link"
                    onClick={() => onOpenArtifact?.(reference.id, reference.anchor)}
                    type="button"
                  >
                    <small>结果卡</small>
                    <span>{reference.label}</span>
                    {reference.anchor ? <em>{formatReferenceAnchor(reference.anchor)}</em> : null}
                  </button>
                  {onInsertReference ? (
                    <button
                      className="secondary message-outcome-action"
                      onClick={() =>
                        onInsertReference(
                          workbenchReferenceMarkdown({
                            kind: "artifact",
                            id: reference.id,
                            label: reference.label,
                            anchor: reference.anchor,
                          }),
                        )
                      }
                      type="button"
                    >
                      引用
                    </button>
                  ) : null}
                </span>
              ))}
              {summary.previewEvidence.map((reference) => (
                <span
                  className="message-outcome-link-stack"
                  key={`outcome-evidence-${reference.id}-${reference.anchor ?? "root"}`}
                >
                  <button
                    className="message-outcome-link evidence"
                    onClick={() => onOpenEvidence?.(reference.id, reference.anchor)}
                    type="button"
                  >
                    <small>来源</small>
                    <span>{reference.label}</span>
                    {reference.anchor ? <em>{formatReferenceAnchor(reference.anchor)}</em> : null}
                  </button>
                  {onInsertReference ? (
                    <button
                      className="secondary message-outcome-action"
                      onClick={() =>
                        onInsertReference(
                          workbenchReferenceMarkdown({
                            kind: "evidence",
                            id: reference.id,
                            label: reference.label,
                            anchor: reference.anchor,
                          }),
                        )
                      }
                      type="button"
                    >
                      引用
                    </button>
                  ) : null}
                </span>
              ))}
            </div>
          </div>
        ) : null}
        <div className="message-run-summary-section">
          <span className="message-run-summary-label">本轮进展</span>
          <div className="message-step-list">
            {steps.map((step) => (
              <ToolStepRenderer
                data={step}
                key={`${step.toolUseId}-${step.toolName}`}
                onOpenArtifact={onOpenArtifact}
                onOpenEvidence={onOpenEvidence}
                operatorMode={operatorMode}
              />
            ))}
          </div>
        </div>
      </div>
    </details>
  );
}

function ComposerSeedSync({
  seed,
  threadId,
}: {
  seed: AssistantThreadPanelProps["composerSeed"];
  threadId: string;
}) {
  const composer = useComposerRuntime({ optional: true });

  useEffect(() => {
    if (!composer || !seed || seed.threadId !== threadId) {
      return;
    }

    const nextText =
      seed.mode === "append"
        ? appendComposerText(composer.getState().text, seed.text)
        : seed.text;
    composer.setText(nextText);
  }, [composer, seed, threadId]);

  return null;
}

function MarkdownTextPart({
  onOpenEvidence,
  onOpenArtifact,
  onInsertReference,
}: {
  onOpenEvidence?: (evidenceId: string, anchor?: string | null) => void;
  onOpenArtifact?: (artifactId: string, anchor?: string | null) => void;
  onInsertReference?: (text: string) => void;
}) {
  const part = useMessagePartText();
  const normalizedText = part.text.trim();

  if (!normalizedText && part.status.type === "running") {
    return (
      <div className="assistant-thinking-state" aria-live="polite">
        <span className="assistant-thinking-pulse" />
        <div className="assistant-thinking-copy">
          <strong>正在整理回复</strong>
          <span>继续读取资料、核对来源并生成下一段内容</span>
        </div>
      </div>
    );
  }

  return (
    <div className="markdown-body assistant-message-text" data-status={part.status.type}>
      <WorkbenchMarkdown
        onInsertReference={onInsertReference}
        onOpenArtifact={onOpenArtifact}
        onOpenEvidence={onOpenEvidence}
        source={normalizedText}
      />
      {part.status.type === "running" && <span className="stream-cursor">●</span>}
    </div>
  );
}

function parseEsSearchResult(output: string): ParsedEsSearchResult | null {
  try {
    const parsed = JSON.parse(output) as unknown;
    if (!isRecord(parsed)) {
      return null;
    }

    return {
      query: readString(parsed.query),
      index: readString(parsed.index),
      fields: Array.isArray(parsed.fields)
        ? parsed.fields.filter((item): item is string => typeof item === "string")
        : [],
      sourceFields: Array.isArray(parsed.source_fields)
        ? parsed.source_fields.filter((item): item is string => typeof item === "string")
        : [],
      total: readNumber(parsed.total),
      hits: Array.isArray(parsed.hits) ? parsed.hits : [],
      message: readString(parsed.message),
      status: readNumber(parsed.status),
      detail: parsed.detail ?? null,
    };
  } catch {
    return null;
  }
}

function parseWebFetchResult(output: string): ParsedWebFetchResult | null {
  try {
    const parsed = JSON.parse(output) as unknown;
    if (!isRecord(parsed)) {
      return null;
    }
    return {
      url: readString(parsed.url),
      contentType: readString(parsed.content_type),
      text: readString(parsed.text),
      artifactId: readString(parsed.artifact_id),
      artifactTitle: readString(parsed.artifact_title),
    };
  } catch {
    return null;
  }
}

function parseDbQueryResult(output: string): ParsedDbQueryResult | null {
  try {
    const parsed = JSON.parse(output) as unknown;
    if (!isRecord(parsed)) {
      return null;
    }
    return {
      query: readString(parsed.query),
      columns: Array.isArray(parsed.columns)
        ? parsed.columns.filter((item): item is string => typeof item === "string")
        : [],
      rows: Array.isArray(parsed.rows) ? parsed.rows : [],
      rowCount: readNumber(parsed.row_count),
      artifactId: readString(parsed.artifact_id),
      artifactTitle: readString(parsed.artifact_title),
    };
  } catch {
    return null;
  }
}

function summarizeEsHit(hit: unknown, index: number): string {
  if (!isRecord(hit)) {
    return `命中 ${index + 1}`;
  }

  const source = isRecord(hit._source) ? hit._source : null;
  if (source) {
    const label =
      readString(source.title) ??
      readString(source.name) ??
      readString(source.path) ??
      readString(source.file) ??
      readString(source.url);
    if (label) {
      return label;
    }
  }

  return readString(hit._id) ?? `命中 ${index + 1}`;
}

function toolRunningLabel(data: ClawdStepData): string {
  if (data.requestDetail) {
    return data.requestDetail;
  }

  return "步骤执行中…";
}

function toolCompletionLabel(
  data: ClawdStepData,
  parsedSearch: ParsedEsSearchResult | null,
  parsedWeb: ParsedWebFetchResult | null,
  parsedDb: ParsedDbQueryResult | null,
): string {
  if (!data.resultOutput) {
    return toolRunningLabel(data);
  }

  if (data.toolName === "EsSearch" && parsedSearch) {
    if (data.isError) {
      return parsedSearch.message ?? "检索失败";
    }

    if (parsedSearch.total !== null) {
      return `命中 ${parsedSearch.total} 条来源`;
    }

    return parsedSearch.hits.length ? `命中 ${parsedSearch.hits.length} 条来源` : "未命中来源";
  }

  if (data.toolName === "SourceSearch" && parsedSearch) {
    if (data.isError) {
      return parsedSearch.message ?? "文档检索失败";
    }
    if (parsedSearch.total !== null) {
      return `命中 ${parsedSearch.total} 份文档`;
    }
    return parsedSearch.hits.length ? `命中 ${parsedSearch.hits.length} 份文档` : "未命中文档";
  }

  if (data.toolName === "WebFetch" && parsedWeb) {
    return parsedWeb.artifactTitle ?? parsedWeb.url ?? data.resultDetail ?? "网页已读取";
  }

  if (data.toolName === "DbQuery" && parsedDb) {
    if (parsedDb.artifactTitle) {
      return parsedDb.artifactTitle;
    }
    if (parsedDb.rowCount !== null) {
      return `返回 ${parsedDb.rowCount} 行`;
    }
  }

  return data.resultDetail ?? (data.isError ? "步骤执行失败" : "步骤执行完成");
}

function ToolStepRenderer({
  data,
  operatorMode,
  onOpenEvidence,
  onOpenArtifact,
}: {
  data: ClawdStepData;
  operatorMode: boolean;
  onOpenEvidence?: (evidenceId: string, anchor?: string | null) => void;
  onOpenArtifact?: (artifactId: string, anchor?: string | null) => void;
}) {
  const parsedSearch =
    (data.toolName === "EsSearch" || data.toolName === "SourceSearch") && data.resultOutput
      ? parseEsSearchResult(data.resultOutput)
      : null;
  const parsedWeb =
    data.toolName === "WebFetch" && data.resultOutput
      ? parseWebFetchResult(data.resultOutput)
      : null;
  const parsedDb =
    data.toolName === "DbQuery" && data.resultOutput
      ? parseDbQueryResult(data.resultOutput)
      : null;
  const parsedResult = data.resultOutput ? parseInputObject(data.resultOutput) : null;
  const artifactId =
    data.toolName === "ArtifactEmit"
      ? firstNonEmptyString(parsedResult, ["artifact_id"])
      : data.toolName === "WebFetch"
        ? parsedWeb?.artifactId ?? null
        : data.toolName === "DbQuery"
          ? parsedDb?.artifactId ?? null
      : null;
  const headline = data.resultTitle ?? data.title;
  const detail = toolCompletionLabel(data, parsedSearch, parsedWeb, parsedDb);

  return (
    <details className={`message-step ${data.isError ? "error" : ""}`}>
      <summary className="message-step-summary">
        <span className="message-step-heading">
          <strong>{headline}</strong>
          <small>{toolLabel(data.toolName)}</small>
        </span>
        <span className="message-step-copy">{detail}</span>
      </summary>

      <div className="message-step-body">
        {data.requestDetail ? (
          <p className="tool-note">处理对象：{toolRunningLabel(data)}</p>
        ) : null}
        {data.toolName === "EsSearch" || data.toolName === "SourceSearch" ? (
          <div className="tool-inline-actions">
            <button
              className="secondary"
              onClick={() => onOpenEvidence?.(data.toolUseId)}
              type="button"
            >
              打开来源
            </button>
          </div>
        ) : null}
        {artifactId ? (
          <div className="tool-inline-actions">
            <button
              className="secondary"
              onClick={() => onOpenArtifact?.(artifactId)}
              type="button"
            >
              打开结果
            </button>
          </div>
        ) : null}

        {!data.resultOutput ? (
          <p className="tool-note">步骤执行中…</p>
        ) : (data.toolName === "EsSearch" || data.toolName === "SourceSearch") && parsedSearch ? (
          <>
            <div className="tool-meta">
              {parsedSearch.query ? <span>查询 {parsedSearch.query}</span> : null}
              <span>{data.toolName === "SourceSearch" ? "来源 上传文档" : `索引 ${parsedSearch.index ?? "default"}`}</span>
            </div>
            {data.isError ? (
              <>
                <p className="tool-note">
                  {parsedSearch.message ?? "检索失败"}
                  {parsedSearch.status !== null ? ` · status ${parsedSearch.status}` : ""}
                </p>
                {operatorMode && parsedSearch.detail ? (
                  <pre>{stringifyValue(parsedSearch.detail)}</pre>
                ) : null}
              </>
            ) : parsedSearch.hits.length ? (
              <ul className="tool-summary-list">
                {parsedSearch.hits.slice(0, 5).map((hit, index) => (
                  <li key={`hit-${data.toolUseId}-${index}`}>{summarizeEsHit(hit, index)}</li>
                ))}
              </ul>
            ) : (
              <p className="tool-note">没有命中结果</p>
            )}
          </>
        ) : data.toolName === "WebFetch" && parsedWeb ? (
          <>
            <div className="tool-meta">
              {parsedWeb.url ? <span>{parsedWeb.url}</span> : null}
              {parsedWeb.contentType ? <span>{parsedWeb.contentType}</span> : null}
            </div>
            <p className="tool-note">{truncate(parsedWeb.text ?? "未读取到网页正文", 240)}</p>
          </>
        ) : data.toolName === "DbQuery" && parsedDb ? (
          <>
            <div className="tool-meta">
              {parsedDb.query ? <span>{truncate(parsedDb.query, 120)}</span> : null}
              <span>{parsedDb.rowCount ?? parsedDb.rows.length} 行</span>
            </div>
            {parsedDb.columns.length ? (
              <ul className="tool-summary-list">
                <li>列: {parsedDb.columns.join(", ")}</li>
                {parsedDb.rows.slice(0, 2).map((row, index) => (
                  <li key={`db-row-${data.toolUseId}-${index}`}>{truncate(stringifyValue(row), 180)}</li>
                ))}
              </ul>
            ) : (
              <p className="tool-note">查询已完成，但未返回结构化列。</p>
            )}
          </>
        ) : (
          <p className="tool-note">
            {data.resultDetail ?? (data.isError ? "步骤执行失败" : "步骤执行完成")}
          </p>
        )}

        {operatorMode && data.requestInput ? (
          <details className="message-step-raw">
            <summary>原始输入</summary>
            <pre>{data.requestInput}</pre>
          </details>
        ) : null}

        {operatorMode && data.resultOutput ? (
          <details className="message-step-raw">
            <summary>原始输出</summary>
            <pre>{data.resultOutput}</pre>
          </details>
        ) : null}
      </div>
    </details>
  );
}

function DataFallbackRenderer({
  data,
  name,
  operatorMode,
}: DataMessagePartProps<unknown> & { operatorMode: boolean }) {
  return (
    <details className="message-step">
      <summary className="message-step-summary">
        <strong>{name}</strong>
        <span className="message-step-copy">
          {operatorMode ? "展开查看数据" : "已生成结构化结果"}
        </span>
      </summary>
      {operatorMode ? <pre>{JSON.stringify(data, null, 2)}</pre> : null}
    </details>
  );
}

function createMutableThreadMessage(
  id: string,
  role: "system" | "user" | "assistant",
  sourceRole: "system" | "user" | "assistant" | "tool",
  status?: { type: "complete"; reason: "stop" } | { type: "running" },
  draft = false,
): ClawdMutableThreadMessage {
  return {
    id,
    role,
    content: [],
    status,
    metadata: {
      custom: {
        sourceRole,
        draft,
        evidenceRefs: [],
        artifactRefs: [],
        steps: [],
      },
    },
    stepIndexByToolUseId: new Map<string, number>(),
  };
}

function appendBlockToMessage(message: ClawdMutableThreadMessage, block: MessageBlock) {
  if (block.type === "text") {
    message.content.push({ type: "text", text: block.text });
    const extractedRefs = extractWorkbenchReferencesFromMarkdown(block.text);
    for (const reference of extractedRefs) {
      appendReferenceToMessage(message, reference.kind, reference);
    }
    return;
  }

  if (block.type === "tool_use") {
    if (!isUserVisibleTool(block.name)) {
      return;
    }

    const summary = summarizeToolUse({
      id: block.id,
      name: block.name,
      input: block.input,
    });
    if (block.name === "EsSearch" || block.name === "SourceSearch") {
      appendReferenceToMessage(message, "evidence", {
        id: block.id,
        label: summary.detail ?? summary.title,
        anchor: null,
      });
    }

    appendStepToMessage(message, {
      toolUseId: block.id,
      toolName: block.name,
      title: summary.title,
      requestDetail: summary.detail,
      requestInput: block.input,
      resultTitle: null,
      resultDetail: null,
      resultOutput: null,
      isError: false,
    });
    return;
  }

  if (!isUserVisibleTool(block.tool_name)) {
    return;
  }

  const summary = summarizeToolResult({
    tool_use_id: block.tool_use_id,
    tool_name: block.tool_name,
    output: block.output,
    is_error: block.is_error,
  });
  const existingIndex = message.stepIndexByToolUseId.get(block.tool_use_id);
  const existingStep =
    existingIndex === undefined ? null : message.metadata.custom.steps[existingIndex] ?? null;

  if (existingIndex !== undefined && existingStep) {
    updateStepInMessage(message, block.tool_use_id, (step) => ({
      ...step,
      resultTitle: summary.title,
      resultDetail: summary.detail,
      resultOutput: shouldRetainToolResultOutput(block.tool_name) ? block.output : null,
      isError: block.is_error,
    }));
    if (block.tool_name === "EsSearch" || block.tool_name === "SourceSearch") {
      appendReferenceToMessage(message, "evidence", {
        id: block.tool_use_id,
        label:
          existingStep.requestDetail ??
          summary.detail ??
          existingStep.title,
        anchor: null,
      });
    }
    if (block.tool_name === "ArtifactEmit") {
      const artifactId = firstNonEmptyString(parseInputObject(block.output), ["artifact_id"]);
      appendReferenceToMessage(
        message,
        "artifact",
        artifactId
          ? {
              id: artifactId,
              label:
                existingStep.requestDetail ??
                summary.detail ??
                existingStep.title,
              anchor: null,
            }
          : null,
      );
    }
    if (block.tool_name === "WebFetch") {
      const parsedWeb = parseWebFetchResult(block.output);
      appendReferenceToMessage(
        message,
        "artifact",
        parsedWeb?.artifactId
          ? {
              id: parsedWeb.artifactId,
              label:
                parsedWeb.artifactTitle ??
                existingStep.requestDetail ??
                summary.detail ??
                existingStep.title,
              anchor: null,
            }
          : null,
      );
    }
    if (block.tool_name === "DbQuery") {
      const parsedDb = parseDbQueryResult(block.output);
      appendReferenceToMessage(
        message,
        "artifact",
        parsedDb?.artifactId
          ? {
              id: parsedDb.artifactId,
              label:
                parsedDb.artifactTitle ??
                existingStep.requestDetail ??
                summary.detail ??
                existingStep.title,
              anchor: null,
            }
          : null,
      );
    }
    return;
  }

  if (block.tool_name === "EsSearch" || block.tool_name === "SourceSearch") {
    appendReferenceToMessage(message, "evidence", {
      id: block.tool_use_id,
      label: summary.detail ?? toolLabel(block.tool_name),
      anchor: null,
    });
  }
  if (block.tool_name === "ArtifactEmit") {
    const artifactId = firstNonEmptyString(parseInputObject(block.output), ["artifact_id"]);
    appendReferenceToMessage(
      message,
      "artifact",
      artifactId
        ? {
            id: artifactId,
            label: summary.detail ?? toolLabel(block.tool_name),
            anchor: null,
          }
        : null,
    );
  }
  if (block.tool_name === "WebFetch") {
    const parsedWeb = parseWebFetchResult(block.output);
    appendReferenceToMessage(
      message,
      "artifact",
      parsedWeb?.artifactId
        ? {
            id: parsedWeb.artifactId,
            label: parsedWeb.artifactTitle ?? summary.detail ?? toolLabel(block.tool_name),
            anchor: null,
          }
        : null,
    );
  }
  if (block.tool_name === "DbQuery") {
    const parsedDb = parseDbQueryResult(block.output);
    appendReferenceToMessage(
      message,
      "artifact",
      parsedDb?.artifactId
        ? {
            id: parsedDb.artifactId,
            label: parsedDb.artifactTitle ?? summary.detail ?? toolLabel(block.tool_name),
            anchor: null,
          }
        : null,
    );
  }

  appendStepToMessage(message, {
    toolUseId: block.tool_use_id,
    toolName: block.tool_name,
    title: toolLabel(block.tool_name),
    requestDetail: null,
    requestInput: null,
    resultTitle: summary.title,
    resultDetail: summary.detail,
    resultOutput: shouldRetainToolResultOutput(block.tool_name) ? block.output : null,
    isError: block.is_error,
  });
}

function finalizeThreadMessages(messages: ClawdMutableThreadMessage[]): ThreadMessageLike[] {
  return messages.map(({ stepIndexByToolUseId, ...message }) => message satisfies ThreadMessageLike);
}

function roleLabel(role: string): string {
  if (role === "user") {
    return "你";
  }
  if (role === "assistant") {
    return "助手";
  }
  return role;
}

function messageHeaderLabel(options: {
  role: "system" | "user" | "assistant";
  sourceRole: "system" | "user" | "assistant" | "tool";
  draft: boolean;
}): string {
  if (options.draft && options.role === "assistant") {
    return "Agent 正在回复";
  }

  if (options.role === "user") {
    return "你";
  }

  if (options.sourceRole === "tool") {
    return "Agent 进展";
  }

  if (options.sourceRole === "system") {
    return "系统";
  }

  return roleLabel(options.role);
}

function shouldRenderMessageHeader(options: {
  role: "system" | "user" | "assistant";
  sourceRole: "system" | "user" | "assistant" | "tool";
  draft: boolean;
}): boolean {
  if (options.draft) {
    return true;
  }

  return options.sourceRole === "system" || options.sourceRole === "tool";
}

function isInternalSystemMessage(text: string): boolean {
  const normalized = text.trim();
  if (!normalized) {
    return true;
  }

  return (
    normalized.includes("This session is being continued from a previous conversation") ||
    normalized.includes("Continue the conversation from where it left off") ||
    normalized.startsWith("Summary:\nConversation summary:")
  );
}

export function snapshotToThreadMessages(thread: ThreadSnapshot): ThreadMessageLike[] {
  const messages: ClawdMutableThreadMessage[] = [];
  let lastAssistantMessage: ClawdMutableThreadMessage | null = null;

  thread.messages.forEach((message, index) => {
    if (message.role === "system") {
      const textContent = message.blocks
        .filter((block): block is Extract<MessageBlock, { type: "text" }> => block.type === "text")
        .map((block) => block.text)
        .join("\n")
        .trim();
      if (isInternalSystemMessage(textContent)) {
        return;
      }
    }

    if (message.role === "tool") {
      const targetMessage =
        lastAssistantMessage ??
        createMutableThreadMessage(
          `${thread.id}-tool-${index}`,
          "assistant",
          "tool",
          { type: "complete", reason: "stop" },
        );

      for (const block of message.blocks) {
        appendBlockToMessage(targetMessage, block);
      }

      if (!messageHasVisibleContent(targetMessage)) {
        return;
      }

      if (!lastAssistantMessage) {
        messages.push(targetMessage);
        lastAssistantMessage = targetMessage;
      }
      return;
    }

    const nextMessage = createMutableThreadMessage(
      `${thread.id}-message-${index}`,
      message.role,
      message.role,
      message.role === "assistant" ? { type: "complete", reason: "stop" } : undefined,
    );

    for (const block of message.blocks) {
      appendBlockToMessage(nextMessage, block);
    }

    if (!messageHasVisibleContent(nextMessage)) {
      lastAssistantMessage = null;
      return;
    }

    if (message.role === "assistant" && lastAssistantMessage) {
      mergeMessages(lastAssistantMessage, nextMessage);
      return;
    }

    messages.push(nextMessage);
    lastAssistantMessage = message.role === "assistant" ? nextMessage : null;
  });

  if (thread.draft_assistant_text) {
    const draftMessage = createMutableThreadMessage(
      `${thread.id}-draft`,
      "assistant",
      "assistant",
      { type: "running" },
      true,
    );
    draftMessage.content.push({ type: "text", text: thread.draft_assistant_text });
    messages.push(draftMessage);
  }

  return finalizeThreadMessages(messages);
}

function appendMessageToText(message: AppendMessage): string {
  return message.content
    .map((part) => {
      if (part.type === "text") {
        return part.text;
      }
      if (part.type === "data") {
        return JSON.stringify(part.data, null, 2);
      }
      return "";
    })
    .join("\n")
    .trim();
}

function removeReferenceFromComposerText(
  current: string,
  target: {
    kind: "artifact" | "evidence";
    id: string;
    anchor: string | null;
  },
): string {
  let removed = false;
  const next = current.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (match) => {
    if (removed) {
      return match;
    }

    const parsed = extractWorkbenchReferencesFromMarkdown(match)[0];
    if (!parsed) {
      return match;
    }

    if (
      parsed.kind === target.kind &&
      parsed.id === target.id &&
      (parsed.anchor ?? null) === (target.anchor ?? null)
    ) {
      removed = true;
      return "";
    }

    return match;
  });

  return next
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]+\n/g, "\n")
    .trim();
}

function ComposerReferenceTray({
  onOpenArtifact,
  onOpenEvidence,
}: {
  onOpenArtifact?: (artifactId: string, anchor?: string | null) => void;
  onOpenEvidence?: (evidenceId: string, anchor?: string | null) => void;
}) {
  const composer = useComposerRuntime({ optional: true });
  const composerText = useAuiState((state) => state.composer.text);
  const refs = useMemo(() => extractWorkbenchReferencesFromMarkdown(composerText), [composerText]);

  if (!refs.length || !composer) {
    return null;
  }

  return (
    <div className="composer-reference-shell">
      <span className="composer-reference-label">已附上</span>
      <div className="composer-reference-tray">
        {refs.map((reference) => (
          <span
            className={`composer-reference-chip composer-reference-chip-${reference.kind}`}
            key={`${reference.kind}-${reference.id}-${reference.anchor ?? "root"}`}
          >
            <button
              className="composer-reference-open"
              onClick={() => {
                if (reference.kind === "artifact") {
                  onOpenArtifact?.(reference.id, reference.anchor);
                  return;
                }

                onOpenEvidence?.(reference.id, reference.anchor);
              }}
              type="button"
            >
              <small>{reference.kind === "artifact" ? "结果" : "来源"}</small>
              <span>{reference.label}</span>
              {reference.anchor ? <em>{formatReferenceAnchor(reference.anchor)}</em> : null}
            </button>
            <button
              aria-label={`移除${reference.label}`}
              className="composer-reference-dismiss"
              onClick={() =>
                composer.setText(
                  removeReferenceFromComposerText(composer.getState().text, {
                    kind: reference.kind,
                    id: reference.id,
                    anchor: reference.anchor,
                  }),
                )
              }
              type="button"
            >
              ×
            </button>
          </span>
        ))}
      </div>
    </div>
  );
}

type ClawdComposerProps = {
  boundaryControls?: ReactNode;
  canCancel: boolean;
  composerTopSlot?: ReactNode;
  helperLabel?: string | null;
  isRunning: boolean;
  onOpenArtifact?: (artifactId: string, anchor?: string | null) => void;
  onOpenEvidence?: (evidenceId: string, anchor?: string | null) => void;
  sendDisabled: boolean;
  sendLabel: string;
  statusLabel: string;
};

function ClawdComposer({
  boundaryControls,
  canCancel,
  composerTopSlot,
  helperLabel,
  isRunning,
  onOpenArtifact,
  onOpenEvidence,
  sendDisabled,
  sendLabel,
  statusLabel,
}: ClawdComposerProps) {
  const showStatusBar = isRunning || helperLabel;

  return (
    <ComposerPrimitive.Root className="composer">
      <div className="assistant-composer">
        {showStatusBar ? (
          <div className="composer-status-bar">
            <span className={`composer-status-pill ${isRunning ? "running" : "idle"}`}>
              {statusLabel}
            </span>
            {helperLabel ? <span className="composer-helper-label">{helperLabel}</span> : null}
          </div>
        ) : null}
        {boundaryControls ? <div className="composer-inline-tools">{boundaryControls}</div> : null}
        {composerTopSlot ? <div className="composer-top-slot">{composerTopSlot}</div> : null}
        <ComposerReferenceTray
          onOpenArtifact={onOpenArtifact}
          onOpenEvidence={onOpenEvidence}
        />
        <ComposerPrimitive.Input
          className="assistant-composer-input"
          maxRows={8}
          minRows={2}
          placeholder="继续提问，或要求缩小范围、补充引用、输出表格或图表"
        />
        <div className="composer-actions">
          {canCancel ? (
            <ComposerPrimitive.Cancel className="secondary" disabled={!canCancel} type="button">
              停止
            </ComposerPrimitive.Cancel>
          ) : null}
          <ComposerPrimitive.Send disabled={sendDisabled} type="submit">
            {sendLabel}
          </ComposerPrimitive.Send>
        </div>
      </div>
    </ComposerPrimitive.Root>
  );
}

function LiveRunPanel({ signals }: { signals: LiveRunSignal[] }) {
  if (!signals.length) {
    return null;
  }

  return (
    <section className="live-run-panel" aria-live="polite">
      <div className="live-run-panel-header">
        <span className="live-run-panel-label">运行过程</span>
        <span className="live-run-panel-caption">只展示用户可见进展</span>
      </div>
      <div className="live-run-signal-list">
        {signals.map((signal) => (
          <article className={`live-run-signal ${signal.state}`} key={signal.id}>
            <div className="live-run-signal-dot" />
            <div className="live-run-signal-copy">
              <strong>{signal.label}</strong>
              {signal.detail ? <p>{signal.detail}</p> : null}
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}

export function AssistantThreadPanel({
  thread,
  onSend,
  onInterrupt,
  onError,
  contextBadge = null,
  contextHint = null,
  contextAction = null,
  onOpenEvidence,
  onOpenArtifact,
  onInsertReference,
  composerSeed = null,
  composerTopSlot = null,
  starterPrompts = [],
  boundaryControls = null,
  operatorMode = false,
}: AssistantThreadPanelProps) {
  const messages = useMemo(() => snapshotToThreadMessages(thread), [thread]);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const nearBottomRef = useRef(true);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  const TextPart = useMemo(
    () =>
      function MarkdownTextPartRenderer() {
        return (
          <MarkdownTextPart
            onInsertReference={onInsertReference}
            onOpenArtifact={onOpenArtifact}
            onOpenEvidence={onOpenEvidence}
          />
        );
      },
    [onInsertReference, onOpenArtifact, onOpenEvidence],
  );
  const ToolStepPart = useMemo(
    () =>
      function ToolStepPartRenderer({ data }: DataMessagePartProps<ClawdStepData>) {
        return (
          <ToolStepRenderer
            data={data}
            onOpenArtifact={onOpenArtifact}
            onOpenEvidence={onOpenEvidence}
            operatorMode={operatorMode}
          />
        );
      },
    [onOpenArtifact, onOpenEvidence, operatorMode],
  );
  const DataFallbackPart = useMemo(
    () =>
      function DataFallbackPartRenderer(props: DataMessagePartProps<unknown>) {
        return <DataFallbackRenderer {...props} operatorMode={operatorMode} />;
      },
    [operatorMode],
  );
  const MessageBubble = useMemo(
    () =>
      function MessageBubbleRenderer() {
        const role = useAuiState((state) => state.message.role);
        const draft = useAuiState((state) => {
          const custom = state.message.metadata?.custom as
            | { draft?: boolean }
            | undefined;
          return custom?.draft ?? false;
        });
        const sourceRole = useAuiState((state) => {
          const custom = state.message.metadata?.custom as
            | { sourceRole?: "system" | "user" | "assistant" | "tool" }
            | undefined;
          return custom?.sourceRole ?? role;
        });
        const shouldShowHeader = shouldRenderMessageHeader({ draft, role, sourceRole });
        const headerLabel = messageHeaderLabel({ draft, role, sourceRole });

        return (
          <MessagePrimitive.Root className={`message-row role-${role}${draft ? " draft" : ""}`}>
            <div
              className={`message-bubble role-${role} source-${sourceRole}${draft ? " draft" : ""}`}
            >
              {shouldShowHeader ? (
                <header className="message-meta">
                  <span className={`message-role-pill source-${sourceRole}${draft ? " draft" : ""}`}>
                    {headerLabel}
                  </span>
                </header>
              ) : null}
              <div className="message-content">
                <MessagePrimitive.Parts
                  components={{
                    Text: TextPart,
                    data: {
                      by_name: {
                        clawd_step: ToolStepPart,
                      },
                      Fallback: DataFallbackPart,
                    },
                  }}
                />
                <MessageRunSummary
                  operatorMode={operatorMode}
                  onInsertReference={onInsertReference}
                  onOpenArtifact={onOpenArtifact}
                  onOpenEvidence={onOpenEvidence}
                />
              </div>
            </div>
          </MessagePrimitive.Root>
        );
      },
    [DataFallbackPart, TextPart, ToolStepPart, onInsertReference, onOpenArtifact, onOpenEvidence, operatorMode],
  );

  const runtime = useExternalStoreRuntime({
    isRunning: thread.status === "running",
    messages,
    convertMessage: (message) => message,
    onNew: async (message) => {
      const text = appendMessageToText(message);
      if (!text) {
        return;
      }

      try {
        await onSend(text);
      } catch (cause) {
        onError(cause instanceof Error ? cause.message : String(cause));
      }
    },
    onCancel: async () => {
      try {
        await onInterrupt();
      } catch (cause) {
        onError(cause instanceof Error ? cause.message : String(cause));
      }
    },
  });

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }

    const updateScrollState = () => {
      const distanceToBottom =
        viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
      const isNearBottom = distanceToBottom <= 120;
      nearBottomRef.current = isNearBottom;
      setShowJumpToBottom(!isNearBottom);
    };

    updateScrollState();
    viewport.addEventListener("scroll", updateScrollState, { passive: true });
    return () => viewport.removeEventListener("scroll", updateScrollState);
  }, [messages, thread.id]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }

    if (!nearBottomRef.current) {
      setShowJumpToBottom(true);
      return;
    }

    viewport.scrollTo({
      top: viewport.scrollHeight,
      behavior: "smooth",
    });
  }, [messages.length, thread.draft_assistant_text, thread.id]);

  const composerStatusLabel =
    thread.status === "running"
      ? "Agent 运行中"
      : thread.status === "interrupt_requested"
        ? "正在停止"
        : "准备就绪";
  const composerHelperLabel =
    thread.status === "running"
      ? "可以继续补充要求，也可以直接停止本轮"
      : thread.status === "interrupt_requested"
        ? "等待当前任务停止后再继续"
        : null;
  const composerSendLabel =
    thread.status === "running"
      ? "继续追问"
      : thread.status === "interrupt_requested"
        ? "等待停止"
        : "发送";
  const viewportState = buildThreadViewportState(thread, messages.length);
  const showWelcomeState = viewportState?.kind === "welcome";
  const jumpButtonLabel =
    thread.status === "running" || thread.draft_assistant_text
      ? "回到最新内容"
      : "回到底部";
  const liveRunSignals = useMemo(() => collectLiveRunSignals(thread), [thread]);

  return (
    <AssistantRuntimeProvider key={thread.id} runtime={runtime}>
      <ComposerSeedSync seed={composerSeed} threadId={thread.id} />
      <ThreadPrimitive.Root className="assistant-thread">
        <ThreadPrimitive.Viewport
          className="message-list assistant-thread-viewport"
          ref={viewportRef}
        >
          {showWelcomeState ? (
            <div className="thread-welcome-state">
              <div className="thread-welcome-copy">
                <span className="thread-welcome-eyebrow">开始一次新分析</span>
                <strong>先给出目标，剩下的交给 agent 推进</strong>
                <p>
                  直接描述目标即可。agent 会读取资料、检索来源、持续总结，并把表格、
                  图表或关系图沉淀到右侧结果区。
                </p>
              </div>
              {starterPrompts.length ? (
                <div className="thread-welcome-prompts">
                  {starterPrompts.map((prompt) => (
                    <button
                      className="secondary thread-welcome-prompt"
                      key={prompt}
                      onClick={() => void onSend(prompt)}
                      type="button"
                    >
                      {prompt}
                    </button>
                  ))}
                </div>
              ) : null}
            </div>
          ) : viewportState ? (
            <ThreadViewportStateBlock
              onSend={onSend}
              starterPrompts={starterPrompts}
              state={viewportState}
            />
          ) : null}
          <ThreadPrimitive.Messages components={{ Message: MessageBubble }} />
        </ThreadPrimitive.Viewport>
        <div className="assistant-thread-footer">
          <LiveRunPanel signals={liveRunSignals} />
          {showJumpToBottom ? (
            <div className="thread-jump-row">
              <button
                className="secondary thread-jump-button"
                onClick={() => {
                  nearBottomRef.current = true;
                  viewportRef.current?.scrollTo({
                    top: viewportRef.current.scrollHeight,
                    behavior: "smooth",
                  });
                }}
                type="button"
              >
                {jumpButtonLabel}
              </button>
            </div>
          ) : null}
          {contextBadge || contextHint || contextAction ? (
            <div className="thread-context-strip">
              <div className="thread-context-copy">
                {contextBadge ? <span className="thread-context-badge">{contextBadge}</span> : null}
                {contextHint ? <span className="thread-context-hint">{contextHint}</span> : null}
              </div>
              {contextAction ? <div className="thread-context-action">{contextAction}</div> : null}
            </div>
          ) : null}
          <ClawdComposer
            boundaryControls={boundaryControls}
            canCancel={thread.status === "running" || thread.status === "interrupt_requested"}
            composerTopSlot={composerTopSlot}
            helperLabel={composerHelperLabel}
            isRunning={thread.status === "running" || thread.status === "interrupt_requested"}
            onOpenArtifact={onOpenArtifact}
            onOpenEvidence={onOpenEvidence}
            sendDisabled={thread.status === "interrupt_requested"}
            sendLabel={composerSendLabel}
            statusLabel={composerStatusLabel}
          />
        </div>
      </ThreadPrimitive.Root>
    </AssistantRuntimeProvider>
  );
}
