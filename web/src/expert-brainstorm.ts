import type { ExpertPanelContext, SkillSummary } from "./types";

export const EXPERT_SKILL_NAMES = [
  "mearsheimer",
  "kissinger",
  "brzezinski",
  "nye",
  "huntington",
  "allison",
  "yan-xuetong",
] as const;

export type ExpertSkillName = (typeof EXPERT_SKILL_NAMES)[number];

export const BUILTIN_EXPERT_SKILLS: SkillSummary[] = EXPERT_SKILL_NAMES.map((name) => ({
  name,
  description: `${expertDisplayName(name)}视角`,
  tags: ["expert", "expert-brainstorm"],
  starter_prompt: null,
  scope: "workspace",
  updated_at_ms: null,
}));

export function isExpertSkill(skill: Pick<SkillSummary, "name" | "tags">): boolean {
  const name = skill.name.trim().toLowerCase();
  if (EXPERT_SKILL_NAMES.includes(name as ExpertSkillName)) {
    return true;
  }
  return skill.tags.some((tag) => tag.trim().toLowerCase() === "expert");
}

export function expertDisplayName(skillName: string): string {
  switch (skillName.trim().toLowerCase()) {
    case "mearsheimer":
      return "米尔斯海默";
    case "kissinger":
      return "基辛格";
    case "brzezinski":
      return "布热津斯基";
    case "nye":
      return "约瑟夫·奈";
    case "huntington":
      return "亨廷顿";
    case "allison":
      return "艾利森";
    case "yan-xuetong":
      return "阎学通";
    default:
      return skillName;
  }
}

function buildExpertPanelId(): string {
  if (typeof crypto !== "undefined" && "randomUUID" in crypto) {
    return `expert-panel-${crypto.randomUUID().slice(0, 8)}`;
  }
  return `expert-panel-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

export function buildExpertPanelContext(
  selectedExperts: Array<Pick<SkillSummary, "name" | "description" | "scope">>,
): ExpertPanelContext {
  const panelId = buildExpertPanelId();
  const experts = selectedExperts.length
    ? selectedExperts
    : [{ name: "mearsheimer", description: null, scope: "workspace" as const }];

  return {
    panel_id: panelId,
    master_skill: "expert-brainstorm",
    experts: experts.map((skill) => ({
      skill: skill.name,
      scope: skill.scope,
      label: expertDisplayName(skill.name),
      description: skill.description?.trim() || null,
    })),
  };
}

export function buildExpertBrainstormPrompt(context: ExpertPanelContext): string {
  const expertLines = context.experts.map((skill, index) => {
    const suffix = skill.description?.trim() ? `：${skill.description.trim()}` : "";
    return `${index + 1}. ${skill.label}（${skill.scope}:${skill.skill}）${suffix}`;
  });

  return [
    `请使用 \`${context.master_skill}\` 组织一次专家会诊，围绕我接下来给出的议题进行分析。`,
    "",
    `本轮会诊编号：${context.panel_id}`,
    "",
    "本轮指定专家：",
    ...expertLines,
    "",
    "执行要求：",
    `1. 先加载 \`${context.master_skill}\` 技能，再逐位加载上面列出的专家技能。`,
    "2. 每位专家都必须独立检索当前会话已接入的资料，优先使用 Elasticsearch；如果同时有上传文档、网页或数据库，也可作为补充证据。",
    "3. 每位专家先给出自己的独立判断，再进入交叉辩论，不要把不同专家混成一段。",
    `4. 每位专家的输出请单独整理为结果卡，标题使用“专家视角 / 专家名”，并在 ArtifactEmit.metadata 中写入 {"group":"expert_view","expert_name":"专家名","panel":"${context.panel_id}"}。`,
    `5. 每位专家完成后，再调用 ExpertPanelEmit，panel_id 固定使用 "${context.panel_id}"，并至少写入 expert_name、summary、artifact_id、status。`,
    `6. 最后再汇总输出“共识 / 分歧地图”和“综合结论 / 行动建议”；综合结论的 metadata 使用 {"group":"expert_summary","panel":"${context.panel_id}"}，共识分歧类结果使用 {"group":"expert_consensus","panel":"${context.panel_id}"}，并同步调用 ExpertPanelEmit 记录最终阶段。`,
    "7. 不要伪造专家原话、现实参会或真实背书；所有内容都应表达为分析视角。",
    "8. 不要向用户展示后台路径、内部调试过程或原始工具返回。",
    "",
    "我接下来会补充具体议题；如果我的消息里已经包含议题，请直接开始。",
  ].join("\n");
}
