import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import {
  AssistantRuntimeProvider,
  ThreadPrimitive,
  useExternalStoreRuntime,
  type AppendMessage,
  type ThreadMessageLike,
} from "@assistant-ui/react";
import {
  ChevronDown,
  Plus,
  Trash2,
} from "lucide-react";

import { Button } from "@/components/ui/button";
import type { TimelineReferenceTarget } from "@/lib/clawd/chat-adapter";
import type { AgentTurnRecord } from "@/lib/clawd/agent-turns";
import { groupTurnsByDisplayDate } from "@/lib/clawd/agent-turns";
import type { ResearchBrief } from "@/lib/clawd/research-brief";
import type { ResearchTask } from "@/lib/clawd/research-task";
import type { ThreadSnapshot } from "@/lib/clawd/types";
import type {
  ExpertPanelRunEventEnvelope,
  ExpertPanelRunResponse,
} from "@/lib/clawd/types";
import type { TimelineEvent } from "@/lib/clawd/timeline-events";
import type { RecentUploadScopeState } from "@/lib/clawd/upload-scope-state";

import { ConversationComposer } from "./ConversationComposer";
import { AgentTurnTimelineRail } from "./AgentTurnTimelineRail";
import { AgentTurnView } from "./AgentTurnView";
import { RuntimeMessageBubble } from "./RuntimeMessageBubble";
import {
  buildComposerQuickActions,
  countConfirmedUserMessages,
  hiddenMessageCount as deriveHiddenMessageCount,
  normalizedMessageKey,
  removeConfirmedPendingMessages,
  runtimeMessagesFromConversation,
  visibleMessageLimit as deriveVisibleMessageLimit,
  type ConversationDiscussion,
  type ConversationMessage,
  type PendingMessage,
} from "./conversation-model";

export type {
  ConversationDiscussion,
  ConversationMessage,
} from "./conversation-model";

export interface ConversationStageProps {
  agentTurns?: AgentTurnRecord[];
  isPlatformAdmin?: boolean;
  messages: ConversationMessage[];
  discussions?: ConversationDiscussion[];
  selectedDiscussionId?: string | null;
  onSendMessage: (content: string) => Promise<void> | void;
  onInterrupt?: () => Promise<void> | void;
  onCreateDiscussion?: () => Promise<void> | void;
  onDeleteDiscussion?: (discussionId: string) => Promise<void> | void;
  onSelectDiscussion?: (discussionId: string) => void;
  sending?: boolean;
  loading?: boolean;
  error?: string | null;
  sourceContextLabel?: string | null;
  threadEventsConnected?: boolean;
  recentUploadScopeState?: RecentUploadScopeState | null;
  expertRunLabel?: string | null;
  expertRun?: ExpertPanelRunResponse | null;
  expertRunEvents?: ExpertPanelRunEventEnvelope[];
  researchBrief?: ResearchBrief | null;
  researchTask?: ResearchTask | null;
  threadTitle?: string;
  threadSnapshot?: ThreadSnapshot | null;
  timelineEvents?: TimelineEvent[];
  onOpenReference?: (target: TimelineReferenceTarget) => void;
}

function formatDiscussionTimestamp(timestamp: Date): string {
  return timestamp.toLocaleDateString("zh-CN", {
    month: "numeric",
    day: "numeric",
  });
}

function formatDiscussionStatusLabel(status: ConversationDiscussion["status"]): string {
  switch (status) {
    case "running":
      return "进行中";
    case "interrupt_requested":
      return "中断中";
    case "failed":
      return "失败";
    default:
      return "已完成";
  }
}

