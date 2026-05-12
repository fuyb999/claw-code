import { FormEvent, useEffect, useMemo, useState } from "react";

import { deleteSkill, getSkill, listSkills, saveSkill } from "./api";
import {
  SKILL_TEMPLATES,
  WEB_SKILL_RUNTIME_GUIDE,
  type SkillTemplate,
} from "./skill-templates";
import { presentSkillReference, presentSkillScope } from "./presentation";
import {
  extractSkillBody,
  hasBlockingSkillDraftIssues,
  validateSkillDraft,
  type SkillDraftIssue,
} from "./skills";
import type { RequestAuth, SkillDetail, SkillScope, SkillSummary } from "./types";

type SkillsPanelProps = {
  auth: RequestAuth | null;
  hasSelectedThread: boolean;
  tenantAvailable: boolean;
  projectId?: string;
  workspaceRoot: string;
  onError: (message: string) => void;
  onUseStarterPromptInCurrentThread?: (prompt: string, skillName: string) => void;
  onUseStarterPromptForNewThread?: (
    prompt: string,
    skillName: string,
    description: string | null | undefined,
  ) => void;
};

function formatTime(epochMs: number | null): string {
  if (!epochMs) {
    return "刚刚更新";
  }

  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    month: "2-digit",
    day: "2-digit",
  }).format(epochMs);
}

function defaultScope(tenantAvailable: boolean): SkillScope {
  return tenantAvailable ? "tenant" : "workspace";
}

const SKILL_TAG_LABELS = new Map<string, string>([
  ["artifact", "结构化结果"],
  ["chart", "图表"],
  ["deep-research", "深度研究"],
  ["drift-check", "防偏题"],
  ["evidence", "证据"],
  ["report", "报告"],
  ["summary", "总结"],
  ["synthesis", "综合分析"],
  ["workspace", "资料集"],
]);

function presentSkillTag(tag: string): string {
  const normalized = tag.trim();
  return SKILL_TAG_LABELS.get(normalized.toLowerCase()) ?? normalized.replace(/[-_]+/g, " ");
}

function skillReadinessLabel(issues: SkillDraftIssue[]): string {
  const warningCount = issues.filter((issue) => issue.severity === "warning").length;
  const tipCount = issues.length - warningCount;
  if (warningCount) {
    return `${warningCount} 项需修正`;
  }
  if (tipCount) {
    return `${tipCount} 项可优化`;
  }
  return "结构完整";
}

