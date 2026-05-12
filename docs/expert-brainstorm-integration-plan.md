# Expert Brainstorm 集成方案

更新时间：2026-05-12

## 目标

把 `expert-brainstorm` 做成当前 `clawd + web` 产品里的标准 Web Agent 能力，而不是把外部参考目录里的 CLI / Bash 工作流硬搬进来。

目标形态：

- 每位专家是一个独立 skill
- 另有一个总控 skill：`expert-brainstorm`
- 用户在聊天时可以选择本轮要启用的专家
- 每位专家基于自己的 skill 方法论独立做 ES 检索与总结
- 所有专家完成后，再输出统一综合结论
- 前端展示为“一轮专家会诊”，而不是把所有子步骤打平成消息瀑布

非目标：

- 不直接复用 `/Users/fuyb/Desktop/expert-brainstorm` 中的 Bash / Python ES 脚本
- 不把专家结果暴露成后台路径、原始工具 JSON、调试日志
- 不把专家切换实现成 CLI 风格的 slash command 体验

## 为什么不能直接照搬外部实现

外部参考目录的实现方式和当前仓库的产品边界不一致：

- 外部实现依赖本地 `bash` + Python ES 脚本
- 外部实现默认是单用户、本地技能目录、离线研究工作流
- 当前仓库是多人并发 Web Agent 服务，主能力边界是：
  - `Skill`
  - `EsSearch`
  - `SourceSearch / SourceRead`
  - `WebFetch`
  - `DbQuery`
  - `MemorySearch / MemoryWrite`
  - `TopicDriftCheck`
  - `ArtifactEmit`

尤其要注意当前后端的真实行为：

- `Skill` 工具现在只负责读取 skill 提示词与元数据
- `Skill` 不会自动替专家起一个独立子运行
- `EsSearch` 已经是当前服务内建标准检索面
- 线程 UI 已经支持把步骤、引用、artifact 收敛到同一轮 assistant 消息下

因此正确方向不是“搬脚本”，而是“复用当前 Skill + EsSearch + Artifact + Thread UI 能力，重做成 Web 产品能力”。

## 当前架构适配点

当前仓库已经具备以下基础：

- 后端可列出、读取、创建、删除 skill
- skill 已有 `name / description / tags / starter_prompt`
- 线程运行时 system prompt 会注入可用技能清单
- 已有 `EsSearch` 工具和数据源绑定模型
- 前端已有技能面板、聊天输入区、结果工作台、消息内步骤聚合
- `ArtifactEmit` 已支持 `markdown / table / chart / graph`

当前缺口主要有四类：

1. 缺少“专家 skill”的标准约定
2. 缺少聊天内的“专家选择器”
3. 缺少“专家会诊结果”的结构化展示协议
4. 缺少真正隔离的专家编排原语

## 产品模型

### 1. 专家 skill

每位专家是一个普通 Web skill，不是特殊插件。

建议首批内置：

- `mearsheimer`
- `kissinger`
- `brzezinski`
- `nye`
- `huntington`
- `allison`
- `yan-xuetong`

每个专家 skill 只做四件事：

- 定义该专家的分析视角和边界
- 定义 ES 查询构造偏好
- 定义该专家应该产出的总结结构
- 明确禁止伪造专家原话、现实参与、私下立场

### 2. 总控 skill：`expert-brainstorm`

总控 skill 负责组织一次完整专家会诊流程：

1. 议题澄清
2. 逐位专家独立分析
3. 关键冲突点交叉辩论
4. 共识 / 分歧地图
5. 综合结论与行动建议

它本身不替代专家 skill，而是要求模型显式加载所选专家 skill，再分别完成检索和分析。

### 3. 聊天内专家选择

用户操作不应是手写技能名，而应是聊天主界面里的轻量专家选择器：

- 在输入框上方或输入框左侧提供“专家视角”入口
- 以 chip / pill 方式显示本轮已选专家
- 允许“全选常用专家”“清空”“按主题预设”
- 所选专家只影响当前待发送消息，不污染全局模型设置

