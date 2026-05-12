# Claw Code 项目总览

更新时间：2026-04-25

## 1. 项目一句话

Claw Code 的主内核仍然是面向代码工作的 agent runtime，但仓库现在已经不只包含 `claw` CLI。

当前有两条并行产物线：

- `claw` CLI：把大模型、工具调用、会话持久化、权限控制、插件、MCP、技能、子代理等能力组合成一个可交互的 coding agent。
- `clawd + web`：把同一套 Rust runtime 收敛为面向多人并发访问的 Web Agent 服务和研究工作台。

仓库当前的事实边界很明确：

- 生产/主运行内核仍在 [`rust/`](../rust/)，这里是 canonical implementation。
- 多人 Web 服务面现在主要落在 [`rust/crates/clawd/`](../rust/crates/clawd/) 和 [`web/`](../web/)。
- 根目录 [`src/`](../src/) 和 [`tests/`](../tests/) 是 Python 参考/迁移工作区，不是当前主运行时。
- 项目既是一个可运行的 CLI 工具，也是一个“自主软件开发工作流”的公开样本。

## 2. 这个仓库是做什么的

从职责上看，这个项目解决的是下面几件事：

- 提供一个可直接运行的 CLI agent：REPL、单次 prompt、JSON 输出、会话恢复、doctor 自检。
- 让模型可以安全地调用本地工具：Shell、文件读写、搜索、Web、Notebook、LSP、MCP、任务/worker/team/cron 等。
- 管理上下文：系统提示词、`CLAUDE.md`、Git 状态、配置文件、会话历史、自动压缩。
- 对接多个模型提供方：Anthropic、xAI、OpenAI-compatible、DashScope，以及本地兼容 OpenAI 接口的服务。
- 承担迁移与对齐职责：通过 mock parity harness、兼容性清单和 Python 参考层，持续验证 Rust 实现对旧表面的覆盖情况。

它仍然不是传统业务应用仓库，但现在已经包含一条真实的 HTTP 产品接口与 Web 前端工作台，用来把 runtime 作为多用户研究型 agent 服务暴露出来。

当前 `web/` 的产品形态已经不再是单页开发控制台，而是分成三层界面：

- `auth gate`：处理 API key / 开发态用户身份接入
- `user workbench`：围绕 project、thread、conversation、artifact/evidence 组织研究流程，并允许在项目层维护默认指令、优先技能和线程启动策略；当前主界面已经收敛为以聊天为中心的单主屏，默认设置抽屉只保留“继续当前任务 / 资料集 / 最近会话”等用户入口，共享策略和技能库则拆到独立管理抽屉，结果/证据/轨迹走右侧 workbench；会话创建入口已继续压缩成 `资料集 / 主题 / 起始消息` 分组；普通用户主路径已开始弱化绝对路径心智，服务器目录只保留在管理侧 `高级接入` 中作为资料集绑定方式；回答区已支持可点击 citation 跳转到 evidence hit / artifact block，并可把引用直接带回下一轮对话，composer 上方也会把当前引用显示为“已附上”的可点击上下文条；主题收束与重规划也已并入输入区组件内部，并继续压轻为会话内 `任务边界` 工具条，同轮步骤会收敛到消息内统一的“本轮进展”面板，连续 assistant 输出也会合并为一轮，避免长回答碎片化；最近一轮结果摘要已继续降噪为更自然的会话辅助信息，右侧 `证据` 面板也开始以 query 概览 + 来源卡片的方式组织，而不是直接暴露检索命中列表
  - 当线程运行失败但尚未形成任何消息时，聊天区会直接显示会话内状态块，而不是欢迎页或空白画布；失败线程顶部也不再重复叠加告警文案，主屏继续保持单一聊天语义
  - 右侧 workbench 已不再只是静态 tab 容器：会根据线程当前是否已有结果或证据选择更合理的默认落点，并在顶部提供本轮产出摘要；`轨迹` 面板也在继续从原始审计流收敛为更适合普通用户阅读的工作记录；从聊天引用跳到结果或来源后，结果块、来源项和命中项现在都有统一高亮动画和滚动留白，欢迎态与“回到最新内容”入口也继续压轻，整体更接近成熟 Web Agent 的聊天主舞台体验；聊天气泡本身也在继续去容器感，朝“按内容自适应宽高”的主流研究产品样式收敛
  - 当某轮暂时没有结构化结果时，`结果` tab 也会引导用户去查看现有证据或工作记录；`证据` tab 则开始向“来源浏览器”收敛，而不只是简单列出检索返回
