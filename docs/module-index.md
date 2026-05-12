# Claw Code 模块索引

更新时间：2026-04-13

本文不是详细设计文档，而是“按目录找东西”的索引。适合在你已经知道要查哪类问题时，快速定位到对应文件。

## 1. 根目录

| 路径 | 说明 |
|---|---|
| [`README.md`](../README.md) | 项目入口和总导航 |
| [`USAGE.md`](../USAGE.md) | 运行、认证、provider、config、session 使用说明 |
| [`PARITY.md`](../PARITY.md) | Rust 迁移对齐状态 |
| [`ROADMAP.md`](../ROADMAP.md) | 路线图与 backlog |
| [`PHILOSOPHY.md`](../PHILOSOPHY.md) | 项目哲学与工作流定位 |
| [`docs/repository-overview.md`](./repository-overview.md) | 仓库总览 |
| [`docs/skill-authoring-guide.md`](./skill-authoring-guide.md) | 面向 `clawd` 的 Web skill 编写规范、模板与注意事项 |
| [`docs/runtime-call-flow.md`](./runtime-call-flow.md) | 运行链路深挖 |
| [`docs/runtime-subsystems.md`](./runtime-subsystems.md) | runtime crate 子系统拆解 |
| [`docs/testing-map.md`](./testing-map.md) | 测试、CI 与验证层次地图 |
| [`docs/web-agent-service-plan.md`](./web-agent-service-plan.md) | 多用户 Web Agent 服务设计与推进计划 |
| [`docs/web-agent-prototype-migration-plan.md`](./web-agent-prototype-migration-plan.md) | 基于 `AI分析师` 原型的 Web Agent 前端迁移改造方案 |
| [`Dockerfile`](../Dockerfile) | `clawd + web` 生产镜像定义 |
| [`Dockerfile.runtime`](../Dockerfile.runtime) | 基于已构建产物封装 runtime 镜像 |
| [`Containerfile`](../Containerfile) | 容器开发镜像 |
| [`install.sh`](../install.sh) | 从源码构建安装脚本 |

## 2. Rust workspace

Rust 主实现位于 [`rust/`](../rust/)。

### 2.1 `rust/crates/rusty-claude-cli`

这是 `claw` 二进制本体。

| 文件 | 说明 |
|---|---|
| [`main.rs`](../rust/crates/rusty-claude-cli/src/main.rs) | 主入口；参数解析、REPL、runtime 装配、provider 调用、输出渲染、resume、本地命令 |
| [`input.rs`](../rust/crates/rusty-claude-cli/src/input.rs) | 终端输入、slash completion、历史输入辅助 |
| [`render.rs`](../rust/crates/rusty-claude-cli/src/render.rs) | Markdown/终端渲染相关逻辑 |
| [`init.rs`](../rust/crates/rusty-claude-cli/src/init.rs) | `claw init`，生成 `.claw/`、`.claw.json`、`CLAUDE.md` 等 |

如果你只看一个文件，先看 `main.rs`。

### 2.2 `rust/crates/runtime`

这是核心运行时库，文件最多、职责最重。

#### 2.2.1 核心对话与上下文

| 文件 | 说明 |
|---|---|
| [`lib.rs`](../rust/crates/runtime/src/lib.rs) | runtime 总导出面；适合先看整体结构 |
| [`conversation.rs`](../rust/crates/runtime/src/conversation.rs) | `ConversationRuntime`，对话循环核心 |
| [`prompt.rs`](../rust/crates/runtime/src/prompt.rs) | system prompt 构建、`CLAUDE.md` 发现与拼接 |
| [`compact.rs`](../rust/crates/runtime/src/compact.rs) | session compact / summary 压缩 |
| [`summary_compression.rs`](../rust/crates/runtime/src/summary_compression.rs) | 摘要压缩相关辅助 |
| [`usage.rs`](../rust/crates/runtime/src/usage.rs) | token usage、价格和成本估算 |

#### 2.2.2 配置、权限与策略

| 文件 | 说明 |
|---|---|
| [`config.rs`](../rust/crates/runtime/src/config.rs) | 配置文件发现、合并、结构化解析 |
| [`config_validate.rs`](../rust/crates/runtime/src/config_validate.rs) | 配置校验与诊断 |
| [`permissions.rs`](../rust/crates/runtime/src/permissions.rs) | 权限模式、规则、prompter、授权决策 |
| [`permission_enforcer.rs`](../rust/crates/runtime/src/permission_enforcer.rs) | 工具参数级别的权限/命令检查 |
| [`sandbox.rs`](../rust/crates/runtime/src/sandbox.rs) | 沙箱检测与 Linux sandbox 组装 |
| [`policy_engine.rs`](../rust/crates/runtime/src/policy_engine.rs) | lane / review / green-contract 类策略评估 |
| [`green_contract.rs`](../rust/crates/runtime/src/green_contract.rs) | green-contract 相关模型与逻辑 |

