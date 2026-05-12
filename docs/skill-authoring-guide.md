# Web Skill 编写规范

更新时间：2026-05-01

本文只针对当前 `clawd` 的多人 Web 服务 skill 能力，不沿用 CLI 全量 skill 心智。结论先说：

- 当前标准形态是单文件 `SKILL.md`
- 当前运行时会读取 `name`、`description`、`tags`、`starter_prompt`
- skill 本质上是“可复用工作流提示词”，不是带完整插件生命周期的扩展包

## 1. 当前后端真实契约

以 `rust/crates/clawd/src/main.rs` 当前实现为准：

- API：
  - `GET /v1/skills`
  - `GET /v1/skills/:name`
  - `POST /v1/skills`
  - `DELETE /v1/skills/:name`
- 名称约束：
  - 只允许 ASCII 字母、数字、`-`、`_`
  - 最长 64 字符
  - 可接受 `/skill-name`、`$skill-name`、`workspace:skill-name`、`tenant:skill-name`
- 解析约束：
  - 当前会解析 frontmatter 里的 `name`、`description`、`tags`、`starter_prompt`
  - `tags` 推荐写成逗号分隔单行
  - `starter_prompt` 当前用于 UI 和模板化入口，不改变 skill 执行本身
  - 正文整体作为 prompt body 返回给模型
- 解析结果：
  - `Skill` 工具返回 JSON：`skill`、`args`、`description`、`tags`、`starter_prompt`、`prompt`
  - `args` 当前只是原样回显，不会做模板变量替换
  - 不返回技能文件的服务器存储路径，避免模型上下文和用户回答泄露后台目录
- 可用工具边界：
  - 内置安全读工具：`read_file`、`glob_search`、`grep_search`
  - 资料源工具：`SourceSearch`、`SourceRead`、`WebFetch`、`DbQuery`、`EsSearch`
  - 服务自定义工具：`Skill`、`MemorySearch`、`MemoryWrite`、`TopicDriftCheck`、`ArtifactEmit`
- 作用域优先级：
  - 同名 skill 默认优先 `workspace`
  - 显式写 `tenant:<name>` 才会强制取 tenant skill

这意味着当前 Web skill 的标准不能假设：

- 有 shell、写文件、任意外网抓取
- 有 CLI 全局 skills 搜索路径
- 有复杂 metadata 驱动逻辑
- 有 skill `args` 占位符替换
- 让用户提供服务器目录、环境变量、租户 ID 或密钥

同时也意味着 skill 生命周期已经覆盖：

- 新建
- 编辑
- 删除

当前前端还新增了一个和 product 直接相关的落点：

- project 可以声明 `default_skill_names`
- 新线程创建时，这些技能名会进入运行时 system prompt，作为“优先加载的工作流”
- 推荐在 project 默认技能里写带 scope 的规范名，例如 `workspace:repo-map`、`tenant:report`
- 这些 project 默认技能现在可以在项目设置面板里反复编辑，前端会通过 `PATCH /v1/projects/:id` 保存
- 项目设置面板还会直接列出当前 workspace / tenant 下真实可见的技能，供用户选中后写回规范名
- 新建 project 时也会基于输入的 workspace 预览可见技能，帮助用户在创建阶段就选好 preferred skills
- 这里的语义仍然是“优先技能偏好”，不是“创建线程时自动强制执行”

但还没有：

- 版本历史
- 回滚
- 审批流
- 模板版本历史

## 2. 存储位置与作用域

### Workspace 级

查询时会从当前工作区下这些安全目录寻找 skill：

- `.claw/skills/<name>/SKILL.md`
- `.agents/skills/<name>/SKILL.md`
- `.codex/skills/<name>/SKILL.md`
- `.claude/skills/<name>/SKILL.md`
- `.omc/skills/<name>/SKILL.md`
- 兼容旧目录：
  - `.claw/commands/`
  - `.agents/commands/`
  - `.codex/commands/`
  - `.claude/commands/`
  - `.omc/commands/`

但通过 `POST /v1/skills` 保存 workspace skill 时，当前固定写入：

```text
<workspace_root>/.claw/skills/<name>/SKILL.md
```

并且 `workspace_root` 必须落在 `CLAWD_ALLOWED_ROOTS` 内。

### Tenant 级

tenant skill 保存到：

```text
<CLAWD_DATA_DIR>/tenants/<tenant_id>/skills/<name>/SKILL.md
```