- `operator console`：集中承载 API key 管理、事件流、配额、持久诊断与可见记忆

## 3. 仓库结构

| 路径 | 作用 |
|---|---|
| [`README.md`](../README.md) | 仓库总入口，明确说明主实现位于 `rust/` |
| [`USAGE.md`](../USAGE.md) | 面向使用者的命令、认证、配置、session、provider 文档 |
| [`rust/`](../rust/) | Rust workspace，包含 `claw` 二进制和所有主逻辑 |
| [`rust/crates/clawd/`](../rust/crates/clawd/) | 多人 Web Agent 服务 crate，提供项目、线程、SSE、技能、鉴权与数据库持久化 |
| [`src/`](../src/) | Python 参考/迁移工作区，用于镜像旧表面、做审计与辅助分析 |
| [`tests/`](../tests/) | Python 工作区对应测试 |
| [`web/`](../web/) | React 工作台前端，提供 `auth gate / user workbench / operator console` 三层界面，以及会话、技能库、artifact/evidence 交互 |
| [`web/scripts/start-dev-preview.sh`](../web/scripts/start-dev-preview.sh) | 本地前端预览脚本，自动寻找可用端口并启动 Vite dev server，便于验收聊天工作台 |
| [`PARITY.md`](../PARITY.md) | Rust 迁移对齐状态、mock parity 清单、已合并 lane |
| [`ROADMAP.md`](../ROADMAP.md) | 中长期路线图、问题清单、近期 backlog |
| [`PHILOSOPHY.md`](../PHILOSOPHY.md) | 项目背后的工作流哲学与系统定位 |
| [`docs/skill-authoring-guide.md`](./skill-authoring-guide.md) | 面向 `clawd` 的 Web skill 编写规范、模板与注意事项 |
| [`docs/expert-brainstorm-integration-plan.md`](./expert-brainstorm-integration-plan.md) | `expert-brainstorm` 多专家会诊能力的 Web 集成方案 |
| [`docs/container.md`](./container.md) | 容器优先开发说明 |
| [`docs/web-agent-service-plan.md`](./web-agent-service-plan.md) | 多用户 Web Agent 服务设计与当前推进状态 |
| [`Dockerfile`](../Dockerfile) | `clawd + web` 生产 Docker 镜像定义 |
| [`Dockerfile.runtime`](../Dockerfile.runtime) | 基于预构建产物打包 `clawd + web` runtime 镜像 |
| [`Containerfile`](../Containerfile) | 开发/测试容器镜像定义 |
| [`install.sh`](../install.sh) | 从源码构建 `claw` 的安装脚本 |
| [`assets/`](../assets/) | 资源文件 |

基于当前工作树的本地统计：

- 9 个 Rust crate
- 78 个 Rust 源文件
- 68 个 Python 文件（`src/` + `tests/`）
- 10 个 Rust 集成测试文件
- 12 个顶层/次顶层 Markdown 文档

## 4. Rust 主实现总览

Rust workspace 由 [`rust/Cargo.toml`](../rust/Cargo.toml) 管理，所有 crate 都在 `rust/crates/*` 下。

### 4.1 Crate 职责

