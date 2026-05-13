import {
  collectEvidenceEntries,
  summarizeEvidenceHit,
} from "./evidence";
import { parseWorkbenchLink, type MessageReference } from "./message-links";
import { presentArtifactKind } from "./presentation";
import type {
  ArtifactRecord,
  MessageBlock,
  ThreadSnapshot,
} from "./types";

export type AiAnalystStage =
  | "ideation"
  | "retrieval"
  | "writing"
  | "synthesis";

export type TimelineReferenceTarget = {
  kind: "artifact" | "evidence";
  id: string;
  anchor: string | null;
};

export type TimelineReferenceDetail = {
  kind: "artifact" | "evidence";
  id: string;
  title: string;
  metaLabel: string | null;
  body: string;
  artifact?: {
    id: string;
    kind: ArtifactRecord["kind"];
    title: string | null;
    payload: unknown;
  };
  evidence?: {
    query: string;
    index: string;
    hit: {
      label: string;
      location: string | null;
      preview: string;
    } | null;
  };
};

export type InspirationTimelineMessage = {
  id: string;
  role: "user" | "assistant" | "expert";
  content: string;
  expertName?: string;
  timestamp: Date;
  artifactRefs: MessageReference[];
  evidenceRefs: MessageReference[];
  aiAnalystStage: AiAnalystStage | null;
};

export function parseExpertHeading(text: string): string | null {
  const match = /^###\s+([^\n]+)$/m.exec(text);
  const heading = match?.[1]?.trim();
  if (!heading || /^final synthesis$/i.test(heading)) {
    return null;
  }
  return heading;
}

export function parseInputObject(input: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(input) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : null;
  } catch {
    return null;
  }
}

export function firstNonEmptyString(
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

function normalizeExpertContent(text: string): string {
  return text.replace(/^###\s+[^\n]+\n+/m, "").trim();
}

function inferStage(
  artifactRefs: MessageReference[],
  evidenceRefs: MessageReference[],
  text: string,
): AiAnalystStage | null {
  if (text.includes("### Final synthesis")) {
    return "synthesis";
  }
  if (parseExpertHeading(text)) {
    return "ideation";
  }
  if (evidenceRefs.length > 0) {
    return "retrieval";
  }
  if (artifactRefs.length > 0) {
    return "writing";
  }
  return null;
}

function stringifyArtifactPayload(artifact: ArtifactRecord): string {
  if (typeof artifact.payload === "string") {
    return artifact.payload;
  }

  try {
    return JSON.stringify(artifact.payload, null, 2);
  } catch {
    return "unserializable payload";
  }
}

function appendReference(
  refs: MessageReference[],
  next: MessageReference | null,
): MessageReference[] {
  if (!next?.id.trim()) {
    return refs;
  }
  const duplicate = refs.some(
    (item) => item.id === next.id && (item.anchor ?? null) === (next.anchor ?? null),
  );
  if (duplicate) {
    return refs;
  }
  return [...refs, next];
}

function applyToolBlock(
  message: InspirationTimelineMessage,
  block: MessageBlock,
): InspirationTimelineMessage {
  if (block.type === "tool_use") {
    if (block.name === "EsSearch" || block.name === "SourceSearch") {
      const input = parseInputObject(block.input);
      return {
        ...message,
        evidenceRefs: appendReference(message.evidenceRefs, {
          id: block.id,
          label:
            firstNonEmptyString(input, ["query"]) ??
            firstNonEmptyString(input, ["path"]) ??
            block.name,
          anchor: null,
        }),
      };
    }

    return message;
  }

  if (block.type !== "tool_result") {
    return message;
  }

  const parsed = parseInputObject(block.output);
  if (block.tool_name === "EsSearch" || block.tool_name === "SourceSearch") {
    return {
      ...message,
      evidenceRefs: appendReference(message.evidenceRefs, {
        id: block.tool_use_id,
        label:
          firstNonEmptyString(parsed, ["query", "artifact_title"]) ??
          block.tool_name,
        anchor: null,
      }),
    };
  }

  if (
    block.tool_name === "ArtifactEmit" ||
    block.tool_name === "WebFetch" ||
    block.tool_name === "SourceWebFetch" ||
    block.tool_name === "DbQuery"
  ) {
    const artifactId = firstNonEmptyString(parsed, ["artifact_id"]);
    if (!artifactId) {
      return message;
    }
    return {
      ...message,
      artifactRefs: appendReference(message.artifactRefs, {
        id: artifactId,
        label:
          firstNonEmptyString(parsed, ["artifact_title"]) ??
          firstNonEmptyString(parsed, ["kind"]) ??
          artifactId,
        anchor: null,
      }),
    };
  }

  return message;
}

function parseMarkdownReferences(text: string): Pick<
  InspirationTimelineMessage,
  "artifactRefs" | "evidenceRefs"
> {
  const artifactRefs: MessageReference[] = [];
  const evidenceRefs: MessageReference[] = [];
  const linkPattern = /\[([^\]]+)\]\(([^)\s]+)\)/g;

  for (const match of text.matchAll(linkPattern)) {
    const label = match[1]?.trim() || "";
    const target = parseWorkbenchLink(match[2]?.trim());
    if (!target) {
      continue;
    }
    const reference = {
      id: target.id,
      label: label || target.id,
      anchor: target.anchor,
    };
    if (target.kind === "artifact") {
      artifactRefs.push(reference);
    } else {
      evidenceRefs.push(reference);
    }
  }

  return { artifactRefs, evidenceRefs };
}

