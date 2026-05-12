export type SkillDraftIssue = {
  severity: "warning" | "tip";
  message: string;
};

const SKILL_NAME_PATTERN = /^[A-Za-z0-9_-]{1,64}$/;
const RECOMMENDED_SECTIONS = [
  "何时使用",
  "输入约束",
  "工作步骤",
  "输出要求",
  "记忆策略",
] as const;
const OPTIONAL_SECTIONS = ["偏题控制", "禁止事项"] as const;
const UNSUPPORTED_TOOL_NAMES = [
  "bash",
  "Bash",
  "shell",
  "terminal",
  "curl",
  "wget",
  "write_file",
  "edit_file",
  "WebSearch",
  "Agent",
  "WorkerCreate",
  "TaskCreate",
] as const;
const RETRIEVAL_TOOL_NAMES = [
  "SourceSearch",
  "SourceRead",
  "EsSearch",
  "WebFetch",
  "DbQuery",
  "read_file",
  "glob_search",
  "grep_search",
] as const;
const SERVER_DETAIL_PATTERN =
  /\bworkspace_root\b|\bCLAWD_[A-Z0-9_]+\b|\btenant_id\b|\bapi_key\b|\bSKILL\.md\b|\/Users\/|\/home\/|[A-Za-z]:\\/;
const EXPERT_QUOTE_RISK_PATTERN =
  /原话|逐字|访谈内容|内部消息|私下表态|真实背书|参加当前会议|亲自发言/;

function normalizePrompt(prompt: string): string {
  return prompt.replace(/\r\n/g, "\n");
}

function hasSection(prompt: string, heading: string): boolean {
  const pattern = new RegExp(`^#{1,6}\\s+${heading}\\s*$`, "m");
  return pattern.test(prompt);
}

export function extractSkillBody(prompt: string): string {
  const normalized = normalizePrompt(prompt);
  const lines = normalized.split("\n");

  if (lines[0]?.trim() !== "---") {
    return normalized.trim();
  }

  for (let index = 1; index < lines.length; index += 1) {
    if (lines[index]?.trim() === "---") {
      return lines.slice(index + 1).join("\n").trim();
    }
  }

  return normalized.trim();
}

export function validateSkillDraft(draft: {
  name: string;
  description: string;
  starterPrompt: string;
  prompt: string;
}): SkillDraftIssue[] {
  const issues: SkillDraftIssue[] = [];
  const name = draft.name.trim();
  const description = draft.description.trim();
  const starterPrompt = draft.starterPrompt.trim();
  const prompt = normalizePrompt(draft.prompt).trim();

  if (!name) {
    issues.push({
      severity: "warning",
      message: "需要填写技能名称，且名称只能使用 ASCII 字母、数字、`-`、`_`。",
    });
  } else if (!SKILL_NAME_PATTERN.test(name)) {
    issues.push({
      severity: "warning",
      message: "技能名称不符合当前后端约束：只允许 ASCII 字母、数字、`-`、`_`，最长 64 字符。",
    });
  }

  if (!description) {
    issues.push({
      severity: "tip",
      message: "建议补一句说明，方便技能库筛选、推荐和会话入口提示。",
    });
  }

  if (!starterPrompt) {
    issues.push({
      severity: "tip",
      message: "建议提供起手提示，这样可以直接用于新会话起手或填充当前对话。",
    });
  }

  if (!prompt) {
    issues.push({
      severity: "warning",
      message: "需要填写技能正文，至少覆盖工作步骤和输出要求。",
    });
    return issues;
  }

  const missingSections = RECOMMENDED_SECTIONS.filter(
    (heading) => !hasSection(prompt, heading),
  );
  if (missingSections.length) {
    issues.push({
      severity: "tip",
      message: `建议补齐标准章节：${missingSections.join("、")}。`,
    });
  }

  const missingOptionalSections = OPTIONAL_SECTIONS.filter(
    (heading) => !hasSection(prompt, heading),
  );
  if (missingOptionalSections.length === OPTIONAL_SECTIONS.length) {
    issues.push({
      severity: "tip",
      message: "建议补 `偏题控制` 或 `禁止事项`，避免模型把内部推演和调试过程暴露给用户。",
    });
  }

  const unsupportedTools = UNSUPPORTED_TOOL_NAMES.filter((toolName) =>
    new RegExp(`\\b${toolName}\\b`).test(prompt),
  );
  if (unsupportedTools.length) {
    issues.push({
      severity: "warning",
      message: `当前 Web Agent 技能不能假设这些工具可用：${unsupportedTools.join(", ")}。`,
    });
  }

  if (SERVER_DETAIL_PATTERN.test(prompt)) {
    issues.push({
      severity: "warning",
      message: "技能正文不要绑定服务器路径、环境变量、租户 ID 或密钥等后台细节，应使用“资料库 / 资料来源 / 团队”这类产品语义。",
    });
  }

  if (EXPERT_QUOTE_RISK_PATTERN.test(prompt)) {
    issues.push({
      severity: "warning",
      message: "如果使用专家、历史人物或学派视角，不能伪造成真实原话、内部消息、现实背书或真实参会发言。",
    });
  }

  if (/\{\{[^}]+\}\}|\$\{[^}]+\}/.test(prompt)) {
    issues.push({
      severity: "warning",
      message: "当前附加参数只会原样回显，不会做模板变量替换，请不要依赖 `{{var}}` 或 `${var}`。",
    });
  }

  const hasRetrievalStep = RETRIEVAL_TOOL_NAMES.some((toolName) =>
    new RegExp(`\\b${toolName}\\b`).test(prompt),
  );
  if (!hasRetrievalStep) {
    issues.push({
      severity: "tip",
      message: "建议写清资料获取方式，例如上传文档检索、网页读取、ES 检索、数据库只读查询或受控文件读取。",
    });
  }

  if (!/\bTopicDriftCheck\b/.test(prompt)) {
    issues.push({
      severity: "tip",
      message: "建议把 `TopicDriftCheck` 写入工作步骤或偏题控制，确保长链研究过程中持续收束主题。",
    });
  }

  if (!/\bMemoryWrite\b/.test(prompt)) {
    issues.push({
      severity: "tip",
      message: "建议说明哪些稳定结论可以写入记忆，哪些临时过程不能沉淀，避免多人使用时污染资料口径。",
    });
  }

  if (!/\bArtifactEmit\b/.test(prompt) && !hasSection(prompt, "Artifact 选择规则")) {
    issues.push({
      severity: "tip",
      message: "建议明确何时调用 `ArtifactEmit`，避免最后只能返回一段难复用的纯文本。",
    });
  }

  if (!/不要.*(调试|原始|内部|工具)|不展示.*(调试|原始|内部|工具)/.test(prompt)) {
    issues.push({
      severity: "tip",
      message: "建议在禁止事项中明确：不要向用户展示原始工具返回、内部调试信息或后台执行细节。",
    });
  }

  if (prompt.length > 80_000) {
    issues.push({
      severity: "warning",
      message: "技能正文过长，建议拆成多个技能；过长指令会挤占模型上下文并增加运行失败概率。",
    });
  }

  return issues;
}

export function hasBlockingSkillDraftIssues(issues: SkillDraftIssue[]): boolean {
  return issues.some((issue) => issue.severity === "warning");
}
