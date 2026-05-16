# AG UI WebAgent Rebuild Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the current WebAgent chat path with a database-backed AG UI Agent Turn flow that streams text, tools, retrieval, experts, citations, history, interruption, and queued follow-up messages as one professional WebAgent experience without exposing `workspace_root`.

**Architecture:** Add a new WebAgent conversation/turn persistence layer in Rust, then expose a native AG UI endpoint that emits `RUN_*`, `TEXT_MESSAGE_*`, `TOOL_CALL_*`, `ACTIVITY_*`, and state events while updating `agent_turns`. The React UI consumes the AG UI endpoint through `@assistant-ui/react-ag-ui` / `@ag-ui/client`, but renders a custom `AgentTurnView` so process steps, citations, expert state, and admin debug details stay inside one answer instead of becoming separate bubbles.

**Tech Stack:** Rust `clawd` with rusqlite/Postgres store methods, Axum streaming responses, existing provider/runtime/tool executor code, React 18, TypeScript, Vite, assistant-ui, `@assistant-ui/react-ag-ui`, `@ag-ui/client`, Vitest, Tailwind CSS.

---

## Scope And Boundaries

This plan implements the new WebAgent main line confirmed in `docs/web-agent-prototype-migration-plan.md`:

- no old JSONL migration
- no old session history compatibility for the new WebAgent UI
- no `workspace_root` in new WebAgent API payloads or frontend types
- one user question maps to one `AgentTurn`
- ordinary users see productized process steps, not raw tool JSON
- admins can expand raw AG UI/tool details
- local file/command/edit/worker CLI tools are not enabled in ordinary WebAgent sessions

The old `/v1/threads` endpoints and legacy SSE may remain in the repository during the transition, but the new `webagent-ui/` chat route must not depend on them after this plan is complete.

## File Structure

- Create: `rust/crates/clawd/src/agent_turns.rs`
  - Owns WebAgent DB-facing record types: conversations, turns, steps, citations, expert summaries, event envelopes.
- Modify: `rust/crates/clawd/src/main.rs`
  - Adds module wiring, DB migrations, store methods, AG UI routes, endpoint handlers, runtime bridge hooks, tool whitelist changes, tests.
- Create: `webagent-ui/src/lib/clawd/agent-turns.ts`
  - Frontend WebAgent turn types and pure helpers for time grouping, citations, status labels, and admin detail gating.
- Create: `webagent-ui/src/lib/clawd/ag-ui-client.ts`
  - Creates the `HttpAgent` runtime and request metadata for the new AG UI endpoint.
- Create: `webagent-ui/src/components/conversation/AgentTurnView.tsx`
  - Renders one user question plus one integrated Agent response.
- Create: `webagent-ui/src/components/conversation/AgentActivityTimeline.tsx`
  - Renders internal small-dot process steps inside an Agent response.
- Create: `webagent-ui/src/components/conversation/AgentCitationList.tsx`
  - Renders `[1]` style references and bottom citation list.
- Create: `webagent-ui/src/components/conversation/AgentDebugDetails.tsx`
  - Admin-only raw AG UI event/tool detail drawer inside a turn.
- Modify: `webagent-ui/src/components/conversation/ConversationStage.tsx`
  - Replaces the old message-bubble runtime as the main render path for WebAgent conversations.
- Modify: `webagent-ui/src/components/conversation/ConversationComposer.tsx`
  - Keeps input enabled during runs, exposes stop and queued follow-up behavior.
- Modify: `webagent-ui/src/components/inspiration/InspirationMode.tsx`
  - Switches history/load/send paths to WebAgent conversations and turns.
- Modify: `webagent-ui/src/lib/clawd/types.ts`
  - Adds WebAgent conversation/turn API types and stops requiring `workspace_root` in new WebAgent request types.
- Modify: `webagent-ui/package.json` and `webagent-ui/package-lock.json`
  - Adds `@assistant-ui/react-ag-ui` and `@ag-ui/client`.
- Modify: `.claw/skills/basic-evidence-scan/SKILL.md`
  - Removes local workspace file tools from the skill contract.
- Modify: `.claw/skills/expert-brainstorm/SKILL.md`
  - Replaces `workspace` memory scope instructions with WebAgent-safe scopes.
- Modify: `docs/web-agent-prototype-migration-plan.md`
  - Mark the AG UI rebuild implementation phase status as active/completed as tasks land.

## Verification Commands

Run focused Rust tests after backend tasks:

```bash
cd rust && cargo test -p clawd agent_turn
cd rust && cargo test -p clawd ag_ui
cd rust && cargo fmt
cd rust && cargo clippy --workspace --all-targets -- -D warnings
```

Run focused frontend tests after UI tasks:

```bash
cd webagent-ui && npm test -- --run \
  src/lib/clawd/agent-turns.test.ts \
  src/components/conversation/AgentTurnView.test.tsx \
  src/components/conversation/ConversationComposer.test.tsx
cd webagent-ui && npm run build
```

Run full final verification before handing to the user:

```bash
cd rust && cargo fmt
cd rust && cargo clippy --workspace --all-targets -- -D warnings
cd rust && cargo test --workspace
cd ../webagent-ui && npm test -- --run
cd ../webagent-ui && npm run build
```

---

### Task 1: Add WebAgent Conversation And AgentTurn Types

**Files:**
- Create: `rust/crates/clawd/src/agent_turns.rs`
- Modify: `rust/crates/clawd/src/main.rs`

- [ ] **Step 1: Create failing Rust type serialization tests**

Add this test module to `rust/crates/clawd/src/agent_turns.rs` after the type definitions added in Step 3. Start by writing the tests so the file fails to compile until the types exist:

```rust
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn agent_turn_round_trips_structured_steps_and_citations() {
        let turn = AgentTurnRecord {
            id: "turn-1".to_string(),
            conversation_id: "conv-1".to_string(),
            tenant_id: Some("tenant-a".to_string()),
            owner_id: "alice".to_string(),
            user_message: "分析台海供应链风险".to_string(),
            assistant_text: "主要风险来自运输、制裁和关键零部件。[1]".to_string(),
            status: AgentTurnStatus::Succeeded,
            started_at_ms: 1_700_000_000_000,
            completed_at_ms: Some(1_700_000_001_000),
            steps: vec![AgentTurnStep {
                id: "step-1".to_string(),
                kind: AgentTurnStepKind::Retrieval,
                label: "检索平台资料".to_string(),
                detail: Some("命中 3 篇文档".to_string()),
                status: AgentTurnStepStatus::Succeeded,
                started_at_ms: Some(1_700_000_000_100),
                completed_at_ms: Some(1_700_000_000_600),
                public_payload: serde_json::json!({ "hit_count": 3 }),
                debug_payload: Some(serde_json::json!({ "tool": "EsSearch" })),
            }],
            citations: vec![AgentCitation {
                id: "cite-1".to_string(),
                number: 1,
                source_kind: "es".to_string(),
                source_label: "平台资料库".to_string(),
                title: Some("供应链风险报告".to_string()),
                location: Some("index-a#hit-1".to_string()),
                preview: "关键港口拥堵会放大风险。".to_string(),
                debug_payload: Some(serde_json::json!({ "score": 0.91 })),
            }],
            expert_results: vec![AgentExpertResult {
                expert_name: "Howard-Wang".to_string(),
                status: AgentExpertStatus::Succeeded,
                summary: Some("PLA logistics indicators require separate tracking.".to_string()),
                citation_numbers: vec![1],
                error: None,
            }],
            artifacts: Vec::new(),
            error: None,
            debug_events: Vec::new(),
        };

        let raw = serde_json::to_string(&turn).expect("serialize turn");
        let parsed: AgentTurnRecord = serde_json::from_str(&raw).expect("deserialize turn");

        assert_eq!(parsed.id, "turn-1");
        assert_eq!(parsed.steps[0].kind, AgentTurnStepKind::Retrieval);
        assert_eq!(parsed.citations[0].number, 1);
        assert_eq!(parsed.expert_results[0].expert_name, "Howard-Wang");
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
cd rust && cargo test -p clawd agent_turn_round_trips_structured_steps_and_citations
```

Expected: FAIL because `agent_turns` module and types are not defined.

- [ ] **Step 3: Implement the WebAgent turn types**

Create `rust/crates/clawd/src/agent_turns.rs`:

