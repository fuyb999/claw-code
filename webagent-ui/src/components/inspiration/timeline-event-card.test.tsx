import { describe, expect, it, vi } from "vitest";
import { createRoot } from "react-dom/client";
import { act } from "react";

import { TimelineEventCard } from "./TimelineEventCard";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

describe("TimelineEventCard", () => {
  it("forwards artifact and evidence references through click handlers", () => {
    const onOpenReference = vi.fn();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        <div>
          <TimelineEventCard
            event={{
              id: "artifact-1",
              kind: "artifact",
              title: "分析报告",
              subtitle: "markdown",
              atMs: 1,
              reference: {
                kind: "artifact",
                id: "artifact-1",
                anchor: "summary",
              },
            }}
            onOpenReference={onOpenReference}
          />
          <TimelineEventCard
            event={{
              id: "evidence-1",
              kind: "retrieval",
              title: "检索资料",
              subtitle: "AI policy",
              atMs: 2,
              reference: {
                kind: "evidence",
                id: "evidence-1",
                anchor: null,
              },
            }}
            onOpenReference={onOpenReference}
          />
        </div>,
      );
    });

    const buttons = Array.from(container.querySelectorAll("button"));
    act(() => {
      buttons[0]?.click();
      buttons[1]?.click();
    });

    expect(onOpenReference).toHaveBeenNthCalledWith(1, {
      kind: "artifact",
      id: "artifact-1",
      anchor: "summary",
    });
    expect(onOpenReference).toHaveBeenNthCalledWith(2, {
      kind: "evidence",
      id: "evidence-1",
      anchor: null,
    });

    act(() => {
      root.unmount();
    });
    container.remove();
  });

  it("keeps non-reference events inert", () => {
    const onOpenReference = vi.fn();
    const container = document.createElement("div");
    document.body.appendChild(container);
    const root = createRoot(container);

    act(() => {
      root.render(
        <TimelineEventCard
          event={{
            id: "expert-1",
            kind: "expert_message",
            title: "米尔斯海默",
            subtitle: "专家观点已进入时间线",
            atMs: 3,
            reference: null,
          }}
          onOpenReference={onOpenReference}
        />,
      );
    });

    const button = container.querySelector("button");
    act(() => {
      button?.click();
    });

    expect(button?.getAttribute("disabled")).not.toBeNull();
    expect(onOpenReference).not.toHaveBeenCalled();

    act(() => {
      root.unmount();
    });
    container.remove();
  });
});
