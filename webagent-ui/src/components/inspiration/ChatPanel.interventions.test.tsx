// @vitest-environment jsdom

import { act } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import { ChatPanel } from "./ChatPanel";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

Object.defineProperty(Element.prototype, "scrollIntoView", {
  configurable: true,
  value: vi.fn(),
});

describe("ChatPanel interventions", () => {
  it("keeps research brief prompt chips hidden while the main chat input sends normally", async () => {
    const onSendMessage = vi.fn();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    await act(async () => {
      root.render(
        <ChatPanel
          messages={[]}
          onSendMessage={onSendMessage}
          researchBrief={{
            id: "thread-1",
            title: "季度策略讨论",
            leadQuestion: "分析季度策略",
            sourceScopeLabel: "平台知识",
            stage: "writing_ready",
            stageLabel: "可进入写作整理",
            handoffLabel: "已有综合结论和产物，可继续要求重写、整理或生成报告。",
            questionCount: 1,
            retrievalCount: 2,
            expertCount: 3,
            synthesisCount: 1,
            artifactCount: 1,
            interventionPrompts: ["只讨论不写作", "先查资料", "用这些证据重写"],
            retrievalDigest: null,
          }}
          researchTask={{
            id: "thread-1",
            title: "季度策略讨论",
            status: "writing_ready",
            statusLabel: "可进入写作整理",
            nextRecommendedAction: "整理综合结论并生成正式报告",
            availableActions: ["用这些证据重写", "整理为报告", "补充反方观点"],
            stageHistory: [
              { stage: "question", label: "问题已记录", atMs: 1 },
              { stage: "expert_review", label: "专家复评中", atMs: 2 },
            ],
          }}
          timelineEvents={[]}
        />,
      );
    });

    expect(container.querySelector('[data-region="composer-quick-actions"]')).toBeNull();
    expect(container.textContent).not.toContain("用这些证据重写");

    await act(async () => {
      const input = container.querySelector(
        'textarea[aria-label="输入问题"]',
      ) as HTMLTextAreaElement | null;

      expect(input).toBeDefined();
      input!.value = "用这些证据重写";
      input!.dispatchEvent(new Event("input", { bubbles: true }));
    });

    const sendButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.getAttribute("aria-label") === "发送",
    );
    expect(sendButton).toBeDefined();

    await act(async () => {
      sendButton?.click();
    });

    expect(onSendMessage).toHaveBeenCalledWith("用这些证据重写");

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});