```rust
use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentConversationStatus {
    Idle,
    Running,
    Interrupted,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentConversationRecord {
    pub id: String,
    pub tenant_id: Option<String>,
    pub owner_id: String,
    pub title: String,
    pub status: AgentConversationStatus,
    pub selected_knowledge_base_ids: Vec<String>,
    pub selected_data_source_ids: Vec<String>,
    pub selected_expert_ids: Vec<String>,
    pub model_profile_id: Option<String>,
    pub created_at_ms: u64,
    pub updated_at_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentTurnStatus {
    Queued,
    Running,
    Succeeded,
    Interrupted,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentTurnStepKind {
    Retrieval,
    Tool,
    Expert,
    Citation,
    Artifact,
    Generation,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentTurnStepStatus {
    Running,
    Succeeded,
    Failed,
    Skipped,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentTurnStep {
    pub id: String,
    pub kind: AgentTurnStepKind,
    pub label: String,
    pub detail: Option<String>,
    pub status: AgentTurnStepStatus,
    pub started_at_ms: Option<u64>,
    pub completed_at_ms: Option<u64>,
    pub public_payload: Value,
    pub debug_payload: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentCitation {
    pub id: String,
    pub number: u32,
    pub source_kind: String,
    pub source_label: String,
    pub title: Option<String>,
    pub location: Option<String>,
    pub preview: String,
    pub debug_payload: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
pub enum AgentExpertStatus {
    Running,
    Succeeded,
    Retrying,
    Failed,
    Skipped,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentExpertResult {
    pub expert_name: String,
    pub status: AgentExpertStatus,
    pub summary: Option<String>,
    pub citation_numbers: Vec<u32>,
    pub error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentTurnError {
    pub public_message: String,
    pub debug_message: Option<String>,
    pub code: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentTurnDebugEvent {
    pub event_type: String,
    pub at_ms: u64,
    pub payload: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AgentTurnRecord {
    pub id: String,
    pub conversation_id: String,
    pub tenant_id: Option<String>,
    pub owner_id: String,
    pub user_message: String,
    pub assistant_text: String,
    pub status: AgentTurnStatus,
    pub started_at_ms: u64,
    pub completed_at_ms: Option<u64>,
    pub steps: Vec<AgentTurnStep>,
    pub citations: Vec<AgentCitation>,
    pub expert_results: Vec<AgentExpertResult>,
    pub artifacts: Vec<Value>,
    pub error: Option<AgentTurnError>,
    pub debug_events: Vec<AgentTurnDebugEvent>,
}
```

In `rust/crates/clawd/src/main.rs`, add near the top-level imports:

```rust
mod agent_turns;

use agent_turns::{
    AgentConversationRecord, AgentConversationStatus, AgentTurnRecord, AgentTurnStatus,
};
```

- [ ] **Step 4: Run the test to verify it passes**

Run:

```bash
cd rust && cargo test -p clawd agent_turn_round_trips_structured_steps_and_citations
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add rust/crates/clawd/src/agent_turns.rs rust/crates/clawd/src/main.rs
git commit -m "feat: add webagent agent turn types"
```

### Task 2: Add Database Tables And Store Methods

**Files:**
- Modify: `rust/crates/clawd/src/main.rs`
- Test: `rust/crates/clawd/src/main.rs`

- [ ] **Step 1: Write failing store round-trip tests**

Add this test in the existing `#[cfg(test)]` module in `rust/crates/clawd/src/main.rs` near the other SQLite store tests:

```rust
#[test]
fn sqlite_store_round_trips_agent_conversations_and_turns() {
    let temp_dir = test_temp_dir("sqlite-agent-turns");
    let config = test_config(temp_dir.clone());
    let store = ThreadStore::open(&config).expect("open sqlite store");

    let conversation = AgentConversationRecord {
        id: "conv-1".to_string(),
        tenant_id: Some("tenant-a".to_string()),
        owner_id: "alice".to_string(),
        title: "台海供应链风险".to_string(),
        status: AgentConversationStatus::Running,
        selected_knowledge_base_ids: vec!["kb-1".to_string()],
        selected_data_source_ids: vec!["ds-1".to_string()],
        selected_expert_ids: vec!["howard-wang".to_string()],
        model_profile_id: Some("platform-default".to_string()),
        created_at_ms: 10,
        updated_at_ms: 20,
    };
    store.upsert_agent_conversation(&conversation).expect("save conversation");

    let mut turn = test_agent_turn_record("turn-1", "conv-1", "alice");
    turn.assistant_text = "结论正文 [1]".to_string();
    store.upsert_agent_turn(&turn).expect("save turn");

    let conversations = store
        .list_agent_conversations(Some("tenant-a"), "alice")
        .expect("list conversations");
    assert_eq!(conversations.len(), 1);
    assert_eq!(conversations[0].id, "conv-1");
    assert_eq!(conversations[0].selected_knowledge_base_ids, vec!["kb-1"]);

    let turns = store
        .list_agent_turns("conv-1", Some("tenant-a"), "alice")
        .expect("list turns");
    assert_eq!(turns.len(), 1);
    assert_eq!(turns[0].assistant_text, "结论正文 [1]");
}

fn test_agent_turn_record(id: &str, conversation_id: &str, owner_id: &str) -> AgentTurnRecord {
    AgentTurnRecord {
        id: id.to_string(),
        conversation_id: conversation_id.to_string(),
        tenant_id: Some("tenant-a".to_string()),
        owner_id: owner_id.to_string(),
        user_message: "问题".to_string(),
        assistant_text: String::new(),
        status: AgentTurnStatus::Running,
        started_at_ms: 10,
        completed_at_ms: None,
        steps: Vec::new(),
        citations: Vec::new(),
        expert_results: Vec::new(),
        artifacts: Vec::new(),
        error: None,
        debug_events: Vec::new(),
    }
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
cd rust && cargo test -p clawd sqlite_store_round_trips_agent_conversations_and_turns
```

Expected: FAIL because migrations and store methods do not exist.

- [ ] **Step 3: Add SQLite and Postgres migration version 9**

In `apply_sqlite_migration`, add a `9 =>` arm after version 8:

```rust
9 => {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS agent_conversations (
            id TEXT PRIMARY KEY,
            tenant_id TEXT NULL,
            owner_id TEXT NOT NULL,
            status TEXT NOT NULL,
            updated_at_ms INTEGER NOT NULL,
            record_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_agent_conversations_owner_updated
            ON agent_conversations (tenant_id, owner_id, updated_at_ms DESC);
        CREATE TABLE IF NOT EXISTS agent_turns (
            id TEXT PRIMARY KEY,
            conversation_id TEXT NOT NULL,
            tenant_id TEXT NULL,
            owner_id TEXT NOT NULL,
            status TEXT NOT NULL,
            started_at_ms INTEGER NOT NULL,
            completed_at_ms INTEGER NULL,
            record_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_agent_turns_conversation_started
            ON agent_turns (conversation_id, started_at_ms ASC, id ASC);
        CREATE TABLE IF NOT EXISTS ag_ui_events (
            id TEXT PRIMARY KEY,
            conversation_id TEXT NOT NULL,
            turn_id TEXT NOT NULL,
            tenant_id TEXT NULL,
            owner_id TEXT NOT NULL,
            event_type TEXT NOT NULL,
            created_at_ms INTEGER NOT NULL,
            payload_json TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_ag_ui_events_turn_created
            ON ag_ui_events (turn_id, created_at_ms ASC, id ASC);",
    )?;
}
```

In the Postgres migration function, add the matching version 9 DDL with `BIGINT` for timestamps and `TEXT` JSON payload columns, following the existing Postgres migration style.

- [ ] **Step 4: Implement store methods**

Add methods to `impl ThreadStore`:

