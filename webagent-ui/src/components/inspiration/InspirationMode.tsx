import { useEffect, useMemo, useState } from "react";

import {
  fetchProviderModels,
} from "@/lib/clawd/api";
import {
  type BrowserModelConfig,
  type BrowserModelDiscoveryState,
} from "@/lib/clawd/browser-model";
import {
  buildTimelineReferenceDetail,
  type InspirationTimelineMessage,
  mapThreadToChatMessages,
  type TimelineReferenceDetail as TimelineReferenceDetailModel,
  type TimelineReferenceTarget,
} from "@/lib/clawd/chat-adapter";
import { ManagementDrawer } from "@/components/management/ManagementDrawer";
import { ModelDrawer } from "@/components/management/ModelDrawer";
import { expertDisplayName } from "@/lib/clawd/expert-brainstorm";
import { buildExpertRunRequest } from "@/lib/clawd/expert-runs";
import { buildSourceRailModel } from "@/lib/clawd/source-model";
import { groupThreadsByProject } from "@/lib/clawd/thread-groups";
import type { RichContent } from "@/components/rich-content/types";
import { useClawdSession } from "@/hooks/useClawdSession";
import { useExpertPanelRun } from "@/hooks/useExpertPanelRun";
import { useThreadEvents } from "@/hooks/useThreadEvents";
import type {
  AuthSession,
  ClawdConfig,
  RequestAuth,
  SkillSummary,
  ThreadSummary,
} from "@/lib/clawd/types";

import { ChatPanel } from "./ChatPanel";
import { ExpertPanel } from "./ExpertPanel";
import { HistoryPanel } from "./HistoryPanel";
import { TimelineReferenceDetail } from "./TimelineReferenceDetail";

interface InspirationModeProps {
  auth: RequestAuth;
  authSession: AuthSession;
  config: ClawdConfig;
  managementOpen: boolean;
  modelSettingsOpen: boolean;
  onBack: () => void;
  onCloseManagement: () => void;
  onCloseModelSettings: () => void;
  onSignOut: () => void;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "expert";
  content: string;
  expertName?: string;
  timestamp: Date;
  richContent?: RichContent;
  artifactRefs?: Array<{ id: string; label: string; anchor: string | null }>;
  evidenceRefs?: Array<{ id: string; label: string; anchor: string | null }>;
  aiAnalystStage?: "ideation" | "retrieval" | "writing" | "synthesis" | null;
}

export interface Expert {
  id: string;
  name: string;
  domain: string;
  type: string;
  description: string;
  selected: boolean;
  skill: SkillSummary;
}

export interface Discussion {
  id: string;
  title: string;
  timestamp: Date;
  messageCount: number;
  status: ThreadSummary["status"];
  subtitle: string;
}

export type DiscussionMode = "qa" | "brainstorm";

function formatThreadTitle(thread: ThreadSummary): string {
  return thread.topic?.trim() || "未命名会话";
}

function formatThreadSubtitle(thread: ThreadSummary): string {
  return thread.project_name ?? thread.knowledge_base_name ?? "个人对话";
}

function inferExpertType(skill: SkillSummary): string {
  const tags = skill.tags.map((tag) => tag.trim().toLowerCase());

  if (tags.includes("realism")) {
    return "现实主义";
  }
  if (tags.includes("liberalism")) {
    return "自由主义";
  }
  if (tags.includes("methodology")) {
    return "方法论";
  }

  return "专家视角";
}

function inferExpertDomain(skill: SkillSummary): string {
  const description = skill.description?.trim();
  if (!description) {
    return "综合分析";
  }

  return description.length > 14 ? `${description.slice(0, 14)}...` : description;
}