### 4. 专家结果展示

一次专家会诊应被视为一轮消息中的一个复合结果，而不是 7 条独立 assistant 消息。

推荐展示结构：

- 聊天主区：
  - 一条 assistant 主回答
  - 消息内折叠的“专家进展”列表
  - 消息内“最终结论 / 风险 / 建议”摘要
- 右侧结果区：
  - 每位专家一份 markdown 结果卡
  - 共识 / 分歧表格
  - 最终综合报告

## Skill 组织标准

### Phase 1 可直接落地的标准

当前 skill parser 只可靠支持：

- `name`
- `description`
- `tags`
- `starter_prompt`

因此第一阶段不要依赖新增 frontmatter 字段，先用 `tags` 约定专家身份。

建议标签约定：

- `expert`
- `expert-brainstorm`
- `expert:<id>`
- `domain:geopolitics` 或 `domain:investment`
- `panel:ir`

示例：

```md
---
name: mearsheimer
description: 用进攻性现实主义框架评估大国竞争、风险升级和结构性压力。
tags: expert, expert-brainstorm, expert:mearsheimer, domain:geopolitics, panel:ir
starter_prompt: 请用米尔斯海默视角分析当前议题，并先检索当前资料库中的相关证据。
---
```

### Phase 2 建议增加的扩展元数据

当需要更稳定的产品编排时，再给后端 parser 加字段支持：

- `display_name`
- `expert_group`
- `expert_order`
- `preferred_output`
- `preferred_sources`
- `selection_hint`

但这不是第一阶段的前提。

## 数据与 ES 接入模型

专家会诊必须基于当前线程可见的数据边界运行，不应让 skill 自己决定 ES 地址或索引。

统一原则：

- ES 连接参数来自当前 thread 绑定的资料库 / 数据源
- 专家 skill 只定义“怎么搜”，不定义“连到哪里”
- 每位专家必须独立构造 query
- 如果当前线程没有可用 ES 数据源：
  - `expert-brainstorm` 明确中止
  - 告诉用户“当前会话未接入 Elasticsearch 资料源”
  - 不应偷偷回退成普通闲聊

每位专家 skill 中建议保留：

- 主题拆解方式
- 关键词扩展规则
- query 组合偏好
- 命中不足时的补检索策略
- 总结输出结构

不应保留：

- endpoint
- index name
- api key
- 用户名密码
- 服务器脚本路径

## Phase 1：基于现有能力的 MVP

第一阶段目标是先把“能用”做出来，不新增真正的后端专家编排引擎。

### 后端

尽量复用现有链路：

- 继续使用 `Skill` 工具加载总控和专家 skill
- 继续使用 `EsSearch` 做每位专家的证据检索
- 继续使用 `ArtifactEmit` 产出专家卡片和综合结果
- 不新增独立运行线程，不新增子 agent

这一阶段后端只需要轻量增强：

1. 为内置专家 skill 落盘
2. 在 skill 列表返回中允许前端按 `tags` 识别专家 skill
3. 视需要补一个更清晰的 system prompt 约束：
   - 当用户明确发起专家会诊时，先加载总控 skill
   - 再逐位加载所选专家 skill
   - 每位专家都要先检索再输出
4. 为 `ArtifactEmit` 约定标题前缀，方便前端聚合：
   - `专家视角 / 米尔斯海默`
   - `专家视角 / 基辛格`
   - `专家会诊 / 共识与分歧`
   - `专家会诊 / 综合结论`
5. 对新的专家会诊结果，优先在 `ArtifactEmit.metadata` 中写稳定分组字段，避免前端完全依赖标题：
   - `{"group":"expert_view","expert_name":"米尔斯海默","panel":"expert-panel-8f3a2c1d"}`
   - `{"group":"expert_consensus","panel":"expert-panel-8f3a2c1d"}`
   - `{"group":"expert_summary","panel":"expert-panel-8f3a2c1d"}`
