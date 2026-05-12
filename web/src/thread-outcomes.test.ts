import { describe, expect, it } from "vitest";

import { latestAssistantOutcomeSummary } from "./thread-outcomes";
import type { ThreadSnapshot } from "./types";

function thread(overrides: Partial<ThreadSnapshot> = {}): ThreadSnapshot {
  return {
    id: "thread-1",
    workspace_root: "/tmp/project",
    session_path: "/tmp/project/.session.jsonl",
    project_id: "project-1",
    project_name: "Research Desk",
    knowledge_base_id: null,
    knowledge_base_name: null,
    model: "claude-sonnet-4-6",
    permission_mode: "read-only",
    topic: "分析仓库结构",
    status: "idle",
    last_error: null,
    draft_assistant_text: "",
    created_at_ms: 1,
    updated_at_ms: 2,
    messages: [],
    memory_notes: [],
    artifacts: [],
    audit_records: [],
    ...overrides,
  };
}

describe("latestAssistantOutcomeSummary", () => {
  it("returns the most recent assistant outcome with aggregated tool steps", () => {
    const outcome = latestAssistantOutcomeSummary(
      thread({
        messages: [
          {
            role: "assistant",
            blocks: [{ type: "text", text: "第一轮总结" }],
          },
          {
            role: "tool",
            blocks: [
              {
                type: "tool_use",
                id: "tool-1",
                name: "ArtifactEmit",
                input: JSON.stringify({ title: "架构总览", kind: "markdown" }),
              },
              {
                type: "tool_result",
                tool_use_id: "tool-1",
                tool_name: "ArtifactEmit",
                output: JSON.stringify({ artifact_id: "artifact-1", kind: "markdown" }),
                is_error: false,
              },
            ],
          },
          {
            role: "assistant",
            blocks: [
              {
                type: "text",
                text: "第二轮先看[证据 2](evidence:es-2#hit-2)。",
              },
            ],
          },
        ],
      }),
    );

    expect(outcome?.message.id).toBe("thread-1-message-0");
    expect(outcome?.message.textParts).toEqual([
      "第一轮总结",
      "第二轮先看[证据 2](evidence:es-2#hit-2)。",
    ]);
    expect(outcome?.summary).toMatchObject({
      artifactCount: 1,
      evidenceCount: 1,
      stepCount: 1,
      previewArtifacts: [{ id: "artifact-1", label: "架构总览", anchor: null }],
      previewEvidence: [{ id: "es-2", label: "证据 2", anchor: "hit-2" }],
    });
  });

  it("falls back to the latest assistant turn that actually has outcomes", () => {
    const outcome = latestAssistantOutcomeSummary(
      thread({
        messages: [
          {
            role: "assistant",
            blocks: [{ type: "text", text: "已完成[结果 A](artifact:artifact-1)" }],
          },
          {
            role: "assistant",
            blocks: [{ type: "text", text: "纯文本追问，不含引用。" }],
          },
        ],
      }),
    );

    expect(outcome?.message.id).toBe("thread-1-message-0");
    expect(outcome?.summary.previewArtifacts).toEqual([
      { id: "artifact-1", label: "结果 A", anchor: null },
    ]);
  });

  it("treats consecutive assistant messages as the same turn when computing latest outcomes", () => {
    const outcome = latestAssistantOutcomeSummary(
      thread({
        messages: [
          {
            role: "assistant",
            blocks: [{ type: "text", text: "第一段说明。" }],
          },
          {
            role: "assistant",
            blocks: [{ type: "text", text: "接着看[结果 B](artifact:artifact-2#block-1)。" }],
          },
        ],
      }),
    );

    expect(outcome?.message.id).toBe("thread-1-message-0");
    expect(outcome?.message.textParts).toEqual([
      "第一段说明。",
      "接着看[结果 B](artifact:artifact-2#block-1)。",
    ]);
    expect(outcome?.summary.previewArtifacts).toEqual([
      { id: "artifact-2", label: "结果 B", anchor: "block-1" },
    ]);
  });

  it("captures auto-generated artifacts from WebFetch and DbQuery tool results", () => {
    const outcome = latestAssistantOutcomeSummary(
      thread({
        messages: [
          {
            role: "assistant",
            blocks: [{ type: "text", text: "先读取网页和数据库。" }],
          },
          {
            role: "tool",
            blocks: [
              {
                type: "tool_use",
                id: "tool-web",
                name: "WebFetch",
                input: JSON.stringify({ url: "https://example.com/report" }),
              },
              {
                type: "tool_result",
                tool_use_id: "tool-web",
                tool_name: "WebFetch",
                output: JSON.stringify({
                  url: "https://example.com/report",
                  text: "content",
                  artifact_id: "artifact-web",
                  artifact_title: "网页摘录 · example.com",
                }),
                is_error: false,
              },
              {
                type: "tool_use",
                id: "tool-db",
                name: "DbQuery",
                input: JSON.stringify({ sql: "select * from reports" }),
              },
              {
                type: "tool_result",
                tool_use_id: "tool-db",
                tool_name: "DbQuery",
                output: JSON.stringify({
                  query: "select * from reports",
                  columns: ["id", "title"],
                  rows: [{ id: 1, title: "weekly" }],
                  artifact_id: "artifact-db",
                  artifact_title: "数据库结果 · analytics",
                }),
                is_error: false,
              },
            ],
          },
        ],
      }),
    );

    expect(outcome?.summary.previewArtifacts).toEqual([
      { id: "artifact-db", label: "数据库结果 · analytics", anchor: null },
      { id: "artifact-web", label: "网页摘录 · example.com", anchor: null },
    ]);
  });
});