export function SkillsPanel({
  auth,
  hasSelectedThread,
  tenantAvailable,
  projectId,
  workspaceRoot,
  onError,
  onUseStarterPromptInCurrentThread,
  onUseStarterPromptForNewThread,
}: SkillsPanelProps) {
  const workspaceContextAvailable = Boolean(projectId || workspaceRoot.trim());
  const [skills, setSkills] = useState<SkillSummary[]>([]);
  const [loading, setLoading] = useState(false);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [selectedKey, setSelectedKey] = useState<string | null>(null);
  const [skillQuery, setSkillQuery] = useState("");
  const [name, setName] = useState("");
  const [scope, setScope] = useState<SkillScope>(defaultScope(tenantAvailable));
  const [description, setDescription] = useState("");
  const [tagsText, setTagsText] = useState("");
  const [starterPrompt, setStarterPrompt] = useState("");
  const [prompt, setPrompt] = useState("");

  useEffect(() => {
    setScope((current) =>
      current === "tenant" && !tenantAvailable ? "workspace" : current,
    );
  }, [tenantAvailable]);

  useEffect(() => {
    if (!auth) {
      setSkills([]);
      return;
    }

    let cancelled = false;
    setLoading(true);
    void listSkills({ projectId, workspaceRoot: workspaceContextAvailable ? workspaceRoot || undefined : undefined }, auth)
      .then((items) => {
        if (!cancelled) {
          setSkills(items);
        }
      })
      .catch((cause) => {
        if (!cancelled) {
          onError(cause instanceof Error ? cause.message : String(cause));
        }
      })
      .finally(() => {
        if (!cancelled) {
          setLoading(false);
        }
      });

    return () => {
      cancelled = true;
    };
  }, [auth, onError, projectId, workspaceContextAvailable, workspaceRoot]);

  const selectedSkill = useMemo(
    () => skills.find((item) => `${item.scope}:${item.name}` === selectedKey) ?? null,
    [selectedKey, skills],
  );
  const draftIssues = useMemo(
    () => validateSkillDraft({ name, description, starterPrompt, prompt }),
    [description, name, prompt, starterPrompt],
  );
  const hasBlockingIssues = hasBlockingSkillDraftIssues(draftIssues);
  const filteredSkills = useMemo(() => {
    const query = skillQuery.trim().toLowerCase();
    if (!query) {
      return skills;
    }

    return skills.filter((skill) => {
      const haystacks = [
        skill.name,
        skill.description ?? "",
        skill.starter_prompt ?? "",
        ...skill.tags,
      ];
      return haystacks.some((value) => value.toLowerCase().includes(query));
    });
  }, [skillQuery, skills]);

  function resetEditor() {
    setSelectedKey(null);
    setName("");
    setScope(defaultScope(tenantAvailable));
    setDescription("");
    setTagsText("");
    setStarterPrompt("");
    setPrompt("");
  }

  function applyTemplate(template: SkillTemplate) {
    setSelectedKey(null);
    setName(template.defaultName);
    setScope((current) =>
      current === "tenant" && !tenantAvailable ? "workspace" : current,
    );
    setDescription(template.defaultDescription);
    setTagsText(template.defaultTags.join(", "));
    setStarterPrompt(template.defaultStarterPrompt);
    setPrompt(template.prompt);
  }

  async function loadSkillDetail(skill: SkillSummary) {
    if (!auth) {
      return;
    }

    try {
      const detail: SkillDetail = await getSkill(
        skill.name,
        {
          scope: skill.scope,
          projectId,
          workspaceRoot: workspaceContextAvailable ? workspaceRoot || undefined : undefined,
        },
        auth,
      );
      setSelectedKey(`${skill.scope}:${skill.name}`);
      setName(detail.name);
      setScope(detail.scope);
      setDescription(detail.description ?? "");
      setTagsText(detail.tags.join(", "));
      setStarterPrompt(detail.starter_prompt ?? "");
      setPrompt(extractSkillBody(detail.prompt));
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function handleSave(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (!auth) {
      return;
    }

    setSaving(true);
    try {
      const saved = await saveSkill(
        {
          name,
          scope,
          description: description.trim() || undefined,
          tags: tagsText
            .split(",")
            .map((tag) => tag.trim())
            .filter(Boolean),
          starter_prompt: starterPrompt.trim() || undefined,
          prompt,
          project_id: scope === "workspace" ? projectId || undefined : undefined,
          workspace_root:
            scope === "workspace" && workspaceContextAvailable ? workspaceRoot || undefined : undefined,
        },
        auth,
      );
      const items = await listSkills(
        {
          projectId,
          workspaceRoot: workspaceContextAvailable ? workspaceRoot || undefined : undefined,
        },
        auth,
      );
      setSkills(items);
      setSelectedKey(`${saved.scope}:${saved.name}`);
      setName(saved.name);
      setScope(saved.scope);
      setDescription(saved.description ?? "");
      setTagsText(saved.tags.join(", "));
      setStarterPrompt(saved.starter_prompt ?? "");
      setPrompt(extractSkillBody(saved.prompt));
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  }

  async function handleCopyStarterPrompt() {
    if (!starterPrompt.trim() || typeof navigator === "undefined" || !navigator.clipboard) {
      return;
    }

    try {
      await navigator.clipboard.writeText(starterPrompt.trim());
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause));
    }
  }

  async function handleDeleteSkill() {
    if (!auth || !selectedSkill) {
      return;
    }

    if (
      typeof window !== "undefined" &&
      !window.confirm(
        `确认删除技能 ${presentSkillReference(`${selectedSkill.scope}:${selectedSkill.name}`)} 吗？`,
      )
    ) {
      return;
    }

    setDeleting(true);
    try {
      await deleteSkill(
        selectedSkill.name,
        {
          scope: selectedSkill.scope,
          projectId,
          workspaceRoot: workspaceContextAvailable ? workspaceRoot || undefined : undefined,
        },
        auth,
      );
      const items = await listSkills(
        {
          projectId,
          workspaceRoot: workspaceContextAvailable ? workspaceRoot || undefined : undefined,
        },
        auth,
      );
      setSkills(items);
      resetEditor();
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setDeleting(false);
    }
  }

  return (
    <article className="card skills-card">
      <header className="skills-panel-header">
        <div>
          <div className="section-title">自定义技能</div>
          <p className="artifact-hint">
            把高频分析方式保存成可复用流程。技能可以用于当前对话，也可以作为新会话的起手模板。
          </p>
        </div>
        <button className="secondary" onClick={resetEditor} type="button">
          新建技能
        </button>
      </header>
      <div className="skills-section-stack">
        <section>
          <div className="section-title">推荐流程</div>
          <div className="skill-template-grid">
            {SKILL_TEMPLATES.map((template) => (
              <article className="skill-template-card" key={template.id}>
                <header>
                  <div>
                    <strong>{template.label}</strong>
                    <span>{template.summary}</span>
                  </div>
                  <span className="scope-pill scope-workspace">模板</span>
                </header>
                <div className="skill-template-meta">
                  <span>适合：{template.recommendedFor}</span>
                  <span>输出：{template.outputModes.join(" / ")}</span>
                </div>
                <button
                  className="secondary"
                  onClick={() => applyTemplate(template)}
                  type="button"
                >
                  应用模板
                </button>
              </article>
            ))}
          </div>
        </section>

        <details className="skill-advanced-guide">
          <summary>高级规则与运行边界</summary>
          <div className="skill-runtime-grid">
            {WEB_SKILL_RUNTIME_GUIDE.map((section) => (
              <article className="skill-runtime-card" key={section.title}>
                <strong>{section.title}</strong>
                {section.description ? <p>{section.description}</p> : null}
                <div className="tags">
                  {section.items.map((item) => (
                    <span key={`${section.title}-${item}`}>{item}</span>
                  ))}
                </div>
              </article>
            ))}
          </div>
        </details>
      </div>

      {!auth ? (
        <div className="empty-state">完成认证后可查看和维护技能。</div>
      ) : (
        <>
          <div className="skills-toolbar">
            <div>
              <strong>我的技能</strong>
              <span className="input-hint">
                {tenantAvailable ? "可保存到当前资料集或团队" : "当前仅保存到资料集"}
              </span>
            </div>
            <input
              onChange={(event) => setSkillQuery(event.target.value)}
              placeholder="搜索技能或说明"
              value={skillQuery}
            />
          </div>

          {loading ? (
            <div className="empty-state">加载技能中…</div>
          ) : filteredSkills.length ? (
            <div className="skills-list">
              {filteredSkills.map((skill) => {
                const key = `${skill.scope}:${skill.name}`;
                return (
                  <button
                    className={`skill-item ${selectedKey === key ? "active" : ""}`}
                    key={key}
                    onClick={() => void loadSkillDetail(skill)}
                    type="button"
                  >
                    <div>
                      <strong>{skill.name}</strong>
                      <span>{skill.description ?? "无描述"}</span>
                      {skill.tags.length ? (
                        <div className="tags">
                          {skill.tags.slice(0, 4).map((tag) => (
                            <span key={tag}>{presentSkillTag(tag)}</span>
                          ))}
                        </div>
                      ) : null}
                    </div>
                    <div className="skill-meta">
                      <span className={`scope-pill scope-${skill.scope}`}>
                        {presentSkillScope(skill.scope)}
                      </span>
                      <span>{formatTime(skill.updated_at_ms)}</span>
                    </div>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="empty-state">
              {skills.length ? "没有匹配当前搜索条件的技能。" : "当前资料集下还没有可用技能。"}
            </div>
          )}

          <form className="stack-form skill-editor" onSubmit={handleSave}>
            <div className="skill-editor-header">
              <div>
                <div className="section-title">编辑技能</div>
                <p>
                  只描述这个技能该如何检索、分析、输出和沉淀记忆，不要写服务器路径、调试命令或密钥。
                </p>
              </div>
              <span className={`skill-readiness ${hasBlockingIssues ? "needs-fix" : "ready"}`}>
                {skillReadinessLabel(draftIssues)}
              </span>
            </div>
            <label>
              技能名称
              <input
                onChange={(event) => setName(event.target.value)}
                placeholder="例如 evidence-map"
                value={name}
              />
              <span className="input-hint">用于系统识别，只允许英文、数字、短横线或下划线。</span>
            </label>
            <label>
              保存位置
              <select
                onChange={(event) => setScope(event.target.value as SkillScope)}
                value={scope}
              >
                <option value="workspace">当前资料集</option>
                {tenantAvailable ? <option value="tenant">团队</option> : null}
              </select>
            </label>
            <label>
              说明
              <input
                onChange={(event) => setDescription(event.target.value)}
                placeholder="简短描述这个技能适合解决什么问题"
                value={description}
              />
            </label>
            <label>
              关键词
              <input
                onChange={(event) => setTagsText(event.target.value)}
                placeholder="可选：用于搜索，例如 研究, 报告, 图表"
                value={tagsText}
              />
            </label>
            <label>
              起手提示
              <textarea
                onChange={(event) => setStarterPrompt(event.target.value)}
                placeholder="给这个技能一个推荐起手提示词，后续可作为模板入口使用。"
                rows={3}
                value={starterPrompt}
              />
            </label>
            <label>
              执行流程
              <textarea
                onChange={(event) => setPrompt(event.target.value)}
                placeholder="写清何时使用、资料获取方式、工作步骤、输出要求、记忆策略、偏题控制和禁止事项。"
                rows={10}
                value={prompt}
              />
            </label>
            <div className="input-hint">保存时会自动生成名称、说明等元信息；这里只写执行流程。</div>
            <section className="skill-checklist">
              <header>
                <strong>发布前检查</strong>
                <span>{draftIssues.length ? skillReadinessLabel(draftIssues) : "已符合推荐结构"}</span>
              </header>
              {draftIssues.length ? (
                <div className="skill-check-items">
                  {draftIssues.map((issue, index) => (
                    <article
                      className={`skill-check-item severity-${issue.severity}`}
                      key={`${issue.severity}-${index}`}
                    >
                      <strong>{issue.severity === "warning" ? "需要修正" : "建议补充"}</strong>
                      <p>{issue.message}</p>
                    </article>
                  ))}
                </div>
              ) : (
                <div className="skill-check-item severity-pass">
                  <strong>可直接保存</strong>
                  <p>
                    当前草稿已经符合推荐结构，并且没有发现与当前 Web Agent 能力边界冲突的假设。
                  </p>
                </div>
              )}
            </section>
            {starterPrompt.trim() ? (
              <div className="inline-actions">
                {hasSelectedThread ? (
                  <button
                    className="secondary"
                    onClick={() =>
                      onUseStarterPromptInCurrentThread?.(starterPrompt, name || "skill")
                    }
                    type="button"
                  >
                    放入当前对话
                  </button>
                ) : null}
                <button
                  className="secondary"
                  onClick={() =>
                    onUseStarterPromptForNewThread?.(starterPrompt, name || "skill", description)
                  }
                  type="button"
                >
                  用于新会话
                </button>
                <button className="secondary" onClick={() => void handleCopyStarterPrompt()} type="button">
                  复制起手提示
                </button>
              </div>
            ) : null}
            {scope === "workspace" && !projectId && !workspaceRoot ? (
              <div className="empty-state">先选择一个资料库，才能保存资料集级技能。</div>
            ) : null}
            {selectedSkill ? (
              <div className="inline-actions">
                <span className="input-hint">
                  正在编辑：{presentSkillReference(`${selectedSkill.scope}:${selectedSkill.name}`)}
                </span>
                <button
                  className="secondary danger-ghost"
                  disabled={deleting}
                  onClick={() => void handleDeleteSkill()}
                  type="button"
                >
                  {deleting ? "删除中…" : "删除技能"}
                </button>
              </div>
            ) : null}
            <button
              disabled={
                saving ||
                deleting ||
                !name.trim() ||
                !prompt.trim() ||
                hasBlockingIssues ||
                (scope === "workspace" && !projectId && !workspaceRoot.trim())
              }
              type="submit"
            >
              {saving ? "保存中…" : "保存技能"}
            </button>
          </form>
        </>
      )}
    </article>
  );
}