#### 2.2.3 Session 与恢复

| 文件 | 说明 |
|---|---|
| [`session.rs`](../rust/crates/runtime/src/session.rs) | session 结构、持久化、json/jsonl 兼容、fork、prompt history |
| [`session_control.rs`](../rust/crates/runtime/src/session_control.rs) | per-worktree session store、latest/load/fork/list |
| [`stale_base.rs`](../rust/crates/runtime/src/stale_base.rs) | base commit 检查 |
| [`stale_branch.rs`](../rust/crates/runtime/src/stale_branch.rs) | branch freshness 检查 |
| [`branch_lock.rs`](../rust/crates/runtime/src/branch_lock.rs) | worktree / branch lock 冲突检测 |
| [`recovery_recipes.rs`](../rust/crates/runtime/src/recovery_recipes.rs) | 失败场景到恢复策略的映射 |

#### 2.2.4 文件、Shell 与 Hook

| 文件 | 说明 |
|---|---|
| [`bash.rs`](../rust/crates/runtime/src/bash.rs) | shell 执行 |
| [`bash_validation.rs`](../rust/crates/runtime/src/bash_validation.rs) | bash 安全/语义检查 |
| [`file_ops.rs`](../rust/crates/runtime/src/file_ops.rs) | 读写文件、编辑、glob、grep |
| [`hooks.rs`](../rust/crates/runtime/src/hooks.rs) | pre/post tool hook runner |
| [`plugin_lifecycle.rs`](../rust/crates/runtime/src/plugin_lifecycle.rs) | plugin lifecycle 与运行时桥接 |

#### 2.2.5 MCP 与远程能力

| 文件 | 说明 |
|---|---|
| [`mcp.rs`](../rust/crates/runtime/src/mcp.rs) | MCP 名称规范、签名、URL 处理 |
| [`mcp_client.rs`](../rust/crates/runtime/src/mcp_client.rs) | MCP client bootstrap / transport 模型 |
| [`mcp_server.rs`](../rust/crates/runtime/src/mcp_server.rs) | 本地 MCP server 规范 |
| [`mcp_stdio.rs`](../rust/crates/runtime/src/mcp_stdio.rs) | stdio MCP 生命周期、发现、调用 |
| [`mcp_tool_bridge.rs`](../rust/crates/runtime/src/mcp_tool_bridge.rs) | MCP tool/resource bridge |
| [`mcp_lifecycle_hardened.rs`](../rust/crates/runtime/src/mcp_lifecycle_hardened.rs) | MCP 生命周期错误面和降级报告 |
| [`remote.rs`](../rust/crates/runtime/src/remote.rs) | remote / upstream proxy 相关环境与 URL 逻辑 |
| [`oauth.rs`](../rust/crates/runtime/src/oauth.rs) | OAuth token、PKCE、credential 持久化 |

#### 2.2.6 代码智能与编排

| 文件 | 说明 |
|---|---|
| [`lsp_client.rs`](../rust/crates/runtime/src/lsp_client.rs) | LSP registry 与查询动作 |
| [`task_packet.rs`](../rust/crates/runtime/src/task_packet.rs) | task packet 结构与校验 |
| [`task_registry.rs`](../rust/crates/runtime/src/task_registry.rs) | 任务生命周期 registry |
| [`team_cron_registry.rs`](../rust/crates/runtime/src/team_cron_registry.rs) | team / cron registry |
| [`worker_boot.rs`](../rust/crates/runtime/src/worker_boot.rs) | worker 启动状态机与观测面 |
| [`lane_events.rs`](../rust/crates/runtime/src/lane_events.rs) | lane 事件模型 |

#### 2.2.7 其他基础模块

| 文件 | 说明 |
|---|---|
| [`bootstrap.rs`](../rust/crates/runtime/src/bootstrap.rs) | bootstrap plan 结构 |
| [`git_context.rs`](../rust/crates/runtime/src/git_context.rs) | Git 上下文与 recent commits 读取 |
| [`json.rs`](../rust/crates/runtime/src/json.rs) | 内部 JSON 帮助类型 |
| [`sse.rs`](../rust/crates/runtime/src/sse.rs) | SSE 解析 |
| [`trust_resolver.rs`](../rust/crates/runtime/src/trust_resolver.rs) | trust 相关测试辅助模块，目前 `#[cfg(test)]` |

### 2.3 `rust/crates/tools`

这里定义工具面，并把工具名真正分发到执行函数。

| 文件 | 说明 |
|---|---|
| [`lib.rs`](../rust/crates/tools/src/lib.rs) | 工具注册表、schema、dispatch、内置工具实现 |
| [`lane_completion.rs`](../rust/crates/tools/src/lane_completion.rs) | lane completion 相关辅助 |
| [`pdf_extract.rs`](../rust/crates/tools/src/pdf_extract.rs) | PDF 文本提取 |

