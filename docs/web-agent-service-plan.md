# Web Agent Service Plan

更新时间：2026-05-10

## 目标

在当前 `claw-code` 仓库上新增一个面向多人并发访问的 Web Agent 服务层，而不是把现有 `claw` CLI 直接包装成 HTTP 服务。

目标能力：

- 基于 Web 聊天的多用户 agent
- 以当前 Rust runtime 为内核，复用 session、tool loop、permission、prompt 装配能力
- 支持本地文件搜索与读取
- 支持 Elasticsearch 检索
- 支持 ACP 协议接入外部系统
- 支持长期工作记忆
- 支持主题偏航检测与重规划
- 支持用户打断
- 支持结构化 artifact 输出：文本、Markdown、表格、图表、关系图

专项能力规划：

- `expert-brainstorm` 专家会诊集成方案见 [`docs/expert-brainstorm-integration-plan.md`](./expert-brainstorm-integration-plan.md)
- 基于 `AI分析师` 原型的前端迁移方案见 [`docs/web-agent-prototype-migration-plan.md`](./web-agent-prototype-migration-plan.md)

## 当前实现进度

已完成：

- 新增 `rust/crates/clawd` 服务 crate，提供线程、消息、SSE 事件流、中断与重规划 API
- 新增 `web/` React 前端，接入 `assistant-ui`，提供线程列表、聊天区、artifact 面板、记忆面板
- 一期安全工具集已收敛为 `read_file / glob_search / grep_search`
- 已落地自定义工具：`EsSearch / MemoryWrite / MemorySearch / TopicDriftCheck / ArtifactEmit`
- 已支持 API key 鉴权基础：
  - 支持 `Authorization: Bearer <api_key>` / `X-CLAWD-API-KEY`
  - 为浏览器 SSE 保留 `api_key` query 鉴权
  - 提供 `tenant_id + user_id` 上下文
  - 开发态可选保留 `X-CLAWD-USER-ID`
- 已将线程元数据持久化切换为数据库抽象：
  - 默认开发/测试：`SQLite`
  - 生产目标：`PostgreSQL 17`
  - 兼容导入旧的 `threads/*.json` 元数据
- 已新增基础 `project` 实体：
  - `GET /v1/projects`
  - `POST /v1/projects`
  - `GET /v1/projects/:id`
  - `PATCH /v1/projects/:id`
  - 线程可绑定 `project_id`
  - 项目当前保存 `name / description / workspace_root`
  - 已支持项目默认配置：`default_topic / default_permission_mode / starter_prompt / default_instructions / default_skill_names`；`default_model` 仍保留为后端兼容字段，但 Web 工作台不再提供默认模型设置入口
- 已支持项目级模型接入配置：Web 页面只保存 `model_base_url / model_api_key`，不暴露 `model_base_url_env / model_api_key_env`
- 浏览器侧模型配置现已改成独立模型面板，按 `API 地址 -> API 密钥 -> 模型` 顺序接入：
  - 先填写 API 地址和 Key
  - 前端自动请求 OpenAI-compatible `/models`
  - 请求失败时才回退到内置备用模型列表
  - 不再默认替用户预选模型，避免“看起来已接好但实际并未生效”的假象
- 服务启动时会自动读取环境变量：`CLAWD_DEFAULT_MODEL` 优先，其次按 provider 读取 `OPENAI_MODEL` / `DASHSCOPE_MODEL` / `XAI_MODEL` / `ANTHROPIC_MODEL` 和对应 `*_BASE_URL` / `*_API_KEY`
- 项目 API 地址指向非 Anthropic 服务时，即使会话继承 Claude 服务默认模型，后端也会按 OpenAI-compatible/xAI/DashScope 路由选择运行时模型，避免页面只填地址和 Key 后不生效
- OpenAI-compatible 运行时现已兼容两类上游地址：
  - 标准 `/chat/completions` base URL
  - 直接指向 `/responses` 的代理地址
- 为兼容现网代理部署，若实际 base URL 并非 Anthropic 官方地址，`clawd` 在 OpenAI-compatible 路由下也会回退读取 `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN`，避免 operator 只改了现有环境变量名却导致运行时报缺 `OPENAI_API_KEY`
- 项目 summary 不回显明文 `model_api_key`，只返回 `model_api_key_configured`
  - 新线程创建时会继承项目默认指令与优先技能列表，并注入运行时 system prompt
  - 项目默认配置已可在创建后继续维护，不必删项目重建
- 已引入数据库 schema version / migration 基础设施
- `memory_notes` / `artifact_records` 已拆到独立表，仍保留 `record_json` 兼容层
- 已完成 workspace 级共享记忆：
  - 记忆 scope = `thread | workspace | tenant`
  - workspace 记忆按 `tenant_id + owner_id + workspace_root` 共享
  - tenant 记忆按 `tenant_id` 共享
  - 线程快照返回“可见记忆”，前端显示 scope 标记
- 已完成持久化运行审计：
  - 数据库新增 `audit_records`
  - 线程快照返回最近审计轨迹
  - SSE 新增 `audit_added`
  - 已覆盖 thread/create、topic update、interrupt、replan queue、run lifecycle、tool use/result、memory write、artifact emit
- 已提供 `GET /v1/config`，返回数据库 backend / schema version / 默认模型与权限模式
- `/v1/config` 已不再向普通前端回传 `allowed_roots` 这类服务器目录白名单，避免把部署侧路径边界暴露到用户界面
- 已提供 `GET /v1/auth/session`，返回当前鉴权上下文
- 已完成 API key 生命周期管理：
  - `GET /v1/api-keys`
  - `POST /v1/api-keys`
  - `POST /v1/api-keys/:id/disable`
  - 当前 key 禁止自禁用，避免前端直接自锁死
  - 前端已提供列表、创建、切换、禁用面板
- 已完成基础治理能力：
  - 线程创建配额：`tenant` / `user`
  - 并发运行上限：`global` / `tenant` / `user`
  - 写请求限流：`global` / `tenant` / `user`，按分钟窗口生效
  - 超限时返回 `429 Too Many Requests`
  - `run_rejected` 会进入线程审计轨迹
  - 对线程命令的限流拒绝会写入 `request_rejected` 审计
  - `/v1/config` 已返回当前限制配置，前端展示当前配额
- 已完成基础恢复能力：
  - 线程记录会持久化 `last_status`、`last_error`、`next_run_id`
  - 服务重启后，如线程上次停在 `running` / `interrupt_requested`，会自动恢复为 `failed`
  - 同时写入 `thread_recovered` 审计，避免线程悄悄回到空闲态
- 已修复失败运行时的消息持久化缺口：
  - 即使模型初始化、额度、provider 返回等异常在 assistant 回复前发生
  - 本轮刚发送的 user message 仍会写回 thread session 并持久化
  - 前端不会再出现“第二轮报错后刚发出的用户消息消失”的假象
