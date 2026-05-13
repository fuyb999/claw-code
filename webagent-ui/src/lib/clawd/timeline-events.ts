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
        ...retrievalEvents,
      ];
    }

    return retrievalEvents;
  });

  const artifactEvents = thread.artifacts.map(eventFromArtifact);
  const failedExpertEvents = thread.audit_records
    .map(expertFailureFromAudit)
    .filter((event): event is TimelineEvent => event !== null);

  return [...messageEvents, ...failedExpertEvents, ...artifactEvents].sort(
    (left, right) => left.atMs - right.atMs,
  );
}
