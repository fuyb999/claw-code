import { describe, expect, it } from "vitest";

import type { AgentTurnRecord } from "@/lib/clawd/agent-turns";

import { mergeRunFinishedTurn, mergeRefreshedTurns } from "./useWebAgentSession";

const baseTurn: AgentTurnRecord = {
  id: "turn-123",
  conversation_id: "conv-1",
  tenant_id: "tenant-a",
  owner_id: "alice",
  user_message: "分析台海供应链风险",
  assistant_text: "主要风险来自运输节点。",
  status: "failed",
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
  citations: [],
  expert_results: [],
  artifacts: [],
  error: null,
  debug_events: [],
};

function failedLocalTurn(runId = "turn-123"): AgentTurnRecord {
  return {
    ...baseTurn,
    id: runId,
    steps: [
      ...baseTurn.steps,
      {
        id: `${runId}-failed`,
        kind: "generation",
        label: "生成回答失败",
        detail: "模型调用失败，请重试。",
        status: "failed",
        started_at_ms: baseTurn.started_at_ms,
        completed_at_ms: baseTurn.completed_at_ms,
        public_payload: {
          result_summary: "模型调用失败，请重试。",
          is_error: true,
        },
      },
    ],
    error: {
      public_message: "模型调用失败，请重试。",
      debug_message: "provider timeout",
      code: null,
    },
  };
}

describe("useWebAgentSession failure turn merging", () => {
  it("preserves local failure details when a final turn arrives after run failure", () => {
    const localTurn = failedLocalTurn();
    const finalTurn: AgentTurnRecord = {
      ...baseTurn,
      id: "server-turn-1",
      assistant_text: "服务端最终回答",
      steps: [{ ...baseTurn.steps[0], id: "server-step-1" }],
      error: {
        public_message: "处理失败",
        debug_message: "generic failure",
        code: null,
      },
    };

    const merged = mergeRunFinishedTurn({
      existingTurn: localTurn,
      finalTurn,
      runId: "turn-123",
    });

    expect(merged.assistant_text).toBe("服务端最终回答");
    expect(merged.status).toBe("failed");
    expect(merged.steps.map((step) => step.id)).toContain("turn-123-failed");
    expect(merged.error).toEqual(localTurn.error);
  });

  it("preserves local failure details when refreshed backend turns replace the list", () => {
    const localTurn = failedLocalTurn();
    const refreshedTurn: AgentTurnRecord = {
      ...baseTurn,
      assistant_text: "刷新后的回答",
      steps: [{ ...baseTurn.steps[0], id: "server-step-1" }],
      error: {
        public_message: "处理失败",
        debug_message: "generic failure",
        code: null,
      },
    };

    const merged = mergeRefreshedTurns({
      currentTurns: [localTurn],
      refreshedTurns: [refreshedTurn],
    });

    expect(merged).toHaveLength(1);
    expect(merged[0].assistant_text).toBe("刷新后的回答");
    expect(merged[0].steps.map((step) => step.id)).toContain("turn-123-failed");
    expect(merged[0].error).toEqual(localTurn.error);
  });
});
