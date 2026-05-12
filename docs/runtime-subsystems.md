# Claw Code Runtime 子系统拆解

更新时间：2026-04-10

本文聚焦 [`rust/crates/runtime`](../rust/crates/runtime) 这个 crate。

如果说：

- `rusty-claude-cli` 是用户入口
- `tools` 是工具面
- `api` 是 provider 面

那么 `runtime` 就是中间那层真正把一切串起来的“骨架层”。

它负责的不是某一个功能，而是所有功能之间的运行时关系。

## 1. runtime crate 的角色

`runtime` 可以粗分为 7 个子系统：

1. 对话循环与上下文装配
2. Session 与工作区状态
3. 配置、权限与策略
4. 文件/Shell/Hook 等本地执行基础能力
5. MCP 与远程连接基础设施
6. 任务、worker、team、cron 等编排能力
7. 恢复、保护与观测辅助

理解这个 crate 的关键，不是背每个文件名，而是知道“哪些文件共同构成一个运行时子系统”。

## 2. 子系统一：对话循环与上下文装配

### 2.1 组成文件

- [`conversation.rs`](../rust/crates/runtime/src/conversation.rs)
- [`prompt.rs`](../rust/crates/runtime/src/prompt.rs)
- [`compact.rs`](../rust/crates/runtime/src/compact.rs)
- [`summary_compression.rs`](../rust/crates/runtime/src/summary_compression.rs)
- [`usage.rs`](../rust/crates/runtime/src/usage.rs)
- [`git_context.rs`](../rust/crates/runtime/src/git_context.rs)

### 2.2 它负责什么

这是 runtime 最核心的一层，职责包括：

- 维护一次 agent turn 的主循环
- 把 `system_prompt + session.messages` 组装成请求
- 消费 provider 返回的事件
- 识别 `ToolUse`
- 把 `ToolResult` 回写到 session
- 统计 usage / prompt cache / compaction
- 发现并注入项目上下文，例如 Git 状态和 `CLAUDE.md`

### 2.3 关键类型

- `ConversationRuntime`
- `ApiRequest`
- `AssistantEvent`
- `TurnSummary`
- `ProjectContext`
- `SystemPromptBuilder`
- `UsageTracker`

### 2.4 边界

这一层不直接：

- 解析 CLI 参数
- 真正执行工具实现
- 直接挑选 provider

它只依赖抽象：

- `ApiClient`
- `ToolExecutor`
- `PermissionPrompter`

所以它是一个“中立 orchestrator”。

### 2.5 什么时候改这里

如果你的需求涉及：

- 多轮工具调用逻辑
- auto compact 行为
- prompt cache 事件如何计入结果
- session 消息如何变成模型上下文
- `CLAUDE.md` / Git 信息如何进入 prompt

优先看这组文件。

## 3. 子系统二：Session 与工作区状态

### 3.1 组成文件

- [`session.rs`](../rust/crates/runtime/src/session.rs)
- [`session_control.rs`](../rust/crates/runtime/src/session_control.rs)
- [`branch_lock.rs`](../rust/crates/runtime/src/branch_lock.rs)
- [`stale_base.rs`](../rust/crates/runtime/src/stale_base.rs)
- [`stale_branch.rs`](../rust/crates/runtime/src/stale_branch.rs)

### 3.2 它负责什么

这组模块的目标是回答两个问题：

1. 当前 session 是什么，存在哪里，怎么恢复？
2. 当前 workspace/branch 是否处于一个安全、正确的状态？

### 3.3 Session 子系统

`session.rs` 负责：

- `Session`
- `ConversationMessage`
- `ContentBlock`
- prompt history
- fork 信息
- compaction 元数据
- `json` / `jsonl` 兼容存储

`session_control.rs` 负责：

- `SessionStore`
- 按 workspace 指纹隔离 session 命名空间
- `latest` / `last` / `recent`
- list/load/fork

