import {
  appendMessageReference,
  extractWorkbenchReferencesFromMarkdown,
  type MessageReference,
} from "./message-links";
import type { MessageBlock, ThreadSnapshot } from "./types";

export type ThreadOutcomeStep = {
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

export type OutcomeMessageStatus =
  | { type: "complete"; reason: "stop" }
  | { type: "running" };

export type ThreadOutcomeMessage = {
  id: string;
  role: "system" | "user" | "assistant";
  sourceRole: "system" | "user" | "assistant" | "tool";
  draft: boolean;
  status?: OutcomeMessageStatus;
  textParts: string[];
  artifactRefs: MessageReference[];
  evidenceRefs: MessageReference[];
  steps: ThreadOutcomeStep[];
};

export type MessageOutcomeSummary = {
  artifactCount: number;
  evidenceCount: number;
  stepCount: number;
  failedStepCount: number;
  runningStepCount: number;
  previewArtifacts: MessageReference[];
  previewEvidence: MessageReference[];
};

export type LatestThreadOutcomeSummary = {
  message: ThreadOutcomeMessage;
  summary: MessageOutcomeSummary;
};

type MutableOutcomeMessage = ThreadOutcomeMessage & {
  stepIndexByToolUseId: Map<string, number>;
};

const INTERNAL_TOOL_NAMES = new Set(["MemoryWrite", "MemorySearch", "TopicDriftCheck"]);

function isUserVisibleTool(name: string): boolean {
  return !INTERNAL_TOOL_NAMES.has(name);
}

function parseInputObject(input: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(input) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
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
    const value = record[key];
    if (typeof value === "string" && value.trim()) {
      return value.trim();
    }
  }

  return null;
}

