import { useCallback, useEffect, useMemo, useState } from "react";

import {
  createDataSource,
  createKnowledgeBase,
  createThread,
  getAuthSession,
  getConfig,
  getThread,
  listDataSources,
  listKnowledgeBases,
  listProjects,
  listSkills,
  listThreads,
  sendThreadCommand,
  uploadDataSourceFile,
} from "@/lib/clawd/api";
import {
  buildThreadModelPayload,
  type BrowserModelConfig,
} from "@/lib/clawd/browser-model";
import {
  BUILTIN_EXPERT_SKILLS,
  isExpertSkill,
} from "@/lib/clawd/expert-brainstorm";
import type {
  AuthSession,
  ClawdConfig,
  DataSourceSummary,
  ExpertPanelContext,
  KnowledgeBaseSummary,
  ProjectSummary,
  RequestAuth,
  SkillSummary,
  ThreadSnapshot,
  ThreadSummary,
} from "@/lib/clawd/types";

function toErrorMessage(error: unknown): string {
  if (error instanceof Error && error.message.trim()) {
    return error.message.trim();
  }
  return "请求失败，请检查后端服务与认证配置。";
}

function summarizeThread(thread: ThreadSnapshot): ThreadSummary {
  return {
    id: thread.id,
    workspace_root: thread.workspace_root,
    project_id: thread.project_id,
    project_name: thread.project_name,
    knowledge_base_id: thread.knowledge_base_id,
    knowledge_base_name: thread.knowledge_base_name,
    model: thread.model,
    topic: thread.topic,
    status: thread.status,
    updated_at_ms: thread.updated_at_ms,
  };
}

function mergeThreadSummary(
  current: ThreadSummary[],
  thread: ThreadSnapshot,
): ThreadSummary[] {
  const nextSummary = summarizeThread(thread);
  const next = [...current];
  const index = next.findIndex((entry) => entry.id === thread.id);

  if (index === -1) {
    next.unshift(nextSummary);
  } else {
    next[index] = nextSummary;
  }

  return next.sort((left, right) => right.updated_at_ms - left.updated_at_ms);
}

function mergeExpertSkills(skills: SkillSummary[]): SkillSummary[] {
  const merged = new Map<string, SkillSummary>();

  for (const skill of [...skills, ...BUILTIN_EXPERT_SKILLS]) {
    if (!isExpertSkill(skill)) {
      continue;
    }

    const key = `${skill.scope}:${skill.name}`.toLowerCase();
    if (!merged.has(key)) {
      merged.set(key, skill);
    }
  }

  return Array.from(merged.values()).sort((left, right) =>
    left.name.localeCompare(right.name, "zh-CN"),
  );
}

export type UseClawdSessionResult = {
  auth: RequestAuth;
  authSession: AuthSession | null;
  config: ClawdConfig | null;
  projects: ProjectSummary[];
  knowledgeBases: KnowledgeBaseSummary[];
  dataSources: DataSourceSummary[];
  threads: ThreadSummary[];
  selectedKnowledgeBaseId: string | null;
  selectedThreadId: string | null;
  selectedThread: ThreadSnapshot | null;
  expertSkills: SkillSummary[];
  loading: boolean;
  threadLoading: boolean;
  sending: boolean;
  uploading: boolean;
  error: string | null;
  refreshSession: () => Promise<void>;
  refreshSelectedThread: (threadId?: string | null) => Promise<ThreadSnapshot | null>;
  selectThread: (threadId: string) => Promise<void>;
  selectKnowledgeBase: (knowledgeBaseId: string | null) => void;
  createEmptyThread: (topic?: string, browserModelConfig?: BrowserModelConfig) => Promise<ThreadSnapshot>;
  sendUserMessage: (
    content: string,
    expertPanel?: ExpertPanelContext,
    executionContext?: {
      knowledgeBaseId?: string | null;
      knowledge_base_id?: string | null;
      autoRetrieval?: boolean;
      auto_retrieval?: boolean;
    },
  ) => Promise<ThreadSnapshot>;
  uploadFilesToPersonalSource: (files: File[]) => Promise<void>;
};

const PERSONAL_KB_NAME = "我的资料";
const PERSONAL_UPLOAD_SOURCE_NAME = "我的上传资料";