- 已完成服务安全版 skill 能力：
  - `clawd` 已允许模型调用 `Skill`
  - skill 解析范围限制在当前 `workspace_root` 下的安全目录，以及 tenant 托管 skills 目录
  - 不再复用 CLI 那套会扫描 `cwd / HOME / 全局 skills` 的查找逻辑
  - 新增 `GET /v1/skills`、`GET /v1/skills/:name`、`POST /v1/skills`、`DELETE /v1/skills/:name`
  - 新增轻量 skill metadata：`tags`、`starter_prompt`
  - 前端已提供技能库面板，可按 `资料集 / 团队` 维护技能，并支持删除
  - skill API 已开始支持通过 `project_id` 解析项目级 skills，前端后续可逐步摆脱显式 `workspace_root` 传参
  - `Skill` 工具输出和技能 API 不再返回技能文件真实存储路径，避免模型上下文或用户回答泄露服务器目录
  - 自定义技能模板已覆盖上传文档、网页、ES、数据库、记忆、偏题检查和结构化输出四类主流程
- 已补第一版资料源产品化摘要：
  - `knowledge_base` 摘要不再回传 legacy 服务器路径
  - `data_source` 摘要现会返回非敏感接入信息，例如 ES 的 `endpoint / index_name / auth_mode`
  - ES 数据源创建已支持 `api_key` 或 `username/password` 两种认证输入
  - 上传文档数据源已打通真实上传入口：`POST /v1/data-sources/:id/upload`
  - 上传文档会落到服务端托管存储，并抽取文本供 `SourceSearch / SourceRead` 使用
- 网页数据源已支持配置受控 URL 列表，并通过 `WebFetch` 读取页面正文
- 数据库数据源已支持配置 `sqlite / postgres` 连接，并通过 `DbQuery` 执行只读查询
- 新增的上传文档检索结果已并入现有 evidence/workbench 视图，不会形成第二套结果 UI
- `WebFetch / DbQuery` 成功后现会自动沉淀结构化结果卡：
  - `WebFetch` 自动生成 markdown 结果，可直接进入右侧 `结果`
  - `DbQuery` 自动生成 table 结果，可直接在右侧 `结果` 浏览与下载
  - 工具结果 payload 会同步回写 `artifact_id / artifact_title`，让聊天内步骤、消息摘要和右侧结果区保持同一引用闭环
- 上传文档数据源前端已不再只是单个上传按钮：
  - 资料库卡片会直接展示已上传文件清单、大小与上传时间
  - 上传入口已支持一次选择多个文件，交互更接近真实资料库接入流
  - 已补数据源移除和上传文件单条移除，资料库管理不再只能增加不能清理
  - 已补数据源编辑流，普通用户可直接更新名称、说明与接入配置，不必删掉重建
  - 数据源编辑已支持真实配置回显；ES / 数据库 / 网页接入也已补测试连接入口，尽量把错误拦在建库阶段
  - 数据源测试已拆成两层：
    - 草稿测试：`POST /v1/data-sources/test`，用于保存前验证接入配置
    - 已保存数据源重测：`POST /v1/data-sources/:id/test`，会把最近一次测试结果沉淀回资料源记录
  - 资料源摘要现已返回 `last_test`，前端卡片可直接显示最近测试状态、摘要和测试时间
  - 测试结果不再只有一行文案，现会按 ES / 网页 / 数据库返回结构化细节：
    - ES：地址、索引、认证方式、命中数
    - 网页：测试地址、内容类型、读取字符数、入口数量
    - 数据库：引擎、脱敏连接串、schema、返回行数
  - 前端资料接入面板已继续去后台化：
    - “数据源”主文案继续收敛为“资料来源 / 接入方式”
    - 接入方式改成卡片式选择，而不是先暴露一整个后台风格下拉表单
    - 资料来源卡片会优先展示用途、当前状态、最近验证或上传时间，再展示编辑/测试/上传动作
    - 资料库卡片已补资料库级“快速上传资料”入口，上传文档不必先下钻到某个来源卡片内部
    - 聊天主舞台已补轻量资料上下文条；绑定了上传类资料来源的会话可直接在聊天区“补充资料”
    - 新建会话卡也已支持在启动前先上传资料，让上传更接近主流 Web Agent 的附件接入体验
    - 其他接入方式也已从聊天主流程可触达：会话内和新建会话卡可直接打开网页、Elasticsearch、数据库接入草稿
- 已进入前端产品化收敛阶段：
  - 用户面产品语义已开始从“目录 / 路径 / workspace”收敛为“资料集 / 资料源 / 高级接入”
  - 普通用户主路径不再要求直接输入服务器绝对路径；聊天主舞台优先围绕资料集、主题、起始消息展开
  - 服务器绝对路径保留在管理侧 `高级接入` 中，仅作为资料集的后端绑定方式，不再作为普通用户主心智
  - 下一阶段将进一步把“资料集=服务器路径”改造成“资料库 + 数据源”，其中服务器本地目录只作为管理员侧的一种接入器
- 聊天主舞台、设置抽屉、结果抽屉和运营面板中的“上下文目录名”表达已进一步收敛为 `纯聊天 / 资料库 / 模式` 等产品语义，减少托管 workspace 目录名泄露
  - 已补 `expert-brainstorm` 专项设计，方向是“每位专家一个 skill + 一个总控 skill + 聊天内专家选择 + ES 驱动的独立专家产出 + 最终综合结论”，第一阶段复用现有 `Skill + EsSearch + ArtifactEmit`，第二阶段再补后端显式专家编排原语

## 路径模型调整

当前 `workspace_root` 模型在单机或内网研发场景中可用，但它不适合作为多人 Web Agent 的长期主模型。

问题很明确：

- 路径不是稳定业务标识，会随机器、挂载、容器和部署方式变化
- 普通用户不应该理解或维护服务器绝对路径
- 路径很难自然承接 SaaS 场景中的权限、审计、共享和迁移
- 外部数据接入无法统一建模，上传文件、网页、对象存储、Git、数据库、Notion、Confluence、ES 索引都不适合用绝对路径表达
- 记忆、技能和跨线程共享如果持续绑定 `workspace_root`，后续产品化会越来越受限

因此，后续主模型调整为：

- `project`
  - 任务与协作容器
  - 保存默认主题、默认技能、默认提示、默认资料库
- `knowledge_base`
  - 用户选择和感知的资料库
  - 作为会话检索、共享记忆和资料权限的主要边界
- `data_source`
  - 资料接入实例
  - 支持 `local_dir / upload / web / git / s3 / es / db / notion / confluence` 等类型
- `sync_job`
  - 数据接入、抓取、切分、索引任务

核心原则：

- 对普通用户，主心智是“资料库”，不是“服务器路径”
- 对系统，主心智是“数据源接入和索引”
- 对管理员，服务器本地目录只是一种 `data_source.kind = local_dir`

## 分阶段迁移计划

### 第一阶段：引入资料库 / 数据源模型，但保持兼容

- 新增 `knowledge_bases` 和 `data_sources` 存储模型与 API
- `project` 开始支持 `default_knowledge_base_id`
- 保留现有 `workspace_root` 字段，避免打断当前运行时与工具链
- `local_dir` 作为首个 `data_source` 类型落地，映射当前服务器路径能力
- 前端仍可继续使用当前 project/thread 流，但后端开始提供新模型

### 第二阶段：取消用户侧直接传路径

- `CreateThreadRequest` 不再接受用户直传 `workspace_root`
- 会话创建改为 `project_id` 或 `knowledge_base_id`
- 前端“新建资料集”去掉“服务器资料路径”，改成“资料库 + 数据源接入”
- 服务器路径只保留在管理员侧数据源接入页中

### 第三阶段：把共享边界从 workspace_root 迁到 knowledge_base_id