这套设计明显是为并行 worktree / 并行 lane 服务的，而不是只做一个简单聊天记录文件。

### 3.4 分支与仓库健康

`stale_base.rs` 关注：

- base commit 是否陈旧
- `.claw-base` / flag / HEAD 关系

`stale_branch.rs` 关注：

- 当前分支是否落后主线
- 应该 rebase、merge-forward、warn-only，还是不动作

`branch_lock.rs` 关注：

- 多分支、多工作树下是否出现冲突或锁定问题

### 3.5 什么时候改这里

如果你的问题是：

- resume 读错 session
- latest 指向不对
- fork 行为不对
- session 串工作目录
- stale branch / stale base 判断不对

优先看这一组。

## 4. 子系统三：配置、权限与策略

### 4.1 组成文件

- [`config.rs`](../rust/crates/runtime/src/config.rs)
- [`config_validate.rs`](../rust/crates/runtime/src/config_validate.rs)
- [`permissions.rs`](../rust/crates/runtime/src/permissions.rs)
- [`permission_enforcer.rs`](../rust/crates/runtime/src/permission_enforcer.rs)
- [`sandbox.rs`](../rust/crates/runtime/src/sandbox.rs)
- [`policy_engine.rs`](../rust/crates/runtime/src/policy_engine.rs)
- [`green_contract.rs`](../rust/crates/runtime/src/green_contract.rs)

### 4.2 它负责什么

这是 runtime 的“规则层”：

- 配置从哪里读
- 配置如何合并
- 某个工具需不需要批准
- 某条 lane 是否能推进
- 当前环境是否在容器内、能否用 sandbox

### 4.3 配置

`config.rs` 是这一层的核心：

- 发现 5 层配置文件
- 解析 hooks、plugins、MCP、OAuth、permissionMode、permission rules、sandbox、provider fallbacks
- 输出 `RuntimeConfig` / `RuntimeFeatureConfig`

`config_validate.rs` 是更偏诊断层，负责让配置错误变成用户可读的结构化信息。

### 4.4 权限

权限这里分成两层：

- `permissions.rs`
  - 决策层
  - 定义 `PermissionPolicy`、`PermissionRequest`、`PermissionOutcome`
- `permission_enforcer.rs`
  - 输入级约束层
  - 例如 bash 命令是否越权、是否触及危险路径或不允许的行为

这种分层很重要：

- `PermissionPolicy` 决定“该不该让这个工具跑”
- `PermissionEnforcer` 决定“这个具体 payload 合不合规”

### 4.5 策略与 green contract

`policy_engine.rs` 和 `green_contract.rs` 明显不是面向普通聊天 CLI 的模块，而是面向 lane / review / merge 这类编排场景。

它们负责：

- 根据 `LaneContext` 评估 rule
- 判断某 lane 是否 stale、是否 reconcile、是否达到 green level
- 输出 `PolicyAction`

这部分更接近 clawhip / orchestration 体系。

### 4.6 什么时候改这里

如果你的问题是：

- 配置不生效
- `--permission-mode` 行为不对
- ask/allow/deny 规则不对
- sandbox 报告不对
- lane 策略或 green contract 有误

优先看这一组。

## 5. 子系统四：本地执行基础能力

### 5.1 组成文件

- [`bash.rs`](../rust/crates/runtime/src/bash.rs)
- [`bash_validation.rs`](../rust/crates/runtime/src/bash_validation.rs)
- [`file_ops.rs`](../rust/crates/runtime/src/file_ops.rs)
- [`hooks.rs`](../rust/crates/runtime/src/hooks.rs)
- [`plugin_lifecycle.rs`](../rust/crates/runtime/src/plugin_lifecycle.rs)

### 5.2 它负责什么

这一层更贴近“在本机具体做事”：

- 跑 bash
- 读写改文件
- 运行 hook
- 跟 plugin lifecycle 桥接

### 5.3 文件与 shell

`file_ops.rs` 提供：

