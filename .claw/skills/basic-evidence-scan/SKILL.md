---
name: basic-evidence-scan
description: 先查记忆，再检索 ES 和本地文件，输出基于证据的简明总结。
tags: evidence, summary, workspace
starter_prompt: 请围绕当前主题先检索证据，再输出一份基于证据的简明总结。
---

# 何时使用

当用户希望围绕一个明确主题做事实检索、文件阅读和简明总结时使用。

如果用户明确要求长链推演、持续校准偏题、反复重规划，改用更强的深度综合类 skill。

# 输入约束

- 主题优先来自当前用户请求。
- 如果 `Skill.args` 非空，把它当补充范围，不当模板变量。
- 如果用户限定了文档范围、目录范围或 ES 索引范围，优先遵守。

# 工作步骤

1. 先调用 `MemorySearch`，查询当前主题在 `workspace` 或 `all` 范围内是否已有稳定结论。
2. 再调用 `EsSearch` 获取候选证据，必要时限定 `fields` 和 `source_fields`。
3. 如需落到文件内容，使用 `glob_search`、`grep_search`、`read_file` 读取最相关文件。
4. 只基于实际命中的证据总结，不补齐未命中的事实。
5. 输出前用 `TopicDriftCheck` 检查总结是否仍围绕主题。
6. 如果结论稳定，调用 `MemoryWrite` 写入一条高价值结论。

# 输出要求

- 默认先给用户一段简洁结论。
- 如果有多条证据来源，补一个 Markdown 列表说明来源和结论映射。
- 只有在比较关系明显时再调用 `ArtifactEmit` 输出表格。

# 记忆策略

- 只写稳定结论，不写中间推测。
- 默认写入 `workspace`。
- 线程内短期提醒可写入 `thread`。

# 禁止事项

- 不要展示原始工具调试信息。
- 不要把 ES 未命中的内容写成事实。
- 不要为了凑完整而扩写无证据结论。
