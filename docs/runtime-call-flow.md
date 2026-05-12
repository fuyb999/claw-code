# Claw Code 运行链路深挖

更新时间：2026-04-10

本文只回答一个问题：`claw` 接到一次输入之后，内部到底是怎么跑起来的。

它覆盖的范围主要是：

- CLI 入口
- system prompt / config / session 初始化
- plugin 与 MCP 装配
- provider 路由
- `ConversationRuntime` 回合循环
- tool execution、权限与 hook
- session 持久化与 resume
- runtime 关闭时的清理动作

如果你还没看过总览，先读 [`repository-overview.md`](./repository-overview.md)。

## 1. 两条主路径

用户和 `claw` 的交互大致分成两类：

1. 单次 prompt
2. 交互式 REPL

两条路径最终都会汇合到同一套运行时：

```text
CLI 解析
  -> LiveCli / BuiltRuntime
  -> ConversationRuntime
  -> provider stream
  -> tool loop
  -> session persistence
```

区别只在于：

- 单次 prompt 执行一轮或若干轮工具回合后直接退出。
- REPL 会保留 `LiveCli` 和 session，继续接收下一条输入。

## 2. CLI 入口层

入口在 [`rust/crates/rusty-claude-cli/src/main.rs`](../rust/crates/rusty-claude-cli/src/main.rs)。

关键节点：

- `main()`
- `run()`
- `parse_args()`
- `CliAction`

`parse_args()` 会把多种用户输入归一到统一动作模型：

- `claw prompt "..."` -> `CliAction::Prompt`
- `claw "..."` -> prompt shorthand
- `claw` -> `CliAction::Repl`
- `claw --resume latest /status` -> `CliAction::ResumeSession`
- `claw doctor` / `claw status` / `claw sandbox` -> 本地命令，不走模型

这层做的是“入口归一化”，不是 agent 逻辑本身。

## 3. REPL 与单次 prompt 如何汇合

### 3.1 单次 prompt

单次 prompt 路径最终会调用：

- `LiveCli::run_turn_with_output()`

它再根据输出格式细分为：

- 文本模式 `run_turn()`
- 紧凑模式 `run_prompt_compact()`
- JSON 模式 `run_prompt_json()`

### 3.2 REPL

REPL 通过：

- `run_repl()`
- `LiveCli::new()`

先构造一个可复用的 `LiveCli`，之后每次输入再调：

- `LiveCli::run_turn()`

不论是哪条路径，核心都依赖 `LiveCli` 内部持有的：

- 当前模型
- permission mode
- system prompt
- `BuiltRuntime`
- 当前 session handle

## 4. 启动 Runtime 之前会做什么

### 4.1 构造 system prompt

`LiveCli::new()` 首先会调用：

- `build_system_prompt()`

再进入 `runtime::load_system_prompt()`。

这一步会读取并拼接：

- OS 与当前日期
- 当前工作目录
- Git status / diff / recent commits
- `CLAUDE.md`
- `CLAUDE.local.md`
- `.claw/CLAUDE.md`
- `.claw/instructions.md`
- runtime config 的 JSON 视图

所以 `claw` 发给模型的 system prompt 不是静态常量，而是一段带工作区上下文的动态文本。

### 4.2 创建 session

当 CLI 走“新会话”路径时，会创建一个新的 `Session`。这既包括首次进入 REPL，也包括普通的单次 prompt：

- `Session::new()`
- `create_managed_session_handle()`

然后把 session persistence path 绑定到：

- `.claw/sessions/<workspace_hash>/<session_id>.jsonl`

这一步很重要，因为后续：

- prompt history
- tool result
- compaction
- resume

都依赖这个 session 文件。

## 5. Runtime 装配阶段

真正把所有子系统拼起来的是：

- `build_runtime()`
- `build_runtime_with_plugin_state()`

中间有一个很关键的中间态：

- `RuntimePluginState`

它包含：

- `feature_config`
- `tool_registry`
- `plugin_registry`
- `mcp_state`

### 5.1 `build_runtime_plugin_state()`

这个阶段的工作顺序基本是：

1. `ConfigLoader::default_for(cwd).load()`
2. `build_plugin_manager()`
3. `plugin_manager.plugin_registry()`
4. 把插件提供的 hooks 合并回 runtime feature config
5. `build_runtime_mcp_state()`
6. 构造 `GlobalToolRegistry`

其中 `GlobalToolRegistry` 会把三类工具统一在一起：

- 内置工具
- 插件工具
- runtime 动态工具

### 5.2 Plugin 装配

插件装配阶段主要做三件事：

- 按配置解析安装目录、registry path、bundled root、external dirs
- 加载插件 manifest
- 聚合插件工具和 hooks

真正启用插件 lifecycle 的动作发生在：

- `build_runtime_with_plugin_state()`
- `plugin_registry.initialize()`

