import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import type { RecentUploadScopeState } from "@/lib/clawd/upload-scope-state";

import { ChatPanel } from "./ChatPanel";

const activeRecentUploadScope: RecentUploadScopeState = {
  knowledgeBaseId: "kb-personal",
  active: true,
  status: "ready",
};

describe("ChatPanel", () => {
  it("shows execution-oriented status copy and active scope labels", () => {
    const html = renderToStaticMarkup(
      <ChatPanel
        discussions={[
          {
            id: "thread-1",
            title: "季度策略讨论",
            subtitle: "个人对话",
            timestamp: new Date("2026-05-13T00:00:00Z"),
            messageCount: 2,
            status: "idle",
          },
          {
            id: "thread-2",
            title: "政策资料解读",
            subtitle: "政策资料库",
            timestamp: new Date("2026-05-12T00:00:00Z"),
            messageCount: 4,
            status: "running",
          },
        ]}
        expertRunLabel="专家会诊运行中 · 2/4"
        loading={false}
        messages={[]}
        onCreateDiscussion={() => {}}
        onSelectDiscussion={() => {}}
        onSendMessage={() => {}}
        recentUploadScopeState={activeRecentUploadScope}
        selectedDiscussionId="thread-1"
        sending={true}
        sourceContextLabel="下一条消息或专家会诊将使用：平台知识"
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
          retrievalDigest: {
            title: "最近一次检索：平台政策变化",
            subtitle: "最近一次命中 2 条",
            highlights: ["政策更新周报", "平台治理解读"],
          },
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
        threadTitle="季度策略讨论"
        timelineEvents={[]}
      />,
    );

    expect(html).toContain("季度策略讨论");
    expect(html).toContain("新建对话");
    expect(html).toContain("进行中 1");
    expect(html).toContain("整理综合结论并生成正式报告");
    expect(html).toContain("个人资料范围已就绪");
    expect(html).toContain("下一条消息或专家会诊将使用：平台知识");
    expect(html).toContain("可进入写作整理");
    expect(html).toContain("问题 1");
    expect(html).toContain("检索 2");
    expect(html).toContain("专家 3");
    expect(html).toContain("产物 1");
    expect(html).not.toContain("研究简报");
    expect(html).not.toContain("当前任务");
    expect(html).not.toContain("最近一次检索：平台政策变化");
    expect(html).not.toContain('data-region="research-summary"');
    expect(html).not.toContain("当前是纯聊天会话");
  });

  it("shows compact empty, loading, and error states in the center panel", () => {
    const html = renderToStaticMarkup(
      <ChatPanel
        error="线程同步失败，请稍后重试"
        loading={true}
        messages={[]}
        onSendMessage={() => {}}
        recentUploadScopeState={null}
        sending={false}
        timelineEvents={[]}
      />,
    );

    expect(html).toContain("正在同步对话...");
    expect(html).toContain("处理异常");
    expect(html).toContain("线程同步失败，请稍后重试");
    expect(html).toContain("暂无对话记录");
    expect(html).toContain("当前还没有对话。直接发送问题即可自动开始。");
    expect(html).not.toContain("用户问题、检索、专家观点、引用和产物会在这里串联。");
    expect(html).not.toContain("对话已连接，可继续提问");
  });

  it("shows a reconnecting status when thread events are disconnected", () => {
    const html = renderToStaticMarkup(
      <ChatPanel
        loading={false}
        messages={[]}
        onSendMessage={() => {}}
        recentUploadScopeState={null}
        sending={false}
        threadEventsConnected={false}
        timelineEvents={[]}
      />,
    );

    expect(html).toContain("对话连接中断，正在等待下一次同步");
    expect(html).not.toContain("会话连接中断，正在等待下一次同步");
    expect(html).not.toContain("对话已连接，可继续提问");
  });

  it("keeps only actionable assistant message controls", () => {
    const html = renderToStaticMarkup(
      <ChatPanel
        loading={false}
        messages={[
          {
            id: "assistant-1",
            role: "assistant",
            content: "这里是回答内容",
            timestamp: new Date("2026-05-13T00:00:00Z"),
          },
        ]}
        onSendMessage={() => {}}
        recentUploadScopeState={null}
        sending={false}
        timelineEvents={[]}
      />,
    );

    expect(html).toContain("复制");
    expect(html).toContain("下载");
    expect(html).not.toContain("收藏");
    expect(html).not.toContain("endpoint");
    expect(html).not.toContain("index_name");
    expect(html).not.toContain("workspace_root");
    expect(html).not.toContain("auth_mode");
  });

  it("shows enriched evidence chips under assistant answers", () => {
    const html = renderToStaticMarkup(
      <ChatPanel
        loading={false}
        messages={[
          {
            id: "assistant-1",
            role: "assistant",
            content: "结论来自检索证据。",
            timestamp: new Date("2026-05-13T00:00:00Z"),
            evidenceRefs: [
              {
                id: "es-1",
                label: "平台治理周报",
                anchor: "hit-2",
                metaLabel: "平台治理周报 · 命中 2 · 索引 platform_docs",
                preview: "平台治理和检索体验是本周重点。",
              },
            ],
          },
        ]}
        onSendMessage={() => {}}
        recentUploadScopeState={null}
        sending={false}
        timelineEvents={[]}
      />,
    );

    expect(html).toContain("引用与产物");
    expect(html).toContain("1 条检索引用");
    expect(html).not.toContain("索引 platform_docs");
  });

  it("shows a lightweight badge on the user message that first auto-applies the recent upload scope", () => {
    const html = renderToStaticMarkup(
      <ChatPanel
        loading={false}
        messages={[
          {
            id: "user-1",
            role: "user",
            content: "总结我刚上传的资料",
            uploadScopeBadge: "最近上传已纳入本轮资料范围",
            timestamp: new Date("2026-05-13T00:00:00Z"),
          },
        ]}
        onSendMessage={() => {}}
        recentUploadScopeState={null}
        sending={false}
        timelineEvents={[]}
      />,
    );

    expect(html).toContain("最近上传已纳入本轮资料范围");
  });

  it("shows a source-scope badge for a user message using the selected thread source range", () => {
    const html = renderToStaticMarkup(
      <ChatPanel
        loading={false}
        messages={[
          {
            id: "user-1",
            role: "user",
            content: "请基于平台资料继续分析",
            sourceScopeBadge: "已使用资料范围：平台知识",
            timestamp: new Date("2026-05-13T00:00:00Z"),
          },
        ]}
        onSendMessage={() => {}}
        recentUploadScopeState={null}
        sending={false}
        timelineEvents={[]}
      />,
    );

    expect(html).toContain("已使用资料范围：平台知识");
  });

  it("shows a pending upload handoff in the center header before activation", () => {
    const html = renderToStaticMarkup(
      <ChatPanel
        loading={false}
        messages={[]}
        onSendMessage={() => {}}
        recentUploadScopeState={{
          knowledgeBaseId: "kb-personal",
          active: false,
          status: "pending",
        }}
        sending={false}
        timelineEvents={[]}
      />,
    );

    expect(html).toContain("上传完成后切入个人资料范围");
  });

  it("shows an explicit applied message after the first auto-scoped send uses the recent upload scope", () => {
    const html = renderToStaticMarkup(
      <ChatPanel
        loading={false}
        messages={[]}
        onSendMessage={() => {}}
        recentUploadScopeState={{
          knowledgeBaseId: "kb-personal",
          active: true,
          status: "applied",
        }}
        sending={false}
        timelineEvents={[]}
      />,
    );

    expect(html).toContain("最近上传已纳入本轮范围");
  });
});