6. `panel` 不应写死为 `expert_brainstorm`。前端发起每一轮会诊时都应生成唯一 `panel_id`，本轮所有 `ArtifactEmit.metadata.panel` 与 `ExpertPanelEmit.panel_id` 都复用该值，避免同一线程中多轮会诊结果串组。
7. 服务端在 expert panel 运行中需要做最小护栏，而不是完全相信模型输出：
   - `ExpertPanelEmit.panel_id` 必须匹配当前运行注入的 `panel_id`
   - `ExpertPanelEmit.expert_name` 若存在，必须属于当前已选专家
   - `ArtifactEmit.metadata.group` 在专家会诊模式下必须属于 `expert_view / expert_consensus / expert_summary`
   - `ArtifactEmit.metadata.expert_name` 在 `expert_view` 下必须匹配当前已选专家
   - `ArtifactEmit.metadata.panel` 若缺失由后端自动补齐；若错误则直接拒绝

### 前端

第一阶段前端重点是入口和展示，不引入重型工作流编辑器。

建议改造：

1. 技能面板增加“专家视角”筛选
2. 聊天输入区增加“选择专家”入口
3. 已选专家显示为 chips
4. 发送时由前端生成一段结构化启动提示，内容包括：
   - 当前主题
   - 已选专家
   - 要求使用 `expert-brainstorm`
   - 要求每位专家独立检索与总结
5. 结果区优先聚合展示专家 artifact，而不是把原始步骤暴露给用户

前端第一阶段可以不新增后端字段，直接用选中专家列表拼接 launch prompt。

但当前仓库已经比纯 prompt 拼接更进一步：

- 前端发送 `user_message` 时，会把本轮已选专家以结构化 `expert_panel` 一并传给后端
- 后端会把该结构化上下文注入 system prompt，并写入 `run_started` audit
- 前端结果区可直接从 `run_started.expert_panel` 恢复“本轮已选专家 / 待完成专家”，不必等第一条 `ExpertPanelEmit`
- 后端对 `ExpertPanelEmit` 与 `ArtifactEmit.metadata` 已开始做运行期约束，减少 panel 串组与专家名漂移
- 结果工作台已进一步改成“阶段导航 + 主结果优先 + 专家单卡次级展开”的结构，而不是把 summary / consensus / expert views 机械平铺成多组列表
- expert panel 的阶段字段现在已开始在服务端归一化为 `phase_0 .. phase_4`，前端展示优先依赖这组 canonical phase，而不是长期兼容任意自由文本别名

### MVP 执行链路

```text
用户选择专家
  -> 前端生成专家会诊启动提示
  -> 当前线程发送一条用户消息
  -> 模型先调用 Skill("expert-brainstorm")
  -> 再依次调用 Skill("<expert>")
  -> 每位专家调用 EsSearch
  -> 每位专家输出简报并调用 ArtifactEmit(markdown)
  -> 汇总调用 ArtifactEmit(table/markdown)
  -> assistant 输出面向用户的综合结论
```

### Phase 1 的局限

这是最快路径，但有明确限制：

- 专家之间是否真正“独立上下文”只能依赖模型遵守提示词
- 无法强保证每位专家都执行了独立检索
- 专家结果对象没有结构化持久化协议
- 前端只能通过 artifact 标题 / tags / 顺序推断专家结果

因此它适合作为第一版，不适合作为最终生产形态。

## Phase 2：生产级专家编排

第二阶段建议新增显式后端原语，避免把所有编排都压给模型。

当前阶段的真实边界应明确写清：

- 已完成：结构化 expert panel 上下文、唯一 `panel_id`、结果分组协议、前端会诊聚合展示、服务端最小校验护栏
- 未完成：真正独立的多专家执行器、逐专家独立运行状态、失败重试策略、面板级持久化模型

### 推荐新增运行时工具：`ExpertPanel`

输入示意：

```json
{
  "topic": "2026年投资金条买卖决策分析",
  "master_skill": "expert-brainstorm",
  "experts": [
    { "skill": "mearsheimer", "label": "米尔斯海默" },
    { "skill": "kissinger", "label": "基辛格" }
  ],
  "require_es": true,
  "final_output": ["markdown", "table"]
}
```