| Crate | 作用 | 关键文件 |
|---|---|---|
| `rusty-claude-cli` | `claw` 二进制入口，参数解析、REPL、输出渲染、直接命令 | [`rust/crates/rusty-claude-cli/src/main.rs`](../rust/crates/rusty-claude-cli/src/main.rs) |
| `runtime` | 会话、配置、权限、系统提示词、MCP 生命周期、核心对话循环 | [`rust/crates/runtime/src/lib.rs`](../rust/crates/runtime/src/lib.rs) |
| `tools` | 工具定义与调度，内置工具、MCP 桥接、任务/worker/team/cron 等 | [`rust/crates/tools/src/lib.rs`](../rust/crates/tools/src/lib.rs) |
| `commands` | Slash command 注册、帮助信息、命令清单与部分共享渲染 | [`rust/crates/commands/src/lib.rs`](../rust/crates/commands/src/lib.rs) |
| `api` | Provider 客户端、请求/流式协议、provider 路由、token 限制预检 | [`rust/crates/api/src/lib.rs`](../rust/crates/api/src/lib.rs) |
| `plugins` | 插件 manifest、安装/启停、插件工具、生命周期与 hooks 元数据 | [`rust/crates/plugins/src/lib.rs`](../rust/crates/plugins/src/lib.rs) |
| `telemetry` | trace 与 telemetry 事件结构、sink 实现 | [`rust/crates/telemetry/src/lib.rs`](../rust/crates/telemetry/src/lib.rs) |
| `compat-harness` | 兼容性/清单抽取辅助层 | [`rust/crates/compat-harness/Cargo.toml`](../rust/crates/compat-harness/Cargo.toml) |
| `mock-anthropic-service` | 本地 deterministic mock 服务，服务于 parity harness | [`rust/crates/mock-anthropic-service/src/lib.rs`](../rust/crates/mock-anthropic-service/src/lib.rs) |

### 4.2 核心大文件

几个大文件几乎决定了项目主行为：

- [`rust/crates/rusty-claude-cli/src/main.rs`](../rust/crates/rusty-claude-cli/src/main.rs)：11,878 行，CLI 主入口与大量用户面逻辑。
- [`rust/crates/tools/src/lib.rs`](../rust/crates/tools/src/lib.rs)：8,607 行，工具面定义与执行。
- [`rust/crates/commands/src/lib.rs`](../rust/crates/commands/src/lib.rs)：5,549 行，slash command 注册表。
- [`rust/crates/runtime/src/mcp_stdio.rs`](../rust/crates/runtime/src/mcp_stdio.rs)：2,928 行，MCP stdio 生命周期与协议处理。
- [`rust/crates/runtime/src/config.rs`](../rust/crates/runtime/src/config.rs)：2,111 行，运行时配置装载与解析。
- [`rust/crates/runtime/src/conversation.rs`](../rust/crates/runtime/src/conversation.rs)：1,699 行，对话循环核心。
- [`rust/crates/runtime/src/session.rs`](../rust/crates/runtime/src/session.rs)：1,515 行，会话持久化格式与存储行为。

如果只想快速理解系统，优先读这些文件。

## 5. 运行链路

下面是 `claw` 从启动到完成一轮任务的主路径：

```text
用户输入
  -> CLI 解析参数 / slash command
  -> 构造 system prompt + 读取配置 + 插件/MCP 状态
  -> 构造 Provider 客户端 + ToolExecutor + PermissionPolicy
  -> ConversationRuntime::run_turn()
  -> 发送模型请求并流式接收事件
  -> 若模型发起 tool use:
       hooks 预处理
       权限决策 / 用户批准
       执行工具
       hooks 后处理
       将 tool_result 追加回 session
  -> 若模型不再请求工具:
       返回 assistant 消息
       记录 usage / telemetry / prompt cache / auto compact
  -> 持久化 session，供 resume / history / export 使用
```

### 5.1 CLI 层

- [`main.rs`](../rust/crates/rusty-claude-cli/src/main.rs) 中的 `main()` 和 `run()` 负责统一入口。
- `CliAction` 枚举定义了顶层动作，例如 `Prompt`、`Repl`、`ResumeSession`、`Doctor`、`Status`、`Init`、`Login`、`Logout`。
- `parse_args()` 负责把顶层参数、单词式 prompt、slash command 代理成统一动作模型。

### 5.2 启动 Runtime

启动运行时的关键函数是：

- `build_runtime()`
- `build_runtime_with_plugin_state()`

它们会组装：