- workspace 记忆改为 knowledge base 记忆
- workspace skill 改为 knowledge base skill
- 检索、结果来源和共享策略按 `knowledge_base_id` 组织

### 第四阶段：把本地目录读取从用户工具面抽离

- 用户侧主工具改为 `KnowledgeSearch / DocumentRead / SourceBrowse`
- `read_file / glob_search / grep_search` 逐步退到：
  - 本地目录型数据源的后台同步流程
  - 管理员受控能力

## 本轮代码落点

本轮改造先做第一阶段：

- 文档正式转向 `资料库 + 数据源`
- 后端新增 `knowledge_base / data_source` 模型和基础 API
- 现有 `project/workspace_root` 保持兼容
- 不一次打断当前前端与运行时主链路
  - 线程创建现已允许不传 `project_id`、不传 `workspace_root`
  - 对“纯聊天 / 暂未接入资料”的会话，服务端会分配托管 workspace，用于兼容当前 runtime/session 存储
  - 纯聊天托管 workspace 默认不暴露本地文件工具，也不会因为服务端已配置 ES 就自动开放 `EsSearch`
  - 前端主入口现已允许直接创建纯聊天会话，不再要求先绑定资料集或服务器路径
  - 管理面板已开始从“新建资料集 + 服务器路径”转向“资料库 + 数据源”，其中 `Elasticsearch / 上传文档 / 网页 / 数据库` 属于产品主路径，`本地目录` 仅保留为高级接入选项
  - ES 数据源前端接入表单已补齐 `API Key / 用户名 / 密码` 认证字段，不再只能填写 endpoint + index
  - 网页数据源前端已补 `多 URL` 接入表单；数据库数据源前端已补 `URL / schema / 凭据` 接入表单
  - 上传文档数据源前端已补直接上传动作，不再要求用户通过服务器路径准备资料
  - 本地目录仍保留为高级接入，但前端不再依赖 `/v1/config` 中的服务器允许目录提示作为主表单占位
  - 开始把页面从“开发控制台”收敛为“研究交付工作台”
  - 子任务步骤继续挂在 assistant 消息下，不再平铺为独立消息
  - 右侧信息区开始收敛为 tabbed workbench，分离 `results / evidence / timeline`
  - 默认入口现已切成独立 surface：`auth gate / user workbench / operator console`
  - 鉴权、API key、事件流、配额和持久诊断已迁出主工作台，集中进入独立 operator console
  - 默认 workbench 下不再把 operator 细节透传给会话区和结果工作台，避免把记忆、原始 payload、调试信息暴露给普通用户
  - 已补第一版引用闭环：消息中的检索步骤可直接联动右侧 evidence workbench
  - artifact 已补基础复制、下载操作，右侧工作台不再只是静态展示
  - 已补第一版 project shell：前端先按 `workspace_root` 对线程分组，形成 `project -> thread` 过渡结构
  - 现已切到真实 `project` 数据模型，左侧项目区不再只是 `workspace_root` 分组
  - 线程创建表单已能继承项目默认 topic / model / permission / starter prompt
  - results tab 已升级为 artifact explorer，不再简单把全部 artifact 平铺在右侧
  - skill `starter_prompt` 已接入真实入口：既可作为新线程 launch prompt，也可填入当前线程输入框
  - skills 面板已补模板库、运行时约束提示和草稿检查，不再只是裸文本编辑器
  - 技能模板区继续去后台化：推荐模板不再突出作者标签，说明区改成更面向普通用户的“推荐流程”；后台能力边界进入折叠的高级规则
  - 自定义技能编辑器已增加发布前检查，会拦截服务器路径、环境变量、密钥、CLI/shell 工具和模板变量替换等不适合多人 Web Agent 的写法
  - 聊天主舞台已补当前会话可用技能快捷区，用户可直接把技能起手提示放入输入框，而不是必须进入管理面板查找
  - 资料库常用技能选择已从“规范名清单”进一步产品化为可读技能卡片，手动规范名编辑收进高级区
  - assistant 最终消息已补消息级引用栏，可从回答直接跳转到关联 evidence / result
  - 回答正文中的 `artifact:` / `evidence:` 链接现在会渲染成更明确的 citation button，并显示 `段落 n` / `命中 n` 等定位标签
  - 消息底部引用栏也已保留具体 anchor，不再丢失 `#block-n` / `#hit-n` 这种细粒度定位
  - 回答区 citation 和消息底部引用栏现在都可直接把引用插回 composer，形成“回答 -> 下一轮追问”的更短闭环
  - 同一轮 assistant 的工具步骤现在会聚合成消息内统一的“执行步骤”面板，正文、步骤和引用有了更稳定的层级，而不是把步骤块散落在回答正文中间
  - 每条 assistant 回答现在会先展示“本轮产出”概览，汇总结果数、证据数、步骤数以及最近的结果/证据入口，便于先扫一眼这轮产出规模再决定是否下钻
  - “本轮产出”概览也已支持直接把结果/证据引用插回 composer，和 citation、消息底部引用栏保持一致
  - 中间“研究概览”卡现已联动到最近一轮 assistant 产出：直接展示最近一轮的结果/证据/步骤概况，并提供跳转与引用入口
  - 前端已支持 `artifact:<id>` / `evidence:<id>` deeplink，便于后续继续做更细粒度引用
  - artifact markdown 现在也支持同样的 deeplink，不再只能从对话正文跳转
  - `evidence:<tool_use_id>#hit-<n>` 现可直接高亮具体命中项，支持更细粒度回看
  - `artifact:<id>#block-<n>` 已打通：markdown artifact 会自动生成块级锚点，支持滚动定位、高亮、复制块引用和插入到当前对话
  - workbench 中的 artifact / evidence 引用现可直接插入当前会话输入框，形成“结果区 -> 对话”的闭环
  - composer 上方已新增可见引用 chip，不再只把 deeplink 藏在输入文本里；引用 chip 现既可移除，也可直接重新打开右侧 result / evidence 面板
  - 连续 assistant 消息现会合并成同一轮对话输出，避免长回答被拆成多段零散消息
  - 聊天区流式输出改成“仅当用户接近底部时自动跟随”，否则保留“查看最新回复”入口，避免阅读历史内容时被强制拖回底部
  - 主题收束 / 重规划不再停留在 composer 上方的独立区域，而是并入输入区组件内部，进一步减少聊天主视图里的控制台分层感
  - 空会话推荐提示与消息运行摘要也继续压轻，减少多层卡片和框体叠加，向更主流的 chat-first Web Agent 视觉靠拢
  - 线程在“运行中 / 停止中 / 失败但还没生成可展示回复”时，聊天视口会直接显示会话内状态块，不再出现大片空白区或把失败态误渲染成欢迎页
  - 对于“失败且尚无任何消息”的线程，顶部失败提示已移除，失败信息只在会话流内部表达，避免头部告警和会话状态重复叠加
  - composer 上方的主题边界工具继续压轻为内联工具条，进一步贴近主流 Web Agent 的“聊天主舞台 + 轻量二级控制”模式
  - 主聊天界面已继续向单主舞台收敛：
    - 设置抽屉中的“新建会话”改为 `上下文 / 目标 / 运行方式` 分组，不再是一长串后台表单
    - 默认设置抽屉现已进一步收敛为“继续当前任务 / 资料集 / 最近会话”，不再把共享策略和技能库直接塞进默认会话入口
    - `资料接入与技能` 已拆到独立管理抽屉，和聊天主舞台、会话入口形成更明确分层
    - 右侧抽屉对普通用户已统一表达为 `结果` 与 `关键进展`，弱化“工作台 / 过程记录”这类内部术语
    - 聊天气泡开始继续去容器感，收敛为更贴近内容宽高的消息呈现，而不是被外层布局撑成大块
  - 聊天主区已继续产品化：
    - assistant / user / tool progress 已切成更清晰的消息行结构，不再像一组松散组件
    - assistant 运行中空文本态已改为更自然的“正在整理回复”
    - 消息内“本轮沉淀 / 工作记录”继续收敛为更轻的“本轮进展”
    - composer 引用 chip 已升级为“已附上”上下文条，更接近主流 chat agent 的追问体验
    - 内联主题工具已继续收敛为会话内 `任务边界` 工具条，并补了“更新主题边界 / 重新规划接下来的步骤”的解释文案
  - 跳转反馈已继续补全：
    - 从聊天 citation 跳到 artifact block / evidence entry / evidence hit 时，结果块、来源项和命中项都会出现统一高亮动画
    - 被定位的结果或来源项已补 `scroll-margin`，避免滚动后贴边
    - 欢迎态和“回到最新内容”入口也已继续压轻，减少空会话和长对话切换时的突兀感