最常看的位置：

- `mvp_tool_specs()`
- `GlobalToolRegistry`
- `execute_tool()`

### 2.4 `rust/crates/commands`

| 文件 | 说明 |
|---|---|
| [`lib.rs`](../rust/crates/commands/src/lib.rs) | slash command 注册表、帮助文案、共享命令视图 |

如果你要找某个 `/command` 有没有、叫什么、是否支持 resume，先看这里。

### 2.5 `rust/crates/api`

这里是 provider 适配层。

| 文件 | 说明 |
|---|---|
| [`lib.rs`](../rust/crates/api/src/lib.rs) | api crate 导出面 |
| [`client.rs`](../rust/crates/api/src/client.rs) | `ProviderClient`，统一 provider enum |
| [`types.rs`](../rust/crates/api/src/types.rs) | request/response/stream 类型 |
| [`error.rs`](../rust/crates/api/src/error.rs) | API 错误与提示 |
| [`http_client.rs`](../rust/crates/api/src/http_client.rs) | HTTP client 构造 |
| [`prompt_cache.rs`](../rust/crates/api/src/prompt_cache.rs) | Anthropic prompt cache |
| [`sse.rs`](../rust/crates/api/src/sse.rs) | provider 侧 SSE 解析 |
| [`providers/mod.rs`](../rust/crates/api/src/providers/mod.rs) | provider 路由、模型别名、token limit |
| [`providers/anthropic.rs`](../rust/crates/api/src/providers/anthropic.rs) | Anthropic 实现 |
| [`providers/openai_compat.rs`](../rust/crates/api/src/providers/openai_compat.rs) | OpenAI-compatible / xAI / DashScope 实现 |

### 2.6 `rust/crates/plugins`

| 文件 | 说明 |
|---|---|
| [`lib.rs`](../rust/crates/plugins/src/lib.rs) | plugin manifest、manager、tool/command/hook/lifecycle 元数据 |
| [`hooks.rs`](../rust/crates/plugins/src/hooks.rs) | plugin hook 执行辅助 |

### 2.7 `rust/crates/telemetry`

| 文件 | 说明 |
|---|---|
| [`lib.rs`](../rust/crates/telemetry/src/lib.rs) | telemetry event、trace record、memory/jsonl sink |

### 2.8 `rust/crates/mock-anthropic-service`

| 文件 | 说明 |
|---|---|
| [`lib.rs`](../rust/crates/mock-anthropic-service/src/lib.rs) | 本地 mock Anthropic 服务与 scenario |
| [`main.rs`](../rust/crates/mock-anthropic-service/src/main.rs) | 独立启动入口 |

### 2.9 `rust/crates/compat-harness`

这个 crate 更偏兼容性辅助层，直接阅读频率通常不如前面几层高。

## 3. Rust 测试入口

### 3.1 CLI / runtime 主测试面

| 文件 | 说明 |
|---|---|
| [`rust/crates/rusty-claude-cli/tests/mock_parity_harness.rs`](../rust/crates/rusty-claude-cli/tests/mock_parity_harness.rs) | mock parity harness 核心 |
| [`rust/crates/rusty-claude-cli/tests/output_format_contract.rs`](../rust/crates/rusty-claude-cli/tests/output_format_contract.rs) | 输出契约 |
| [`rust/crates/rusty-claude-cli/tests/resume_slash_commands.rs`](../rust/crates/rusty-claude-cli/tests/resume_slash_commands.rs) | resume 路径 |
| [`rust/crates/rusty-claude-cli/tests/cli_flags_and_config_defaults.rs`](../rust/crates/rusty-claude-cli/tests/cli_flags_and_config_defaults.rs) | CLI 参数与默认值 |
| [`rust/crates/rusty-claude-cli/tests/compact_output.rs`](../rust/crates/rusty-claude-cli/tests/compact_output.rs) | compact 输出相关 |
| [`rust/crates/runtime/tests/integration_tests.rs`](../rust/crates/runtime/tests/integration_tests.rs) | runtime 侧集成测试 |

### 3.2 Provider 测试面

| 文件 | 说明 |
|---|---|
| [`rust/crates/api/tests/client_integration.rs`](../rust/crates/api/tests/client_integration.rs) | client integration |
| [`rust/crates/api/tests/openai_compat_integration.rs`](../rust/crates/api/tests/openai_compat_integration.rs) | OpenAI-compatible 集成 |
| [`rust/crates/api/tests/provider_client_integration.rs`](../rust/crates/api/tests/provider_client_integration.rs) | provider client 集成 |
| [`rust/crates/api/tests/proxy_integration.rs`](../rust/crates/api/tests/proxy_integration.rs) | proxy 相关集成 |

## 4. Python 参考工作区