- `ConversationRuntime`
- provider client
- `CliToolExecutor`
- `PermissionPolicy`
- 插件注册表
- MCP 状态

其中有一个容易误解的历史命名：[`main.rs`](../rust/crates/rusty-claude-cli/src/main.rs) 里的 `AnthropicRuntimeClient` 现在内部实际持有的是多 provider 的 `ApiProviderClient`，不再只代表 Anthropic。

### 5.3 对话循环

真正的 agent 回合逻辑在 [`rust/crates/runtime/src/conversation.rs`](../rust/crates/runtime/src/conversation.rs)：

- `ConversationRuntime` 持有 `Session`、`ApiClient`、`ToolExecutor`、`PermissionPolicy`、`HookRunner`、`UsageTracker` 等状态。
- `run_turn()` 的流程是：
  1. 把用户输入追加到 session。
  2. 把 `system_prompt + messages` 组装成 `ApiRequest` 发给 provider。
  3. 从流式事件中拼出 assistant message。
  4. 提取 `ToolUse` block。
  5. 对每个工具调用执行 hook、权限检查、工具执行和结果回写。
  6. 循环直到本轮 assistant 不再请求工具。
  7. 记录 usage、prompt cache 事件、auto compaction。

这一层是项目真正的“心脏”。

## 6. 关键能力面

### 6.1 Provider 路由

`api` crate 负责把模型名和环境变量映射到正确 provider：

- Anthropic
- xAI
- OpenAI-compatible
- DashScope（走 OpenAI-compatible 协议）
- 本地兼容 OpenAI `/v1/chat/completions` 的服务

关键点：

- 模型别名在 [`rust/crates/api/src/providers/mod.rs`](../rust/crates/api/src/providers/mod.rs) 中解析，例如 `opus`、`sonnet`、`haiku`、`grok`。
- provider 选择优先看模型前缀和模型家族，再看环境变量。
- `OPENAI_BASE_URL` 存在时会优先支持本地兼容 OpenAI 服务。
- `clawd` 项目层可以直接保存 `model_base_url` / `model_api_key`。Web 页面只暴露 API 地址和 Key，不再让用户维护默认模型或环境变量名；明文 key 不会通过 project summary 回显。
- 服务启动时会自动读取 provider 环境变量：`CLAWD_DEFAULT_MODEL` 优先，其次可读取 `OPENAI_MODEL` / `DASHSCOPE_MODEL` / `XAI_MODEL` / `ANTHROPIC_MODEL` 以及对应 `*_BASE_URL` / `*_API_KEY`。当项目 API 地址指向非 Anthropic 服务而会话仍继承 Claude 默认模型时，`clawd` 会按 OpenAI-compatible/xAI/DashScope 路由选择运行时模型，避免页面配置看似未生效。
- OpenAI-compatible 路径除了常见的 `/v1/chat/completions` base URL，也已支持直接配置到 `/v1/responses` 的代理地址；为兼容一些历史部署，若该地址并非 Anthropic 官方地址，运行时也会把 `ANTHROPIC_BASE_URL` / `ANTHROPIC_AUTH_TOKEN` 视为 OpenAI-compatible 代理配置来源。
- Anthropic 路径支持 prompt cache；OpenAI-compatible/xAI 路径没有该特性。

### 6.2 命令面

命令面分成两层：

- 顶层 CLI 子命令，例如 `prompt`、`status`、`sandbox`、`agents`、`mcp`、`skills`、`doctor`。
- REPL 内的 slash commands，由 `commands` crate 维护。

当前命令注册表里有 142 个 `SlashCommandSpec`。常见类别包括：

- 会话与状态：`/help`、`/status`、`/sandbox`、`/cost`、`/resume`
- 工作区与 Git：`/diff`、`/commit`、`/pr`、`/issue`、`/branch`
- 能力管理：`/agents`、`/skills`、`/mcp`、`/plugin`
- 分析与自动化：`/review`、`/advisor`、`/insights`、`/security-review`

### 6.3 工具面

工具面由 `tools` crate 提供。当前源码中可见 52 个唯一工具名，核心类别包括：