- 右侧 workbench 抽屉现在会按线程内容自动落到更合理的默认 tab：优先 `结果`，其次 `证据`，最后才是 `轨迹`
  - workbench 已补“本轮产出”摘要层，先给出本轮结果/证据/步骤概况，再进入结果、证据和轨迹的下钻浏览
  - `轨迹` tab 正在从工程审计流继续收敛为更用户化的“工作记录”，降低内部事件名和原始错误细节的直出感
  - `结果` tab 在“暂无结构化结果”但已有证据或轨迹时，已补更明确的下一跳入口，不再只显示一句空文案
  - assistant 消息底部的“本轮沉淀”区域已继续弱化为自然聊天辅助信息，优先展示本轮结果和来源入口，步骤数等内部执行感信息降为次级表达
  - `证据` tab 已继续向“来源浏览器”收敛：每个 query 先展示检索概览，再列出来源卡片、摘要片段与引用动作，而不是直接堆 raw hit 列表
  - 已移除本地 `Demo 线程` 入口，当前统一以真实会话流验证“用户消息 + assistant 回复 + 工具步骤 + 结果 + 来源 + 轨迹”的完整体验，避免把演示逻辑带入产品界面
  - 左侧 project shell 已补状态统计和最近主题快捷入口，不再只是简单分组列表
  - 选中 project 后，左侧现可直接编辑项目描述、默认 topic/model/permission、starter prompt、default instructions 和 preferred skills
  - preferred skills 不再只靠手输：项目设置面板会列出当前 workspace / tenant 下真实可见的技能，点击即可加入或移出
  - 技能能力正在从 `workspace` 术语继续收敛到 `项目 / 团队` 语义，接口层已先补 `project_id` 解析能力，前端逐步跟进
  - 新建 project 时也会按输入的 workspace 预览可见技能，避免创建态和编辑态的技能选择体验割裂
  - 项目设置编辑支持重置草稿，避免异步详情刷新覆盖当前输入
  - 会话面板、技能库、工作台已做懒加载拆包，主入口构建体积不再触发默认 chunk 告警
- 已固化 PostgreSQL 17 smoke 脚本：
  - `rust/scripts/run_clawd_pg17_smoke.sh`
  - 覆盖 `/v1/config`、`/v1/auth/session`、API key 生命周期、线程创建和线程配额拒绝
- 已补第一版可交付打包链：
  - `clawd` 现支持通过 `CLAWD_WEB_DIST_DIR` 直接托管前端静态产物
  - `rust/scripts/package_clawd_linux.sh` 可在当前宿主机构建前端与 release 后端，并组装统一运行目录
  - `rust/scripts/package_clawd_linux_docker.sh` 可在支持 Docker 的环境中产出真正的 Linux x64 包
  - 根目录 `Dockerfile` 已定义可直接部署的 `clawd + web` 生产镜像
  - `Dockerfile.runtime` 用于基于已构建好的 Linux `clawd` 与前端 `dist` 快速封装 runtime 镜像
  - `rust/scripts/export_clawd_docker_image.sh` 可构建镜像并把 `docker save` 产物直接输出到仓库根目录

待继续推进：

- tenant 级记忆与检索索引
- 真正的后台长任务续跑与任务队列
- 技能版本化与删除/回滚
- ACP 协议接入与外部系统编排
- `project` 级容器继续扩展：共享知识、结构化共享技能选择器、成员能力与更细粒度默认策略
- artifact workspace 的版本、下载、分享、引用锚点
- 回答正文里的引用结构继续细化，例如在消息正文中补更明确的段落级 citation 展示与跳转提示
- 前端自动化截图链路仍待补完整，但已新增稳定版本地 dev 预览脚本：
  - `web/scripts/start-dev-preview.sh`
  - 会自动在 `4173-4193` 间寻找可用端口，降低本地验收时的端口冲突干扰

## ACP 协议支持规划

### 定位

这里的 `ACP` 作为 agent 与外部系统之间的协议层引入，用来补齐“Web Agent 不只调用本地工具和资料源，还可以接入外部业务系统、外部 agent 能力、远端任务执行面”的主线能力。

对当前 `clawd + web` 产品，ACP 的定位不是另起一套控制台，也不是要求用户直接理解协议 payload，而是：

- 作为“外部系统接入”的统一协议层
- 作为 thread 内可被模型发现和调用的受控能力面
- 作为结果、证据、工作记录的一种新来源，而不是独立于聊天主舞台之外的第二套产品

### 范围定义

ACP 支持按两个方向推进，但优先级不同：

- 第一优先级：`ACP out`
  - `clawd` 作为 ACP client，连接外部 ACP 兼容系统
  - 让当前线程可以发现远端能力、读取远端上下文、发起远端任务或调用远端工具
- 第二优先级：`ACP in`
  - `clawd` 再对外暴露 ACP 兼容入口
  - 让其他 agent 或企业系统可以把 `clawd` 当作一个研究执行节点来调度

这样分阶段的原因很直接：

- 当前仓库已经稳定围绕 `thread + command + SSE` 运转
- 先做 `ACP out` 可以把外部系统接入到现有聊天主线中，不需要先重写运行时心脏
- `ACP in` 更适合放在服务编排和治理能力补齐后再做

### 产品模型

面向用户时，ACP 不应以“协议配置”出现，而应作为 `外部系统` 或 `ACP 接入` 进入管理面板。

建议产品模型如下：

- `acp_connector`
  - 一个外部 ACP 系统接入实例
  - 具备名称、说明、接入地址、认证方式、启用范围、可发现能力摘要
- `connector_scope`
  - 作用范围为 `tenant / project / knowledge_base`
  - 默认建议以 `project` 为主，避免所有线程默认共享高风险外部动作能力
- `capability_profile`
  - 记录远端系统暴露的能力摘要，例如只读查询、知识检索、任务执行、写入动作
  - UI 中只展示“可做什么”和“能返回什么”，不直接暴露原始协议字段

用户侧交互目标：