tenant 级写入要求使用 tenant-scoped API key 鉴权。

## 3. 推荐标准格式

当前最稳妥的标准是：

```md
---
name: your_skill_name
description: 这个技能适合解决什么问题
tags: evidence, synthesis, report
starter_prompt: 请基于当前主题检索资料并产出结构化报告
---

# 何时使用

# 输入约束

# 工作步骤

# 输出要求

# 记忆策略

# 偏题控制

# 禁止事项
```

说明：

- `name` 用英文蛇形或短横线风格，不要中文名
- `description` 只写“触发条件 + 价值”，保持一句话
- `tags` 用来支持技能库筛选、模板归类、后续推荐
- `starter_prompt` 用来给前端模板入口或快捷启动提供推荐起手提示
  - 当前前端已支持：
    - 用它创建新线程时自动发送 launch prompt
    - 用它填充当前线程输入框，供用户二次编辑后发送
- 当前前端 skills 面板还会基于真实运行时做草稿检查：
  - 名称是否符合后端约束
  - 是否缺少推荐章节
  - 是否误写了当前不可用工具
  - 是否错误假设 `Skill.args` 会做模板变量替换
  - 是否绑定服务器路径、环境变量、租户 ID 或密钥
  - 是否遗漏资料获取、记忆写入、偏题检查或结构化输出策略
- 正文只写执行策略，不写产品宣传或开发过程说明
- 每段都要能指导模型做动作，不要堆概念

## 4. 推荐正文结构

建议正文按下面 7 段写，足够兼容当前后端：

### 4.1 何时使用

明确告诉模型：

- 哪类问题应该调用这个 skill
- 哪类问题不应该调用
- 如果只是局部匹配，应该先确认主题还是继续执行

### 4.2 输入约束

写清：

- 主题来自哪里
- 用户给的范围如何优先
- `starter_prompt` 只是推荐入口，不是强制执行内容
- `Skill.args` 若存在，只当附加上下文，不当模板变量

### 4.3 工作步骤

推荐把步骤写成有限、可检查的顺序：

1. 先查记忆，避免重复分析
2. 再按问题选择上传文档、网页、ES、数据库或受控文件读取
3. 只在证据不足时扩展搜索
4. 形成阶段性结论前做一次偏题检查
5. 产出文本或结构化 artifact
6. 只把稳定结论写入记忆

### 4.4 输出要求

要明确：

- 什么时候直接文本回答
- 什么时候输出 Markdown
- 什么时候必须调用 `ArtifactEmit`
- 表格、图表、关系图分别适合什么场景

### 4.5 记忆策略

当前推荐：

- `thread`：临时分析笔记、本轮假设
- `workspace`：同一资料集内复用的稳定结论
- `tenant`：跨用户共享也成立的稳定规则、术语、主题边界

不要把每一步调试过程写进记忆。

### 4.6 偏题控制

建议明确要求：

- 形成结论前，用 `TopicDriftCheck` 检查候选结论是否还围绕主题
- 如果 `verdict=off_topic`，先缩回主题再继续
- 如果用户打断或改题，废弃旧路线，按新主题重建计划

### 4.7 禁止事项

建议写死：

- 不要杜撰没检索到的事实
- 不要把工具原始调试输出直接展示给用户
- 不要把所有中间子任务都堆到最终消息列表里
- 不要在证据不足时做确定性判断

## 5. 当前可安全依赖的工具

### 5.1 资料源读取

- `SourceSearch`
  - 检索上传文档抽取后的文本
- `SourceRead`
  - 按文件 ID 或文件名读取上传文档关键内容
- `WebFetch`
  - 读取已接入网页的正文内容
- `DbQuery`
  - 对已接入数据库执行只读 SQL 查询
- `EsSearch`
  - 输入：`query` 必填
  - 可选：`index`、`size`、`fields`、`source_fields`

### 5.2 受控文件读取

- `glob_search`
  - 在服务端允许的资料边界内找文件范围
- `grep_search`
  - 找关键词、实体、字段名
- `read_file`
  - 读取命中文件内容

普通 Web Agent 场景优先使用资料源工具。只有资料库确实绑定了受控服务器目录时，才在技能里使用这组三个文件工具。

### 5.3 记忆与分析

- `MemorySearch`
  - 输入：`query` 必填
  - 可选：`limit`、`scope = thread | workspace | tenant | all`
- `MemoryWrite`
  - 输入：`note` 必填
  - 可选：`tags`、`scope = thread | workspace | tenant`
