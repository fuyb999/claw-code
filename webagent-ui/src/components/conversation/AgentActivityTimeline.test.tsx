// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { AgentActivityTimeline } from "./AgentActivityTimeline";
import type { AgentTurnStep } from "@/lib/clawd/agent-turns";

afterEach(() => {
  cleanup();
});

function step(status: AgentTurnStep["status"], id: string = status): AgentTurnStep {
  return {
    id,
    kind: "tool",
    label: `步骤 ${status}`,
    detail: null,
    status,
    started_at_ms: new Date("2026-05-15T14:32:00+08:00").getTime(),
    completed_at_ms: status === "running" ? null : new Date("2026-05-15T14:33:00+08:00").getTime(),
    public_payload: {
      result_summary: `产出 ${status}`,
    },
  };
}

describe("AgentActivityTimeline", () => {
  it("renders explicit status indicators for succeeded, failed, and running steps", () => {
    const { container } = render(
      <AgentActivityTimeline
        citations={[]}
        expertResults={[]}
        steps={[step("succeeded"), step("failed"), step("running")]}
      />,
    );

    expect(screen.getByLabelText(/状态：已完成/)).toBeInTheDocument();
    expect(screen.getByLabelText(/状态：失败/)).toBeInTheDocument();
    expect(screen.getByLabelText(/状态：进行中/)).toBeInTheDocument();
    expect(
      container.querySelector('[data-step-status-indicator="true"][data-step-status="succeeded"]'),
    ).toHaveClass("bg-emerald-500");
    expect(
      container.querySelector('[data-step-status-indicator="true"][data-step-status="failed"]'),
    ).toHaveClass("bg-destructive");
    expect(
      container.querySelector('[data-step-status-indicator="true"][data-step-status="running"]'),
    ).toHaveClass("animate-spin");
  });

  it("renders child retrieval steps under the tool call parent", () => {
    const { container } = render(
      <AgentActivityTimeline
        citations={[]}
        expertResults={[]}
        steps={[
          {
            ...step("succeeded", "plan"),
            kind: "generation",
            label: "计划",
            public_payload: { result_summary: "已生成计划", phase: "plan" },
          },
          {
            ...step("running", "tool-1"),
            label: "工具调用",
            public_payload: { tool_purpose: "EsSearch", phase: "tool_call" },
          },
          {
            ...step("succeeded", "tokenize"),
            label: "检索分词",
            public_payload: {
              parent_id: "tool-1",
              result_summary: "分词完成",
            },
          },
          {
            ...step("succeeded", "search"),
            kind: "retrieval",
            label: "检索",
            public_payload: {
              parent_id: "tool-1",
              hit_count: 2,
              citation_numbers: [1, 2],
            },
          },
        ]}
      />,
    );

    const toolRow = screen.getByText("工具调用").closest("[data-pipeline-item]");
    expect(toolRow).not.toBeNull();
    expect(toolRow?.textContent).toContain("检索分词");
    expect(toolRow?.textContent).toContain("检索");
    expect(container.querySelectorAll('[data-pipeline-level="1"]').length).toBeGreaterThanOrEqual(2);
  });
});