`ExpertPanel` 的职责：

1. 校验所选专家 skill 是否存在
2. 校验当前线程是否有可用 ES 访问权
3. 为每位专家建立隔离子上下文
4. 将该专家 skill prompt、当前议题和当前数据边界拼成一次独立 mini-run
5. 捕获该专家的：
   - 检索 query
   - 关键命中
   - 专家总结
   - 相关 artifact
6. 所有专家完成后，再触发一次综合归纳
7. 返回结构化结果给当前线程

### 推荐返回结构

```json
{
  "panel_id": "exp_123",
  "experts": [
    {
      "skill": "mearsheimer",
      "label": "米尔斯海默",
      "status": "completed",
      "queries": ["..."],
      "artifact_id": "art_1",
      "summary": "..."
    }
  ],
  "final_artifact_id": "art_final",
  "consensus_artifact_id": "art_table"
}
```

### 后端存储建议

如果第二阶段要支持可追踪、可复盘、可重放，建议增加一种明确的专家会诊记录层。

可选方案：

1. 新表 `expert_panels`
2. 新表 `expert_panel_results`
3. 当前已补兼容式 `artifact.metadata` 协议，后续可继续扩成更严格的结构化记录

建议下一步优先新增独立记录或专用 `ExpertPanel` 结果对象，而不是长期把专家编排状态继续塞进松散 audit 文本里。

### 前端 Phase 2 展示

当前消息区已经能把步骤挂到一条 assistant 消息下，因此第二阶段 UI 可以沿现有结构升级：

- 消息内：
  - 专家进度条
  - 每位专家折叠卡片
  - 最终综合摘要
- 结果区：
  - 专家输出列表
  - 共识 / 分歧表
  - 最终综合报告
- 证据区：
  - 按专家分组展示其 ES 命中

这样用户感知是“一次专家会诊”，而不是一串工具日志。

## 自定义专家能力

后续不应把专家固定死成 7 位内置人物。

产品标准应是：

- 任何 skill 只要符合专家标签规范，就可以作为可选专家
- 前端专家选择器先显示系统内置，再显示用户自定义专家
- 自定义专家仍遵守多人 Web Agent 约束：
  - 不写 Bash
  - 不写本地 Python 脚本
  - 不绑定路径、密钥、环境变量
  - 不伪装成真实人物背书

建议在技能编辑器中补一类专家模板：

- `专家视角 / 战略分析`
- `专家视角 / 行业研究`
- `专家视角 / 投资决策`

## 测试与验收

### 后端验收

- 能正确列出专家 skill
- 线程绑定 ES 数据源时，`EsSearch` 可用
- 未绑定 ES 数据源时，专家会诊会明确失败并给出可操作提示
- 每位专家都能生成独立 artifact
- 最终综合结果能引用专家产出

### 前端验收

- 用户可在聊天界面选择专家
- 已选专家不会把后台规范名、路径或调试信息暴露给用户
- 一轮专家会诊不会打平为多条碎消息
- 用户能在结果区区分“专家单卡”和“最终综合结论”

### 质量红线

- 不出现伪造原话、伪造现实参与
- 不暴露 ES endpoint、服务器目录、skill 存储路径
- 不把 memory / drift / audit 原始信息直接给用户
- 不把纯聊天线程自动误导成必须走 ES

## 推荐落地顺序

1. 落地首批内置专家 skill
2. 强化 `expert-brainstorm` 总控 skill
3. 前端增加专家选择器与已选专家 chips
4. 按 artifact 标题约定聚合专家结果
5. 补第一轮专家会诊模板与测试样例
6. 再进入 `ExpertPanel` 后端编排原语开发

## 结论

这项能力应按两段推进：

- 第一段先用当前 `Skill + EsSearch + ArtifactEmit` 做出可用版本
- 第二段再把专家编排下沉到后端，拿到真正稳定的生产行为

这样能兼顾速度和产品质量，也符合当前仓库“Web Agent 优先、多人并发优先、避免 CLI 心智泄露”的主线方向。
