import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type {
  AgentSubscriber,
  ActivityDeltaEvent,
  ActivitySnapshotEvent,
  RunFinishedEvent,
  StateSnapshotEvent,
  TextMessageContentEvent,
} from "@ag-ui/client";
import type { Message } from "@ag-ui/core";

import {
  createAgentConversation,
  deleteAgentConversation,
  interruptAgentConversation,
  listAgentConversations,
  listAgentTurns,
} from "@/lib/clawd/api";
import { createWebAgentHttpAgent } from "@/lib/clawd/ag-ui-client";
import type {
  AgentCitation,
  AgentExpertResult,
  AgentTurnRecord,
  AgentTurnStep,
} from "@/lib/clawd/agent-turns";
import type {
  AgentConversationRecord,
  CreateAgentConversationRequest,
  RequestAuth,
} from "@/lib/clawd/types";

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }
  return "请求失败，请检查后端服务与认证配置。";
}

function normalizeStringList(values?: string[] | null): string[] {
  return Array.from(new Set((values ?? []).map((item) => item.trim()).filter(Boolean)));
}

function createLocalRunningTurn({
  conversation,
  content,
  runId,
  selectedExpertIds = [],
}: {
  conversation: AgentConversationRecord;
  content: string;
  runId: string;
  selectedExpertIds?: string[];
}): AgentTurnRecord {
  const now = Date.now();
  const expertIds = normalizeStringList(selectedExpertIds);
  return {
    id: runId,
    conversation_id: conversation.id,
    tenant_id: conversation.tenant_id,
    owner_id: conversation.owner_id,
    user_message: content,
    assistant_text: "",
    status: "running",
    started_at_ms: now,
    completed_at_ms: null,
    steps: [
      {
        id: `${runId}-start`,
        kind: "generation",
        label: "任务已交给 AI 分析师",
        detail: "正在准备检索、专家和生成流程",
        status: "running",
        started_at_ms: now,
        completed_at_ms: null,
        public_payload: {},
      },
      ...expertIds.map((expertId) => ({
        id: `${runId}-expert-${expertId}`,
        kind: "expert" as const,
        label: `${expertId} 分析中`,
        detail: "等待专家返回分析结果",
        status: "running" as const,
        started_at_ms: now,
        completed_at_ms: null,
        public_payload: {
          expert_name: expertId,
          result_summary: "专家分析进行中",
        },
      })),
    ],
    citations: [],
    expert_results: [],
    artifacts: [],
    error: null,
    debug_events: [],
  };
}

export const createLocalRunningTurnForTest = createLocalRunningTurn;

function mergeById<T extends { id: string }>(current: T[], incoming: T[]): T[] {
  const next = [...current];
  for (const item of incoming) {
    const index = next.findIndex((entry) => entry.id === item.id);
    if (index === -1) {
      next.push(item);
    } else {
      next[index] = item;
    }
  }
  return next;
}

function mergeFailedGenerationStep({
  message,
  now,
  runId,
  steps,
}: {
  message: string;
  now: number;
  runId: string;
  steps: AgentTurnStep[];
}): AgentTurnStep[] {
  return mergeById(steps, [
    {
      id: `${runId}-failed`,
      kind: "generation",
      label: "生成回答失败",
      detail: message,
      status: "failed",
      started_at_ms: now,
      completed_at_ms: now,
      public_payload: {
        result_summary: message,
        is_error: true,
      },
    },
  ]);
}

function failTurnWithMessage(
  turn: AgentTurnRecord,
  runId: string,
  message: string,
): AgentTurnRecord {
  const now = Date.now();
  return {
    ...turn,
    status: "failed",
    completed_at_ms: now,
    steps: mergeFailedGenerationStep({
      message,
      now,
      runId,
      steps: turn.steps,
    }),
    error: {
      public_message: message,
      debug_message: message,
      code: null,
    },
  };
}

export function mergeRunFinishedTurn({
  existingTurn,
  finalTurn,
  runId,
}: {
  existingTurn: AgentTurnRecord;
  finalTurn: AgentTurnRecord;
  runId: string;
}): AgentTurnRecord {
  const failedStep = existingTurn.steps.find((step) => step.id === `${runId}-failed`);
  const hasLocalFailure = existingTurn.status === "failed" || Boolean(failedStep) || Boolean(existingTurn.error);
  if (!hasLocalFailure) {
    return finalTurn;
  }

  return {
    ...finalTurn,
    steps: failedStep ? mergeById(finalTurn.steps, [failedStep]) : finalTurn.steps,
    error: existingTurn.error ?? finalTurn.error,
  };
}

