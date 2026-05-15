// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

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
});
