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
    expect(groups[0]?.items[0]?.output).toContain("命中 2 篇资料");
    expect(groups[0]?.items[0]?.references).toEqual([1, 2]);
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
