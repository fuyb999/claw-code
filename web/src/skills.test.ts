import { describe, expect, it } from "vitest";

import {
  extractSkillBody,
  hasBlockingSkillDraftIssues,
  validateSkillDraft,
} from "./skills";
import {
  buildExpertPanelContext,
  buildExpertBrainstormPrompt,
  expertDisplayName,
  isExpertSkill,
} from "./expert-brainstorm";

describe("extractSkillBody", () => {
  it("strips the top-level frontmatter from a saved skill file", () => {
    expect(
      extractSkillBody(`---
name: evidence-scan
description: scan evidence
---

# Steps

1. Search first.`),
    ).toBe(`# Steps

1. Search first.`);
  });

  it("returns the original trimmed prompt when no frontmatter exists", () => {
    expect(extractSkillBody("  Just the body.  ")).toBe("Just the body.");
  });

  it("flags unsupported tools and template placeholders", () => {
    const issues = validateSkillDraft({
      name: "bad skill",
      description: "",
      starterPrompt: "",
      prompt: `# 工作步骤

1. 使用 bash 和 write_file。
2. 渲染 {{topic}} 与 \${scope}。`,
    });

    expect(issues.some((issue) => issue.message.includes("技能名称不符合"))).toBe(true);
    expect(issues.some((issue) => issue.message.includes("bash, write_file"))).toBe(
      true,
    );
    expect(issues.some((issue) => issue.message.includes("模板变量替换"))).toBe(true);
    expect(hasBlockingSkillDraftIssues(issues)).toBe(true);
  });

  it("accepts a standard web skill draft without warnings", () => {
    const issues = validateSkillDraft({
      name: "evidence-map",
      description: "围绕主题检索证据并输出结构化结论。",
      starterPrompt: "请围绕当前主题检索证据并输出结果。",
      prompt: `# 何时使用

当用户需要围绕明确主题检索证据并给出稳定总结时使用。

# 输入约束

- 主题优先来自当前请求。

# 工作步骤

1. 先调用 \`MemorySearch\`。
2. 再调用 \`SourceSearch\`、\`SourceRead\`、\`EsSearch\` 与 \`WebFetch\`。
3. 形成阶段性结论前调用 \`TopicDriftCheck\`。
4. 必要时调用 \`ArtifactEmit\`。
5. 稳定结论调用 \`MemoryWrite\`。

# 输出要求

- 默认返回简洁结论。

# 记忆策略

- 只写稳定结论。

# 禁止事项

- 不展示原始工具返回、后台路径或内部调试输出。`,
    });

    expect(issues).toEqual([]);
  });

  it("allows connected web and database tools in web skills", () => {
    const issues = validateSkillDraft({
      name: "multi-source-answer",
      description: "根据问题自动选择网页和数据库来源回答。",
      starterPrompt: "请基于当前资料库回答我的问题。",
      prompt: `# 何时使用

当用户要求跨来源问答时使用。

# 输入约束

- 主题来自用户问题。

# 工作步骤

1. 先调用 \`MemorySearch\`。
2. 网页问题用 \`WebFetch\`。
3. 数据问题用 \`DbQuery\`。
4. 文档问题用 \`SourceSearch\` 与 \`SourceRead\`。
5. 输出前调用 \`TopicDriftCheck\`。
6. 稳定结论调用 \`MemoryWrite\`。
7. 必要时调用 \`ArtifactEmit\`。

# 输出要求

- 先回答结论，再列出来源。

# 记忆策略

- 只写稳定结论。

# 禁止事项

- 不展示原始工具返回、后台路径或内部调试信息。`,
    });

    expect(issues).toEqual([]);
  });

  it("flags server paths and backend configuration details", () => {
    const issues = validateSkillDraft({
      name: "path-bound-skill",
      description: "错误绑定服务器路径。",
      starterPrompt: "请读取服务器路径。",
      prompt: `# 工作步骤

1. 读取 /Users/fuyb/private 下的 workspace_root。
2. 使用 \`SourceSearch\`。
3. 调用 \`TopicDriftCheck\`。
4. 调用 \`MemoryWrite\`。
5. 调用 \`ArtifactEmit\`。`,
    });

    expect(issues.some((issue) => issue.message.includes("服务器路径"))).toBe(true);
    expect(hasBlockingSkillDraftIssues(issues)).toBe(true);
  });

  it("flags drafts that present expert personas as real quoted participants", () => {
    const issues = validateSkillDraft({
      name: "expert-brainstorm",
      description: "错误把专家视角写成真实发言。",
      starterPrompt: "请组织专家讨论。",
      prompt: `# 何时使用

当用户要求多专家讨论时使用。

# 输入约束

- 直接引用专家原话与访谈内容。

# 工作步骤

1. 先调用 \`MemorySearch\`。
2. 按真实参会发言方式重现他们的内部消息。
3. 调用 \`SourceSearch\`。
4. 调用 \`TopicDriftCheck\`。
5. 调用 \`MemoryWrite\`。
6. 调用 \`ArtifactEmit\`。

# 输出要求

- 逐字呈现专家原话。

# 记忆策略

- 只写稳定结论。`,
    });

    expect(issues.some((issue) => issue.message.includes("真实原话"))).toBe(true);
    expect(hasBlockingSkillDraftIssues(issues)).toBe(true);
  });
});

describe("expert-brainstorm helpers", () => {
  it("identifies expert skills by name or tag", () => {
    expect(
      isExpertSkill({
        name: "mearsheimer",
        tags: ["research"],
      }),
    ).toBe(true);
    expect(
      isExpertSkill({
        name: "custom-analyst",
        tags: ["expert", "investment"],
      }),
    ).toBe(true);
    expect(
      isExpertSkill({
        name: "basic-evidence-scan",
        tags: ["evidence"],
      }),
    ).toBe(false);
  });

  it("builds a structured launch prompt for selected experts", () => {
    const context = buildExpertPanelContext([
      {
        name: "mearsheimer",
        description: "评估结构性冲突。",
        scope: "workspace",
      },
      {
        name: "kissinger",
        description: "评估均势和交易空间。",
        scope: "tenant",
      },
    ]);
    const prompt = buildExpertBrainstormPrompt(context);

    expect(prompt).toContain("expert-brainstorm");
    expect(prompt).toContain("本轮会诊编号：expert-panel-");
    expect(prompt).toContain("米尔斯海默（workspace:mearsheimer）");
    expect(prompt).toContain("基辛格（tenant:kissinger）");
    expect(prompt).toContain("每位专家都必须独立检索");
    expect(prompt).toContain('"group":"expert_view"');
  });

  it("builds structured expert panel context", () => {
    const context = buildExpertPanelContext([
      {
        name: "yan-xuetong",
        description: "评估领导力与规则竞争。",
        scope: "workspace",
      },
    ]);

    expect(context.panel_id).toContain("expert-panel-");
    expect(context.master_skill).toBe("expert-brainstorm");
    expect(context.experts).toEqual([
      {
        skill: "yan-xuetong",
        scope: "workspace",
        label: "阎学通",
        description: "评估领导力与规则竞争。",
      },
    ]);
  });

  it("maps expert names to user-facing display names", () => {
    expect(expertDisplayName("yan-xuetong")).toBe("阎学通");
    expect(expertDisplayName("custom-analyst")).toBe("custom-analyst");
  });
});