也就是说，插件不是“只有发现，没有启动”；它会在 runtime 构建时真正进入初始化阶段。

### 5.3 MCP 装配

MCP 状态由 `RuntimeMcpState::new()` 构建。

它会：

1. 用 runtime config 构造 `McpServerManager`
2. `discover_tools_best_effort()`
3. 收集：
   - 可用工具
   - failed servers
   - unsupported servers
   - degraded report
4. 把发现到的 MCP tool 转成 runtime tools
5. 额外注入 wrapper tools：
   - `MCPTool`
   - `ListMcpResourcesTool`
   - `ReadMcpResourceTool`

所以在 `claw` 视角里，MCP 不是完全独立的一套调用方式，而是被吸收进统一的 tool surface。

## 6. `BuiltRuntime` 是什么

`BuiltRuntime` 是对底层 `ConversationRuntime` 的一个资源管理包装。

它除了真正的 runtime 之外，还持有：

- `plugin_registry`
- `mcp_state`

存在意义主要有两个：

1. 把插件和 MCP 生命周期和 runtime 绑定在一起。
2. 在 drop 时自动关闭资源。

`BuiltRuntime::drop()` 会做：

- `shutdown_mcp()`
- `shutdown_plugins()`

这样 REPL 退出、运行失败、对象替换时都能比较干净地收尾。

## 7. Provider 路由阶段

虽然类型名还叫 `AnthropicRuntimeClient`，但它现在实际是一个 provider 分发层。

内部持有的是：

- `ApiProviderClient`

`AnthropicRuntimeClient::new()` 的关键逻辑是：

1. `resolve_model_alias()`
2. `detect_provider_kind()`
3. 根据 provider 构造对应 client

### 7.1 Anthropic 路径

Anthropic 分支会：

- 解析 CLI auth source
- 应用 `ANTHROPIC_BASE_URL`
- 附加 session-scoped `PromptCache`

### 7.2 OpenAI-compatible / xAI / DashScope 路径

这些路径都会走 `ApiProviderClient::from_model_with_anthropic_auth(...)`，内部再根据模型和环境变量构造：

- OpenAI
- OpenRouter
- xAI
- DashScope
- Ollama / 本地 OpenAI-compatible 服务

这一层的原则是：

- 模型前缀优先于环境变量存在与否
- `OPENAI_BASE_URL` 能驱动本地兼容服务

## 8. 发起一次模型请求

当 `ConversationRuntime::run_turn()` 需要向模型发请求时，会调用 `ApiClient::stream()`。

对 CLI 而言，这个实现是 `AnthropicRuntimeClient::stream()`。

它会构造 `MessageRequest`，主要字段包括：

- `model`
- `max_tokens`
- `messages`
- `system`
- `tools`
- `tool_choice`
- `stream`
- `reasoning_effort`

这里的两个关键转换是：

- `convert_messages()`
  - 把 `Session` 里的结构化消息转成 provider 请求格式
- `filter_tool_specs(...)`
  - 根据 registry 和 `--allowedTools` 过滤当前对模型可见的工具

只有这一步之后，工具才真正暴露给模型。

## 9. provider 响应如何变成 runtime 事件

provider 返回的 `MessageResponse` 不会直接丢给 session，而是先经过：

- `response_to_events()`

它负责把响应 block 变成 runtime 认识的事件流：

- `AssistantEvent::TextDelta`
- `AssistantEvent::ToolUse`
- `AssistantEvent::Usage`
- `AssistantEvent::MessageStop`

如果 provider 是 Anthropic，还会额外收集 prompt cache 记录，转成：

- `AssistantEvent::PromptCache`

这一层的作用是把不同 provider 的响应收敛成 runtime 可以统一消费的事件抽象。

## 10. `ConversationRuntime::run_turn()` 的完整职责

这一步是整个系统最核心的循环。

`run_turn()` 大致会做：

1. 把用户输入 `push_user_text()` 到 session。
2. 构造 `ApiRequest` 并调用 provider stream。
3. 从事件流拼出 assistant message。
4. 记录 usage、assistant iteration、prompt cache 事件。
5. 把 assistant message 存回 session。
6. 从 assistant message 中提取 `ToolUse` block。
7. 如果没有工具调用，本轮结束。
8. 如果有工具调用，对每个工具依次：
   - 跑 pre-tool hook
   - 合并 hook 对输入和权限的修改
   - 做权限决策
   - 调 `tool_executor.execute(...)`
   - 跑 post-tool 或 post-tool-failure hook
   - 生成 `tool_result`
   - 追加回 session
9. 再次回到 provider，直到 assistant 不再请求工具。
10. 视 token 情况决定是否 auto compact。

因此一个“用户发了一句 prompt”在内部可能对应多个 provider 回合和多个工具调用回合。

## 11. 权限决策在哪里发生

权限并不是在具体工具函数里临时判断，而是在 runtime loop 里作为独立决策步骤发生。

