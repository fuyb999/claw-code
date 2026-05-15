use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::{SystemTime, UNIX_EPOCH};

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
    ActivityDelta { delta: Value, timestamp: u64 },
    #[serde(rename = "STATE_SNAPSHOT")]
    StateSnapshot { snapshot: Value, timestamp: u64 },
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
            timestamp: now_millis(),
        }
    }
}

pub fn encode_ag_ui_sse_frame(event: &AgUiEvent) -> Result<String, serde_json::Error> {
    let payload = serde_json::to_string(event)?;
    Ok(format!("data: {payload}\n\n"))
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64
}

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
        assert!(raw.contains("\"status\":\"succeeded\""));
        assert!(raw.contains("\"kind\":\"retrieval\""));
        assert!(raw.contains("\"expert_name\":\"Howard-Wang\""));

        let parsed: AgentTurnRecord = serde_json::from_str(&raw).expect("deserialize turn");

        assert_eq!(parsed.id, "turn-1");
        assert_eq!(parsed.steps[0].kind, AgentTurnStepKind::Retrieval);
        assert_eq!(parsed.citations[0].number, 1);
        assert_eq!(parsed.expert_results[0].expert_name, "Howard-Wang");
    }

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
}
