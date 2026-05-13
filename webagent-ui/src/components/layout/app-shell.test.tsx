import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { ChatPanel } from "../inspiration/ChatPanel";
import { HistoryPanel } from "../inspiration/HistoryPanel";
import { InspirationMode } from "../inspiration/InspirationMode";
import { AppShell } from "./AppShell";

describe("AppShell", () => {
  it("renders a service access gate before the workspace", () => {
    const html = renderToStaticMarkup(
      <AppShell
        onBackToEntry={() => {}}
        onModeSelect={() => {}}
        onSwitchToInspiration={() => {}}
      />,
    );

    expect(html).toContain("服务接入");
    expect(html).not.toContain("上下文");
    expect(html).not.toContain("活动流");
  });
});

describe("InspirationMode", () => {
  it("shows the collapsed timeline control when more than three events exist", () => {
    const html = renderToStaticMarkup(
      <ChatPanel
        messages={[]}
        onSendMessage={() => {}}
        timelineEvents={[
          {
            id: "event-1",
            kind: "user_question",
            title: "用户问题",
            subtitle: "问题 1",
            atMs: 1,
            reference: null,
          },
          {
            id: "event-2",
            kind: "retrieval",
            title: "检索资料",
            subtitle: "问题 2",
            atMs: 2,
            reference: null,
          },
          {
            id: "event-3",
            kind: "execution_scope",
            title: "本次使用资料范围",
            subtitle: "范围 3",
            atMs: 3,
            reference: null,
          },
          {
            id: "event-4",
            kind: "retrieval_policy",
            title: "自动检索已开启",
            subtitle: "策略 4",
            atMs: 4,
            reference: null,
          },
        ]}
      />,
    );

    expect(html).toContain("时间线");
    expect(html).toContain("展开时间线");
    expect(html).not.toContain("收起时间线");
    expect(html).toContain("本次使用资料范围");
    expect(html).toContain("自动检索已开启");
    expect(html).not.toContain("用户问题");
  });

  it("keeps the single web agent workspace without research-os primary modes", () => {
    const html = renderToStaticMarkup(
      <InspirationMode
        auth={{ userId: "test-user" }}
        authSession={{
          auth_mode: "dev_user_header",
          tenant_id: null,
          user_id: "test-user",
          api_key_id: null,
          api_key_prefix: null,
          display_name: null,
        }}
        config={{
          database_backend: "sqlite",
          database_schema_version: 1,
          default_model: "gpt-test",
          default_permission_mode: "read-only",
          run_timeout_secs: null,
          max_threads_per_user: null,
          max_threads_per_tenant: null,
          max_concurrent_runs_global: null,
          max_concurrent_runs_per_tenant: null,
          max_concurrent_runs_per_user: null,
          max_mutation_requests_per_minute_global: null,
          max_mutation_requests_per_minute_per_tenant: null,
          max_mutation_requests_per_minute_per_user: null,
          api_key_auth_enabled: true,
          dev_user_header_auth_enabled: true,
        }}
        onBack={() => {}}
        onCloseManagement={() => {}}
        onCloseModelSettings={() => {}}
        onSignOut={() => {}}
        managementOpen={false}
        modelSettingsOpen={false}
      />,
    );

    expect(html).toContain("对话历史");
    expect(html).toContain("虚拟专家");
    expect(html).toContain("工作台");
    expect(html).toContain("我的上传");
    expect(html).toContain("平台资料源");
    expect(html).toContain("当前资料范围");
    expect(html).toContain("下一条消息或专家会诊将使用这里选择的资料范围。");
    expect(html).toContain("时间线");
    expect(html).toContain("自动检索");
    expect(html).not.toContain("上下文");
    expect(html).not.toContain("活动流");
    expect(html).not.toContain("数据驱动");
    expect(html).not.toContain("任务驱动");
    expect(html).not.toContain("分屏预设");
    expect(html).not.toContain("转为任务");
    expect(html).not.toContain("结果面板");
    expect(html).not.toContain("证据面板");
    expect(html).not.toContain("Workbench");
    expect(html).not.toContain("workspace_root");
    expect(html).not.toContain("endpoint");
    expect(html).not.toContain("index_name");
  });

  it("renders source rows without exposing backend connection fields", () => {
    const html = renderToStaticMarkup(
      <HistoryPanel
        discussions={[]}
        loading={false}
        onCreateDiscussion={() => {}}
        onSelectDiscussion={() => {}}
        onSelectKnowledgeBase={() => {}}
        onUploadFiles={async () => {}}
        selectedDiscussionId={null}
        selectedKnowledgeBaseId="kb-platform"
        sourceModel={{
          currentScope: {
            id: "kb-platform",
            label: "平台知识",
            dataSourceCount: 2,
          },
          favorites: [],
          personalUploads: [
            {
              id: "upload-1",
              knowledgeBaseId: "kb-personal",
              label: "市场资料包",
              description: null,
              kind: "upload",
              kindLabel: "我的上传",
              status: "ready",
              searchable: true,
              fileCount: 2,
              leadFileName: "market.pdf",
              lastSyncedAtMs: null,
            },
          ],
          platformSources: [
            {
              id: "es-1",
              knowledgeBaseId: "kb-platform",
              label: "政策资料库",
              description: null,
              kind: "es",
              kindLabel: "平台检索",
              status: "ready",
              searchable: true,
              fileCount: 0,
              leadFileName: null,
              lastSyncedAtMs: null,
            },
          ],
        }}
        threadGroups={[]}
        uploading={false}
      />,
    );

    expect(html).toContain("市场资料包");
    expect(html).toContain("政策资料库");
    expect(html).toContain("点击来源会切换资料范围，用于下一条消息或专家会诊。");
    expect(html).not.toContain("endpoint");
    expect(html).not.toContain("index_name");
    expect(html).not.toContain("internal-es");
  });

  it("shows low-frequency settings as summaries rather than an admin console", () => {
    const html = renderToStaticMarkup(
      <InspirationMode
        auth={{ userId: "test-user" }}
        authSession={{
          auth_mode: "dev_user_header",
          tenant_id: null,
          user_id: "test-user",
          api_key_id: null,
          api_key_prefix: null,
          display_name: null,
        }}
        config={{
          database_backend: "sqlite",
          database_schema_version: 1,
          default_model: "gpt-test",
          default_permission_mode: "read-only",
          run_timeout_secs: null,
          max_threads_per_user: null,
          max_threads_per_tenant: null,
          max_concurrent_runs_global: null,
          max_concurrent_runs_per_tenant: null,
          max_concurrent_runs_per_user: null,
          max_mutation_requests_per_minute_global: null,
          max_mutation_requests_per_minute_per_tenant: null,
          max_mutation_requests_per_minute_per_user: null,
          api_key_auth_enabled: true,
          dev_user_header_auth_enabled: true,
        }}
        onBack={() => {}}
        onCloseManagement={() => {}}
        onCloseModelSettings={() => {}}
        onSignOut={() => {}}
        managementOpen={true}
        modelSettingsOpen={false}
      />,
    );

    expect(html).toContain("工作区设置");
    expect(html).toContain("资料与专家摘要");
    expect(html).not.toContain("管理抽屉");
    expect(html).not.toContain("ES 连接");
    expect(html).not.toContain("endpoint");
  });
});