```rust
fn upsert_agent_conversation(
    &self,
    record: &AgentConversationRecord,
) -> Result<(), Box<dyn std::error::Error>> {
    let record_json = serde_json::to_string(record)?;
    let updated_at_ms = i64::try_from(record.updated_at_ms)?;
    match self {
        Self::Sqlite { connection, .. } => {
            let guard = connection.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            guard.execute(
                "INSERT INTO agent_conversations (id, tenant_id, owner_id, status, updated_at_ms, record_json)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                 ON CONFLICT(id) DO UPDATE SET
                   tenant_id = excluded.tenant_id,
                   owner_id = excluded.owner_id,
                   status = excluded.status,
                   updated_at_ms = excluded.updated_at_ms,
                   record_json = excluded.record_json",
                rusqlite::params![
                    &record.id,
                    &record.tenant_id,
                    &record.owner_id,
                    format!("{:?}", record.status),
                    updated_at_ms,
                    &record_json
                ],
            )?;
            Ok(())
        }
        Self::Postgres { worker, .. } => worker.upsert_agent_conversation(record),
    }
}

fn upsert_agent_turn(
    &self,
    record: &AgentTurnRecord,
) -> Result<(), Box<dyn std::error::Error>> {
    let record_json = serde_json::to_string(record)?;
    let started_at_ms = i64::try_from(record.started_at_ms)?;
    let completed_at_ms = record.completed_at_ms.map(i64::try_from).transpose()?;
    match self {
        Self::Sqlite { connection, .. } => {
            let guard = connection.lock().unwrap_or_else(std::sync::PoisonError::into_inner);
            guard.execute(
                "INSERT INTO agent_turns (id, conversation_id, tenant_id, owner_id, status, started_at_ms, completed_at_ms, record_json)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
                 ON CONFLICT(id) DO UPDATE SET
                   conversation_id = excluded.conversation_id,
                   tenant_id = excluded.tenant_id,
                   owner_id = excluded.owner_id,
                   status = excluded.status,
                   started_at_ms = excluded.started_at_ms,
                   completed_at_ms = excluded.completed_at_ms,
                   record_json = excluded.record_json",
                rusqlite::params![
                    &record.id,
                    &record.conversation_id,
                    &record.tenant_id,
                    &record.owner_id,
                    format!("{:?}", record.status),
                    started_at_ms,
                    completed_at_ms,
                    &record_json
                ],
            )?;
            Ok(())
        }
        Self::Postgres { worker, .. } => worker.upsert_agent_turn(record),
    }
}
```

Add `list_agent_conversations` and `list_agent_turns` using `record_json` deserialization and tenant/owner predicates matching existing API-key/project store patterns. Add matching Postgres worker methods using `tokio_postgres::Client::execute` / `query`.

- [ ] **Step 5: Run the store test to verify it passes**

Run:

```bash
cd rust && cargo test -p clawd sqlite_store_round_trips_agent_conversations_and_turns
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add rust/crates/clawd/src/main.rs rust/crates/clawd/src/agent_turns.rs
git commit -m "feat: persist webagent conversations and turns"
```

### Task 3: Add AG UI Event Encoding

**Files:**
- Modify: `rust/crates/clawd/src/agent_turns.rs`
- Test: `rust/crates/clawd/src/agent_turns.rs`

- [ ] **Step 1: Write failing event encoder tests**

Add tests to `agent_turns.rs`:

```rust
#[test]
fn ag_ui_event_serializes_text_delta_shape() {
    let event = AgUiEvent::text_content("msg-1", "hello");
    let value = serde_json::to_value(event).expect("serialize event");

    assert_eq!(value["type"], "TEXT_MESSAGE_CONTENT");
    assert_eq!(value["messageId"], "msg-1");
    assert_eq!(value["delta"], "hello");
}

#[test]
fn ag_ui_sse_frame_uses_json_data_lines() {
    let event = AgUiEvent::run_started("conv-1", "turn-1", 42);
    let frame = encode_ag_ui_sse_frame(&event).expect("encode frame");

    assert!(frame.starts_with("data: "));
    assert!(frame.ends_with("\n\n"));
    assert!(frame.contains("\"type\":\"RUN_STARTED\""));
}
```

- [ ] **Step 2: Run the tests to verify they fail**

Run:

```bash
cd rust && cargo test -p clawd ag_ui_event
```

Expected: FAIL because `AgUiEvent` and `encode_ag_ui_sse_frame` do not exist.

- [ ] **Step 3: Implement minimal AG UI event enum and encoder**

Add to `agent_turns.rs`:

```rust
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(tag = "type")]
pub enum AgUiEvent {
    #[serde(rename = "RUN_STARTED")]
    RunStarted {
        #[serde(rename = "threadId")]
        thread_id: String,
        #[serde(rename = "runId")]
        run_id: String,
        timestamp: u64,
    },
    #[serde(rename = "RUN_FINISHED")]
    RunFinished {
        #[serde(rename = "threadId")]
        thread_id: String,
        #[serde(rename = "runId")]
        run_id: String,
        timestamp: u64,
        result: Value,
    },
    #[serde(rename = "RUN_ERROR")]
    RunError {
        message: String,
        code: Option<String>,
        timestamp: u64,
    },
    #[serde(rename = "TEXT_MESSAGE_START")]
    TextMessageStart {
        #[serde(rename = "messageId")]
        message_id: String,
        role: String,
        timestamp: u64,
    },
    #[serde(rename = "TEXT_MESSAGE_CONTENT")]
    TextMessageContent {
        #[serde(rename = "messageId")]
        message_id: String,
        delta: String,
        timestamp: u64,
    },
    #[serde(rename = "TEXT_MESSAGE_END")]
    TextMessageEnd {
        #[serde(rename = "messageId")]
        message_id: String,
        timestamp: u64,
    },
    #[serde(rename = "TOOL_CALL_START")]
    ToolCallStart {
        #[serde(rename = "toolCallId")]
        tool_call_id: String,
        #[serde(rename = "toolCallName")]
        tool_call_name: String,
        #[serde(rename = "parentMessageId")]
        parent_message_id: Option<String>,
        timestamp: u64,
    },
    #[serde(rename = "TOOL_CALL_ARGS")]
    ToolCallArgs {
        #[serde(rename = "toolCallId")]
        tool_call_id: String,
        delta: String,
        timestamp: u64,
    },
    #[serde(rename = "TOOL_CALL_END")]
    ToolCallEnd {
        #[serde(rename = "toolCallId")]
        tool_call_id: String,
        timestamp: u64,
    },
    #[serde(rename = "TOOL_CALL_RESULT")]
    ToolCallResult {
        #[serde(rename = "toolCallId")]
        tool_call_id: String,
        message: String,
        timestamp: u64,
    },
    #[serde(rename = "ACTIVITY_DELTA")]
    ActivityDelta {
        delta: Value,
        timestamp: u64,
    },
    #[serde(rename = "STATE_SNAPSHOT")]
    StateSnapshot {
        snapshot: Value,
        timestamp: u64,
    },
}

impl AgUiEvent {
    pub fn run_started(thread_id: &str, run_id: &str, timestamp: u64) -> Self {
        Self::RunStarted {
            thread_id: thread_id.to_string(),
            run_id: run_id.to_string(),
            timestamp,
        }
    }

    pub fn text_content(message_id: &str, delta: &str) -> Self {
        Self::TextMessageContent {
            message_id: message_id.to_string(),
            delta: delta.to_string(),
            timestamp: crate::now_millis(),
        }
    }
}

pub fn encode_ag_ui_sse_frame(event: &AgUiEvent) -> Result<String, serde_json::Error> {
    let payload = serde_json::to_string(event)?;
    Ok(format!("data: {payload}\n\n"))
}
```

- [ ] **Step 4: Run event encoder tests**

Run:

```bash
cd rust && cargo test -p clawd ag_ui_event
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add rust/crates/clawd/src/agent_turns.rs
git commit -m "feat: encode ag ui events"
```

### Task 4: Add WebAgent REST APIs And AG UI Endpoint

**Files:**
- Modify: `rust/crates/clawd/src/main.rs`
- Test: `rust/crates/clawd/src/main.rs`

- [ ] **Step 1: Write failing API tests for no `workspace_root`**

Add tests in `main.rs` using existing handler-test patterns:

```rust
#[tokio::test]
async fn create_agent_conversation_does_not_require_workspace_root() {
    let temp_dir = test_temp_dir("agent-conversation-api");
    let state = Arc::new(AppState::new(Arc::new(test_config(temp_dir))).expect("state"));
    let request = CreateAgentConversationRequest {
        title: Some("台海供应链风险".to_string()),
        selected_knowledge_base_ids: Some(vec!["kb-platform".to_string()]),
        selected_data_source_ids: None,
        selected_expert_ids: Some(vec!["howard-wang".to_string()]),
        model_profile_id: None,
    };

    let response = create_agent_conversation(
        State(state),
        HeaderMap::new(),
        Query(AuthQuery { user_id: Some("alice".to_string()), tenant_id: Some("tenant-a".to_string()), api_key: None }),
        Json(request),
    )
    .await
    .expect("create conversation")
    .0;

    assert_eq!(response.title, "台海供应链风险");
    assert_eq!(response.selected_expert_ids, vec!["howard-wang"]);
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
cd rust && cargo test -p clawd create_agent_conversation_does_not_require_workspace_root
```

Expected: FAIL because request/handler/routes do not exist.

- [ ] **Step 3: Add API request/response structs**

