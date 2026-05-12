# Claw Code 测试与验证地图

更新时间：2026-04-10

本文回答三个问题：

1. 这个仓库现在有哪些测试层次？
2. CI 实际跑哪些检查？
3. 改动某类功能时，应该补哪种测试？

## 1. 测试体系总览

当前仓库的验证手段大致分成 6 层：

1. Rust 源文件内单元测试
2. Rust crate 级集成测试
3. CLI 端到端契约测试
4. mock parity harness
5. Python 参考工作区测试
6. GitHub Actions CI / release workflow

这套体系偏重：

- runtime 行为正确
- provider 路由正确
- CLI 输出契约稳定
- parity 对齐有证据

相对不强调：

- 前端/UI
- 基于真实外部云服务的大规模端到端联调

## 2. Rust 源文件内单元测试

这个仓库把很多测试直接写在实现文件内部，而不是只放到 `tests/` 目录。

按当前源码粗看，测试密度最高的文件包括：

| 文件 | 当前测试标记数 |
|---|---:|
| `rust/crates/tools/src/lib.rs` | 79 |
| `rust/crates/commands/src/lib.rs` | 36 |
| `rust/crates/runtime/src/bash_validation.rs` | 32 |
| `rust/crates/plugins/src/lib.rs` | 31 |
| `rust/crates/api/src/providers/anthropic.rs` | 31 |
| `rust/crates/runtime/src/config.rs` | 23 |
| `rust/crates/runtime/src/mcp_stdio.rs` | 22 |
| `rust/crates/api/src/providers/openai_compat.rs` | 22 |
| `rust/crates/runtime/src/permission_enforcer.rs` | 21 |
| `rust/crates/runtime/src/lsp_client.rs` | 21 |
| `rust/crates/api/src/providers/mod.rs` | 21 |

这能看出几个事实：

- 工具系统是高风险面，所以测试很多。
- provider 路由和 API 适配是高风险面，所以测试很多。
- 配置、MCP、权限、LSP 都被视为高复杂度面。

## 3. Rust crate 级集成测试

当前可见的集成测试文件有 10 个：

### 3.1 API 集成测试

- [`rust/crates/api/tests/client_integration.rs`](../rust/crates/api/tests/client_integration.rs)
- [`rust/crates/api/tests/openai_compat_integration.rs`](../rust/crates/api/tests/openai_compat_integration.rs)
- [`rust/crates/api/tests/provider_client_integration.rs`](../rust/crates/api/tests/provider_client_integration.rs)
- [`rust/crates/api/tests/proxy_integration.rs`](../rust/crates/api/tests/proxy_integration.rs)

主要覆盖：

- 请求能否正确发出
- SSE/streaming 解析
- provider dispatch
- prompt cache
- retry 逻辑
- 代理环境变量
- OpenAI-compatible / xAI / DashScope 路由

### 3.2 Runtime 集成测试

- [`rust/crates/runtime/tests/integration_tests.rs`](../rust/crates/runtime/tests/integration_tests.rs)

它的定位很明确：测试“跨模块 wiring”而不是某个函数本身。

当前关注的组合主要是：

- `stale_branch` + `policy_engine`
- `green_contract` + policy
- reconcile / merge action 决策
- worker provider failure -> recovery -> policy

这类测试说明 runtime 中有一部分逻辑不是“函数对函数”，而是“状态评估链路”。

### 3.3 CLI 集成测试

- [`rust/crates/rusty-claude-cli/tests/cli_flags_and_config_defaults.rs`](../rust/crates/rusty-claude-cli/tests/cli_flags_and_config_defaults.rs)
- [`rust/crates/rusty-claude-cli/tests/resume_slash_commands.rs`](../rust/crates/rusty-claude-cli/tests/resume_slash_commands.rs)
- [`rust/crates/rusty-claude-cli/tests/output_format_contract.rs`](../rust/crates/rusty-claude-cli/tests/output_format_contract.rs)
- [`rust/crates/rusty-claude-cli/tests/mock_parity_harness.rs`](../rust/crates/rusty-claude-cli/tests/mock_parity_harness.rs)
- [`rust/crates/rusty-claude-cli/tests/compact_output.rs`](../rust/crates/rusty-claude-cli/tests/compact_output.rs)