export function InspirationMode({
  auth,
  authSession,
  config,
  managementOpen,
  onBack,
  onCloseManagement,
  onCloseModelSettings,
  onSignOut,
  modelSettingsOpen,
}: InspirationModeProps) {
  void onBack;
  void authSession;
  void config;
  void onSignOut;

  const {
    dataSources,
    error,
    expertSkills,
    knowledgeBases,
    loading,
    createEmptyThread,
    refreshSelectedThread,
    selectKnowledgeBase,
    selectThread,
    selectedKnowledgeBaseId,
    selectedThread,
    selectedThreadId,
    sendUserMessage,
    sending,
    threadLoading,
    threads,
    uploadFilesToPersonalSource,
    uploading,
  } = useClawdSession(auth);

  const [discussionMode, setDiscussionMode] = useState<DiscussionMode>("brainstorm");
  const [selectedExpertIds, setSelectedExpertIds] = useState<string[]>([]);
  const [retryCount, setRetryCount] = useState(1);
  const [concurrencyLimit, setConcurrencyLimit] = useState(3);
  const [activeReferenceTarget, setActiveReferenceTarget] = useState<TimelineReferenceTarget | null>(null);
  const [browserModelConfig, setBrowserModelConfig] = useState<BrowserModelConfig>({
    baseUrl: "",
    apiKey: "",
    modelName: "",
  });
  const [discoveredModels, setDiscoveredModels] = useState<
    Array<{ id: string; label: string; owner: string | null }>
  >([]);
  const [modelDiscoveryState, setModelDiscoveryState] = useState<BrowserModelDiscoveryState>("idle");
  const [modelDiscoveryMessage, setModelDiscoveryMessage] = useState<string | null>(null);

  const threadGroups = useMemo(() => groupThreadsByProject(threads, []), [threads]);

  const discussions = useMemo<Discussion[]>(
    () =>
      threads.map((thread) => ({
        id: thread.id,
        title: formatThreadTitle(thread),
        timestamp: new Date(thread.updated_at_ms),
        messageCount: selectedThread?.id === thread.id ? selectedThread.messages.length : 0,
        status: thread.status,
        subtitle: formatThreadSubtitle(thread),
      })),
    [selectedThread, threads],
  );

  const experts = useMemo<Expert[]>(
    () =>
      expertSkills.map((skill) => {
        const id = `${skill.scope}:${skill.name}`;
        return {
          id,
          name: expertDisplayName(skill.name),
          domain: inferExpertDomain(skill),
          type: inferExpertType(skill),
          description: skill.description?.trim() || "专家协同分析",
          selected: selectedExpertIds.includes(id),
          skill,
        };
      }),
    [expertSkills, selectedExpertIds],
  );

  const messages = useMemo<ChatMessage[]>(
    () => mapThreadToChatMessages(selectedThread) as InspirationTimelineMessage[],
    [selectedThread],
  );

  const activeReferenceDetail = useMemo<TimelineReferenceDetailModel | null>(
    () => buildTimelineReferenceDetail(selectedThread, activeReferenceTarget),
    [activeReferenceTarget, selectedThread],
  );

  const sourceRailModel = useMemo(
    () =>
      buildSourceRailModel({
        dataSources,
        knowledgeBases,
        selectedKnowledgeBaseId,
      }),
    [dataSources, knowledgeBases, selectedKnowledgeBaseId],
  );

  const activeKnowledgeBase = useMemo(
    () => knowledgeBases.find((item) => item.id === selectedKnowledgeBaseId) ?? null,
    [knowledgeBases, selectedKnowledgeBaseId],
  );

  const selectedExperts = useMemo(
    () => experts.filter((expert) => expert.selected),
    [experts],
  );

  useThreadEvents({
    threadId: selectedThreadId,
    auth,
    onThreadChanged: refreshSelectedThread,
  });

  const expertRun = useExpertPanelRun({
    auth,
    threadId: selectedThreadId,
    onThreadChanged: refreshSelectedThread,
  });

  const handleSendMessage = async (content: string) => {
    if (discussionMode === "brainstorm" && selectedExperts.length > 0) {
      let threadId = selectedThreadId;
      if (!threadId) {
        const snapshot = await createEmptyThread(content, browserModelConfig);
        threadId = snapshot.id;
      }
      await expertRun.start(
        buildExpertRunRequest({
          question: content,
          experts: selectedExperts.map((expert) => ({
            skill: expert.skill.name,
            scope: expert.skill.scope,
            label: expert.name,
            description: expert.description,
          })),
          retryCount,
          concurrencyLimit,
        }),
        threadId,
      );
      return;
    }

    await sendUserMessage(content);
  };

  const handleToggleExpert = (id: string) => {
    setSelectedExpertIds((current) =>
      current.includes(id)
        ? current.filter((entry) => entry !== id)
        : [...current, id],
    );
  };

  const handleUploadFiles = async (files: File[]) => {
    await uploadFilesToPersonalSource(files);
  };

  const handleCreateDiscussion = async () => {
    await createEmptyThread(undefined, browserModelConfig);
  };

  const handleResetBrowserModel = () => {
    setBrowserModelConfig({
      baseUrl: "",
      apiKey: "",
      modelName: "",
    });
    setDiscoveredModels([]);
    setModelDiscoveryState("idle");
    setModelDiscoveryMessage(null);
  };

  useEffect(() => {
    const baseUrl = browserModelConfig.baseUrl.trim();
    const apiKey = browserModelConfig.apiKey.trim();
    if (!modelSettingsOpen || !baseUrl || !apiKey) {
      return;
    }

    let cancelled = false;
    setModelDiscoveryState("loading");
    setModelDiscoveryMessage("正在读取模型列表…");

    void fetchProviderModels(baseUrl, apiKey)
      .then((items) => {
        if (cancelled) {
          return;
        }
        setDiscoveredModels(items);
        setModelDiscoveryState("ready");
        setModelDiscoveryMessage(`已读取 ${items.length} 个模型`);
      })
      .catch((error: unknown) => {
        if (cancelled) {
          return;
        }
        setDiscoveredModels([]);
        setModelDiscoveryState("error");
        setModelDiscoveryMessage(
          error instanceof Error ? error.message : "模型列表读取失败。",
        );
      });

    return () => {
      cancelled = true;
    };
  }, [
    browserModelConfig.apiKey,
    browserModelConfig.baseUrl,
    modelSettingsOpen,
  ]);

  return (
    <div className="h-full flex flex-col animate-fade-in">
      <div className="flex-1 flex overflow-hidden">
        <HistoryPanel
          discussions={discussions}
          loading={loading}
          sourceModel={sourceRailModel}
          uploading={uploading}
          selectedKnowledgeBaseId={selectedKnowledgeBaseId}
          selectedDiscussionId={selectedThreadId}
          threadGroups={threadGroups.map((group) => ({
            id: group.filterKey,
            label: group.label,
            count: group.threadCount,
          }))}
          onCreateDiscussion={handleCreateDiscussion}
          onSelectKnowledgeBase={selectKnowledgeBase}
          onSelectDiscussion={selectThread}
          onUploadFiles={handleUploadFiles}
        />

        <ChatPanel
          activeReferenceDetail={activeReferenceDetail}
          error={error}
          loading={loading || threadLoading}
          messages={messages}
          onCloseReferenceDetail={() => setActiveReferenceTarget(null)}
          onOpenReference={(target) => setActiveReferenceTarget(target)}
          onSendMessage={handleSendMessage}
          sending={sending || expertRun.running}
          expertRunLabel={
            expertRun.running
              ? "多专家会诊进行中，完成的专家会逐步进入聊天流。"
              : null
          }
          sourceContextLabel={
            selectedThread?.knowledge_base_name
              ? `当前连接资料空间：${selectedThread.knowledge_base_name}`
              : activeKnowledgeBase
                ? `下一次新建会话将连接：${activeKnowledgeBase.name}`
                : null
          }
          threadTitle={selectedThread?.topic?.trim() || "灵感工作台"}
        />

        <ExpertPanel
          concurrencyLimit={concurrencyLimit}
          discussionMode={discussionMode}
          experts={experts}
          retryCount={retryCount}
          runStatusLabel={
            expertRun.running
              ? `专家会诊运行中 · ${
                  expertRun.activeRun?.experts.filter((item) => item.status === "succeeded").length ?? 0
                }/${expertRun.activeRun?.experts.length ?? 0}`
              : expertRun.error
                ? expertRun.error
                : null
          }
          onConcurrencyLimitChange={(value) => setConcurrencyLimit(Math.min(8, Math.max(1, value || 1)))}
          onModeChange={setDiscussionMode}
          onRetryCountChange={(value) => setRetryCount(Math.min(3, Math.max(0, value || 0)))}
          onToggleExpert={handleToggleExpert}
        />
      </div>

      <TimelineReferenceDetail
        detail={activeReferenceDetail}
        onClose={() => setActiveReferenceTarget(null)}
      />
      <ModelDrawer
        config={browserModelConfig}
        discoveredModels={discoveredModels}
        discoveryMessage={modelDiscoveryMessage}
        discoveryState={modelDiscoveryState}
        isOpen={modelSettingsOpen}
        onApiKeyChange={(value) => {
          setBrowserModelConfig((current) => ({ ...current, apiKey: value }));
          setModelDiscoveryState("idle");
        }}
        onBaseUrlChange={(value) => {
          setBrowserModelConfig((current) => ({ ...current, baseUrl: value }));
          setModelDiscoveryState("idle");
        }}
        onClose={onCloseModelSettings}
        onModelNameChange={(value) =>
          setBrowserModelConfig((current) => ({ ...current, modelName: value }))
        }
        onReset={handleResetBrowserModel}
      />
      <ManagementDrawer
        dataSources={dataSources}
        expertSkills={expertSkills}
        isOpen={managementOpen}
        knowledgeBases={knowledgeBases}
        onClose={onCloseManagement}
      />
    </div>
  );
}
