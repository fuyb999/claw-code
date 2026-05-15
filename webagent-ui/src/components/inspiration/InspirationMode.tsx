import { useMemo, useState } from "react";

import {
  buildTimelineReferenceDetail,
  type TimelineReferenceDetail as TimelineReferenceDetailModel,
  type TimelineReferenceTarget,
} from "@/lib/clawd/chat-adapter";
import { ManagementDrawer } from "@/components/management/ManagementDrawer";
import {
  expertCategory,
  expertDisplayName,
  expertDomainLabel,
} from "@/lib/clawd/expert-brainstorm";
import {
  buildExpertRunStatusLabel,
  buildSourceContextLabel,
  buildThreadTitle,
  type PendingExecutionScope,
} from "@/lib/clawd/inspiration-presentation";
import { prepareInspirationSubmission } from "@/lib/clawd/inspiration-submission";
import { buildResearchBrief } from "@/lib/clawd/research-brief";
import { buildResearchTask } from "@/lib/clawd/research-task";
import { buildSourceRailModel } from "@/lib/clawd/source-model";
import { buildTimelineEvents } from "@/lib/clawd/timeline-events";
import type { RichContent } from "@/components/rich-content/types";
import { useClawdSession } from "@/hooks/useClawdSession";
import { useExpertPanelRun } from "@/hooks/useExpertPanelRun";
import { useThreadEvents } from "@/hooks/useThreadEvents";
import { useWebAgentSession } from "@/hooks/useWebAgentSession";
import type {
  AgentConversationRecord,
  AuthSession,
  ClawdConfig,
  MessageSnapshot,
  ProjectSummary,
  RequestAuth,
  SkillSummary,
  ThreadSnapshot,
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
  onBack: () => void;
  onCloseManagement: () => void;
  onSignOut: () => void;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant" | "expert";
  content: string;
  uploadScopeBadge?: string;
  sourceScopeBadge?: string;
  expertName?: string;
  timestamp: Date;
  richContent?: RichContent;
  artifactRefs?: Array<{ id: string; label: string; anchor: string | null }>;
  evidenceRefs?: Array<{
    id: string;
    label: string;
    anchor: string | null;
    metaLabel?: string;
    preview?: string;
  }>;
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

function formatAgentConversationSubtitle(conversation: AgentConversationRecord): string {
  if (conversation.selected_data_source_ids.length) {
    return `平台资料 ${conversation.selected_data_source_ids.length} 项`;
  }
  if (conversation.selected_knowledge_base_ids.length) {
    return `资料库 ${conversation.selected_knowledge_base_ids.length} 项`;
  }
  return "WebAgent 对话";
}

function conversationStatusForDiscussion(
  status: AgentConversationRecord["status"],
): ThreadSummary["status"] {
  if (status === "interrupted") {
    return "interrupt_requested";
  }
  return status;
}

function normalizeSelectedKnowledgeBaseIds({
  executionKnowledgeBaseId,
  pendingExecutionScope,
  selectedKnowledgeBaseId,
}: {
  executionKnowledgeBaseId?: string | null;
  pendingExecutionScope: PendingExecutionScope | null;
  selectedKnowledgeBaseId: string | null;
}): string[] {
  if (pendingExecutionScope?.kind === "clear") {
    return [];
  }
  const ids = [
    executionKnowledgeBaseId ?? null,
    pendingExecutionScope?.kind === "select" ? pendingExecutionScope.knowledgeBaseId : null,
    selectedKnowledgeBaseId,
  ];
  return Array.from(new Set(ids.map((item) => item?.trim()).filter(Boolean) as string[]));
}

function mergeLiveThreadSnapshot(
  thread: ThreadSnapshot | null,
  liveDraftText: string,
  liveBlocks: ThreadSnapshot["messages"][number]["blocks"],
): ThreadSnapshot | null {
  if (!thread) {
    return null;
  }

  if (!liveDraftText && !liveBlocks.length) {
    return thread;
  }

  const messages = [...thread.messages];
  const lastAssistantIndex = [...messages]
    .map((message, index) => ({ message, index }))
    .reverse()
    .find(({ message }) => message.role === "assistant")?.index ?? -1;

  if (lastAssistantIndex >= 0 && liveBlocks.length) {
    const lastAssistant = messages[lastAssistantIndex];
    messages[lastAssistantIndex] = {
      ...lastAssistant,
      blocks: [
        ...lastAssistant.blocks.filter((block) => block.type !== "tool_use" && block.type !== "tool_result"),
        ...liveBlocks,
      ],
    } satisfies MessageSnapshot;
  }

  return {
    ...thread,
    draft_assistant_text: liveDraftText || thread.draft_assistant_text,
    messages,
  };
}

export function InspirationMode({
  auth,
  authSession,
  config,
  managementOpen,
  onBack,
  onCloseManagement,
  onSignOut,
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
    consumePendingRecentUploadScopeEvent,
    removeKnowledgeBases,
    pendingRecentUploadScopeEvent,
    projects,
    recentUploadScopeAppliedEvent,
    recentUploadScopeEvent,
    refreshSession,
    refreshSelectedThread,
    selectKnowledgeBase,
    recentUploadScopeState,
    selectedKnowledgeBaseId,
    selectedThread,
    selectedThreadId,
    sending,
    threadLoading,
    uploadFilesToPersonalSource,
    uploading,
  } = useClawdSession(auth);
  const webAgent = useWebAgentSession(auth);

  const [discussionMode, setDiscussionMode] = useState<DiscussionMode>("brainstorm");
  const [selectedExpertIds, setSelectedExpertIds] = useState<string[]>([]);
  const [retryCount, setRetryCount] = useState(1);
  const [concurrencyLimit, setConcurrencyLimit] = useState(3);
  const [autoRetrieval, setAutoRetrieval] = useState(true);
  const [pendingExecutionScope, setPendingExecutionScope] = useState<PendingExecutionScope | null>(null);
  const [selectedPlatformSourceIds, setSelectedPlatformSourceIds] = useState<string[]>([]);
  const [activeReferenceTarget, setActiveReferenceTarget] = useState<TimelineReferenceTarget | null>(null);
  const currentProject = useMemo<ProjectSummary | null>(
    () =>
      selectedThread?.project_id
        ? projects.find((item) => item.id === selectedThread.project_id) ?? null
        : projects[0] ?? null,
    [projects, selectedThread?.project_id],
  );

  const discussions = useMemo<Discussion[]>(
    () =>
      webAgent.conversations.map((conversation) => ({
        id: conversation.id,
        title: conversation.title || "未命名对话",
        timestamp: new Date(conversation.updated_at_ms),
        messageCount:
          webAgent.selectedConversationId === conversation.id
            ? webAgent.agentTurns.length
            : 0,
        status: conversationStatusForDiscussion(conversation.status),
        subtitle: formatAgentConversationSubtitle(conversation),
      })),
    [webAgent.agentTurns.length, webAgent.conversations, webAgent.selectedConversationId],
  );

  const experts = useMemo<Expert[]>(
    () =>
      expertSkills.map((skill) => {
        const id = `${skill.scope}:${skill.name}`;
        return {
          id,
          name: expertDisplayName(skill.name),
          domain: expertDomainLabel(skill.name, skill.description),
          type: expertCategory(skill.name),
          description: skill.description?.trim() || "专家协同分析",
          selected: selectedExpertIds.includes(id),
          skill,
        };
      }),
    [expertSkills, selectedExpertIds],
  );

  const sourceRailModel = useMemo(
    () =>
      buildSourceRailModel({
        dataSources,
        knowledgeBases,
        selectedKnowledgeBaseId,
        selectedPlatformSourceIds,
      }),
    [dataSources, knowledgeBases, selectedKnowledgeBaseId, selectedPlatformSourceIds],
  );

  const pendingKnowledgeBase = useMemo(
    () =>
      pendingExecutionScope?.kind === "select"
        ? knowledgeBases.find((item) => item.id === pendingExecutionScope.knowledgeBaseId) ?? null
        : null,
    [knowledgeBases, pendingExecutionScope],
  );
  const pendingScopeLabel = useMemo(() => {
    if (pendingExecutionScope?.kind === "select_platform_sources") {
      const selectedSources = sourceRailModel.platformSources.filter((source) =>
        pendingExecutionScope.dataSourceIds.includes(source.id),
      );
      if (!selectedSources.length) {
        return null;
      }
      if (selectedSources.length === 1) {
        return `${selectedSources[0].label} / 平台资料 / 1 个来源`;
      }
      return `已选平台资料 ${selectedSources.length} 项 / 平台资料 / ${selectedSources.length} 个来源`;
    }

    if (!pendingKnowledgeBase) {
      return null;
    }

    const kind = sourceRailModel.personalUploads.some(
      (source) => source.knowledgeBaseId === pendingKnowledgeBase.id,
    ) &&
      !sourceRailModel.platformSources.some(
        (source) => source.knowledgeBaseId === pendingKnowledgeBase.id,
      )
      ? "最近上传"
      : sourceRailModel.platformSources.some(
            (source) => source.knowledgeBaseId === pendingKnowledgeBase.id,
          )
        ? "平台资料"
        : "资料范围";

    return `${pendingKnowledgeBase.name} / ${kind} / ${pendingKnowledgeBase.data_source_count} 个来源`;
  }, [pendingExecutionScope, pendingKnowledgeBase, sourceRailModel.personalUploads, sourceRailModel.platformSources]);
  const threadScopeLabel = useMemo(() => {
    if (!selectedThread?.knowledge_base_id) {
      return null;
    }

    const currentScope = sourceRailModel.currentScope;
    if (currentScope?.id === selectedThread.knowledge_base_id) {
      return currentScope.scopeSummaryLabel;
    }

    const threadKnowledgeBase =
      knowledgeBases.find((item) => item.id === selectedThread.knowledge_base_id) ?? null;
    if (!threadKnowledgeBase) {
      return selectedThread.knowledge_base_name ?? null;
    }

    const kind = sourceRailModel.personalUploads.some(
      (source) => source.knowledgeBaseId === threadKnowledgeBase.id,
    ) &&
      !sourceRailModel.platformSources.some(
        (source) => source.knowledgeBaseId === threadKnowledgeBase.id,
      )
      ? "最近上传"
      : sourceRailModel.platformSources.some(
            (source) => source.knowledgeBaseId === threadKnowledgeBase.id,
          )
        ? "平台资料"
        : "资料范围";

    return `${threadKnowledgeBase.name} / ${kind} / ${threadKnowledgeBase.data_source_count} 个来源`;
  }, [
    knowledgeBases,
    selectedThread?.knowledge_base_id,
    selectedThread?.knowledge_base_name,
    sourceRailModel.currentScope,
    sourceRailModel.personalUploads,
    sourceRailModel.platformSources,
  ]);

  const selectedExperts = useMemo(
    () => experts.filter((expert) => expert.selected),
    [experts],
  );
  const hasSourceScope =
    pendingExecutionScope?.kind === "clear"
      ? false
      : Boolean(
          pendingExecutionScope?.kind === "select_platform_sources"
            ? pendingExecutionScope.dataSourceIds.length
            :
          pendingExecutionScope?.kind === "select" ||
            selectedThread?.knowledge_base_id ||
            selectedKnowledgeBaseId,
        );

  const threadEvents = useThreadEvents({
    threadId: selectedThreadId,
    auth,
    running:
      selectedThread?.status === "running" ||
      selectedThread?.status === "interrupt_requested" ||
      Boolean(selectedThread?.draft_assistant_text?.trim()),
    onThreadChanged: refreshSelectedThread,
  });

  const liveThread = useMemo(
    () =>
      mergeLiveThreadSnapshot(
        selectedThread,
        threadEvents.liveDraftText,
        threadEvents.liveBlocks,
      ),
    [selectedThread, threadEvents.liveBlocks, threadEvents.liveDraftText],
  );

  const activeReferenceDetail = useMemo<TimelineReferenceDetailModel | null>(
    () => buildTimelineReferenceDetail(liveThread, activeReferenceTarget),
    [activeReferenceTarget, liveThread],
  );
  const timelineEvents = useMemo(
    () =>
      buildTimelineEvents(
        liveThread,
        recentUploadScopeEvent,
        recentUploadScopeAppliedEvent,
      ),
    [liveThread, recentUploadScopeAppliedEvent, recentUploadScopeEvent],
  );
  const researchBrief = useMemo(
    () => buildResearchBrief(liveThread),
    [liveThread],
  );
  const researchTask = useMemo(
    () => buildResearchTask(liveThread),
    [liveThread],
  );

  const expertRun = useExpertPanelRun({
    auth,
    threadId: selectedThreadId,
    onThreadChanged: refreshSelectedThread,
  });
  const expertRunStatusLabel = useMemo(
    () => buildExpertRunStatusLabel(expertRun.activeRun, expertRun.error),
    [expertRun.activeRun, expertRun.error],
  );

  const handleSendMessage = async (content: string) => {
    const submission = prepareInspirationSubmission({
      content,
      discussionMode,
      hasSourceScope,
      autoRetrievalEnabled: autoRetrieval,
      selectedExperts,
      retryCount,
      concurrencyLimit,
      pendingExecutionScope,
      recentUploadScopeEvent: pendingRecentUploadScopeEvent,
    });

    const executionContextPayload =
      submission.kind === "chat"
        ? submission.executionContextPayload
        : {
            knowledge_base_id: submission.request.knowledge_base_id,
            data_source_ids: submission.request.data_source_ids,
            auto_retrieval: submission.request.auto_retrieval ?? autoRetrieval,
          };
    const selectedKnowledgeBaseIds = normalizeSelectedKnowledgeBaseIds({
      pendingExecutionScope,
      selectedKnowledgeBaseId,
      executionKnowledgeBaseId:
        executionContextPayload.knowledge_base_id ?? null,
    });
    const selectedDataSourceIds =
      executionContextPayload.data_source_ids ??
      (pendingExecutionScope?.kind === "select_platform_sources"
        ? pendingExecutionScope.dataSourceIds
        : []);

    await webAgent.sendMessage(submission.nextContent, {
      title: submission.nextContent.slice(0, 48),
      selectedKnowledgeBaseIds,
      selectedDataSourceIds: selectedDataSourceIds ?? [],
      selectedExpertIds:
        submission.kind === "expert_panel"
          ? submission.request.experts.map((expert) => `${expert.scope}:${expert.skill}`)
          : selectedExperts.map((expert) => expert.id),
      modelProfileId: currentProject?.id ?? null,
    });
    if (submission.kind === "chat" && submission.consumedRecentUploadScopeEvent) {
      consumePendingRecentUploadScopeEvent(
        submission.consumedRecentUploadScopeEvent.activatedAtMs,
      );
    }
    setPendingExecutionScope(null);
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
    await webAgent.createConversation({
      title: "新对话",
      selected_knowledge_base_ids: selectedKnowledgeBaseId ? [selectedKnowledgeBaseId] : [],
      selected_data_source_ids: selectedPlatformSourceIds,
      selected_expert_ids: selectedExpertIds,
      model_profile_id: currentProject?.id ?? null,
    });
  };

  const handleSelectKnowledgeBase = (knowledgeBaseId: string | null) => {
    setSelectedPlatformSourceIds([]);
    selectKnowledgeBase(knowledgeBaseId);
    setPendingExecutionScope(
      knowledgeBaseId
        ? { kind: "select", knowledgeBaseId }
        : { kind: "clear" },
    );
  };

  const handleTogglePlatformSource = (dataSourceId: string) => {
    setSelectedPlatformSourceIds((current) => {
      const next = current.includes(dataSourceId)
        ? current.filter((item) => item !== dataSourceId)
        : [...current, dataSourceId];
      setPendingExecutionScope(
        next.length ? { kind: "select_platform_sources", dataSourceIds: next } : null,
      );
      return next;
    });
  };

  return (
    <div className="flex h-full min-h-0 flex-col overflow-hidden">
      <div className="flex min-h-0 flex-1 overflow-hidden">
        <div className="flex shrink-0">
          <HistoryPanel
            loading={loading}
            recentUploadScopeState={recentUploadScopeState}
            sourceModel={sourceRailModel}
            uploading={uploading}
            selectedKnowledgeBaseId={selectedKnowledgeBaseId}
            selectedPlatformSourceIds={selectedPlatformSourceIds}
            onSelectKnowledgeBase={handleSelectKnowledgeBase}
            onTogglePlatformSource={handleTogglePlatformSource}
            onUploadFiles={handleUploadFiles}
          />
        </div>

        <div className="relative flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden">
          <ChatPanel
            agentTurns={webAgent.agentTurns}
            discussions={discussions}
            error={webAgent.error ?? error}
            isPlatformAdmin={authSession.is_platform_admin}
            loading={webAgent.loading || loading || threadLoading}
            messages={[]}
            onCreateDiscussion={handleCreateDiscussion}
            onDeleteDiscussion={webAgent.deleteConversation}
            onInterrupt={async () => {
              await webAgent.interruptCurrentRun();
            }}
            onOpenReference={(target) => setActiveReferenceTarget(target)}
            onSelectDiscussion={(conversationId) => {
              void webAgent.selectConversation(conversationId);
            }}
            onSendMessage={handleSendMessage}
            recentUploadScopeState={recentUploadScopeState}
            selectedDiscussionId={webAgent.selectedConversationId}
            sending={webAgent.sending || sending}
            expertRunLabel={
              webAgent.sending
                ? "专家与资料检索会逐步进入当前回答。"
                : null
            }
            researchBrief={researchBrief}
            researchTask={researchTask}
            sourceContextLabel={
              buildSourceContextLabel({
                pendingScope: pendingExecutionScope,
                pendingScopeLabel,
                threadScopeLabel,
                activeScopeLabel: sourceRailModel.currentScope?.scopeSummaryLabel ?? null,
              })
            }
            threadEventsConnected={threadEvents.connected}
            threadSnapshot={liveThread}
            threadTitle={buildThreadTitle(selectedThread?.topic)}
            timelineEvents={timelineEvents}
          />
        </div>

        <div className="flex shrink-0">
          <ExpertPanel
            autoRetrieval={autoRetrieval}
            concurrencyLimit={concurrencyLimit}
            discussionMode={discussionMode}
            experts={experts}
            retryCount={retryCount}
            runStatusLabel={expertRunStatusLabel}
            onAutoRetrievalChange={setAutoRetrieval}
            onConcurrencyLimitChange={(value) => setConcurrencyLimit(Math.min(8, Math.max(1, value || 1)))}
            onModeChange={setDiscussionMode}
            onRetryCountChange={(value) => setRetryCount(Math.min(3, Math.max(0, value || 0)))}
            onToggleExpert={handleToggleExpert}
          />
        </div>
      </div>

      <TimelineReferenceDetail
        detail={activeReferenceDetail}
        onClose={() => setActiveReferenceTarget(null)}
      />
          <ManagementDrawer
            auth={auth}
            authSession={authSession}
            currentProject={currentProject}
            projects={projects}
            dataSources={dataSources}
            expertSkills={expertSkills}
            isOpen={managementOpen}
            knowledgeBases={knowledgeBases}
        onClose={onCloseManagement}
        onDeleteKnowledgeBases={removeKnowledgeBases}
        onSourcesChanged={refreshSession}
      />
    </div>
  );
}
