// @vitest-environment jsdom

import { act } from "react";
import type { ReactElement } from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";

import type { ThreadSnapshot } from "@/lib/clawd/types";
import type { AgentTurnRecord } from "@/lib/clawd/agent-turns";
import type {
  ExpertPanelRunEventEnvelope,
  ExpertPanelRunResponse,
} from "@/lib/clawd/types";

import { ConversationStage } from "./ConversationStage";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function threadSnapshot(overrides: Partial<ThreadSnapshot> = {}): ThreadSnapshot {
  return {
    id: "thread-1",
    workspace_root: "/tmp/project",
    session_path: "/tmp/project/.session.jsonl",
    project_id: null,
    project_name: null,
    knowledge_base_id: null,
    knowledge_base_name: null,
    model: "claude-sonnet-4-6",
    permission_mode: "read-only",
    topic: "对话",
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

function expertRun(overrides: Partial<ExpertPanelRunResponse> = {}): ExpertPanelRunResponse {
  return {
    run_id: "run-1",
    thread_id: "thread-1",
    status: "running",
    retry_count: 1,
    concurrency_limit: 3,
    experts: [
      {
        skill: "expert-method-distiller",
        scope: "workspace",
        label: "expert-method-distiller",
        status: "running",
        attempts: 1,
        citations: [],
      },
    ],
    ...overrides,
  };
}

async function renderConversation(
  element: ReactElement,
): Promise<{ container: HTMLDivElement; root: ReturnType<typeof createRoot> }> {
  const container = document.createElement("div");
  document.body.appendChild(container);
  const root = createRoot(container);

  await act(async () => {
    root.render(element);
  });

  return { container, root };
}

function setTextareaValue(textarea: HTMLTextAreaElement, value: string) {
  const descriptor = Object.getOwnPropertyDescriptor(
    HTMLTextAreaElement.prototype,
    "value",
  );
  descriptor?.set?.call(textarea, value);
  textarea.dispatchEvent(new Event("input", { bubbles: true }));
}

async function sendText(container: HTMLElement, text: string) {
  const textarea = container.querySelector('textarea[aria-label="输入问题"]') as HTMLTextAreaElement | null;
  expect(textarea).not.toBeNull();

  await act(async () => {
    if (textarea) {
      setTextareaValue(textarea, text);
    }
  });

  const sendButton = Array.from(container.querySelectorAll("button")).find(
    (button) => button.getAttribute("aria-label") === "发送",
  );
  expect(sendButton).toBeDefined();

  await act(async () => {
    sendButton?.click();
  });
}

describe("ConversationStage", () => {
  const agentTurn = (overrides: Partial<AgentTurnRecord> = {}): AgentTurnRecord => ({
    id: "turn-1",
    conversation_id: "conv-1",
    tenant_id: "tenant-a",
    owner_id: "admin",
    user_message: "分析平台资料",
    assistant_text: "结论来自平台资料。[1]",
    status: "succeeded",
    started_at_ms: new Date("2026-05-15T10:00:00+08:00").getTime(),
    completed_at_ms: new Date("2026-05-15T10:01:00+08:00").getTime(),
    steps: [
      {
        id: "step-1",
        kind: "retrieval",
        label: "资料检索已返回",
        detail: "生成 1 条引用",
        status: "succeeded",
        started_at_ms: new Date("2026-05-15T10:00:04+08:00").getTime(),
        completed_at_ms: new Date("2026-05-15T10:00:07+08:00").getTime(),
        public_payload: { citation_count: 1 },
      },
    ],
    citations: [
      {
        id: "cite-1",
        number: 1,
        source_kind: "es",
        source_label: "平台资料库",
        title: "平台资料报告",
        location: "index-a#hit-1",
        preview: "资料摘要。",
      },
    ],
    expert_results: [],
    artifacts: [],
    error: null,
    debug_events: [],
    ...overrides,
  });

  it("renders database-backed agent turns as the main WebAgent path", async () => {
    const { container, root } = await renderConversation(
      <ConversationStage
        agentTurns={[agentTurn()]}
        isPlatformAdmin={false}
        messages={[
          {
            id: "assistant-legacy",
            role: "assistant",
            content: "旧气泡不应作为主路径显示",
            timestamp: new Date("2026-05-15T10:02:00+08:00"),
          },
        ]}
        onSendMessage={() => {}}
      />,
    );

    expect(container.textContent).toContain("分析平台资料");
    expect(container.textContent).toContain("结论来自平台资料。[1]");
    expect(container.textContent).toContain("资料检索已返回");
    expect(container.textContent).toContain("引用资料");
    expect(container.textContent).not.toContain("旧气泡不应作为主路径显示");

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("keeps the composer editable and queues follow-up messages while an agent turn is running", async () => {
    const onInterrupt = vi.fn();
    const onSendMessage = vi.fn();
    const { container, root } = await renderConversation(
      <ConversationStage
        agentTurns={[agentTurn({ status: "running", assistant_text: "正在检索资料" })]}
        isPlatformAdmin={false}
        messages={[]}
        onInterrupt={onInterrupt}
        onSendMessage={onSendMessage}
      />,
    );

    const textarea = container.querySelector('textarea[aria-label="输入问题"]') as HTMLTextAreaElement | null;
    expect(textarea).not.toBeNull();
    expect(textarea?.disabled).toBe(false);

    await act(async () => {
      if (textarea) {
        setTextareaValue(textarea, "补充最新数据");
      }
    });

    expect(textarea?.value).toBe("补充最新数据");

    const stopButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.getAttribute("aria-label") === "停止当前回复",
    );
    expect(stopButton).toBeDefined();

    await act(async () => {
      textarea?.dispatchEvent(new KeyboardEvent("keydown", {
        bubbles: true,
        key: "Enter",
      }));
    });

    expect(container.textContent).toContain("待发送 1 条");
    expect(container.textContent).toContain("补充最新数据");
    expect(onSendMessage).not.toHaveBeenCalled();

    await act(async () => {
      stopButton?.click();
    });

    expect(onInterrupt).toHaveBeenCalledTimes(1);

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("renders draft assistant text as the current running answer", async () => {
    const { container, root } = await renderConversation(
      <ConversationStage
        messages={[
          {
            id: "user-1",
            role: "user",
            content: "请分析这份资料",
            timestamp: new Date("2026-05-13T00:00:00Z"),
          },
        ]}
        onSendMessage={() => {}}
        expertRun={expertRun()}
        expertRunEvents={[
          {
            kind: "expert_run_event",
            at_ms: 1,
            payload: {
              run_id: "run-1",
              event: "expert_started",
              expert: "expert-method-distiller",
              attempt: 1,
            },
          } satisfies ExpertPanelRunEventEnvelope["payload"],
        ]}
        threadEventsConnected={true}
        threadSnapshot={threadSnapshot({
          status: "running",
          draft_assistant_text: "正在从资料中提取关键判断。",
          messages: [
            {
              id: "assistant-1",
              role: "assistant",
              blocks: [
                {
                  type: "tool_use",
                  id: "es-1",
                  name: "EsSearch",
                  input: JSON.stringify({ query: "平台治理", index: "platform_docs" }),
                },
              ],
            },
          ],
        })}
      />,
    );

    expect(container.textContent).toContain("正在从资料中提取关键判断。");
    expect(container.textContent).toContain("正在生成");
    expect(container.textContent).toContain("正在生成回复，内容会持续进入时间线");
    expect(container.textContent).toContain("执行过程");
    expect(container.textContent).toContain("正在检索资料");
    expect(container.textContent).toContain("expert-method-distiller");

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("shows a degraded runtime status when the reply is running but event streaming is disconnected", async () => {
    const { container, root } = await renderConversation(
      <ConversationStage
        messages={[]}
        onSendMessage={() => {}}
        threadEventsConnected={false}
        threadSnapshot={threadSnapshot({
          status: "running",
          draft_assistant_text: "正在继续生成。",
        })}
      />,
    );

    expect(container.textContent).toContain("正在生成回复，实时连接重试中");

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("shows the submitted user message immediately while the backend request is pending", async () => {
    let resolveSend: (() => void) | null = null;
    const onSendMessage = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSend = resolve;
        }),
    );
    const { container, root } = await renderConversation(
      <ConversationStage
        messages={[]}
        onSendMessage={onSendMessage}
        researchBrief={{
          id: "thread-1",
          title: "对话",
          leadQuestion: "分析资料",
          sourceScopeLabel: "平台知识",
          stage: "question",
          stageLabel: "问题已记录",
          handoffLabel: "可以继续推进。",
          questionCount: 1,
          retrievalCount: 0,
          expertCount: 0,
          synthesisCount: 0,
          artifactCount: 0,
          interventionPrompts: ["立即分析这个问题"],
          retrievalDigest: null,
        }}
      />,
    );

    await sendText(container, "立即分析这个问题");

    expect(onSendMessage).toHaveBeenCalledWith("立即分析这个问题");
    expect(container.textContent).toContain("立即分析这个问题");
    expect(container.textContent).toContain("发送中...");

    await act(async () => {
      resolveSend?.();
    });
    await act(async () => {});

    expect(container.textContent).toContain("发送中...");

    await act(async () => {
      root.render(
        <ConversationStage
          messages={[
            {
              id: "user-1",
              role: "user",
              content: "立即分析这个问题",
              timestamp: new Date("2026-05-13T00:00:01Z"),
            },
          ]}
          onSendMessage={onSendMessage}
          researchBrief={{
            id: "thread-1",
            title: "对话",
            leadQuestion: "分析资料",
            sourceScopeLabel: "平台知识",
            stage: "question",
            stageLabel: "问题已记录",
            handoffLabel: "可以继续推进。",
            questionCount: 1,
            retrievalCount: 0,
            expertCount: 0,
            synthesisCount: 0,
            artifactCount: 0,
            interventionPrompts: ["立即分析这个问题"],
            retrievalDigest: null,
          }}
        />,
      );
    });

    expect(container.textContent).not.toContain("发送中...");

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("keeps long text inside a breakable message body", async () => {
    const longWord = "verylongcontent".repeat(40);
    const { container, root } = await renderConversation(
      <ConversationStage
        messages={[
          {
            id: "assistant-1",
            role: "assistant",
            content: longWord,
            timestamp: new Date("2026-05-13T00:00:00Z"),
          },
        ]}
        onSendMessage={() => {}}
      />,
    );

    const breakableMessage = container.querySelector(".\\[overflow-wrap\\:anywhere\\]");
    expect(breakableMessage?.textContent).toContain(longWord);

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("shows clickable timeline dots only on user messages", async () => {
    const scrollIntoView = vi.fn();
    Object.defineProperty(Element.prototype, "scrollIntoView", {
      configurable: true,
      value: scrollIntoView,
    });
    const { container, root } = await renderConversation(
      <ConversationStage
        messages={[
          {
            id: "user-1",
            role: "user",
            content: "请分析问题",
            timestamp: new Date("2026-05-13T08:00:00Z"),
          },
          {
            id: "assistant-1",
            role: "assistant",
            content: "这是回复",
            timestamp: new Date("2026-05-13T08:01:00Z"),
          },
        ]}
        onSendMessage={() => {}}
      />,
    );

    const anchors = container.querySelectorAll('[data-timeline-anchor="user-message"]');
    expect(anchors).toHaveLength(1);
    expect(anchors[0]?.textContent).toMatch(/\d{2}:\d{2}/);
    expect(container.querySelector('[aria-label*="assistant"]')).toBeNull();

    await act(async () => {
      (anchors[0] as HTMLButtonElement | undefined)?.click();
    });

    expect(scrollIntoView).toHaveBeenCalledWith({
      behavior: "smooth",
      block: "center",
    });

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("uses a searchable conversation list instead of a native select", async () => {
    const onSelectDiscussion = vi.fn();
    const onDeleteDiscussion = vi.fn();
    const discussions = [
      {
        id: "thread-1",
        title: "宏观政策研判",
        timestamp: new Date("2026-05-13T00:00:00Z"),
        messageCount: 12,
        status: "idle" as const,
        subtitle: "平台资料",
      },
      {
        id: "thread-2",
        title: "消费行业复盘",
        timestamp: new Date("2026-05-12T00:00:00Z"),
        messageCount: 8,
        status: "running" as const,
        subtitle: "我的资料",
      },
    ];

    const { container, root } = await renderConversation(
      <ConversationStage
        discussions={discussions}
        messages={[]}
        onDeleteDiscussion={onDeleteDiscussion}
        onSelectDiscussion={onSelectDiscussion}
        onSendMessage={() => {}}
        selectedDiscussionId="thread-1"
      />,
    );

    expect(container.querySelector("select")).toBeNull();
    expect(container.textContent).toContain("宏观政策研判");
    expect(container.textContent).toContain("平台资料");
    expect(container.textContent).toContain("进行中 1");

    const switcherButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.getAttribute("aria-label") === "切换对话",
    );
    expect(switcherButton).toBeDefined();

    await act(async () => {
      switcherButton?.click();
    });

    expect(container.textContent).toContain("对话列表");
    expect(container.textContent).toContain("进行中");
    expect(container.textContent).toContain("最近查看");
    expect(container.textContent).toContain("消费行业复盘");

    const searchInput = container.querySelector('input[aria-label="搜索对话"]') as HTMLInputElement | null;
    expect(searchInput).not.toBeNull();

    await act(async () => {
      if (searchInput) {
        searchInput.value = "消费";
        searchInput.dispatchEvent(new Event("input", { bubbles: true }));
      }
    });

    expect(container.textContent).toContain("消费行业复盘");
    expect(container.textContent).not.toContain("宏观政策研判平台资料12 条消息");

    const targetThread = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent?.includes("消费行业复盘"),
    );
    expect(targetThread).toBeDefined();
    expect(container.textContent).toContain("删除");

    await act(async () => {
      targetThread?.click();
    });

    expect(onSelectDiscussion).toHaveBeenCalledWith("thread-2");
    expect(container.textContent).not.toContain("对话列表");

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("keeps one pending duplicate visible until each confirmed user message arrives", async () => {
    let resolveSend: (() => void) | null = null;
    const onSendMessage = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSend = resolve;
        }),
    );
    const timestamp = new Date("2026-05-13T00:00:00Z");
    const initialMessages = [
      {
        id: "user-1",
        role: "user" as const,
        content: "请继续分析",
        timestamp,
      },
    ];

    const { container, root } = await renderConversation(
      <ConversationStage
        messages={initialMessages}
        onSendMessage={onSendMessage}
        researchTask={{
          id: "thread-1",
          title: "对话",
          status: "writing_ready",
          statusLabel: "可继续",
          nextRecommendedAction: "继续分析",
          availableActions: ["请继续分析"],
          stageHistory: [],
        }}
      />,
    );

    await sendText(container, "请继续分析");

    expect(container.textContent).toContain("发送中...");

    await act(async () => {
      resolveSend?.();
    });
    await act(async () => {});

    expect(container.textContent).toContain("发送中...");

    await act(async () => {
      root.render(
        <ConversationStage
          messages={[
            ...initialMessages,
            {
              id: "user-2",
              role: "user",
              content: "请继续分析",
              timestamp: new Date("2026-05-13T00:01:00Z"),
            },
          ]}
          onSendMessage={onSendMessage}
          researchTask={{
            id: "thread-1",
            title: "对话",
            status: "writing_ready",
            statusLabel: "可继续",
            nextRecommendedAction: "继续分析",
            availableActions: ["请继续分析"],
            stageHistory: [],
          }}
        />,
      );
    });

    expect(container.textContent).not.toContain("发送中...");

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("clears local pending state when switching to another thread", async () => {
    let resolveSend: (() => void) | null = null;
    const onSendMessage = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          resolveSend = resolve;
        }),
    );

    const { container, root } = await renderConversation(
      <ConversationStage
        messages={[]}
        onSendMessage={onSendMessage}
        researchTask={{
          id: "thread-1",
          title: "对话一",
          status: "writing_ready",
          statusLabel: "可继续",
          nextRecommendedAction: "继续分析",
          availableActions: ["继续分析"],
          stageHistory: [],
        }}
        threadSnapshot={threadSnapshot({
          id: "thread-1",
          topic: "对话一",
        })}
      />,
    );

    await sendText(container, "继续分析");

    expect(container.textContent).toContain("发送中...");

    await act(async () => {
      resolveSend?.();
      root.render(
        <ConversationStage
          messages={[]}
          onSendMessage={onSendMessage}
          researchTask={{
            id: "thread-2",
            title: "对话二",
            status: "writing_ready",
            statusLabel: "可继续",
            nextRecommendedAction: "整理观点",
            availableActions: ["整理观点"],
            stageHistory: [],
          }}
          threadSnapshot={threadSnapshot({
            id: "thread-2",
            topic: "对话二",
          })}
        />,
      );
    });

    expect(container.textContent).not.toContain("发送中...");
    expect(container.textContent).not.toContain("继续分析");
    expect(container.textContent).toContain("整理观点");

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("shows composer quick actions and running status in the input area", async () => {
    const onSendMessage = vi.fn();

    const { container, root } = await renderConversation(
      <ConversationStage
        messages={[]}
        onSendMessage={onSendMessage}
        researchBrief={{
          id: "thread-1",
          title: "对话",
          leadQuestion: "分析资料",
          sourceScopeLabel: "平台知识",
          stage: "question",
          stageLabel: "问题已记录",
          handoffLabel: "可以继续推进。",
          questionCount: 1,
          retrievalCount: 0,
          expertCount: 0,
          synthesisCount: 0,
          artifactCount: 0,
          interventionPrompts: ["补充反方观点", "只讨论不写作"],
          retrievalDigest: null,
        }}
        researchTask={{
          id: "thread-1",
          title: "对话",
          status: "writing_ready",
          statusLabel: "可继续",
          nextRecommendedAction: "继续分析",
          availableActions: ["整理为报告", "补充反方观点"],
          stageHistory: [],
        }}
        threadSnapshot={threadSnapshot({
          status: "running",
          draft_assistant_text: "正在整理中",
        })}
        threadEventsConnected={true}
      />,
    );

    expect(container.textContent).not.toContain("回复生成中，可继续补充追问");
    expect(container.textContent).not.toContain("可直接继续追问当前问题");
    expect(container.textContent).not.toContain("围绕当前对话继续提问");
    expect(container.textContent).not.toContain("整理为报告补充反方观点");
    expect(container.textContent).not.toContain("只讨论不写作");
    expect(container.textContent).not.toContain("研究摘要");
    expect(container.textContent).not.toContain("当前任务");

    const textarea = container.querySelector('textarea[aria-label="输入问题"]') as HTMLTextAreaElement | null;
    expect(textarea).not.toBeNull();
    expect(textarea?.disabled).toBe(false);

    await act(async () => {
      if (textarea) {
        setTextareaValue(textarea, "整理为报告");
        textarea.dispatchEvent(
          new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }),
        );
      }
    });

    expect(onSendMessage).not.toHaveBeenCalled();
    expect(container.textContent).toContain("待发送 1 条");
    expect(container.textContent).toContain("整理为报告");

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("keeps the composer editable while submit is idle and sends typed content", async () => {
    const onSendMessage = vi.fn().mockResolvedValue(undefined);

    const { container, root } = await renderConversation(
      <ConversationStage messages={[]} onSendMessage={onSendMessage} />,
    );

    const textarea = container.querySelector('textarea[aria-label="输入问题"]') as HTMLTextAreaElement | null;
    expect(textarea).not.toBeNull();
    expect(textarea?.disabled).toBe(false);

    await act(async () => {
      if (textarea) {
        setTextareaValue(textarea, "请给出结论");
      }
    });

    const sendButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.getAttribute("aria-label") === "发送",
    );
    expect(sendButton?.hasAttribute("disabled")).toBe(false);

    await act(async () => {
      sendButton?.click();
    });

    expect(onSendMessage).toHaveBeenCalledWith("请给出结论");

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("keeps the composer editable while a previous message is submitting", async () => {
    let resolveFirstSend: (() => void) | null = null;
    const onSendMessage = vi
      .fn()
      .mockImplementationOnce(
        () =>
          new Promise<void>((resolve) => {
            resolveFirstSend = resolve;
          }),
      )
      .mockResolvedValue(undefined);

    const { container, root } = await renderConversation(
      <ConversationStage messages={[]} onSendMessage={onSendMessage} />,
    );

    await sendText(container, "第一条问题");

    const textarea = container.querySelector('textarea[aria-label="输入问题"]') as HTMLTextAreaElement | null;
    expect(textarea).not.toBeNull();
    expect(textarea?.disabled).toBe(false);

    await act(async () => {
      if (textarea) {
        setTextareaValue(textarea, "补充约束条件");
      }
    });

    expect(textarea?.value).toBe("补充约束条件");

    let sendButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.getAttribute("aria-label") === "发送",
    );
    expect(sendButton?.hasAttribute("disabled")).toBe(false);

    await act(async () => {
      sendButton?.click();
    });

    expect(container.textContent).toContain("待发送 1 条");
    expect(container.textContent).toContain("当前回复结束后自动发送");

    await act(async () => {
      resolveFirstSend?.();
    });
    await act(async () => {});

    sendButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.getAttribute("aria-label") === "发送",
    );

    expect(onSendMessage).toHaveBeenNthCalledWith(1, "第一条问题");
    expect(onSendMessage).toHaveBeenNthCalledWith(2, "补充约束条件");

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("shows a stop action while running and calls interrupt without disabling input", async () => {
    const onInterrupt = vi.fn().mockResolvedValue(undefined);
    const onSendMessage = vi.fn().mockResolvedValue(undefined);

    const { container, root } = await renderConversation(
      <ConversationStage
        messages={[]}
        onInterrupt={onInterrupt}
        onSendMessage={onSendMessage}
        threadSnapshot={threadSnapshot({
          status: "running",
          draft_assistant_text: "正在整理中",
        })}
      />,
    );

    const textarea = container.querySelector('textarea[aria-label="输入问题"]') as HTMLTextAreaElement | null;
    expect(textarea).not.toBeNull();
    expect(textarea?.disabled).toBe(false);

    const stopButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.getAttribute("aria-label") === "停止当前回复",
    );
    expect(stopButton).toBeDefined();

    await act(async () => {
      stopButton?.click();
    });

    expect(onInterrupt).toHaveBeenCalledTimes(1);
    expect(onSendMessage).not.toHaveBeenCalled();

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("queues Enter submissions while the assistant is running and sends them after completion", async () => {
    const onSendMessage = vi.fn().mockResolvedValue(undefined);
    const initialProps = {
      messages: [],
      onSendMessage,
      threadSnapshot: threadSnapshot({
        status: "running" as const,
        draft_assistant_text: "正在整理中",
      }),
    };
    const { container, root } = await renderConversation(
      <ConversationStage {...initialProps} />,
    );

    const textarea = container.querySelector('textarea[aria-label="输入问题"]') as HTMLTextAreaElement | null;
    expect(textarea).not.toBeNull();

    await act(async () => {
      if (textarea) {
        setTextareaValue(textarea, "补充检索上市公司公告");
        textarea.dispatchEvent(
          new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }),
        );
      }
    });

    expect(onSendMessage).not.toHaveBeenCalled();
    expect(container.textContent).toContain("待发送 1 条");
    expect(container.textContent).toContain("补充检索上市公司公告");

    await act(async () => {
      root.render(
        <ConversationStage
          messages={[]}
          onSendMessage={onSendMessage}
          threadSnapshot={threadSnapshot({
            status: "idle",
            draft_assistant_text: "",
          })}
        />,
      );
    });
    await act(async () => {});

    expect(onSendMessage).toHaveBeenCalledWith("补充检索上市公司公告");

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("does not submit when the user is still composing with IME", async () => {
    const onSendMessage = vi.fn().mockResolvedValue(undefined);

    const { container, root } = await renderConversation(
      <ConversationStage messages={[]} onSendMessage={onSendMessage} />,
    );

    const textarea = container.querySelector('textarea[aria-label="输入问题"]') as HTMLTextAreaElement | null;
    expect(textarea).not.toBeNull();

    await act(async () => {
      textarea?.dispatchEvent(new CompositionEvent("compositionstart", { bubbles: true }));
      if (textarea) {
        setTextareaValue(textarea, "正在输入");
        textarea.dispatchEvent(
          new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }),
        );
      }
    });

    expect(onSendMessage).not.toHaveBeenCalled();

    await act(async () => {
      textarea?.dispatchEvent(new CompositionEvent("compositionend", { bubbles: true }));
      textarea?.dispatchEvent(
        new KeyboardEvent("keydown", { bubbles: true, key: "Enter" }),
      );
    });

    expect(onSendMessage).toHaveBeenCalledWith("正在输入");

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("keeps research summary collapsed by default and reveals detail when expanded", async () => {
    const { container, root } = await renderConversation(
      <ConversationStage
        messages={[]}
        onSendMessage={() => {}}
        researchBrief={{
          id: "thread-1",
          title: "对话",
          leadQuestion: "分析资料",
          sourceScopeLabel: "平台知识",
          stage: "question",
          stageLabel: "问题已记录",
          handoffLabel: "可以继续推进。",
          questionCount: 1,
          retrievalCount: 2,
          expertCount: 3,
          synthesisCount: 0,
          artifactCount: 1,
          interventionPrompts: ["补充反方观点"],
          retrievalDigest: null,
        }}
        researchTask={{
          id: "thread-1",
          title: "对话",
          status: "writing_ready",
          statusLabel: "可继续",
          nextRecommendedAction: "整理为报告",
          availableActions: ["整理为报告"],
          stageHistory: [],
        }}
        timelineEvents={[
          {
            id: "event-1",
            kind: "research_stage",
            title: "问题记录",
            subtitle: "已记录研究问题",
            atMs: 1,
            reference: null,
          },
        ]}
      />,
    );

    expect(container.textContent).not.toContain("研究摘要");
    expect(container.textContent).toContain("整理为报告");
    expect(container.textContent).not.toContain("当前任务");
    expect(container.textContent).toContain("问题 1");
    expect(container.textContent).toContain("检索 2");
    expect(container.textContent).toContain("专家 3");
    expect(container.textContent).toContain("产物 1");
    expect(container.textContent).toContain("时间线 1");

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("shows failed send recovery controls in the composer area", async () => {
    const onSendMessage = vi
      .fn<() => Promise<void>>()
      .mockRejectedValueOnce(new Error("发送失败"))
      .mockResolvedValueOnce(undefined);

    const { container, root } = await renderConversation(
      <ConversationStage
        messages={[]}
        onSendMessage={onSendMessage}
        researchTask={{
          id: "thread-1",
          title: "会话",
          status: "writing_ready",
          statusLabel: "可继续",
          nextRecommendedAction: "继续分析",
          availableActions: ["继续分析"],
          stageHistory: [],
        }}
      />,
    );

    await sendText(container, "继续分析");

    expect(container.textContent).toContain("上次发送失败，可直接重试");
    expect(container.textContent).toContain("未发送内容：继续分析");
    expect(container.textContent).toContain("重试上条");

    const retryButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "重试上条",
    );
    expect(retryButton).toBeDefined();

    await act(async () => {
      retryButton?.click();
    });

    expect(onSendMessage).toHaveBeenNthCalledWith(2, "继续分析");

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });

  it("collapses older messages in long conversations until the user expands them", async () => {
    const messages = Array.from({ length: 45 }, (_, index) => ({
      id: `message-${index + 1}`,
      role: index % 2 === 0 ? ("user" as const) : ("assistant" as const),
      content: `历史消息 #${index + 1}#`,
      timestamp: new Date(1_770_000_000_000 + index),
    }));

    const { container, root } = await renderConversation(
      <ConversationStage messages={messages} onSendMessage={() => {}} />,
    );

    expect(container.textContent).toContain("已折叠较早 5 条消息，点击展开完整时间线");
    expect(container.textContent).not.toContain("历史消息 #1#");
    expect(container.textContent).toContain("历史消息 #45#");

    const expandButton = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "已折叠较早 5 条消息，点击展开完整时间线",
    );
    expect(expandButton).toBeDefined();

    await act(async () => {
      expandButton?.click();
    });

    expect(container.textContent).toContain("历史消息 #1#");
    expect(container.textContent).toContain("历史消息 #45#");
    expect(container.textContent).not.toContain("已折叠较早 5 条消息");

    await act(async () => {
      root.unmount();
    });
    container.remove();
  });
});