function truncate(value: string, maxLength = 180): string {
  return value.length > maxLength ? `${value.slice(0, maxLength)}...` : value;
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
      return "检索证据";
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

function summarizeToolUse(block: Extract<MessageBlock, { type: "tool_use" }>): {
  title: string;
  detail: string | null;
} {
  const input = parseInputObject(block.input);

  switch (block.name) {
    case "EsSearch":
      return {
        title: toolLabel(block.name),
        detail: firstNonEmptyString(input, ["query"]),
      };
    case "read_file":
      return {
        title: toolLabel(block.name),
        detail: presentResourceHint(firstNonEmptyString(input, ["path"])),
      };
    case "glob_search":
      return {
        title: toolLabel(block.name),
        detail:
          firstNonEmptyString(input, ["pattern"]) ??
          presentResourceHint(firstNonEmptyString(input, ["path"])),
      };
    case "grep_search":
      return {
        title: toolLabel(block.name),
        detail:
          firstNonEmptyString(input, ["query", "pattern"]) ??
          presentResourceHint(firstNonEmptyString(input, ["path"])),
      };
    case "ArtifactEmit":
      return {
        title: toolLabel(block.name),
        detail: firstNonEmptyString(input, ["title", "kind"]),
      };
    default:
      return {
        title: toolLabel(block.name),
        detail:
          firstNonEmptyString(input, ["title", "query", "pattern"]) ??
          presentResourceHint(firstNonEmptyString(input, ["path"])),
      };
  }
}

function summarizeToolResult(block: Extract<MessageBlock, { type: "tool_result" }>): {
  title: string;
  detail: string | null;
} {
  if (block.tool_name === "ArtifactEmit") {
    const parsed = parseInputObject(block.output);
    return {
      title: block.is_error ? "结果整理失败" : "已生成结构化结果",
      detail: firstNonEmptyString(parsed, ["kind", "artifact_id"]),
    };
  }

  if (block.tool_name === "WebFetch" || block.tool_name === "DbQuery") {
    const parsed = parseInputObject(block.output);
    return {
      title:
        block.tool_name === "WebFetch"
          ? block.is_error
            ? "网页读取失败"
            : "已生成网页摘录"
          : block.is_error
            ? "数据库查询失败"
            : "已生成结果表格",
      detail:
        firstNonEmptyString(parsed, ["artifact_title", "url", "query", "artifact_id"]) ??
        (block.is_error ? truncate(block.output) : null),
    };
  }

  return {
    title: block.is_error ? `${toolLabel(block.tool_name)}失败` : `${toolLabel(block.tool_name)}完成`,
    detail: block.is_error ? truncate(block.output) : null,
  };
}

function createOutcomeMessage(
  id: string,
  role: "system" | "user" | "assistant",
  sourceRole: "system" | "user" | "assistant" | "tool",
  status?: OutcomeMessageStatus,
  draft = false,
): MutableOutcomeMessage {
  return {
    id,
    role,
    sourceRole,
    draft,
    status,
    textParts: [],
    artifactRefs: [],
    evidenceRefs: [],
    steps: [],
    stepIndexByToolUseId: new Map<string, number>(),
  };
}

function appendReference(
  message: MutableOutcomeMessage,
  kind: "artifact" | "evidence",
  reference: MessageReference | null | undefined,
) {
  if (kind === "artifact") {
    message.artifactRefs = appendMessageReference(message.artifactRefs, reference);
    return;
  }

  message.evidenceRefs = appendMessageReference(message.evidenceRefs, reference);
}

function appendStep(message: MutableOutcomeMessage, step: ThreadOutcomeStep) {
  const nextIndex = message.steps.length;
  message.steps.push(step);
  message.stepIndexByToolUseId.set(step.toolUseId, nextIndex);
}

function mergeOutcomeMessages(target: MutableOutcomeMessage, source: MutableOutcomeMessage) {
  target.textParts.push(...source.textParts);

  for (const reference of source.artifactRefs) {
    appendReference(target, "artifact", reference);
  }

  for (const reference of source.evidenceRefs) {
    appendReference(target, "evidence", reference);
  }

  for (const step of source.steps) {
    appendStep(target, step);
  }
}

function applyBlock(message: MutableOutcomeMessage, block: MessageBlock) {
  if (block.type === "text") {
    message.textParts.push(block.text);
    for (const reference of extractWorkbenchReferencesFromMarkdown(block.text)) {
      appendReference(message, reference.kind, reference);
    }
    return;
  }

  if (block.type === "tool_use") {
    if (!isUserVisibleTool(block.name)) {
      return;
    }

    const summary = summarizeToolUse(block);
    if (block.name === "EsSearch" || block.name === "SourceSearch") {
      appendReference(message, "evidence", {
        id: block.id,
        label: summary.detail ?? summary.title,
        anchor: null,
      });
    }

    appendStep(message, {
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

  const summary = summarizeToolResult(block);
  const stepIndex = message.stepIndexByToolUseId.get(block.tool_use_id);
  const existingStep = stepIndex === undefined ? null : message.steps[stepIndex] ?? null;

  if (existingStep) {
    message.steps[stepIndex!] = {
      ...existingStep,
      resultTitle: summary.title,
      resultDetail: summary.detail,
      resultOutput: block.output,
      isError: block.is_error,
    };

    if (block.tool_name === "EsSearch" || block.tool_name === "SourceSearch") {
      appendReference(message, "evidence", {
        id: block.tool_use_id,
        label: existingStep.requestDetail ?? summary.detail ?? existingStep.title,
        anchor: null,
      });
    }
    if (
      block.tool_name === "ArtifactEmit"
      || block.tool_name === "WebFetch"
      || block.tool_name === "DbQuery"
    ) {
      const artifactId = firstNonEmptyString(parseInputObject(block.output), ["artifact_id"]);
      appendReference(
        message,
        "artifact",
        artifactId
          ? {
            id: artifactId,
            label:
              firstNonEmptyString(parseInputObject(block.output), ["artifact_title"])
              ?? existingStep.requestDetail
              ?? summary.detail
              ?? existingStep.title,
            anchor: null,
          }
          : null,
      );
    }
    return;
  }

  if (block.tool_name === "EsSearch" || block.tool_name === "SourceSearch") {
    appendReference(message, "evidence", {
      id: block.tool_use_id,
      label: summary.detail ?? toolLabel(block.tool_name),
      anchor: null,
    });
  }
  if (
    block.tool_name === "ArtifactEmit"
    || block.tool_name === "WebFetch"
    || block.tool_name === "DbQuery"
  ) {
    const parsed = parseInputObject(block.output);
    const artifactId = firstNonEmptyString(parsed, ["artifact_id"]);
    appendReference(
      message,
      "artifact",
      artifactId
        ? {
          id: artifactId,
          label:
            firstNonEmptyString(parsed, ["artifact_title"])
            ?? summary.detail
            ?? toolLabel(block.tool_name),
          anchor: null,
        }
        : null,
    );
  }

  appendStep(message, {
    toolUseId: block.tool_use_id,
    toolName: block.tool_name,
    title: toolLabel(block.tool_name),
    requestDetail: null,
    requestInput: null,
    resultTitle: summary.title,
    resultDetail: summary.detail,
    resultOutput: block.output,
    isError: block.is_error,
  });
}

function hasVisibleContent(message: MutableOutcomeMessage): boolean {
  return message.textParts.length > 0 || message.steps.length > 0;
}

export function buildThreadOutcomeMessages(thread: ThreadSnapshot): ThreadOutcomeMessage[] {
  const messages: MutableOutcomeMessage[] = [];
  let lastAssistantMessage: MutableOutcomeMessage | null = null;

  thread.messages.forEach((message, index) => {
    if (message.role === "tool") {
      const targetMessage =
        lastAssistantMessage ??
        createOutcomeMessage(
          `${thread.id}-tool-${index}`,
          "assistant",
          "tool",
          { type: "complete", reason: "stop" },
        );

      for (const block of message.blocks) {
        applyBlock(targetMessage, block);
      }

      if (!hasVisibleContent(targetMessage)) {
        return;
      }

      if (!lastAssistantMessage) {
        messages.push(targetMessage);
        lastAssistantMessage = targetMessage;
      }
      return;
    }

    const nextMessage = createOutcomeMessage(
      `${thread.id}-message-${index}`,
      message.role,
      message.role,
      message.role === "assistant" ? { type: "complete", reason: "stop" } : undefined,
    );

    for (const block of message.blocks) {
      applyBlock(nextMessage, block);
    }

    if (!hasVisibleContent(nextMessage)) {
      lastAssistantMessage = null;
      return;
    }

    if (message.role === "assistant" && lastAssistantMessage) {
      mergeOutcomeMessages(lastAssistantMessage, nextMessage);
      return;
    }

    messages.push(nextMessage);
    lastAssistantMessage = message.role === "assistant" ? nextMessage : null;
  });

  if (thread.draft_assistant_text) {
    const draftMessage = createOutcomeMessage(
      `${thread.id}-draft`,
      "assistant",
      "assistant",
      { type: "running" },
      true,
    );
    draftMessage.textParts.push(thread.draft_assistant_text);
    messages.push(draftMessage);
  }

  return messages.map(({ stepIndexByToolUseId: _stepIndexByToolUseId, ...message }) => message);
}

export function buildMessageOutcomeSummary(options: {
  artifactRefs: MessageReference[];
  evidenceRefs: MessageReference[];
  steps: ThreadOutcomeStep[];
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

export function latestAssistantOutcomeSummary(
  thread: ThreadSnapshot | null,
): LatestThreadOutcomeSummary | null {
  if (!thread) {
    return null;
  }

  const messages = buildThreadOutcomeMessages(thread);
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message || message.role !== "assistant") {
      continue;
    }
    const summary = buildMessageOutcomeSummary({
      artifactRefs: message.artifactRefs,
      evidenceRefs: message.evidenceRefs,
      steps: message.steps,
    });
    if (summary) {
      return { message, summary };
    }
  }

  return null;
}
