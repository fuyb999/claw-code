import { describe, expect, it } from "vitest";

import {
  groupAgentTurnSteps,
  groupTurnsByDisplayDate,
  replaceEvidenceMarkersWithCitationNumbers,
  statusLabelForAgentTurn,
} from "./agent-turns";

describe("agent-turn helpers", () => {
  it("replaces raw evidence markers with numbered citations", () => {
    const result = replaceEvidenceMarkersWithCitationNumbers(
      "结论来自 evidence:tool-1#hit-0 和 evidence:tool-1#hit-1",
      [
        { id: "tool-1#hit-0", number: 1 },
        { id: "tool-1#hit-1", number: 2 },
      ],
    );

    expect(result).toBe("结论来自 [1] 和 [2]");
  });

  it("uses compact date separators", () => {
    const groups = groupTurnsByDisplayDate(
      [
        { id: "a", started_at_ms: new Date("2026-05-15T08:00:00+08:00").getTime() },
        { id: "b", started_at_ms: new Date("2026-05-16T08:00:00+08:00").getTime() },
      ],
      new Date("2026-05-16T12:00:00+08:00"),
    );

    expect(groups.map((group) => group.label)).toEqual(["5月15日 周五", "5月16日 周六"]);
  });

  it("uses ordinary user status labels", () => {
    expect(statusLabelForAgentTurn("running")).toBe("正在处理");
    expect(statusLabelForAgentTurn("failed")).toBe("处理失败");
  });

  it("groups retrieval steps with action, output, and citation references", () => {
    const groups = groupAgentTurnSteps(
      [
        {
          id: "retrieval-1",
          kind: "retrieval",
          label: "检索资料库",
          detail: "检索完成",
          status: "succeeded",
          started_at_ms: 100,
          completed_at_ms: 200,
          public_payload: {
            source_name: "平台资料库",
            query: "台海供应链",
            hit_count: 2,
            citation_numbers: [1, 2],
          },
          debug_payload: {
            result_summary: "debug only",
          },
        },
      ],
      [],
      [],
    );

    expect(groups[0]?.kind).toBe("retrieval");
    expect(groups[0]?.title).toBe("资料检索");
    expect(groups[0]?.items[0]?.title).toBe("检索资料库");
    expect(groups[0]?.items[0]?.action).toBe("查询：台海供应链");
    expect(groups[0]?.items[0]?.output).toContain("命中 2 篇资料");
    expect(groups[0]?.items[0]?.references).toEqual([1, 2]);
    expect(groups[0]?.items[0]?.detail).toBe("检索完成");
  });

  it("builds a tree-shaped execution chain from model response to tool result", () => {
    const groups = groupAgentTurnSteps(
      [
        {
          id: "generation-1",
          kind: "generation",
          label: "模型接口响应内容",
          detail: "模型已生成计划",
          status: "succeeded",
          started_at_ms: 1,
          completed_at_ms: 2,
          public_payload: {
            result_summary: "模型接口响应已返回",
            phase: "model_response",
          },
        },
        {
          id: "generation-2",
          kind: "generation",
          label: "计划",
          detail: "开始执行检索计划",
          status: "succeeded",
          started_at_ms: 3,
          completed_at_ms: 4,
          public_payload: {
            result_summary: "已生成计划",
            phase: "plan",
          },
        },
        {
          id: "tool-1",
          kind: "tool",
          label: "工具调用",
          detail: "准备检索分词",
          status: "running",
          started_at_ms: 5,
          completed_at_ms: null,
          public_payload: {
            tool_purpose: "EsSearch",
            phase: "tool_call",
          },
        },
        {
          id: "step-tokenize",
          kind: "tool",
          label: "检索分词",
          detail: "已拆分关键词",
          status: "succeeded",
          started_at_ms: 6,
          completed_at_ms: 7,
          public_payload: {
            parent_id: "tool-1",
            phase: "retrieval_tokenize",
            result_summary: "分词完成",
          },
        },
        {
          id: "step-search",
          kind: "retrieval",
          label: "检索",
          detail: "命中 2 篇资料",
          status: "succeeded",
          started_at_ms: 8,
          completed_at_ms: 9,
          public_payload: {
            parent_id: "tool-1",
            phase: "retrieval_search",
            source_name: "平台资料库",
            query: "台海供应链",
            hit_count: 2,
            citation_numbers: [1, 2],
          },
        },
        {
          id: "step-result",
          kind: "citation",
          label: "结果",
          detail: "形成 2 条引用",
          status: "succeeded",
          started_at_ms: 10,
          completed_at_ms: 11,
          public_payload: {
            parent_id: "tool-1",
            phase: "retrieval_result",
            result_summary: "命中 2 篇资料，形成 2 条引用",
            citation_numbers: [1, 2],
          },
        },
      ],
      [],
      [],
    );

    expect(groups.map((group) => group.kind)).toEqual(["generation", "tool"]);
    expect(groups[0]?.items[0]?.title).toBe("模型接口响应内容");
    expect(groups[0]?.items[1]?.title).toBe("计划");
    expect(groups[1]?.items[0]?.title).toBe("工具调用");
    expect(groups[1]?.items[0]?.children?.map((item) => item.title)).toEqual([
      "检索分词",
      "检索",
      "结果",
    ]);
    expect(groups[1]?.items[0]?.children?.[1]?.output).toContain("命中 2 篇资料");
  });

  it("adds expert results to the expert pipeline group", () => {
    const groups = groupAgentTurnSteps(
      [],
      [],
      [
        {
          expert_name: "Mearsheimer",
          status: "succeeded",
          summary: "大国竞争压力升高。",
          citation_numbers: [2],
          error: null,
        },
      ],
    );

    expect(groups).toEqual([
      {
        kind: "expert",
        title: "专家分析",
        items: [
          {
            id: "expert-result-Mearsheimer-0",
            title: "Mearsheimer 分析",
            action: "专家视角分析",
            output: "大国竞争压力升高。",
            status: "succeeded",
            references: [2],
            detail: null,
            started_at_ms: null,
            completed_at_ms: null,
          },
        ],
      },
    ]);
  });
});
