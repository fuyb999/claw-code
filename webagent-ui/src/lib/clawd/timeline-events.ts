import {
  firstNonEmptyString,
  parseExpertHeading,
  parseInputObject,
} from "./chat-adapter";
import { presentArtifactKind } from "./presentation";
import type {
  ArtifactRecord,
  AuditRecord,
  MessageBlock,
  ThreadSnapshot,
} from "./types";

export type TimelineEventKind =
  | "user_question"
  | "retrieval"
  | "execution_scope"
  | "retrieval_policy"
  | "expert_message"
  | "expert_failed"
  | "synthesis"
  | "artifact";

export interface TimelineEventReference {
  kind: "artifact" | "evidence";
  id: string;
  anchor: string | null;
}

export interface TimelineEvent {
  id: string;
  kind: TimelineEventKind;
  title: string;
  subtitle: string;
  atMs: number;
  reference: TimelineEventReference | null;
}

type ExecutionContext = {
  knowledgeBaseName: string | null;
  autoRetrieval: boolean | null;
};

function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function booleanValue(record: Record<string, unknown> | null, keys: readonly string[]): boolean | null {
  if (!record) {
    return null;
  }

  for (const key of keys) {
    const value = record[key];
    if (typeof value === "boolean") {
      return value;
    }
  }

  return null;
}

function executionContextFromValue(value: unknown): ExecutionContext | null {
  const record = asRecord(value);
  if (!record) {
    return null;
  }

  const knowledgeBaseName = firstNonEmptyString(record, [
    "knowledge_base_name",
    "knowledgeBaseName",
  ]);
  const autoRetrieval = booleanValue(record, [
    "auto_retrieval",
    "autoRetrieval",
  ]);

  if (!knowledgeBaseName && autoRetrieval === null) {
    return null;
  }

  return {
    knowledgeBaseName,
    autoRetrieval,
  };
}

function executionContextFromMessage(message: ThreadSnapshot["messages"][number]): ExecutionContext | null {
  const metadata = asRecord((message as { metadata?: unknown }).metadata);
  if (!metadata) {
    return null;
  }

  return (
    executionContextFromValue(metadata.effective_execution_context) ??
    executionContextFromValue(metadata.execution_context) ??
    executionContextFromValue(metadata)
  );
}

function executionContextFromAudit(audit: AuditRecord): ExecutionContext | null {
  const payload = asRecord(audit.payload);
  if (!payload) {
    return null;
  }

  return (
    executionContextFromValue(payload.effective_execution_context) ??
    executionContextFromValue(payload.execution_context) ??
    executionContextFromValue(payload.context) ??
    executionContextFromValue(payload)
  );
}

function timelineEventsFromExecutionContext(
  idPrefix: string,
  atMs: number,
  context: ExecutionContext | null,
): TimelineEvent[] {
  if (!context) {
    return [];
  }

  const events: TimelineEvent[] = [];

  if (context.knowledgeBaseName) {
    events.push({
      id: `${idPrefix}:execution_scope`,
      kind: "execution_scope",
      title: "本次使用资料范围",
      subtitle: context.knowledgeBaseName,
      atMs,
      reference: null,
    });
  }

  if (context.autoRetrieval !== null) {
    events.push({
      id: `${idPrefix}:retrieval_policy`,
      kind: "retrieval_policy",
      title: context.autoRetrieval ? "自动检索已开启" : "自动检索已关闭",
      subtitle: context.autoRetrieval ? "回答前可默认检索资料" : "不做默认前置检索",
      atMs,
      reference: null,
    });
  }

  return events;
}

function textFromBlocks(blocks: MessageBlock[]): string {
  return blocks
    .filter((block): block is Extract<MessageBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text)
    .join("\n\n")
    .trim();
}

function retrievalEventsFromBlocks(
  messageId: string,
  atMs: number,
  blocks: MessageBlock[],
): TimelineEvent[] {
  return blocks.flatMap((block) => {
    if (block.type !== "tool_use" || (block.name !== "EsSearch" && block.name !== "SourceSearch")) {
      return [];
    }

    const input = parseInputObject(block.input);
    const query = firstNonEmptyString(input, ["query"]) ?? "当前资料范围";

    return [
      {
        id: `${messageId}:${block.id}`,
        kind: "retrieval" as const,
        title: "检索资料",
        subtitle: query,
        atMs,
        reference: {
          kind: "evidence" as const,
          id: block.id,
          anchor: null,
        },
      },
    ];
  });
}

function eventFromArtifact(artifact: ArtifactRecord): TimelineEvent {
  return {
    id: artifact.id,
    kind: "artifact",
    title: artifact.title?.trim() || presentArtifactKind(artifact.kind),
    subtitle: presentArtifactKind(artifact.kind),
    atMs: artifact.created_at_ms,
    reference: {
      kind: "artifact",
      id: artifact.id,
      anchor: null,
    },
  };
}

function expertFailureFromAudit(audit: AuditRecord): TimelineEvent | null {
  if (audit.kind !== "expert_run_event") {
    return null;
  }
  const payload = audit.payload && typeof audit.payload === "object" && !Array.isArray(audit.payload)
    ? (audit.payload as Record<string, unknown>)
    : null;
  if (payload?.event !== "expert_failed") {
    return null;
  }

  const expert = typeof payload.expert === "string" && payload.expert.trim()
    ? payload.expert.trim()
    : "专家";

  return {
    id: audit.id,
    kind: "expert_failed",
    title: `${expert}失败`,
    subtitle: "已记录失败，其他专家继续执行",
    atMs: audit.created_at_ms,
    reference: null,
  };
}

export function buildTimelineEvents(thread: ThreadSnapshot | null): TimelineEvent[] {
  if (!thread) {
    return [];
  }

  const messageEvents = thread.messages.flatMap((message) => {
    const atMs = thread.updated_at_ms;
    const text = textFromBlocks(message.blocks);
    const retrievalEvents = retrievalEventsFromBlocks(message.id, atMs, message.blocks);
    const contextEvents = timelineEventsFromExecutionContext(
      message.id,
      atMs,
      executionContextFromMessage(message),
    );

    if (message.role === "user" && text) {
      return [
        {
          id: message.id,
          kind: "user_question" as const,
          title: "用户问题",
          subtitle: text,
          atMs,
          reference: null,
        },
        ...contextEvents,
        ...retrievalEvents,
      ];
    }

    if (text.includes("### Final synthesis")) {
      return [
        {
          id: message.id,
          kind: "synthesis" as const,
          title: "综合结论",
          subtitle: "已汇总专家观点与资料证据",
          atMs,
          reference: null,
        },
        ...contextEvents,
        ...retrievalEvents,
      ];
    }

    const expertName = parseExpertHeading(text);
    if (expertName) {
      return [
        {
          id: message.id,
          kind: "expert_message" as const,
          title: expertName,
          subtitle: "专家观点已进入时间线",
          atMs,
          reference: null,
        },
        ...contextEvents,
        ...retrievalEvents,
      ];
    }

    return [...contextEvents, ...retrievalEvents];
  });

  const artifactEvents = thread.artifacts.map(eventFromArtifact);
  const failedExpertEvents = thread.audit_records
    .map(expertFailureFromAudit)
    .filter((event): event is TimelineEvent => event !== null);
  const auditContextEvents = thread.audit_records.flatMap((audit) =>
    timelineEventsFromExecutionContext(audit.id, audit.created_at_ms, executionContextFromAudit(audit))
  );

  return [...messageEvents, ...auditContextEvents, ...failedExpertEvents, ...artifactEvents].sort(
    (left, right) => left.atMs - right.atMs,
  );
}
