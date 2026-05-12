import { describe, expect, it } from "vitest";

import {
  collectExpertPanelEvents,
  collectExpertPanelExpertStatuses,
  collectExpertPanelSeeds,
  presentExpertPanelStage,
  summarizeExpertPanels,
} from "./expert-panels";
import type { ArtifactRecord, ThreadSnapshot } from "./types";

function thread(overrides: Partial<ThreadSnapshot> = {}): ThreadSnapshot {
  return {
    id: "thread-1",
    workspace_root: "/tmp/project",
    session_path: "/tmp/project/.session.jsonl",
    project_id: null,
    project_name: null,
    knowledge_base_id: null,
    knowledge_base_name: null,
    model: "gpt-5.4",
    permission_mode: "read-only",
    topic: "专家会诊",
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

describe("expert panels", () => {
  it("collects expert panel events from audit records", () => {
    const events = collectExpertPanelEvents(
      thread({
        audit_records: [
          {
            id: "a1",
            run_id: 1,
            kind: "expert_panel_emit",
            created_at_ms: 10,
            payload: {
              panel_id: "panel-1",
              expert_name: "米尔斯海默",
              stage: "phase_1",
              summary: "完成结构性判断",
              artifact_id: "artifact-1",
              query_refs: ["美中 权力转移"],
              status: "completed",
            },
          },
        ],
      }),
    );

    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      panelId: "panel-1",
      expertName: "米尔斯海默",
      stage: "phase_1",
      artifactId: "artifact-1",
    });
  });

  it("collects expert panel seeds from run_started audit payloads", () => {
    const seeds = collectExpertPanelSeeds(
      thread({
        audit_records: [
          {
            id: "a0",
            run_id: 1,
            kind: "run_started",
            created_at_ms: 8,
            payload: {
              expert_panel: {
                panel_id: "panel-seed",
                master_skill: "expert-brainstorm",
                experts: [
                  { skill: "workspace:mearsheimer", label: "米尔斯海默" },
                  { skill: "tenant:kissinger", label: "基辛格" },
                ],
              },
            },
          },
        ],
      }),
    );

    expect(seeds).toHaveLength(1);
    expect(seeds[0]).toMatchObject({
      panelId: "panel-seed",
      masterSkill: "expert-brainstorm",
      experts: [
        { skill: "workspace:mearsheimer", label: "米尔斯海默" },
        { skill: "tenant:kissinger", label: "基辛格" },
      ],
    });
  });

  it("summarizes completed experts and final stage", () => {
    const summary = summarizeExpertPanels([
      {
        id: "a1",
        panelId: "panel-1",
        expertName: "米尔斯海默",
        stage: "phase_1",
        summary: "完成结构性判断",
        artifactId: "artifact-1",
        queryRefs: [],
        status: "completed",
        createdAtMs: 10,
      },
      {
        id: "a2",
        panelId: "panel-1",
        expertName: null,
        stage: "final",
        summary: "综合结论已生成",
        artifactId: "artifact-final",
        queryRefs: [],
        status: "completed",
        createdAtMs: 11,
      },
    ]);

    expect(summary).toMatchObject({
      panelId: "panel-1",
      plannedExperts: ["米尔斯海默"],
      pendingExperts: [],
      totalEvents: 2,
      completedExperts: ["米尔斯海默"],
      latestStage: "final",
      latestStageLabel: "综合结论",
      latestSummary: "综合结论已生成",
      finalSummaryReady: true,
    });
  });

  it("keeps planned and pending experts visible before emit events arrive", () => {
    const summary = summarizeExpertPanels([], {
      panelId: "panel-seed",
      masterSkill: "expert-brainstorm",
      experts: [
        { skill: "workspace:mearsheimer", label: "米尔斯海默" },
        { skill: "tenant:kissinger", label: "基辛格" },
      ],
      createdAtMs: 5,
    });

    expect(summary).toMatchObject({
      panelId: "panel-seed",
      masterSkill: "expert-brainstorm",
      plannedExperts: ["米尔斯海默", "基辛格"],
      completedExperts: [],
      pendingExperts: ["米尔斯海默", "基辛格"],
      totalEvents: 0,
      latestStage: null,
      finalSummaryReady: false,
    });
  });

  it("builds expert execution statuses from seed, events and artifacts", () => {
    const statuses = collectExpertPanelExpertStatuses(
      {
        panelId: "panel-seed",
        masterSkill: "expert-brainstorm",
        experts: [
          { skill: "workspace:mearsheimer", label: "米尔斯海默" },
          { skill: "tenant:kissinger", label: "基辛格" },
        ],
        createdAtMs: 5,
      },
      [
        {
          id: "evt-1",
          panelId: "panel-seed",
          expertName: "米尔斯海默",
          stage: "phase_1",
          summary: "完成结构性判断",
          artifactId: "artifact-m",
          queryRefs: ["权力转移"],
          status: "completed",
          createdAtMs: 10,
        },
      ],
      [
        artifact({
          id: "artifact-m",
          title: "专家视角 / 米尔斯海默",
          metadata: {
            group: "expert_view",
            expert_name: "米尔斯海默",
            panel: "panel-seed",
          },
        }),
      ],
    );

    expect(statuses).toHaveLength(2);
    expect(statuses[0]).toMatchObject({
      expertName: "米尔斯海默",
      completed: true,
      status: "completed",
      artifactId: "artifact-m",
      stageLabel: "独立评估",
    });
    expect(statuses[1]).toMatchObject({
      expertName: "基辛格",
      completed: false,
      status: "planned",
      artifactId: null,
      stageLabel: null,
    });
  });

  it("maps common expert panel stages to user-facing labels", () => {
    expect(presentExpertPanelStage("phase_1")).toBe("独立评估");
    expect(presentExpertPanelStage("phase_2")).toBe("交叉辩论");
    expect(presentExpertPanelStage("phase_3")).toBe("共识与分歧");
    expect(presentExpertPanelStage("phase_4")).toBe("综合结论");
    expect(presentExpertPanelStage("final")).toBe("综合结论");
    expect(presentExpertPanelStage("consensus")).toBe("共识与分歧");
  });
});