这组测试基本覆盖：

- CLI 参数和默认值
- local-only 命令是否误触发 provider/runtime
- resumed slash command
- JSON 输出契约
- compact 输出行为
- mock parity 场景

## 4. CLI 契约测试的职责分工

这几个 CLI 测试文件各自定位很清晰：

### 4.1 `cli_flags_and_config_defaults.rs`

偏“控制面正确性”：

- `--model`
- `--permission-mode`
- `doctor`
- `/help`
- `/config`
- local subcommand help

它验证的是：

- 参数有没有被正确解释
- 本地命令有没有错误掉进 provider 路径

### 4.2 `resume_slash_commands.rs`

偏“恢复路径正确性”：

- `--resume latest`
- resumed `/status`
- resumed `/sandbox`
- resumed `/version`
- resumed `/export`
- resumed `/help`

这组测试对于 session 相关改动很关键。

### 4.3 `output_format_contract.rs`

偏“机器可消费输出不破坏”：

- `--output-format json`
- inventory commands
- bootstrap / system-prompt
- resumed JSON surfaces

如果你改了输出结构，这组测试最容易发现回归。

### 4.4 `compact_output.rs`

偏“人类阅读输出体验”：

- compact 模式下是否只打印最终 assistant 文本
- 是否隐藏不该暴露的中间 tool 细节

## 5. Mock parity harness

mock parity harness 是当前仓库最重要的行为级验证面之一。

### 5.1 相关文件

- [`rust/crates/rusty-claude-cli/tests/mock_parity_harness.rs`](../rust/crates/rusty-claude-cli/tests/mock_parity_harness.rs)
- [`rust/crates/mock-anthropic-service/src/lib.rs`](../rust/crates/mock-anthropic-service/src/lib.rs)
- [`rust/mock_parity_scenarios.json`](../rust/mock_parity_scenarios.json)
- [`rust/scripts/run_mock_parity_harness.sh`](../rust/scripts/run_mock_parity_harness.sh)
- [`rust/scripts/run_mock_parity_diff.py`](../rust/scripts/run_mock_parity_diff.py)

### 5.2 它的目标

这层不是普通单测，也不是完全真实的外部联调。

它做的是：

- 启一个 deterministic 的本地 mock Anthropic 服务
- 用真实 CLI 去跑一组脚本化场景
- 捕获请求数、工具调用、最终消息
- 把每个场景映射回 `PARITY.md`

### 5.3 当前场景

目前 manifest 中的场景包括：

- `streaming_text`
- `read_file_roundtrip`
- `grep_chunk_assembly`
- `write_file_allowed`
- `write_file_denied`
- `multi_tool_turn_roundtrip`
- `bash_stdout_roundtrip`
- `bash_permission_prompt_approved`
- `bash_permission_prompt_denied`
- `plugin_tool_roundtrip`
- `auto_compact_triggered`
- `token_cost_reporting`

### 5.4 为什么这层重要

因为它验证的是“实际 CLI 经过 provider/tool/session/output 之后是否还能跑通一个真实回合”，而不是单个函数对不对。

它尤其适合发现：

- 工具循环断裂
- provider 请求形状不兼容
- permission prompt 路径损坏
- plugin tool 集成断裂
- compact / usage / JSON 输出回归

## 6. Python 参考工作区测试

Python 参考层的测试入口是：

- [`tests/test_porting_workspace.py`](../tests/test_porting_workspace.py)

它主要验证：

- `src.main` 下的 CLI 能运行
- workspace summary / manifest / parity-audit 能输出
- mirrored commands / tools 快照不是空壳
- bootstrap / route / turn-loop 等分析辅助层没坏

它验证的是“porting workspace 仍然是个有用的审计工具”，不是 Rust 主产品面。

## 7. CI 现在实际跑什么

当前 GitHub Actions 的主验证 workflow 是：

- [`rust-ci.yml`](../.github/workflows/rust-ci.yml)

它会跑 4 类 job：

1. `docs source-of-truth`
2. `cargo fmt --all --check`
3. `cargo test --workspace`
4. `cargo clippy --workspace`

### 7.1 docs source-of-truth

这个 job 运行：