function formatDiscussionTime(timestamp: Date): string {
  return timestamp.toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

function groupDiscussions(discussions: ConversationDiscussion[]) {
  return {
    active: discussions.filter(
      (discussion) =>
        discussion.status === "running" || discussion.status === "interrupt_requested",
    ),
    recent: discussions.filter((discussion) => discussion.status === "idle").slice(0, 8),
    completed: discussions.filter((discussion) => discussion.status === "failed").concat(
      discussions.filter((discussion) => discussion.status !== "running" && discussion.status !== "interrupt_requested" && discussion.status !== "idle"),
    ),
  };
}

function appendMessageToText(message: AppendMessage): string {
  return message.content
    .map((part) => {
      if (part.type === "text") {
        return part.text;
      }
      if (part.type === "data") {
        return JSON.stringify(part.data, null, 2);
      }
      return "";
    })
    .join("\n")
    .trim();
}

function scrollElementToBottom(element: HTMLElement, behavior: ScrollBehavior = "smooth") {
  if (typeof element.scrollTo === "function") {
    element.scrollTo({
      top: element.scrollHeight,
      behavior,
    });
    return;
  }

  element.scrollTop = element.scrollHeight;
}

function ConversationRuntime({
  children,
  messages,
  onSubmit,
  runtimeKey,
}: {
  children: ReactNode;
  messages: ThreadMessageLike[];
  onSubmit: (content: string) => Promise<void>;
  runtimeKey: string;
}) {
  const runtime = useExternalStoreRuntime({
    isRunning: false,
    messages,
    convertMessage: (message) => message,
    adapters: {
      threadList: {
        threadId: runtimeKey,
        threads: [
          {
            id: runtimeKey,
            status: "regular",
          },
        ],
      },
    },
    onNew: async (message) => {
      const text = appendMessageToText(message);
      if (!text) {
        return;
      }
      await onSubmit(text);
    },
  });

  return (
    <AssistantRuntimeProvider key={runtimeKey} runtime={runtime}>
      {children}
    </AssistantRuntimeProvider>
  );
}

export function ConversationStage({
  discussions = [],
  error = null,
  loading = false,
  messages,
  onCreateDiscussion,
  onDeleteDiscussion,
  onInterrupt,
  onOpenReference,
  onSelectDiscussion,
  onSendMessage,
  recentUploadScopeState = null,
  selectedDiscussionId = null,
  sending = false,
  sourceContextLabel = null,
  threadEventsConnected = false,
  expertRunLabel = null,
  expertRun = null,
  expertRunEvents = [],
  agentTurns = [],
  isPlatformAdmin = false,
  researchBrief = null,
  researchTask = null,
  threadSnapshot = null,
  threadTitle = "灵感工作台",
  timelineEvents = [],
}: ConversationStageProps) {
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [messageHistoryExpanded, setMessageHistoryExpanded] = useState(false);
  const [sessionSwitcherOpen, setSessionSwitcherOpen] = useState(false);
  const [sessionSearch, setSessionSearch] = useState("");
  const [pendingMessages, setPendingMessages] = useState<PendingMessage[]>([]);
  const [localSubmitting, setLocalSubmitting] = useState(false);
  const pendingNonceRef = useRef(0);
  const submitLockRef = useRef(false);
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const sessionSwitcherRef = useRef<HTMLDivElement | null>(null);
  const nearBottomRef = useRef(true);
  const [showJumpToBottom, setShowJumpToBottom] = useState(false);
  const confirmedUserMessageCountRef = useRef<Map<string, number>>(new Map());

  const running =
    agentTurns.some((turn) => turn.status === "running" || turn.status === "queued") ||
    threadSnapshot?.status === "running" ||
    threadSnapshot?.status === "interrupt_requested" ||
    Boolean(threadSnapshot?.draft_assistant_text?.trim());
  const isSubmitBusy = running || sending || localSubmitting || submitLockRef.current;

  const queueContent = useCallback((content: string) => {
    const trimmed = content.trim();
    if (!trimmed) {
      return;
    }

    const id = `pending-${Date.now()}-${pendingNonceRef.current++}`;
    setPendingMessages((current) => [
      ...current,
      { id, content: trimmed, status: "queued" },
    ]);
  }, []);

  const submitContentNow = useCallback(
    async (content: string) => {
      const trimmed = content.trim();
      if (!trimmed || submitLockRef.current) {
        return;
      }

      const messageKey = normalizedMessageKey(trimmed);
      const existingSendingMessage = pendingMessages.some(
        (item) =>
          item.status === "sending" &&
          normalizedMessageKey(item.content) === messageKey,
      );
      if (existingSendingMessage) {
        return;
      }

      const id = `pending-${Date.now()}-${pendingNonceRef.current++}`;
      const pending: PendingMessage = { id, content: trimmed, status: "sending" };
      submitLockRef.current = true;
      setLocalSubmitting(true);
      setPendingMessages((current) => [...current, pending]);

      try {
        await onSendMessage(trimmed);
      } catch {
        setPendingMessages((current) =>
          current.map((item) =>
            item.id === id ? { ...item, status: "failed" } : item,
          ),
        );
      } finally {
        submitLockRef.current = false;
        setLocalSubmitting(false);
      }
    },
    [onSendMessage, pendingMessages],
  );

  const submitContent = useCallback(
    async (content: string) => {
      const trimmed = content.trim();
      if (!trimmed) {
        return;
      }

      if (isSubmitBusy) {
        queueContent(trimmed);
        return;
      }

      await submitContentNow(trimmed);
    },
    [isSubmitBusy, queueContent, submitContentNow],
  );

  const retryPending = useCallback(
    (pending: PendingMessage) => {
      setPendingMessages((current) => current.filter((item) => item.id !== pending.id));
      void submitContentNow(pending.content);
    },
    [submitContentNow],
  );

  const jumpToAgentTurn = useCallback((turnId: string) => {
    const target = Array.from(
      viewportRef.current?.querySelectorAll<HTMLElement>(
        "[data-agent-turn-question-id]",
      ) ?? [],
    ).find((item) => item.dataset.agentTurnQuestionId === turnId);
    if (!target) {
      return;
    }

    nearBottomRef.current = false;
    setShowJumpToBottom(true);
    target.scrollIntoView({
      behavior: "smooth",
      block: "center",
    });
  }, []);

  const handleCopy = useCallback((id: string, content: string) => {
    void navigator.clipboard.writeText(content);
    setCopiedId(id);
    window.setTimeout(() => setCopiedId(null), 2000);
  }, []);

  const handleDownload = useCallback((content: string, expertName?: string) => {
    const blob = new Blob([content], { type: "text/markdown" });
    const url = URL.createObjectURL(blob);
    const anchor = document.createElement("a");
    anchor.href = url;
    anchor.download = `${expertName || threadTitle}_${new Date().toLocaleDateString("zh-CN")}.md`;
    anchor.click();
    URL.revokeObjectURL(url);
  }, [threadTitle]);

  const hasAgentTurnPath = agentTurns.length > 0;
  const connectionLabel = loading
    ? "正在同步对话..."
    : sending
      ? "执行已提交，等待结果返回"
      : running
        ? threadEventsConnected
          ? "正在生成回复，内容会持续进入时间线"
          : "正在生成回复，实时连接重试中"
        : hasAgentTurnPath
          ? "对话已同步，可继续提问"
          : threadEventsConnected
          ? "对话已连接，可继续提问"
          : "对话连接中断，正在等待下一次同步";
  const showSessionControls = Boolean(onCreateDiscussion || onSelectDiscussion || discussions.length);
  const activeDiscussion = useMemo(
    () =>
      discussions.find((discussion) => discussion.id === selectedDiscussionId) ??
      discussions[0] ??
      null,
    [discussions, selectedDiscussionId],
  );
  const filteredDiscussions = useMemo(() => {
    const query = sessionSearch.trim().toLowerCase();
    if (!query) {
      return discussions;
    }

    return discussions.filter((discussion) => {
      const haystack = `${discussion.title} ${discussion.subtitle}`.toLowerCase();
      return haystack.includes(query);
    });
  }, [discussions, sessionSearch]);
  const groupedDiscussions = useMemo(
    () => groupDiscussions(filteredDiscussions),
    [filteredDiscussions],
  );
  const groupedAllDiscussions = useMemo(
    () => groupDiscussions(discussions),
    [discussions],
  );
  const latestFailedPending = useMemo(
    () =>
      [...pendingMessages]
        .reverse()
        .find((item) => item.status === "failed") ?? null,
    [pendingMessages],
  );
  const queuedMessages = useMemo(
    () => pendingMessages.filter((item) => item.status === "queued"),
    [pendingMessages],
  );
  const composerQuickActions = useMemo(
    () =>
      latestFailedPending
        ? []
        : buildComposerQuickActions({
            researchBrief,
            researchTask,
          }),
    [latestFailedPending, researchBrief, researchTask],
  );
  const visibleMessageLimit = deriveVisibleMessageLimit({
    expanded: messageHistoryExpanded,
    messageCount: messages.length,
  });
  const hasSummaryContent = Boolean(
    researchBrief || researchTask || timelineEvents.length || recentUploadScopeState || expertRunLabel,
  );
  const taskSummaryTitle =
    researchTask?.nextRecommendedAction ??
    researchBrief?.handoffLabel ??
    connectionLabel;
  const taskSummaryMeta = [
    researchBrief ? `问题 ${researchBrief.questionCount}` : null,
    researchBrief ? `检索 ${researchBrief.retrievalCount}` : null,
    researchBrief ? `专家 ${researchBrief.expertCount}` : null,
    researchBrief ? `产物 ${researchBrief.artifactCount}` : null,
    timelineEvents.length ? `时间线 ${timelineEvents.length}` : null,
    sourceContextLabel?.replace("当前会话", "当前对话") ?? null,
    recentUploadScopeState
      ? recentUploadScopeState.status === "pending"
        ? "上传完成后切入个人资料范围"
        : recentUploadScopeState.status === "applied"
          ? "最近上传已纳入本轮范围"
          : "个人资料范围已就绪"
      : null,
    expertRunLabel,
  ].filter((item): item is string => Boolean(item));
  const hiddenMessageCount = deriveHiddenMessageCount({
    messageCount: messages.length,
    visibleLimit: visibleMessageLimit,
  });
  const runtimeMessages = useMemo(
    () =>
      runtimeMessagesFromConversation(
        messages,
        pendingMessages,
        threadSnapshot,
        expertRun,
        expertRunEvents,
        visibleMessageLimit,
      ),
    [expertRun, expertRunEvents, messages, pendingMessages, threadSnapshot, visibleMessageLimit],
  );
  const groupedAgentTurns = useMemo(
    () => groupTurnsByDisplayDate(agentTurns),
    [agentTurns],
  );
  const latestAgentTurn = agentTurns[agentTurns.length - 1] ?? null;
  const latestAgentTurnId = latestAgentTurn?.id ?? null;
  const agentTurnStreamKey = latestAgentTurn
    ? `${latestAgentTurn.id}:${latestAgentTurn.status}:${latestAgentTurn.assistant_text.length}:${latestAgentTurn.steps.length}:${latestAgentTurn.citations.length}`
    : "";
  const viewportDependencyKey = hasAgentTurnPath
    ? agentTurnStreamKey
    : runtimeMessages.length;

  const MessageBubble = useMemo(
    () =>
      function MessageBubbleRenderer() {
        return (
          <RuntimeMessageBubble
            copiedId={copiedId}
            onCopy={handleCopy}
            onDownload={handleDownload}
            onOpenReference={onOpenReference}
            onRetryPending={retryPending}
          />
        );
      },
    [copiedId, handleCopy, handleDownload, onOpenReference, retryPending],
  );

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) {
      return;
    }

    const updateScrollState = () => {
      const distanceToBottom =
        viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight;
      const isNearBottom = distanceToBottom <= 120;
      nearBottomRef.current = isNearBottom;
      setShowJumpToBottom(!isNearBottom);
    };

    updateScrollState();
    viewport.addEventListener("scroll", updateScrollState, { passive: true });
    return () => viewport.removeEventListener("scroll", updateScrollState);
  }, [viewportDependencyKey, threadSnapshot?.id]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!hasAgentTurnPath || !viewport) {
      return;
    }

    nearBottomRef.current = true;
    setShowJumpToBottom(false);
    const frameId = window.requestAnimationFrame(() => {
      scrollElementToBottom(viewport);
    });

    return () => window.cancelAnimationFrame(frameId);
  }, [hasAgentTurnPath, latestAgentTurnId]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport || !nearBottomRef.current) {
      return;
    }

    scrollElementToBottom(viewport);
  }, [
    viewportDependencyKey,
    threadSnapshot?.draft_assistant_text,
    pendingMessages.length,
  ]);

  useEffect(() => {
    setPendingMessages([]);
    setLocalSubmitting(false);
    submitLockRef.current = false;
    confirmedUserMessageCountRef.current = new Map();
    nearBottomRef.current = true;
    setShowJumpToBottom(false);
    setSessionSwitcherOpen(false);
    setSessionSearch("");
    setMessageHistoryExpanded(false);
  }, [threadSnapshot?.id]);

  useEffect(() => {
    if (!sessionSwitcherOpen) {
      return;
    }

    const handlePointerDown = (event: MouseEvent) => {
      if (!sessionSwitcherRef.current?.contains(event.target as Node)) {
        setSessionSwitcherOpen(false);
      }
    };

    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        setSessionSwitcherOpen(false);
      }
    };

    window.addEventListener("mousedown", handlePointerDown);
    window.addEventListener("keydown", handleKeyDown);
    return () => {
      window.removeEventListener("mousedown", handlePointerDown);
      window.removeEventListener("keydown", handleKeyDown);
    };
  }, [sessionSwitcherOpen]);

  useEffect(() => {
    const confirmedCounts = countConfirmedUserMessages(messages);
    const previousCounts = confirmedUserMessageCountRef.current;
    confirmedUserMessageCountRef.current = confirmedCounts;

    if (!pendingMessages.length || !confirmedCounts.size) {
      return;
    }

    setPendingMessages((current) => {
      const next = removeConfirmedPendingMessages({
        pendingMessages: current,
        previousCounts,
        confirmedCounts,
      });

      return next.length === current.length ? current : next;
    });
  }, [messages, pendingMessages.length]);

  useEffect(() => {
    if (isSubmitBusy) {
      return;
    }

    const nextQueued = pendingMessages.find((item) => item.status === "queued");
    if (!nextQueued) {
      return;
    }

    setPendingMessages((current) => current.filter((item) => item.id !== nextQueued.id));
    void submitContentNow(nextQueued.content);
  }, [isSubmitBusy, pendingMessages, submitContentNow]);

  return (
    <ConversationRuntime
      messages={runtimeMessages}
      onSubmit={submitContent}
      runtimeKey={threadSnapshot?.id ?? "welcome"}
    >
      <div className="relative flex min-h-0 min-w-0 flex-1 flex-col border-x border-border/30">
        <div className="shrink-0 border-b border-border/30 px-6 py-2.5">
          <div className="flex items-center justify-between gap-4">
            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-2">
                <p className="truncate text-sm font-medium text-foreground">{threadTitle}</p>
                {researchBrief?.stageLabel ? (
                  <span className="shrink-0 rounded border border-primary/25 bg-primary/10 px-1.5 py-0.5 text-[9px] text-primary">
                    {researchBrief.stageLabel}
                  </span>
                ) : null}
                {researchTask?.statusLabel ? (
                  <span className="shrink-0 rounded border border-border/35 bg-background/70 px-1.5 py-0.5 text-[9px] text-muted-foreground">
                    {researchTask.statusLabel}
                  </span>
                ) : null}
              </div>
              <p className="mt-0.5 truncate text-[11px] text-muted-foreground">
                {taskSummaryTitle}
              </p>
              {hasSummaryContent ? (
                <div className="mt-1 flex min-w-0 gap-2 overflow-hidden text-[10px] text-muted-foreground/70">
                  {taskSummaryMeta.slice(0, 6).map((item) => (
                    <span className="shrink-0 truncate" key={item}>
                      {item}
                    </span>
                  ))}
                </div>
              ) : null}
            </div>
            {showSessionControls ? (
              <div className="relative flex shrink-0 items-center gap-2" ref={sessionSwitcherRef}>
                {onSelectDiscussion ? (
                  <button
                    aria-expanded={sessionSwitcherOpen}
                    aria-label="切换对话"
                    className="flex min-w-[12rem] max-w-[16rem] items-center justify-between gap-2 rounded-md border border-border/40 bg-background/70 px-2.5 py-1.5 text-left transition-colors hover:border-border"
                    onClick={() => setSessionSwitcherOpen((current) => !current)}
                    type="button"
                  >
                    <div className="min-w-0">
                      <p className="truncate text-[11px] font-medium text-foreground">
                        {activeDiscussion?.title ?? "选择对话"}
                      </p>
                      <p className="truncate text-[10px] text-muted-foreground/70">
                        {activeDiscussion
                          ? `${activeDiscussion.subtitle} · ${formatDiscussionTimestamp(activeDiscussion.timestamp)} · ${formatDiscussionStatusLabel(activeDiscussion.status)}`
                          : "查看对话列表并快速切换"}
                      </p>
                    </div>
                    <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  </button>
                ) : null}
                {onCreateDiscussion ? (
                  <Button
                    className="h-7 gap-1 px-2 text-[11px]"
                    onClick={() => void onCreateDiscussion()}
                    size="sm"
                    type="button"
                    variant="outline"
                  >
                    <Plus className="h-3 w-3" />
                    新建对话
                  </Button>
                ) : null}
                {groupedAllDiscussions.active.length > 0 ? (
                  <button
                    className="rounded-full border border-primary/20 bg-primary/10 px-2.5 py-1 text-[10px] text-primary transition-colors hover:bg-primary/15"
                    onClick={() => setSessionSwitcherOpen(true)}
                    type="button"
                  >
                    进行中 {groupedAllDiscussions.active.length}
                  </button>
                ) : null}
                {sessionSwitcherOpen && onSelectDiscussion ? (
                  <div className="absolute right-0 top-full z-20 mt-2 w-80 rounded-xl border border-border/40 bg-background/95 p-3 shadow-lg backdrop-blur">
                    <div className="flex items-center justify-between gap-2">
                      <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                        对话列表
                      </p>
                      <span className="text-[10px] text-muted-foreground/60">
                        进行中 {groupedDiscussions.active.length}
                      </span>
                    </div>
                    <input
                      aria-label="搜索对话"
                      className="mt-2 h-8 w-full rounded-md border border-border/40 bg-background/80 px-2.5 text-[11px] text-foreground outline-none transition-colors placeholder:text-muted-foreground/50 focus:border-primary/40"
                      onChange={(event) => setSessionSearch(event.target.value)}
                      placeholder="搜索对话标题或资料范围"
                      type="text"
                      value={sessionSearch}
                    />
                    <div className="mt-2 max-h-80 overflow-y-auto scrollbar-thin">
                      {filteredDiscussions.length === 0 ? (
                        <div className="rounded-lg border border-dashed border-border/35 bg-card/25 px-3 py-3">
                          <p className="text-[11px] font-medium text-foreground/80">未找到匹配对话</p>
                          <p className="mt-1 text-[10px] text-muted-foreground/60">
                            换个关键词，或直接新建对话。
                          </p>
                        </div>
                      ) : (
                        <div className="space-y-3">
                          {[
                            { key: "active", label: "进行中", items: groupedDiscussions.active },
                            { key: "recent", label: "最近查看", items: groupedDiscussions.recent },
                            { key: "completed", label: "已完成", items: groupedDiscussions.completed },
                          ]
                            .filter((group) => group.items.length > 0)
                            .map((group) => (
                              <div key={group.key}>
                                <div className="mb-1 flex items-center justify-between gap-2">
                                  <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground/75">
                                    {group.label}
                                  </p>
                                  <span className="text-[9px] text-muted-foreground/55">
                                    {group.items.length}
                                  </span>
                                </div>
                                <div className="space-y-1">
                                  {group.items.map((discussion) => {
                                    const active = discussion.id === selectedDiscussionId;
                                    return (
                                      <div
                                        className={`rounded-lg border px-3 py-2 transition-colors ${
                                          active
                                            ? "border-primary/30 bg-primary/10"
                                            : "border-transparent bg-card/25 hover:border-border/30 hover:bg-secondary/35"
                                        }`}
                                        key={discussion.id}
                                      >
                                        <div className="flex items-start gap-2">
                                          <button
                                            className="min-w-0 flex-1 text-left"
                                            onClick={() => {
                                              onSelectDiscussion(discussion.id);
                                              setSessionSwitcherOpen(false);
                                              setSessionSearch("");
                                            }}
                                            type="button"
                                          >
                                            <div className="flex items-start justify-between gap-2">
                                              <div className="min-w-0">
                                                <p className="truncate text-[11px] font-medium text-foreground">
                                                  {discussion.title}
                                                </p>
                                                <p className="mt-0.5 truncate text-[10px] text-muted-foreground/75">
                                                  {discussion.subtitle}
                                                </p>
                                              </div>
                                              <span className="shrink-0 rounded-full border border-border/30 bg-background/70 px-1.5 py-0.5 text-[9px] text-muted-foreground">
                                                {formatDiscussionStatusLabel(discussion.status)}
                                              </span>
                                            </div>
                                            <div className="mt-1 flex items-center gap-2 text-[10px] text-muted-foreground/60">
                                              <span>{formatDiscussionTimestamp(discussion.timestamp)}</span>
                                              <span>{formatDiscussionTime(discussion.timestamp)}</span>
                                              <span>{discussion.messageCount} 条消息</span>
                                            </div>
                                          </button>
                                          {onDeleteDiscussion ? (
                                            <Button
                                              aria-label={`删除对话 ${discussion.title}`}
                                              className="h-7 shrink-0 gap-1 px-2 text-[10px]"
                                              onClick={() => {
                                                void onDeleteDiscussion(discussion.id);
                                                setSessionSwitcherOpen(false);
                                                setSessionSearch("");
                                              }}
                                              size="sm"
                                              type="button"
                                              variant="ghost"
                                            >
                                              <Trash2 className="h-3 w-3" />
                                              删除
                                            </Button>
                                          ) : null}
                                        </div>
                                      </div>
                                    );
                                  })}
                                </div>
                              </div>
                            ))}
                        </div>
                      )}
                    </div>
                  </div>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>

        {hasAgentTurnPath ? (
          <div
            className="relative flex min-h-0 flex-1 flex-col overflow-hidden"
            key={threadSnapshot?.id ?? selectedDiscussionId ?? "agent-turns"}
          >
            <div
              className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 py-4 pl-12 scrollbar-thin md:pl-16"
              data-chat-viewport="true"
              ref={viewportRef}
            >
              <AgentTurnTimelineRail
                onJumpToTurn={jumpToAgentTurn}
                turns={agentTurns}
              />
              <div className="flex min-h-full flex-col gap-4 pb-2">
                {groupedAgentTurns.map((group) => (
                  <section className="space-y-2" key={group.key}>
                    <div className="sticky top-0 z-10 flex justify-center py-1">
                      <span className="rounded-full border border-border/35 bg-background/90 px-2.5 py-1 text-[10px] text-muted-foreground shadow-sm backdrop-blur">
                        {group.label}
                      </span>
                    </div>
                    {group.turns.map((turn) => (
                      <AgentTurnView
                        isAdmin={isPlatformAdmin}
                        key={turn.id}
                        turn={turn}
                      />
                    ))}
                  </section>
                ))}
              </div>
              {showJumpToBottom ? (
                <button
                  className="absolute bottom-3 right-4 z-10 rounded-full border border-border/40 bg-background/92 px-3 py-1.5 text-[11px] text-muted-foreground shadow-lg backdrop-blur transition-colors hover:border-primary/30 hover:text-foreground"
                  onClick={() => {
                    nearBottomRef.current = true;
                    if (viewportRef.current) {
                      scrollElementToBottom(viewportRef.current);
                    }
                  }}
                  type="button"
                >
                  回到最新内容
                </button>
              ) : null}
            </div>

            <div className="shrink-0 border-t border-border/30 bg-background/96 p-4 backdrop-blur supports-[backdrop-filter]:bg-background/85">
              <ConversationComposer
                failedPending={latestFailedPending}
                inputDisabled={false}
                onInterrupt={onInterrupt}
                onQuickAction={(content) => void submitContent(content)}
                onRetryFailed={() => latestFailedPending && retryPending(latestFailedPending)}
                quickActions={composerQuickActions}
                queuedMessages={queuedMessages}
                running={running}
                showAssistiveRows={false}
                sending={sending || localSubmitting}
              />
            </div>
          </div>
        ) : (
        <ThreadPrimitive.Root
          className="relative flex min-h-0 flex-1 flex-col overflow-hidden"
          key={threadSnapshot?.id ?? "welcome-thread"}
        >
          <ThreadPrimitive.Viewport
            className="relative min-h-0 flex-1 overflow-y-auto overscroll-contain px-6 py-4 scrollbar-thin"
            data-chat-viewport="true"
            ref={viewportRef}
          >
            <div className="flex min-h-full flex-col gap-4 pb-2">
              {error ? (
                <div
                  className="rounded-xl border border-destructive/30 bg-destructive/10 px-4 py-3 text-sm text-destructive"
                  data-page-error="true"
                >
                  <p className="text-[11px] font-medium">处理异常</p>
                  <p className="mt-1 break-words [overflow-wrap:anywhere]">{error}</p>
                </div>
              ) : null}

              {messages.length === 0 && !sending && !pendingMessages.length ? (
                <div className="rounded-xl border border-dashed border-border/35 bg-card/25 px-4 py-4">
                  <p className="text-sm font-medium text-foreground/85">暂无对话记录</p>
                  <p className="mt-1 text-sm text-muted-foreground">
                    当前还没有对话。直接发送问题即可自动开始。
                  </p>
                </div>
              ) : null}

              {hiddenMessageCount > 0 ? (
                <div
                  className="flex items-center justify-center"
                  data-region="message-history-collapse"
                >
                  <button
                    className="rounded-full border border-border/40 bg-background/85 px-3 py-1.5 text-[11px] text-muted-foreground shadow-sm transition-colors hover:border-primary/30 hover:text-foreground"
                    onClick={() => {
                      nearBottomRef.current = false;
                      setMessageHistoryExpanded(true);
                    }}
                    type="button"
                  >
                    已折叠较早 {hiddenMessageCount} 条消息，点击展开完整时间线
                  </button>
                </div>
              ) : null}

              <div className="min-h-0">
                <ThreadPrimitive.Messages components={{ Message: MessageBubble }} />
              </div>
            </div>
            {showJumpToBottom ? (
              <button
                className="sticky bottom-3 float-right z-10 mr-1 -mt-9 rounded-full border border-border/40 bg-background/92 px-3 py-1.5 text-[11px] text-muted-foreground shadow-lg backdrop-blur transition-colors hover:border-primary/30 hover:text-foreground"
                onClick={() => {
                  nearBottomRef.current = true;
                  if (viewportRef.current) {
                    scrollElementToBottom(viewportRef.current);
                  }
                }}
                type="button"
              >
                回到最新内容
              </button>
            ) : null}
          </ThreadPrimitive.Viewport>

          <div className="shrink-0 border-t border-border/30 bg-background/96 p-4 backdrop-blur supports-[backdrop-filter]:bg-background/85">
            <ConversationComposer
              failedPending={latestFailedPending}
              inputDisabled={false}
              onInterrupt={onInterrupt}
              onQuickAction={(content) => void submitContent(content)}
              onRetryFailed={() => latestFailedPending && retryPending(latestFailedPending)}
              quickActions={composerQuickActions}
              queuedMessages={queuedMessages}
              running={running}
              showAssistiveRows={false}
              sending={sending || localSubmitting}
            />
          </div>
        </ThreadPrimitive.Root>
        )}
      </div>
    </ConversationRuntime>
  );
}
