// @vitest-environment jsdom

import "@testing-library/jest-dom/vitest";
import { cleanup, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";

import { AgentActivityTimeline } from "./AgentActivityTimeline";
import type { AgentTurnStep } from "@/lib/clawd/agent-turns";

afterEach(() => {
  cleanup();
});

function step(status: AgentTurnStep["status"], id = status): AgentTurnStep {
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
    expect(container.querySelector('[data-step-status="succeeded"]')).toHaveClass("bg-emerald-500");
    expect(container.querySelector('[data-step-status="failed"]')).toHaveClass("bg-destructive");
    expect(container.querySelector('[data-step-status="running"]')).toHaveClass("animate-spin");
  });
});