Add near existing request structs:

```rust
#[derive(Debug, Deserialize)]
struct CreateAgentConversationRequest {
    title: Option<String>,
    selected_knowledge_base_ids: Option<Vec<String>>,
    selected_data_source_ids: Option<Vec<String>>,
    selected_expert_ids: Option<Vec<String>>,
    model_profile_id: Option<String>,
}

#[derive(Debug, Deserialize)]
struct AgUiRunRequest {
    #[serde(rename = "threadId")]
    thread_id: String,
    #[serde(rename = "runId")]
    run_id: String,
    #[serde(default)]
    messages: Vec<Value>,
    #[serde(default)]
    state: Value,
    #[serde(default)]
    context: Vec<Value>,
    #[serde(default, rename = "forwardedProps")]
    forwarded_props: Value,
}
```

Return `Json<AgentConversationRecord>` and `Json<Vec<AgentTurnRecord>>` directly for the new WebAgent APIs.

- [ ] **Step 4: Add routes**

In the Axum router setup, add:

```rust
.route("/v1/agent/conversations", get(list_agent_conversations).post(create_agent_conversation))
.route("/v1/agent/conversations/:id/turns", get(list_agent_turns))
.route("/v1/agent/ag-ui", post(post_ag_ui_run))
.route("/v1/agent/conversations/:id/interrupt", post(interrupt_agent_conversation))
```

- [ ] **Step 5: Implement conversation handlers**

Add handlers:

```rust
async fn create_agent_conversation(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
    Json(request): Json<CreateAgentConversationRequest>,
) -> Result<Json<AgentConversationRecord>, AppError> {
    let auth = resolve_auth_context(&state, &headers, &query)?;
    let now = now_millis();
    let title = normalize_optional_text(request.title)
        .unwrap_or_else(|| "新对话".to_string());
    let record = AgentConversationRecord {
        id: generate_id("conversation"),
        tenant_id: auth.tenant_id.clone(),
        owner_id: auth.user_id.clone(),
        title,
        status: AgentConversationStatus::Idle,
        selected_knowledge_base_ids: request.selected_knowledge_base_ids.unwrap_or_default(),
        selected_data_source_ids: request.selected_data_source_ids.unwrap_or_default(),
        selected_expert_ids: request.selected_expert_ids.unwrap_or_default(),
        model_profile_id: normalize_optional_text(request.model_profile_id),
        created_at_ms: now,
        updated_at_ms: now,
    };
    state.store.upsert_agent_conversation(&record)
        .map_err(|error| AppError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;
    Ok(Json(record))
}
```

Implement `list_agent_conversations` and `list_agent_turns` using the store methods from Task 2 and the current auth context.

- [ ] **Step 6: Implement a streaming endpoint skeleton**

Implement `post_ag_ui_run` as an SSE response that emits `RUN_STARTED`, `TEXT_MESSAGE_START`, one `TEXT_MESSAGE_CONTENT`, `TEXT_MESSAGE_END`, and `RUN_FINISHED` for a deterministic first pass. Use `axum::response::sse::{Event, Sse}` or a `Body::from_stream` with `encode_ag_ui_sse_frame`; keep the content type as `text/event-stream`.

The first skeleton must create an `AgentTurnRecord` with `status = AgentTurnStatus::Succeeded` and save it through `state.store.upsert_agent_turn`.

- [ ] **Step 7: Run API tests**

Run:

```bash
cd rust && cargo test -p clawd create_agent_conversation_does_not_require_workspace_root
cd rust && cargo test -p clawd ag_ui
```

Expected: PASS for the new conversation test and any AG UI skeleton tests.

- [ ] **Step 8: Commit**

```bash
git add rust/crates/clawd/src/main.rs rust/crates/clawd/src/agent_turns.rs
git commit -m "feat: add webagent ag ui endpoints"
```

### Task 5: Bridge Runtime Streaming, Tools, Citations, And AgentTurn Updates

Status: **backend runtime path implemented** as of 2026-05-15.

- Completed: tool-result to public step/citation mapper, `AgentToolUpdates`, focused mapper tests, AG UI skeleton endpoint persistence of forwarded tool updates, and runtime `AgentRunEventSink` plumbing on provider/tool paths.
- Completed: stale Rust test call sites were updated so Task 4/5 focused tests compile and run.
- Completed: `/v1/agent/ag-ui` now verifies the WebAgent conversation, creates an internal managed runtime thread, starts a runtime-backed run with an active `AgentRunEventSink`, streams provider deltas/tool calls into AG UI SSE events, updates the current `AgentTurnRecord`, and emits runtime `RUN_ERROR` / `RUN_FINISHED`.
- Known follow-up: `ToolExecutor::execute` still lacks provider `tool_call_id`, so runtime `TOOL_CALL_RESULT` currently uses the turn id for correlation. A later runtime trait upgrade should pass tool call id through the executor to avoid collisions when several tools run in one turn.

**Files:**
- Modify: `rust/crates/clawd/src/main.rs`
- Modify: `rust/crates/clawd/src/agent_turns.rs`
- Test: `rust/crates/clawd/src/main.rs`

- [ ] **Step 1: Write failing mapper tests**

Add tests for tool/result mapping:

```rust
#[test]
fn es_search_tool_result_maps_to_public_retrieval_step_and_citation() {
    let input = serde_json::json!({ "query": "台海供应链", "index": "military-index" });
    let output = serde_json::json!({
        "query": "台海供应链",
        "index": "military-index",
        "hits": [
            { "title": "供应链报告", "preview": "港口风险上升", "location": "military-index#1", "score": 0.91 }
        ]
    })
    .to_string();

    let mapped = map_tool_result_to_agent_updates("tool-1", "EsSearch", &input.to_string(), &output, false);

    assert_eq!(mapped.steps[0].label, "资料检索已返回");
    assert_eq!(mapped.citations[0].number, 1);
    assert_eq!(mapped.citations[0].title.as_deref(), Some("供应链报告"));
    assert_eq!(mapped.debug_event.event_type, "TOOL_CALL_RESULT");
}
```

- [ ] **Step 2: Run mapper test to verify it fails**

Run:

```bash
cd rust && cargo test -p clawd es_search_tool_result_maps_to_public_retrieval_step_and_citation
```

Expected: FAIL because mapper does not exist.

- [ ] **Step 3: Implement mapping helpers**

Add a helper struct in `agent_turns.rs`:

```rust
#[derive(Debug, Clone)]
pub struct AgentToolUpdates {
    pub steps: Vec<AgentTurnStep>,
    pub citations: Vec<AgentCitation>,
    pub expert_results: Vec<AgentExpertResult>,
    pub debug_event: AgentTurnDebugEvent,
}
```

In `main.rs`, implement:

```rust
fn map_tool_result_to_agent_updates(
    tool_call_id: &str,
    tool_name: &str,
    input: &str,
    output: &str,
    is_error: bool,
) -> agent_turns::AgentToolUpdates {
    let now = now_millis();
    let public_label = match tool_name {
        "EsSearch" | "SourceSearch" => {
            if is_error { "资料检索失败" } else { "资料检索已返回" }
        }
        "DbQuery" => if is_error { "数据库查询失败" } else { "数据库查询已返回" },
        "ArtifactEmit" => if is_error { "产物生成失败" } else { "产物已生成" },
        _ => if is_error { "工具执行失败" } else { "工具执行完成" },
    };
    let parsed = serde_json::from_str::<Value>(output).unwrap_or(Value::String(output.to_string()));
    let citations = extract_agent_citations(tool_call_id, tool_name, &parsed);
    agent_turns::AgentToolUpdates {
        steps: vec![agent_turns::AgentTurnStep {
            id: format!("step-{tool_call_id}"),
            kind: if matches!(tool_name, "EsSearch" | "SourceSearch") {
                agent_turns::AgentTurnStepKind::Retrieval
            } else {
                agent_turns::AgentTurnStepKind::Tool
            },
            label: public_label.to_string(),
            detail: Some(if citations.is_empty() {
                "未生成引用".to_string()
            } else {
                format!("生成 {} 条引用", citations.len())
            }),
            status: if is_error {
                agent_turns::AgentTurnStepStatus::Failed
            } else {
                agent_turns::AgentTurnStepStatus::Succeeded
            },
            started_at_ms: None,
            completed_at_ms: Some(now),
            public_payload: serde_json::json!({ "citation_count": citations.len() }),
            debug_payload: Some(serde_json::json!({ "tool": tool_name, "input": input, "output": output })),
        }],
        citations,
        expert_results: Vec::new(),
        debug_event: agent_turns::AgentTurnDebugEvent {
            event_type: "TOOL_CALL_RESULT".to_string(),
            at_ms: now,
            payload: serde_json::json!({ "toolCallId": tool_call_id, "toolName": tool_name, "isError": is_error }),
        },
    }
}
```