- 文件与 shell：`bash`、`read_file`、`write_file`、`edit_file`、`glob_search`、`grep_search`
- Web：`WebFetch`、`WebSearch`
- 工作流：`TodoWrite`、`Skill`、`Agent`、`ToolSearch`
- 文档/Notebook：`NotebookEdit`
- 用户交互：`SendUserMessage`、`AskUserQuestion`
- 任务系统：`TaskCreate`、`TaskGet`、`TaskList`、`TaskStop`、`TaskUpdate`、`TaskOutput`
- Worker/编队：`WorkerCreate`、`WorkerObserve`、`WorkerSendPrompt`、`TeamCreate`、`CronCreate`
- 代码智能：`LSP`
- 外部工具生态：`ListMcpResources`、`ReadMcpResource`、`McpAuth`、`MCP`

这说明它不是一个“只有 shell 和读写文件”的轻量 CLI，而是明显朝通用 agent runtime 的方向扩展。

### 6.4 权限与 Hook

权限系统在 [`rust/crates/runtime/src/permissions.rs`](../rust/crates/runtime/src/permissions.rs)。

支持的主模式包括：

- `read-only`
- `workspace-write`
- `danger-full-access`

此外还有内部决策态：

- `prompt`
- `allow`

权限决策会综合：

- 当前运行模式
- 每个工具所需权限
- allow/deny/ask 规则
- hook 注入的 override
- 交互式批准提示

Hook 相关逻辑分布在：

- [`rust/crates/runtime/src/hooks.rs`](../rust/crates/runtime/src/hooks.rs)
- [`rust/crates/plugins/src/hooks.rs`](../rust/crates/plugins/src/hooks.rs)

### 6.5 配置与上下文注入

系统提示词并不是一段固定文本，而是运行时动态装配：

- OS 与日期
- 当前工作目录
- Git status / diff / recent commits
- `CLAUDE.md`、`CLAUDE.local.md`、`.claw/CLAUDE.md`、`.claw/instructions.md`
- 运行时配置 JSON

这些逻辑在 [`rust/crates/runtime/src/prompt.rs`](../rust/crates/runtime/src/prompt.rs)。

### 6.6 Session 与恢复

会话能力由 [`rust/crates/runtime/src/session.rs`](../rust/crates/runtime/src/session.rs) 和 [`rust/crates/runtime/src/session_control.rs`](../rust/crates/runtime/src/session_control.rs) 提供：

- 会话消息以结构化 block 保存：`Text`、`ToolUse`、`ToolResult`
- 支持 prompt history、fork、compaction、model 元数据
- 支持 `json`/`jsonl` 兼容装载
- 会话默认落在按 workspace 指纹隔离的目录：`.claw/sessions/<workspace_hash>/`

这套设计的目标不是单纯“保存聊天记录”，而是保证并行工作树/并行 lane 下不会串会话。

### 6.7 MCP / Plugin / LSP / Worker

这是该项目区别于简单 CLI agent 的几个高级子系统：

- MCP
  - 配置支持 stdio、HTTP/SSE、WebSocket、SDK、managed proxy。
  - `runtime/mcp_stdio.rs` 负责本地 stdio server 启动、握手、资源与工具调用。
- Plugin
  - 插件 manifest 位于 `.claude-plugin/plugin.json`。
  - 支持权限、hooks、lifecycle、commands、tools。
- LSP
  - 提供 symbols、references、diagnostics、definition、hover 等代码智能入口。
- Worker / Team / Cron
  - 提供 agent 编队和计划任务基础设施。
  - 当前不少能力仍以 registry/in-memory 生命周期为主，而不是完整的分布式调度系统。

## 7. 配置体系

运行时配置加载顺序是：

1. `~/.claw.json`
2. `~/.config/claw/settings.json`
3. `<repo>/.claw.json`
4. `<repo>/.claw/settings.json`
5. `<repo>/.claw/settings.local.json`

后者覆盖前者。

`RuntimeConfig` 可以承载的核心配置包括：

