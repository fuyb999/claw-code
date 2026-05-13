import type {
  CreateExpertPanelRunRequest,
  SkillScope,
} from "./types";

export type ExpertRunDraftExpert = {
  skill: string;
  scope: SkillScope;
  label: string;
  description?: string | null;
};

export type BuildExpertRunRequestOptions = {
  question?: string;
  sourceMessageId?: string;
  knowledgeBaseId?: string;
  autoRetrieval?: boolean;
  experts: ExpertRunDraftExpert[];
  retryCount: number;
  concurrencyLimit: number;
};

function clampRetryCount(value: number): number {
  return Math.min(3, Math.max(0, Math.trunc(value || 0)));
}

function clampConcurrencyLimit(value: number): number {
  return Math.min(8, Math.max(1, Math.trunc(value || 1)));
}

export function buildExpertRunRequest(
  options: BuildExpertRunRequestOptions,
): CreateExpertPanelRunRequest {
  const question = options.question?.trim() || "";
  const sourceMessageId = options.sourceMessageId?.trim() || "";

  if (!options.experts.length) {
    throw new Error("请先选择至少一位专家。");
  }

  if (!question && !sourceMessageId) {
    throw new Error("请先提供问题或选择要继续会诊的消息。");
  }

  if (question && sourceMessageId) {
    throw new Error("问题和来源消息只能二选一。");
  }

  return {
    ...(question ? { question } : { source_message_id: sourceMessageId }),
    ...(options.knowledgeBaseId ? { knowledge_base_id: options.knowledgeBaseId } : {}),
    ...(options.autoRetrieval !== undefined ? { auto_retrieval: options.autoRetrieval } : {}),
    experts: options.experts.map((expert) => ({
      skill: expert.skill,
      scope: expert.scope,
      label: expert.label,
      description: expert.description,
    })),
    retry_count: clampRetryCount(options.retryCount),
    concurrency_limit: clampConcurrencyLimit(options.concurrencyLimit),
  };
}