Implement `extract_agent_citations` for `EsSearch` and `SourceSearch` by reading `hits[]` items with `title`, `preview`, `location`, and assigning citation numbers in call order.

- [ ] **Step 4: Bridge provider stream events to AG UI events**

Refactor `ServiceApiClient::publish_stream_text`, `push_output_block`, and `ServiceToolExecutor::execute` so the AG UI endpoint can subscribe to the same runtime events without going through old `thread.publish` only.

Add an internal sender type:

```rust
#[derive(Clone)]
struct AgentRunEventSink {
    turn_id: String,
    message_id: String,
    sender: tokio::sync::mpsc::UnboundedSender<agent_turns::AgUiEvent>,
}
```

When AG UI mode is active:

- text deltas send `TEXT_MESSAGE_CONTENT`
- tool start sends `TOOL_CALL_START` and `ACTIVITY_DELTA`
- tool args send `TOOL_CALL_ARGS`
- tool result sends `TOOL_CALL_RESULT` and an `ACTIVITY_DELTA`
- errors send `RUN_ERROR`
- completion sends `TEXT_MESSAGE_END` then `RUN_FINISHED`

Each public step/citation update must also update the current `AgentTurnRecord` with `state.store.upsert_agent_turn`.

- [ ] **Step 5: Run backend runtime tests**

Run:

```bash
cd rust && cargo test -p clawd es_search_tool_result_maps_to_public_retrieval_step_and_citation
cd rust && cargo test -p clawd agent_turn
cd rust && cargo test -p clawd ag_ui
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add rust/crates/clawd/src/main.rs rust/crates/clawd/src/agent_turns.rs
git commit -m "feat: stream runtime events through ag ui turns"
```

### Task 6: Add Frontend AG UI Runtime And AgentTurn Types

**Files:**
- Modify: `webagent-ui/package.json`
- Modify: `webagent-ui/package-lock.json`
- Create: `webagent-ui/src/lib/clawd/agent-turns.ts`
- Create: `webagent-ui/src/lib/clawd/agent-turns.test.ts`
- Create: `webagent-ui/src/lib/clawd/ag-ui-client.ts`

- [ ] **Step 1: Install AG UI dependencies**

Run:

```bash
cd webagent-ui && npm install @assistant-ui/react-ag-ui @ag-ui/client
```

Expected: `package.json` and `package-lock.json` include both packages.

- [ ] **Step 2: Write failing frontend helper tests**

Create `webagent-ui/src/lib/clawd/agent-turns.test.ts`:

```ts
import { describe, expect, it } from "vitest";

import {
  groupTurnsByDisplayDate,
  replaceEvidenceMarkersWithCitationNumbers,
  statusLabelForAgentTurn,
} from "./agent-turns";

describe("agent-turn helpers", () => {
  it("replaces raw evidence markers with numbered citations", () => {
    const result = replaceEvidenceMarkersWithCitationNumbers(
      "结论来自 evidence:tool-1#hit-0 和 evidence:tool-1#hit-1",
      [
        { id: "tool-1#hit-0", number: 1 },
        { id: "tool-1#hit-1", number: 2 },
      ],
    );

    expect(result).toBe("结论来自 [1] 和 [2]");
  });

  it("uses compact date separators", () => {
    const groups = groupTurnsByDisplayDate(
      [
        { id: "a", started_at_ms: new Date("2026-05-15T08:00:00+08:00").getTime() },
        { id: "b", started_at_ms: new Date("2026-05-16T08:00:00+08:00").getTime() },
      ],
      new Date("2026-05-16T12:00:00+08:00"),
    );

    expect(groups.map((group) => group.label)).toEqual(["5月15日 周五", "5月16日 周六"]);
  });

  it("uses ordinary user status labels", () => {
    expect(statusLabelForAgentTurn("running")).toBe("正在处理");
    expect(statusLabelForAgentTurn("failed")).toBe("处理失败");
  });
});
```

- [ ] **Step 3: Run tests to verify they fail**

Run:

```bash
cd webagent-ui && npm test -- --run src/lib/clawd/agent-turns.test.ts
```

Expected: FAIL because helpers do not exist.

- [ ] **Step 4: Implement frontend types and helpers**

Create `webagent-ui/src/lib/clawd/agent-turns.ts`:

```ts
export type AgentTurnStatus = "queued" | "running" | "succeeded" | "interrupted" | "failed";

export interface AgentTurnStep {
  id: string;
  kind: "retrieval" | "tool" | "expert" | "citation" | "artifact" | "generation";
  label: string;
  detail: string | null;
  status: "running" | "succeeded" | "failed" | "skipped";
  started_at_ms: number | null;
  completed_at_ms: number | null;
  public_payload: unknown;
  debug_payload?: unknown;
}

export interface AgentCitation {
  id: string;
  number: number;
  source_kind: string;
  source_label: string;
  title: string | null;
  location: string | null;
  preview: string;
  debug_payload?: unknown;
}

export interface AgentExpertResult {
  expert_name: string;
  status: "running" | "succeeded" | "retrying" | "failed" | "skipped";
  summary: string | null;
  citation_numbers: number[];
  error: string | null;
}

export interface AgentTurnRecord {
  id: string;
  conversation_id: string;
  tenant_id: string | null;
  owner_id: string;
  user_message: string;
  assistant_text: string;
  status: AgentTurnStatus;
  started_at_ms: number;
  completed_at_ms: number | null;
  steps: AgentTurnStep[];
  citations: AgentCitation[];
  expert_results: AgentExpertResult[];
  artifacts: unknown[];
  error: { public_message: string; debug_message: string | null; code: string | null } | null;
  debug_events: Array<{ event_type: string; at_ms: number; payload: unknown }>;
}

export function statusLabelForAgentTurn(status: AgentTurnStatus): string {
  switch (status) {
    case "queued":
      return "等待发送";
    case "running":
      return "正在处理";
    case "succeeded":
      return "已完成";
    case "interrupted":
      return "已停止";
    case "failed":
      return "处理失败";
  }
}

export function replaceEvidenceMarkersWithCitationNumbers(
  text: string,
  citations: Array<{ id: string; number: number }>,
): string {
  return text.replace(/evidence:([^\s`),.;，。；）]+)/g, (raw, id: string) => {
    const citation = citations.find((item) => item.id === id);
    return citation ? `[${citation.number}]` : raw;
  });
}

export function groupTurnsByDisplayDate<T extends { started_at_ms: number }>(
  turns: T[],
  now: Date = new Date(),
): Array<{ key: string; label: string; turns: T[] }> {
  const groups = new Map<string, { key: string; label: string; turns: T[] }>();
  for (const turn of turns) {
    const date = new Date(turn.started_at_ms);
    const key = date.toLocaleDateString("zh-CN");
    const sameYear = date.getFullYear() === now.getFullYear();
    const label = date.toLocaleDateString("zh-CN", {
      year: sameYear ? undefined : "numeric",
      month: "numeric",
      day: "numeric",
      weekday: "short",
    });
    const group = groups.get(key) ?? { key, label, turns: [] };
    group.turns.push(turn);
    groups.set(key, group);
  }
  return [...groups.values()];
}
```

- [ ] **Step 5: Add AG UI client factory**

Create `webagent-ui/src/lib/clawd/ag-ui-client.ts`:

```ts
import { HttpAgent } from "@ag-ui/client";

import type { RequestAuth } from "./types";

export function agUiEndpointUrl(auth: RequestAuth): string {
  const params = new URLSearchParams();
  if (auth.userId) params.set("user_id", auth.userId);
  if (auth.tenantId) params.set("tenant_id", auth.tenantId);
  if (auth.apiKey) params.set("api_key", auth.apiKey);
  const query = params.toString();
  return `/v1/agent/ag-ui${query ? `?${query}` : ""}`;
}