- 在“设置 / 管理”侧单独维护外部系统接入
- 在线程或项目中选择是否启用某个 ACP 系统
- 在对话中自然调用，不需要理解协议握手细节
- 在结果区看到标准化后的结论、引用和结构化产物

### 后端设计

建议先新增独立持久化模型，而不是把 ACP 信息塞进现有 `data_sources` 或 `skills` 文本配置里。

建议新增：

- `acp_connectors`
  - `id`
  - `tenant_id`
  - `owner_id`
  - `project_id` 可选
  - `knowledge_base_id` 可选
  - `name`
  - `description`
  - `base_url`
  - `auth_mode`
  - `secret_ref` 或加密后的凭据字段
  - `status`
  - `capability_cache_json`
  - `policy_json`
  - `last_test_status`
  - `last_test_summary`
  - `created_at / updated_at`
- `acp_call_records`
  - 记录连接器调用审计
  - 关联 `thread_id / connector_id / run_id / tool_use_id`
  - 保存能力名、摘要、耗时、状态、错误概览

建议新增 API：

- `GET /v1/acp-connectors`
- `POST /v1/acp-connectors`
- `GET /v1/acp-connectors/:id`
- `PATCH /v1/acp-connectors/:id`
- `DELETE /v1/acp-connectors/:id`
- `POST /v1/acp-connectors/test`
- `POST /v1/acp-connectors/:id/discover`
- `GET /v1/acp-connectors/:id/capabilities`

接口层原则：

- 普通列表只返回脱敏摘要
- 密钥只在创建或更新时写入，不回显明文
- 能力发现结果走缓存，避免线程运行期间频繁握手
- 每次 discover 和 invoke 都进入统一审计

### Runtime 与工具面设计

ACP 不应绕开当前工具层，而应被收敛为新的受控 runtime tool。

建议新增两类工具：

- `AcpDiscover`
  - 读取当前线程可见的 ACP 系统和能力摘要
  - 让模型先知道有哪些外部系统、各自的边界和适用场景
- `AcpInvoke`
  - 调用指定 ACP connector 的某项能力
  - 支持文本结果、结构化结果、长任务状态和错误摘要

必要时可继续补：

- `AcpTask`
  - 面向长任务或可恢复任务的统一封装
  - 与现有 thread run / interrupt / replan 状态联动

与现有系统对齐方式：

- system prompt 中按当前 thread / project 注入“已连接外部系统”摘要
- 模型看到的是能力说明、权限边界、适用场景，不是原始协议配置
- ACP 返回的文本、表格、图表、关系图统一走现有 `ArtifactEmit` 和 evidence/workbench 主链路
- 远端长任务进度映射到现有 SSE 事件，不额外发明第二套前端事件通道

### 前端设计

前端应把 ACP 做成“管理侧接入 + 会话侧使用”的双层模式。

管理侧：

- 在现有设置/管理结构下新增 `外部系统` 或 `ACP 接入`
- 支持新增连接器、测试连接、查看能力摘要、启用/停用、范围绑定
- 把协议、认证、超时、重试等高级项收进折叠区，不进入普通聊天主路径

会话侧：

- 在线程启动或项目设置中选择启用哪些外部系统
- 在聊天区只展示“已接入能力”与“本轮调用结果”
- 右侧结果区继续统一承接 ACP 输出，不单独做调试面板
- 若某项 ACP 能力属于外部动作型能力，则在消息内清晰标识其影响范围和执行状态

### 安全、多租户与治理

ACP 接入如果直接放开，会比普通资料源和技能更容易引入越权与外部副作用，因此需要单独治理。

必须落实：

- 租户隔离
  - connector 归属 `tenant_id`
  - 默认不跨租户共享能力缓存和密钥
- 密钥治理
  - 统一加密存储
  - 前端永不回显明文
  - 支持轮换与禁用
- 出网策略
  - 维护 ACP 目标地址 allowlist
  - 配置超时、重试和并发上限
- 权限策略
  - 默认只读
  - 对有外部副作用的能力，增加项目级开关和必要时的用户确认
- 审计
  - 每次 discover / invoke 都记录连接器、能力名、耗时、结果摘要、失败原因
- 展示策略
  - 普通用户默认看到“发生了什么”和“拿到了什么”
  - 原始错误 payload、协议细节和后台地址只在 operator 侧或诊断侧可见

### 分阶段开发计划

#### Phase A：Outbound ACP 连接器

目标：

- 让 `clawd` 能稳定连接外部 ACP 系统，并把其能力接入线程执行链路

任务：

- 新增 `acp_connectors` / `acp_call_records` schema 与 migration
- 新增 connector CRUD、test、discover API
- 完成密钥存储、连接测试、能力摘要缓存
- 新增 `AcpDiscover` / `AcpInvoke`
- 把已启用 connector 摘要注入 system prompt
- 将调用过程映射为 thread audit 与 SSE 事件

验收：

- 用户可以在管理侧接入一个外部 ACP 系统
- 线程可以调用远端能力并得到可展示结果
- 失败、超时、中断和重规划都能写入审计并在前端正确反馈

#### Phase B：ACP 结果标准化

目标：

- 让 ACP 返回结果自然融入现有聊天、结果和引用体验

任务：

- 把 ACP 返回内容统一映射为 `text / markdown / table / chart / graph`
- 将可引用结果并入 evidence / artifact 引用体系
- 对长任务型响应补充进度、阶段状态和最终结果汇总

验收：

- ACP 结果不需要单独 UI 组件也能在主舞台完成查看和追问
- 用户能从回答跳回对应 ACP 结果或引用块

#### Phase C：Inbound ACP 兼容层

目标：

- 让外部系统能以 ACP 方式驱动 `clawd`

任务：

- 在 `thread/create/run/events` 之上封装 ACP 兼容入口
- 把 thread lifecycle 映射为 ACP task lifecycle
- 增加面向外部系统的鉴权、配额和审计

验收：

- 外部 ACP 客户端可创建任务、接收进度、获取最终结果
- 不破坏当前 Web 聊天主链路

#### Phase D：治理与生产化

目标：

- 让 ACP 能力满足多人在线使用场景下的稳定性和可控性要求

任务：

- connector 配额、并发、超时和重试策略
- 高风险远端动作审批
- 失败恢复与更稳的后台长任务续跑
- operator 侧诊断与租户级统计

验收：

- ACP 连接器在多租户部署下可追踪、可限流、可禁用、可审计
- 不会把外部系统接入能力变成普通用户可见的后台协议噪音

## 现状判断

### 适合作为服务内核复用的部分

- `runtime::ConversationRuntime`
- `runtime::Session` / `runtime::SessionStore`
- `runtime::PermissionPolicy`
- `api::ProviderClient`
- `runtime::load_system_prompt`
- `tools::GlobalToolRegistry`

### 不适合直接暴露为多人服务面的部分

- `rusty-claude-cli` 仍是 CLI 组装层，不是多租户服务边界
- `TaskRegistry` / `WorkerRegistry` 是进程级全局单例，不适合直接暴露给多人 HTTP 服务
- 内置工具大量依赖进程级 `cwd`，如果不做服务层重写会把不同用户线程串到同一工作目录
- provider streaming 在 runtime 中最终被聚合成 `Vec<AssistantEvent>`，服务层仍需补一个事件转发层

### 仓库改造结论