export function useClawdSession(auth: RequestAuth): UseClawdSessionResult {
  const [authSession, setAuthSession] = useState<AuthSession | null>(null);
  const [config, setConfig] = useState<ClawdConfig | null>(null);
  const [projects, setProjects] = useState<ProjectSummary[]>([]);
  const [knowledgeBases, setKnowledgeBases] = useState<KnowledgeBaseSummary[]>([]);
  const [dataSources, setDataSources] = useState<DataSourceSummary[]>([]);
  const [threads, setThreads] = useState<ThreadSummary[]>([]);
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [selectedKnowledgeBaseId, setSelectedKnowledgeBaseId] = useState<string | null>(null);
  const [selectedThreadId, setSelectedThreadId] = useState<string | null>(null);
  const [selectedThread, setSelectedThread] = useState<ThreadSnapshot | null>(null);
  const [loading, setLoading] = useState(true);
  const [threadLoading, setThreadLoading] = useState(false);
  const [sending, setSending] = useState(false);
  const [uploading, setUploading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refreshDataSources = useCallback(async () => {
    const nextKnowledgeBases = await listKnowledgeBases(auth);
    const nextDataSources = await listDataSources(auth);
    setKnowledgeBases(nextKnowledgeBases);
    setDataSources(nextDataSources);
    return {
      knowledgeBases: nextKnowledgeBases,
      dataSources: nextDataSources,
    };
  }, [auth]);

  const refreshSelectedThread = useCallback(
    async (threadId?: string | null): Promise<ThreadSnapshot | null> => {
      const targetThreadId = threadId ?? selectedThreadId;
      if (!targetThreadId) {
        return null;
      }

      const snapshot = await getThread(targetThreadId, auth);
      setSelectedThreadId(snapshot.id);
      setSelectedThread(snapshot);
      setSelectedKnowledgeBaseId(snapshot.knowledge_base_id ?? null);
      setThreads((current) => mergeThreadSummary(current, snapshot));
      return snapshot;
    },
    [auth, selectedThreadId],
  );

  const refreshSession = useCallback(async () => {
    setLoading(true);
    setError(null);

    try {
      const [
        nextConfig,
        nextAuthSession,
        nextProjects,
        nextKnowledgeBases,
        nextDataSources,
        nextThreads,
        nextSkills,
      ] = await Promise.all([
        getConfig(),
        getAuthSession(auth),
        listProjects(auth),
        listKnowledgeBases(auth),
        listDataSources(auth),
        listThreads(auth),
        listSkills({}, auth).catch(() => [] as SkillSummary[]),
      ]);

      setConfig(nextConfig);
      setAuthSession(nextAuthSession);
      setProjects(nextProjects);
      setKnowledgeBases(nextKnowledgeBases);
      setDataSources(nextDataSources);
      setThreads(nextThreads);
      setSkills(nextSkills);

      const firstThreadId = nextThreads[0]?.id ?? null;
      setSelectedThreadId(firstThreadId);

      if (!firstThreadId) {
        setSelectedThread(null);
        return;
      }

      const snapshot = await getThread(firstThreadId, auth);
      setSelectedThread(snapshot);
      setSelectedKnowledgeBaseId(snapshot.knowledge_base_id ?? null);
      setThreads((current) => mergeThreadSummary(current, snapshot));
    } catch (nextError) {
      setError(toErrorMessage(nextError));
    } finally {
      setLoading(false);
    }
  }, [auth]);

  useEffect(() => {
    void refreshSession();
  }, [refreshSession]);

  const selectThread = useCallback(
    async (threadId: string) => {
      setThreadLoading(true);
      setError(null);

      try {
        await refreshSelectedThread(threadId);
      } catch (nextError) {
        setError(toErrorMessage(nextError));
      } finally {
        setThreadLoading(false);
      }
    },
    [refreshSelectedThread],
  );

  const createEmptyThread = useCallback(
    async (
      topic?: string,
      browserModelConfig?: BrowserModelConfig,
    ): Promise<ThreadSnapshot> => {
      setError(null);

      try {
        const snapshot = await createThread(
          {
            ...(topic?.trim() ? { topic: topic.trim() } : {}),
            ...(selectedKnowledgeBaseId ? { knowledge_base_id: selectedKnowledgeBaseId } : {}),
            ...(browserModelConfig
              ? buildThreadModelPayload(browserModelConfig)
              : {}),
          },
          auth,
        );
        setSelectedThreadId(snapshot.id);
        setSelectedThread(snapshot);
        setSelectedKnowledgeBaseId(snapshot.knowledge_base_id ?? selectedKnowledgeBaseId ?? null);
        setThreads((current) => mergeThreadSummary(current, snapshot));
        return snapshot;
      } catch (nextError) {
        const message = toErrorMessage(nextError);
        setError(message);
        throw new Error(message);
      }
    },
    [auth, selectedKnowledgeBaseId],
  );

  const sendUserMessage = useCallback(
    async (
      content: string,
      expertPanel?: ExpertPanelContext,
      executionContext?: {
        knowledgeBaseId?: string | null;
        knowledge_base_id?: string | null;
        autoRetrieval?: boolean;
        auto_retrieval?: boolean;
      },
    ): Promise<ThreadSnapshot> => {
      const trimmedContent = content.trim();
      if (!trimmedContent) {
        throw new Error("消息内容不能为空。");
      }

      setSending(true);
      setError(null);

      try {
        const threadId = selectedThreadId ?? (await createEmptyThread(trimmedContent)).id;
        const knowledgeBaseId =
          executionContext?.knowledge_base_id !== undefined
            ? executionContext.knowledge_base_id
            : executionContext?.knowledgeBaseId;
        const autoRetrieval =
          executionContext?.auto_retrieval !== undefined
            ? executionContext.auto_retrieval
            : executionContext?.autoRetrieval;
        const snapshot = await sendThreadCommand(
          threadId,
          expertPanel
            ? {
                type: "user_message",
                content: trimmedContent,
                expert_panel: expertPanel,
                ...(knowledgeBaseId !== undefined
                  ? { knowledge_base_id: knowledgeBaseId }
                  : {}),
                ...(autoRetrieval !== undefined
                  ? { auto_retrieval: autoRetrieval }
                  : {}),
              }
            : {
                type: "user_message",
                content: trimmedContent,
                ...(knowledgeBaseId !== undefined
                  ? { knowledge_base_id: knowledgeBaseId }
                  : {}),
                ...(autoRetrieval !== undefined
                  ? { auto_retrieval: autoRetrieval }
                  : {}),
              },
          auth,
        );

        setSelectedThreadId(snapshot.id);
        setSelectedThread(snapshot);
        setThreads((current) => mergeThreadSummary(current, snapshot));
        return snapshot;
      } catch (nextError) {
        const message = toErrorMessage(nextError);
        setError(message);
        throw new Error(message);
      } finally {
        setSending(false);
      }
    },
    [auth, createEmptyThread, selectedThreadId],
  );

  const uploadFilesToPersonalSource = useCallback(
    async (files: File[]) => {
      const normalizedFiles = files.filter((file) => file.size >= 0);
      if (!normalizedFiles.length) {
        throw new Error("请选择要上传的资料。");
      }

      setUploading(true);
      setError(null);

      try {
        let nextKnowledgeBases = knowledgeBases;
        let nextDataSources = dataSources;

        let targetKnowledgeBase =
          nextKnowledgeBases.find((item) => item.name === PERSONAL_KB_NAME) ?? null;

        if (!targetKnowledgeBase) {
          targetKnowledgeBase = await createKnowledgeBase(
            {
              name: PERSONAL_KB_NAME,
              description: "当前用户的个人上传资料空间",
            },
            auth,
          );
          nextKnowledgeBases = [targetKnowledgeBase, ...nextKnowledgeBases];
          setKnowledgeBases(nextKnowledgeBases);
        }
        setSelectedKnowledgeBaseId(targetKnowledgeBase.id);

        let targetSource =
          nextDataSources.find(
            (item) =>
              item.kind === "upload" &&
              item.knowledge_base_id === targetKnowledgeBase?.id &&
              item.name === PERSONAL_UPLOAD_SOURCE_NAME,
          ) ?? null;

        if (!targetSource) {
          targetSource = await createDataSource(
            {
              knowledge_base_id: targetKnowledgeBase.id,
              name: PERSONAL_UPLOAD_SOURCE_NAME,
              kind: "upload",
              description: "用户上传的私有资料",
            },
            auth,
          );
          nextDataSources = [targetSource, ...nextDataSources];
          setDataSources(nextDataSources);
        }

        for (const file of normalizedFiles) {
          await uploadDataSourceFile(targetSource.id, file, auth);
        }

        await refreshDataSources();
      } catch (nextError) {
        const message = toErrorMessage(nextError);
        setError(message);
        throw new Error(message);
      } finally {
        setUploading(false);
      }
    },
    [auth, dataSources, knowledgeBases, refreshDataSources],
  );

  const expertSkills = useMemo(() => mergeExpertSkills(skills), [skills]);

  return {
    auth,
    authSession,
    config,
    projects,
    knowledgeBases,
    dataSources,
    threads,
    selectedKnowledgeBaseId,
    selectedThreadId,
    selectedThread,
    expertSkills,
    loading,
    threadLoading,
    sending,
    uploading,
    error,
    refreshSession,
    refreshSelectedThread,
    selectThread,
    selectKnowledgeBase: setSelectedKnowledgeBaseId,
    createEmptyThread,
    sendUserMessage,
    uploadFilesToPersonalSource,
  };
}