- read
- write
- edit
- glob
- grep

`bash.rs` 负责真正执行命令。

`bash_validation.rs` 则是一套更细的 bash 校验规则，说明作者不满足于“只要能跑就行”，而是在补 shell 行为约束。

### 5.4 Hook 与 plugin lifecycle

`hooks.rs` 是对话循环与外部命令/策略之间的切点：

- pre tool use
- post tool use
- post tool use failure

`plugin_lifecycle.rs` 则把插件初始化、健康状态、降级状态和运行时桥接起来。

这两者一起决定了“工具调用并不是一条直线”，中间可以被拦截、修改、拒绝或补充反馈。

## 6. 子系统五：MCP 与远程连接基础设施

### 6.1 组成文件

- [`mcp.rs`](../rust/crates/runtime/src/mcp.rs)
- [`mcp_client.rs`](../rust/crates/runtime/src/mcp_client.rs)
- [`mcp_server.rs`](../rust/crates/runtime/src/mcp_server.rs)
- [`mcp_stdio.rs`](../rust/crates/runtime/src/mcp_stdio.rs)
- [`mcp_tool_bridge.rs`](../rust/crates/runtime/src/mcp_tool_bridge.rs)
- [`mcp_lifecycle_hardened.rs`](../rust/crates/runtime/src/mcp_lifecycle_hardened.rs)
- [`remote.rs`](../rust/crates/runtime/src/remote.rs)
- [`oauth.rs`](../rust/crates/runtime/src/oauth.rs)
- [`sse.rs`](../rust/crates/runtime/src/sse.rs)

### 6.2 它负责什么

这组模块负责两件事：

1. 把外部能力通过 MCP 接进来
2. 把认证、proxy、远程连接、流式协议处理成 runtime 能消费的形状

### 6.3 MCP 栈的分层

可以把 MCP 相关模块看成 4 层：

1. 命名与配置层
   - `mcp.rs`
   - `mcp_client.rs`
2. server / transport 协议层
   - `mcp_server.rs`
   - `mcp_stdio.rs`
3. 生命周期与错误面
   - `mcp_lifecycle_hardened.rs`
4. runtime bridge
   - `mcp_tool_bridge.rs`

其中：

- `mcp_stdio.rs` 是执行面最重的模块
- `mcp_lifecycle_hardened.rs` 是“系统能不能优雅降级”的关键
- `mcp_tool_bridge.rs` 是把 MCP 结果映射回 runtime 工具面

### 6.4 remote / oauth / sse

`remote.rs` 负责：

- upstream proxy
- token 文件
- websocket URL
- no_proxy 环境变量继承

`oauth.rs` 负责：

- token set 存储
- PKCE
- callback 参数解析
- credential 文件管理

`sse.rs` 是 provider / streaming 协议的底层帮助层。

### 6.5 什么时候改这里

如果你的问题是：

- MCP server 无法发现
- MCP resource/tool 调用失败
- OAuth 登录失败
- 远程 proxy/bootstrap 行为异常
- SSE 流解析异常

优先看这一组。

## 7. 子系统六：任务、worker、team、cron 编排

### 7.1 组成文件

- [`task_packet.rs`](../rust/crates/runtime/src/task_packet.rs)
- [`task_registry.rs`](../rust/crates/runtime/src/task_registry.rs)
- [`team_cron_registry.rs`](../rust/crates/runtime/src/team_cron_registry.rs)
- [`worker_boot.rs`](../rust/crates/runtime/src/worker_boot.rs)
- [`bootstrap.rs`](../rust/crates/runtime/src/bootstrap.rs)
- [`lane_events.rs`](../rust/crates/runtime/src/lane_events.rs)

### 7.2 它负责什么

这部分说明 Claw Code 并不只想做“一个人在终端里发 prompt 的 CLI”，而是在往可编排、多 lane、多 worker 的系统演进。

### 7.3 任务与计划