关键对象：

- `PermissionPolicy`
- `PermissionContext`
- `CliPermissionPrompter`

`permission_policy()` 会从 `tool_registry.permission_specs()` 自动生成：

- 工具名 -> 需要的权限级别

再叠加：

- feature config 里的 allow/deny/ask 规则

最终在每次工具调用前，通过：

- `authorize_with_context()`

决定：

- 直接允许
- 直接拒绝
- 进入交互式批准提示

所以权限系统是“声明式工具权限 + 规则 + hook override + 用户批准”的组合，不是零散 if/else。

## 12. tool execution 真实落点

`ConversationRuntime` 并不知道具体怎么执行工具。它只依赖 `ToolExecutor` trait。

CLI 提供的实现是：

- `CliToolExecutor`

它内部的分流逻辑是：

1. 先检查 `--allowedTools`
2. 解析输入 JSON
3. 如果是 `ToolSearch`，走搜索分支
4. 如果是 runtime tool，走 MCP/runtime tool 分支
5. 否则交给 `tool_registry.execute(...)`

而 `tool_registry.execute(...)` 最终会落到：

- `tools::execute_tool()`

这里是一个大的 `match` 分发：

- `bash`
- `read_file`
- `write_file`
- `edit_file`
- `glob_search`
- `grep_search`
- `WebFetch`
- `WebSearch`
- `TodoWrite`
- `Skill`
- `Agent`
- `NotebookEdit`
- `Task*`
- `Worker*`
- `Team*`
- `Cron*`
- `LSP`
- `MCP`
- `McpAuth`
- `RemoteTrigger`

因此“工具系统”的真正边界是三层：

```text
ConversationRuntime
  -> CliToolExecutor
  -> GlobalToolRegistry
  -> tools::execute_tool()
```

## 13. MCP 工具在这条链里怎么跑

MCP 工具有两种进入路径：

1. 被发现后的 qualified runtime tool
2. wrapper tools，如 `MCPTool`

在 CLI 层最终都落到 `RuntimeMcpState`：

- `call_tool()`
- `list_resources_for_server()`
- `list_resources_for_all_servers()`
- `read_resource()`

再由 `McpServerManager` 真正与目标 MCP server 通信。

这意味着 MCP 工具虽然暴露成普通工具名，但执行阶段仍会回到一个独立的 MCP runtime 子系统。

## 14. Session 在回合中的角色

`Session` 不是单纯的日志文件，而是整个 runtime 的事实来源之一。

它负责保存：

- 消息序列
- `ToolUse`
- `ToolResult`
- prompt history
- compaction 信息
- fork 信息
- workspace root
- model 元数据

在 `run_turn()` 中，session 会在多个阶段被修改：

- 用户输入写入
- assistant message 写入
- 每个 tool result 写入
- prompt history 写入
- auto compaction 后替换 session 内容

这也是为什么 resume 路径可以重建出接近实时的上下文状态。

## 15. Resume 是怎么接回来的

session 解析入口主要是：

- `resolve_session_reference()`
- `Session::load_from_path()`

支持：

- `latest`
- `last`
- `recent`
- 明确的 session id
- 明确的 path
- `jsonl` / `json` 兼容装载

恢复后，CLI 会重新构建 runtime，但把旧 session 注入进去，这样：

- `/status`
- `/compact`
- 继续对话

都能建立在已有上下文之上。

## 16. 哪些命令不走模型

不是所有 CLI 表面都会走 provider。

典型本地命令包括：

- `claw doctor`
- `claw status`
- `claw sandbox`
- `claw version`
- `claw system-prompt`
- `claw mcp`
- `claw skills`
- `claw agents`

这些命令更像“本地 runtime introspection”或管理命令。

这也是阅读 `main.rs` 时容易踩的一个坑：文件很大，但其中有相当一部分是本地控制面，不属于模型回合主路径。

## 17. 关键调试切入点

如果你要调试一条真实回合，最有价值的断点/阅读点是：

1. `parse_args()`
2. `LiveCli::new()`
3. `build_runtime_plugin_state_with_loader()`
4. `build_runtime_with_plugin_state()`
5. `AnthropicRuntimeClient::new()`
6. `AnthropicRuntimeClient::stream()`
7. `response_to_events()`
8. `ConversationRuntime::run_turn()`
9. `CliToolExecutor::execute()`
10. `tools::execute_tool()`
11. `Session::push_message()`

基本沿这条线就能把一次请求完整走通。

## 18. 一句话总结

`claw` 的一次真实任务不是“CLI 调 API 再打印输出”这么简单，而是：

```text
本地控制面
  + 动态 prompt 构建
  + 配置/插件/MCP 装配
  + 多 provider 路由
  + 对话循环
  + 权限/Hook/工具执行
  + 会话持久化
```

这条链路解释了为什么这个仓库看起来不像普通 CLI：它本质上是一个 agent runtime。
