---
name: report-table-chart
description: 把检索和分析结果整理为文本、Markdown、表格、图表或关系图并稳定渲染到前端。
tags: 报告, 图表, 结构化结果
starter_prompt: 请围绕当前主题检索资料，并把结果整理成适合页面渲染的 Markdown、表格、图表或关系图。
---

# 何时使用

当用户明确要求结果以表格、图表、关系图或 Markdown 报告形式输出时使用。

# 输入约束

- 先确认用户要的是对比、趋势、分布、关系还是正文报告。
- 如果用户没指定，按信息结构自动选最合适的 artifact 类型。

# 工作步骤

1. 先通过 `MemorySearch` 查找已有口径，避免重复定义指标或字段。
2. 收集证据，按已接入来源选择 `SourceSearch` / `SourceRead`、`EsSearch`、`WebFetch` 或 `DbQuery`。
3. 先形成规范化数据结构，再决定是否调用 `ArtifactEmit`。
4. 输出前调用 `TopicDriftCheck`，避免图表或表格表达偏离主题。
5. 对稳定规则或指标口径调用 `MemoryWrite` 做长期沉淀。

# Artifact 选择规则

- 对比多个来源或条目：`table`
- 展示趋势、分布、占比：`chart`
- 展示实体关联、依赖、引用链：`graph`
- 输出长段说明和小节结构：`markdown`
- 只需一句结果：`text`

# 输出要求

- `table` payload 只放结构化列和行，不混入长段 prose。
- `chart` payload 使用稳定字段名，避免一列一义的临时命名。
- `graph` payload 中节点和边都要有稳定 `id` 或关系字段。
- 如果 artifact 已足够表达，不要再重复一遍同长度自然语言。

# 记忆策略

- 把稳定指标口径、分类定义和复用价值高的结论写入 `workspace` 或 `tenant`。
- 不把一次性渲染细节写进长期记忆。

# 禁止事项

- 不要把工具原始 JSON 原封不动展示给用户。
- 不要输出字段名混乱的图表 payload。
- 不要为了视觉效果伪造数据点。
