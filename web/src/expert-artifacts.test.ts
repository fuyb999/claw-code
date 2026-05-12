import { describe, expect, it } from "vitest";

import {
  groupExpertArtifacts,
  hasExpertArtifactPresentation,
} from "./expert-artifacts";
import type { ArtifactRecord } from "./types";

function artifact(overrides: Partial<ArtifactRecord> = {}): ArtifactRecord {
  return {
    id: "artifact-1",
    kind: "markdown",
    title: "未命名结果",
    payload: "# Test",
    created_at_ms: 1,
    ...overrides,
  };
}

describe("expert artifact grouping", () => {
  it("groups summary, consensus, expert and other artifacts", () => {
    const grouped = groupExpertArtifacts([
      artifact({ id: "a1", title: "专家会诊 / 综合结论" }),
      artifact({ id: "a2", title: "专家会诊 / 共识与分歧" }),
      artifact({ id: "a3", title: "专家视角 / 米尔斯海默" }),
      artifact({ id: "a4", title: "普通结果卡" }),
    ]);

    expect(grouped.summaryArtifacts.map((item) => item.id)).toEqual(["a1"]);
    expect(grouped.consensusArtifacts.map((item) => item.id)).toEqual(["a2"]);
    expect(grouped.expertArtifacts.map((item) => item.expertName)).toEqual(["米尔斯海默"]);
    expect(grouped.otherArtifacts.map((item) => item.id)).toEqual(["a4"]);
  });

  it("detects when expert presentation should be enabled", () => {
    expect(
      hasExpertArtifactPresentation([artifact({ title: "专家视角 / 基辛格" })]),
    ).toBe(true);
    expect(hasExpertArtifactPresentation([artifact({ title: "普通结果卡" })])).toBe(false);
  });

  it("prefers explicit metadata grouping when present", () => {
    const grouped = groupExpertArtifacts([
      artifact({
        id: "a1",
        title: "普通标题",
        metadata: { group: "expert_summary", panel: "expert_brainstorm" },
      }),
      artifact({
        id: "a2",
        title: "别的标题",
        metadata: {
          group: "expert_view",
          expert_name: "阎学通",
          panel: "expert_brainstorm",
        },
      }),
      artifact({
        id: "a3",
        title: "另一个标题",
        metadata: { group: "expert_consensus", panel: "expert_brainstorm" },
      }),
    ]);

    expect(grouped.summaryArtifacts.map((item) => item.id)).toEqual(["a1"]);
    expect(grouped.expertArtifacts.map((item) => item.expertName)).toEqual(["阎学通"]);
    expect(grouped.consensusArtifacts.map((item) => item.id)).toEqual(["a3"]);
    expect(grouped.panelId).toBe("expert_brainstorm");
  });

  it("focuses on the dominant panel when multiple expert panels exist", () => {
    const grouped = groupExpertArtifacts([
      artifact({
        id: "a1",
        title: "专家会诊 / 综合结论",
        metadata: { group: "expert_summary", panel: "panel-a" },
      }),
      artifact({
        id: "a2",
        title: "专家视角 / 米尔斯海默",
        metadata: { group: "expert_view", expert_name: "米尔斯海默", panel: "panel-a" },
      }),
      artifact({
        id: "a3",
        title: "专家视角 / 基辛格",
        metadata: { group: "expert_view", expert_name: "基辛格", panel: "panel-b" },
      }),
    ]);

    expect(grouped.panelId).toBe("panel-a");
    expect(grouped.summaryArtifacts.map((item) => item.id)).toEqual(["a1"]);
    expect(grouped.expertArtifacts.map((item) => item.artifact.id)).toEqual(["a2"]);
    expect(grouped.otherArtifacts.map((item) => item.id)).toEqual(["a3"]);
  });

  it("surfaces stage artifacts separately when stage metadata exists", () => {
    const grouped = groupExpertArtifacts([
      artifact({
        id: "stage-1",
        title: "议题构建",
        metadata: { panel: "panel-a", stage: "phase_0" },
      }),
      artifact({
        id: "summary-1",
        title: "专家会诊 / 综合结论",
        metadata: { group: "expert_summary", panel: "panel-a" },
      }),
    ]);

    expect(grouped.stageArtifacts).toHaveLength(1);
    expect(grouped.stageArtifacts[0]).toMatchObject({
      stage: "phase_0",
      stageLabel: "议题构建",
    });
    expect(grouped.stageArtifacts[0]?.artifact.id).toBe("stage-1");
    expect(grouped.otherArtifacts).toHaveLength(0);
  });
});