- 不能继续走 CLI 包 HTTP 的路线
- 正确方向是新增服务 crate，让 Rust runtime 退到“内核层”
- 前端不应该直接依赖 CLI 心智，而应该围绕“线程 + 事件流 + artifact”建模
- `workspace_root` 继续保留为后端内部资源边界，但 Web 用户层应通过“资料集 + 高级接入”表达，不直接暴露底层路径

## 设计原则

- 多用户优先：每个线程必须绑定独立 `workspace_root`、独立 session 和独立状态
- 读优先：一期先把检索、读取、总结、artifact 做稳，不急着开放写文件和 shell
- 软中断优先：先实现可控中断和重规划，再考虑后台长任务恢复
- 服务层兜底：凡是 runtime 内仍带 CLI 假设的地方，都在 `clawd` 中显式收敛
- 前后端解耦：后端先提供稳定线程 API 和 SSE，前端再接入

## 推荐架构

```text
Web Frontend (React)
  -> assistant-ui 聊天壳
  -> 自定义线程列表 / 输入区 / artifact 面板
  -> Markdown / table / chart / graph renderer
  -> 中断 / 重规划 / 主题切换 / 证据回看

clawd (新 Rust 服务)
  -> HTTP API
  -> SSE 事件流
  -> 多线程状态管理
  -> runtime + api + tools 适配层
  -> 自定义 runtime tools:
       EsSearch
       MemoryWrite
       MemorySearch
       TopicDriftCheck
       ArtifactEmit
  -> 线程工作区路径重写与安全工具白名单
  -> project records + thread/project 关联

存储层
  -> runtime SessionStore: 对话持久化
  -> clawd thread records:
       SQLite（默认开发/测试）
       PostgreSQL 17（生产）
       保存线程元数据、projects、记忆、artifacts、audit、tenant_id、owner_id、api_keys
       schema version = 7
  -> Elasticsearch: 检索文档与证据
```

## 前端方案选择

### 推荐

前端优先使用 `React + assistant-ui`。

原因：

- 它只负责聊天 UI 和线程交互，不强绑定某个 agent runtime
- 可以直接对接当前 `clawd` 的 HTTP/SSE 设计，不需要把后端重写成另一个框架的专有协议
- 更适合当前仓库这种“后端内核已经存在，只缺 Web service 和 UI”的场景

### 不推荐一期采用的方向

- 继续沿用 CLI UI 思路
- 把 CopilotKit 这类更重的 agent runtime 一并引入后端
- 先做 Vue 前端再倒逼后端协议

这些方案不是不能做，而是会扩大一次性改造面，拖慢服务层落地。

## 前端产品化对齐目标

当前前端已经具备多线程聊天、打断重规划、结构化 artifact、证据回看、skill 管理这些主能力，但还不能算业界成品级工作台。

接下来前端按下面 4 条主线持续收敛：

- 工作台优先：
  - 中间保留对话
  - 右侧固定为结果工作区
  - artifact、证据、轨迹不要继续堆在消息列表
  - 设置、项目维护、技能管理等次级能力继续收敛到抽屉或独立面板，不回到主聊天视图
  - 顶部会话信息条保持轻量，只保留必要上下文和动作入口，不再恢复 dashboard 式大头部
- 控制台降噪：
  - API key、鉴权、事件流、配额等收敛到独立服务控制台
  - 默认用户面只暴露与任务相关的信息
  - 这条主线已补到独立 surface 切换，后续只继续优化 operator 信息架构
- 项目层补齐：
  - 后续从 thread 升级到 `project -> thread` 双层模型
  - 把共享知识、共享 skills、成员权限放到 project 层
- 引用闭环：
  - 最终回答要能和证据卡、artifact、关系图做双向联动
  - 页面要支持“从结论回看证据”，而不只是旁边再放一个证据列表
  - 当前已做到消息级联动和 deeplink，下一步是段落级或块级锚点

## 服务边界

新增 crate：`rust/crates/clawd`

一期只解决服务底座，不把前端一并塞进当前 Rust workspace。前端后续独立放在 `web/`。

`clawd` 负责：

- 创建线程
- 保存/恢复线程元数据
- 为每个线程运行独立的 conversation turn
- 输出线程快照和增量事件
- 实现软中断
- 提供重规划入口
- 提供线程主题与草稿状态
- 提供最小可用的自定义 runtime tools
- 将内置读工具绑定到线程工作区

`clawd` 不负责：

- 完整 IAM / SSO / 企业级身份系统
- 生产级数据库迁移
- 多机分布式调度
- 前端组件库渲染细节
- 长期记忆向量化与召回排序

## 线程模型

### 每个线程的持久化字段

- `id`
- `tenant_id`
- `owner_id`
- `workspace_root`
- `session_path`
- `model`
- `permission_mode`
- `topic`
- `memory_notes`
- `artifacts`
- `created_at_ms`
- `updated_at_ms`

### 每个线程的运行时字段

- `session`
- `visible_memory_notes`
- `status`
- `last_error`
- `draft_assistant_text`
- `next_run_id`
- `current_run`
- `pending_replan`

### 当前多用户隔离

- 每个 thread 绑定 `tenant_id + owner_id`
- `GET /v1/threads`、`GET /v1/threads/:id`、`POST /v1/threads/:id/commands`、`GET /v1/threads/:id/events` 都按 tenant + owner 过滤
- 正式路径通过 API key 解析鉴权上下文：
  - `Authorization: Bearer <api_key>`
  - `X-CLAWD-API-KEY`
  - `api_key` query 参数，主要供 SSE / EventSource 使用
- 开发模式可选保留 `X-CLAWD-USER-ID` / `user_id` 兜底

### 状态机

- `idle`
- `running`
- `interrupt_requested`
- `failed`

### 运行策略

- 每次用户消息或重规划请求，基于当前 `session` 构造新的 `ConversationRuntime`
- 运行完成后再把更新后的 `session` 回写到线程状态
- 打断时触发 `HookAbortSignal`
- 如果运行被打断后仍返回，则当前轮结果不应继续影响后续规划
- 若线程在运行中收到 `replan`，先排队，再请求中断，当前轮结束后自动启动新的 replan turn

## 工具策略

### 一期开放的内置工具

- `read_file`
- `glob_search`
- `grep_search`

### 一期不开放给模型的高风险工具

- `bash`
- `write_file`
- `edit_file`
- 任务/worker/team/cron 相关工具

原因：

- 它们要么依赖进程级 `cwd`
- 要么需要更完整的多租户权限与执行隔离
- 要么并非当前“读资料、总结、展示”的核心需求

### 一期自定义 runtime tools

#### `EsSearch`

用途：

- 对 Elasticsearch 发起检索，返回结构化命中

约束：

- 单 ES endpoint
- 从环境变量读取连接参数
- 返回原始命中，前端可据此展示证据卡片

#### `MemoryWrite`

用途：

- 把稳定结论、关键假设、主题边界写入 `thread | workspace | tenant` 记忆

#### `MemorySearch`

用途：

- 在 `thread | workspace | tenant` 记忆中做快速检索，帮助多轮分析维持一致性

#### `TopicDriftCheck`

用途：

- 对“当前主题”和“候选分析摘要”做轻量偏航评分
- 作为模型自校验辅助工具，不代替最终判断

#### `ArtifactEmit`

用途：

- 让模型显式提交结构化输出，供前端渲染

支持类型：

- `text`
- `markdown`
- `table`
- `chart`
- `graph`