根目录 [`src/`](../src/) 不是当前主运行时，而是迁移/审计/参考层。

### 4.1 最值得看的 Python 文件

| 文件 | 说明 |
|---|---|
| [`src/main.py`](../src/main.py) | Python 工作区 CLI 入口 |
| [`src/port_manifest.py`](../src/port_manifest.py) | port manifest 生成 |
| [`src/query_engine.py`](../src/query_engine.py) | workspace summary / route 辅助 |
| [`src/parity_audit.py`](../src/parity_audit.py) | parity audit |
| [`src/runtime.py`](../src/runtime.py) | Python 侧 runtime-style 报告逻辑 |
| [`src/commands.py`](../src/commands.py) | mirrored commands metadata |
| [`src/tools.py`](../src/tools.py) | mirrored tools metadata |
| [`src/session_store.py`](../src/session_store.py) | Python 侧 session 辅助 |
| [`src/reference_data/`](../src/reference_data) | 命令/工具/archive 快照 |

### 4.2 Placeholder 包

`src/assistant`、`src/bridge`、`src/plugins`、`src/utils` 等大量包目前主要是 archived namespace placeholder。

它们存在的意义主要是：

- 保留旧表面的命名空间痕迹
- 暴露 archive metadata
- 支持 porting workspace 的审计和索引能力

不要把这些包误判成当前产品主实现。

### 4.3 Python 测试

| 文件 | 说明 |
|---|---|
| [`tests/test_porting_workspace.py`](../tests/test_porting_workspace.py) | Python 参考工作区测试入口 |

## 5. 遇到问题时该先看哪

### 5.1 CLI 行为不对

先看：

1. [`main.rs`](../rust/crates/rusty-claude-cli/src/main.rs)
2. [`commands/lib.rs`](../rust/crates/commands/src/lib.rs)
3. [`input.rs`](../rust/crates/rusty-claude-cli/src/input.rs)

### 5.2 模型路由不对

先看：

1. [`providers/mod.rs`](../rust/crates/api/src/providers/mod.rs)
2. [`client.rs`](../rust/crates/api/src/client.rs)
3. [`main.rs`](../rust/crates/rusty-claude-cli/src/main.rs) 里的 `AnthropicRuntimeClient::new`

### 5.3 工具调用行为不对

先看：

1. [`conversation.rs`](../rust/crates/runtime/src/conversation.rs)
2. [`main.rs`](../rust/crates/rusty-claude-cli/src/main.rs) 里的 `CliToolExecutor`
3. [`tools/lib.rs`](../rust/crates/tools/src/lib.rs)
4. [`permissions.rs`](../rust/crates/runtime/src/permissions.rs)

### 5.4 Session / resume 有问题

先看：

1. [`session.rs`](../rust/crates/runtime/src/session.rs)
2. [`session_control.rs`](../rust/crates/runtime/src/session_control.rs)
3. [`main.rs`](../rust/crates/rusty-claude-cli/src/main.rs) 的 resume 路径

### 5.5 MCP 有问题

先看：

1. [`mcp_stdio.rs`](../rust/crates/runtime/src/mcp_stdio.rs)
2. [`mcp_tool_bridge.rs`](../rust/crates/runtime/src/mcp_tool_bridge.rs)
3. [`main.rs`](../rust/crates/rusty-claude-cli/src/main.rs) 里的 `RuntimeMcpState`

### 5.6 配置不生效

先看：

1. [`config.rs`](../rust/crates/runtime/src/config.rs)
2. [`config_validate.rs`](../rust/crates/runtime/src/config_validate.rs)
3. [`USAGE.md`](../USAGE.md) 的 config resolution order

## 6. 最短阅读路径

如果你只想用最少时间建立代码地图，推荐：

1. [`rust/crates/rusty-claude-cli/src/main.rs`](../rust/crates/rusty-claude-cli/src/main.rs)
2. [`rust/crates/runtime/src/lib.rs`](../rust/crates/runtime/src/lib.rs)
3. [`rust/crates/runtime/src/conversation.rs`](../rust/crates/runtime/src/conversation.rs)
4. [`rust/crates/tools/src/lib.rs`](../rust/crates/tools/src/lib.rs)
5. [`rust/crates/runtime/src/config.rs`](../rust/crates/runtime/src/config.rs)
6. [`rust/crates/runtime/src/session.rs`](../rust/crates/runtime/src/session.rs)
7. [`rust/crates/api/src/providers/mod.rs`](../rust/crates/api/src/providers/mod.rs)

## 7. 一句话总结

这个项目的源码地图可以简单理解为：

```text
rusty-claude-cli = 用户入口
runtime          = 运行时骨架
tools            = 工具面
commands         = slash command 面
api              = provider 面
plugins / MCP    = 扩展与外部能力
src/             = 迁移/审计参考层
```
