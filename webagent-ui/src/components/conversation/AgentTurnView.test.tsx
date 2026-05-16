// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { AgentTurnView } from "./AgentTurnView";
import type { AgentTurnRecord } from "@/lib/clawd/agent-turns";

const turn: AgentTurnRecord = {
  id: "turn-1",
  conversation_id: "conv-1",
  tenant_id: "tenant-a",
  owner_id: "alice",
  user_message: "分析台海供应链风险",
  assistant_text: "主要风险来自运输节点。[1]",
  status: "succeeded",
  started_at_ms: new Date("2026-05-15T14:32:00+08:00").getTime(),
  completed_at_ms: new Date("2026-05-15T14:33:00+08:00").getTime(),
  steps: [
    {
      id: "step-1",
      kind: "retrieval",
      label: "资料检索已返回",
      detail: "生成 1 条引用",
      status: "succeeded",
      started_at_ms: new Date("2026-05-15T14:32:04+08:00").getTime(),
      completed_at_ms: new Date("2026-05-15T14:32:07+08:00").getTime(),
      public_payload: { citation_count: 1 },
    },
  ],
  citations: [
    {
      id: "tool-1#hit-0",
      number: 1,
      source_kind: "es",
      source_label: "平台资料库",
      title: "供应链报告",
      location: "military-index#1",
      preview: "港口风险上升。",
    },
  ],
  expert_results: [],
  artifacts: [],
  error: null,
  debug_events: [],
};

afterEach(() => {
  cleanup();
});

describe("AgentTurnView", () => {
  it("renders one user question with one integrated agent answer", () => {
    render(<AgentTurnView isAdmin={false} turn={turn} />);

    expect(screen.getByText("分析台海供应链风险")).toBeInTheDocument();
    expect(screen.getByText(/主要风险来自运输节点。/)).toBeInTheDocument();
    expect(screen.getByText("资料检索已返回")).toBeInTheDocument();
    expect(screen.getByText("引用资料")).toBeInTheDocument();
    expect(screen.getByText("供应链报告")).toBeInTheDocument();
    expect(screen.queryByText("TOOL_CALL_RESULT")).not.toBeInTheDocument();
  });

  it("renders failed turn details and failed generation step inside the answer card", () => {
    render(
      <AgentTurnView
        isAdmin={false}
        turn={{
          ...turn,
          assistant_text: "已经生成的部分答案。",
          status: "failed",
          steps: [
            {
              id: "turn-1-failed",
              kind: "generation",
              label: "生成回答失败",
              detail: "模型调用失败，请重试。",
              status: "failed",
              started_at_ms: turn.started_at_ms,
              completed_at_ms: turn.completed_at_ms,
              public_payload: {
                result_summary: "模型调用失败，请重试。",
                is_error: true,
              },
            },
          ],
          citations: [],
          error: {
            public_message: "模型调用失败，请重试。",
            debug_message: "model call failed",
            code: null,
          },
        }}
      />,
    );

    expect(screen.getByText("已经生成的部分答案。")).toBeInTheDocument();
    expect(screen.getAllByText("处理失败")).toHaveLength(2);
    expect(screen.getAllByText("模型调用失败，请重试。")).toHaveLength(2);
    expect(screen.getByText("生成回答失败")).toBeInTheDocument();
    expect(screen.queryByText("正在处理")).not.toBeInTheDocument();
  });
});
