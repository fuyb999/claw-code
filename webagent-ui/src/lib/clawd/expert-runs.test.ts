import { describe, expect, it } from "vitest";

import { buildExpertRunRequest } from "./expert-runs";
import type { SkillScope } from "./types";

function expert(
  skill: string,
  label: string,
  scope: SkillScope = "workspace",
) {
  return {
    skill,
    scope,
    label,
    description: `${label} 视角`,
  };
}

describe("buildExpertRunRequest", () => {
  it("builds a question-based expert run request and clamps controls", () => {
    expect(
      buildExpertRunRequest({
        question: "  分析中美 AI 竞争  ",
        knowledgeBaseId: "kb-42",
        autoRetrieval: true,
        experts: [expert("mearsheimer", "米尔斯海默")],
        retryCount: 9,
        concurrencyLimit: 0,
      }),
    ).toEqual({
      question: "分析中美 AI 竞争",
      knowledge_base_id: "kb-42",
      auto_retrieval: true,
      experts: [expert("mearsheimer", "米尔斯海默")],
      retry_count: 3,
      concurrency_limit: 1,
    });
  });

  it("builds a source-message follow-up expert run request", () => {
    expect(
      buildExpertRunRequest({
        sourceMessageId: "thread-1-message-2",
        experts: [expert("nye", "约瑟夫·奈")],
        retryCount: 1,
        concurrencyLimit: 3,
      }),
    ).toEqual({
      source_message_id: "thread-1-message-2",
      experts: [expert("nye", "约瑟夫·奈")],
      retry_count: 1,
      concurrency_limit: 3,
    });
  });

  it("rejects empty experts or missing question/source message", () => {
    expect(() =>
      buildExpertRunRequest({
        question: "分析",
        experts: [],
        retryCount: 1,
        concurrencyLimit: 3,
      }),
    ).toThrow("请先选择至少一位专家");

    expect(() =>
      buildExpertRunRequest({
        experts: [expert("mearsheimer", "米尔斯海默")],
        retryCount: 1,
        concurrencyLimit: 3,
      }),
    ).toThrow("请先提供问题或选择要继续会诊的消息");
  });
});