`task_packet.rs` 定义 task packet 和校验逻辑。

`task_registry.rs` 提供：

- task 生命周期
- 状态
- 输出
- 更新

`team_cron_registry.rs` 提供：

- team registry
- cron registry

目前这部分更像 runtime 内部 registry 层，而不是完整的外部调度系统。

### 7.4 Worker 启动状态机

`worker_boot.rs` 是这里最特别的模块。

它处理：

- worker 状态
- failure class
- trust resolution
- ready-for-prompt 检测
- prompt misdelivery 检测
- 状态文件输出

这说明项目在解决一个很具体的问题：

- 子 worker/代理进程启动后，如何知道它是否真的准备好接任务了
- 如果 prompt 发错时机，如何观测和恢复

这比“spawn 一个子进程”要复杂很多。

### 7.5 事件与 bootstrap

`lane_events.rs` 负责 lane 事件模型。

`bootstrap.rs` 负责 bootstrap plan 阶段模型。

二者都更偏 orchestration 元信息，而不是最终执行动作本身。

## 8. 子系统七：恢复、保护与观测辅助

### 8.1 组成文件

- [`recovery_recipes.rs`](../rust/crates/runtime/src/recovery_recipes.rs)
- [`lane_events.rs`](../rust/crates/runtime/src/lane_events.rs)
- [`usage.rs`](../rust/crates/runtime/src/usage.rs)
- [`json.rs`](../rust/crates/runtime/src/json.rs)

### 8.2 它负责什么

这一层不是单独的产品面，而是保证系统可恢复、可解释、可统计：

- 失败场景 -> 恢复方案
- 事件 -> 可记录/可消费的结构
- usage -> 成本与 token 指标
- JSON helpers -> 统一解析与渲染辅助

其中 `recovery_recipes.rs` 体现的是“失败不是直接报错退出”，而是希望 runtime 能知道下一步应该怎么救。

## 9. 当前 runtime 的工程特征

从这些子系统可以看出几个明显特征：

### 9.1 它是 agent runtime，不是普通 CLI 库

因为它不仅有：

- prompt
- API client

还内置了：

- session/fork/compact
- permission policy
- hook
- MCP lifecycle
- worker boot
- team/cron registry
- lane policy

### 9.2 它是分层的

最重要的分层大致是：

```text
CLI
  -> runtime orchestrator
  -> tools / api / plugins / MCP
  -> session + policy + config
```

`runtime` 正好处在中间这一层。

### 9.3 它已经不只是“移植”了

虽然仓库里有 parity 和 porting 的历史包袱，但从 `runtime` 的子系统规模来看，它已经明显演变成一个独立的工程体系，而不只是旧实现的机械重写。

## 10. 读 runtime 的建议顺序

如果你准备系统读 `runtime`，推荐顺序：

1. [`lib.rs`](../rust/crates/runtime/src/lib.rs)
2. [`conversation.rs`](../rust/crates/runtime/src/conversation.rs)
3. [`prompt.rs`](../rust/crates/runtime/src/prompt.rs)
4. [`config.rs`](../rust/crates/runtime/src/config.rs
5. [`permissions.rs`](../rust/crates/runtime/src/permissions.rs)
6. [`session.rs`](../rust/crates/runtime/src/session.rs)
7. [`mcp_stdio.rs`](../rust/crates/runtime/src/mcp_stdio.rs)
8. [`worker_boot.rs`](../rust/crates/runtime/src/worker_boot.rs)
9. [`task_registry.rs`](../rust/crates/runtime/src/task_registry.rs)
10. [`policy_engine.rs`](../rust/crates/runtime/src/policy_engine.rs)

## 11. 一句话总结

`runtime` crate 的本质是：

- 把 session、prompt、policy、tool loop、MCP、worker、recovery 等能力组织成一个可运转的 agent 中枢。

它不是边角料，也不是公共 util crate，而是整个 Claw Code 的运行时核心。