- `TopicDriftCheck`
  - 输入：`candidate` 必填
  - 可选：`topic`

### 5.4 前端结构化输出

- `ArtifactEmit`
  - `kind = text | markdown | table | chart | graph`
  - `payload` 结构需稳定、可渲染

推荐结构：

```json
{"kind":"table","payload":{"columns":[{"key":"source","label":"Source"}],"rows":[{"source":"doc-a"}]}}
```

```json
{"kind":"chart","payload":{"type":"bar","title":"命中分布","data":[{"label":"A","value":3}],"xKey":"label","series":[{"key":"value","label":"Value","color":"#195f59"}]}}
```

```json
{"kind":"graph","payload":{"title":"关系图","nodes":[{"id":"n1","label":"主题"}],"edges":[{"source":"n1","target":"n2","label":"depends_on"}]}}
```

## 6. 标准模板

可直接从下面 5 份模板开始，仓库内和前端技能库里都提供了可直接套用的版本：

- [`docs/templates/skills/basic-evidence-scan.SKILL.md`](./templates/skills/basic-evidence-scan.SKILL.md)
- [`docs/templates/skills/deep-synthesis.SKILL.md`](./templates/skills/deep-synthesis.SKILL.md)
- [`docs/templates/skills/expert-brainstorm.SKILL.md`](./templates/skills/expert-brainstorm.SKILL.md)
- [`docs/templates/skills/report-table-chart.SKILL.md`](./templates/skills/report-table-chart.SKILL.md)
- [`docs/templates/skills/multi-source-answer.SKILL.md`](./templates/skills/multi-source-answer.SKILL.md)

## 7. 模板选择建议

- 如果主要是“先搜再总结”，用 `basic-evidence-scan`
- 如果主要是“边搜边校准主题，持续推演”，用 `deep-synthesis`
- 如果主要是“多专家视角辩论、形成共识/分歧与行动建议”，用 `expert-brainstorm`
- 如果主要是“页面要稳定输出表格/图表/关系图”，用 `report-table-chart`
- 如果主要是“用户自然语言提问，系统自动选择上传文档、网页、ES 或数据库”，用 `multi-source-answer`

如果是专家会诊类结果，建议给 `ArtifactEmit` 使用稳定标题前缀，方便前端自动聚合：

- `专家视角 / 专家名`
- `专家会诊 / 综合结论`
- `专家会诊 / 共识与分歧`
- `专家会诊 / 风险矩阵`

复杂场景不要把所有能力塞进一个巨型 skill。推荐拆成：

- `deep-synthesis`
- `report-table-chart`
- `domain-glossary`

由模型按需加载，而不是一个 skill 包办全部流程。

## 8. 编写注意事项

### 要做

- 用 `description` 写清触发场景
- 在正文里明确“先检索、后总结、再固化记忆”
- 把输出格式写成可执行规则
- 把偏题检测写成硬步骤
- 把“何时停止继续搜索”写清楚
- 如果用了历史人物、知名专家或流派名义，明确这是“分析视角”而不是虚构原话

### 不要做

- 不要依赖 frontmatter 扩展字段驱动逻辑
- 不要把 `starter_prompt` 写成大段说明文档
- 不要把 `starter_prompt` 写成只能在 CLI 里使用的命令式说明
- 不要把 skill 写成需要 shell 或写文件的自动化脚本
- 不要假设 tenant skill 一定能读取额外 sidecar 文件
- 不要把敏感路径、秘钥、租户内部实现细节写进模板
- 不要要求用户理解 `workspace_root`、`CLAWD_DATA_DIR` 或服务器目录
- 不要把 `args` 当变量替换系统
- 不要伪造专家原话、访谈、背书或现实参与关系

## 9. 推荐命名方式

推荐 `动作-对象` 或 `领域-动作`：

- `evidence-scan`
- `deep-synthesis`
- `report-table-chart`
- `contract-risk-review`
- `repo-topic-summary`

不推荐：

- `分析一下`
- `skill1`
- `super_agent_final_v2`
- `文档总结图表版`

## 10. 当前阶段的结论

如果要和现有 `clawd` 完全对齐，建议把 skill 标准定成下面这句话：

> Web skill = 一个受限、安全、可复用的单文件工作流提示词，围绕检索、总结、偏题控制、记忆写入和结构化输出展开。

这比直接照搬 CLI skill 生态更稳，也更适合当前多人服务架构。