- [check_doc_source_of_truth.py](../.github/scripts/check_doc_source_of_truth.py)

它会扫描：

- `README.md`
- `USAGE.md`
- `PARITY.md`
- `PHILOSOPHY.md`
- `ROADMAP.md`
- `docs/**/*.md`

用来阻止：

- 旧仓库链接
- 旧 Discord 邀请
- 旧资源名
- 过期 branding

这说明项目把“文档一致性”当成 CI 检查的一部分。

### 7.2 Rust CI 的边界

当前 `rust-ci.yml` 明确会跑 Rust 相关验证，但不会直接跑：

- 根目录 Python 参考工作区测试 `tests/test_porting_workspace.py`

这不是说 Python 层不重要，而是说明它当前不在默认 CI 主路径里。

## 8. Release workflow

发布 workflow 是：

- [`release.yml`](../.github/workflows/release.yml)

当前会构建：

- `linux-x64`
- `macos-arm64`

触发条件：

- `v*` tag
- 手动 `workflow_dispatch`

它的作用不是测试逻辑细节，而是验证：

- release binary 能否在支持平台上构建与打包

## 9. 应该补哪类测试

这是最实用的一部分。

### 9.1 如果你改的是 provider 路由、请求结构、stream 解析

优先补：

- `api/tests/*`
- `api/src/providers/*.rs` 内部单测

必要时再补：

- mock parity harness

### 9.2 如果你改的是 CLI 参数、resume、JSON 输出

优先补：

- `cli_flags_and_config_defaults.rs`
- `resume_slash_commands.rs`
- `output_format_contract.rs`

### 9.3 如果你改的是工具执行、权限、tool loop

优先补：

- `tools/src/lib.rs` 内部单测
- `runtime/src/conversation.rs` 内部单测
- `runtime/src/permissions.rs` / `permission_enforcer.rs` 内部单测

必要时补：

- mock parity harness

### 9.4 如果你改的是 MCP / plugin / worker lifecycle

优先补：

- `runtime/src/mcp_stdio.rs`
- `runtime/src/mcp_tool_bridge.rs`
- `runtime/src/plugin_lifecycle.rs`
- `runtime/src/worker_boot.rs`

必要时补：

- CLI parity / integration 测试

### 9.5 如果你改的是 lane / policy / stale-branch / recovery

优先补：

- `runtime/tests/integration_tests.rs`
- 各模块内部单测

因为这类逻辑的风险点通常在“模块间是否真的接上了”。

### 9.6 如果你改的是 porting workspace

优先补：

- `tests/test_porting_workspace.py`

但要意识到它不是当前主产品验证面。

## 10. 当前验证体系的优点和空白

### 10.1 优点

- 核心 Rust 模块普遍带内部单测
- CLI 契约有专门测试
- provider 层有独立 integration coverage
- parity harness 能验证真实回合
- 文档一致性也进入了 CI

### 10.2 空白

- Python 参考工作区未进入默认 CI 主路径
- release workflow 只覆盖两个平台
- 部分高级能力更多验证 registry/lifecycle，而不是完整外部系统协同

这些空白不等于项目不可用，但意味着你在改这些区域时要主动补验证。

## 11. 推荐的最小验证清单

如果你只改文档：

- 至少检查 README/文档链接和术语一致性

如果你改 CLI 控制面：

- `cargo test -p rusty-claude-cli`

如果你改 provider：

- `cargo test -p api`

如果你改 runtime 核心：

- `cargo test -p runtime`
- 必要时 `cargo test --workspace`

如果你改的是工具循环、权限或 output contract：

- `cargo test -p rusty-claude-cli`
- 再考虑跑 mock parity harness

如果你改的是 parity / 集成行为：

- `rust/scripts/run_mock_parity_harness.sh`
- 必要时 `rust/scripts/run_mock_parity_diff.py`

## 12. 一句话总结

Claw Code 的测试体系不是“只有 cargo test”。

它实际上是：

```text
源文件单测
  + crate 集成测试
  + CLI 契约测试
  + mock parity harness
  + 文档 source-of-truth 检查
  + release 构建验证
```

理解这张地图之后，你就能更准确地判断改动该落到哪一层验证，而不是一律只跑 `cargo test --workspace`。