export function createWebAgentHttpAgent(auth: RequestAuth): HttpAgent {
  return new HttpAgent({
    url: agUiEndpointUrl(auth),
  });
}
```

- [ ] **Step 6: Run frontend helper tests**

Run:

```bash
cd webagent-ui && npm test -- --run src/lib/clawd/agent-turns.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add webagent-ui/package.json webagent-ui/package-lock.json webagent-ui/src/lib/clawd/agent-turns.ts webagent-ui/src/lib/clawd/agent-turns.test.ts webagent-ui/src/lib/clawd/ag-ui-client.ts
git commit -m "feat: add webagent ag ui frontend model"
```

### Task 7: Build AgentTurnView And Inline Process Rendering

**Files:**
- Create: `webagent-ui/src/components/conversation/AgentTurnView.tsx`
- Create: `webagent-ui/src/components/conversation/AgentActivityTimeline.tsx`
- Create: `webagent-ui/src/components/conversation/AgentCitationList.tsx`
- Create: `webagent-ui/src/components/conversation/AgentDebugDetails.tsx`
- Create: `webagent-ui/src/components/conversation/AgentTurnView.test.tsx`

- [ ] **Step 1: Write failing component tests**

Create `webagent-ui/src/components/conversation/AgentTurnView.test.tsx`:

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";

import { AgentTurnView } from "./AgentTurnView";
import type { AgentTurnRecord } from "@/lib/clawd/agent-turns";

const turn: AgentTurnRecord = {
  id: "turn-1",
  conversation_id: "conv-1",
  tenant_id: "tenant-a",
  owner_id: "alice",
  user_message: "分析台海供应链风险",
  assistant_text: "主要风险来自运输节点。[1]",
  status: "succeeded",
  started_at_ms: new Date("2026-05-15T14:32:00+08:00").getTime(),
  completed_at_ms: new Date("2026-05-15T14:33:00+08:00").getTime(),
  steps: [
    {
      id: "step-1",
      kind: "retrieval",
      label: "资料检索已返回",
      detail: "生成 1 条引用",
      status: "succeeded",
      started_at_ms: new Date("2026-05-15T14:32:04+08:00").getTime(),
      completed_at_ms: new Date("2026-05-15T14:32:07+08:00").getTime(),
      public_payload: { citation_count: 1 },
    },
  ],
  citations: [
    {
      id: "tool-1#hit-0",
      number: 1,
      source_kind: "es",
      source_label: "平台资料库",
      title: "供应链报告",
      location: "military-index#1",
      preview: "港口风险上升。",
    },
  ],
  expert_results: [],
  artifacts: [],
  error: null,
  debug_events: [],
};

describe("AgentTurnView", () => {
  it("renders one user question with one integrated agent answer", () => {
    render(<AgentTurnView isAdmin={false} turn={turn} />);

    expect(screen.getByText("分析台海供应链风险")).toBeInTheDocument();
    expect(screen.getByText("主要风险来自运输节点。")).toBeInTheDocument();
    expect(screen.getByText("资料检索已返回")).toBeInTheDocument();
    expect(screen.getByText("引用资料")).toBeInTheDocument();
    expect(screen.getByText("供应链报告")).toBeInTheDocument();
    expect(screen.queryByText("TOOL_CALL_RESULT")).not.toBeInTheDocument();
  });
});
```

- [ ] **Step 2: Run component test to verify it fails**

Run:

```bash
cd webagent-ui && npm test -- --run src/components/conversation/AgentTurnView.test.tsx
```

Expected: FAIL because components do not exist.

- [ ] **Step 3: Implement citation list**

Create `AgentCitationList.tsx`:

```tsx
import type { AgentCitation } from "@/lib/clawd/agent-turns";

export function AgentCitationList({ citations }: { citations: AgentCitation[] }) {
  if (!citations.length) return null;

  return (
    <section className="mt-3 border-t border-border/30 pt-3">
      <p className="text-[11px] font-medium text-muted-foreground">引用资料</p>
      <div className="mt-2 space-y-2">
        {citations.map((citation) => (
          <article className="rounded-md border border-border/35 bg-background/60 px-3 py-2" key={citation.id}>
            <div className="flex items-start gap-2">
              <span className="rounded bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium text-primary">
                [{citation.number}]
              </span>
              <div className="min-w-0">
                <p className="truncate text-xs font-medium text-foreground">
                  {citation.title ?? citation.source_label}
                </p>
                <p className="mt-1 text-[11px] leading-5 text-muted-foreground">
                  {citation.preview}
                </p>
                <p className="mt-1 text-[10px] text-muted-foreground/65">
                  {citation.source_label}
                  {citation.location ? ` · ${citation.location}` : ""}
                </p>
              </div>
            </div>
          </article>
        ))}
      </div>
    </section>
  );
}
```

- [ ] **Step 4: Implement internal activity timeline**

Create `AgentActivityTimeline.tsx`:

```tsx
import type { AgentTurnStep } from "@/lib/clawd/agent-turns";

function formatEventTime(value: number | null): string {
  if (!value) return "";
  return new Date(value).toLocaleString("zh-CN", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

export function AgentActivityTimeline({ steps }: { steps: AgentTurnStep[] }) {
  if (!steps.length) return null;

  return (
    <div className="mt-3 rounded-md border border-border/30 bg-background/45 px-3 py-2">
      <div className="space-y-2">
        {steps.slice(0, 5).map((step) => (
          <div className="flex min-w-0 gap-2" key={step.id}>
            <span
              className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-primary/60"
              title={formatEventTime(step.completed_at_ms ?? step.started_at_ms)}
            />
            <div className="min-w-0">
              <p className="text-[11px] font-medium text-foreground/85">{step.label}</p>
              {step.detail ? (
                <p className="mt-0.5 break-words text-[10px] text-muted-foreground">
                  {step.detail}
                </p>
              ) : null}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
```

- [ ] **Step 5: Implement admin debug details**

Create `AgentDebugDetails.tsx`:

```tsx
import type { AgentTurnRecord } from "@/lib/clawd/agent-turns";

export function AgentDebugDetails({ isAdmin, turn }: { isAdmin: boolean; turn: AgentTurnRecord }) {
  if (!isAdmin) return null;

  return (
    <details className="mt-3 rounded-md border border-border/30 bg-background/60 px-3 py-2">
      <summary className="cursor-pointer text-[11px] font-medium text-muted-foreground">
        技术细节
      </summary>
      <pre className="mt-2 max-h-64 overflow-auto whitespace-pre-wrap break-words text-[10px] text-muted-foreground">
        {JSON.stringify({ steps: turn.steps, events: turn.debug_events }, null, 2)}
      </pre>
    </details>
  );
}
```

- [ ] **Step 6: Implement AgentTurnView**

Create `AgentTurnView.tsx`:

```tsx
import { MarkdownMessage } from "./MarkdownMessage";
import { AgentActivityTimeline } from "./AgentActivityTimeline";
import { AgentCitationList } from "./AgentCitationList";
import { AgentDebugDetails } from "./AgentDebugDetails";
import {
  replaceEvidenceMarkersWithCitationNumbers,
  statusLabelForAgentTurn,
  type AgentTurnRecord,
} from "@/lib/clawd/agent-turns";

function formatShortTime(value: number): string {
  return new Date(value).toLocaleTimeString("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
  });
}

export function AgentTurnView({ isAdmin, turn }: { isAdmin: boolean; turn: AgentTurnRecord }) {
  const text = replaceEvidenceMarkersWithCitationNumbers(
    turn.assistant_text,
    turn.citations.map((citation) => ({ id: citation.id, number: citation.number })),
  );

  return (
    <article className="flex min-w-0 gap-3 py-3" data-agent-turn-id={turn.id}>
      <div className="w-14 shrink-0 text-right">
        <button className="inline-flex flex-col items-end gap-1" title={new Date(turn.started_at_ms).toLocaleString("zh-CN")} type="button">
          <span className="text-[10px] text-muted-foreground/75">{formatShortTime(turn.started_at_ms)}</span>
          <span className="h-2.5 w-2.5 rounded-full border border-primary/55 bg-primary/25" />
        </button>
      </div>
      <div className="min-w-0 flex-1">
        <div className="ml-auto max-w-[72%] rounded-2xl rounded-tr-sm border border-primary/20 bg-primary/15 px-4 py-3">
          <p className="whitespace-pre-wrap break-words text-sm leading-6">{turn.user_message}</p>
        </div>
        <div className="mt-3 max-w-[88%] rounded-2xl rounded-tl-sm border border-border/40 bg-card/50 px-4 py-3">
          <div className="mb-2 flex items-center gap-2">
            <span className="text-[11px] font-medium text-primary">{statusLabelForAgentTurn(turn.status)}</span>
          </div>
          <AgentActivityTimeline steps={turn.steps} />
          {turn.error ? (
            <p className="mt-3 rounded-md border border-destructive/30 bg-destructive/10 px-3 py-2 text-sm text-destructive">
              {turn.error.public_message}
            </p>
          ) : null}
          {text ? (
            <div className="mt-3 min-w-0">
              <MarkdownMessage content={text} streaming={turn.status === "running"} />
            </div>
          ) : null}
          <AgentCitationList citations={turn.citations} />
          <AgentDebugDetails isAdmin={isAdmin} turn={turn} />
        </div>
      </div>
    </article>
  );
}
```