function createMessageFromSnapshot(
  thread: ThreadSnapshot,
  source: ThreadSnapshot["messages"][number],
): InspirationTimelineMessage | null {
  const textParts = source.blocks
    .filter((block): block is Extract<MessageBlock, { type: "text" }> => block.type === "text")
    .map((block) => block.text);
  const text = textParts.join("\n\n").trim();
  const refs = text ? parseMarkdownReferences(text) : { artifactRefs: [], evidenceRefs: [] };
  const expertName = source.role === "assistant" ? parseExpertHeading(text) : null;
  const normalizedContent = expertName ? normalizeExpertContent(text) : text;
  const role =
    source.role === "user" ? "user" : expertName ? "expert" : "assistant";
  const message: InspirationTimelineMessage = {
    id: source.id,
    role,
    content: normalizedContent || "处理中...",
    expertName: expertName ?? undefined,
    timestamp: new Date(thread.updated_at_ms),
    artifactRefs: refs.artifactRefs,
    evidenceRefs: refs.evidenceRefs,
    aiAnalystStage: inferStage(refs.artifactRefs, refs.evidenceRefs, text),
  };

  for (const block of source.blocks) {
    if (block.type !== "text") {
      Object.assign(message, applyToolBlock(message, block));
    }
  }

  if (!normalizedContent && !message.artifactRefs.length && !message.evidenceRefs.length) {
    return null;
  }

  return {
    ...message,
    aiAnalystStage: inferStage(message.artifactRefs, message.evidenceRefs, text),
  };
}

export function mapThreadToChatMessages(
  thread: ThreadSnapshot | null,
): InspirationTimelineMessage[] {
  if (!thread) {
    return [
      {
        id: "welcome",
        role: "assistant",
        content: "当前还没有对话。直接发送问题即可自动创建新线程。",
        timestamp: new Date(),
        artifactRefs: [],
        evidenceRefs: [],
        aiAnalystStage: null,
      },
    ];
  }

  const messages: InspirationTimelineMessage[] = [];
  let lastAssistantIndex = -1;

  for (const source of thread.messages) {
    if (source.role === "tool") {
      if (lastAssistantIndex < 0) {
        continue;
      }
      let target = messages[lastAssistantIndex];
      if (!target) {
        continue;
      }
      for (const block of source.blocks) {
        target = applyToolBlock(target, block);
      }
      target = {
        ...target,
        aiAnalystStage: inferStage(target.artifactRefs, target.evidenceRefs, target.content),
      };
      messages[lastAssistantIndex] = target;
      continue;
    }

    const nextMessage = createMessageFromSnapshot(thread, source);
    if (!nextMessage) {
      lastAssistantIndex = -1;
      continue;
    }

    messages.push(nextMessage);
    lastAssistantIndex = nextMessage.role === "user" ? -1 : messages.length - 1;
  }

  return messages.length
    ? messages
    : [
        {
          id: "welcome",
          role: "assistant",
          content: "当前还没有对话。直接发送问题即可自动创建新线程。",
          timestamp: new Date(),
          artifactRefs: [],
          evidenceRefs: [],
          aiAnalystStage: null,
        },
      ];
}

function evidenceAnchorMeta(anchor: string | null): string | null {
  if (!anchor) {
    return null;
  }
  const match = /^hit-(\d+)$/i.exec(anchor);
  if (!match) {
    return anchor;
  }
  return `命中 ${match[1]}`;
}

export function buildTimelineReferenceDetail(
  thread: ThreadSnapshot | null,
  target: TimelineReferenceTarget | null,
): TimelineReferenceDetail | null {
  if (!thread || !target) {
    return null;
  }

  if (target.kind === "artifact") {
    const artifact = thread.artifacts.find((item) => item.id === target.id);
    if (!artifact) {
      return null;
    }
    return {
      kind: "artifact",
      id: artifact.id,
      title: artifact.title ?? "未命名结果",
      metaLabel: presentArtifactKind(artifact.kind),
      body: stringifyArtifactPayload(artifact),
      artifact: {
        id: artifact.id,
        kind: artifact.kind,
        title: artifact.title,
        payload: artifact.payload,
      },
    };
  }

  const entry = collectEvidenceEntries(thread).find((item) => item.id === target.id);
  if (!entry) {
    return null;
  }

  const hitIndex = target.anchor
    ? Math.max(0, Number.parseInt(target.anchor.replace(/^hit-/i, ""), 10) - 1)
    : null;
  const selectedHit =
    hitIndex !== null && Number.isFinite(hitIndex)
      ? entry.hits[hitIndex] ?? null
      : entry.hits[0] ?? null;
  const summary = selectedHit ? summarizeEvidenceHit(selectedHit, hitIndex ?? 0) : null;
  const bodyParts = [
    summary?.label ? `标题：${summary.label}` : null,
    summary?.location ? `位置：${summary.location}` : null,
    summary?.preview ? `摘要：${summary.preview}` : null,
  ].filter((item): item is string => Boolean(item));

  return {
    kind: "evidence",
    id: entry.id,
    title: entry.query,
    metaLabel: `索引 ${entry.index}${target.anchor ? ` · ${evidenceAnchorMeta(target.anchor)}` : ""}`,
    body: bodyParts.join("\n\n") || entry.rawOutput,
    evidence: {
      query: entry.query,
      index: entry.index,
      hit: summary
        ? {
            label: summary.label,
            location: summary.location,
            preview: summary.preview,
          }
        : null,
    },
  };
}

export function resolveTimelineReferenceTarget(
  href?: string | null,
): TimelineReferenceTarget | null {
  const parsed = parseWorkbenchLink(href);
  if (!parsed) {
    return null;
  }
  return parsed;
}