function runIdFromFailedStep(turn: AgentTurnRecord): string | null {
  const failedStep = turn.steps.find((step) => step.id.endsWith("-failed"));
  return failedStep ? failedStep.id.slice(0, -"-failed".length) : null;
}

export function mergeRefreshedTurns({
  currentTurns,
  refreshedTurns,
}: {
  currentTurns: AgentTurnRecord[];
  refreshedTurns: AgentTurnRecord[];
}): AgentTurnRecord[] {
  return refreshedTurns.map((refreshedTurn) => {
    const existingTurn = currentTurns.find(
      (turn) =>
        turn.id === refreshedTurn.id ||
        runIdFromFailedStep(turn) === refreshedTurn.id ||
        (turn.conversation_id === refreshedTurn.conversation_id &&
          turn.user_message === refreshedTurn.user_message),
    );
    if (!existingTurn) {
      return refreshedTurn;
    }

    return mergeRunFinishedTurn({
      existingTurn,
      finalTurn: refreshedTurn,
      runId: runIdFromFailedStep(existingTurn) ?? existingTurn.id,
    });
  });
}

type ActivityPayload = {
  steps: AgentTurnStep[];
  citations: AgentCitation[];
  expertResults: AgentExpertResult[];
};

function readActivityContentPayload(content: unknown): ActivityPayload | null {
  const payload = content as
    | {
        steps?: AgentTurnStep[];
        citations?: AgentCitation[];
        expertResults?: AgentExpertResult[];
      }
      | undefined;
  if (!payload) {
    return null;
  }
  return {
    steps: Array.isArray(payload.steps) ? payload.steps : [],
    citations: Array.isArray(payload.citations) ? payload.citations : [],
    expertResults: Array.isArray(payload.expertResults) ? payload.expertResults : [],
  };
}

function readActivitySnapshotPayload(event: ActivitySnapshotEvent): ActivityPayload | null {
  return readActivityContentPayload(event.content);
}

function readActivityDeltaPayload(event: ActivityDeltaEvent): ActivityPayload | null {
  const rawEvent = event.rawEvent as { delta?: unknown } | undefined;
  return readActivityContentPayload(rawEvent?.delta);
}

function readTurnFromRunFinished(event: RunFinishedEvent): AgentTurnRecord | null {
  const result = (event as RunFinishedEvent & { result?: { turn?: AgentTurnRecord } }).result;
  return result?.turn ?? null;
}

function readDebugPayload(event: StateSnapshotEvent): unknown {
  const snapshot = event.snapshot as { debugEvent?: unknown } | undefined;
  return snapshot?.debugEvent ?? event.snapshot;
}

export type WebAgentSendOptions = {
  title?: string;
  selectedKnowledgeBaseIds?: string[];
  selectedDataSourceIds?: string[];
  selectedExpertIds?: string[];
  modelProfileId?: string | null;
};

export type UseWebAgentSessionResult = {
  conversations: AgentConversationRecord[];
  selectedConversation: AgentConversationRecord | null;
  selectedConversationId: string | null;
  agentTurns: AgentTurnRecord[];
  loading: boolean;
  sending: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  selectConversation: (conversationId: string) => Promise<void>;
  createConversation: (payload?: CreateAgentConversationRequest) => Promise<AgentConversationRecord>;
  deleteConversation: (conversationId: string) => Promise<void>;
  sendMessage: (content: string, options?: WebAgentSendOptions) => Promise<void>;
  interruptCurrentRun: () => Promise<void>;
};