- [ ] **Step 7: Run component test**

Run:

```bash
cd webagent-ui && npm test -- --run src/components/conversation/AgentTurnView.test.tsx
```

Expected: PASS.

- [ ] **Step 8: Commit**

```bash
git add webagent-ui/src/components/conversation/AgentTurnView.tsx webagent-ui/src/components/conversation/AgentActivityTimeline.tsx webagent-ui/src/components/conversation/AgentCitationList.tsx webagent-ui/src/components/conversation/AgentDebugDetails.tsx webagent-ui/src/components/conversation/AgentTurnView.test.tsx
git commit -m "feat: render integrated agent turns"
```

### Task 8: Switch ConversationStage To AgentTurn Main Path

**Files:**
- Modify: `webagent-ui/src/components/conversation/ConversationStage.tsx`
- Modify: `webagent-ui/src/components/conversation/ConversationComposer.tsx`
- Modify: `webagent-ui/src/components/inspiration/InspirationMode.tsx`
- Test: `webagent-ui/src/components/conversation/ConversationComposer.test.tsx`

- [ ] **Step 1: Write failing composer queue test**

Create or extend `ConversationComposer.test.tsx`:

```tsx
import { fireEvent, render, screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";

import { ConversationComposer } from "./ConversationComposer";

describe("ConversationComposer WebAgent run behavior", () => {
  it("keeps input enabled while running and shows stop action", () => {
    const onSubmit = vi.fn();
    const onInterrupt = vi.fn();

    render(
      <ConversationComposer
        disabled={false}
        isRunning={true}
        onInterrupt={onInterrupt}
        onSubmit={onSubmit}
        quickActions={[]}
      />,
    );

    const input = screen.getByRole("textbox");
    fireEvent.change(input, { target: { value: "追加问题" } });
    expect(input).toHaveValue("追加问题");

    fireEvent.click(screen.getByRole("button", { name: "停止" }));
    expect(onInterrupt).toHaveBeenCalledTimes(1);
  });
});
```

- [ ] **Step 2: Run test to verify current behavior fails if input is disabled**

Run:

```bash
cd webagent-ui && npm test -- --run src/components/conversation/ConversationComposer.test.tsx
```

Expected: FAIL until the composer props and implementation support enabled input while running.

- [ ] **Step 3: Update ConversationComposer props**

Ensure `ConversationComposer` accepts:

```ts
interface ConversationComposerProps {
  disabled?: boolean;
  isRunning?: boolean;
  queuedCount?: number;
  quickActions?: string[];
  onInterrupt?: () => Promise<void> | void;
  onSubmit: (content: string) => Promise<void> | void;
}
```

Implementation rule:

- `disabled` only means the user cannot type due to auth/loading fatal state
- `isRunning` changes the send button to a stop button
- user can keep typing while `isRunning`
- submit while `isRunning` calls the parent queue handler instead of disabling input

- [ ] **Step 4: Update ConversationStage render path**

Add a feature path in `ConversationStage`:

```tsx
if (agentTurns) {
  return (
    <div className="relative flex min-h-0 min-w-0 flex-1 flex-col border-x border-border/30">
      <div ref={viewportRef} className="min-h-0 flex-1 overflow-y-auto px-6 py-4 scrollbar-thin">
        {groupTurnsByDisplayDate(agentTurns).map((group) => (
          <section key={group.key}>
            <div className="sticky top-0 z-10 mx-auto mb-2 w-fit rounded-full border border-border/30 bg-background/85 px-3 py-1 text-[10px] text-muted-foreground backdrop-blur">
              {group.label}
            </div>
            {group.turns.map((turn) => (
              <AgentTurnView isAdmin={isPlatformAdmin} key={turn.id} turn={turn} />
            ))}
          </section>
        ))}
      </div>
      <ConversationComposer
        disabled={loading}
        isRunning={running}
        onInterrupt={onInterrupt}
        onSubmit={submitContent}
        queuedCount={queuedMessages.length}
        quickActions={[]}
      />
    </div>
  );
}
```

Keep the old `ThreadPrimitive` path behind a temporary prop only for rollback during the same branch. Do not use it from `InspirationMode` after this task.

- [ ] **Step 5: Update InspirationMode to fetch WebAgent conversations and turns**

Replace the active chat data source with:

- `GET /v1/agent/conversations`
- `GET /v1/agent/conversations/:id/turns`
- `POST /v1/agent/conversations`
- AG UI runtime URL `/v1/agent/ag-ui`
- interrupt endpoint `/v1/agent/conversations/:id/interrupt`

Do not pass `workspace_root` from this path.

- [ ] **Step 6: Run frontend tests**

Run:

```bash
cd webagent-ui && npm test -- --run \
  src/lib/clawd/agent-turns.test.ts \
  src/components/conversation/AgentTurnView.test.tsx \
  src/components/conversation/ConversationComposer.test.tsx
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add webagent-ui/src/components/conversation/ConversationStage.tsx webagent-ui/src/components/conversation/ConversationComposer.tsx webagent-ui/src/components/inspiration/InspirationMode.tsx webagent-ui/src/components/conversation/ConversationComposer.test.tsx
git commit -m "feat: switch chat stage to agent turns"
```

### Task 9: Remove Workspace Semantics From WebAgent Tools And Skills

**Files:**
- Modify: `rust/crates/clawd/src/main.rs`
- Modify: `.claw/skills/basic-evidence-scan/SKILL.md`
- Modify: `.claw/skills/expert-brainstorm/SKILL.md`
- Test: `rust/crates/clawd/src/main.rs`

- [ ] **Step 1: Write failing tool whitelist test**

Add a Rust test:

```rust
#[test]
fn webagent_allowed_tools_exclude_local_workspace_tools() {
    let allowed = webagent_allowed_tool_names(true, true, true, true);

    assert!(allowed.contains("EsSearch"));
    assert!(allowed.contains("SourceSearch"));
    assert!(allowed.contains("SourceRead"));
    assert!(allowed.contains("ArtifactEmit"));
    assert!(!allowed.contains("read_file"));
    assert!(!allowed.contains("write_file"));
    assert!(!allowed.contains("edit_file"));
    assert!(!allowed.contains("glob_search"));
    assert!(!allowed.contains("grep_search"));
    assert!(!allowed.contains("Bash"));
    assert!(!allowed.contains("PowerShell"));
}
```

- [ ] **Step 2: Run the test to verify it fails**

Run:

```bash
cd rust && cargo test -p clawd webagent_allowed_tools_exclude_local_workspace_tools
```

Expected: FAIL because `webagent_allowed_tool_names` does not exist.

- [ ] **Step 3: Implement WebAgent tool whitelist**

Add:

```rust
fn webagent_allowed_tool_names(
    has_es_access: bool,
    has_document_access: bool,
    has_web_access: bool,
    has_db_access: bool,
) -> BTreeSet<String> {
    let mut allowed = BTreeSet::from([
        "Skill".to_string(),
        "MemoryWrite".to_string(),
        "MemorySearch".to_string(),
        "TopicDriftCheck".to_string(),
        "ArtifactEmit".to_string(),
        "ExpertPanelEmit".to_string(),
    ]);
    if has_es_access {
        allowed.insert("EsSearch".to_string());
    }
    if has_document_access {
        allowed.insert("SourceSearch".to_string());
        allowed.insert("SourceRead".to_string());
    }
    if has_web_access {
        allowed.insert("SourceWebFetch".to_string());
    }
    if has_db_access {
        allowed.insert("DbQuery".to_string());
    }
    allowed
}
```

Use this function for the AG UI run path. Keep legacy thread path unchanged until it is removed from the product route.

- [ ] **Step 4: Update skill instructions**

In `.claw/skills/basic-evidence-scan/SKILL.md`:

- replace `workspace` memory scope with `user` or `tenant`
- remove `glob_search`, `grep_search`, `read_file`
- require `EsSearch`, `SourceSearch`, `SourceRead`, and `MemorySearch`

In `.claw/skills/expert-brainstorm/SKILL.md`:

- replace `workspace` memory scope with `user`
- explicitly say local file tools are unavailable in WebAgent sessions

- [ ] **Step 5: Run tests**

Run:

```bash
cd rust && cargo test -p clawd webagent_allowed_tools_exclude_local_workspace_tools
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add rust/crates/clawd/src/main.rs .claw/skills/basic-evidence-scan/SKILL.md .claw/skills/expert-brainstorm/SKILL.md
git commit -m "feat: restrict webagent tools to platform data"
```

### Task 10A: Verification Baseline Closeout

**Files:**
- Modify: `webagent-ui/src/components/inspiration/ChatPanel.test.tsx`
- Modify: `webagent-ui/src/components/inspiration/ChatPanel.interventions.test.tsx`
- Modify: `docs/superpowers/plans/2026-05-15-ag-ui-webagent-rebuild.md`

- [ ] **Step 1: Align stale frontend assertions with the current product surface**

Update `webagent-ui/src/components/inspiration/ChatPanel.test.tsx` so it validates the current WebAgent UI contract:

- user-facing copy uses `对话`, not `会话`
- the center header can show the research/task summary instead of the transient submit status
- the conversation switcher shows the current conversation and `进行中 N` while the full list remains collapsed
- reference details are collapsed by default, so tests should assert the summary (`引用与产物`, `1 条检索引用`) and not hidden ES metadata
- recent upload header badges use the compact header copy (`上传完成后切入个人资料范围`, `最近上传已纳入本轮范围`)
- composer assistive rows and old quick-action chips stay hidden by default so the chat transcript keeps maximum height; the intervention test should validate that normal typing and sending still works instead of reintroducing prompt-chip rows

- [ ] **Step 2: Run focused frontend regression**

Run:

```bash
cd webagent-ui && npm test -- --run src/components/inspiration/ChatPanel.test.tsx
```

Expected: PASS. Warnings from `assistant-ui` `useLayoutEffect` under server rendering are acceptable if tests pass.

- [ ] **Step 3: Run frontend baseline verification**

Run:

```bash
cd webagent-ui && npm test -- --run
cd webagent-ui && npm run build
```

Expected: both commands exit 0. The Vite chunk-size warning is acceptable.

- [ ] **Step 4: Run Rust baseline verification**

Run:

```bash
cd rust && cargo fmt
cd rust && cargo test --workspace
```

Expected: both commands exit 0.

- [ ] **Step 5: Record known Rust clippy blocker**

Run:

```bash
cd rust && cargo clippy --workspace --all-targets -- -D warnings
```

Expected for this closeout: currently FAILS on pre-existing workspace-wide lint debt outside the AG UI WebAgent task (`runtime`, `commands`, and `api`). Do not broaden Task 10 into a repository-wide clippy cleanup unless the user explicitly asks for that separate task.

Record the failed clippy categories in the final handoff and in the implementation status note.

Observed closeout result on 2026-05-16:

- `cd webagent-ui && npm test -- --run`: PASS, 27 files / 140 tests. `assistant-ui` emits expected server-render `useLayoutEffect` warnings in render-to-string tests.
- `cd webagent-ui && npm run build`: PASS. Vite reports the expected chunk-size warning for the main bundle.
- `cd rust && cargo fmt`: PASS.
- `cd rust && cargo test --workspace`: PASS.
- `cd rust && cargo clippy --workspace --all-targets -- -D warnings`: FAILS on existing workspace lint debt:
  - `runtime/tests/integration_tests.rs`: `duration_suboptimal_units`
  - `commands/src/lib.rs`: `manual_split_once`, `unnecessary_wraps`, `unnecessary_map_or`
  - `api/src/providers/anthropic.rs`, `api/src/providers/openai_compat.rs`, `api/src/providers/mod.rs`: `map_unwrap_or`, `collapsible_match`, `large_enum_variant`, `needless_pass_by_value`, `too_many_lines`, `doc_markdown`, `match_same_arms`, `single_match_else`

### Task 10B: Screen Startup And Local Acceptance

**Files:**
- Modify: `docs/web-agent-prototype-migration-plan.md`

- [ ] **Step 1: Start backend and frontend with screen**

Run from `.worktrees/webagent-route1`:

```bash
mkdir -p .logs
screen -S clawd-webagent -X quit || true
screen -S webagent-preview -X quit || true
screen -dmS clawd-webagent bash -lc 'CLAWD_DATA_DIR=/Users/fuyb/IdeaProjects/claw-code/.worktrees/webagent-route1/.clawd-dev CLAWD_WEB_DIST_DIR=/Users/fuyb/IdeaProjects/claw-code/.worktrees/webagent-route1/webagent-ui/dist CLAWD_PLATFORM_ADMIN_USERS=admin,local-dev,admin-check ./rust/target/debug/clawd > .logs/clawd.log 2>&1'
screen -dmS webagent-preview bash -lc 'cd webagent-ui && npm run preview -- --host 127.0.0.1 --port 4173 > ../.logs/webagent-ui-preview.log 2>&1'
```

- [ ] **Step 2: Verify local services**

Run:

```bash
lsof -iTCP:3210 -sTCP:LISTEN -n -P
lsof -iTCP:4173 -sTCP:LISTEN -n -P
curl http://127.0.0.1:3210/healthz
curl -I http://127.0.0.1:4173/
```

Expected:

- port `3210` listening
- port `4173` listening
- health endpoint returns success
- frontend returns HTTP 200

- [ ] **Step 3: Capture startup details**

Record in the final handoff:

- backend URL: `http://127.0.0.1:3210`
- frontend URL: `http://127.0.0.1:4173`
- backend log: `.logs/clawd.log`
- frontend log: `.logs/webagent-ui-preview.log`
- database: `.clawd-dev/clawd.db`
- screen sessions: `clawd-webagent`, `webagent-preview`

### Task 10C: Documentation Status And Commit

**Files:**
- Modify: `docs/web-agent-prototype-migration-plan.md`
- Modify: `docs/superpowers/plans/2026-05-15-ag-ui-webagent-rebuild.md`
- Modify: `webagent-ui/src/components/inspiration/ChatPanel.test.tsx`
- Modify: `webagent-ui/src/components/inspiration/ChatPanel.interventions.test.tsx`

- [ ] **Step 1: Update migration plan status**

Add a completion note under `新增边界修正：AG UI 与 WebAgent 完全重构` in `docs/web-agent-prototype-migration-plan.md`:

```markdown
实施状态：已完成 AG UI 原生端点、AgentTurn 数据库存储、前端 AgentTurnView 主渲染、WebAgent 工具白名单和 `workspace_root` 主链路移除。当前验收地址按运行环境约束使用 screen 启动。

验证状态：`cargo test --workspace`、`npm test -- --run`、`npm run build` 已通过；`cargo clippy --workspace --all-targets -- -D warnings` 当前仍被仓库级既有 lint 债阻塞，范围在 `runtime`、`commands`、`api`，不属于本轮 AG UI WebAgent 主线改造。
```

- [ ] **Step 2: Run final diff check**

Run:

```bash
git diff --check -- docs/superpowers/plans/2026-05-15-ag-ui-webagent-rebuild.md docs/web-agent-prototype-migration-plan.md webagent-ui/src/components/inspiration/ChatPanel.test.tsx webagent-ui/src/components/inspiration/ChatPanel.interventions.test.tsx
```

- [ ] **Step 3: Commit**

```bash
git add docs/superpowers/plans/2026-05-15-ag-ui-webagent-rebuild.md docs/web-agent-prototype-migration-plan.md webagent-ui/src/components/inspiration/ChatPanel.test.tsx webagent-ui/src/components/inspiration/ChatPanel.interventions.test.tsx
git commit -m "docs: record ag ui webagent rebuild status"
```

---

## Self-Review

- Spec coverage: This plan covers native AG UI endpoint, AgentTurn DB persistence, integrated tool/retrieval/expert rendering, citation replacement, no JSONL migration, no `workspace_root` in the WebAgent route, tool whitelist tightening, queue/interrupt behavior, and final screen-based startup verification.
- Placeholder scan: The plan contains no `TBD`, `TODO`, or unspecified implementation slots. Each task has concrete files, code shape, commands, and expected outcomes.
- Type consistency: Backend uses `AgentConversationRecord`, `AgentTurnRecord`, `AgUiEvent`, and store methods consistently. Frontend uses `AgentTurnRecord`, `AgentTurnView`, `AgentActivityTimeline`, `AgentCitationList`, and `AgentDebugDetails` consistently.