- model 与 alias
- permissions 与 permission rules
- MCP server 配置
- OAuth
- hooks
- plugin 启用状态与安装路径
- provider fallback
- sandbox

这意味着该项目的配置不是“只有一个 API key”的简单级别，而是一个完整的 runtime 配置层。

## 8. 系统提示词与 `CLAUDE.md`

`claw` 很依赖仓库内指导文件。`prompt.rs` 会沿当前目录向上发现并读取：

- `CLAUDE.md`
- `CLAUDE.local.md`
- `.claw/CLAUDE.md`
- `.claw/instructions.md`

同时会做：

- 去重
- 截断
- 按 prompt budget 控制总字符量

CLI 里还有 [`rust/crates/rusty-claude-cli/src/init.rs`](../rust/crates/rusty-claude-cli/src/init.rs)，用于为仓库初始化：

- `.claw/`
- `.claw.json`
- `.gitignore` 补充项
- `CLAUDE.md`

这说明项目把“仓库级 agent 指令”视为一等公民，而不是辅助文档。

## 9. 测试与质量保障

### 9.1 Rust 集成测试

当前可见的 Rust 集成测试文件包括：

- `api/tests/client_integration.rs`
- `api/tests/openai_compat_integration.rs`
- `api/tests/provider_client_integration.rs`
- `api/tests/proxy_integration.rs`
- `runtime/tests/integration_tests.rs`
- `rusty-claude-cli/tests/cli_flags_and_config_defaults.rs`
- `rusty-claude-cli/tests/compact_output.rs`
- `rusty-claude-cli/tests/mock_parity_harness.rs`
- `rusty-claude-cli/tests/output_format_contract.rs`
- `rusty-claude-cli/tests/resume_slash_commands.rs`

这些测试覆盖的重点不是 UI，而是：

- provider 路由
- 输出契约
- resume 行为
- parity harness
- 配置默认值
- compact 与 session 行为

### 9.2 Mock parity harness

这是项目非常核心的一层保障，位于：

- [`rust/crates/mock-anthropic-service/`](../rust/crates/mock-anthropic-service/)
- [`rust/crates/rusty-claude-cli/tests/mock_parity_harness.rs`](../rust/crates/rusty-claude-cli/tests/mock_parity_harness.rs)

它通过一个本地 deterministic mock Anthropic 服务，验证以下典型回合：

- 流式文本
- 文件读写
- grep 拼接
- 多工具回合
- bash 输出
- 权限批准/拒绝
- plugin 工具回合
- auto compact

### 9.3 Python 参考层测试

[`tests/test_porting_workspace.py`](../tests/test_porting_workspace.py) 主要验证：

- Python 工作区 manifest 能生成
- 命令/工具镜像快照不是空壳
- `src.main` 下的摘要、路由、bootstrap、parity-audit 等辅助 CLI 能运行

它验证的是“迁移工作区是否仍然可用于分析和审计”，不是产品主运行时是否可用。

## 10. Python 参考工作区是什么

根目录 [`src/`](../src/) 的定位可以概括为三句话：

- 它不是当前主产品运行时。
- 它是迁移/参考/审计工作区。
- 它镜像了旧 TypeScript 表面的一部分命令和工具信息，用于辅助移植和对齐。

从本地执行结果看，Python 工作区目前包含：

- 67 个 Python 文件
- 207 个 mirrored command entries
- 184 个 mirrored tool entries

它能做的事情包括：

- 输出 workspace summary
- 生成 port manifest
- 路由 prompt 到镜像命令/工具
- 输出 bootstrap/turn-loop 报告
- 做 parity audit

很多子包只是 archived subsystem 的 placeholder，并不意味着对应运行时仍由 Python 承担。

## 11. 文档地图

这个仓库的文档层次比较完整，建议按用途理解：

- [`README.md`](../README.md)
  - 适合第一次打开仓库时看，快速建立“这是什么项目”的心智模型。
- [`docs/runtime-call-flow.md`](./runtime-call-flow.md)
  - 适合想追一条真实请求从 CLI 到 tool loop 的完整链路。