export function useWebAgentSession(auth: RequestAuth): UseWebAgentSessionResult {
  const [conversations, setConversations] = useState<AgentConversationRecord[]>([]);
  const [selectedConversationId, setSelectedConversationId] = useState<string | null>(null);
  const [agentTurns, setAgentTurns] = useState<AgentTurnRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const activeAgentRef = useRef<ReturnType<typeof createWebAgentHttpAgent> | null>(null);

  const selectedConversation = useMemo(
    () =>
      conversations.find((conversation) => conversation.id === selectedConversationId) ??
      null,
    [conversations, selectedConversationId],
  );

  const mergeConversation = useCallback((conversation: AgentConversationRecord) => {
    setConversations((current) => {
      const next = [...current];
      const index = next.findIndex((item) => item.id === conversation.id);
      if (index === -1) {
        next.unshift(conversation);
      } else {
        next[index] = conversation;
      }
      return next.sort((left, right) => right.updated_at_ms - left.updated_at_ms);
    });
  }, []);

  const refreshTurns = useCallback(
    async (conversationId: string) => {
      const turns = await listAgentTurns(conversationId, auth);
      setAgentTurns((current) =>
        mergeRefreshedTurns({
          currentTurns: current,
          refreshedTurns: turns,
        }),
      );
      return turns;
    },
    [auth],
  );

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const nextConversations = await listAgentConversations(auth);
      setConversations(nextConversations);
      const nextSelectedId = selectedConversationId ?? nextConversations[0]?.id ?? null;
      setSelectedConversationId(nextSelectedId);
      if (nextSelectedId) {
        await refreshTurns(nextSelectedId);
      } else {
        setAgentTurns([]);
      }
    } catch (nextError) {
      setError(toErrorMessage(nextError));
    } finally {
      setLoading(false);
    }
  }, [auth, refreshTurns, selectedConversationId]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const selectConversation = useCallback(
    async (conversationId: string) => {
      setSelectedConversationId(conversationId);
      setError(null);
      try {
        await refreshTurns(conversationId);
      } catch (nextError) {
        setError(toErrorMessage(nextError));
      }
    },
    [refreshTurns],
  );

  const createConversation = useCallback(
    async (payload: CreateAgentConversationRequest = {}) => {
      setError(null);
      const conversation = await createAgentConversation(payload, auth);
      mergeConversation(conversation);
      setSelectedConversationId(conversation.id);
      setAgentTurns([]);
      return conversation;
    },
    [auth, mergeConversation],
  );

  const ensureConversation = useCallback(
    async (content: string, options: WebAgentSendOptions = {}) => {
      if (selectedConversation) {
        return selectedConversation;
      }
      return createConversation({
        title: options.title ?? (content.slice(0, 48) || "新对话"),
        selected_knowledge_base_ids: normalizeStringList(options.selectedKnowledgeBaseIds),
        selected_data_source_ids: normalizeStringList(options.selectedDataSourceIds),
        selected_expert_ids: normalizeStringList(options.selectedExpertIds),
        model_profile_id: options.modelProfileId ?? null,
      });
    },
    [createConversation, selectedConversation],
  );

  const sendMessage = useCallback(
    async (content: string, options: WebAgentSendOptions = {}) => {
      const trimmed = content.trim();
      if (!trimmed) {
        throw new Error("消息内容不能为空。");
      }

      setSending(true);
      setError(null);
      const runId = `turn-${Date.now()}`;

      try {
        const conversation = await ensureConversation(trimmed, options);
        const localTurn = createLocalRunningTurn({
          conversation,
          content: trimmed,
          runId,
          selectedExpertIds: options.selectedExpertIds,
        });
        setAgentTurns((current) => [...current, localTurn]);

        const agent = createWebAgentHttpAgent(auth, conversation.id);
        activeAgentRef.current = agent;
        const userMessage: Message = {
          id: `${runId}-user`,
          role: "user",
          content: trimmed,
        };
        agent.addMessage(userMessage);

        const updateTurn = (updater: (turn: AgentTurnRecord) => AgentTurnRecord) => {
          setAgentTurns((current) =>
            current.map((turn) => (turn.id === runId ? updater(turn) : turn)),
          );
        };

        const subscriber: AgentSubscriber = {
          onTextMessageContentEvent: ({
            event,
          }: {
            event: TextMessageContentEvent;
          }) => {
            updateTurn((turn) => ({
              ...turn,
              assistant_text: `${turn.assistant_text}${event.delta}`,
              status: "running",
            }));
          },
          onActivitySnapshotEvent: ({ event }: { event: ActivitySnapshotEvent }) => {
            const payload = readActivitySnapshotPayload(event);
            if (!payload) {
              return;
            }
            updateTurn((turn) => ({
              ...turn,
              steps: mergeById(turn.steps, payload.steps),
              citations: mergeById(turn.citations, payload.citations),
              expert_results: mergeById(
                turn.expert_results.map((expert) => ({
                  ...expert,
                  id: expert.expert_name,
                })),
                payload.expertResults.map((expert) => ({
                  ...expert,
                  id: expert.expert_name,
                })),
              ).map(({ id: _id, ...expert }) => expert),
            }));
          },
          onActivityDeltaEvent: ({ event }: { event: ActivityDeltaEvent }) => {
            const payload = readActivityDeltaPayload(event);
            if (!payload) {
              return;
            }
            updateTurn((turn) => ({
              ...turn,
              steps: mergeById(turn.steps, payload.steps),
              citations: mergeById(turn.citations, payload.citations),
              expert_results: mergeById(
                turn.expert_results.map((expert) => ({
                  ...expert,
                  id: expert.expert_name,
                })),
                payload.expertResults.map((expert) => ({
                  ...expert,
                  id: expert.expert_name,
                })),
              ).map(({ id: _id, ...expert }) => expert),
            }));
          },
          onStateSnapshotEvent: ({ event }: { event: StateSnapshotEvent }) => {
            updateTurn((turn) => ({
              ...turn,
              debug_events: [
                ...turn.debug_events,
                {
                  event_type: "STATE_SNAPSHOT",
                  at_ms: Date.now(),
                  payload: readDebugPayload(event),
                },
              ],
            }));
          },
          onRunFinishedEvent: ({ event }: { event: RunFinishedEvent }) => {
            const finalTurn = readTurnFromRunFinished(event);
            if (finalTurn) {
              setAgentTurns((current) =>
                current.map((turn) =>
                  turn.id === runId
                    ? mergeRunFinishedTurn({
                        existingTurn: turn,
                        finalTurn,
                        runId,
                      })
                    : turn,
                ),
              );
              void refreshTurns(conversation.id);
              return;
            }
            updateTurn((turn) => ({
              ...turn,
              status: "succeeded",
              completed_at_ms: Date.now(),
            }));
          },
          onRunFailed: ({ error: runError }) => {
            const message = toErrorMessage(runError);
            updateTurn((turn) => failTurnWithMessage(turn, runId, message));
          },
        };

        await agent.runAgent(
          {
            runId,
            forwardedProps: {
              selectedKnowledgeBaseIds: normalizeStringList(options.selectedKnowledgeBaseIds),
              selectedDataSourceIds: normalizeStringList(options.selectedDataSourceIds),
              selectedExpertIds: normalizeStringList(options.selectedExpertIds),
              modelProfileId: options.modelProfileId ?? null,
            },
          },
          subscriber,
        );
      } catch (nextError) {
        const message = toErrorMessage(nextError);
        setError(message);
        setAgentTurns((current) =>
          current.map((turn) =>
            turn.id === runId ? failTurnWithMessage(turn, runId, message) : turn,
          ),
        );
        throw new Error(message);
      } finally {
        activeAgentRef.current = null;
        setSending(false);
      }
    },
    [auth, ensureConversation, refreshTurns],
  );

  const deleteConversation = useCallback(
    async (conversationId: string) => {
      setError(null);
      await deleteAgentConversation(conversationId, auth);
      let nextSelectedId: string | null = null;
      setConversations((current) => {
        const remaining = current.filter((conversation) => conversation.id !== conversationId);
        nextSelectedId =
          selectedConversationId === conversationId
            ? remaining[0]?.id ?? null
            : selectedConversationId;
        return remaining;
      });
      if (selectedConversationId === conversationId) {
        setSelectedConversationId(nextSelectedId);
        if (nextSelectedId) {
          await refreshTurns(nextSelectedId);
        } else {
          setAgentTurns([]);
        }
      }
    },
    [auth, refreshTurns, selectedConversationId],
  );

  const interruptCurrentRun = useCallback(async () => {
    activeAgentRef.current?.abortRun();
    if (!selectedConversationId) {
      return;
    }
    const conversation = await interruptAgentConversation(selectedConversationId, auth);
    mergeConversation(conversation);
    setAgentTurns((current) =>
      current.map((turn) =>
        turn.status === "running"
          ? { ...turn, status: "interrupted", completed_at_ms: Date.now() }
          : turn,
      ),
    );
  }, [auth, mergeConversation, selectedConversationId]);

  return {
    conversations,
    selectedConversation,
    selectedConversationId,
    agentTurns,
    loading,
    sending,
    error,
    refresh,
    selectConversation,
    createConversation,
    deleteConversation,
    sendMessage,
    interruptCurrentRun,
  };
}
