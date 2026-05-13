import { describe, expect, it } from "vitest";

import { buildTimelineEvents } from "./timeline-events";
import type { MessageSnapshot, ThreadSnapshot } from "./types";

function thread(overrides: Partial<ThreadSnapshot>): ThreadSnapshot {
  return {
    id: "thread-1",
    workspace_root: "/internal/workspace",
    session_path: "/internal/session",
    project_id: null,
    project_name: null,
    knowledge_base_id: "kb-1",
    knowledge_base_name: "平台知识",
    model: "gpt-test",
    permission_mode: "default",
    topic: "AI 竞争分析",
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

function messageWithMetadata(
  message: MessageSnapshot,
  metadata: Record<string, unknown>,
): MessageSnapshot {
  return {
    ...message,
    metadata,
  } as MessageSnapshot;
}

describe("timeline-events", () => {
  it("derives retrieval, expert, synthesis, and artifact events without internal paths", () => {
    const events = buildTimelineEvents(
      thread({
        messages: [
          {
            id: "m-user",
            role: "user",
            blocks: [{ type: "text", text: "分析中美 AI 竞争" }],
          },
          {
            id: "m-expert",
            role: "assistant",
            blocks: [{ type: "text", text: "### 米尔斯海默\n现实主义判断" }],
          },
          {
            id: "m-synthesis",
            role: "assistant",
            blocks: [{ type: "text", text: "### Final synthesis\n综合判断" }],
          },
          {
            id: "m-tool",
            role: "assistant",
            blocks: [
              {
                type: "tool_use",
                id: "tool-1",
                name: "EsSearch",
                input: JSON.stringify({ query: "AI policy", index: "secret_index" }),
              },
              {
                type: "tool_use",
                id: "tool-2",
                name: "SourceSearch",
                input: JSON.stringify({ path: "/internal/private/report.md" }),
              },
            ],
          },
        ],
        artifacts: [
          {
            id: "artifact-1",
            kind: "markdown",
            title: "分析报告",
            payload: "# report",
            created_at_ms: 3,
          },
        ],
      }),
    );

    expect(events.map((event) => event.kind)).toEqual([
      "user_question",
      "expert_message",
      "synthesis",
      "retrieval",
      "retrieval",
      "artifact",
    ]);
    expect(events.find((event) => event.kind === "retrieval")?.title).toBe("检索资料");
    expect(events.find((event) => event.kind === "artifact")?.title).toBe("分析报告");
    expect(events.filter((event) => event.kind === "retrieval").map((event) => event.subtitle)).toEqual([
      "AI policy",
      "当前资料范围",
    ]);
    expect(JSON.stringify(events)).not.toContain("secret_index");
    expect(JSON.stringify(events)).not.toContain("/internal");
  });

  it("derives failed expert events from audit records", () => {
    const events = buildTimelineEvents(
      thread({
        audit_records: [
          {
            id: "audit-1",
            run_id: null,
            kind: "expert_run_event",
            created_at_ms: 10,
            payload: {
              event: "expert_failed",
              expert: "产业专家",
              error: "model timeout",
            },
          },
        ],
      }),
    );

    expect(events).toEqual([
      {
        id: "audit-1",
        kind: "expert_failed",
        title: "产业专家失败",
        subtitle: "已记录失败，其他专家继续执行",
        atMs: 10,
        reference: null,
      },
    ]);
  });

  it("derives execution scope and retrieval policy from effective execution context metadata", () => {
    const events = buildTimelineEvents(
      thread({
        messages: [
          messageWithMetadata(
            {
              id: "m-user",
              role: "user",
              blocks: [{ type: "text", text: "请总结行业趋势" }],
            },
            {
              effective_execution_context: {
                knowledge_base_name: "行业资料包",
                auto_retrieval: false,
              },
            },
          ),
        ],
      }),
    );

    expect(events.map((event) => event.kind)).toEqual([
      "user_question",
      "execution_scope",
      "retrieval_policy",
    ]);
    expect(events.find((event) => event.kind === "execution_scope")).toMatchObject({
      title: "本次使用资料范围",
      subtitle: "行业资料包",
    });
    expect(events.find((event) => event.kind === "retrieval_policy")).toMatchObject({
      title: "自动检索已关闭",
      subtitle: "不做默认前置检索",
    });
  });

  it("derives execution scope with fallback subtitle when effective execution context has no KB name", () => {
    const events = buildTimelineEvents(
      thread({
        messages: [
          messageWithMetadata(
            {
              id: "m-user",
              role: "user",
              blocks: [{ type: "text", text: "请继续分析" }],
            },
            {
              effective_execution_context: {
                auto_retrieval: true,
              },
            },
          ),
        ],
      }),
    );

    expect(events.map((event) => event.kind)).toEqual([
      "user_question",
      "execution_scope",
      "retrieval_policy",
    ]);
    expect(events.find((event) => event.kind === "execution_scope")).toMatchObject({
      title: "本次使用资料范围",
      subtitle: "当前资料范围",
    });
  });

  it("derives execution scope and retrieval policy from audit payload when message metadata is absent", () => {
    const events = buildTimelineEvents(
      thread({
        audit_records: [
          {
            id: "audit-ctx",
            run_id: 7,
            kind: "thread_run_context",
            created_at_ms: 6,
            payload: {
              effective_execution_context: {
                knowledge_base_name: "项目知识库",
                auto_retrieval: true,
              },
            },
          },
        ],
      }),
    );

    expect(events).toEqual([
      {
        id: "audit-ctx:execution_scope",
        kind: "execution_scope",
        title: "本次使用资料范围",
        subtitle: "项目知识库",
        atMs: 6,
        reference: null,
      },
      {
        id: "audit-ctx:retrieval_policy",
        kind: "retrieval_policy",
        title: "自动检索已开启",
        subtitle: "回答前可默认检索资料",
        atMs: 6,
        reference: null,
      },
    ]);
  });
});