- [`docs/module-index.md`](./module-index.md)
  - 适合需要按目录/文件快速定位问题时查索引。
- [`docs/runtime-subsystems.md`](./runtime-subsystems.md)
  - 适合系统理解 `runtime` crate 的子系统边界和职责划分。
- [`docs/testing-map.md`](./testing-map.md)
  - 适合判断当前 CI、测试层次和某类改动该补哪种验证。
- [`USAGE.md`](../USAGE.md)
  - 适合真正准备运行 `claw` 时看，覆盖 auth、provider、session、config、doctor。
- [`rust/README.md`](../rust/README.md)
  - 适合想进入代码时看，给出 crate 视角的结构图。
- [`PARITY.md`](../PARITY.md)
  - 适合理解“Rust 版和旧表面的对齐到了哪一步”。
- [`ROADMAP.md`](../ROADMAP.md)
  - 适合理解作者当前最关心的问题、下一阶段演进方向以及真实使用中的痛点。
- [`PHILOSOPHY.md`](../PHILOSOPHY.md)
  - 适合理解为什么项目会长成这样，以及它为什么强调多 agent、Discord、通知路由和 clawhip。
- [`docs/container.md`](./container.md)
  - 适合容器内开发与测试。

## 12. 当前成熟度判断

从代码和文档综合判断，这个项目处于“可运行、可验证、快速演进”的阶段。

可以明确认为它已经具备：

- 可用的 CLI 主路径
- 多 provider 路由
- 较大的命令/工具面
- 会话管理与恢复
- MCP / plugin / skills / subagent 等高级表面
- parity harness 与较系统化的测试

同时也要保留两个现实判断：

- 项目仍在快速变化，文档里多次强调 command surface is moving quickly。
- 某些高级子系统已经有 registry 与生命周期桥接，但并不等于已经具备完整的生产级编排平台能力。

## 13. 推荐阅读顺序

### 如果你的目标是“先知道项目整体在干什么”

1. [`README.md`](../README.md)
2. [`PHILOSOPHY.md`](../PHILOSOPHY.md)
3. [`USAGE.md`](../USAGE.md)
4. 本文档

### 如果你的目标是“开始改代码”

1. [`rust/README.md`](../rust/README.md)
2. [`rust/crates/rusty-claude-cli/src/main.rs`](../rust/crates/rusty-claude-cli/src/main.rs)
3. [`docs/runtime-call-flow.md`](./runtime-call-flow.md)
4. [`docs/module-index.md`](./module-index.md)
5. [`rust/crates/runtime/src/conversation.rs`](../rust/crates/runtime/src/conversation.rs)
6. [`rust/crates/tools/src/lib.rs`](../rust/crates/tools/src/lib.rs)
7. [`rust/crates/runtime/src/config.rs`](../rust/crates/runtime/src/config.rs)

### 如果你的目标是“判断迁移状态和真实完成度”

1. [`PARITY.md`](../PARITY.md)
2. [`ROADMAP.md`](../ROADMAP.md)
3. [`rust/crates/rusty-claude-cli/tests/mock_parity_harness.rs`](../rust/crates/rusty-claude-cli/tests/mock_parity_harness.rs)
4. [`tests/test_porting_workspace.py`](../tests/test_porting_workspace.py)

## 14. 总结

Claw Code 的本质不是“一个用 Rust 重写的聊天命令行”，而是一个正在演进的 agent runtime 平台：

- Rust 是当前主实现。
- Python 是迁移/审计辅助层。
- CLI、工具、权限、配置、session、MCP、plugin、skills、subagent 共同构成了真实产品面。
- 文档、parity harness 和 roadmap 则反映了它仍处在高频迭代阶段。

如果后续还要继续深入，这个仓库最值得继续拆解的三个方向是：

1. `claw` 的一次完整回合如何从 CLI 输入流转到 provider 和 tool loop。
2. MCP / plugin / worker 这三个高级子系统现在各自成熟到什么程度。
3. Python 参考层和 Rust 主实现之间，哪些内容仍在迁移，哪些已经只剩历史包袱。