## 提示词附加策略

服务端在仓库默认 system prompt 之外追加 Web Agent 约束：

- 优先围绕当前主题组织检索与总结
- 先搜索证据，再深读原文
- 对显著结论尽量写入记忆
- 遇到疑似偏题时先自检，再收窄检索
- 需要结构化可视化输出时优先使用 `ArtifactEmit`
- 重规划时先给出新的分析路线，再继续深读

## API 设计

### `GET /healthz`

健康检查

### `GET /v1/config`

返回服务默认配置与数据库状态：

- `database_backend`
- `database_schema_version`
- `default_model`（服务级运行默认值，仅运维和后端兼容使用，普通 Web 工作台不展示为可编辑配置）
- `default_permission_mode`
- `run_timeout_secs`
- `max_threads_per_user`
- `max_threads_per_tenant`
- `max_concurrent_runs_global`
- `max_concurrent_runs_per_tenant`
- `max_concurrent_runs_per_user`
- `max_mutation_requests_per_minute_global`
- `max_mutation_requests_per_minute_per_tenant`
- `max_mutation_requests_per_minute_per_user`
- `api_key_auth_enabled`
- `dev_user_header_auth_enabled`
- `allowed_roots`

### `GET /v1/auth/session`

返回当前请求解析到的鉴权上下文：

- `auth_mode = api_key | dev_user_header`
- `tenant_id`
- `user_id`
- `api_key_id`
- `api_key_prefix`
- `display_name`

### `GET /v1/api-keys`

列出当前 `tenant_id + user_id` 下的 API key 元数据：

- `id`
- `display_name`
- `key_prefix`
- `created_at_ms`
- `updated_at_ms`
- `last_used_at_ms`
- `disabled_at_ms`

### `POST /v1/api-keys`

基于当前鉴权上下文创建新的 API key。

请求：

```json
{
  "display_name": "Browser"
}
```

响应：

```json
{
  "api_key": {
    "id": "api-key-...",
    "display_name": "Browser",
    "key_prefix": "ck_ab12",
    "created_at_ms": 1776079343481,
    "updated_at_ms": 1776079343481,
    "last_used_at_ms": null,
    "disabled_at_ms": null
  },
  "raw_key": "ck_ab1234..."
}
```

说明：

- `raw_key` 只在创建时返回一次
- 仅允许 tenant-scoped API key 会话创建和管理 key

### `POST /v1/api-keys/:id/disable`

禁用当前 `tenant_id + user_id` 下的指定 key。

约束：

- 已禁用 key 再次禁用会返回 `404`
- 当前正在使用的 key 不允许自禁用，必须先切换到另一个 key

### `GET /v1/threads`

列出线程摘要

### `POST /v1/threads`

创建线程

请求：

```json
{
  "workspace_root": "/abs/path",
  "model": "claude-sonnet-4-6",
  "permission_mode": "read-only",
  "topic": "分析某主题资料"
}
```

### `GET /v1/threads/:id`

返回线程快照

### `GET /v1/threads/:id/events`

SSE 事件流

事件类别：

- `snapshot`
- `run_started`
- `status_changed`
- `assistant_text_delta`
- `tool_use`
- `tool_result`
- `artifact_added`
- `audit_added`
- `run_completed`
- `run_failed`

### `POST /v1/threads/:id/commands`

请求：

```json
{ "type": "user_message", "content": "继续分析这些材料" }
```

```json
{ "type": "interrupt", "reason": "范围偏了" }
```

```json
{ "type": "replan", "reason": "先聚焦 A 主题", "topic": "A 主题" }
```

```json
{ "type": "set_topic", "topic": "新的主题边界" }
```

## Artifact 协议建议

一期 artifact payload 仍然走通用 JSON，但字段已经收敛到前端可直接消费的 schema。

前端约定：

- `text`
  - 直接渲染纯文本
- `markdown`
  - 交给 Markdown 渲染器
- `table`
  - 约定 `columns` + `rows`
  - `columns` 支持 `["name", "score"]` 或 `[{ "key": "name", "label": "名称" }]`
- `chart`
  - 约定：
    - `type = line | bar | area | pie`
    - `data = [{...}]`
    - `line/bar/area` 使用 `xKey` + `series[]`
    - `pie` 使用 `labelKey` + `valueKey`
- `graph`
  - 约定 `nodes` + `edges`
  - `nodes` 支持显式坐标，也支持前端自动布局

建议 payload 示例：

```json
{
  "kind": "table",
  "payload": {
    "columns": [
      { "key": "source", "label": "Source" },
      { "key": "score", "label": "Score" }
    ],
    "rows": [
      { "source": "README.md", "score": 0.92 }
    ]
  }
}
```

```json
{
  "kind": "chart",
  "payload": {
    "type": "bar",
    "title": "Evidence Count By Topic",
    "xKey": "topic",
    "series": [
      { "key": "count", "label": "Count", "color": "#195f59" }
    ],
    "data": [
      { "topic": "runtime", "count": 12 },
      { "topic": "tools", "count": 7 }
    ]
  }
}
```

```json
{
  "kind": "graph",
  "payload": {
    "title": "Topic Relationship",
    "nodes": [
      { "id": "runtime", "label": "Runtime" },
      { "id": "tools", "label": "Tools" }
    ],
    "edges": [
      { "source": "runtime", "target": "tools", "label": "calls" }
    ]
  }
}
```

这样后端只负责存储和广播，前端负责具体渲染组件。

## 记忆模型

当前记忆模型已经支持两级 scope：

- `thread`
  - 仅当前线程可见
- `workspace`
  - 在同一 `tenant_id + owner_id + workspace_root` 下跨线程可见

当前仍不是跨用户长期记忆，也还没有 tenant 全局共享记忆。

写入原则：

- 仅保存稳定结论
- 保存主题边界与排除项
- 保存已验证的重要证据来源
- 不保存每一轮草稿推理
- `workspace` 只用于跨线程复用价值明显的稳定结论
- `thread` 用于当前线程内的临时边界和局部上下文

后续升级方向：

- `memory_scope = thread | workspace | tenant`
- 引入 embedding 检索
- 引入记忆失效与人工清理机制

## 中断与重规划策略

### 中断

- 当前轮运行时设置 `HookAbortSignal`
- 服务层将线程状态改为 `interrupt_requested`
- provider stream 或工具执行在感知到中断后尽快退出

### 重规划

- 若当前空闲，直接启动 replan turn
- 若当前运行中，将 replan 放入 `pending_replan`
- 当前轮中断后自动执行最新 replan 请求

### 为什么先做软中断

- 当前 runtime 没有天然面向服务的强取消协议
- 软中断已经足够覆盖“用户打断重新规划”的产品需求
- 这能在不重写 runtime 心脏的情况下快速落地

## 安全与隔离

一期先做最小必要隔离：

- 线程创建时校验 `workspace_root` 必须在 `CLAWD_ALLOWED_ROOTS` 下
- 仅暴露读工具和自定义工具
- 相对路径全部重写为线程工作区下的绝对路径
- 默认权限模式为 `read-only`
- 为多用户服务增加基础治理：
  - `CLAWD_MAX_THREADS_PER_USER`
  - `CLAWD_MAX_THREADS_PER_TENANT`
  - `CLAWD_MAX_CONCURRENT_RUNS_GLOBAL`
  - `CLAWD_MAX_CONCURRENT_RUNS_PER_TENANT`
  - `CLAWD_MAX_CONCURRENT_RUNS_PER_USER`
  - `CLAWD_MAX_MUTATION_REQUESTS_PER_MINUTE_GLOBAL`
  - `CLAWD_MAX_MUTATION_REQUESTS_PER_MINUTE_PER_TENANT`
  - `CLAWD_MAX_MUTATION_REQUESTS_PER_MINUTE_PER_USER`
  - 设为 `0` 表示关闭对应限制

后续再补：

- API key 管理与轮换
- 更细粒度租户隔离
- 后台任务隔离执行
- 更严格的 shell 沙箱与工作区授权

## 当前实现状态

截至本次改造，已经完成：

- 新增 `rust/crates/clawd`
- 新增线程创建、列表、快照、命令接口
- 新增 SSE 事件流
- 新增线程元数据持久化
- 新增 `/v1/config` 配置接口
- 复用 `SessionStore` 与 runtime session
- 实现 `EsSearch` / `MemoryWrite` / `MemorySearch` / `TopicDriftCheck` / `ArtifactEmit`
- 实现软中断与重规划排队
- 将 `read_file` / `glob_search` / `grep_search` 绑定到线程工作区
- 收紧工具白名单，避免多人服务误用 CLI 全局工具
- 新增 `web/` React 前端骨架
- 前端已接入线程列表、assistant-ui 聊天区、SSE、打断/重规划、记忆与 artifact 面板
- assistant-ui 已通过 `ExternalStoreRuntime` 适配 `clawd` 线程状态与命令接口
- 已实现 workspace / tenant 级共享记忆，并在前端“可见记忆”面板展示 scope
- 已为 `EsSearch` 增加前端证据面板，展示 query / index / fields / `_source` / hits / error detail
- assistant-ui 内的 `EsSearch` tool result 已改为结构化摘要卡，而不是仅显示原始 JSON
- 已新增 API key 鉴权与 tenant/user 上下文，前端已切换到 API key 优先模式
- 数据库 migration 已推进到 schema v5，支持 tenant 维度、独立 `api_keys`、以及 `audit_records`
- PostgreSQL 路径已切换为 `tokio-postgres` worker，避免在 Tokio runtime 内调用阻塞客户端导致 panic
- 前端已新增持久审计面板，展示最近线程审计轨迹和原始 payload
- 前端已补充 `vitest` 契约测试，覆盖 `threadEventsUrl`、线程命令请求和 `EsSearch` 证据提取逻辑
- 前端已新增 API key 管理面板，支持查看、创建、切换和禁用当前用户 key
- 前端已展示当前线程/并发配额配置，便于多人部署时排障
- 前端已展示当前 mutation rate limit 配置，便于定位 `429` 来源
- 线程状态已持久化 `last_status / last_error / next_run_id`，服务重启后会纠正 stale running thread
- 已新增 `rust/scripts/run_clawd_pg17_smoke.sh`，把 PostgreSQL 17 smoke 验证收敛成可重复执行脚本

本次验证结果：

- `cargo test -p clawd` 通过（24 tests）
- `npm test` 通过（8 tests）
- `npm run build` 通过
- `rust/scripts/run_clawd_pg17_smoke.sh` 通过
- 本地启动 `clawd` 并命中 `/v1/config` 成功，返回 `database_backend = sqlite`、`database_schema_version = 5`
- SQLite service smoke 成功：
  - 同用户同工作区创建两个线程
  - 注入一条 `scope = workspace` 记忆后重启服务
  - 第二个线程快照可见该共享记忆
  - 不同用户在同工作区下看不到该共享记忆
- PostgreSQL 17 service smoke 成功：
  - 容器化启动 `postgres:17`
  - `clawd` 在 `database_backend = postgres` 下正常启动
  - `/v1/config` 返回 `database_schema_version = 5`
  - `GET /v1/auth/session` 返回 `auth_mode = api_key`、`tenant_id = tenant-a`、`user_id = alice`
  - `GET /v1/api-keys` 返回 bootstrap key 元数据
  - `POST /v1/api-keys` 成功创建新 key，并只回传一次 `raw_key`
  - 切换到新 key 后，`POST /v1/api-keys/:id/disable` 可禁用旧 key
  - 被禁用的旧 key 随后访问 `/v1/auth/session` 返回 `401`
  - 对当前正在使用的 key 调用 disable 会返回错误，避免自禁用
  - 线程创建配额超限时返回 `429`
  - mutation rate limit 超限时线程命令返回 `429`

## 分阶段开发计划

### Phase 1：服务底座

目标：

- 让 Rust runtime 可以作为多用户 Web 服务内核稳定运行

任务：

- `clawd` crate
- 线程创建/快照/SSE
- `user_message` / `interrupt` / `replan` / `set_topic`
- SessionStore 持久化
- `EsSearch`
- `MemoryWrite` / `MemorySearch`
- `TopicDriftCheck`
- `ArtifactEmit`
- 线程工作区路径重写
- 安全工具白名单

验收：

- 多个线程能同时存在
- 每个线程绑定独立 workspace
- agent 能搜索/读取本地资料并生成 artifact
- 用户能打断并重规划

### Phase 2：Web 前端

目标：

- 提供可用的多人 Web 聊天界面

任务：

- 新建 `web/` React 项目
- 接入 `assistant-ui`
- 线程列表页
- 聊天窗口 + SSE 增量渲染
- artifact 面板
- 证据卡片与来源面板
- 中断 / 重规划 / 主题编辑操作

验收：

- 用户可以在浏览器中创建线程、发送消息、接收流式回复
- `markdown/table/chart/graph` 可被渲染
- 中断和重规划可在 UI 中操作

### Phase 3：记忆与分析增强

目标：

- 提升“持续分析资料”的稳定性

任务：

- 记忆打标与去重
- 引入 embedding 检索
- 更强的 drift policy
- 证据引用和结论回链
- workspace 级记忆 UI/检索体验打磨

验收：

- 长轮对话不易偏题
- 主题切换后可以保留历史结论但不污染新主题

### Phase 4：服务化与生产化

目标：

- 让多人系统可部署、可运维

任务：

- PostgreSQL 17 部署与 schema migration 运维
- 鉴权和租户隔离
- 任务队列与后台运行
- 可恢复长任务
- 观测与审计

验收：

- 多用户并发运行稳定
- 服务重启后可恢复线程和 artifact
- 可审计每次中断、重规划、工具调用和失败原因

## 风险

- 当前 runtime 的 streaming 抽象仍是同步聚合接口，服务层只能在适配器里桥接增量事件
- `TaskRegistry` / `WorkerRegistry` 仍是全局单例，不宜直接暴露为多用户服务 API
- 打断当前实现属于软中断，依赖 provider stream drop 与 hook abort 协作
- 当前仍是单进程内存驻留线程调度，不适合多实例水平扩容
- 当前“恢复”仅覆盖线程状态修复与审计补录，还不等同于真正的后台任务续跑

## 下一步建议

紧接着应该做的开发项：

1. 把 PostgreSQL 17 smoke 固化进 CI 或运维脚本
2. 增加 API key 轮换审计、请求级限速和 usage 指标
3. 为线程运行补真正的后台恢复和更稳的任务队列
4. 继续增强 tenant / workspace 记忆检索与证据回链
