use std::collections::{BTreeSet, HashMap};
use std::fs;
use std::io::Write;
use std::net::SocketAddr;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex, RwLock};
use std::time::{SystemTime, UNIX_EPOCH};

pub mod agent_turns;

use crate::agent_turns::{
    encode_ag_ui_sse_frame, AgUiEvent, AgentCitation, AgentConversationRecord,
    AgentConversationStatus, AgentToolUpdates, AgentTurnDebugEvent, AgentTurnError,
    AgentTurnRecord, AgentTurnStatus, AgentTurnStep, AgentTurnStepKind, AgentTurnStepStatus,
};
use api::{
    model_family_identity_for, AnthropicClient, ContentBlockDelta, InputContentBlock, InputMessage,
    MessageRequest, MessageResponse, OpenAiCompatClient, OpenAiCompatConfig, OutputContentBlock,
    ProviderClient, ProviderKind, StreamEvent as ApiStreamEvent, ToolChoice,
    ToolResultContentBlock,
};
use async_stream::stream;
use axum::extract::{Multipart, Path as AxumPath, Query, State};
use axum::http::{header, HeaderMap, HeaderName, Method, StatusCode};
use axum::response::sse::{Event, KeepAlive, Sse};
use axum::response::{Html, IntoResponse, Response};
use axum::routing::{delete, get, post};
use axum::{Json, Router};
use base64::Engine;
use rand::rngs::OsRng;
use rand::RngCore;
use runtime::{
    AssistantEvent, ContentBlock, ConversationMessage, ConversationRuntime, HookAbortSignal,
    MessageRole, PermissionMode, PermissionPolicy, RuntimeError, Session, SessionStore, ToolError,
    ToolExecutor,
};
use rusqlite::{Connection as SqliteConnection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use tokio_postgres::{Client as PostgresClient, NoTls, Transaction as PostgresTransaction};
use tools::pdf_extract;
use tools::{GlobalToolRegistry, RuntimeToolDefinition};
use tower_http::cors::{Any, CorsLayer};
static ID_COUNTER: AtomicU64 = AtomicU64::new(0);
const SAFE_BUILTIN_TOOLS: &[&str] = &["read_file", "glob_search", "grep_search"];
const CURRENT_DATABASE_SCHEMA_VERSION: u32 = 9;
const MAX_VISIBLE_AUDIT_RECORDS: usize = 200;
const MAX_AUDIT_TEXT_CHARS: usize = 2_000;

fn main() -> Result<(), Box<dyn std::error::Error>> {
    let config = Arc::new(AppConfig::from_env()?);
    fs::create_dir_all(config.thread_records_dir())?;
    let state = Arc::new(AppState::new(config.clone())?);

    let runtime = tokio::runtime::Builder::new_multi_thread()
        .enable_all()
        .build()?;
    runtime.block_on(async move {
        let cors = CorsLayer::new()
            .allow_origin(Any)
            .allow_methods([Method::GET, Method::POST, Method::PATCH, Method::DELETE])
            .allow_headers([
                header::AUTHORIZATION,
                header::CONTENT_TYPE,
                HeaderName::from_static("x-clawd-api-key"),
                HeaderName::from_static("x-clawd-user-id"),
                HeaderName::from_static("x-user-id"),
            ]);

        let app = Router::new()
            .route("/", get(serve_web_index))
            .route("/index.html", get(serve_web_index))
            .route("/assets/*path", get(serve_web_asset))
            .route("/healthz", get(healthz))
            .route("/v1/config", get(get_config))
            .route("/v1/auth/session", get(get_auth_session))
            .route("/v1/api-keys", get(list_api_keys).post(create_api_key))
            .route("/v1/api-keys/:id/disable", post(disable_api_key))
            .route("/v1/projects", get(list_projects).post(create_project))
            .route("/v1/projects/:id", get(get_project).patch(update_project))
            .route(
                "/v1/knowledge-bases",
                get(list_knowledge_bases).post(create_knowledge_base),
            )
            .route("/v1/knowledge-bases/:id", delete(delete_knowledge_base))
            .route(
                "/v1/data-sources",
                get(list_data_sources).post(create_data_source),
            )
            .route("/v1/data-sources/test", post(test_data_source))
            .route("/v1/data-sources/:id/test", post(test_saved_data_source))
            .route(
                "/v1/data-sources/:id",
                get(get_data_source)
                    .patch(update_data_source)
                    .delete(delete_data_source),
            )
            .route("/v1/data-sources/:id/upload", post(upload_data_source_file))
            .route(
                "/v1/data-sources/:id/files/:file_id",
                delete(delete_data_source_file),
            )
            .route(
                "/v1/acp-connectors",
                get(list_acp_connectors).post(create_acp_connector),
            )
            .route("/v1/acp-connectors/test", post(test_acp_connector))
            .route(
                "/v1/acp-connectors/:id",
                get(get_acp_connector)
                    .patch(update_acp_connector)
                    .delete(delete_acp_connector),
            )
            .route(
                "/v1/acp-connectors/:id/discover",
                post(discover_saved_acp_connector),
            )
            .route("/v1/skills", get(list_skills).post(upsert_skill))
            .route("/v1/skills/:name", get(get_skill).delete(delete_skill))
            .route(
                "/v1/agent/conversations",
                get(list_agent_conversations).post(create_agent_conversation),
            )
            .route(
                "/v1/agent/conversations/:id",
                delete(delete_agent_conversation),
            )
            .route("/v1/agent/conversations/:id/turns", get(list_agent_turns))
            .route("/v1/agent/ag-ui", post(post_ag_ui_run))
            .route(
                "/v1/agent/conversations/:id/interrupt",
                post(interrupt_agent_conversation),
            )
            .route("/v1/threads", get(list_threads).post(create_thread))
            .route("/v1/threads/:id", get(get_thread).delete(delete_thread))
            .route("/v1/threads/:id/events", get(thread_events))
            .route(
                "/v1/threads/:id/expert-panel-runs",
                post(create_expert_panel_run),
            )
            .route(
                "/v1/threads/:id/expert-panel-runs/:run_id",
                get(get_expert_panel_run),
            )
            .route(
                "/v1/threads/:id/expert-panel-runs/:run_id/events",
                get(expert_panel_run_events),
            )
            .route("/v1/threads/:id/commands", post(post_thread_command))
            .layer(cors);

        let app = app.with_state(state.clone());

        let addr: SocketAddr = config.bind_addr.parse()?;
        let listener = tokio::net::TcpListener::bind(addr).await?;

        println!("clawd listening on http://{}", addr);
        println!(
            "clawd web dist dir: {}",
            state
                .config
                .web_dist_dir
                .as_ref()
                .map(|path| path.display().to_string())
                .unwrap_or_else(|| "<disabled>".to_string())
        );
        axum::serve(listener, app).await?;
        Ok::<(), Box<dyn std::error::Error>>(())
    })?;
    Ok(())
}

#[derive(Clone)]
struct AppConfig {
    bind_addr: String,
    data_dir: PathBuf,
    web_dist_dir: Option<PathBuf>,
    service_skills_dir: Option<PathBuf>,
    database_url: String,
    default_model: String,
    default_permission_mode: PermissionMode,
    run_timeout_secs: Option<u64>,
    max_threads_per_user: Option<usize>,
    max_threads_per_tenant: Option<usize>,
    max_concurrent_runs_global: Option<usize>,
    max_concurrent_runs_per_tenant: Option<usize>,
    max_concurrent_runs_per_user: Option<usize>,
    max_mutation_requests_per_minute_global: Option<usize>,
    max_mutation_requests_per_minute_per_tenant: Option<usize>,
    max_mutation_requests_per_minute_per_user: Option<usize>,
    dev_user_header_auth_enabled: bool,
    platform_admin_users: BTreeSet<String>,
    bootstrap_api_keys: Vec<SeedApiKey>,
    allowed_roots: Vec<PathBuf>,
    es: EsConfig,
}

impl AppConfig {
    fn from_env() -> Result<Self, Box<dyn std::error::Error>> {
        let cwd = std::env::current_dir()?;
        let bind_addr =
            std::env::var("CLAWD_BIND_ADDR").unwrap_or_else(|_| "127.0.0.1:3210".to_string());
        let data_dir = std::env::var("CLAWD_DATA_DIR")
            .map(PathBuf::from)
            .unwrap_or_else(|_| cwd.join(".clawd"));
        let web_dist_dir = std::env::var("CLAWD_WEB_DIST_DIR")
            .ok()
            .map(PathBuf::from)
            .filter(|path| path.is_dir());
        let service_skills_dir = std::env::var("CLAWD_SERVICE_SKILLS_DIR")
            .ok()
            .map(PathBuf::from)
            .filter(|path| path.is_dir())
            .or_else(|| {
                let candidate = cwd.join(".claw").join("skills");
                candidate.is_dir().then_some(candidate)
            });
        let database_url =
            std::env::var("CLAWD_DATABASE_URL").unwrap_or_else(|_| default_database_url(&data_dir));
        let default_model = default_model_from_env();
        let default_permission_mode = std::env::var("CLAWD_PERMISSION_MODE")
            .ok()
            .map(|value| parse_permission_mode(&value))
            .transpose()?
            .unwrap_or(PermissionMode::ReadOnly);
        let run_timeout_secs = match std::env::var("CLAWD_RUN_TIMEOUT_SECS").ok() {
            Some(value) => parse_run_timeout_secs(&value)?,
            None => Some(120),
        };
        let max_threads_per_user = match std::env::var("CLAWD_MAX_THREADS_PER_USER").ok() {
            Some(value) => parse_limit_env("CLAWD_MAX_THREADS_PER_USER", &value)?,
            None => Some(200),
        };
        let max_threads_per_tenant = match std::env::var("CLAWD_MAX_THREADS_PER_TENANT").ok() {
            Some(value) => parse_limit_env("CLAWD_MAX_THREADS_PER_TENANT", &value)?,
            None => Some(2_000),
        };
        let max_concurrent_runs_global =
            match std::env::var("CLAWD_MAX_CONCURRENT_RUNS_GLOBAL").ok() {
                Some(value) => parse_limit_env("CLAWD_MAX_CONCURRENT_RUNS_GLOBAL", &value)?,
                None => Some(16),
            };
        let max_concurrent_runs_per_tenant =
            match std::env::var("CLAWD_MAX_CONCURRENT_RUNS_PER_TENANT").ok() {
                Some(value) => parse_limit_env("CLAWD_MAX_CONCURRENT_RUNS_PER_TENANT", &value)?,
                None => Some(8),
            };
        let max_concurrent_runs_per_user =
            match std::env::var("CLAWD_MAX_CONCURRENT_RUNS_PER_USER").ok() {
                Some(value) => parse_limit_env("CLAWD_MAX_CONCURRENT_RUNS_PER_USER", &value)?,
                None => Some(2),
            };
        let max_mutation_requests_per_minute_global =
            match std::env::var("CLAWD_MAX_MUTATION_REQUESTS_PER_MINUTE_GLOBAL").ok() {
                Some(value) => {
                    parse_limit_env("CLAWD_MAX_MUTATION_REQUESTS_PER_MINUTE_GLOBAL", &value)?
                }
                None => Some(240),
            };
        let max_mutation_requests_per_minute_per_tenant =
            match std::env::var("CLAWD_MAX_MUTATION_REQUESTS_PER_MINUTE_PER_TENANT").ok() {
                Some(value) => {
                    parse_limit_env("CLAWD_MAX_MUTATION_REQUESTS_PER_MINUTE_PER_TENANT", &value)?
                }
                None => Some(120),
            };
        let max_mutation_requests_per_minute_per_user =
            match std::env::var("CLAWD_MAX_MUTATION_REQUESTS_PER_MINUTE_PER_USER").ok() {
                Some(value) => {
                    parse_limit_env("CLAWD_MAX_MUTATION_REQUESTS_PER_MINUTE_PER_USER", &value)?
                }
                None => Some(30),
            };
        let dev_user_header_auth_enabled = std::env::var("CLAWD_ENABLE_DEV_USER_HEADER_AUTH")
            .ok()
            .map(|value| parse_bool_env("CLAWD_ENABLE_DEV_USER_HEADER_AUTH", &value))
            .transpose()?
            .unwrap_or(true);
        let platform_admin_users = std::env::var("CLAWD_PLATFORM_ADMIN_USERS")
            .ok()
            .map(|value| parse_identifier_csv(&value))
            .transpose()?
            .unwrap_or_default();
        let platform_admin_users = if platform_admin_users.is_empty() {
            BTreeSet::from(["admin".to_string()])
        } else {
            platform_admin_users
        };
        let bootstrap_api_keys = std::env::var("CLAWD_BOOTSTRAP_API_KEYS")
            .ok()
            .map(|value| parse_bootstrap_api_keys(&value))
            .transpose()?
            .unwrap_or_default();
        let allowed_roots = std::env::var("CLAWD_ALLOWED_ROOTS")
            .ok()
            .map(|value| {
                value
                    .split(',')
                    .map(str::trim)
                    .filter(|item| !item.is_empty())
                    .map(PathBuf::from)
                    .collect::<Vec<_>>()
            })
            .filter(|roots| !roots.is_empty())
            .unwrap_or_else(|| discover_allowed_roots(&cwd));

        Ok(Self {
            bind_addr,
            data_dir,
            web_dist_dir,
            service_skills_dir,
            database_url,
            default_model,
            default_permission_mode,
            run_timeout_secs,
            max_threads_per_user,
            max_threads_per_tenant,
            max_concurrent_runs_global,
            max_concurrent_runs_per_tenant,
            max_concurrent_runs_per_user,
            max_mutation_requests_per_minute_global,
            max_mutation_requests_per_minute_per_tenant,
            max_mutation_requests_per_minute_per_user,
            dev_user_header_auth_enabled,
            platform_admin_users,
            bootstrap_api_keys,
            allowed_roots,
            es: EsConfig::from_env(),
        })
    }

    fn thread_records_dir(&self) -> PathBuf {
        self.data_dir.join("threads")
    }

    fn tenant_skills_dir(&self, tenant_id: &str) -> PathBuf {
        self.data_dir.join("tenants").join(tenant_id).join("skills")
    }

    fn managed_workspaces_dir(&self) -> PathBuf {
        self.data_dir.join("managed-workspaces")
    }

    fn managed_workspace_root(&self, tenant_id: Option<&str>, owner_id: &str) -> PathBuf {
        let tenant_segment = tenant_id
            .map(safe_storage_segment)
            .unwrap_or_else(|| "personal".to_string());
        self.managed_workspaces_dir()
            .join(tenant_segment)
            .join(safe_storage_segment(owner_id))
            .join("chat")
    }

    fn database_backend(&self) -> &'static str {
        if self.database_url.starts_with("postgres://")
            || self.database_url.starts_with("postgresql://")
        {
            "postgres"
        } else {
            "sqlite"
        }
    }
}

#[derive(Debug, Clone)]
struct SeedApiKey {
    tenant_id: String,
    user_id: String,
    raw_key: String,
    display_name: Option<String>,
}

fn default_database_url(data_dir: &Path) -> String {
    format!("sqlite://{}", data_dir.join("clawd.db").display())
}

fn parse_identifier_csv(raw: &str) -> Result<BTreeSet<String>, Box<dyn std::error::Error>> {
    let mut values = BTreeSet::new();
    for item in raw
        .split(',')
        .map(str::trim)
        .filter(|item| !item.is_empty())
    {
        values.insert(parse_user_id(item)?);
    }
    Ok(values)
}

fn is_platform_admin(config: &AppConfig, auth: &AuthContext) -> bool {
    config.platform_admin_users.contains(auth.user_id.as_str())
}

fn data_source_storage_dir(config: &AppConfig, source: &DataSourceRecord) -> PathBuf {
    let tenant_segment = source
        .tenant_id
        .as_deref()
        .map(safe_storage_segment)
        .unwrap_or_else(|| "personal".to_string());
    let owner_segment = source
        .owner_id
        .as_deref()
        .map(safe_storage_segment)
        .unwrap_or_else(|| "shared".to_string());
    config
        .data_dir
        .join("data-sources")
        .join(tenant_segment)
        .join(owner_segment)
        .join(safe_storage_segment(&source.id))
}

fn persist_uploaded_document(
    config: &AppConfig,
    source: &DataSourceRecord,
    file_name: &str,
    mime_type: Option<String>,
    bytes: &[u8],
) -> Result<DocumentFileRecord, AppError> {
    let directory = data_source_storage_dir(config, source);
    fs::create_dir_all(&directory).map_err(|error| {
        AppError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("failed to create upload directory: {error}"),
        )
    })?;
    let document_id = generate_id("doc");
    let sanitized_name = sanitize_upload_file_name(file_name);
    let stored_name = format!("{document_id}-{sanitized_name}");
    let stored_path = directory.join(&stored_name);
    let mut file = fs::File::create(&stored_path).map_err(|error| {
        AppError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("failed to create uploaded file: {error}"),
        )
    })?;
    file.write_all(bytes).map_err(|error| {
        AppError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("failed to write uploaded file: {error}"),
        )
    })?;
    let extracted_text = extract_document_text(&stored_path, mime_type.as_deref(), bytes);
    Ok(DocumentFileRecord {
        id: document_id,
        file_name: file_name.to_string(),
        stored_name: stored_name.clone(),
        relative_path: stored_path.display().to_string(),
        mime_type,
        size_bytes: bytes.len() as u64,
        extracted_text,
        uploaded_at_ms: now_millis(),
    })
}

fn sanitize_upload_file_name(file_name: &str) -> String {
    let mut output = String::with_capacity(file_name.len());
    for ch in file_name.chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '.' | '-' | '_') {
            output.push(ch);
        } else {
            output.push('-');
        }
    }
    let cleaned = output.trim_matches('-').to_string();
    if cleaned.is_empty() {
        "document".to_string()
    } else {
        cleaned
    }
}

fn remove_uploaded_document_file(
    config: &AppConfig,
    source: &DataSourceRecord,
    file: &DocumentFileRecord,
) {
    let stored_path = data_source_storage_dir(config, source).join(&file.stored_name);
    match fs::remove_file(&stored_path) {
        Ok(()) => {}
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            eprintln!(
                "failed to remove uploaded file for data source {} file {}: {}",
                source.id, file.id, error
            );
        }
    }
}

fn extract_document_text(path: &Path, mime_type: Option<&str>, bytes: &[u8]) -> String {
    let file_name = path
        .file_name()
        .and_then(|value| value.to_str())
        .unwrap_or_default()
        .to_ascii_lowercase();
    let mime = mime_type.unwrap_or_default().to_ascii_lowercase();
    if file_name.ends_with(".pdf") || mime.contains("pdf") {
        return pdf_extract::extract_text(path).unwrap_or_default();
    }
    if file_name.ends_with(".md")
        || file_name.ends_with(".txt")
        || file_name.ends_with(".json")
        || file_name.ends_with(".csv")
        || file_name.ends_with(".yaml")
        || file_name.ends_with(".yml")
        || mime.starts_with("text/")
        || mime.contains("json")
    {
        return String::from_utf8_lossy(bytes).to_string();
    }
    String::from_utf8_lossy(bytes).to_string()
}

fn safe_storage_segment(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return "default".to_string();
    }

    let mut normalized = String::with_capacity(trimmed.len());
    for ch in trimmed.chars() {
        if ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_') {
            normalized.push(ch.to_ascii_lowercase());
        } else {
            normalized.push('-');
        }
    }

    let collapsed = normalized
        .split('-')
        .filter(|segment| !segment.is_empty())
        .collect::<Vec<_>>()
        .join("-");
    if collapsed.is_empty() {
        let digest = Sha256::digest(trimmed.as_bytes());
        format!("id-{}", &encode_hex(&digest)[..12])
    } else {
        collapsed
    }
}

fn read_env_non_empty(name: &str) -> Option<String> {
    std::env::var(name)
        .ok()
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn default_model_from_env() -> String {
    if let Some(model) = read_env_non_empty("CLAWD_DEFAULT_MODEL") {
        return model;
    }

    if read_env_non_empty("OPENAI_BASE_URL").is_some() {
        return read_env_non_empty("OPENAI_MODEL")
            .unwrap_or_else(|| "openai/gpt-4.1-mini".to_string());
    }
    if read_env_non_empty("DASHSCOPE_BASE_URL").is_some() {
        return read_env_non_empty("DASHSCOPE_MODEL").unwrap_or_else(|| "qwen-plus".to_string());
    }
    if read_env_non_empty("XAI_BASE_URL").is_some() {
        return read_env_non_empty("XAI_MODEL").unwrap_or_else(|| "grok-3".to_string());
    }
    if let Some(model) = read_env_non_empty("ANTHROPIC_MODEL") {
        return model;
    }
    if let Some(model) = read_env_non_empty("OPENAI_MODEL") {
        return model;
    }
    if let Some(model) = read_env_non_empty("DASHSCOPE_MODEL") {
        return model;
    }
    if let Some(model) = read_env_non_empty("XAI_MODEL") {
        return model;
    }
    if read_env_non_empty("OPENAI_API_KEY").is_some() {
        return "openai/gpt-4.1-mini".to_string();
    }
    if read_env_non_empty("DASHSCOPE_API_KEY").is_some() {
        return "qwen-plus".to_string();
    }
    if read_env_non_empty("XAI_API_KEY").is_some() {
        return "grok-3".to_string();
    }

    "claude-sonnet-4-6".to_string()
}

fn sqlite_path_from_url(value: &str) -> Result<PathBuf, Box<dyn std::error::Error>> {
    if value == "sqlite::memory:" {
        return Ok(PathBuf::from(":memory:"));
    }

    let raw = value
        .strip_prefix("sqlite://")
        .or_else(|| value.strip_prefix("sqlite:"))
        .unwrap_or(value);
    let path = raw.strip_prefix("//").unwrap_or(raw);
    if path.is_empty() {
        return Err("sqlite database path must not be empty".into());
    }
    Ok(PathBuf::from(path))
}

#[derive(Clone, Default)]
struct EsConfig {
    base_url: Option<String>,
    api_key: Option<String>,
    username: Option<String>,
    password: Option<String>,
    default_index: Option<String>,
}

impl EsConfig {
    fn from_env() -> Self {
        Self {
            base_url: std::env::var("CLAWD_ES_BASE_URL").ok(),
            api_key: std::env::var("CLAWD_ES_API_KEY").ok(),
            username: std::env::var("CLAWD_ES_USERNAME").ok(),
            password: std::env::var("CLAWD_ES_PASSWORD").ok(),
            default_index: std::env::var("CLAWD_ES_DEFAULT_INDEX").ok(),
        }
    }
}

struct AppState {
    config: Arc<AppConfig>,
    store: Arc<ThreadStore>,
    admission: Mutex<()>,
    mutation_rate_limiter: Mutex<MutationRateLimiter>,
    threads: RwLock<HashMap<String, Arc<ManagedThread>>>,
}

impl AppState {
    fn new(config: Arc<AppConfig>) -> Result<Self, Box<dyn std::error::Error>> {
        let store = Arc::new(ThreadStore::open(&config)?);
        seed_bootstrap_api_keys(&store, &config.bootstrap_api_keys)?;
        promote_legacy_dev_platform_records(&store, &config)?;
        import_legacy_thread_records(&store, &config)?;
        let mut threads = HashMap::new();
        for managed in load_threads(&store)? {
            threads.insert(managed.id().to_string(), Arc::new(managed));
        }
        Ok(Self {
            config,
            store,
            admission: Mutex::new(()),
            mutation_rate_limiter: Mutex::new(MutationRateLimiter::default()),
            threads: RwLock::new(threads),
        })
    }

    fn get_thread(&self, id: &str) -> Option<Arc<ManagedThread>> {
        self.threads
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .get(id)
            .cloned()
    }

    fn insert_thread(&self, thread: Arc<ManagedThread>) {
        self.threads
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .insert(thread.id().to_string(), thread);
    }
}

fn promote_legacy_dev_platform_records(
    store: &ThreadStore,
    config: &AppConfig,
) -> Result<(), Box<dyn std::error::Error>> {
    if !config.dev_user_header_auth_enabled {
        return Ok(());
    }

    let projects = store.load_projects()?;
    for mut record in projects {
        if !project_should_promote_to_platform(config, &record) {
            continue;
        }
        record.owner_id = None;
        record.updated_at_ms = now_millis();
        store.upsert_project(&record)?;
    }

    let data_sources = store.load_data_sources()?;
    let mut promoted_knowledge_base_ids = BTreeSet::new();
    for mut record in data_sources {
        if !data_source_should_promote_to_platform(config, &record) {
            continue;
        }
        record.owner_id = None;
        record.updated_at_ms = now_millis();
        promoted_knowledge_base_ids.insert(record.knowledge_base_id.clone());
        store.upsert_data_source(&record)?;
    }

    let knowledge_bases = store.load_knowledge_bases()?;
    for mut record in knowledge_bases {
        if !knowledge_base_should_promote_to_platform(
            config,
            &record,
            promoted_knowledge_base_ids.contains(&record.id),
        ) {
            continue;
        }
        record.owner_id = None;
        record.updated_at_ms = now_millis();
        store.upsert_knowledge_base(&record)?;
    }

    let acp_connectors = store.load_acp_connectors()?;
    for mut record in acp_connectors {
        if !acp_connector_should_promote_to_platform(config, &record) {
            continue;
        }
        record.owner_id = None;
        record.updated_at_ms = now_millis();
        store.upsert_acp_connector(&record)?;
    }

    Ok(())
}

fn legacy_dev_owner_id_is_platform_candidate(config: &AppConfig, owner_id: &str) -> bool {
    config.platform_admin_users.contains(owner_id)
        || matches!(owner_id, "1" | "admin" | "local-dev" | "admin-check")
        || owner_id.starts_with("browser-")
}

fn project_should_promote_to_platform(config: &AppConfig, record: &ProjectRecord) -> bool {
    record
        .owner_id
        .as_deref()
        .is_some_and(|owner_id| legacy_dev_owner_id_is_platform_candidate(config, owner_id))
}

fn data_source_should_promote_to_platform(config: &AppConfig, record: &DataSourceRecord) -> bool {
    record.kind != DataSourceKind::Upload
        && record
            .owner_id
            .as_deref()
            .is_some_and(|owner_id| legacy_dev_owner_id_is_platform_candidate(config, owner_id))
}

fn knowledge_base_should_promote_to_platform(
    config: &AppConfig,
    record: &KnowledgeBaseRecord,
    has_promoted_source: bool,
) -> bool {
    has_promoted_source
        && record
            .owner_id
            .as_deref()
            .is_some_and(|owner_id| legacy_dev_owner_id_is_platform_candidate(config, owner_id))
}

fn acp_connector_should_promote_to_platform(
    config: &AppConfig,
    record: &AcpConnectorRecord,
) -> bool {
    record
        .owner_id
        .as_deref()
        .is_some_and(|owner_id| legacy_dev_owner_id_is_platform_candidate(config, owner_id))
}

#[derive(Debug, Clone)]
struct ApiKeyRecord {
    id: String,
    tenant_id: String,
    user_id: String,
    display_name: Option<String>,
    key_prefix: String,
    key_hash: String,
    created_at_ms: u64,
    updated_at_ms: u64,
    last_used_at_ms: Option<u64>,
    disabled_at_ms: Option<u64>,
}

#[derive(Debug, Clone)]
struct AuthContext {
    auth_mode: AuthMode,
    tenant_id: Option<String>,
    user_id: String,
    api_key_id: Option<String>,
    api_key_prefix: Option<String>,
    display_name: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize)]
#[serde(rename_all = "snake_case")]
enum AuthMode {
    ApiKey,
    DevUserHeader,
}

#[derive(Debug)]
struct StringError(String);

impl std::fmt::Display for StringError {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str(&self.0)
    }
}

impl std::error::Error for StringError {}

fn boxed_string_error(message: impl Into<String>) -> Box<dyn std::error::Error> {
    Box::new(StringError(message.into()))
}

#[derive(Clone)]
struct PostgresWorker {
    sender: mpsc::Sender<PostgresRequest>,
}

enum PostgresRequest {
    UpsertRecord {
        record: ThreadRecord,
        reply: mpsc::Sender<Result<(), String>>,
    },
    DeleteRecord {
        id: String,
        reply: mpsc::Sender<Result<bool, String>>,
    },
    UpsertProject {
        record: ProjectRecord,
        reply: mpsc::Sender<Result<(), String>>,
    },
    UpsertKnowledgeBase {
        record: KnowledgeBaseRecord,
        reply: mpsc::Sender<Result<(), String>>,
    },
    DeleteKnowledgeBase {
        id: String,
        reply: mpsc::Sender<Result<bool, String>>,
    },
    UpsertDataSource {
        record: DataSourceRecord,
        reply: mpsc::Sender<Result<(), String>>,
    },
    DeleteDataSource {
        id: String,
        reply: mpsc::Sender<Result<bool, String>>,
    },
    UpsertAcpConnector {
        record: AcpConnectorRecord,
        reply: mpsc::Sender<Result<(), String>>,
    },
    DeleteAcpConnector {
        id: String,
        reply: mpsc::Sender<Result<bool, String>>,
    },
    UpsertApiKey {
        record: ApiKeyRecord,
        reply: mpsc::Sender<Result<(), String>>,
    },
    AuthenticateApiKey {
        key_hash: String,
        now_ms: u64,
        reply: mpsc::Sender<Result<Option<ApiKeyRecord>, String>>,
    },
    ListApiKeys {
        tenant_id: String,
        user_id: String,
        reply: mpsc::Sender<Result<Vec<ApiKeyRecord>, String>>,
    },
    DisableApiKey {
        id: String,
        tenant_id: String,
        user_id: String,
        now_ms: u64,
        reply: mpsc::Sender<Result<bool, String>>,
    },
    #[allow(dead_code)]
    UpsertAgentConversation {
        record: AgentConversationRecord,
        reply: mpsc::Sender<Result<(), String>>,
    },
    #[allow(dead_code)]
    UpsertAgentTurn {
        record: AgentTurnRecord,
        reply: mpsc::Sender<Result<(), String>>,
    },
    #[allow(dead_code)]
    ListAgentConversations {
        tenant_id: Option<String>,
        owner_id: String,
        reply: mpsc::Sender<Result<Vec<AgentConversationRecord>, String>>,
    },
    #[allow(dead_code)]
    ListAgentTurns {
        conversation_id: String,
        tenant_id: Option<String>,
        owner_id: String,
        reply: mpsc::Sender<Result<Vec<AgentTurnRecord>, String>>,
    },
    #[allow(dead_code)]
    DeleteAgentConversation {
        id: String,
        tenant_id: Option<String>,
        owner_id: String,
        reply: mpsc::Sender<Result<bool, String>>,
    },
    AppendAuditRecord {
        thread_id: String,
        record: AuditRecord,
        reply: mpsc::Sender<Result<(), String>>,
    },
    LoadRecords {
        reply: mpsc::Sender<Result<Vec<ThreadRecord>, String>>,
    },
    LoadProjects {
        reply: mpsc::Sender<Result<Vec<ProjectRecord>, String>>,
    },
    LoadKnowledgeBases {
        reply: mpsc::Sender<Result<Vec<KnowledgeBaseRecord>, String>>,
    },
    LoadDataSources {
        reply: mpsc::Sender<Result<Vec<DataSourceRecord>, String>>,
    },
    LoadAcpConnectors {
        reply: mpsc::Sender<Result<Vec<AcpConnectorRecord>, String>>,
    },
    GetProject {
        id: String,
        reply: mpsc::Sender<Result<Option<ProjectRecord>, String>>,
    },
    GetKnowledgeBase {
        id: String,
        reply: mpsc::Sender<Result<Option<KnowledgeBaseRecord>, String>>,
    },
    GetAcpConnector {
        id: String,
        reply: mpsc::Sender<Result<Option<AcpConnectorRecord>, String>>,
    },
    LoadAuditRecords {
        thread_id: String,
        limit: usize,
        reply: mpsc::Sender<Result<Vec<AuditRecord>, String>>,
    },
    LoadLatestExpertPanelRunState {
        thread_id: String,
        run_id: String,
        reply: mpsc::Sender<Result<Option<ExpertPanelRunResponse>, String>>,
    },
    LoadMemoryNotesForScope {
        record: ThreadRecord,
        scope: MemorySearchScope,
        reply: mpsc::Sender<Result<Vec<MemoryNote>, String>>,
    },
}

impl PostgresWorker {
    fn start(database_url: &str) -> Result<(Self, u32), Box<dyn std::error::Error>> {
        let (sender, receiver) = mpsc::channel::<PostgresRequest>();
        let (ready_tx, ready_rx) = mpsc::channel::<Result<u32, String>>();
        let database_url = database_url.to_string();

        std::thread::spawn(move || {
            let runtime = match tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
            {
                Ok(runtime) => runtime,
                Err(error) => {
                    let _ = ready_tx.send(Err(error.to_string()));
                    return;
                }
            };

            let startup = runtime.block_on(async {
                let (client, connection) = tokio_postgres::connect(&database_url, NoTls)
                    .await
                    .map_err(|error| error.to_string())?;
                tokio::spawn(async move {
                    if let Err(error) = connection.await {
                        eprintln!("postgres connection error: {error}");
                    }
                });
                let mut client = client;
                let schema_version = apply_postgres_migrations(&mut client)
                    .await
                    .map_err(|error| error.to_string())?;
                Ok::<_, String>((client, schema_version))
            });

            let (mut client, schema_version) = match startup {
                Ok(value) => value,
                Err(error) => {
                    let _ = ready_tx.send(Err(error));
                    return;
                }
            };

            if ready_tx.send(Ok(schema_version)).is_err() {
                return;
            }

            while let Ok(request) = receiver.recv() {
                match request {
                    PostgresRequest::UpsertRecord { record, reply } => {
                        let result = runtime
                            .block_on(postgres_upsert_record(&mut client, &record))
                            .map_err(|error| error.to_string());
                        let _ = reply.send(result);
                    }
                    PostgresRequest::DeleteRecord { id, reply } => {
                        let result = runtime
                            .block_on(postgres_delete_record(&client, &id))
                            .map_err(|error| error.to_string());
                        let _ = reply.send(result);
                    }
                    PostgresRequest::UpsertProject { record, reply } => {
                        let result = runtime
                            .block_on(postgres_upsert_project(&client, &record))
                            .map_err(|error| error.to_string());
                        let _ = reply.send(result);
                    }
                    PostgresRequest::UpsertKnowledgeBase { record, reply } => {
                        let result = runtime
                            .block_on(postgres_upsert_knowledge_base(&client, &record))
                            .map_err(|error| error.to_string());
                        let _ = reply.send(result);
                    }
                    PostgresRequest::DeleteKnowledgeBase { id, reply } => {
                        let result = runtime
                            .block_on(postgres_delete_knowledge_base(&client, &id))
                            .map_err(|error| error.to_string());
                        let _ = reply.send(result);
                    }
                    PostgresRequest::UpsertDataSource { record, reply } => {
                        let result = runtime
                            .block_on(postgres_upsert_data_source(&client, &record))
                            .map_err(|error| error.to_string());
                        let _ = reply.send(result);
                    }
                    PostgresRequest::DeleteDataSource { id, reply } => {
                        let result = runtime
                            .block_on(postgres_delete_data_source(&client, &id))
                            .map_err(|error| error.to_string());
                        let _ = reply.send(result);
                    }
                    PostgresRequest::UpsertAcpConnector { record, reply } => {
                        let result = runtime
                            .block_on(postgres_upsert_acp_connector(&client, &record))
                            .map_err(|error| error.to_string());
                        let _ = reply.send(result);
                    }
                    PostgresRequest::DeleteAcpConnector { id, reply } => {
                        let result = runtime
                            .block_on(postgres_delete_acp_connector(&client, &id))
                            .map_err(|error| error.to_string());
                        let _ = reply.send(result);
                    }
                    PostgresRequest::UpsertApiKey { record, reply } => {
                        let result = runtime
                            .block_on(postgres_upsert_api_key(&client, &record))
                            .map_err(|error| error.to_string());
                        let _ = reply.send(result);
                    }
                    PostgresRequest::AuthenticateApiKey {
                        key_hash,
                        now_ms,
                        reply,
                    } => {
                        let result = runtime
                            .block_on(postgres_authenticate_api_key(&client, &key_hash, now_ms))
                            .map_err(|error| error.to_string());
                        let _ = reply.send(result);
                    }
                    PostgresRequest::ListApiKeys {
                        tenant_id,
                        user_id,
                        reply,
                    } => {
                        let result = runtime
                            .block_on(postgres_list_api_keys(&client, &tenant_id, &user_id))
                            .map_err(|error| error.to_string());
                        let _ = reply.send(result);
                    }
                    PostgresRequest::DisableApiKey {
                        id,
                        tenant_id,
                        user_id,
                        now_ms,
                        reply,
                    } => {
                        let result = runtime
                            .block_on(postgres_disable_api_key(
                                &client, &id, &tenant_id, &user_id, now_ms,
                            ))
                            .map_err(|error| error.to_string());
                        let _ = reply.send(result);
                    }
                    PostgresRequest::UpsertAgentConversation { record, reply } => {
                        let result = runtime
                            .block_on(postgres_upsert_agent_conversation(&client, &record))
                            .map_err(|error| error.to_string());
                        let _ = reply.send(result);
                    }
                    PostgresRequest::UpsertAgentTurn { record, reply } => {
                        let result = runtime
                            .block_on(postgres_upsert_agent_turn(&client, &record))
                            .map_err(|error| error.to_string());
                        let _ = reply.send(result);
                    }
                    PostgresRequest::ListAgentConversations {
                        tenant_id,
                        owner_id,
                        reply,
                    } => {
                        let result = runtime
                            .block_on(postgres_list_agent_conversations(
                                &client,
                                tenant_id.as_deref(),
                                &owner_id,
                            ))
                            .map_err(|error| error.to_string());
                        let _ = reply.send(result);
                    }
                    PostgresRequest::ListAgentTurns {
                        conversation_id,
                        tenant_id,
                        owner_id,
                        reply,
                    } => {
                        let result = runtime
                            .block_on(postgres_list_agent_turns(
                                &client,
                                &conversation_id,
                                tenant_id.as_deref(),
                                &owner_id,
                            ))
                            .map_err(|error| error.to_string());
                        let _ = reply.send(result);
                    }
                    PostgresRequest::DeleteAgentConversation {
                        id,
                        tenant_id,
                        owner_id,
                        reply,
                    } => {
                        let result = runtime
                            .block_on(postgres_delete_agent_conversation(
                                &client,
                                &id,
                                tenant_id.as_deref(),
                                &owner_id,
                            ))
                            .map_err(|error| error.to_string());
                        let _ = reply.send(result);
                    }
                    PostgresRequest::AppendAuditRecord {
                        thread_id,
                        record,
                        reply,
                    } => {
                        let result = runtime
                            .block_on(postgres_append_audit_record(&client, &thread_id, &record))
                            .map_err(|error| error.to_string());
                        let _ = reply.send(result);
                    }
                    PostgresRequest::LoadRecords { reply } => {
                        let result = runtime
                            .block_on(postgres_load_records(&client))
                            .map_err(|error| error.to_string());
                        let _ = reply.send(result);
                    }
                    PostgresRequest::LoadProjects { reply } => {
                        let result = runtime
                            .block_on(postgres_load_projects(&client))
                            .map_err(|error| error.to_string());
                        let _ = reply.send(result);
                    }
                    PostgresRequest::LoadKnowledgeBases { reply } => {
                        let result = runtime
                            .block_on(postgres_load_knowledge_bases(&client))
                            .map_err(|error| error.to_string());
                        let _ = reply.send(result);
                    }
                    PostgresRequest::LoadDataSources { reply } => {
                        let result = runtime
                            .block_on(postgres_load_data_sources(&client))
                            .map_err(|error| error.to_string());
                        let _ = reply.send(result);
                    }
                    PostgresRequest::LoadAcpConnectors { reply } => {
                        let result = runtime
                            .block_on(postgres_load_acp_connectors(&client))
                            .map_err(|error| error.to_string());
                        let _ = reply.send(result);
                    }
                    PostgresRequest::GetProject { id, reply } => {
                        let result = runtime
                            .block_on(postgres_get_project(&client, &id))
                            .map_err(|error| error.to_string());
                        let _ = reply.send(result);
                    }
                    PostgresRequest::GetKnowledgeBase { id, reply } => {
                        let result = runtime
                            .block_on(postgres_get_knowledge_base(&client, &id))
                            .map_err(|error| error.to_string());
                        let _ = reply.send(result);
                    }
                    PostgresRequest::GetAcpConnector { id, reply } => {
                        let result = runtime
                            .block_on(postgres_get_acp_connector(&client, &id))
                            .map_err(|error| error.to_string());
                        let _ = reply.send(result);
                    }
                    PostgresRequest::LoadAuditRecords {
                        thread_id,
                        limit,
                        reply,
                    } => {
                        let result = runtime
                            .block_on(load_postgres_audit_records(&client, &thread_id, limit))
                            .map_err(|error| error.to_string());
                        let _ = reply.send(result);
                    }
                    PostgresRequest::LoadLatestExpertPanelRunState {
                        thread_id,
                        run_id,
                        reply,
                    } => {
                        let result = runtime
                            .block_on(load_postgres_latest_expert_panel_run_state(
                                &client, &thread_id, &run_id,
                            ))
                            .map_err(|error| error.to_string());
                        let _ = reply.send(result);
                    }
                    PostgresRequest::LoadMemoryNotesForScope {
                        record,
                        scope,
                        reply,
                    } => {
                        let result = runtime
                            .block_on(load_postgres_memory_notes_for_scope(
                                &client, &record, scope,
                            ))
                            .map_err(|error| error.to_string());
                        let _ = reply.send(result);
                    }
                }
            }
        });

        let schema_version = ready_rx
            .recv()
            .map_err(|error| boxed_string_error(format!("postgres worker init failed: {error}")))?
            .map_err(boxed_string_error)?;
        Ok((Self { sender }, schema_version))
    }

    fn upsert_record(&self, record: &ThreadRecord) -> Result<(), Box<dyn std::error::Error>> {
        let (reply_tx, reply_rx) = mpsc::channel();
        self.sender
            .send(PostgresRequest::UpsertRecord {
                record: record.clone(),
                reply: reply_tx,
            })
            .map_err(|error| boxed_string_error(format!("postgres request failed: {error}")))?;
        reply_rx
            .recv()
            .map_err(|error| boxed_string_error(format!("postgres response failed: {error}")))?
            .map_err(boxed_string_error)
    }

    fn delete_record(&self, id: &str) -> Result<bool, Box<dyn std::error::Error>> {
        let (reply_tx, reply_rx) = mpsc::channel();
        self.sender
            .send(PostgresRequest::DeleteRecord {
                id: id.to_string(),
                reply: reply_tx,
            })
            .map_err(|error| boxed_string_error(format!("postgres request failed: {error}")))?;
        reply_rx
            .recv()
            .map_err(|error| boxed_string_error(format!("postgres response failed: {error}")))?
            .map_err(boxed_string_error)
    }

    fn upsert_project(&self, record: &ProjectRecord) -> Result<(), Box<dyn std::error::Error>> {
        let (reply_tx, reply_rx) = mpsc::channel();
        self.sender
            .send(PostgresRequest::UpsertProject {
                record: record.clone(),
                reply: reply_tx,
            })
            .map_err(|error| boxed_string_error(format!("postgres request failed: {error}")))?;
        reply_rx
            .recv()
            .map_err(|error| boxed_string_error(format!("postgres response failed: {error}")))?
            .map_err(boxed_string_error)
    }

    fn upsert_knowledge_base(
        &self,
        record: &KnowledgeBaseRecord,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let (reply_tx, reply_rx) = mpsc::channel();
        self.sender
            .send(PostgresRequest::UpsertKnowledgeBase {
                record: record.clone(),
                reply: reply_tx,
            })
            .map_err(|error| boxed_string_error(format!("postgres request failed: {error}")))?;
        reply_rx
            .recv()
            .map_err(|error| boxed_string_error(format!("postgres response failed: {error}")))?
            .map_err(boxed_string_error)
    }

    fn delete_knowledge_base(&self, id: &str) -> Result<bool, Box<dyn std::error::Error>> {
        let (reply_tx, reply_rx) = mpsc::channel();
        self.sender
            .send(PostgresRequest::DeleteKnowledgeBase {
                id: id.to_string(),
                reply: reply_tx,
            })
            .map_err(|error| boxed_string_error(format!("postgres request failed: {error}")))?;
        reply_rx
            .recv()
            .map_err(|error| boxed_string_error(format!("postgres response failed: {error}")))?
            .map_err(boxed_string_error)
    }

    fn upsert_data_source(
        &self,
        record: &DataSourceRecord,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let (reply_tx, reply_rx) = mpsc::channel();
        self.sender
            .send(PostgresRequest::UpsertDataSource {
                record: record.clone(),
                reply: reply_tx,
            })
            .map_err(|error| boxed_string_error(format!("postgres request failed: {error}")))?;
        reply_rx
            .recv()
            .map_err(|error| boxed_string_error(format!("postgres response failed: {error}")))?
            .map_err(boxed_string_error)
    }

    fn delete_data_source(&self, id: &str) -> Result<bool, Box<dyn std::error::Error>> {
        let (reply_tx, reply_rx) = mpsc::channel();
        self.sender
            .send(PostgresRequest::DeleteDataSource {
                id: id.to_string(),
                reply: reply_tx,
            })
            .map_err(|error| boxed_string_error(format!("postgres request failed: {error}")))?;
        reply_rx
            .recv()
            .map_err(|error| boxed_string_error(format!("postgres response failed: {error}")))?
            .map_err(boxed_string_error)
    }

    fn upsert_acp_connector(
        &self,
        record: &AcpConnectorRecord,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let (reply_tx, reply_rx) = mpsc::channel();
        self.sender
            .send(PostgresRequest::UpsertAcpConnector {
                record: record.clone(),
                reply: reply_tx,
            })
            .map_err(|error| boxed_string_error(format!("postgres request failed: {error}")))?;
        reply_rx
            .recv()
            .map_err(|error| boxed_string_error(format!("postgres response failed: {error}")))?
            .map_err(boxed_string_error)
    }

    fn delete_acp_connector(&self, id: &str) -> Result<bool, Box<dyn std::error::Error>> {
        let (reply_tx, reply_rx) = mpsc::channel();
        self.sender
            .send(PostgresRequest::DeleteAcpConnector {
                id: id.to_string(),
                reply: reply_tx,
            })
            .map_err(|error| boxed_string_error(format!("postgres request failed: {error}")))?;
        reply_rx
            .recv()
            .map_err(|error| boxed_string_error(format!("postgres response failed: {error}")))?
            .map_err(boxed_string_error)
    }

    fn load_acp_connectors(&self) -> Result<Vec<AcpConnectorRecord>, Box<dyn std::error::Error>> {
        let (reply_tx, reply_rx) = mpsc::channel();
        self.sender
            .send(PostgresRequest::LoadAcpConnectors { reply: reply_tx })
            .map_err(|error| boxed_string_error(format!("postgres request failed: {error}")))?;
        reply_rx
            .recv()
            .map_err(|error| boxed_string_error(format!("postgres response failed: {error}")))?
            .map_err(boxed_string_error)
    }

    fn get_acp_connector(
        &self,
        id: &str,
    ) -> Result<Option<AcpConnectorRecord>, Box<dyn std::error::Error>> {
        let (reply_tx, reply_rx) = mpsc::channel();
        self.sender
            .send(PostgresRequest::GetAcpConnector {
                id: id.to_string(),
                reply: reply_tx,
            })
            .map_err(|error| boxed_string_error(format!("postgres request failed: {error}")))?;
        reply_rx
            .recv()
            .map_err(|error| boxed_string_error(format!("postgres response failed: {error}")))?
            .map_err(boxed_string_error)
    }

    fn append_audit_record(
        &self,
        thread_id: &str,
        record: &AuditRecord,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let (reply_tx, reply_rx) = mpsc::channel();
        self.sender
            .send(PostgresRequest::AppendAuditRecord {
                thread_id: thread_id.to_string(),
                record: record.clone(),
                reply: reply_tx,
            })
            .map_err(|error| boxed_string_error(format!("postgres request failed: {error}")))?;
        reply_rx
            .recv()
            .map_err(|error| boxed_string_error(format!("postgres response failed: {error}")))?
            .map_err(boxed_string_error)
    }

    fn upsert_api_key(&self, record: &ApiKeyRecord) -> Result<(), Box<dyn std::error::Error>> {
        let (reply_tx, reply_rx) = mpsc::channel();
        self.sender
            .send(PostgresRequest::UpsertApiKey {
                record: record.clone(),
                reply: reply_tx,
            })
            .map_err(|error| boxed_string_error(format!("postgres request failed: {error}")))?;
        reply_rx
            .recv()
            .map_err(|error| boxed_string_error(format!("postgres response failed: {error}")))?
            .map_err(boxed_string_error)
    }

    fn authenticate_api_key(
        &self,
        key_hash: &str,
        now_ms: u64,
    ) -> Result<Option<ApiKeyRecord>, Box<dyn std::error::Error>> {
        let (reply_tx, reply_rx) = mpsc::channel();
        self.sender
            .send(PostgresRequest::AuthenticateApiKey {
                key_hash: key_hash.to_string(),
                now_ms,
                reply: reply_tx,
            })
            .map_err(|error| boxed_string_error(format!("postgres request failed: {error}")))?;
        reply_rx
            .recv()
            .map_err(|error| boxed_string_error(format!("postgres response failed: {error}")))?
            .map_err(boxed_string_error)
    }

    fn list_api_keys(
        &self,
        tenant_id: &str,
        user_id: &str,
    ) -> Result<Vec<ApiKeyRecord>, Box<dyn std::error::Error>> {
        let (reply_tx, reply_rx) = mpsc::channel();
        self.sender
            .send(PostgresRequest::ListApiKeys {
                tenant_id: tenant_id.to_string(),
                user_id: user_id.to_string(),
                reply: reply_tx,
            })
            .map_err(|error| boxed_string_error(format!("postgres request failed: {error}")))?;
        reply_rx
            .recv()
            .map_err(|error| boxed_string_error(format!("postgres response failed: {error}")))?
            .map_err(boxed_string_error)
    }

    fn disable_api_key(
        &self,
        id: &str,
        tenant_id: &str,
        user_id: &str,
        now_ms: u64,
    ) -> Result<bool, Box<dyn std::error::Error>> {
        let (reply_tx, reply_rx) = mpsc::channel();
        self.sender
            .send(PostgresRequest::DisableApiKey {
                id: id.to_string(),
                tenant_id: tenant_id.to_string(),
                user_id: user_id.to_string(),
                now_ms,
                reply: reply_tx,
            })
            .map_err(|error| boxed_string_error(format!("postgres request failed: {error}")))?;
        reply_rx
            .recv()
            .map_err(|error| boxed_string_error(format!("postgres response failed: {error}")))?
            .map_err(boxed_string_error)
    }

    #[allow(dead_code)]
    fn upsert_agent_conversation(
        &self,
        record: &AgentConversationRecord,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let (reply_tx, reply_rx) = mpsc::channel();
        self.sender
            .send(PostgresRequest::UpsertAgentConversation {
                record: record.clone(),
                reply: reply_tx,
            })
            .map_err(|error| boxed_string_error(format!("postgres request failed: {error}")))?;
        reply_rx
            .recv()
            .map_err(|error| boxed_string_error(format!("postgres response failed: {error}")))?
            .map_err(boxed_string_error)
    }

    #[allow(dead_code)]
    fn upsert_agent_turn(
        &self,
        record: &AgentTurnRecord,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let (reply_tx, reply_rx) = mpsc::channel();
        self.sender
            .send(PostgresRequest::UpsertAgentTurn {
                record: record.clone(),
                reply: reply_tx,
            })
            .map_err(|error| boxed_string_error(format!("postgres request failed: {error}")))?;
        reply_rx
            .recv()
            .map_err(|error| boxed_string_error(format!("postgres response failed: {error}")))?
            .map_err(boxed_string_error)
    }

    #[allow(dead_code)]
    fn list_agent_conversations(
        &self,
        tenant_id: Option<&str>,
        owner_id: &str,
    ) -> Result<Vec<AgentConversationRecord>, Box<dyn std::error::Error>> {
        let (reply_tx, reply_rx) = mpsc::channel();
        self.sender
            .send(PostgresRequest::ListAgentConversations {
                tenant_id: tenant_id.map(str::to_string),
                owner_id: owner_id.to_string(),
                reply: reply_tx,
            })
            .map_err(|error| boxed_string_error(format!("postgres request failed: {error}")))?;
        reply_rx
            .recv()
            .map_err(|error| boxed_string_error(format!("postgres response failed: {error}")))?
            .map_err(boxed_string_error)
    }

    #[allow(dead_code)]
    fn list_agent_turns(
        &self,
        conversation_id: &str,
        tenant_id: Option<&str>,
        owner_id: &str,
    ) -> Result<Vec<AgentTurnRecord>, Box<dyn std::error::Error>> {
        let (reply_tx, reply_rx) = mpsc::channel();
        self.sender
            .send(PostgresRequest::ListAgentTurns {
                conversation_id: conversation_id.to_string(),
                tenant_id: tenant_id.map(str::to_string),
                owner_id: owner_id.to_string(),
                reply: reply_tx,
            })
            .map_err(|error| boxed_string_error(format!("postgres request failed: {error}")))?;
        reply_rx
            .recv()
            .map_err(|error| boxed_string_error(format!("postgres response failed: {error}")))?
            .map_err(boxed_string_error)
    }

    #[allow(dead_code)]
    fn delete_agent_conversation(
        &self,
        id: &str,
        tenant_id: Option<&str>,
        owner_id: &str,
    ) -> Result<bool, Box<dyn std::error::Error>> {
        let (reply_tx, reply_rx) = mpsc::channel();
        self.sender
            .send(PostgresRequest::DeleteAgentConversation {
                id: id.to_string(),
                tenant_id: tenant_id.map(str::to_string),
                owner_id: owner_id.to_string(),
                reply: reply_tx,
            })
            .map_err(|error| boxed_string_error(format!("postgres request failed: {error}")))?;
        reply_rx
            .recv()
            .map_err(|error| boxed_string_error(format!("postgres response failed: {error}")))?
            .map_err(boxed_string_error)
    }

    fn load_records(&self) -> Result<Vec<ThreadRecord>, Box<dyn std::error::Error>> {
        let (reply_tx, reply_rx) = mpsc::channel();
        self.sender
            .send(PostgresRequest::LoadRecords { reply: reply_tx })
            .map_err(|error| boxed_string_error(format!("postgres request failed: {error}")))?;
        reply_rx
            .recv()
            .map_err(|error| boxed_string_error(format!("postgres response failed: {error}")))?
            .map_err(boxed_string_error)
    }

    fn load_projects(&self) -> Result<Vec<ProjectRecord>, Box<dyn std::error::Error>> {
        let (reply_tx, reply_rx) = mpsc::channel();
        self.sender
            .send(PostgresRequest::LoadProjects { reply: reply_tx })
            .map_err(|error| boxed_string_error(format!("postgres request failed: {error}")))?;
        reply_rx
            .recv()
            .map_err(|error| boxed_string_error(format!("postgres response failed: {error}")))?
            .map_err(boxed_string_error)
    }

    fn load_knowledge_bases(&self) -> Result<Vec<KnowledgeBaseRecord>, Box<dyn std::error::Error>> {
        let (reply_tx, reply_rx) = mpsc::channel();
        self.sender
            .send(PostgresRequest::LoadKnowledgeBases { reply: reply_tx })
            .map_err(|error| boxed_string_error(format!("postgres request failed: {error}")))?;
        reply_rx
            .recv()
            .map_err(|error| boxed_string_error(format!("postgres response failed: {error}")))?
            .map_err(boxed_string_error)
    }

    fn load_data_sources(&self) -> Result<Vec<DataSourceRecord>, Box<dyn std::error::Error>> {
        let (reply_tx, reply_rx) = mpsc::channel();
        self.sender
            .send(PostgresRequest::LoadDataSources { reply: reply_tx })
            .map_err(|error| boxed_string_error(format!("postgres request failed: {error}")))?;
        reply_rx
            .recv()
            .map_err(|error| boxed_string_error(format!("postgres response failed: {error}")))?
            .map_err(boxed_string_error)
    }

    fn get_project(&self, id: &str) -> Result<Option<ProjectRecord>, Box<dyn std::error::Error>> {
        let (reply_tx, reply_rx) = mpsc::channel();
        self.sender
            .send(PostgresRequest::GetProject {
                id: id.to_string(),
                reply: reply_tx,
            })
            .map_err(|error| boxed_string_error(format!("postgres request failed: {error}")))?;
        reply_rx
            .recv()
            .map_err(|error| boxed_string_error(format!("postgres response failed: {error}")))?
            .map_err(boxed_string_error)
    }

    fn get_knowledge_base(
        &self,
        id: &str,
    ) -> Result<Option<KnowledgeBaseRecord>, Box<dyn std::error::Error>> {
        let (reply_tx, reply_rx) = mpsc::channel();
        self.sender
            .send(PostgresRequest::GetKnowledgeBase {
                id: id.to_string(),
                reply: reply_tx,
            })
            .map_err(|error| boxed_string_error(format!("postgres request failed: {error}")))?;
        reply_rx
            .recv()
            .map_err(|error| boxed_string_error(format!("postgres response failed: {error}")))?
            .map_err(boxed_string_error)
    }

    fn load_audit_records(
        &self,
        thread_id: &str,
        limit: usize,
    ) -> Result<Vec<AuditRecord>, Box<dyn std::error::Error>> {
        let (reply_tx, reply_rx) = mpsc::channel();
        self.sender
            .send(PostgresRequest::LoadAuditRecords {
                thread_id: thread_id.to_string(),
                limit,
                reply: reply_tx,
            })
            .map_err(|error| boxed_string_error(format!("postgres request failed: {error}")))?;
        reply_rx
            .recv()
            .map_err(|error| boxed_string_error(format!("postgres response failed: {error}")))?
            .map_err(boxed_string_error)
    }

    fn load_latest_expert_panel_run_state(
        &self,
        thread_id: &str,
        run_id: &str,
    ) -> Result<Option<ExpertPanelRunResponse>, Box<dyn std::error::Error>> {
        let (reply_tx, reply_rx) = mpsc::channel();
        self.sender
            .send(PostgresRequest::LoadLatestExpertPanelRunState {
                thread_id: thread_id.to_string(),
                run_id: run_id.to_string(),
                reply: reply_tx,
            })
            .map_err(|error| boxed_string_error(format!("postgres request failed: {error}")))?;
        reply_rx
            .recv()
            .map_err(|error| boxed_string_error(format!("postgres response failed: {error}")))?
            .map_err(boxed_string_error)
    }

    fn load_memory_notes_for_scope(
        &self,
        record: &ThreadRecord,
        scope: MemorySearchScope,
    ) -> Result<Vec<MemoryNote>, Box<dyn std::error::Error>> {
        let (reply_tx, reply_rx) = mpsc::channel();
        self.sender
            .send(PostgresRequest::LoadMemoryNotesForScope {
                record: record.clone(),
                scope,
                reply: reply_tx,
            })
            .map_err(|error| boxed_string_error(format!("postgres request failed: {error}")))?;
        reply_rx
            .recv()
            .map_err(|error| boxed_string_error(format!("postgres response failed: {error}")))?
            .map_err(boxed_string_error)
    }
}

enum ThreadStore {
    Sqlite {
        connection: Mutex<SqliteConnection>,
        schema_version: u32,
    },
    Postgres {
        worker: PostgresWorker,
        schema_version: u32,
    },
}

impl ThreadStore {
    fn open(config: &AppConfig) -> Result<Self, Box<dyn std::error::Error>> {
        match config.database_backend() {
            "postgres" => {
                let (worker, schema_version) = PostgresWorker::start(&config.database_url)?;
                Ok(Self::Postgres {
                    worker,
                    schema_version,
                })
            }
            _ => {
                let sqlite_path = sqlite_path_from_url(&config.database_url)?;
                if let Some(parent) = sqlite_path.parent() {
                    fs::create_dir_all(parent)?;
                }
                let mut connection = SqliteConnection::open(sqlite_path)?;
                let schema_version = apply_sqlite_migrations(&mut connection)?;
                Ok(Self::Sqlite {
                    connection: Mutex::new(connection),
                    schema_version,
                })
            }
        }
    }

    fn schema_version(&self) -> u32 {
        match self {
            Self::Sqlite { schema_version, .. } | Self::Postgres { schema_version, .. } => {
                *schema_version
            }
        }
    }

    fn upsert_record(&self, record: &ThreadRecord) -> Result<(), Box<dyn std::error::Error>> {
        let tenant_id = record.tenant_id.clone();
        let owner_id = record.owner_id.clone();
        let updated_at_ms = i64::try_from(record.updated_at_ms)?;
        let record_json = serde_json::to_string(record)?;

        match self {
            Self::Sqlite { connection, .. } => {
                let mut guard = connection
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                let transaction = guard.transaction()?;
                transaction.execute(
                    "INSERT INTO thread_records (id, tenant_id, owner_id, updated_at_ms, record_json)
                     VALUES (?1, ?2, ?3, ?4, ?5)
                     ON CONFLICT(id) DO UPDATE SET
                       tenant_id = excluded.tenant_id,
                       owner_id = excluded.owner_id,
                       updated_at_ms = excluded.updated_at_ms,
                       record_json = excluded.record_json",
                    rusqlite::params![
                        &record.id,
                        &tenant_id,
                        &owner_id,
                        updated_at_ms,
                        &record_json
                    ],
                )?;
                replace_sqlite_derived_rows(&transaction, record)?;
                transaction.commit()?;
            }
            Self::Postgres { worker, .. } => {
                let _ = tenant_id;
                let _ = owner_id;
                let _ = updated_at_ms;
                let _ = record_json;
                worker.upsert_record(record)?;
            }
        }

        Ok(())
    }

    fn delete_thread(&self, id: &str) -> Result<bool, Box<dyn std::error::Error>> {
        match self {
            Self::Sqlite { connection, .. } => {
                let mut guard = connection
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                let transaction = guard.transaction()?;
                transaction.execute("DELETE FROM audit_records WHERE thread_id = ?1", [id])?;
                transaction.execute("DELETE FROM artifact_records WHERE thread_id = ?1", [id])?;
                transaction.execute("DELETE FROM memory_notes WHERE thread_id = ?1", [id])?;
                let affected =
                    transaction.execute("DELETE FROM thread_records WHERE id = ?1", [id])?;
                transaction.commit()?;
                Ok(affected > 0)
            }
            Self::Postgres { worker, .. } => worker.delete_record(id),
        }
    }

    fn upsert_project(&self, record: &ProjectRecord) -> Result<(), Box<dyn std::error::Error>> {
        let tenant_id = record.tenant_id.clone();
        let owner_id = record.owner_id.clone();
        let updated_at_ms = i64::try_from(record.updated_at_ms)?;
        let record_json = serde_json::to_string(record)?;

        match self {
            Self::Sqlite { connection, .. } => {
                let guard = connection
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                guard.execute(
                    "INSERT INTO project_records (id, tenant_id, owner_id, updated_at_ms, record_json)
                     VALUES (?1, ?2, ?3, ?4, ?5)
                     ON CONFLICT(id) DO UPDATE SET
                       tenant_id = excluded.tenant_id,
                       owner_id = excluded.owner_id,
                       updated_at_ms = excluded.updated_at_ms,
                       record_json = excluded.record_json",
                    rusqlite::params![
                        &record.id,
                        &tenant_id,
                        &owner_id,
                        updated_at_ms,
                        &record_json
                    ],
                )?;
            }
            Self::Postgres { worker, .. } => {
                let _ = tenant_id;
                let _ = owner_id;
                let _ = updated_at_ms;
                let _ = record_json;
                worker.upsert_project(record)?;
            }
        }

        Ok(())
    }

    fn upsert_knowledge_base(
        &self,
        record: &KnowledgeBaseRecord,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let tenant_id = record.tenant_id.clone();
        let owner_id = record.owner_id.clone();
        let updated_at_ms = i64::try_from(record.updated_at_ms)?;
        let record_json = serde_json::to_string(record)?;

        match self {
            Self::Sqlite { connection, .. } => {
                let guard = connection
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                guard.execute(
                    "INSERT INTO knowledge_bases (id, tenant_id, owner_id, updated_at_ms, record_json)
                     VALUES (?1, ?2, ?3, ?4, ?5)
                     ON CONFLICT(id) DO UPDATE SET
                       tenant_id = excluded.tenant_id,
                       owner_id = excluded.owner_id,
                       updated_at_ms = excluded.updated_at_ms,
                       record_json = excluded.record_json",
                    rusqlite::params![
                        &record.id,
                        &tenant_id,
                        &owner_id,
                        updated_at_ms,
                        &record_json
                    ],
                )?;
            }
            Self::Postgres { worker, .. } => {
                worker.upsert_knowledge_base(record)?;
            }
        }

        Ok(())
    }

    fn delete_knowledge_base(&self, id: &str) -> Result<bool, Box<dyn std::error::Error>> {
        match self {
            Self::Sqlite { connection, .. } => {
                let guard = connection
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                let affected = guard.execute("DELETE FROM knowledge_bases WHERE id = ?1", [id])?;
                Ok(affected > 0)
            }
            Self::Postgres { worker, .. } => worker.delete_knowledge_base(id),
        }
    }

    fn upsert_data_source(
        &self,
        record: &DataSourceRecord,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let tenant_id = record.tenant_id.clone();
        let owner_id = record.owner_id.clone();
        let updated_at_ms = i64::try_from(record.updated_at_ms)?;
        let record_json = serde_json::to_string(record)?;

        match self {
            Self::Sqlite { connection, .. } => {
                let guard = connection
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                guard.execute(
                    "INSERT INTO data_sources (id, knowledge_base_id, tenant_id, owner_id, updated_at_ms, record_json)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6)
                     ON CONFLICT(id) DO UPDATE SET
                       knowledge_base_id = excluded.knowledge_base_id,
                       tenant_id = excluded.tenant_id,
                       owner_id = excluded.owner_id,
                       updated_at_ms = excluded.updated_at_ms,
                       record_json = excluded.record_json",
                    rusqlite::params![
                        &record.id,
                        &record.knowledge_base_id,
                        &tenant_id,
                        &owner_id,
                        updated_at_ms,
                        &record_json
                    ],
                )?;
            }
            Self::Postgres { worker, .. } => {
                worker.upsert_data_source(record)?;
            }
        }

        Ok(())
    }

    fn delete_data_source(&self, id: &str) -> Result<bool, Box<dyn std::error::Error>> {
        match self {
            Self::Sqlite { connection, .. } => {
                let guard = connection
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                let affected = guard.execute("DELETE FROM data_sources WHERE id = ?1", [id])?;
                Ok(affected > 0)
            }
            Self::Postgres { worker, .. } => worker.delete_data_source(id),
        }
    }

    fn upsert_acp_connector(
        &self,
        record: &AcpConnectorRecord,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let tenant_id = record.tenant_id.clone();
        let owner_id = record.owner_id.clone();
        let project_id = record.project_id.clone();
        let knowledge_base_id = record.knowledge_base_id.clone();
        let updated_at_ms = i64::try_from(record.updated_at_ms)?;
        let record_json = serde_json::to_string(record)?;

        match self {
            Self::Sqlite { connection, .. } => {
                let guard = connection
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                guard.execute(
                    "INSERT INTO acp_connectors (
                        id, tenant_id, owner_id, project_id, knowledge_base_id, updated_at_ms, record_json
                     )
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)
                     ON CONFLICT(id) DO UPDATE SET
                       tenant_id = excluded.tenant_id,
                       owner_id = excluded.owner_id,
                       project_id = excluded.project_id,
                       knowledge_base_id = excluded.knowledge_base_id,
                       updated_at_ms = excluded.updated_at_ms,
                       record_json = excluded.record_json",
                    rusqlite::params![
                        &record.id,
                        &tenant_id,
                        &owner_id,
                        &project_id,
                        &knowledge_base_id,
                        updated_at_ms,
                        &record_json
                    ],
                )?;
            }
            Self::Postgres { worker, .. } => worker.upsert_acp_connector(record)?,
        }

        Ok(())
    }

    fn delete_acp_connector(&self, id: &str) -> Result<bool, Box<dyn std::error::Error>> {
        match self {
            Self::Sqlite { connection, .. } => {
                let guard = connection
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                let affected = guard.execute("DELETE FROM acp_connectors WHERE id = ?1", [id])?;
                Ok(affected > 0)
            }
            Self::Postgres { worker, .. } => worker.delete_acp_connector(id),
        }
    }

    fn upsert_api_key(&self, record: &ApiKeyRecord) -> Result<(), Box<dyn std::error::Error>> {
        match self {
            Self::Sqlite { connection, .. } => {
                let guard = connection
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                upsert_sqlite_api_key(&guard, record)?;
                Ok(())
            }
            Self::Postgres { worker, .. } => worker.upsert_api_key(record),
        }
    }

    fn authenticate_api_key(
        &self,
        raw_key: &str,
    ) -> Result<Option<ApiKeyRecord>, Box<dyn std::error::Error>> {
        let key_hash = hash_api_key(raw_key);
        let now_ms = now_millis();
        match self {
            Self::Sqlite { connection, .. } => {
                let guard = connection
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                authenticate_sqlite_api_key(&guard, &key_hash, now_ms)
            }
            Self::Postgres { worker, .. } => worker.authenticate_api_key(&key_hash, now_ms),
        }
    }

    fn list_api_keys(
        &self,
        tenant_id: &str,
        user_id: &str,
    ) -> Result<Vec<ApiKeyRecord>, Box<dyn std::error::Error>> {
        match self {
            Self::Sqlite { connection, .. } => {
                let guard = connection
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                list_sqlite_api_keys(&guard, tenant_id, user_id)
            }
            Self::Postgres { worker, .. } => worker.list_api_keys(tenant_id, user_id),
        }
    }

    fn disable_api_key(
        &self,
        id: &str,
        tenant_id: &str,
        user_id: &str,
    ) -> Result<bool, Box<dyn std::error::Error>> {
        let now_ms = now_millis();
        match self {
            Self::Sqlite { connection, .. } => {
                let guard = connection
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                disable_sqlite_api_key(&guard, id, tenant_id, user_id, now_ms)
            }
            Self::Postgres { worker, .. } => worker.disable_api_key(id, tenant_id, user_id, now_ms),
        }
    }

    #[allow(dead_code)]
    fn upsert_agent_conversation(
        &self,
        record: &AgentConversationRecord,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let updated_at_ms = i64::try_from(record.updated_at_ms)?;
        let record_json = serde_json::to_string(record)?;

        match self {
            Self::Sqlite { connection, .. } => {
                let guard = connection
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
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
                        agent_conversation_status_as_str(&record.status),
                        updated_at_ms,
                        &record_json
                    ],
                )?;
                Ok(())
            }
            Self::Postgres { worker, .. } => worker.upsert_agent_conversation(record),
        }
    }

    #[allow(dead_code)]
    fn upsert_agent_turn(
        &self,
        record: &AgentTurnRecord,
    ) -> Result<(), Box<dyn std::error::Error>> {
        let started_at_ms = i64::try_from(record.started_at_ms)?;
        let completed_at_ms = record.completed_at_ms.map(i64::try_from).transpose()?;
        let record_json = serde_json::to_string(record)?;

        match self {
            Self::Sqlite { connection, .. } => {
                let guard = connection
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                guard.execute(
                    "INSERT INTO agent_turns (
                        id, conversation_id, tenant_id, owner_id, status, started_at_ms, completed_at_ms, record_json
                     )
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
                        agent_turn_status_as_str(&record.status),
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

    #[allow(dead_code)]
    fn list_agent_conversations(
        &self,
        tenant_id: Option<&str>,
        owner_id: &str,
    ) -> Result<Vec<AgentConversationRecord>, Box<dyn std::error::Error>> {
        match self {
            Self::Sqlite { connection, .. } => {
                let guard = connection
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                let mut statement = guard.prepare(
                    "SELECT record_json FROM agent_conversations
                     WHERE tenant_id IS ?1 AND owner_id = ?2
                     ORDER BY updated_at_ms DESC, id DESC",
                )?;
                let rows = statement.query_map(rusqlite::params![tenant_id, owner_id], |row| {
                    row.get::<_, String>(0)
                })?;
                let mut records = Vec::new();
                for row in rows {
                    records.push(serde_json::from_str::<AgentConversationRecord>(&row?)?);
                }
                Ok(records)
            }
            Self::Postgres { worker, .. } => worker.list_agent_conversations(tenant_id, owner_id),
        }
    }

    #[allow(dead_code)]
    fn list_agent_turns(
        &self,
        conversation_id: &str,
        tenant_id: Option<&str>,
        owner_id: &str,
    ) -> Result<Vec<AgentTurnRecord>, Box<dyn std::error::Error>> {
        match self {
            Self::Sqlite { connection, .. } => {
                let guard = connection
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                let mut statement = guard.prepare(
                    "SELECT record_json FROM agent_turns
                     WHERE conversation_id = ?1 AND tenant_id IS ?2 AND owner_id = ?3
                     ORDER BY started_at_ms ASC, id ASC",
                )?;
                let rows = statement.query_map(
                    rusqlite::params![conversation_id, tenant_id, owner_id],
                    |row| row.get::<_, String>(0),
                )?;
                let mut records = Vec::new();
                for row in rows {
                    records.push(serde_json::from_str::<AgentTurnRecord>(&row?)?);
                }
                Ok(records)
            }
            Self::Postgres { worker, .. } => {
                worker.list_agent_turns(conversation_id, tenant_id, owner_id)
            }
        }
    }

    #[allow(dead_code)]
    fn delete_agent_conversation(
        &self,
        id: &str,
        tenant_id: Option<&str>,
        owner_id: &str,
    ) -> Result<bool, Box<dyn std::error::Error>> {
        match self {
            Self::Sqlite { connection, .. } => {
                let guard = connection
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                let deleted = guard.execute(
                    "DELETE FROM agent_conversations
                     WHERE id = ?1 AND tenant_id IS ?2 AND owner_id = ?3",
                    rusqlite::params![id, tenant_id, owner_id],
                )?;
                if deleted > 0 {
                    guard.execute(
                        "DELETE FROM agent_turns
                         WHERE conversation_id = ?1 AND tenant_id IS ?2 AND owner_id = ?3",
                        rusqlite::params![id, tenant_id, owner_id],
                    )?;
                }
                Ok(deleted > 0)
            }
            Self::Postgres { worker, .. } => {
                worker.delete_agent_conversation(id, tenant_id, owner_id)
            }
        }
    }

    fn load_records(&self) -> Result<Vec<ThreadRecord>, Box<dyn std::error::Error>> {
        match self {
            Self::Sqlite { connection, .. } => {
                let guard = connection
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                let mut statement = guard.prepare(
                    "SELECT id, record_json FROM thread_records ORDER BY updated_at_ms DESC",
                )?;
                let rows = statement.query_map([], |row| {
                    Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
                })?;
                let mut records = Vec::new();
                for row in rows {
                    let (id, raw) = row?;
                    let mut record = serde_json::from_str::<ThreadRecord>(&raw)?;
                    let memory_notes = load_sqlite_memory_notes(&guard, &id)?;
                    if !memory_notes.is_empty() || record.memory_notes.is_empty() {
                        record.memory_notes = memory_notes;
                    }
                    let artifacts = load_sqlite_artifacts(&guard, &id)?;
                    if !artifacts.is_empty() || record.artifacts.is_empty() {
                        record.artifacts = artifacts;
                    }
                    records.push(record);
                }
                Ok(records)
            }
            Self::Postgres { worker, .. } => worker.load_records(),
        }
    }

    fn load_projects(&self) -> Result<Vec<ProjectRecord>, Box<dyn std::error::Error>> {
        match self {
            Self::Sqlite { connection, .. } => {
                let guard = connection
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                let mut statement = guard.prepare(
                    "SELECT record_json FROM project_records ORDER BY updated_at_ms DESC",
                )?;
                let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
                let mut records = Vec::new();
                for row in rows {
                    records.push(serde_json::from_str::<ProjectRecord>(&row?)?);
                }
                Ok(records)
            }
            Self::Postgres { worker, .. } => worker.load_projects(),
        }
    }

    fn load_knowledge_bases(&self) -> Result<Vec<KnowledgeBaseRecord>, Box<dyn std::error::Error>> {
        match self {
            Self::Sqlite { connection, .. } => {
                let guard = connection
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                let mut statement = guard.prepare(
                    "SELECT record_json FROM knowledge_bases ORDER BY updated_at_ms DESC",
                )?;
                let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
                let mut records = Vec::new();
                for row in rows {
                    records.push(serde_json::from_str::<KnowledgeBaseRecord>(&row?)?);
                }
                Ok(records)
            }
            Self::Postgres { worker, .. } => worker.load_knowledge_bases(),
        }
    }

    fn load_data_sources(&self) -> Result<Vec<DataSourceRecord>, Box<dyn std::error::Error>> {
        match self {
            Self::Sqlite { connection, .. } => {
                let guard = connection
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                let mut statement = guard
                    .prepare("SELECT record_json FROM data_sources ORDER BY updated_at_ms DESC")?;
                let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
                let mut records = Vec::new();
                for row in rows {
                    records.push(serde_json::from_str::<DataSourceRecord>(&row?)?);
                }
                Ok(records)
            }
            Self::Postgres { worker, .. } => worker.load_data_sources(),
        }
    }

    fn load_acp_connectors(&self) -> Result<Vec<AcpConnectorRecord>, Box<dyn std::error::Error>> {
        match self {
            Self::Sqlite { connection, .. } => {
                let guard = connection
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                let mut statement = guard.prepare(
                    "SELECT record_json FROM acp_connectors ORDER BY updated_at_ms DESC",
                )?;
                let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
                let mut records = Vec::new();
                for row in rows {
                    records.push(serde_json::from_str::<AcpConnectorRecord>(&row?)?);
                }
                Ok(records)
            }
            Self::Postgres { worker, .. } => worker.load_acp_connectors(),
        }
    }

    fn get_project(&self, id: &str) -> Result<Option<ProjectRecord>, Box<dyn std::error::Error>> {
        match self {
            Self::Sqlite { connection, .. } => {
                let guard = connection
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                let raw = guard
                    .query_row(
                        "SELECT record_json FROM project_records WHERE id = ?1",
                        [id],
                        |row| row.get::<_, String>(0),
                    )
                    .optional()?;
                raw.map(|value| serde_json::from_str::<ProjectRecord>(&value))
                    .transpose()
                    .map_err(|error| -> Box<dyn std::error::Error> { Box::new(error) })
            }
            Self::Postgres { worker, .. } => worker.get_project(id),
        }
    }

    fn get_knowledge_base(
        &self,
        id: &str,
    ) -> Result<Option<KnowledgeBaseRecord>, Box<dyn std::error::Error>> {
        match self {
            Self::Sqlite { connection, .. } => {
                let guard = connection
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                let raw = guard
                    .query_row(
                        "SELECT record_json FROM knowledge_bases WHERE id = ?1",
                        [id],
                        |row| row.get::<_, String>(0),
                    )
                    .optional()?;
                raw.map(|value| serde_json::from_str::<KnowledgeBaseRecord>(&value))
                    .transpose()
                    .map_err(|error| -> Box<dyn std::error::Error> { Box::new(error) })
            }
            Self::Postgres { worker, .. } => worker.get_knowledge_base(id),
        }
    }

    fn get_acp_connector(
        &self,
        id: &str,
    ) -> Result<Option<AcpConnectorRecord>, Box<dyn std::error::Error>> {
        match self {
            Self::Sqlite { connection, .. } => {
                let guard = connection
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                let raw = guard
                    .query_row(
                        "SELECT record_json FROM acp_connectors WHERE id = ?1",
                        [id],
                        |row| row.get::<_, String>(0),
                    )
                    .optional()?;
                raw.map(|value| serde_json::from_str::<AcpConnectorRecord>(&value))
                    .transpose()
                    .map_err(|error| -> Box<dyn std::error::Error> { Box::new(error) })
            }
            Self::Postgres { worker, .. } => worker.get_acp_connector(id),
        }
    }

    fn append_audit_record(
        &self,
        thread_id: &str,
        record: &AuditRecord,
    ) -> Result<(), Box<dyn std::error::Error>> {
        match self {
            Self::Sqlite { connection, .. } => {
                let guard = connection
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                append_sqlite_audit_record(&guard, thread_id, record)?;
                Ok(())
            }
            Self::Postgres { worker, .. } => worker.append_audit_record(thread_id, record),
        }
    }

    fn load_audit_records(
        &self,
        thread_id: &str,
        limit: usize,
    ) -> Result<Vec<AuditRecord>, Box<dyn std::error::Error>> {
        match self {
            Self::Sqlite { connection, .. } => {
                let guard = connection
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                load_sqlite_audit_records(&guard, thread_id, limit)
            }
            Self::Postgres { worker, .. } => worker.load_audit_records(thread_id, limit),
        }
    }

    fn load_latest_expert_panel_run_state(
        &self,
        thread_id: &str,
        run_id: &str,
    ) -> Result<Option<ExpertPanelRunResponse>, Box<dyn std::error::Error>> {
        match self {
            Self::Sqlite { connection, .. } => {
                let guard = connection
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                load_sqlite_latest_expert_panel_run_state(&guard, thread_id, run_id)
            }
            Self::Postgres { worker, .. } => {
                worker.load_latest_expert_panel_run_state(thread_id, run_id)
            }
        }
    }

    fn load_visible_memory_notes(
        &self,
        record: &ThreadRecord,
    ) -> Result<Vec<MemoryNote>, Box<dyn std::error::Error>> {
        self.load_memory_notes_for_scope(record, MemorySearchScope::All)
    }

    fn load_memory_notes_for_scope(
        &self,
        record: &ThreadRecord,
        scope: MemorySearchScope,
    ) -> Result<Vec<MemoryNote>, Box<dyn std::error::Error>> {
        match self {
            Self::Sqlite { connection, .. } => {
                let guard = connection
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                load_sqlite_memory_notes_for_scope(&guard, record, scope)
            }
            Self::Postgres { worker, .. } => worker.load_memory_notes_for_scope(record, scope),
        }
    }
}

fn apply_sqlite_migrations(
    connection: &mut SqliteConnection,
) -> Result<u32, Box<dyn std::error::Error>> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS clawd_meta (
            key TEXT PRIMARY KEY,
            value TEXT NOT NULL
        );",
    )?;
    let mut version = read_sqlite_schema_version(connection)?
        .unwrap_or(detect_legacy_sqlite_schema_version(connection)?);
    write_sqlite_schema_version(connection, version)?;
    while version < CURRENT_DATABASE_SCHEMA_VERSION {
        let next = version + 1;
        apply_sqlite_migration(connection, next)?;
        write_sqlite_schema_version(connection, next)?;
        version = next;
    }
    Ok(version)
}

fn detect_legacy_sqlite_schema_version(
    connection: &SqliteConnection,
) -> Result<u32, Box<dyn std::error::Error>> {
    let has_thread_records = sqlite_table_exists(connection, "thread_records")?;
    let has_memory_notes = sqlite_table_exists(connection, "memory_notes")?;
    let has_artifacts = sqlite_table_exists(connection, "artifact_records")?;
    let has_audit_records = sqlite_table_exists(connection, "audit_records")?;
    let has_api_keys = sqlite_table_exists(connection, "api_keys")?;
    let has_project_records = sqlite_table_exists(connection, "project_records")?;
    let has_knowledge_bases = sqlite_table_exists(connection, "knowledge_bases")?;
    let has_acp_connectors = sqlite_table_exists(connection, "acp_connectors")?;
    Ok(if has_acp_connectors {
        8
    } else if has_knowledge_bases {
        7
    } else if has_project_records {
        6
    } else if has_api_keys {
        5
    } else if has_audit_records {
        4
    } else if has_memory_notes || has_artifacts {
        2
    } else if has_thread_records {
        1
    } else {
        0
    })
}

fn sqlite_table_exists(
    connection: &SqliteConnection,
    table_name: &str,
) -> Result<bool, Box<dyn std::error::Error>> {
    let exists = connection
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1 LIMIT 1",
            [table_name],
            |_| Ok(()),
        )
        .optional()?
        .is_some();
    Ok(exists)
}

fn read_sqlite_schema_version(
    connection: &SqliteConnection,
) -> Result<Option<u32>, Box<dyn std::error::Error>> {
    let version = connection
        .query_row(
            "SELECT value FROM clawd_meta WHERE key = 'schema_version'",
            [],
            |row| row.get::<_, String>(0),
        )
        .optional()?;
    version
        .map(|value| value.parse::<u32>())
        .transpose()
        .map_err(|error| -> Box<dyn std::error::Error> { Box::new(error) })
}

fn write_sqlite_schema_version(
    connection: &SqliteConnection,
    version: u32,
) -> Result<(), Box<dyn std::error::Error>> {
    connection.execute(
        "INSERT INTO clawd_meta (key, value)
         VALUES ('schema_version', ?1)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value",
        [version.to_string()],
    )?;
    Ok(())
}

fn apply_sqlite_migration(
    connection: &mut SqliteConnection,
    version: u32,
) -> Result<(), Box<dyn std::error::Error>> {
    match version {
        1 => {
            connection.execute_batch(
                "CREATE TABLE IF NOT EXISTS thread_records (
                    id TEXT PRIMARY KEY,
                    owner_id TEXT NULL,
                    updated_at_ms INTEGER NOT NULL,
                    record_json TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_thread_records_owner_updated
                    ON thread_records (owner_id, updated_at_ms DESC);",
            )?;
        }
        2 => {
            connection.execute_batch(
                "CREATE TABLE IF NOT EXISTS memory_notes (
                    id TEXT PRIMARY KEY,
                    thread_id TEXT NOT NULL,
                    created_at_ms INTEGER NOT NULL,
                    note_json TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_memory_notes_thread_created
                    ON memory_notes (thread_id, created_at_ms ASC);
                CREATE TABLE IF NOT EXISTS artifact_records (
                    id TEXT PRIMARY KEY,
                    thread_id TEXT NOT NULL,
                    created_at_ms INTEGER NOT NULL,
                    artifact_json TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_artifact_records_thread_created
                    ON artifact_records (thread_id, created_at_ms ASC);",
            )?;
            backfill_sqlite_derived_tables(connection)?;
        }
        3 => {
            connection.execute_batch(
                "ALTER TABLE memory_notes ADD COLUMN scope TEXT NOT NULL DEFAULT 'thread';
                ALTER TABLE memory_notes ADD COLUMN owner_id TEXT NULL;
                ALTER TABLE memory_notes ADD COLUMN workspace_root TEXT NULL;
                CREATE INDEX IF NOT EXISTS idx_memory_notes_workspace_scope
                    ON memory_notes (owner_id, workspace_root, scope, created_at_ms ASC);",
            )?;
            backfill_sqlite_memory_note_dimensions(connection)?;
        }
        4 => {
            connection.execute_batch(
                "CREATE TABLE IF NOT EXISTS audit_records (
                    id TEXT PRIMARY KEY,
                    thread_id TEXT NOT NULL,
                    run_id INTEGER NULL,
                    kind TEXT NOT NULL,
                    created_at_ms INTEGER NOT NULL,
                    payload_json TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_audit_records_thread_created
                    ON audit_records (thread_id, created_at_ms DESC, id DESC);",
            )?;
        }
        5 => {
            connection.execute_batch(
                "ALTER TABLE thread_records ADD COLUMN tenant_id TEXT NULL;
                CREATE INDEX IF NOT EXISTS idx_thread_records_tenant_owner_updated
                    ON thread_records (tenant_id, owner_id, updated_at_ms DESC);
                ALTER TABLE memory_notes ADD COLUMN tenant_id TEXT NULL;
                CREATE INDEX IF NOT EXISTS idx_memory_notes_tenant_workspace_scope
                    ON memory_notes (tenant_id, owner_id, workspace_root, scope, created_at_ms ASC);
                CREATE TABLE IF NOT EXISTS api_keys (
                    id TEXT PRIMARY KEY,
                    tenant_id TEXT NOT NULL,
                    user_id TEXT NOT NULL,
                    display_name TEXT NULL,
                    key_prefix TEXT NOT NULL,
                    key_hash TEXT NOT NULL UNIQUE,
                    created_at_ms INTEGER NOT NULL,
                    updated_at_ms INTEGER NOT NULL,
                    last_used_at_ms INTEGER NULL,
                    disabled_at_ms INTEGER NULL
                );
                CREATE INDEX IF NOT EXISTS idx_api_keys_tenant_user
                    ON api_keys (tenant_id, user_id, created_at_ms DESC);",
            )?;
            backfill_sqlite_tenant_dimensions(connection)?;
        }
        6 => {
            connection.execute_batch(
                "CREATE TABLE IF NOT EXISTS project_records (
                    id TEXT PRIMARY KEY,
                    tenant_id TEXT NULL,
                    owner_id TEXT NULL,
                    updated_at_ms INTEGER NOT NULL,
                    record_json TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_project_records_tenant_owner_updated
                    ON project_records (tenant_id, owner_id, updated_at_ms DESC);",
            )?;
        }
        7 => {
            connection.execute_batch(
                "CREATE TABLE IF NOT EXISTS knowledge_bases (
                    id TEXT PRIMARY KEY,
                    tenant_id TEXT NULL,
                    owner_id TEXT NULL,
                    updated_at_ms INTEGER NOT NULL,
                    record_json TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_knowledge_bases_tenant_owner_updated
                    ON knowledge_bases (tenant_id, owner_id, updated_at_ms DESC);
                CREATE TABLE IF NOT EXISTS data_sources (
                    id TEXT PRIMARY KEY,
                    knowledge_base_id TEXT NOT NULL,
                    tenant_id TEXT NULL,
                    owner_id TEXT NULL,
                    updated_at_ms INTEGER NOT NULL,
                    record_json TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_data_sources_kb_updated
                    ON data_sources (knowledge_base_id, updated_at_ms DESC);",
            )?;
        }
        8 => {
            connection.execute_batch(
                "CREATE TABLE IF NOT EXISTS acp_connectors (
                    id TEXT PRIMARY KEY,
                    tenant_id TEXT NULL,
                    owner_id TEXT NULL,
                    project_id TEXT NULL,
                    knowledge_base_id TEXT NULL,
                    updated_at_ms INTEGER NOT NULL,
                    record_json TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_acp_connectors_tenant_owner_updated
                    ON acp_connectors (tenant_id, owner_id, updated_at_ms DESC);
                CREATE INDEX IF NOT EXISTS idx_acp_connectors_project_updated
                    ON acp_connectors (project_id, updated_at_ms DESC);
                CREATE INDEX IF NOT EXISTS idx_acp_connectors_kb_updated
                    ON acp_connectors (knowledge_base_id, updated_at_ms DESC);",
            )?;
        }
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
        other => {
            return Err(format!("unsupported sqlite schema migration {other}").into());
        }
    }
    Ok(())
}

fn agent_conversation_status_as_str(status: &AgentConversationStatus) -> &'static str {
    match status {
        AgentConversationStatus::Idle => "idle",
        AgentConversationStatus::Running => "running",
        AgentConversationStatus::Interrupted => "interrupted",
        AgentConversationStatus::Failed => "failed",
    }
}

fn agent_turn_status_as_str(status: &AgentTurnStatus) -> &'static str {
    match status {
        AgentTurnStatus::Queued => "queued",
        AgentTurnStatus::Running => "running",
        AgentTurnStatus::Succeeded => "succeeded",
        AgentTurnStatus::Interrupted => "interrupted",
        AgentTurnStatus::Failed => "failed",
    }
}

fn backfill_sqlite_derived_tables(
    connection: &mut SqliteConnection,
) -> Result<(), Box<dyn std::error::Error>> {
    let transaction = connection.transaction()?;
    let raw_records = {
        let mut statement = transaction.prepare("SELECT record_json FROM thread_records")?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
        let mut raw_records = Vec::new();
        for row in rows {
            raw_records.push(row?);
        }
        raw_records
    };
    for raw in raw_records {
        let record = serde_json::from_str::<ThreadRecord>(&raw)?;
        replace_sqlite_legacy_v2_derived_rows(&transaction, &record)?;
    }
    transaction.commit()?;
    Ok(())
}

fn backfill_sqlite_memory_note_dimensions(
    connection: &mut SqliteConnection,
) -> Result<(), Box<dyn std::error::Error>> {
    let transaction = connection.transaction()?;
    let rows = {
        let mut statement =
            transaction.prepare("SELECT id, owner_id, record_json FROM thread_records")?;
        let rows = statement.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, String>(2)?,
            ))
        })?;
        let mut items = Vec::new();
        for row in rows {
            items.push(row?);
        }
        items
    };
    for row in rows {
        let (thread_id, owner_id, raw) = row;
        let record = serde_json::from_str::<ThreadRecord>(&raw)?;
        let workspace_root = record.workspace_root.display().to_string();
        for note in record.memory_notes {
            transaction.execute(
                "UPDATE memory_notes
                 SET scope = ?1, owner_id = ?2, workspace_root = ?3
                 WHERE id = ?4 AND thread_id = ?5",
                rusqlite::params![
                    note.scope.as_str(),
                    owner_id.as_deref(),
                    &workspace_root,
                    &note.id,
                    &thread_id
                ],
            )?;
        }
    }
    transaction.commit()?;
    Ok(())
}

fn backfill_sqlite_tenant_dimensions(
    connection: &mut SqliteConnection,
) -> Result<(), Box<dyn std::error::Error>> {
    let transaction = connection.transaction()?;
    let rows = {
        let mut statement = transaction.prepare("SELECT id, record_json FROM thread_records")?;
        let rows = statement.query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })?;
        let mut items = Vec::new();
        for row in rows {
            items.push(row?);
        }
        items
    };
    for (thread_id, raw) in rows {
        let record = serde_json::from_str::<ThreadRecord>(&raw)?;
        transaction.execute(
            "UPDATE thread_records SET tenant_id = ?1 WHERE id = ?2",
            rusqlite::params![record.tenant_id.as_deref(), &thread_id],
        )?;
        transaction.execute(
            "UPDATE memory_notes
             SET tenant_id = ?1
             WHERE thread_id = ?2",
            rusqlite::params![record.tenant_id.as_deref(), &thread_id],
        )?;
    }
    transaction.commit()?;
    Ok(())
}

fn replace_sqlite_derived_rows(
    transaction: &rusqlite::Transaction<'_>,
    record: &ThreadRecord,
) -> Result<(), Box<dyn std::error::Error>> {
    let tenant_id = record.tenant_id.as_deref();
    let owner_id = record.owner_id.as_deref();
    let workspace_root = record.workspace_root.display().to_string();
    transaction.execute(
        "DELETE FROM memory_notes WHERE thread_id = ?1",
        [&record.id],
    )?;
    for note in &record.memory_notes {
        transaction.execute(
            "INSERT INTO memory_notes (
                id,
                thread_id,
                created_at_ms,
                tenant_id,
                scope,
                owner_id,
                workspace_root,
                note_json
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            rusqlite::params![
                &note.id,
                &record.id,
                i64::try_from(note.created_at_ms)?,
                tenant_id,
                note.scope.as_str(),
                owner_id,
                &workspace_root,
                serde_json::to_string(note)?
            ],
        )?;
    }

    transaction.execute(
        "DELETE FROM artifact_records WHERE thread_id = ?1",
        [&record.id],
    )?;
    for artifact in &record.artifacts {
        transaction.execute(
            "INSERT INTO artifact_records (id, thread_id, created_at_ms, artifact_json)
             VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![
                &artifact.id,
                &record.id,
                i64::try_from(artifact.created_at_ms)?,
                serde_json::to_string(artifact)?
            ],
        )?;
    }
    Ok(())
}

fn replace_sqlite_legacy_v2_derived_rows(
    transaction: &rusqlite::Transaction<'_>,
    record: &ThreadRecord,
) -> Result<(), Box<dyn std::error::Error>> {
    transaction.execute(
        "DELETE FROM memory_notes WHERE thread_id = ?1",
        [&record.id],
    )?;
    for note in &record.memory_notes {
        transaction.execute(
            "INSERT INTO memory_notes (id, thread_id, created_at_ms, note_json)
             VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![
                &note.id,
                &record.id,
                i64::try_from(note.created_at_ms)?,
                serde_json::to_string(note)?
            ],
        )?;
    }

    transaction.execute(
        "DELETE FROM artifact_records WHERE thread_id = ?1",
        [&record.id],
    )?;
    for artifact in &record.artifacts {
        transaction.execute(
            "INSERT INTO artifact_records (id, thread_id, created_at_ms, artifact_json)
             VALUES (?1, ?2, ?3, ?4)",
            rusqlite::params![
                &artifact.id,
                &record.id,
                i64::try_from(artifact.created_at_ms)?,
                serde_json::to_string(artifact)?
            ],
        )?;
    }
    Ok(())
}

fn load_sqlite_memory_notes(
    connection: &SqliteConnection,
    thread_id: &str,
) -> Result<Vec<MemoryNote>, Box<dyn std::error::Error>> {
    let mut statement = connection.prepare(
        "SELECT note_json FROM memory_notes WHERE thread_id = ?1 ORDER BY created_at_ms ASC, id ASC",
    )?;
    let rows = statement.query_map([thread_id], |row| row.get::<_, String>(0))?;
    let mut notes = Vec::new();
    for row in rows {
        notes.push(serde_json::from_str::<MemoryNote>(&row?)?);
    }
    Ok(notes)
}

fn load_sqlite_memory_notes_for_scope(
    connection: &SqliteConnection,
    record: &ThreadRecord,
    scope: MemorySearchScope,
) -> Result<Vec<MemoryNote>, Box<dyn std::error::Error>> {
    match scope {
        MemorySearchScope::Thread => load_sqlite_memory_notes_by_thread_and_scope(
            connection,
            &record.id,
            MemoryScope::Thread,
        ),
        MemorySearchScope::Workspace => load_sqlite_workspace_memory_notes(connection, record),
        MemorySearchScope::Tenant => load_sqlite_tenant_memory_notes(connection, record),
        MemorySearchScope::All => {
            let mut notes = load_sqlite_memory_notes_by_thread_and_scope(
                connection,
                &record.id,
                MemoryScope::Thread,
            )?;
            notes.extend(load_sqlite_workspace_memory_notes(connection, record)?);
            notes.extend(load_sqlite_tenant_memory_notes(connection, record)?);
            Ok(dedupe_and_sort_memory_notes(notes))
        }
    }
}

fn load_sqlite_memory_notes_by_thread_and_scope(
    connection: &SqliteConnection,
    thread_id: &str,
    scope: MemoryScope,
) -> Result<Vec<MemoryNote>, Box<dyn std::error::Error>> {
    let mut statement = connection.prepare(
        "SELECT note_json FROM memory_notes
         WHERE thread_id = ?1 AND scope = ?2
         ORDER BY created_at_ms ASC, id ASC",
    )?;
    let rows = statement.query_map([thread_id, scope.as_str()], |row| row.get::<_, String>(0))?;
    let mut notes = Vec::new();
    for row in rows {
        notes.push(serde_json::from_str::<MemoryNote>(&row?)?);
    }
    Ok(notes)
}

fn load_sqlite_workspace_memory_notes(
    connection: &SqliteConnection,
    record: &ThreadRecord,
) -> Result<Vec<MemoryNote>, Box<dyn std::error::Error>> {
    let workspace_root = record.workspace_root.display().to_string();
    let mut notes = Vec::new();
    if let Some(owner_id) = record.owner_id.as_deref() {
        let tenant_id = record.tenant_id.as_deref();
        let mut statement = connection.prepare(
            "SELECT note_json FROM memory_notes
             WHERE scope = 'workspace' AND tenant_id IS ?1 AND owner_id = ?2 AND workspace_root = ?3
             ORDER BY created_at_ms ASC, id ASC",
        )?;
        let rows = statement.query_map(
            rusqlite::params![tenant_id, owner_id, workspace_root.as_str()],
            |row| row.get::<_, String>(0),
        )?;
        for row in rows {
            notes.push(serde_json::from_str::<MemoryNote>(&row?)?);
        }
    } else {
        let tenant_id = record.tenant_id.as_deref();
        let mut statement = connection.prepare(
            "SELECT note_json FROM memory_notes
             WHERE scope = 'workspace' AND tenant_id IS ?1 AND owner_id IS NULL AND workspace_root = ?2
             ORDER BY created_at_ms ASC, id ASC",
        )?;
        let rows = statement.query_map(
            rusqlite::params![tenant_id, workspace_root.as_str()],
            |row| row.get::<_, String>(0),
        )?;
        for row in rows {
            notes.push(serde_json::from_str::<MemoryNote>(&row?)?);
        }
    }
    Ok(notes)
}

fn load_sqlite_tenant_memory_notes(
    connection: &SqliteConnection,
    record: &ThreadRecord,
) -> Result<Vec<MemoryNote>, Box<dyn std::error::Error>> {
    let Some(tenant_id) = record.tenant_id.as_deref() else {
        return Ok(Vec::new());
    };
    let mut statement = connection.prepare(
        "SELECT note_json FROM memory_notes
         WHERE scope = 'tenant' AND tenant_id = ?1
         ORDER BY created_at_ms ASC, id ASC",
    )?;
    let rows = statement.query_map([tenant_id], |row| row.get::<_, String>(0))?;
    let mut notes = Vec::new();
    for row in rows {
        notes.push(serde_json::from_str::<MemoryNote>(&row?)?);
    }
    Ok(notes)
}

fn dedupe_and_sort_memory_notes(mut notes: Vec<MemoryNote>) -> Vec<MemoryNote> {
    notes.sort_by_key(|note| (note.created_at_ms, note.id.clone()));
    let mut seen = BTreeSet::new();
    notes
        .into_iter()
        .filter(|note| seen.insert(note.id.clone()))
        .collect()
}

fn load_sqlite_artifacts(
    connection: &SqliteConnection,
    thread_id: &str,
) -> Result<Vec<ArtifactRecord>, Box<dyn std::error::Error>> {
    let mut statement = connection.prepare(
        "SELECT artifact_json FROM artifact_records
         WHERE thread_id = ?1
         ORDER BY created_at_ms ASC, id ASC",
    )?;
    let rows = statement.query_map([thread_id], |row| row.get::<_, String>(0))?;
    let mut artifacts = Vec::new();
    for row in rows {
        artifacts.push(serde_json::from_str::<ArtifactRecord>(&row?)?);
    }
    Ok(artifacts)
}

fn append_sqlite_audit_record(
    connection: &SqliteConnection,
    thread_id: &str,
    record: &AuditRecord,
) -> Result<(), Box<dyn std::error::Error>> {
    connection.execute(
        "INSERT INTO audit_records (id, thread_id, run_id, kind, created_at_ms, payload_json)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6)",
        rusqlite::params![
            &record.id,
            thread_id,
            record.run_id.map(i64::try_from).transpose()?,
            &record.kind,
            i64::try_from(record.created_at_ms)?,
            serde_json::to_string(&record.payload)?,
        ],
    )?;
    Ok(())
}

fn load_sqlite_audit_records(
    connection: &SqliteConnection,
    thread_id: &str,
    limit: usize,
) -> Result<Vec<AuditRecord>, Box<dyn std::error::Error>> {
    let mut statement = connection.prepare(
        "SELECT id, run_id, kind, created_at_ms, payload_json
         FROM (
            SELECT id, run_id, kind, created_at_ms, payload_json
            FROM audit_records
            WHERE thread_id = ?1
            ORDER BY created_at_ms DESC, id DESC
            LIMIT ?2
         )
         ORDER BY created_at_ms ASC, id ASC",
    )?;
    let rows = statement.query_map(rusqlite::params![thread_id, i64::try_from(limit)?], |row| {
        Ok((
            row.get::<_, String>(0)?,
            row.get::<_, Option<i64>>(1)?,
            row.get::<_, String>(2)?,
            row.get::<_, i64>(3)?,
            row.get::<_, String>(4)?,
        ))
    })?;
    let mut records = Vec::new();
    for row in rows {
        let (id, run_id, kind, created_at_ms, payload_json) = row?;
        records.push(AuditRecord {
            id,
            run_id: run_id.map(u64::try_from).transpose()?,
            kind,
            created_at_ms: u64::try_from(created_at_ms)?,
            payload: serde_json::from_str(&payload_json)?,
        });
    }
    Ok(records)
}

fn load_sqlite_latest_expert_panel_run_state(
    connection: &SqliteConnection,
    thread_id: &str,
    run_id: &str,
) -> Result<Option<ExpertPanelRunResponse>, Box<dyn std::error::Error>> {
    let mut statement = connection.prepare(
        "SELECT payload_json
         FROM audit_records
         WHERE thread_id = ?1 AND kind = 'expert_panel_run_state'
         ORDER BY created_at_ms DESC, id DESC",
    )?;
    let rows = statement.query_map([thread_id], |row| row.get::<_, String>(0))?;
    for row in rows {
        let payload_json = row?;
        let response = serde_json::from_str::<ExpertPanelRunResponse>(&payload_json)?;
        if response.run_id == run_id {
            return Ok(Some(response));
        }
    }
    Ok(None)
}

fn upsert_sqlite_api_key(
    connection: &SqliteConnection,
    record: &ApiKeyRecord,
) -> Result<(), Box<dyn std::error::Error>> {
    connection.execute(
        "INSERT INTO api_keys (
            id,
            tenant_id,
            user_id,
            display_name,
            key_prefix,
            key_hash,
            created_at_ms,
            updated_at_ms,
            last_used_at_ms,
            disabled_at_ms
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
         ON CONFLICT(key_hash) DO UPDATE SET
            tenant_id = excluded.tenant_id,
            user_id = excluded.user_id,
            display_name = excluded.display_name,
            key_prefix = excluded.key_prefix,
            updated_at_ms = excluded.updated_at_ms,
            disabled_at_ms = excluded.disabled_at_ms",
        rusqlite::params![
            &record.id,
            &record.tenant_id,
            &record.user_id,
            &record.display_name,
            &record.key_prefix,
            &record.key_hash,
            i64::try_from(record.created_at_ms)?,
            i64::try_from(record.updated_at_ms)?,
            record.last_used_at_ms.map(i64::try_from).transpose()?,
            record.disabled_at_ms.map(i64::try_from).transpose()?,
        ],
    )?;
    Ok(())
}

fn sqlite_api_key_record_from_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<ApiKeyRecord> {
    Ok(ApiKeyRecord {
        id: row.get::<_, String>(0)?,
        tenant_id: row.get::<_, String>(1)?,
        user_id: row.get::<_, String>(2)?,
        display_name: row.get::<_, Option<String>>(3)?,
        key_prefix: row.get::<_, String>(4)?,
        key_hash: row.get::<_, String>(5)?,
        created_at_ms: u64::try_from(row.get::<_, i64>(6)?).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                6,
                rusqlite::types::Type::Integer,
                Box::new(error),
            )
        })?,
        updated_at_ms: u64::try_from(row.get::<_, i64>(7)?).map_err(|error| {
            rusqlite::Error::FromSqlConversionFailure(
                7,
                rusqlite::types::Type::Integer,
                Box::new(error),
            )
        })?,
        last_used_at_ms: row
            .get::<_, Option<i64>>(8)?
            .map(u64::try_from)
            .transpose()
            .map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    8,
                    rusqlite::types::Type::Integer,
                    Box::new(error),
                )
            })?,
        disabled_at_ms: row
            .get::<_, Option<i64>>(9)?
            .map(u64::try_from)
            .transpose()
            .map_err(|error| {
                rusqlite::Error::FromSqlConversionFailure(
                    9,
                    rusqlite::types::Type::Integer,
                    Box::new(error),
                )
            })?,
    })
}

fn authenticate_sqlite_api_key(
    connection: &SqliteConnection,
    key_hash: &str,
    now_ms: u64,
) -> Result<Option<ApiKeyRecord>, Box<dyn std::error::Error>> {
    let mut statement = connection.prepare(
        "SELECT id, tenant_id, user_id, display_name, key_prefix, key_hash, created_at_ms, updated_at_ms, last_used_at_ms, disabled_at_ms
         FROM api_keys
         WHERE key_hash = ?1 AND disabled_at_ms IS NULL
         LIMIT 1",
    )?;
    let record = statement
        .query_row([key_hash], sqlite_api_key_record_from_row)
        .optional()?;
    if record.is_some() {
        connection.execute(
            "UPDATE api_keys SET last_used_at_ms = ?1 WHERE key_hash = ?2",
            rusqlite::params![i64::try_from(now_ms)?, key_hash],
        )?;
    }
    Ok(record.map(|mut record| {
        record.last_used_at_ms = Some(now_ms);
        record
    }))
}

fn list_sqlite_api_keys(
    connection: &SqliteConnection,
    tenant_id: &str,
    user_id: &str,
) -> Result<Vec<ApiKeyRecord>, Box<dyn std::error::Error>> {
    let mut statement = connection.prepare(
        "SELECT id, tenant_id, user_id, display_name, key_prefix, key_hash, created_at_ms, updated_at_ms, last_used_at_ms, disabled_at_ms
         FROM api_keys
         WHERE tenant_id = ?1 AND user_id = ?2
         ORDER BY created_at_ms DESC, id DESC",
    )?;
    let rows = statement.query_map(
        rusqlite::params![tenant_id, user_id],
        sqlite_api_key_record_from_row,
    )?;
    let mut records = Vec::new();
    for row in rows {
        records.push(row?);
    }
    Ok(records)
}

fn disable_sqlite_api_key(
    connection: &SqliteConnection,
    id: &str,
    tenant_id: &str,
    user_id: &str,
    now_ms: u64,
) -> Result<bool, Box<dyn std::error::Error>> {
    let updated = connection.execute(
        "UPDATE api_keys
         SET updated_at_ms = ?1, disabled_at_ms = ?1
         WHERE id = ?2 AND tenant_id = ?3 AND user_id = ?4 AND disabled_at_ms IS NULL",
        rusqlite::params![i64::try_from(now_ms)?, id, tenant_id, user_id],
    )?;
    Ok(updated > 0)
}

async fn apply_postgres_migrations(
    client: &mut PostgresClient,
) -> Result<u32, Box<dyn std::error::Error>> {
    client
        .batch_execute(
            "CREATE TABLE IF NOT EXISTS clawd_meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );",
        )
        .await?;
    let mut version = read_postgres_schema_version(client)
        .await?
        .unwrap_or(detect_legacy_postgres_schema_version(client).await?);
    write_postgres_schema_version(client, version).await?;
    while version < CURRENT_DATABASE_SCHEMA_VERSION {
        let next = version + 1;
        apply_postgres_migration(client, next).await?;
        write_postgres_schema_version(client, next).await?;
        version = next;
    }
    Ok(version)
}

async fn detect_legacy_postgres_schema_version(
    client: &PostgresClient,
) -> Result<u32, Box<dyn std::error::Error>> {
    let has_thread_records = postgres_table_exists(client, "thread_records").await?;
    let has_memory_notes = postgres_table_exists(client, "memory_notes").await?;
    let has_artifacts = postgres_table_exists(client, "artifact_records").await?;
    let has_audit_records = postgres_table_exists(client, "audit_records").await?;
    let has_api_keys = postgres_table_exists(client, "api_keys").await?;
    let has_project_records = postgres_table_exists(client, "project_records").await?;
    let has_knowledge_bases = postgres_table_exists(client, "knowledge_bases").await?;
    let has_acp_connectors = postgres_table_exists(client, "acp_connectors").await?;
    Ok(if has_acp_connectors {
        8
    } else if has_knowledge_bases {
        7
    } else if has_project_records {
        6
    } else if has_api_keys {
        5
    } else if has_audit_records {
        4
    } else if has_memory_notes || has_artifacts {
        2
    } else if has_thread_records {
        1
    } else {
        0
    })
}

async fn postgres_table_exists(
    client: &PostgresClient,
    table_name: &str,
) -> Result<bool, Box<dyn std::error::Error>> {
    let exists: bool = client
        .query_one(
            "SELECT EXISTS (
                SELECT 1
                FROM information_schema.tables
                WHERE table_schema = current_schema()
                  AND table_name = $1
            )",
            &[&table_name],
        )
        .await?
        .get(0);
    Ok(exists)
}

async fn read_postgres_schema_version(
    client: &PostgresClient,
) -> Result<Option<u32>, Box<dyn std::error::Error>> {
    client
        .query_opt(
            "SELECT value FROM clawd_meta WHERE key = 'schema_version'",
            &[],
        )
        .await?
        .map(|row| {
            row.get::<_, String>(0)
                .parse::<u32>()
                .map_err(|error| -> Box<dyn std::error::Error> { Box::new(error) })
        })
        .transpose()
}

async fn write_postgres_schema_version(
    client: &PostgresClient,
    version: u32,
) -> Result<(), Box<dyn std::error::Error>> {
    let value = version.to_string();
    client
        .execute(
            "INSERT INTO clawd_meta (key, value)
             VALUES ('schema_version', $1)
             ON CONFLICT(key) DO UPDATE SET value = EXCLUDED.value",
            &[&value],
        )
        .await?;
    Ok(())
}

async fn apply_postgres_migration(
    client: &mut PostgresClient,
    version: u32,
) -> Result<(), Box<dyn std::error::Error>> {
    match version {
        1 => {
            client
                .batch_execute(
                    "CREATE TABLE IF NOT EXISTS thread_records (
                        id TEXT PRIMARY KEY,
                        owner_id TEXT NULL,
                        updated_at_ms BIGINT NOT NULL,
                        record_json TEXT NOT NULL
                    );
                    CREATE INDEX IF NOT EXISTS idx_thread_records_owner_updated
                        ON thread_records (owner_id, updated_at_ms DESC);",
                )
                .await?;
        }
        2 => {
            client
                .batch_execute(
                    "CREATE TABLE IF NOT EXISTS memory_notes (
                        id TEXT PRIMARY KEY,
                        thread_id TEXT NOT NULL,
                        created_at_ms BIGINT NOT NULL,
                        note_json TEXT NOT NULL
                    );
                    CREATE INDEX IF NOT EXISTS idx_memory_notes_thread_created
                        ON memory_notes (thread_id, created_at_ms ASC);
                    CREATE TABLE IF NOT EXISTS artifact_records (
                        id TEXT PRIMARY KEY,
                        thread_id TEXT NOT NULL,
                        created_at_ms BIGINT NOT NULL,
                        artifact_json TEXT NOT NULL
                    );
                    CREATE INDEX IF NOT EXISTS idx_artifact_records_thread_created
                        ON artifact_records (thread_id, created_at_ms ASC);",
                )
                .await?;
            backfill_postgres_derived_tables(client).await?;
        }
        3 => {
            client
                .batch_execute(
                    "ALTER TABLE memory_notes ADD COLUMN scope TEXT NOT NULL DEFAULT 'thread';
                    ALTER TABLE memory_notes ADD COLUMN owner_id TEXT NULL;
                    ALTER TABLE memory_notes ADD COLUMN workspace_root TEXT NULL;
                    CREATE INDEX IF NOT EXISTS idx_memory_notes_workspace_scope
                        ON memory_notes (owner_id, workspace_root, scope, created_at_ms ASC);",
                )
                .await?;
            backfill_postgres_memory_note_dimensions(client).await?;
        }
        4 => {
            client
                .batch_execute(
                    "CREATE TABLE IF NOT EXISTS audit_records (
                        id TEXT PRIMARY KEY,
                        thread_id TEXT NOT NULL,
                        run_id BIGINT NULL,
                        kind TEXT NOT NULL,
                        created_at_ms BIGINT NOT NULL,
                        payload_json TEXT NOT NULL
                    );
                    CREATE INDEX IF NOT EXISTS idx_audit_records_thread_created
                        ON audit_records (thread_id, created_at_ms DESC, id DESC);",
                )
                .await?;
        }
        5 => {
            client
                .batch_execute(
                    "ALTER TABLE thread_records ADD COLUMN tenant_id TEXT NULL;
                    CREATE INDEX IF NOT EXISTS idx_thread_records_tenant_owner_updated
                        ON thread_records (tenant_id, owner_id, updated_at_ms DESC);
                    ALTER TABLE memory_notes ADD COLUMN tenant_id TEXT NULL;
                    CREATE INDEX IF NOT EXISTS idx_memory_notes_tenant_workspace_scope
                        ON memory_notes (tenant_id, owner_id, workspace_root, scope, created_at_ms ASC);
                    CREATE TABLE IF NOT EXISTS api_keys (
                        id TEXT PRIMARY KEY,
                        tenant_id TEXT NOT NULL,
                        user_id TEXT NOT NULL,
                        display_name TEXT NULL,
                        key_prefix TEXT NOT NULL,
                        key_hash TEXT NOT NULL UNIQUE,
                        created_at_ms BIGINT NOT NULL,
                        updated_at_ms BIGINT NOT NULL,
                        last_used_at_ms BIGINT NULL,
                        disabled_at_ms BIGINT NULL
                    );
                    CREATE INDEX IF NOT EXISTS idx_api_keys_tenant_user
                        ON api_keys (tenant_id, user_id, created_at_ms DESC);",
                )
                .await?;
            backfill_postgres_tenant_dimensions(client).await?;
        }
        6 => {
            client
                .batch_execute(
                    "CREATE TABLE IF NOT EXISTS project_records (
                        id TEXT PRIMARY KEY,
                        tenant_id TEXT NULL,
                        owner_id TEXT NULL,
                        updated_at_ms BIGINT NOT NULL,
                        record_json TEXT NOT NULL
                    );
                    CREATE INDEX IF NOT EXISTS idx_project_records_tenant_owner_updated
                        ON project_records (tenant_id, owner_id, updated_at_ms DESC);",
                )
                .await?;
        }
        7 => {
            client
                .batch_execute(
                    "CREATE TABLE IF NOT EXISTS knowledge_bases (
                        id TEXT PRIMARY KEY,
                        tenant_id TEXT NULL,
                        owner_id TEXT NULL,
                        updated_at_ms BIGINT NOT NULL,
                        record_json TEXT NOT NULL
                    );
                    CREATE INDEX IF NOT EXISTS idx_knowledge_bases_tenant_owner_updated
                        ON knowledge_bases (tenant_id, owner_id, updated_at_ms DESC);
                    CREATE TABLE IF NOT EXISTS data_sources (
                        id TEXT PRIMARY KEY,
                        knowledge_base_id TEXT NOT NULL,
                        tenant_id TEXT NULL,
                        owner_id TEXT NULL,
                        updated_at_ms BIGINT NOT NULL,
                        record_json TEXT NOT NULL
                    );
                    CREATE INDEX IF NOT EXISTS idx_data_sources_kb_updated
                        ON data_sources (knowledge_base_id, updated_at_ms DESC);",
                )
                .await?;
        }
        8 => {
            client
                .batch_execute(
                    "CREATE TABLE IF NOT EXISTS acp_connectors (
                        id TEXT PRIMARY KEY,
                        tenant_id TEXT NULL,
                        owner_id TEXT NULL,
                        project_id TEXT NULL,
                        knowledge_base_id TEXT NULL,
                        updated_at_ms BIGINT NOT NULL,
                        record_json TEXT NOT NULL
                    );
                    CREATE INDEX IF NOT EXISTS idx_acp_connectors_tenant_owner_updated
                        ON acp_connectors (tenant_id, owner_id, updated_at_ms DESC);
                    CREATE INDEX IF NOT EXISTS idx_acp_connectors_project_updated
                        ON acp_connectors (project_id, updated_at_ms DESC);
                    CREATE INDEX IF NOT EXISTS idx_acp_connectors_kb_updated
                        ON acp_connectors (knowledge_base_id, updated_at_ms DESC);",
                )
                .await?;
        }
        9 => {
            client
                .batch_execute(
                    "CREATE TABLE IF NOT EXISTS agent_conversations (
                        id TEXT PRIMARY KEY,
                        tenant_id TEXT NULL,
                        owner_id TEXT NOT NULL,
                        status TEXT NOT NULL,
                        updated_at_ms BIGINT NOT NULL,
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
                        started_at_ms BIGINT NOT NULL,
                        completed_at_ms BIGINT NULL,
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
                        created_at_ms BIGINT NOT NULL,
                        payload_json TEXT NOT NULL
                    );
                    CREATE INDEX IF NOT EXISTS idx_ag_ui_events_turn_created
                        ON ag_ui_events (turn_id, created_at_ms ASC, id ASC);",
                )
                .await?;
        }
        other => {
            return Err(format!("unsupported postgres schema migration {other}").into());
        }
    }
    Ok(())
}

async fn backfill_postgres_derived_tables(
    client: &mut PostgresClient,
) -> Result<(), Box<dyn std::error::Error>> {
    let transaction = client.transaction().await?;
    let raw_records = transaction
        .query("SELECT record_json FROM thread_records", &[])
        .await?;
    for row in raw_records {
        let raw: String = row.get(0);
        let record = serde_json::from_str::<ThreadRecord>(&raw)?;
        replace_postgres_legacy_v2_derived_rows(&transaction, &record).await?;
    }
    transaction.commit().await?;
    Ok(())
}

async fn backfill_postgres_memory_note_dimensions(
    client: &mut PostgresClient,
) -> Result<(), Box<dyn std::error::Error>> {
    let transaction = client.transaction().await?;
    let rows = transaction
        .query("SELECT id, owner_id, record_json FROM thread_records", &[])
        .await?;
    for row in rows {
        let thread_id: String = row.get(0);
        let owner_id: Option<String> = row.get(1);
        let raw: String = row.get(2);
        let record = serde_json::from_str::<ThreadRecord>(&raw)?;
        let workspace_root = record.workspace_root.display().to_string();
        for note in record.memory_notes {
            transaction
                .execute(
                    "UPDATE memory_notes
                     SET scope = $1, owner_id = $2, workspace_root = $3
                     WHERE id = $4 AND thread_id = $5",
                    &[
                        &note.scope.as_str(),
                        &owner_id,
                        &workspace_root,
                        &note.id,
                        &thread_id,
                    ],
                )
                .await?;
        }
    }
    transaction.commit().await?;
    Ok(())
}

async fn backfill_postgres_tenant_dimensions(
    client: &mut PostgresClient,
) -> Result<(), Box<dyn std::error::Error>> {
    let transaction = client.transaction().await?;
    let rows = transaction
        .query("SELECT id, record_json FROM thread_records", &[])
        .await?;
    for row in rows {
        let thread_id: String = row.get(0);
        let raw: String = row.get(1);
        let record = serde_json::from_str::<ThreadRecord>(&raw)?;
        transaction
            .execute(
                "UPDATE thread_records SET tenant_id = $1 WHERE id = $2",
                &[&record.tenant_id, &thread_id],
            )
            .await?;
        transaction
            .execute(
                "UPDATE memory_notes SET tenant_id = $1 WHERE thread_id = $2",
                &[&record.tenant_id, &thread_id],
            )
            .await?;
    }
    transaction.commit().await?;
    Ok(())
}

async fn replace_postgres_derived_rows(
    transaction: &PostgresTransaction<'_>,
    record: &ThreadRecord,
) -> Result<(), Box<dyn std::error::Error>> {
    let workspace_root = record.workspace_root.display().to_string();
    transaction
        .execute(
            "DELETE FROM memory_notes WHERE thread_id = $1",
            &[&record.id],
        )
        .await?;
    for note in &record.memory_notes {
        let created_at_ms = i64::try_from(note.created_at_ms)?;
        let raw = serde_json::to_string(note)?;
        transaction
            .execute(
                "INSERT INTO memory_notes (
                    id,
                    thread_id,
                    created_at_ms,
                    tenant_id,
                    scope,
                    owner_id,
                    workspace_root,
                    note_json
                 ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)",
                &[
                    &note.id,
                    &record.id,
                    &created_at_ms,
                    &record.tenant_id,
                    &note.scope.as_str(),
                    &record.owner_id,
                    &workspace_root,
                    &raw,
                ],
            )
            .await?;
    }

    transaction
        .execute(
            "DELETE FROM artifact_records WHERE thread_id = $1",
            &[&record.id],
        )
        .await?;
    for artifact in &record.artifacts {
        let created_at_ms = i64::try_from(artifact.created_at_ms)?;
        let raw = serde_json::to_string(artifact)?;
        transaction
            .execute(
                "INSERT INTO artifact_records (id, thread_id, created_at_ms, artifact_json)
                 VALUES ($1, $2, $3, $4)",
                &[&artifact.id, &record.id, &created_at_ms, &raw],
            )
            .await?;
    }
    Ok(())
}

async fn replace_postgres_legacy_v2_derived_rows(
    transaction: &PostgresTransaction<'_>,
    record: &ThreadRecord,
) -> Result<(), Box<dyn std::error::Error>> {
    transaction
        .execute(
            "DELETE FROM memory_notes WHERE thread_id = $1",
            &[&record.id],
        )
        .await?;
    for note in &record.memory_notes {
        let created_at_ms = i64::try_from(note.created_at_ms)?;
        let raw = serde_json::to_string(note)?;
        transaction
            .execute(
                "INSERT INTO memory_notes (id, thread_id, created_at_ms, note_json)
                 VALUES ($1, $2, $3, $4)",
                &[&note.id, &record.id, &created_at_ms, &raw],
            )
            .await?;
    }

    transaction
        .execute(
            "DELETE FROM artifact_records WHERE thread_id = $1",
            &[&record.id],
        )
        .await?;
    for artifact in &record.artifacts {
        let created_at_ms = i64::try_from(artifact.created_at_ms)?;
        let raw = serde_json::to_string(artifact)?;
        transaction
            .execute(
                "INSERT INTO artifact_records (id, thread_id, created_at_ms, artifact_json)
                 VALUES ($1, $2, $3, $4)",
                &[&artifact.id, &record.id, &created_at_ms, &raw],
            )
            .await?;
    }
    Ok(())
}

async fn postgres_upsert_record(
    client: &mut PostgresClient,
    record: &ThreadRecord,
) -> Result<(), Box<dyn std::error::Error>> {
    let tenant_id = record.tenant_id.clone();
    let owner_id = record.owner_id.clone();
    let updated_at_ms = i64::try_from(record.updated_at_ms)?;
    let record_json = serde_json::to_string(record)?;
    let transaction = client.transaction().await?;
    transaction
        .execute(
            "INSERT INTO thread_records (id, tenant_id, owner_id, updated_at_ms, record_json)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT(id) DO UPDATE SET
               tenant_id = EXCLUDED.tenant_id,
               owner_id = EXCLUDED.owner_id,
               updated_at_ms = EXCLUDED.updated_at_ms,
               record_json = EXCLUDED.record_json",
            &[
                &record.id,
                &tenant_id,
                &owner_id,
                &updated_at_ms,
                &record_json,
            ],
        )
        .await?;
    replace_postgres_derived_rows(&transaction, record).await?;
    transaction.commit().await?;
    Ok(())
}

async fn postgres_load_records(
    client: &PostgresClient,
) -> Result<Vec<ThreadRecord>, Box<dyn std::error::Error>> {
    let rows = client
        .query(
            "SELECT id, record_json FROM thread_records ORDER BY updated_at_ms DESC",
            &[],
        )
        .await?;
    let mut records = Vec::new();
    for row in rows {
        let id: String = row.get(0);
        let raw: String = row.get(1);
        let mut record = serde_json::from_str::<ThreadRecord>(&raw)?;
        let memory_notes = load_postgres_memory_notes(client, &id).await?;
        if !memory_notes.is_empty() || record.memory_notes.is_empty() {
            record.memory_notes = memory_notes;
        }
        let artifacts = load_postgres_artifacts(client, &id).await?;
        if !artifacts.is_empty() || record.artifacts.is_empty() {
            record.artifacts = artifacts;
        }
        records.push(record);
    }
    Ok(records)
}

async fn postgres_upsert_project(
    client: &PostgresClient,
    record: &ProjectRecord,
) -> Result<(), Box<dyn std::error::Error>> {
    let updated_at_ms = i64::try_from(record.updated_at_ms)?;
    let record_json = serde_json::to_string(record)?;
    client
        .execute(
            "INSERT INTO project_records (id, tenant_id, owner_id, updated_at_ms, record_json)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT(id) DO UPDATE SET
               tenant_id = EXCLUDED.tenant_id,
               owner_id = EXCLUDED.owner_id,
               updated_at_ms = EXCLUDED.updated_at_ms,
               record_json = EXCLUDED.record_json",
            &[
                &record.id,
                &record.tenant_id,
                &record.owner_id,
                &updated_at_ms,
                &record_json,
            ],
        )
        .await?;
    Ok(())
}

async fn postgres_upsert_knowledge_base(
    client: &PostgresClient,
    record: &KnowledgeBaseRecord,
) -> Result<(), Box<dyn std::error::Error>> {
    let updated_at_ms = i64::try_from(record.updated_at_ms)?;
    let record_json = serde_json::to_string(record)?;
    client
        .execute(
            "INSERT INTO knowledge_bases (id, tenant_id, owner_id, updated_at_ms, record_json)
             VALUES ($1, $2, $3, $4, $5)
             ON CONFLICT(id) DO UPDATE SET
               tenant_id = EXCLUDED.tenant_id,
               owner_id = EXCLUDED.owner_id,
               updated_at_ms = EXCLUDED.updated_at_ms,
               record_json = EXCLUDED.record_json",
            &[
                &record.id,
                &record.tenant_id,
                &record.owner_id,
                &updated_at_ms,
                &record_json,
            ],
        )
        .await?;
    Ok(())
}

async fn postgres_upsert_data_source(
    client: &PostgresClient,
    record: &DataSourceRecord,
) -> Result<(), Box<dyn std::error::Error>> {
    let updated_at_ms = i64::try_from(record.updated_at_ms)?;
    let record_json = serde_json::to_string(record)?;
    client
        .execute(
            "INSERT INTO data_sources (id, knowledge_base_id, tenant_id, owner_id, updated_at_ms, record_json)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT(id) DO UPDATE SET
               knowledge_base_id = EXCLUDED.knowledge_base_id,
               tenant_id = EXCLUDED.tenant_id,
               owner_id = EXCLUDED.owner_id,
               updated_at_ms = EXCLUDED.updated_at_ms,
               record_json = EXCLUDED.record_json",
            &[
                &record.id,
                &record.knowledge_base_id,
                &record.tenant_id,
                &record.owner_id,
                &updated_at_ms,
                &record_json,
            ],
        )
        .await?;
    Ok(())
}

async fn postgres_upsert_agent_conversation(
    client: &PostgresClient,
    record: &AgentConversationRecord,
) -> Result<(), Box<dyn std::error::Error>> {
    let updated_at_ms = i64::try_from(record.updated_at_ms)?;
    let record_json = serde_json::to_string(record)?;
    client
        .execute(
            "INSERT INTO agent_conversations (id, tenant_id, owner_id, status, updated_at_ms, record_json)
             VALUES ($1, $2, $3, $4, $5, $6)
             ON CONFLICT(id) DO UPDATE SET
               tenant_id = EXCLUDED.tenant_id,
               owner_id = EXCLUDED.owner_id,
               status = EXCLUDED.status,
               updated_at_ms = EXCLUDED.updated_at_ms,
               record_json = EXCLUDED.record_json",
            &[
                &record.id,
                &record.tenant_id,
                &record.owner_id,
                &agent_conversation_status_as_str(&record.status),
                &updated_at_ms,
                &record_json,
            ],
        )
        .await?;
    Ok(())
}

async fn postgres_upsert_agent_turn(
    client: &PostgresClient,
    record: &AgentTurnRecord,
) -> Result<(), Box<dyn std::error::Error>> {
    let started_at_ms = i64::try_from(record.started_at_ms)?;
    let completed_at_ms = record.completed_at_ms.map(i64::try_from).transpose()?;
    let record_json = serde_json::to_string(record)?;
    client
        .execute(
            "INSERT INTO agent_turns (
                id, conversation_id, tenant_id, owner_id, status, started_at_ms, completed_at_ms, record_json
             )
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
             ON CONFLICT(id) DO UPDATE SET
               conversation_id = EXCLUDED.conversation_id,
               tenant_id = EXCLUDED.tenant_id,
               owner_id = EXCLUDED.owner_id,
               status = EXCLUDED.status,
               started_at_ms = EXCLUDED.started_at_ms,
               completed_at_ms = EXCLUDED.completed_at_ms,
               record_json = EXCLUDED.record_json",
            &[
                &record.id,
                &record.conversation_id,
                &record.tenant_id,
                &record.owner_id,
                &agent_turn_status_as_str(&record.status),
                &started_at_ms,
                &completed_at_ms,
                &record_json,
            ],
        )
        .await?;
    Ok(())
}

async fn postgres_list_agent_conversations(
    client: &PostgresClient,
    tenant_id: Option<&str>,
    owner_id: &str,
) -> Result<Vec<AgentConversationRecord>, Box<dyn std::error::Error>> {
    let rows = client
        .query(
            "SELECT record_json FROM agent_conversations
             WHERE tenant_id IS NOT DISTINCT FROM $1 AND owner_id = $2
             ORDER BY updated_at_ms DESC, id DESC",
            &[&tenant_id, &owner_id],
        )
        .await?;
    rows.into_iter()
        .map(|row| {
            let raw: String = row.get(0);
            serde_json::from_str::<AgentConversationRecord>(&raw)
                .map_err(|error| -> Box<dyn std::error::Error> { Box::new(error) })
        })
        .collect()
}

async fn postgres_list_agent_turns(
    client: &PostgresClient,
    conversation_id: &str,
    tenant_id: Option<&str>,
    owner_id: &str,
) -> Result<Vec<AgentTurnRecord>, Box<dyn std::error::Error>> {
    let rows = client
        .query(
            "SELECT record_json FROM agent_turns
             WHERE conversation_id = $1 AND tenant_id IS NOT DISTINCT FROM $2 AND owner_id = $3
             ORDER BY started_at_ms ASC, id ASC",
            &[&conversation_id, &tenant_id, &owner_id],
        )
        .await?;
    rows.into_iter()
        .map(|row| {
            let raw: String = row.get(0);
            serde_json::from_str::<AgentTurnRecord>(&raw)
                .map_err(|error| -> Box<dyn std::error::Error> { Box::new(error) })
        })
        .collect()
}

async fn postgres_delete_agent_conversation(
    client: &PostgresClient,
    id: &str,
    tenant_id: Option<&str>,
    owner_id: &str,
) -> Result<bool, Box<dyn std::error::Error>> {
    let deleted = client
        .execute(
            "DELETE FROM agent_conversations
             WHERE id = $1 AND tenant_id IS NOT DISTINCT FROM $2 AND owner_id = $3",
            &[&id, &tenant_id, &owner_id],
        )
        .await?;
    if deleted > 0 {
        client
            .execute(
                "DELETE FROM agent_turns
                 WHERE conversation_id = $1 AND tenant_id IS NOT DISTINCT FROM $2 AND owner_id = $3",
                &[&id, &tenant_id, &owner_id],
            )
            .await?;
    }
    Ok(deleted > 0)
}

async fn postgres_delete_data_source(
    client: &PostgresClient,
    id: &str,
) -> Result<bool, Box<dyn std::error::Error>> {
    let affected = client
        .execute("DELETE FROM data_sources WHERE id = $1", &[&id])
        .await?;
    Ok(affected > 0)
}

async fn postgres_delete_knowledge_base(
    client: &PostgresClient,
    id: &str,
) -> Result<bool, Box<dyn std::error::Error>> {
    let affected = client
        .execute("DELETE FROM knowledge_bases WHERE id = $1", &[&id])
        .await?;
    Ok(affected > 0)
}

async fn postgres_delete_record(
    client: &PostgresClient,
    id: &str,
) -> Result<bool, Box<dyn std::error::Error>> {
    client
        .execute("DELETE FROM audit_records WHERE thread_id = $1", &[&id])
        .await?;
    client
        .execute("DELETE FROM artifact_records WHERE thread_id = $1", &[&id])
        .await?;
    client
        .execute("DELETE FROM memory_notes WHERE thread_id = $1", &[&id])
        .await?;
    let affected = client
        .execute("DELETE FROM thread_records WHERE id = $1", &[&id])
        .await?;
    Ok(affected > 0)
}

async fn postgres_upsert_acp_connector(
    _client: &PostgresClient,
    _record: &AcpConnectorRecord,
) -> Result<(), Box<dyn std::error::Error>> {
    Err(boxed_string_error(
        "ACP support is paused in this build and postgres ACP storage is not enabled.",
    ))
}

async fn postgres_delete_acp_connector(
    _client: &PostgresClient,
    _id: &str,
) -> Result<bool, Box<dyn std::error::Error>> {
    Err(boxed_string_error(
        "ACP support is paused in this build and postgres ACP storage is not enabled.",
    ))
}

async fn postgres_load_projects(
    client: &PostgresClient,
) -> Result<Vec<ProjectRecord>, Box<dyn std::error::Error>> {
    let rows = client
        .query(
            "SELECT record_json FROM project_records ORDER BY updated_at_ms DESC",
            &[],
        )
        .await?;
    rows.into_iter()
        .map(|row| {
            let raw: String = row.get(0);
            serde_json::from_str::<ProjectRecord>(&raw)
                .map_err(|error| -> Box<dyn std::error::Error> { Box::new(error) })
        })
        .collect()
}

async fn postgres_load_knowledge_bases(
    client: &PostgresClient,
) -> Result<Vec<KnowledgeBaseRecord>, Box<dyn std::error::Error>> {
    let rows = client
        .query(
            "SELECT record_json FROM knowledge_bases ORDER BY updated_at_ms DESC",
            &[],
        )
        .await?;
    rows.into_iter()
        .map(|row| {
            let raw: String = row.get(0);
            serde_json::from_str::<KnowledgeBaseRecord>(&raw)
                .map_err(|error| -> Box<dyn std::error::Error> { Box::new(error) })
        })
        .collect()
}

async fn postgres_load_data_sources(
    client: &PostgresClient,
) -> Result<Vec<DataSourceRecord>, Box<dyn std::error::Error>> {
    let rows = client
        .query(
            "SELECT record_json FROM data_sources ORDER BY updated_at_ms DESC",
            &[],
        )
        .await?;
    rows.into_iter()
        .map(|row| {
            let raw: String = row.get(0);
            serde_json::from_str::<DataSourceRecord>(&raw)
                .map_err(|error| -> Box<dyn std::error::Error> { Box::new(error) })
        })
        .collect()
}

async fn postgres_load_acp_connectors(
    _client: &PostgresClient,
) -> Result<Vec<AcpConnectorRecord>, Box<dyn std::error::Error>> {
    Err(boxed_string_error(
        "ACP support is paused in this build and postgres ACP storage is not enabled.",
    ))
}

async fn postgres_get_project(
    client: &PostgresClient,
    id: &str,
) -> Result<Option<ProjectRecord>, Box<dyn std::error::Error>> {
    client
        .query_opt(
            "SELECT record_json FROM project_records WHERE id = $1",
            &[&id],
        )
        .await?
        .map(|row| {
            let raw: String = row.get(0);
            serde_json::from_str::<ProjectRecord>(&raw)
                .map_err(|error| -> Box<dyn std::error::Error> { Box::new(error) })
        })
        .transpose()
}

async fn postgres_get_knowledge_base(
    client: &PostgresClient,
    id: &str,
) -> Result<Option<KnowledgeBaseRecord>, Box<dyn std::error::Error>> {
    client
        .query_opt(
            "SELECT record_json FROM knowledge_bases WHERE id = $1",
            &[&id],
        )
        .await?
        .map(|row| {
            let raw: String = row.get(0);
            serde_json::from_str::<KnowledgeBaseRecord>(&raw)
                .map_err(|error| -> Box<dyn std::error::Error> { Box::new(error) })
        })
        .transpose()
}

async fn postgres_get_acp_connector(
    _client: &PostgresClient,
    _id: &str,
) -> Result<Option<AcpConnectorRecord>, Box<dyn std::error::Error>> {
    Err(boxed_string_error(
        "ACP support is paused in this build and postgres ACP storage is not enabled.",
    ))
}

async fn load_postgres_memory_notes(
    client: &PostgresClient,
    thread_id: &str,
) -> Result<Vec<MemoryNote>, Box<dyn std::error::Error>> {
    let rows = client
        .query(
            "SELECT note_json FROM memory_notes
             WHERE thread_id = $1
             ORDER BY created_at_ms ASC, id ASC",
            &[&thread_id],
        )
        .await?;
    rows.into_iter()
        .map(|row| {
            let raw: String = row.get(0);
            serde_json::from_str::<MemoryNote>(&raw)
                .map_err(|error| -> Box<dyn std::error::Error> { Box::new(error) })
        })
        .collect()
}

async fn load_postgres_memory_notes_for_scope(
    client: &PostgresClient,
    record: &ThreadRecord,
    scope: MemorySearchScope,
) -> Result<Vec<MemoryNote>, Box<dyn std::error::Error>> {
    match scope {
        MemorySearchScope::Thread => {
            load_postgres_memory_notes_by_thread_and_scope(client, &record.id, MemoryScope::Thread)
                .await
        }
        MemorySearchScope::Workspace => load_postgres_workspace_memory_notes(client, record).await,
        MemorySearchScope::Tenant => load_postgres_tenant_memory_notes(client, record).await,
        MemorySearchScope::All => {
            let mut notes = load_postgres_memory_notes_by_thread_and_scope(
                client,
                &record.id,
                MemoryScope::Thread,
            )
            .await?;
            notes.extend(load_postgres_workspace_memory_notes(client, record).await?);
            notes.extend(load_postgres_tenant_memory_notes(client, record).await?);
            Ok(dedupe_and_sort_memory_notes(notes))
        }
    }
}

async fn load_postgres_memory_notes_by_thread_and_scope(
    client: &PostgresClient,
    thread_id: &str,
    scope: MemoryScope,
) -> Result<Vec<MemoryNote>, Box<dyn std::error::Error>> {
    let rows = client
        .query(
            "SELECT note_json FROM memory_notes
             WHERE thread_id = $1 AND scope = $2
             ORDER BY created_at_ms ASC, id ASC",
            &[&thread_id, &scope.as_str()],
        )
        .await?;
    rows.into_iter()
        .map(|row| {
            let raw: String = row.get(0);
            serde_json::from_str::<MemoryNote>(&raw)
                .map_err(|error| -> Box<dyn std::error::Error> { Box::new(error) })
        })
        .collect()
}

async fn load_postgres_workspace_memory_notes(
    client: &PostgresClient,
    record: &ThreadRecord,
) -> Result<Vec<MemoryNote>, Box<dyn std::error::Error>> {
    let workspace_root = record.workspace_root.display().to_string();
    let rows = if let Some(owner_id) = record.owner_id.as_deref() {
        let tenant_id = record.tenant_id.as_deref();
        client
            .query(
                "SELECT note_json FROM memory_notes
                 WHERE scope = 'workspace' AND tenant_id IS NOT DISTINCT FROM $1 AND owner_id = $2 AND workspace_root = $3
                 ORDER BY created_at_ms ASC, id ASC",
                &[&tenant_id, &owner_id, &workspace_root],
            )
            .await?
    } else {
        let tenant_id = record.tenant_id.as_deref();
        client
            .query(
                "SELECT note_json FROM memory_notes
                 WHERE scope = 'workspace' AND tenant_id IS NOT DISTINCT FROM $1 AND owner_id IS NULL AND workspace_root = $2
                 ORDER BY created_at_ms ASC, id ASC",
                &[&tenant_id, &workspace_root],
            )
            .await?
    };
    rows.into_iter()
        .map(|row| {
            let raw: String = row.get(0);
            serde_json::from_str::<MemoryNote>(&raw)
                .map_err(|error| -> Box<dyn std::error::Error> { Box::new(error) })
        })
        .collect()
}

async fn load_postgres_tenant_memory_notes(
    client: &PostgresClient,
    record: &ThreadRecord,
) -> Result<Vec<MemoryNote>, Box<dyn std::error::Error>> {
    let Some(tenant_id) = record.tenant_id.as_deref() else {
        return Ok(Vec::new());
    };
    let rows = client
        .query(
            "SELECT note_json FROM memory_notes
             WHERE scope = 'tenant' AND tenant_id = $1
             ORDER BY created_at_ms ASC, id ASC",
            &[&tenant_id],
        )
        .await?;
    rows.into_iter()
        .map(|row| {
            let raw: String = row.get(0);
            serde_json::from_str::<MemoryNote>(&raw)
                .map_err(|error| -> Box<dyn std::error::Error> { Box::new(error) })
        })
        .collect()
}

async fn load_postgres_artifacts(
    client: &PostgresClient,
    thread_id: &str,
) -> Result<Vec<ArtifactRecord>, Box<dyn std::error::Error>> {
    let rows = client
        .query(
            "SELECT artifact_json FROM artifact_records
             WHERE thread_id = $1
             ORDER BY created_at_ms ASC, id ASC",
            &[&thread_id],
        )
        .await?;
    rows.into_iter()
        .map(|row| {
            let raw: String = row.get(0);
            serde_json::from_str::<ArtifactRecord>(&raw)
                .map_err(|error| -> Box<dyn std::error::Error> { Box::new(error) })
        })
        .collect()
}

async fn postgres_upsert_api_key(
    client: &PostgresClient,
    record: &ApiKeyRecord,
) -> Result<(), Box<dyn std::error::Error>> {
    let created_at_ms = i64::try_from(record.created_at_ms)?;
    let updated_at_ms = i64::try_from(record.updated_at_ms)?;
    let last_used_at_ms = record.last_used_at_ms.map(i64::try_from).transpose()?;
    let disabled_at_ms = record.disabled_at_ms.map(i64::try_from).transpose()?;
    client
        .execute(
            "INSERT INTO api_keys (
                id,
                tenant_id,
                user_id,
                display_name,
                key_prefix,
                key_hash,
                created_at_ms,
                updated_at_ms,
                last_used_at_ms,
                disabled_at_ms
             ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
             ON CONFLICT(key_hash) DO UPDATE SET
                tenant_id = EXCLUDED.tenant_id,
                user_id = EXCLUDED.user_id,
                display_name = EXCLUDED.display_name,
                key_prefix = EXCLUDED.key_prefix,
                updated_at_ms = EXCLUDED.updated_at_ms,
                disabled_at_ms = EXCLUDED.disabled_at_ms",
            &[
                &record.id,
                &record.tenant_id,
                &record.user_id,
                &record.display_name,
                &record.key_prefix,
                &record.key_hash,
                &created_at_ms,
                &updated_at_ms,
                &last_used_at_ms,
                &disabled_at_ms,
            ],
        )
        .await?;
    Ok(())
}

fn postgres_api_key_from_row(
    row: tokio_postgres::Row,
) -> Result<ApiKeyRecord, Box<dyn std::error::Error>> {
    Ok(ApiKeyRecord {
        id: row.get(0),
        tenant_id: row.get(1),
        user_id: row.get(2),
        display_name: row.get(3),
        key_prefix: row.get(4),
        key_hash: row.get(5),
        created_at_ms: u64::try_from(row.get::<_, i64>(6))?,
        updated_at_ms: u64::try_from(row.get::<_, i64>(7))?,
        last_used_at_ms: row
            .get::<_, Option<i64>>(8)
            .map(u64::try_from)
            .transpose()?,
        disabled_at_ms: row
            .get::<_, Option<i64>>(9)
            .map(u64::try_from)
            .transpose()?,
    })
}

async fn postgres_authenticate_api_key(
    client: &PostgresClient,
    key_hash: &str,
    now_ms: u64,
) -> Result<Option<ApiKeyRecord>, Box<dyn std::error::Error>> {
    let row = client
        .query_opt(
            "SELECT id, tenant_id, user_id, display_name, key_prefix, key_hash, created_at_ms, updated_at_ms, last_used_at_ms, disabled_at_ms
             FROM api_keys
             WHERE key_hash = $1 AND disabled_at_ms IS NULL
             LIMIT 1",
            &[&key_hash],
        )
        .await?;
    let Some(row) = row else {
        return Ok(None);
    };
    client
        .execute(
            "UPDATE api_keys SET last_used_at_ms = $1 WHERE key_hash = $2",
            &[&i64::try_from(now_ms)?, &key_hash],
        )
        .await?;
    let mut record = postgres_api_key_from_row(row)?;
    record.last_used_at_ms = Some(now_ms);
    Ok(Some(record))
}

async fn postgres_list_api_keys(
    client: &PostgresClient,
    tenant_id: &str,
    user_id: &str,
) -> Result<Vec<ApiKeyRecord>, Box<dyn std::error::Error>> {
    let rows = client
        .query(
            "SELECT id, tenant_id, user_id, display_name, key_prefix, key_hash, created_at_ms, updated_at_ms, last_used_at_ms, disabled_at_ms
             FROM api_keys
             WHERE tenant_id = $1 AND user_id = $2
             ORDER BY created_at_ms DESC, id DESC",
            &[&tenant_id, &user_id],
        )
        .await?;
    rows.into_iter().map(postgres_api_key_from_row).collect()
}

async fn postgres_disable_api_key(
    client: &PostgresClient,
    id: &str,
    tenant_id: &str,
    user_id: &str,
    now_ms: u64,
) -> Result<bool, Box<dyn std::error::Error>> {
    let updated = client
        .execute(
            "UPDATE api_keys
             SET updated_at_ms = $1, disabled_at_ms = $1
             WHERE id = $2 AND tenant_id = $3 AND user_id = $4 AND disabled_at_ms IS NULL",
            &[&i64::try_from(now_ms)?, &id, &tenant_id, &user_id],
        )
        .await?;
    Ok(updated > 0)
}

async fn postgres_append_audit_record(
    client: &PostgresClient,
    thread_id: &str,
    record: &AuditRecord,
) -> Result<(), Box<dyn std::error::Error>> {
    let run_id = record.run_id.map(i64::try_from).transpose()?;
    let created_at_ms = i64::try_from(record.created_at_ms)?;
    let payload_json = serde_json::to_string(&record.payload)?;
    client
        .execute(
            "INSERT INTO audit_records (id, thread_id, run_id, kind, created_at_ms, payload_json)
             VALUES ($1, $2, $3, $4, $5, $6)",
            &[
                &record.id,
                &thread_id,
                &run_id,
                &record.kind,
                &created_at_ms,
                &payload_json,
            ],
        )
        .await?;
    Ok(())
}

async fn load_postgres_audit_records(
    client: &PostgresClient,
    thread_id: &str,
    limit: usize,
) -> Result<Vec<AuditRecord>, Box<dyn std::error::Error>> {
    let limit = i64::try_from(limit)?;
    let rows = client
        .query(
            "SELECT id, run_id, kind, created_at_ms, payload_json
             FROM (
                SELECT id, run_id, kind, created_at_ms, payload_json
                FROM audit_records
                WHERE thread_id = $1
                ORDER BY created_at_ms DESC, id DESC
                LIMIT $2
             ) AS recent_audit_records
             ORDER BY created_at_ms ASC, id ASC",
            &[&thread_id, &limit],
        )
        .await?;
    rows.into_iter()
        .map(|row| {
            let id: String = row.get(0);
            let run_id = row
                .get::<_, Option<i64>>(1)
                .map(u64::try_from)
                .transpose()?;
            let kind: String = row.get(2);
            let created_at_ms = u64::try_from(row.get::<_, i64>(3))?;
            let payload_json: String = row.get(4);
            Ok(AuditRecord {
                id,
                run_id,
                kind,
                created_at_ms,
                payload: serde_json::from_str(&payload_json)?,
            })
        })
        .collect()
}

async fn load_postgres_latest_expert_panel_run_state(
    client: &PostgresClient,
    thread_id: &str,
    run_id: &str,
) -> Result<Option<ExpertPanelRunResponse>, Box<dyn std::error::Error>> {
    let rows = client
        .query(
            "SELECT payload_json
             FROM audit_records
             WHERE thread_id = $1 AND kind = 'expert_panel_run_state'
             ORDER BY created_at_ms DESC, id DESC",
            &[&thread_id],
        )
        .await?;
    for row in rows {
        let payload_json: String = row.get(0);
        let response = serde_json::from_str::<ExpertPanelRunResponse>(&payload_json)?;
        if response.run_id == run_id {
            return Ok(Some(response));
        }
    }
    Ok(None)
}

struct ManagedThread {
    events: tokio::sync::broadcast::Sender<ThreadEventEnvelope>,
    shared: Arc<Mutex<ThreadState>>,
}

impl ManagedThread {
    fn new(state: ThreadState) -> Self {
        let (events, _) = tokio::sync::broadcast::channel(256);
        Self {
            events,
            shared: Arc::new(Mutex::new(state)),
        }
    }

    fn id(&self) -> String {
        self.shared
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .record
            .id
            .clone()
    }

    fn snapshot(&self) -> ThreadSnapshot {
        snapshot_from_state(
            &self
                .shared
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner),
        )
    }

    fn publish(&self, kind: &'static str, payload: Value) {
        let _ = self.events.send(ThreadEventEnvelope {
            kind: kind.to_string(),
            at_ms: now_millis(),
            payload,
        });
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ThreadRecord {
    id: String,
    #[serde(default)]
    tenant_id: Option<String>,
    #[serde(default)]
    owner_id: Option<String>,
    workspace_root: PathBuf,
    session_path: PathBuf,
    #[serde(default)]
    project_id: Option<String>,
    #[serde(default)]
    project_name: Option<String>,
    #[serde(default)]
    knowledge_base_id: Option<String>,
    #[serde(default)]
    knowledge_base_name: Option<String>,
    model: String,
    #[serde(default)]
    model_access: ModelAccessConfig,
    permission_mode: String,
    topic: Option<String>,
    #[serde(default)]
    instructions: Option<String>,
    #[serde(default)]
    preferred_skill_names: Vec<String>,
    memory_notes: Vec<MemoryNote>,
    artifacts: Vec<ArtifactRecord>,
    created_at_ms: u64,
    updated_at_ms: u64,
    #[serde(default)]
    last_status: Option<ThreadStatus>,
    #[serde(default)]
    last_error: Option<String>,
    #[serde(default = "default_next_run_id")]
    next_run_id: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ProjectRecord {
    id: String,
    #[serde(default)]
    tenant_id: Option<String>,
    #[serde(default)]
    owner_id: Option<String>,
    name: String,
    #[serde(default)]
    description: Option<String>,
    workspace_root: PathBuf,
    #[serde(default)]
    default_topic: Option<String>,
    #[serde(default)]
    default_model: Option<String>,
    #[serde(default)]
    model_access: ModelAccessConfig,
    #[serde(default)]
    default_permission_mode: Option<String>,
    #[serde(default)]
    starter_prompt: Option<String>,
    #[serde(default)]
    default_instructions: Option<String>,
    #[serde(default)]
    default_skill_names: Vec<String>,
    created_at_ms: u64,
    updated_at_ms: u64,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum DataSourceKind {
    LocalDir,
    Upload,
    Web,
    Git,
    S3,
    Es,
    Db,
    Notion,
    Confluence,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum AcpConnectorProfile {
    EsSearch,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct KnowledgeBaseRecord {
    id: String,
    #[serde(default)]
    tenant_id: Option<String>,
    #[serde(default)]
    owner_id: Option<String>,
    name: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    default_project_id: Option<String>,
    #[serde(default)]
    legacy_workspace_root: Option<PathBuf>,
    created_at_ms: u64,
    updated_at_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DataSourceRecord {
    id: String,
    knowledge_base_id: String,
    #[serde(default)]
    tenant_id: Option<String>,
    #[serde(default)]
    owner_id: Option<String>,
    name: String,
    kind: DataSourceKind,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    config: Value,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    last_test: Option<DataSourceTestResult>,
    #[serde(default)]
    last_synced_at_ms: Option<u64>,
    created_at_ms: u64,
    updated_at_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AcpConnectorRecord {
    id: String,
    #[serde(default)]
    tenant_id: Option<String>,
    #[serde(default)]
    owner_id: Option<String>,
    #[serde(default)]
    project_id: Option<String>,
    #[serde(default)]
    knowledge_base_id: Option<String>,
    name: String,
    profile: AcpConnectorProfile,
    base_url: String,
    #[serde(default)]
    description: Option<String>,
    #[serde(default)]
    agent_name: Option<String>,
    #[serde(default)]
    api_key: Option<String>,
    #[serde(default)]
    status: Option<String>,
    #[serde(default)]
    capability_cache: Vec<AcpCapabilitySummary>,
    #[serde(default)]
    last_test: Option<AcpConnectorTestResult>,
    created_at_ms: u64,
    updated_at_ms: u64,
}

#[derive(Debug, Clone)]
struct ResolvedDataAccess {
    data_sources: Vec<DataSourceRecord>,
}

#[derive(Debug, Clone, Default)]
struct ResolvedAcpAccess {
    connectors: Vec<AcpConnectorRecord>,
}

#[derive(Debug, Clone, Default)]
struct ResolvedEsAccess {
    base_url: Option<String>,
    api_key: Option<String>,
    username: Option<String>,
    password: Option<String>,
    default_index: Option<String>,
    indices: Vec<String>,
    source_id: Option<String>,
    source_name: Option<String>,
}

#[derive(Debug, Clone, Default)]
struct ResolvedDocumentAccess {
    source_id: Option<String>,
    source_name: Option<String>,
    files: Vec<DocumentFileRecord>,
}

#[derive(Debug, Clone, Default)]
struct ResolvedWebAccess {
    source_id: Option<String>,
    source_name: Option<String>,
    urls: Vec<String>,
}

#[derive(Debug, Clone, Default)]
struct ResolvedDbAccess {
    source_id: Option<String>,
    source_name: Option<String>,
    url: Option<String>,
    schema: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DocumentFileRecord {
    id: String,
    file_name: String,
    stored_name: String,
    relative_path: String,
    mime_type: Option<String>,
    size_bytes: u64,
    extracted_text: String,
    uploaded_at_ms: u64,
}

#[derive(Debug, Clone)]
struct ThreadState {
    record: ThreadRecord,
    visible_memory_notes: Vec<MemoryNote>,
    audit_records: Vec<AuditRecord>,
    session: Session,
    status: ThreadStatus,
    last_error: Option<String>,
    draft_assistant_text: String,
    next_run_id: u64,
    current_run: Option<ActiveRun>,
    pending_replan: Option<RunRequest>,
}

#[derive(Debug, Clone)]
struct ActiveRun {
    run_id: u64,
    abort_signal: HookAbortSignal,
    request: RunRequest,
}

#[derive(Debug, Clone)]
struct RunRequest {
    kind: RunKind,
    prompt: String,
    expert_panel: Option<ExpertPanelRequest>,
    expert_run: Option<ExpertPanelRunExecution>,
    execution_context: Option<RunExecutionContext>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum RunKind {
    UserMessage,
    Replan,
    ExpertPanel,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ExpertPanelRequest {
    panel_id: String,
    master_skill: String,
    experts: Vec<ExpertPanelExpert>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ExpertPanelExpert {
    skill: String,
    scope: SkillScope,
    label: String,
    #[serde(default)]
    description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ExpertPanelRunExecution {
    run_id: String,
    retry_count: u8,
    concurrency_limit: u8,
}

#[derive(Debug, Clone)]
struct ExpertExecutionInput {
    run_id: String,
    question: String,
    expert: ExpertPanelExpert,
    attempt: u8,
}

#[derive(Debug, Clone)]
struct ExpertExecutionOutput {
    expert: ExpertPanelExpert,
    attempts: u8,
    content: String,
    citations: Vec<String>,
    confidence: Option<String>,
    stance: Option<String>,
}

#[derive(Debug, Clone)]
struct ExpertExecutionFailure {
    expert: ExpertPanelExpert,
    attempts: u8,
    error: String,
}

#[derive(Debug, Clone)]
struct ExpertStreamContext {
    run_id: String,
    expert: ExpertPanelExpert,
    attempt: u8,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ExpertPanelRunRequest {
    #[serde(default)]
    question: Option<String>,
    #[serde(default)]
    source_message_id: Option<String>,
    #[serde(default)]
    knowledge_base_id: Option<String>,
    #[serde(default)]
    data_source_ids: Option<Vec<String>>,
    #[serde(default)]
    auto_retrieval: Option<bool>,
    experts: Vec<ExpertPanelExpert>,
    #[serde(default)]
    retry_count: Option<u8>,
    #[serde(default)]
    concurrency_limit: Option<u8>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct RunExecutionContext {
    #[serde(default)]
    knowledge_base_id: Option<String>,
    #[serde(default)]
    data_source_ids: Option<Vec<String>>,
    #[serde(default)]
    knowledge_base_name: Option<String>,
    #[serde(default)]
    auto_retrieval: Option<bool>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum ExpertPanelRunStatus {
    Queued,
    Running,
    Succeeded,
    Failed,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum ExpertPanelExpertStatus {
    Queued,
    Running,
    Retrying,
    Succeeded,
    Failed,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ExpertPanelRunExpertState {
    skill: String,
    scope: SkillScope,
    label: String,
    #[serde(default)]
    description: Option<String>,
    status: ExpertPanelExpertStatus,
    attempts: u8,
    #[serde(default)]
    content: Option<String>,
    #[serde(default)]
    citations: Vec<String>,
    #[serde(default)]
    confidence: Option<String>,
    #[serde(default)]
    stance: Option<String>,
    #[serde(default)]
    error: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ExpertPanelRunResponse {
    run_id: String,
    thread_id: String,
    status: ExpertPanelRunStatus,
    retry_count: u8,
    concurrency_limit: u8,
    experts: Vec<ExpertPanelRunExpertState>,
}

fn default_next_run_id() -> u64 {
    1
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum ThreadStatus {
    Idle,
    Running,
    InterruptRequested,
    Failed,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum MemoryScope {
    Thread,
    Workspace,
    Tenant,
}

impl Default for MemoryScope {
    fn default() -> Self {
        Self::Thread
    }
}

impl MemoryScope {
    fn as_str(self) -> &'static str {
        match self {
            Self::Thread => "thread",
            Self::Workspace => "workspace",
            Self::Tenant => "tenant",
        }
    }
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum MemorySearchScope {
    Thread,
    Workspace,
    Tenant,
    All,
}

impl Default for MemorySearchScope {
    fn default() -> Self {
        Self::All
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct MemoryNote {
    id: String,
    #[serde(default)]
    scope: MemoryScope,
    note: String,
    tags: Vec<String>,
    created_at_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ArtifactRecord {
    id: String,
    kind: ArtifactKind,
    title: Option<String>,
    payload: Value,
    #[serde(default)]
    metadata: Option<Value>,
    created_at_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AuditRecord {
    id: String,
    run_id: Option<u64>,
    kind: String,
    created_at_ms: u64,
    payload: Value,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum ResearchTaskStage {
    Question,
    Retrieval,
    ExpertReview,
    Synthesis,
    WritingReady,
}

impl ResearchTaskStage {
    fn label(&self) -> &'static str {
        match self {
            Self::Question => "问题已记录",
            Self::Retrieval => "资料检索中",
            Self::ExpertReview => "专家复评中",
            Self::Synthesis => "已形成综合判断",
            Self::WritingReady => "可进入写作整理",
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct ResearchTaskStageRecord {
    stage: ResearchTaskStage,
    label: String,
    at_ms: u64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
struct ResearchTaskStateRecord {
    id: String,
    title: String,
    status: ResearchTaskStage,
    status_label: String,
    next_recommended_action: String,
    available_actions: Vec<String>,
    stage_history: Vec<ResearchTaskStageRecord>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
enum ArtifactKind {
    Text,
    Markdown,
    Table,
    Chart,
    Graph,
}

#[derive(Debug, Clone, Serialize)]
struct ThreadSnapshot {
    id: String,
    workspace_root: String,
    session_path: String,
    project_id: Option<String>,
    project_name: Option<String>,
    knowledge_base_id: Option<String>,
    knowledge_base_name: Option<String>,
    model: String,
    permission_mode: String,
    topic: Option<String>,
    status: ThreadStatus,
    last_error: Option<String>,
    draft_assistant_text: String,
    created_at_ms: u64,
    updated_at_ms: u64,
    messages: Vec<MessageSnapshot>,
    memory_notes: Vec<MemoryNote>,
    artifacts: Vec<ArtifactRecord>,
    audit_records: Vec<AuditRecord>,
}

#[derive(Debug, Clone, Serialize)]
struct ThreadSummary {
    id: String,
    workspace_root: String,
    project_id: Option<String>,
    project_name: Option<String>,
    knowledge_base_id: Option<String>,
    knowledge_base_name: Option<String>,
    model: String,
    topic: Option<String>,
    status: ThreadStatus,
    updated_at_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
struct MessageSnapshot {
    id: String,
    role: String,
    blocks: Vec<MessageBlockSnapshot>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum MessageBlockSnapshot {
    Text {
        text: String,
    },
    ToolUse {
        id: String,
        name: String,
        input: String,
    },
    ToolResult {
        tool_use_id: String,
        tool_name: String,
        output: String,
        is_error: bool,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct ThreadEventEnvelope {
    kind: String,
    at_ms: u64,
    payload: Value,
}

#[derive(Debug, Deserialize)]
struct CreateThreadRequest {
    workspace_root: Option<String>,
    project_id: Option<String>,
    knowledge_base_id: Option<String>,
    model: Option<String>,
    model_base_url: Option<String>,
    model_api_key: Option<String>,
    permission_mode: Option<String>,
    topic: Option<String>,
}

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

#[derive(Debug, Deserialize)]
struct CreateProjectRequest {
    name: String,
    description: Option<String>,
    workspace_root: Option<String>,
    default_topic: Option<String>,
    default_model: Option<String>,
    model_base_url: Option<String>,
    model_base_url_env: Option<String>,
    model_api_key: Option<String>,
    model_api_key_env: Option<String>,
    default_permission_mode: Option<String>,
    starter_prompt: Option<String>,
    default_instructions: Option<String>,
    default_skill_names: Option<Vec<String>>,
}

#[derive(Debug, Deserialize)]
struct CreateKnowledgeBaseRequest {
    name: String,
    description: Option<String>,
    default_project_id: Option<String>,
    legacy_workspace_root: Option<String>,
}

#[derive(Debug, Deserialize)]
struct CreateDataSourceRequest {
    knowledge_base_id: String,
    name: String,
    kind: DataSourceKind,
    description: Option<String>,
    config: Option<Value>,
}

#[derive(Debug, Deserialize)]
struct CreateAcpConnectorRequest {
    name: String,
    profile: AcpConnectorProfile,
    base_url: String,
    description: Option<String>,
    project_id: Option<String>,
    knowledge_base_id: Option<String>,
    agent_name: Option<String>,
    api_key: Option<String>,
}

#[derive(Debug, Deserialize)]
struct UpdateDataSourceRequest {
    name: Option<String>,
    description: Option<String>,
    config: Option<Value>,
}

#[derive(Debug, Default, Deserialize)]
struct UpdateAcpConnectorRequest {
    name: Option<String>,
    description: Option<String>,
    base_url: Option<String>,
    project_id: Option<String>,
    knowledge_base_id: Option<String>,
    agent_name: Option<String>,
    api_key: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct UpdateProjectRequest {
    name: Option<String>,
    description: Option<String>,
    default_topic: Option<String>,
    default_model: Option<String>,
    model_base_url: Option<String>,
    model_base_url_env: Option<String>,
    model_api_key: Option<String>,
    model_api_key_env: Option<String>,
    default_permission_mode: Option<String>,
    starter_prompt: Option<String>,
    default_instructions: Option<String>,
    default_skill_names: Option<Vec<String>>,
}

#[derive(Debug, Clone, Serialize)]
struct ProjectSummary {
    id: String,
    name: String,
    description: Option<String>,
    workspace_root: String,
    default_topic: Option<String>,
    default_model: Option<String>,
    model_base_url: Option<String>,
    model_base_url_env: Option<String>,
    model_api_key_env: Option<String>,
    model_api_key_configured: bool,
    default_permission_mode: Option<String>,
    starter_prompt: Option<String>,
    default_instructions: Option<String>,
    default_skill_names: Vec<String>,
    created_at_ms: u64,
    updated_at_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
struct KnowledgeBaseSummary {
    id: String,
    name: String,
    description: Option<String>,
    default_project_id: Option<String>,
    data_source_count: usize,
    created_at_ms: u64,
    updated_at_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
struct DataSourceSummary {
    id: String,
    knowledge_base_id: String,
    name: String,
    kind: DataSourceKind,
    description: Option<String>,
    status: Option<String>,
    endpoint: Option<String>,
    index_name: Option<String>,
    auth_mode: Option<String>,
    source_detail: Option<String>,
    uploaded_files: Vec<UploadedDocumentSummary>,
    last_test: Option<DataSourceTestResult>,
    last_synced_at_ms: Option<u64>,
    created_at_ms: u64,
    updated_at_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
struct DataSourceDetail {
    id: String,
    knowledge_base_id: String,
    name: String,
    kind: DataSourceKind,
    description: Option<String>,
    status: Option<String>,
    config: Value,
    endpoint: Option<String>,
    index_name: Option<String>,
    auth_mode: Option<String>,
    source_detail: Option<String>,
    uploaded_files: Vec<UploadedDocumentSummary>,
    last_test: Option<DataSourceTestResult>,
    last_synced_at_ms: Option<u64>,
    created_at_ms: u64,
    updated_at_ms: u64,
}

#[derive(Debug, Deserialize)]
struct TestDataSourceRequest {
    kind: DataSourceKind,
    config: Option<Value>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DataSourceTestDetail {
    label: String,
    value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct DataSourceTestResult {
    kind: DataSourceKind,
    status: String,
    summary: String,
    checked_at_ms: u64,
    details: Vec<DataSourceTestDetail>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AcpCapabilitySummary {
    name: String,
    #[serde(default)]
    description: Option<String>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AcpConnectorTestDetail {
    label: String,
    value: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct AcpConnectorTestResult {
    status: String,
    summary: String,
    checked_at_ms: u64,
    #[serde(default)]
    details: Vec<AcpConnectorTestDetail>,
}

#[derive(Debug, Serialize)]
struct TestDataSourceResponse {
    ok: bool,
    kind: DataSourceKind,
    summary: String,
    result: DataSourceTestResult,
}

#[derive(Debug, Deserialize)]
struct TestAcpConnectorRequest {
    profile: AcpConnectorProfile,
    base_url: String,
    agent_name: Option<String>,
    api_key: Option<String>,
}

#[derive(Debug, Serialize)]
struct TestAcpConnectorResponse {
    ok: bool,
    profile: AcpConnectorProfile,
    summary: String,
    result: AcpConnectorTestResult,
    capabilities: Vec<AcpCapabilitySummary>,
}

#[derive(Debug, Clone, Serialize)]
struct UploadedDocumentSummary {
    id: String,
    file_name: String,
    mime_type: Option<String>,
    size_bytes: u64,
    uploaded_at_ms: u64,
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
struct ModelAccessConfig {
    #[serde(default)]
    base_url: Option<String>,
    #[serde(default)]
    base_url_env: Option<String>,
    #[serde(default)]
    api_key: Option<String>,
    #[serde(default)]
    api_key_env: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct CreateApiKeyRequest {
    display_name: Option<String>,
}

#[derive(Debug, Default, Deserialize)]
struct AuthQuery {
    user_id: Option<String>,
    api_key: Option<String>,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "snake_case")]
enum SkillScope {
    Workspace,
    Tenant,
}

impl SkillScope {
    fn as_str(self) -> &'static str {
        match self {
            Self::Workspace => "workspace",
            Self::Tenant => "tenant",
        }
    }
}

#[derive(Debug, Default, Deserialize)]
struct SkillQuery {
    workspace_root: Option<String>,
    project_id: Option<String>,
    scope: Option<SkillScope>,
    user_id: Option<String>,
    api_key: Option<String>,
}

#[derive(Debug, Deserialize)]
struct UpsertSkillRequest {
    scope: SkillScope,
    workspace_root: Option<String>,
    project_id: Option<String>,
    name: String,
    description: Option<String>,
    tags: Option<Vec<String>>,
    starter_prompt: Option<String>,
    prompt: String,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "type", rename_all = "snake_case")]
enum CommandRequest {
    UserMessage {
        content: String,
        #[serde(default)]
        expert_panel: Option<ExpertPanelRequest>,
        #[serde(default)]
        knowledge_base_id: Option<String>,
        #[serde(default)]
        data_source_ids: Option<Vec<String>>,
        #[serde(default)]
        auto_retrieval: Option<bool>,
    },
    Interrupt {
        reason: Option<String>,
    },
    Replan {
        reason: Option<String>,
        topic: Option<String>,
    },
    SetTopic {
        topic: String,
    },
}

#[derive(Debug, Clone)]
struct AppError {
    status: StatusCode,
    message: String,
}

impl AppError {
    fn new(status: StatusCode, message: impl Into<String>) -> Self {
        Self {
            status,
            message: message.into(),
        }
    }
}

impl IntoResponse for AppError {
    fn into_response(self) -> axum::response::Response {
        (self.status, Json(json!({ "error": self.message }))).into_response()
    }
}

async fn healthz() -> Json<Value> {
    Json(json!({ "ok": true }))
}

async fn serve_web_index(State(state): State<Arc<AppState>>) -> Response {
    eprintln!("serve_web_index invoked");
    let Some(web_dist_dir) = state.config.web_dist_dir.clone() else {
        eprintln!("serve_web_index: web dist disabled");
        return StatusCode::NOT_FOUND.into_response();
    };

    let index_path = web_dist_dir.join("index.html");
    match fs::read_to_string(index_path) {
        Ok(contents) => Html(contents).into_response(),
        Err(error) => {
            eprintln!("serve_web_index: failed to read index.html: {error}");
            StatusCode::NOT_FOUND.into_response()
        }
    }
}

async fn serve_web_asset(
    State(state): State<Arc<AppState>>,
    AxumPath(path): AxumPath<String>,
) -> Response {
    eprintln!("serve_web_asset invoked: {path}");
    let Some(web_dist_dir) = state.config.web_dist_dir.clone() else {
        eprintln!("serve_web_asset: web dist disabled");
        return StatusCode::NOT_FOUND.into_response();
    };

    if path.is_empty() || path.contains("..") || path.starts_with('/') {
        eprintln!("serve_web_asset: rejected path");
        return StatusCode::NOT_FOUND.into_response();
    }

    let asset_path = web_dist_dir.join("assets").join(path);
    let body = match fs::read(&asset_path) {
        Ok(body) => body,
        Err(error) => {
            eprintln!("serve_web_asset: failed to read asset: {error}");
            return StatusCode::NOT_FOUND.into_response();
        }
    };

    let mime = content_type_for_path(&asset_path);
    ([(header::CONTENT_TYPE, mime)], body).into_response()
}

fn content_type_for_path(path: &Path) -> &'static str {
    match path.extension().and_then(|ext| ext.to_str()) {
        Some("css") => "text/css; charset=utf-8",
        Some("js") => "application/javascript; charset=utf-8",
        Some("html") => "text/html; charset=utf-8",
        Some("json") => "application/json; charset=utf-8",
        Some("svg") => "image/svg+xml",
        Some("png") => "image/png",
        Some("jpg") | Some("jpeg") => "image/jpeg",
        Some("webp") => "image/webp",
        Some("woff") => "font/woff",
        Some("woff2") => "font/woff2",
        _ => "application/octet-stream",
    }
}

#[derive(Debug, Clone, Serialize)]
struct ConfigResponse {
    database_backend: String,
    database_schema_version: u32,
    default_model: String,
    default_permission_mode: String,
    run_timeout_secs: Option<u64>,
    max_threads_per_user: Option<usize>,
    max_threads_per_tenant: Option<usize>,
    max_concurrent_runs_global: Option<usize>,
    max_concurrent_runs_per_tenant: Option<usize>,
    max_concurrent_runs_per_user: Option<usize>,
    max_mutation_requests_per_minute_global: Option<usize>,
    max_mutation_requests_per_minute_per_tenant: Option<usize>,
    max_mutation_requests_per_minute_per_user: Option<usize>,
    api_key_auth_enabled: bool,
    dev_user_header_auth_enabled: bool,
}

async fn get_config(State(state): State<Arc<AppState>>) -> Json<ConfigResponse> {
    Json(ConfigResponse {
        database_backend: state.config.database_backend().to_string(),
        database_schema_version: state.store.schema_version(),
        default_model: state.config.default_model.clone(),
        default_permission_mode: state.config.default_permission_mode.as_str().to_string(),
        run_timeout_secs: state.config.run_timeout_secs,
        max_threads_per_user: state.config.max_threads_per_user,
        max_threads_per_tenant: state.config.max_threads_per_tenant,
        max_concurrent_runs_global: state.config.max_concurrent_runs_global,
        max_concurrent_runs_per_tenant: state.config.max_concurrent_runs_per_tenant,
        max_concurrent_runs_per_user: state.config.max_concurrent_runs_per_user,
        max_mutation_requests_per_minute_global: state
            .config
            .max_mutation_requests_per_minute_global,
        max_mutation_requests_per_minute_per_tenant: state
            .config
            .max_mutation_requests_per_minute_per_tenant,
        max_mutation_requests_per_minute_per_user: state
            .config
            .max_mutation_requests_per_minute_per_user,
        api_key_auth_enabled: true,
        dev_user_header_auth_enabled: state.config.dev_user_header_auth_enabled,
    })
}

#[derive(Debug, Clone, Serialize)]
struct AuthSessionResponse {
    auth_mode: AuthMode,
    tenant_id: Option<String>,
    user_id: String,
    api_key_id: Option<String>,
    api_key_prefix: Option<String>,
    display_name: Option<String>,
    is_platform_admin: bool,
}

#[derive(Debug, Clone, Serialize)]
struct ApiKeySummaryResponse {
    id: String,
    display_name: Option<String>,
    key_prefix: String,
    created_at_ms: u64,
    updated_at_ms: u64,
    last_used_at_ms: Option<u64>,
    disabled_at_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
struct ApiKeyListResponse {
    api_keys: Vec<ApiKeySummaryResponse>,
}

#[derive(Debug, Clone, Serialize)]
struct CreatedApiKeyResponse {
    api_key: ApiKeySummaryResponse,
    raw_key: String,
}

#[derive(Debug, Clone, Serialize)]
struct SkillSummaryResponse {
    name: String,
    description: Option<String>,
    tags: Vec<String>,
    starter_prompt: Option<String>,
    scope: SkillScope,
    updated_at_ms: Option<u64>,
}

#[derive(Debug, Clone, Serialize)]
struct SkillDetailResponse {
    name: String,
    description: Option<String>,
    tags: Vec<String>,
    starter_prompt: Option<String>,
    scope: SkillScope,
    updated_at_ms: Option<u64>,
    prompt: String,
}

#[derive(Debug, Clone, Serialize)]
struct SkillListResponse {
    skills: Vec<SkillSummaryResponse>,
}

#[derive(Debug, Clone, Serialize)]
struct KnowledgeBaseListResponse {
    knowledge_bases: Vec<KnowledgeBaseSummary>,
}

#[derive(Debug, Clone, Serialize)]
struct DataSourceListResponse {
    data_sources: Vec<DataSourceSummary>,
}

#[derive(Debug, Clone, Serialize)]
struct AcpConnectorSummary {
    id: String,
    name: String,
    profile: AcpConnectorProfile,
    base_url: String,
    description: Option<String>,
    project_id: Option<String>,
    knowledge_base_id: Option<String>,
    agent_name: Option<String>,
    status: Option<String>,
    capability_count: usize,
    last_test: Option<AcpConnectorTestResult>,
    created_at_ms: u64,
    updated_at_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
struct AcpConnectorDetail {
    id: String,
    name: String,
    profile: AcpConnectorProfile,
    base_url: String,
    description: Option<String>,
    project_id: Option<String>,
    knowledge_base_id: Option<String>,
    agent_name: Option<String>,
    api_key_configured: bool,
    status: Option<String>,
    capabilities: Vec<AcpCapabilitySummary>,
    last_test: Option<AcpConnectorTestResult>,
    created_at_ms: u64,
    updated_at_ms: u64,
}

#[derive(Debug, Clone, Serialize)]
struct AcpConnectorListResponse {
    acp_connectors: Vec<AcpConnectorSummary>,
}

#[derive(Debug, Clone, Serialize)]
struct AcpConnectorDiscoveryResponse {
    connector: AcpConnectorSummary,
    capabilities: Vec<AcpCapabilitySummary>,
}

fn api_key_summary_response(record: ApiKeyRecord) -> ApiKeySummaryResponse {
    ApiKeySummaryResponse {
        id: record.id,
        display_name: record.display_name,
        key_prefix: record.key_prefix,
        created_at_ms: record.created_at_ms,
        updated_at_ms: record.updated_at_ms,
        last_used_at_ms: record.last_used_at_ms,
        disabled_at_ms: record.disabled_at_ms,
    }
}

fn acp_paused_error() -> AppError {
    AppError::new(
        StatusCode::NOT_IMPLEMENTED,
        "ACP support is paused in this build and will resume in a later phase.",
    )
}

async fn list_acp_connectors() -> Result<Json<AcpConnectorListResponse>, AppError> {
    Err(acp_paused_error())
}

async fn create_acp_connector() -> Result<Json<AcpConnectorSummary>, AppError> {
    Err(acp_paused_error())
}

async fn test_acp_connector() -> Result<Json<TestAcpConnectorResponse>, AppError> {
    Err(acp_paused_error())
}

async fn get_acp_connector() -> Result<Json<AcpConnectorDetail>, AppError> {
    Err(acp_paused_error())
}

async fn update_acp_connector() -> Result<Json<AcpConnectorSummary>, AppError> {
    Err(acp_paused_error())
}

async fn delete_acp_connector() -> Result<StatusCode, AppError> {
    Err(acp_paused_error())
}

async fn discover_saved_acp_connector() -> Result<Json<AcpConnectorDiscoveryResponse>, AppError> {
    Err(acp_paused_error())
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum ServiceSkillRootKind {
    SkillsDir,
    LegacyCommandsDir,
}

#[derive(Debug, Clone)]
struct ServiceSkillRoot {
    path: PathBuf,
    scope: SkillScope,
    kind: ServiceSkillRootKind,
    writable: bool,
}

#[derive(Debug, Clone)]
struct ServiceSkillEntry {
    name: String,
    description: Option<String>,
    tags: Vec<String>,
    starter_prompt: Option<String>,
    scope: SkillScope,
    path: PathBuf,
    updated_at_ms: Option<u64>,
}

#[derive(Debug, Clone)]
struct ServiceSkillDetail {
    entry: ServiceSkillEntry,
    prompt: String,
}

#[derive(Debug, Clone, Serialize)]
struct ServiceSkillOutput {
    skill: String,
    args: Option<String>,
    description: Option<String>,
    tags: Vec<String>,
    starter_prompt: Option<String>,
    prompt: String,
}

fn auth_query_from_skill_query(query: &SkillQuery) -> AuthQuery {
    AuthQuery {
        user_id: query.user_id.clone(),
        api_key: query.api_key.clone(),
    }
}

fn resolve_skill_workspace_root(
    store: &ThreadStore,
    config: &AppConfig,
    workspace_root: Option<&str>,
    project_id: Option<&str>,
) -> Result<Option<PathBuf>, AppError> {
    if let Some(project_id) = project_id.filter(|value| !value.trim().is_empty()) {
        let project = store
            .get_project(project_id)
            .map_err(|error| AppError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?
            .ok_or_else(|| AppError::new(StatusCode::NOT_FOUND, "project not found"))?;
        return Ok(Some(project.workspace_root));
    }

    workspace_root
        .map(|root| canonicalize_workspace(root, config))
        .transpose()
}

fn normalize_skill_name(value: &str) -> Result<String, String> {
    let trimmed = value.trim().trim_start_matches('/').trim_start_matches('$');
    if trimmed.is_empty() {
        return Err(String::from("skill name must not be empty"));
    }
    if trimmed.len() > 64 {
        return Err(String::from("skill name must be 64 characters or fewer"));
    }
    if trimmed
        .chars()
        .all(|ch| ch.is_ascii_alphanumeric() || matches!(ch, '-' | '_'))
    {
        return Ok(trimmed.to_string());
    }
    Err(String::from(
        "skill name may only contain ASCII letters, numbers, `-`, and `_`",
    ))
}

fn parse_requested_skill(value: &str) -> Result<(Option<SkillScope>, String), String> {
    let trimmed = value.trim().trim_start_matches('/').trim_start_matches('$');
    let (scope, rest) = if let Some(rest) = trimmed.strip_prefix("workspace:") {
        (Some(SkillScope::Workspace), rest)
    } else if let Some(rest) = trimmed.strip_prefix("tenant:") {
        (Some(SkillScope::Tenant), rest)
    } else {
        (None, trimmed)
    };
    Ok((scope, normalize_skill_name(rest)?))
}

fn service_skill_roots(
    config: &AppConfig,
    workspace_root: Option<&Path>,
    tenant_id: Option<&str>,
) -> Vec<ServiceSkillRoot> {
    let mut roots = Vec::new();
    if let Some(service_skills_dir) = &config.service_skills_dir {
        push_service_skill_root(
            &mut roots,
            service_skills_dir.clone(),
            SkillScope::Workspace,
            ServiceSkillRootKind::SkillsDir,
            false,
        );
    }
    if let Some(workspace_root) = workspace_root {
        for prefix in [".claw", ".agents", ".codex", ".claude", ".omc"] {
            push_service_skill_root(
                &mut roots,
                workspace_root.join(prefix).join("skills"),
                SkillScope::Workspace,
                ServiceSkillRootKind::SkillsDir,
                true,
            );
            push_service_skill_root(
                &mut roots,
                workspace_root.join(prefix).join("commands"),
                SkillScope::Workspace,
                ServiceSkillRootKind::LegacyCommandsDir,
                true,
            );
        }
    }
    if let Some(tenant_id) = tenant_id {
        push_service_skill_root(
            &mut roots,
            config.tenant_skills_dir(tenant_id),
            SkillScope::Tenant,
            ServiceSkillRootKind::SkillsDir,
            true,
        );
    }
    roots
}

fn push_service_skill_root(
    roots: &mut Vec<ServiceSkillRoot>,
    path: PathBuf,
    scope: SkillScope,
    kind: ServiceSkillRootKind,
    writable: bool,
) {
    if path.is_dir() && !roots.iter().any(|existing| existing.path == path) {
        roots.push(ServiceSkillRoot {
            path,
            scope,
            kind,
            writable,
        });
    }
}

fn list_service_skills(
    config: &AppConfig,
    workspace_root: Option<&Path>,
    tenant_id: Option<&str>,
) -> Result<Vec<ServiceSkillEntry>, String> {
    let mut entries = Vec::new();
    let mut seen = BTreeSet::new();
    for root in service_skill_roots(config, workspace_root, tenant_id) {
        list_service_skills_in_root(&root, &mut seen, &mut entries)?;
    }
    Ok(entries)
}

fn list_service_skills_in_root(
    root: &ServiceSkillRoot,
    seen: &mut BTreeSet<String>,
    entries: &mut Vec<ServiceSkillEntry>,
) -> Result<(), String> {
    let read_dir = match fs::read_dir(&root.path) {
        Ok(read_dir) => read_dir,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.to_string()),
    };

    for item in read_dir.flatten() {
        let candidate_path = match root.kind {
            ServiceSkillRootKind::SkillsDir => {
                let path = item.path().join("SKILL.md");
                if !path.is_file() {
                    continue;
                }
                path
            }
            ServiceSkillRootKind::LegacyCommandsDir => {
                let path = item.path();
                if path.is_dir() {
                    let nested = path.join("SKILL.md");
                    if !nested.is_file() {
                        continue;
                    }
                    nested
                } else if path
                    .extension()
                    .is_some_and(|ext| ext.to_string_lossy().eq_ignore_ascii_case("md"))
                {
                    path
                } else {
                    continue;
                }
            }
        };

        let prompt = fs::read_to_string(&candidate_path).map_err(|error| error.to_string())?;
        let name = parse_skill_name_from_contents(&prompt).or_else(|| match root.kind {
            ServiceSkillRootKind::SkillsDir => candidate_path
                .parent()
                .and_then(|parent| parent.file_name())
                .map(|value| value.to_string_lossy().to_string()),
            ServiceSkillRootKind::LegacyCommandsDir => {
                if candidate_path
                    .file_name()
                    .is_some_and(|file_name| file_name == "SKILL.md")
                {
                    candidate_path
                        .parent()
                        .and_then(|parent| parent.file_name())
                        .map(|value| value.to_string_lossy().to_string())
                } else {
                    candidate_path
                        .file_stem()
                        .map(|value| value.to_string_lossy().to_string())
                }
            }
        });
        let Some(name) = name else {
            continue;
        };
        let Ok(name) = normalize_skill_name(&name) else {
            continue;
        };
        let dedupe_key = format!("{}:{name}", root.scope.as_str());
        if !seen.insert(dedupe_key) {
            continue;
        }

        entries.push(ServiceSkillEntry {
            name,
            description: parse_skill_description_from_contents(&prompt),
            tags: parse_skill_tags_from_contents(&prompt),
            starter_prompt: parse_skill_starter_prompt_from_contents(&prompt),
            scope: root.scope,
            updated_at_ms: file_updated_at_ms(&candidate_path),
            path: candidate_path,
        });
    }

    Ok(())
}

fn resolve_service_skill(
    config: &AppConfig,
    workspace_root: Option<&Path>,
    tenant_id: Option<&str>,
    requested: &str,
) -> Result<ServiceSkillDetail, String> {
    let (requested_scope, requested_name) = parse_requested_skill(requested)?;
    for root in service_skill_roots(config, workspace_root, tenant_id) {
        if requested_scope.is_some_and(|scope| scope != root.scope) {
            continue;
        }
        if let Some(path) = resolve_service_skill_path_in_root(&root, &requested_name)? {
            let prompt = fs::read_to_string(&path).map_err(|error| error.to_string())?;
            return Ok(ServiceSkillDetail {
                entry: ServiceSkillEntry {
                    name: requested_name,
                    description: parse_skill_description_from_contents(&prompt),
                    tags: parse_skill_tags_from_contents(&prompt),
                    starter_prompt: parse_skill_starter_prompt_from_contents(&prompt),
                    scope: root.scope,
                    updated_at_ms: file_updated_at_ms(&path),
                    path,
                },
                prompt,
            });
        }
    }

    Err(format!("unknown skill: {requested_name}"))
}

fn canonical_service_skill_name(entry: &ServiceSkillEntry) -> String {
    format!("{}:{}", entry.scope.as_str(), entry.name)
}

fn normalize_project_default_skill_names(
    config: &AppConfig,
    workspace_root: &Path,
    tenant_id: Option<&str>,
    values: Option<Vec<String>>,
) -> Result<Vec<String>, String> {
    let requested = values
        .unwrap_or_default()
        .into_iter()
        .flat_map(|value| {
            value
                .split(|ch: char| ch == ',' || ch == '\n')
                .map(str::trim)
                .filter(|item| !item.is_empty())
                .map(ToString::to_string)
                .collect::<Vec<_>>()
        })
        .collect::<Vec<_>>();
    if requested.is_empty() {
        return Ok(Vec::new());
    }

    let available = list_service_skills(config, Some(workspace_root), tenant_id)?;
    let mut normalized = Vec::new();
    let mut seen = BTreeSet::new();
    for requested_name in requested {
        let (scope, skill_name) = parse_requested_skill(&requested_name)?;
        let Some(entry) = available.iter().find(|entry| {
            entry.name == skill_name && scope.map_or(true, |value| entry.scope == value)
        }) else {
            return Err(format!("unknown project default skill: {requested_name}"));
        };
        let canonical = canonical_service_skill_name(entry);
        if seen.insert(canonical.clone()) {
            normalized.push(canonical);
        }
    }

    Ok(normalized)
}

fn normalize_optional_text(value: Option<String>) -> Option<String> {
    value
        .map(|value| value.trim().to_string())
        .filter(|value| !value.is_empty())
}

fn normalize_string_list(values: Vec<String>) -> Vec<String> {
    let mut seen = BTreeSet::new();
    let mut normalized = Vec::new();
    for value in values {
        let value = value.trim().to_string();
        if value.is_empty() || !seen.insert(value.clone()) {
            continue;
        }
        normalized.push(value);
    }
    normalized
}

fn extract_ag_ui_user_message(request: &AgUiRunRequest) -> Option<String> {
    request
        .messages
        .iter()
        .rev()
        .find_map(extract_ag_ui_message_text)
        .or_else(|| {
            request
                .forwarded_props
                .get("message")
                .and_then(Value::as_str)
                .map(str::to_string)
        })
}

fn extract_ag_ui_forwarded_string_list(
    forwarded_props: &Value,
    keys: &[&str],
) -> Option<Vec<String>> {
    for key in keys {
        if let Some(value) = forwarded_props.get(*key) {
            let Some(items) = value.as_array() else {
                return Some(Vec::new());
            };
            return Some(normalize_string_list(
                items
                    .iter()
                    .filter_map(Value::as_str)
                    .map(ToString::to_string)
                    .collect(),
            ));
        }
    }
    None
}

fn apply_ag_ui_forwarded_context(
    mut conversation: AgentConversationRecord,
    request: &AgUiRunRequest,
) -> AgentConversationRecord {
    if let Some(ids) = extract_ag_ui_forwarded_string_list(
        &request.forwarded_props,
        &["selectedKnowledgeBaseIds", "selected_knowledge_base_ids"],
    ) {
        conversation.selected_knowledge_base_ids = ids;
    }
    if let Some(ids) = extract_ag_ui_forwarded_string_list(
        &request.forwarded_props,
        &["selectedDataSourceIds", "selected_data_source_ids"],
    ) {
        conversation.selected_data_source_ids = ids;
    }
    if let Some(ids) = extract_ag_ui_forwarded_string_list(
        &request.forwarded_props,
        &["selectedExpertIds", "selected_expert_ids"],
    ) {
        conversation.selected_expert_ids = ids;
    }
    if let Some(model_profile_id) = request
        .forwarded_props
        .get("modelProfileId")
        .or_else(|| request.forwarded_props.get("model_profile_id"))
    {
        conversation.model_profile_id = model_profile_id
            .as_str()
            .and_then(|value| normalize_optional_text(Some(value.to_string())));
    }
    conversation
}

fn extract_ag_ui_message_text(message: &Value) -> Option<String> {
    let role = message.get("role").and_then(Value::as_str)?;
    if role != "user" {
        return None;
    }
    let content = message.get("content")?;
    if let Some(text) = content.as_str() {
        return normalize_optional_text(Some(text.to_string()));
    }
    let parts = content.as_array()?;
    let text = parts
        .iter()
        .filter_map(|part| {
            if part.get("type").and_then(Value::as_str) == Some("text") {
                part.get("text").and_then(Value::as_str)
            } else {
                None
            }
        })
        .collect::<Vec<_>>()
        .join("\n");
    normalize_optional_text(Some(text))
}

fn map_tool_result_to_agent_updates(
    tool_call_id: &str,
    tool_name: &str,
    input: &str,
    output: &str,
    is_error: bool,
) -> AgentToolUpdates {
    let now = now_millis();
    let parsed = serde_json::from_str::<Value>(output).unwrap_or(Value::String(output.to_string()));
    let citations = extract_agent_citations(tool_call_id, tool_name, &parsed);
    let public_payload = build_step_public_payload(tool_name, input, &parsed, &citations, is_error);
    let public_label = match tool_name {
        "EsSearch" | "SourceSearch" => {
            if is_error {
                "资料检索失败"
            } else {
                "资料检索已返回"
            }
        }
        "DbQuery" => {
            if is_error {
                "数据库查询失败"
            } else {
                "数据库查询已返回"
            }
        }
        "ArtifactEmit" => {
            if is_error {
                "产物生成失败"
            } else {
                "产物已生成"
            }
        }
        _ => {
            if is_error {
                "工具执行失败"
            } else {
                "工具执行完成"
            }
        }
    };
    let step_kind = if matches!(tool_name, "EsSearch" | "SourceSearch") {
        AgentTurnStepKind::Retrieval
    } else {
        AgentTurnStepKind::Tool
    };

    AgentToolUpdates {
        steps: vec![AgentTurnStep {
            id: format!("step-{tool_call_id}"),
            kind: step_kind,
            label: public_label.to_string(),
            detail: Some(if citations.is_empty() {
                "未生成引用".to_string()
            } else {
                format!("生成 {} 条引用", citations.len())
            }),
            status: if is_error {
                AgentTurnStepStatus::Failed
            } else {
                AgentTurnStepStatus::Succeeded
            },
            started_at_ms: None,
            completed_at_ms: Some(now),
            public_payload,
            debug_payload: Some(json!({ "tool": tool_name, "input": input, "output": output })),
        }],
        citations,
        expert_results: Vec::new(),
        debug_event: AgentTurnDebugEvent {
            event_type: "TOOL_CALL_RESULT".to_string(),
            at_ms: now,
            payload: json!({
                "toolCallId": tool_call_id,
                "toolName": tool_name,
                "isError": is_error,
            }),
        },
    }
}

fn extract_agent_citations(
    tool_call_id: &str,
    tool_name: &str,
    parsed_output: &Value,
) -> Vec<AgentCitation> {
    if !matches!(tool_name, "EsSearch" | "SourceSearch") {
        return Vec::new();
    }
    let Some(hits) = parsed_output.get("hits").and_then(Value::as_array) else {
        return Vec::new();
    };

    hits.iter()
        .enumerate()
        .map(|(index, hit)| {
            let source = hit.get("_source").unwrap_or(hit);
            let title = value_string(source, &["title", "name", "file"])
                .or_else(|| value_string(hit, &["title", "name", "file"]));
            let preview = value_string(
                source,
                &["preview", "snippet", "summary", "text", "content"],
            )
            .or_else(|| value_string(hit, &["preview", "snippet", "summary", "text", "content"]))
            .unwrap_or_default();
            let location = value_string(source, &["location", "path", "url", "id"])
                .or_else(|| value_string(hit, &["location", "path", "url", "id", "_id"]));
            AgentCitation {
                id: format!("{tool_call_id}#hit-{index}"),
                number: (index + 1) as u32,
                source_kind: if tool_name == "EsSearch" {
                    "es".to_string()
                } else {
                    "source".to_string()
                },
                source_label: parsed_output
                    .get("data_source_name")
                    .or_else(|| parsed_output.get("index"))
                    .and_then(Value::as_str)
                    .unwrap_or("平台资料库")
                    .to_string(),
                title,
                location,
                preview,
                debug_payload: Some(hit.clone()),
            }
        })
        .collect()
}

fn value_string(value: &Value, keys: &[&str]) -> Option<String> {
    keys.iter().find_map(|key| {
        value
            .get(*key)
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|item| !item.is_empty())
            .map(ToString::to_string)
    })
}

fn value_usize(value: &Value, keys: &[&str]) -> Option<usize> {
    keys.iter()
        .filter_map(|key| value.get(*key))
        .find_map(value_as_usize)
}

fn value_as_usize(value: &Value) -> Option<usize> {
    if let Some(number) = value.as_u64() {
        return usize::try_from(number).ok();
    }
    if let Some(number) = value.as_i64() {
        return usize::try_from(number).ok();
    }
    if let Some(text) = value.as_str() {
        return text.trim().parse::<usize>().ok();
    }
    if let Some(nested) = value.get("value") {
        return value_as_usize(nested);
    }
    None
}

fn extract_query_from_tool_input(input: &str) -> Option<String> {
    serde_json::from_str::<Value>(input)
        .ok()
        .and_then(|value| value_string(&value, &["query", "q", "keyword", "keywords"]))
}

fn summarize_tool_output(output: &Value, is_error: bool) -> String {
    if is_error {
        return match output
            .as_str()
            .map(str::trim)
            .filter(|text| !text.is_empty())
        {
            Some(message) => format!("执行失败：{message}"),
            None => "执行失败".to_string(),
        };
    }

    if let Some(count) = output.get("hits").and_then(Value::as_array).map(Vec::len) {
        if count == 0 {
            return "执行完成，未返回结果".to_string();
        }
        return format!("执行完成，返回 {count} 条结果");
    }

    if let Some(count) = output.get("rows").and_then(Value::as_array).map(Vec::len) {
        if count == 0 {
            return "执行完成，未返回数据行".to_string();
        }
        return format!("执行完成，返回 {count} 行数据");
    }

    "执行完成".to_string()
}

fn build_step_public_payload(
    tool_name: &str,
    input: &str,
    parsed_output: &Value,
    citations: &[AgentCitation],
    is_error: bool,
) -> Value {
    if matches!(tool_name, "EsSearch" | "SourceSearch") {
        let source_name =
            value_string(parsed_output, &["data_source_name", "source_name", "index"])
                .unwrap_or_else(|| "平台资料库".to_string());
        let query = value_string(parsed_output, &["query", "q", "keyword", "keywords"])
            .or_else(|| extract_query_from_tool_input(input));
        let hit_count = value_usize(parsed_output, &["hit_count", "count", "total"])
            .or_else(|| {
                parsed_output
                    .get("hits")
                    .and_then(Value::as_array)
                    .map(Vec::len)
            })
            .unwrap_or(citations.len());
        let citation_numbers = citations
            .iter()
            .map(|citation| citation.number)
            .collect::<Vec<_>>();

        let mut payload = serde_json::Map::new();
        payload.insert("source_name".to_string(), json!(source_name));
        if let Some(source_id) =
            value_string(parsed_output, &["data_source_id", "source_id", "sourceId"])
        {
            payload.insert("source_id".to_string(), json!(source_id));
        }
        if let Some(query) = query {
            payload.insert("query".to_string(), json!(query));
        }
        payload.insert("hit_count".to_string(), json!(hit_count));
        payload.insert("citation_numbers".to_string(), json!(citation_numbers));
        payload.insert("empty_result".to_string(), json!(hit_count == 0));
        payload.insert("is_error".to_string(), json!(is_error));
        payload.insert(
            "result_summary".to_string(),
            json!(if is_error {
                summarize_tool_output(parsed_output, true)
            } else {
                format!("命中 {hit_count} 篇资料，形成 {} 条引用", citations.len())
            }),
        );
        return Value::Object(payload);
    }

    json!({
        "tool_purpose": tool_name,
        "result_summary": summarize_tool_output(parsed_output, is_error),
        "is_error": is_error,
    })
}

fn renumber_agent_tool_updates(mut updates: Vec<AgentToolUpdates>) -> Vec<AgentToolUpdates> {
    let mut next_number = 1_u32;
    for update in &mut updates {
        for citation in &mut update.citations {
            citation.number = next_number;
            next_number += 1;
        }
    }
    updates
}

fn extract_ag_ui_forwarded_tool_updates(request: &AgUiRunRequest) -> Vec<AgentToolUpdates> {
    let Some(tool_results) = request
        .forwarded_props
        .get("toolResults")
        .and_then(Value::as_array)
    else {
        return Vec::new();
    };

    let updates = tool_results
        .iter()
        .enumerate()
        .filter_map(|(index, item)| {
            let tool_name = item
                .get("toolName")
                .or_else(|| item.get("name"))
                .and_then(Value::as_str)?;
            let tool_call_id = item
                .get("toolCallId")
                .or_else(|| item.get("id"))
                .and_then(Value::as_str)
                .map(ToString::to_string)
                .unwrap_or_else(|| format!("tool-{index}"));
            let input = item
                .get("input")
                .map(Value::to_string)
                .unwrap_or_else(|| "{}".to_string());
            let output = item
                .get("output")
                .or_else(|| item.get("result"))
                .map(|value| {
                    value
                        .as_str()
                        .map(ToString::to_string)
                        .unwrap_or_else(|| value.to_string())
                })
                .unwrap_or_default();
            let is_error = item
                .get("isError")
                .or_else(|| item.get("is_error"))
                .and_then(Value::as_bool)
                .unwrap_or(false);
            Some(map_tool_result_to_agent_updates(
                &tool_call_id,
                tool_name,
                &input,
                &output,
                is_error,
            ))
        })
        .collect();
    renumber_agent_tool_updates(updates)
}

fn normalize_model_access_from_parts(
    base_url: Option<String>,
    base_url_env: Option<String>,
    api_key: Option<String>,
    api_key_env: Option<String>,
) -> ModelAccessConfig {
    ModelAccessConfig {
        base_url: normalize_optional_text(base_url),
        base_url_env: normalize_optional_text(base_url_env),
        api_key: normalize_optional_text(api_key),
        api_key_env: normalize_optional_text(api_key_env),
    }
}

fn apply_model_access_update(
    access: &mut ModelAccessConfig,
    base_url: Option<String>,
    base_url_env: Option<String>,
    api_key: Option<String>,
    api_key_env: Option<String>,
) {
    if base_url.is_some() {
        access.base_url = normalize_optional_text(base_url);
    }
    if base_url_env.is_some() {
        access.base_url_env = normalize_optional_text(base_url_env);
    }
    if api_key.is_some() {
        access.api_key = normalize_optional_text(api_key);
    }
    if api_key_env.is_some() {
        access.api_key_env = normalize_optional_text(api_key_env);
    }
}

fn read_model_access_env(var_name: &str) -> Result<Option<String>, String> {
    let normalized = var_name.trim();
    if normalized.is_empty() {
        return Ok(None);
    }

    std::env::var(normalized)
        .map(|value| value.trim().to_string())
        .map(|value| (!value.is_empty()).then_some(value))
        .map_err(|_| format!("model access env var `{normalized}` is not set"))
}

fn resolve_model_access_value(
    explicit: Option<&str>,
    env_var: Option<&str>,
) -> Result<Option<String>, String> {
    if let Some(value) = explicit.map(str::trim).filter(|value| !value.is_empty()) {
        return Ok(Some(value.to_string()));
    }

    if let Some(env_var) = env_var.map(str::trim).filter(|value| !value.is_empty()) {
        return read_model_access_env(env_var);
    }

    Ok(None)
}

fn openai_compat_config_for_model(model: &str) -> OpenAiCompatConfig {
    let resolved_model = api::resolve_model_alias(model);
    match api::metadata_for_model(&resolved_model) {
        Some(metadata) if metadata.auth_env == "DASHSCOPE_API_KEY" => {
            OpenAiCompatConfig::dashscope()
        }
        _ => OpenAiCompatConfig::openai(),
    }
}

fn is_anthropic_base_url(base_url: &str) -> bool {
    base_url.to_ascii_lowercase().contains("anthropic")
}

fn is_dashscope_base_url(base_url: &str) -> bool {
    let normalized = base_url.to_ascii_lowercase();
    normalized.contains("dashscope") || normalized.contains("aliyuncs.com")
}

fn is_xai_base_url(base_url: &str) -> bool {
    base_url.to_ascii_lowercase().contains("x.ai")
}

fn openai_compat_api_key_from_env(
    config: OpenAiCompatConfig,
    base_url: Option<&str>,
) -> Option<String> {
    read_env_non_empty(config.api_key_env).or_else(|| {
        if config.provider_name == "OpenAI" && !base_url.is_some_and(is_anthropic_base_url) {
            read_env_non_empty("ANTHROPIC_AUTH_TOKEN")
                .or_else(|| read_env_non_empty("ANTHROPIC_API_KEY"))
        } else {
            None
        }
    })
}

fn openai_compat_base_url_from_env(config: OpenAiCompatConfig) -> Option<String> {
    read_env_non_empty(config.base_url_env).or_else(|| {
        if config.provider_name == "OpenAI" {
            read_env_non_empty("ANTHROPIC_BASE_URL").filter(|value| !is_anthropic_base_url(value))
        } else {
            None
        }
    })
}

fn provider_kind_for_model_access(model: &str, base_url: Option<&str>) -> ProviderKind {
    let resolved_model = api::resolve_model_alias(model);
    let detected = api::detect_provider_kind(&resolved_model);
    let Some(base_url) = base_url.map(str::trim).filter(|value| !value.is_empty()) else {
        return detected;
    };

    if is_xai_base_url(base_url) {
        return ProviderKind::Xai;
    }

    // The web UI intentionally asks only for API address + key. If a project
    // points at a non-Anthropic URL while the service default model is Claude,
    // treat it as OpenAI-compatible instead of silently using Anthropic wire
    // format and making the page-level configuration look ineffective.
    if detected == ProviderKind::Anthropic && !is_anthropic_base_url(base_url) {
        return ProviderKind::OpenAi;
    }

    detected
}

fn openai_compat_config_for_model_access(
    model: &str,
    base_url: Option<&str>,
) -> OpenAiCompatConfig {
    if base_url.is_some_and(is_dashscope_base_url) {
        return OpenAiCompatConfig::dashscope();
    }

    openai_compat_config_for_model(model)
}

fn openai_compat_model_for_base_url(base_url: Option<&str>) -> String {
    match base_url {
        Some(url) if is_dashscope_base_url(url) => {
            read_env_non_empty("DASHSCOPE_MODEL").unwrap_or_else(|| "qwen-plus".to_string())
        }
        Some(url) if is_xai_base_url(url) => {
            read_env_non_empty("XAI_MODEL").unwrap_or_else(|| "grok-3".to_string())
        }
        _ => {
            read_env_non_empty("OPENAI_MODEL").unwrap_or_else(|| "openai/gpt-4.1-mini".to_string())
        }
    }
}

fn request_model_for_model_access(
    model: &str,
    provider_kind: ProviderKind,
    base_url: Option<&str>,
) -> String {
    let resolved_model = api::resolve_model_alias(model);
    let detected = api::detect_provider_kind(&resolved_model);
    let has_non_anthropic_base_url = base_url
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .is_some_and(|value| !is_anthropic_base_url(value));

    if detected == ProviderKind::Anthropic && has_non_anthropic_base_url {
        return match provider_kind {
            ProviderKind::OpenAi => openai_compat_model_for_base_url(base_url),
            ProviderKind::Xai => {
                read_env_non_empty("XAI_MODEL").unwrap_or_else(|| "grok-3".to_string())
            }
            ProviderKind::Anthropic => resolved_model,
        };
    }

    model.to_string()
}

fn provider_client_from_record(record: &ThreadRecord) -> Result<ProviderClient, String> {
    let base_url = resolve_model_access_value(
        record.model_access.base_url.as_deref(),
        record.model_access.base_url_env.as_deref(),
    )?;
    let api_key = resolve_model_access_value(
        record.model_access.api_key.as_deref(),
        record.model_access.api_key_env.as_deref(),
    )?;

    if base_url.is_none() && api_key.is_none() {
        let provider_kind = api::detect_provider_kind(&api::resolve_model_alias(&record.model));
        if provider_kind != ProviderKind::OpenAi {
            return ProviderClient::from_model(&record.model).map_err(|error| error.to_string());
        }

        let config = openai_compat_config_for_model_access(&record.model, None);
        let key = openai_compat_api_key_from_env(config, None).ok_or_else(|| {
            format!(
                "missing {} credentials; configure model API key or {}",
                config.provider_name, config.api_key_env
            )
        })?;
        let client = OpenAiCompatClient::new(key, config);
        return Ok(ProviderClient::OpenAi(
            match openai_compat_base_url_from_env(config) {
                Some(url) => client.with_base_url(url),
                None => client,
            },
        ));
    }

    let provider_kind = provider_kind_for_model_access(&record.model, base_url.as_deref());
    match provider_kind {
        ProviderKind::Anthropic => {
            let client = match api_key {
                Some(key) => AnthropicClient::new(key),
                None => AnthropicClient::from_env().map_err(|error| error.to_string())?,
            };
            Ok(ProviderClient::Anthropic(match base_url {
                Some(url) => client.with_base_url(url),
                None => client,
            }))
        }
        ProviderKind::Xai => {
            let key = api_key
                .or_else(|| std::env::var("XAI_API_KEY").ok())
                .ok_or_else(|| {
                    "missing xAI credentials; configure model API key or XAI_API_KEY".to_string()
                })?;
            let client = OpenAiCompatClient::new(key, OpenAiCompatConfig::xai());
            Ok(ProviderClient::Xai(match base_url {
                Some(url) => client.with_base_url(url),
                None => client,
            }))
        }
        ProviderKind::OpenAi => {
            let config = openai_compat_config_for_model_access(&record.model, base_url.as_deref());
            let key = api_key
                .or_else(|| openai_compat_api_key_from_env(config, base_url.as_deref()))
                .ok_or_else(|| {
                    format!(
                        "missing {} credentials; configure model API key or {}",
                        config.provider_name, config.api_key_env
                    )
                })?;
            let client = OpenAiCompatClient::new(key, config);
            Ok(ProviderClient::OpenAi(match base_url {
                Some(url) => client.with_base_url(url),
                None => client,
            }))
        }
    }
}

fn apply_project_update(
    config: &AppConfig,
    project: &mut ProjectRecord,
    tenant_id: Option<&str>,
    request: UpdateProjectRequest,
) -> Result<(), String> {
    if let Some(name) = request.name {
        let normalized_name = name.trim();
        if normalized_name.is_empty() {
            return Err("project name must not be empty".to_string());
        }
        project.name = normalized_name.to_string();
    }

    if let Some(description) = request.description {
        project.description = normalize_optional_text(Some(description));
    }
    if let Some(default_topic) = request.default_topic {
        project.default_topic = normalize_optional_text(Some(default_topic));
    }
    if let Some(default_model) = request.default_model {
        project.default_model = normalize_optional_text(Some(default_model));
    }
    apply_model_access_update(
        &mut project.model_access,
        request.model_base_url,
        request.model_base_url_env,
        request.model_api_key,
        request.model_api_key_env,
    );
    if let Some(default_permission_mode) = request.default_permission_mode {
        project.default_permission_mode =
            match normalize_optional_text(Some(default_permission_mode)) {
                Some(value) => Some(parse_permission_mode(&value)?.as_str().to_string()),
                None => None,
            };
    }
    if let Some(starter_prompt) = request.starter_prompt {
        project.starter_prompt = normalize_optional_text(Some(starter_prompt));
    }
    if let Some(default_instructions) = request.default_instructions {
        project.default_instructions = normalize_optional_text(Some(default_instructions));
    }
    if let Some(default_skill_names) = request.default_skill_names {
        project.default_skill_names = normalize_project_default_skill_names(
            config,
            &project.workspace_root,
            tenant_id,
            Some(default_skill_names),
        )?;
    }

    project.updated_at_ms = now_millis();
    Ok(())
}

fn resolve_service_skill_path_in_root(
    root: &ServiceSkillRoot,
    requested: &str,
) -> Result<Option<PathBuf>, String> {
    match root.kind {
        ServiceSkillRootKind::SkillsDir => {
            resolve_service_skill_path_in_skills_dir(&root.path, requested)
        }
        ServiceSkillRootKind::LegacyCommandsDir => {
            resolve_service_skill_path_in_legacy_commands_dir(&root.path, requested)
        }
    }
}

fn resolve_service_skill_path_in_skills_dir(
    root: &Path,
    requested: &str,
) -> Result<Option<PathBuf>, String> {
    let direct = root.join(requested).join("SKILL.md");
    if direct.is_file() {
        return Ok(Some(direct));
    }

    let read_dir = match fs::read_dir(root) {
        Ok(read_dir) => read_dir,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    for entry in read_dir.flatten() {
        let path = entry.path().join("SKILL.md");
        if !path.is_file() {
            continue;
        }
        let entry_name = entry.file_name().to_string_lossy().to_string();
        if entry_name.eq_ignore_ascii_case(requested)
            || skill_frontmatter_name_matches(&path, requested)
        {
            return Ok(Some(path));
        }
    }

    Ok(None)
}

fn resolve_service_skill_path_in_legacy_commands_dir(
    root: &Path,
    requested: &str,
) -> Result<Option<PathBuf>, String> {
    let direct_dir = root.join(requested).join("SKILL.md");
    if direct_dir.is_file() {
        return Ok(Some(direct_dir));
    }

    let direct_markdown = root.join(format!("{requested}.md"));
    if direct_markdown.is_file() {
        return Ok(Some(direct_markdown));
    }

    let read_dir = match fs::read_dir(root) {
        Ok(read_dir) => read_dir,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.to_string()),
    };
    for entry in read_dir.flatten() {
        let path = entry.path();
        let candidate = if path.is_dir() {
            let nested = path.join("SKILL.md");
            if !nested.is_file() {
                continue;
            }
            nested
        } else if path
            .extension()
            .is_some_and(|ext| ext.to_string_lossy().eq_ignore_ascii_case("md"))
        {
            path
        } else {
            continue;
        };

        let entry_name = entry
            .file_name()
            .to_string_lossy()
            .trim_end_matches(".md")
            .to_string();
        if entry_name.eq_ignore_ascii_case(requested)
            || candidate
                .file_stem()
                .is_some_and(|stem| stem.to_string_lossy().eq_ignore_ascii_case(requested))
            || skill_frontmatter_name_matches(&candidate, requested)
        {
            return Ok(Some(candidate));
        }
    }

    Ok(None)
}

fn skill_frontmatter_name_matches(path: &Path, requested: &str) -> bool {
    fs::read_to_string(path)
        .ok()
        .and_then(|contents| parse_skill_name_from_contents(&contents))
        .is_some_and(|name| name.eq_ignore_ascii_case(requested))
}

fn parse_skill_name_from_contents(contents: &str) -> Option<String> {
    parse_skill_frontmatter_value(contents, "name")
}

fn parse_skill_description_from_contents(contents: &str) -> Option<String> {
    parse_skill_frontmatter_value(contents, "description").or_else(|| {
        contents.lines().find_map(|line| {
            line.strip_prefix("description:")
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToString::to_string)
        })
    })
}

fn parse_skill_starter_prompt_from_contents(contents: &str) -> Option<String> {
    parse_skill_frontmatter_value(contents, "starter_prompt")
}

fn parse_skill_tags_from_contents(contents: &str) -> Vec<String> {
    if let Some(value) = parse_skill_frontmatter_value(contents, "tags") {
        return split_skill_tags(&value);
    }

    parse_skill_frontmatter_list(contents, "tags")
        .unwrap_or_default()
        .into_iter()
        .flat_map(|value| split_skill_tags(&value))
        .collect()
}

fn split_skill_tags(value: &str) -> Vec<String> {
    value
        .split(',')
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
        .collect()
}

fn parse_skill_frontmatter_value(contents: &str, key: &str) -> Option<String> {
    let mut lines = contents.lines();
    if lines.next().map(str::trim) != Some("---") {
        return None;
    }

    for line in lines {
        let trimmed = line.trim();
        if trimmed == "---" {
            break;
        }
        if let Some(value) = trimmed.strip_prefix(&format!("{key}:")) {
            let value = value
                .trim()
                .trim_matches(|ch| matches!(ch, '"' | '\''))
                .trim();
            if !value.is_empty() {
                return Some(value.to_string());
            }
        }
    }

    None
}

fn parse_skill_frontmatter_list(contents: &str, key: &str) -> Option<Vec<String>> {
    let mut lines = contents.lines();
    if lines.next().map(str::trim) != Some("---") {
        return None;
    }

    let mut collecting = false;
    let mut values = Vec::new();

    for line in lines {
        let trimmed = line.trim();
        if trimmed == "---" {
            break;
        }

        if collecting {
            if let Some(value) = trimmed.strip_prefix('-') {
                let value = value
                    .trim()
                    .trim_matches(|ch| matches!(ch, '"' | '\''))
                    .trim();
                if !value.is_empty() {
                    values.push(value.to_string());
                }
                continue;
            }

            if line.starts_with(' ') || line.starts_with('\t') || trimmed.is_empty() {
                continue;
            }

            break;
        }

        if let Some(value) = trimmed.strip_prefix(&format!("{key}:")) {
            if value.trim().is_empty() {
                collecting = true;
            } else {
                return None;
            }
        }
    }

    (!values.is_empty()).then_some(values)
}

fn file_updated_at_ms(path: &Path) -> Option<u64> {
    fs::metadata(path)
        .ok()
        .and_then(|metadata| metadata.modified().ok())
        .and_then(|modified| modified.duration_since(UNIX_EPOCH).ok())
        .and_then(|duration| u64::try_from(duration.as_millis()).ok())
}

fn workspace_skill_storage_path(workspace_root: &Path, name: &str) -> PathBuf {
    workspace_root
        .join(".claw")
        .join("skills")
        .join(name)
        .join("SKILL.md")
}

fn tenant_skill_storage_path(config: &AppConfig, tenant_id: &str, name: &str) -> PathBuf {
    config
        .tenant_skills_dir(tenant_id)
        .join(name)
        .join("SKILL.md")
}

fn delete_service_skill_file(path: &Path) -> Result<(), String> {
    fs::remove_file(path).map_err(|error| error.to_string())?;

    if path
        .file_name()
        .is_some_and(|file_name| file_name == "SKILL.md")
    {
        if let Some(parent) = path.parent() {
            let _ = fs::remove_dir(parent);
        }
    }

    Ok(())
}

fn render_skill_prompt(
    name: &str,
    description: Option<&str>,
    tags: &[String],
    starter_prompt: Option<&str>,
    prompt: &str,
) -> String {
    let mut rendered = String::from("---\n");
    rendered.push_str(&format!("name: {name}\n"));
    if let Some(description) = description.filter(|description| !description.trim().is_empty()) {
        rendered.push_str(&format!("description: {}\n", description.trim()));
    }
    if !tags.is_empty() {
        rendered.push_str(&format!("tags: {}\n", tags.join(", ")));
    }
    if let Some(starter_prompt) = starter_prompt.filter(|value| !value.trim().is_empty()) {
        rendered.push_str(&format!(
            "starter_prompt: {}\n",
            starter_prompt.replace('\n', " ").trim()
        ));
    }
    rendered.push_str("---\n\n");
    rendered.push_str(prompt.trim());
    rendered.push('\n');
    rendered
}

fn require_tenant_api_key_auth(auth: &AuthContext) -> Result<&str, AppError> {
    auth.tenant_id.as_deref().ok_or_else(|| {
        AppError::new(
            StatusCode::BAD_REQUEST,
            "api key management requires tenant-scoped API key authentication",
        )
    })
}

async fn get_auth_session(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
) -> Result<Json<AuthSessionResponse>, AppError> {
    let auth = resolve_auth_context(&state, &headers, &query)?;
    let is_admin = is_platform_admin(&state.config, &auth);
    Ok(Json(AuthSessionResponse {
        auth_mode: auth.auth_mode,
        tenant_id: auth.tenant_id,
        user_id: auth.user_id,
        api_key_id: auth.api_key_id,
        api_key_prefix: auth.api_key_prefix,
        display_name: auth.display_name,
        is_platform_admin: is_admin,
    }))
}

async fn list_api_keys(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
) -> Result<Json<ApiKeyListResponse>, AppError> {
    let auth = resolve_auth_context(&state, &headers, &query)?;
    let tenant_id = require_tenant_api_key_auth(&auth)?;
    let api_keys = state
        .store
        .list_api_keys(tenant_id, &auth.user_id)
        .map_err(|error| AppError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?
        .into_iter()
        .map(api_key_summary_response)
        .collect();
    Ok(Json(ApiKeyListResponse { api_keys }))
}

async fn create_api_key(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
    Json(request): Json<CreateApiKeyRequest>,
) -> Result<(StatusCode, Json<CreatedApiKeyResponse>), AppError> {
    let auth = resolve_auth_context(&state, &headers, &query)?;
    let _ = consume_mutation_rate_limit(&state, &auth)?;
    let tenant_id = require_tenant_api_key_auth(&auth)?;
    let display_name = normalize_api_key_display_name(request.display_name.as_deref())
        .map_err(|error| AppError::new(StatusCode::BAD_REQUEST, error))?;
    let raw_key = generate_api_key_secret();
    let now_ms = now_millis();
    let record = ApiKeyRecord {
        id: generate_id("api-key"),
        tenant_id: tenant_id.to_string(),
        user_id: auth.user_id.clone(),
        display_name,
        key_prefix: api_key_prefix(&raw_key),
        key_hash: hash_api_key(&raw_key),
        created_at_ms: now_ms,
        updated_at_ms: now_ms,
        last_used_at_ms: None,
        disabled_at_ms: None,
    };
    state
        .store
        .upsert_api_key(&record)
        .map_err(|error| AppError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;
    Ok((
        StatusCode::CREATED,
        Json(CreatedApiKeyResponse {
            api_key: api_key_summary_response(record),
            raw_key,
        }),
    ))
}

async fn disable_api_key(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
    AxumPath(id): AxumPath<String>,
) -> Result<StatusCode, AppError> {
    let auth = resolve_auth_context(&state, &headers, &query)?;
    let _ = consume_mutation_rate_limit(&state, &auth)?;
    let tenant_id = require_tenant_api_key_auth(&auth)?;
    if auth.api_key_id.as_deref() == Some(id.as_str()) {
        return Err(AppError::new(
            StatusCode::BAD_REQUEST,
            "cannot disable the currently authenticated api key; switch to another key first",
        ));
    }
    let disabled = state
        .store
        .disable_api_key(&id, tenant_id, &auth.user_id)
        .map_err(|error| AppError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;
    if !disabled {
        return Err(AppError::new(
            StatusCode::NOT_FOUND,
            format!("api key not found: {id}"),
        ));
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn list_skills(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<SkillQuery>,
) -> Result<Json<SkillListResponse>, AppError> {
    let auth = resolve_auth_context(&state, &headers, &auth_query_from_skill_query(&query))?;
    let workspace_root = resolve_skill_workspace_root(
        &state.store,
        &state.config,
        query.workspace_root.as_deref(),
        query.project_id.as_deref(),
    )?;
    let skills = list_service_skills(
        &state.config,
        workspace_root.as_deref(),
        auth.tenant_id.as_deref(),
    )
    .map_err(|error| AppError::new(StatusCode::INTERNAL_SERVER_ERROR, error))?
    .into_iter()
    .filter(|entry| match query.scope {
        Some(scope) => scope == entry.scope,
        None => true,
    })
    .map(|entry| SkillSummaryResponse {
        name: entry.name,
        description: entry.description,
        tags: entry.tags,
        starter_prompt: entry.starter_prompt,
        scope: entry.scope,
        updated_at_ms: entry.updated_at_ms,
    })
    .collect();

    Ok(Json(SkillListResponse { skills }))
}

async fn get_skill(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<SkillQuery>,
    AxumPath(name): AxumPath<String>,
) -> Result<Json<SkillDetailResponse>, AppError> {
    let auth = resolve_auth_context(&state, &headers, &auth_query_from_skill_query(&query))?;
    let workspace_root = resolve_skill_workspace_root(
        &state.store,
        &state.config,
        query.workspace_root.as_deref(),
        query.project_id.as_deref(),
    )?;
    let requested_name = query
        .scope
        .map(|scope| format!("{}:{name}", scope.as_str()))
        .unwrap_or(name);
    let detail = resolve_service_skill(
        &state.config,
        workspace_root.as_deref(),
        auth.tenant_id.as_deref(),
        &requested_name,
    )
    .map_err(|error| AppError::new(StatusCode::NOT_FOUND, error))?;

    Ok(Json(SkillDetailResponse {
        name: detail.entry.name,
        description: detail.entry.description,
        tags: detail.entry.tags,
        starter_prompt: detail.entry.starter_prompt,
        scope: detail.entry.scope,
        updated_at_ms: detail.entry.updated_at_ms,
        prompt: detail.prompt,
    }))
}

async fn upsert_skill(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
    Json(request): Json<UpsertSkillRequest>,
) -> Result<(StatusCode, Json<SkillDetailResponse>), AppError> {
    let auth = resolve_auth_context(&state, &headers, &query)?;
    let _ = consume_mutation_rate_limit(&state, &auth)?;
    let name = normalize_skill_name(&request.name)
        .map_err(|error| AppError::new(StatusCode::BAD_REQUEST, error))?;
    if request.prompt.trim().is_empty() {
        return Err(AppError::new(
            StatusCode::BAD_REQUEST,
            "skill prompt must not be empty",
        ));
    }

    let path = match request.scope {
        SkillScope::Workspace => {
            let workspace_root = resolve_skill_workspace_root(
                &state.store,
                &state.config,
                request.workspace_root.as_deref(),
                request.project_id.as_deref(),
            )?
            .ok_or_else(|| {
                AppError::new(
                    StatusCode::BAD_REQUEST,
                    "project_id or workspace_root is required for workspace-scoped skills",
                )
            })?;
            workspace_skill_storage_path(&workspace_root, &name)
        }
        SkillScope::Tenant => {
            let tenant_id = auth.tenant_id.as_deref().ok_or_else(|| {
                AppError::new(
                    StatusCode::BAD_REQUEST,
                    "tenant-scoped skills require tenant-scoped api key authentication",
                )
            })?;
            tenant_skill_storage_path(&state.config, tenant_id, &name)
        }
    };

    if let Some(parent) = path.parent() {
        fs::create_dir_all(parent)
            .map_err(|error| AppError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;
    }
    let normalized_tags = request
        .tags
        .unwrap_or_default()
        .into_iter()
        .map(|tag| tag.trim().to_string())
        .filter(|tag| !tag.is_empty())
        .collect::<Vec<_>>();
    let rendered = render_skill_prompt(
        &name,
        request.description.as_deref(),
        &normalized_tags,
        request.starter_prompt.as_deref(),
        &request.prompt,
    );
    fs::write(&path, rendered)
        .map_err(|error| AppError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;
    let prompt = fs::read_to_string(&path)
        .map_err(|error| AppError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;

    Ok((
        StatusCode::CREATED,
        Json(SkillDetailResponse {
            name,
            description: parse_skill_description_from_contents(&prompt),
            tags: parse_skill_tags_from_contents(&prompt),
            starter_prompt: parse_skill_starter_prompt_from_contents(&prompt),
            scope: request.scope,
            updated_at_ms: file_updated_at_ms(&path),
            prompt,
        }),
    ))
}

async fn delete_skill(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<SkillQuery>,
    AxumPath(name): AxumPath<String>,
) -> Result<StatusCode, AppError> {
    let auth = resolve_auth_context(&state, &headers, &auth_query_from_skill_query(&query))?;
    let _ = consume_mutation_rate_limit(&state, &auth)?;

    if matches!(query.scope, Some(SkillScope::Tenant)) && auth.tenant_id.is_none() {
        return Err(AppError::new(
            StatusCode::BAD_REQUEST,
            "tenant-scoped skills require tenant-scoped api key authentication",
        ));
    }

    let workspace_root = resolve_skill_workspace_root(
        &state.store,
        &state.config,
        query.workspace_root.as_deref(),
        query.project_id.as_deref(),
    )?;
    let requested_name = query
        .scope
        .map(|scope| format!("{}:{name}", scope.as_str()))
        .unwrap_or(name);
    let detail = resolve_service_skill(
        &state.config,
        workspace_root.as_deref(),
        auth.tenant_id.as_deref(),
        &requested_name,
    )
    .map_err(|error| AppError::new(StatusCode::NOT_FOUND, error))?;
    let read_only_root = service_skill_roots(
        &state.config,
        workspace_root.as_deref(),
        auth.tenant_id.as_deref(),
    )
    .into_iter()
    .find(|root| detail.entry.path.starts_with(&root.path) && !root.writable);
    if read_only_root.is_some() {
        return Err(AppError::new(
            StatusCode::FORBIDDEN,
            "built-in skills are read-only",
        ));
    }

    delete_service_skill_file(&detail.entry.path)
        .map_err(|error| AppError::new(StatusCode::INTERNAL_SERVER_ERROR, error))?;
    Ok(StatusCode::NO_CONTENT)
}

#[derive(Debug, Clone, Copy, Default, PartialEq, Eq)]
struct CapacityUsage {
    tenant_threads: usize,
    user_threads: usize,
    active_runs_global: usize,
    active_runs_tenant: usize,
    active_runs_user: usize,
}

fn record_matches_tenant_scope(record: &ThreadRecord, tenant_id: Option<&str>) -> bool {
    match (record.tenant_id.as_deref(), tenant_id) {
        (Some(left), Some(right)) => left == right,
        (None, None) => true,
        _ => false,
    }
}

fn record_matches_user_scope(
    record: &ThreadRecord,
    tenant_id: Option<&str>,
    user_id: &str,
) -> bool {
    record.owner_id.as_deref() == Some(user_id) && record_matches_tenant_scope(record, tenant_id)
}

fn project_matches_tenant_scope(record: &ProjectRecord, tenant_id: Option<&str>) -> bool {
    match (record.tenant_id.as_deref(), tenant_id) {
        (Some(left), Some(right)) => left == right,
        (None, None) => true,
        _ => false,
    }
}

fn project_matches_user_scope(
    record: &ProjectRecord,
    tenant_id: Option<&str>,
    user_id: &str,
) -> bool {
    if !project_matches_tenant_scope(record, tenant_id) {
        return false;
    }
    match record.owner_id.as_deref() {
        Some(owner_id) => owner_id == user_id,
        None => true,
    }
}

fn project_matches_platform_scope(record: &ProjectRecord, tenant_id: Option<&str>) -> bool {
    record.owner_id.is_none() && project_matches_tenant_scope(record, tenant_id)
}

fn project_is_visible_to_auth(
    config: &AppConfig,
    record: &ProjectRecord,
    auth: &AuthContext,
) -> bool {
    if is_platform_admin(config, auth) {
        return project_matches_platform_scope(record, auth.tenant_id.as_deref());
    }
    project_matches_user_scope(record, auth.tenant_id.as_deref(), &auth.user_id)
}

fn knowledge_base_matches_tenant_scope(
    record: &KnowledgeBaseRecord,
    tenant_id: Option<&str>,
) -> bool {
    match (record.tenant_id.as_deref(), tenant_id) {
        (Some(left), Some(right)) => left == right,
        (None, None) => true,
        _ => false,
    }
}

fn knowledge_base_matches_user_scope(
    record: &KnowledgeBaseRecord,
    tenant_id: Option<&str>,
    user_id: &str,
) -> bool {
    if !knowledge_base_matches_tenant_scope(record, tenant_id) {
        return false;
    }
    match record.owner_id.as_deref() {
        Some(owner_id) => owner_id == user_id,
        None => true,
    }
}

fn knowledge_base_matches_platform_scope(
    record: &KnowledgeBaseRecord,
    tenant_id: Option<&str>,
) -> bool {
    record.owner_id.is_none() && knowledge_base_matches_tenant_scope(record, tenant_id)
}

fn knowledge_base_is_visible_to_auth(
    config: &AppConfig,
    record: &KnowledgeBaseRecord,
    auth: &AuthContext,
) -> bool {
    if is_platform_admin(config, auth) {
        return knowledge_base_matches_platform_scope(record, auth.tenant_id.as_deref());
    }
    knowledge_base_matches_user_scope(record, auth.tenant_id.as_deref(), &auth.user_id)
}

fn data_source_matches_tenant_scope(record: &DataSourceRecord, tenant_id: Option<&str>) -> bool {
    match (record.tenant_id.as_deref(), tenant_id) {
        (Some(left), Some(right)) => left == right,
        (None, None) => true,
        _ => false,
    }
}

fn data_source_matches_user_scope(
    record: &DataSourceRecord,
    tenant_id: Option<&str>,
    user_id: &str,
) -> bool {
    if !data_source_matches_tenant_scope(record, tenant_id) {
        return false;
    }
    match record.owner_id.as_deref() {
        Some(owner_id) => owner_id == user_id,
        None => true,
    }
}

fn data_source_matches_platform_scope(record: &DataSourceRecord, tenant_id: Option<&str>) -> bool {
    record.owner_id.is_none() && data_source_matches_tenant_scope(record, tenant_id)
}

fn data_source_is_visible_to_auth(
    config: &AppConfig,
    record: &DataSourceRecord,
    auth: &AuthContext,
) -> bool {
    if is_platform_admin(config, auth) {
        return data_source_matches_platform_scope(record, auth.tenant_id.as_deref());
    }
    data_source_matches_user_scope(record, auth.tenant_id.as_deref(), &auth.user_id)
}

fn collect_capacity_usage<'a, I>(
    threads: I,
    tenant_id: Option<&str>,
    user_id: &str,
) -> CapacityUsage
where
    I: IntoIterator<Item = &'a Arc<ManagedThread>>,
{
    let mut usage = CapacityUsage::default();
    for thread in threads {
        let guard = thread
            .shared
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let record = &guard.record;
        let same_tenant = record_matches_tenant_scope(record, tenant_id);
        let same_user = record_matches_user_scope(record, tenant_id, user_id);
        if same_tenant {
            usage.tenant_threads += 1;
        }
        if same_user {
            usage.user_threads += 1;
        }
        if guard.current_run.is_some() {
            usage.active_runs_global += 1;
            if same_tenant {
                usage.active_runs_tenant += 1;
            }
            if same_user {
                usage.active_runs_user += 1;
            }
        }
    }
    usage
}

fn ensure_thread_capacity(config: &AppConfig, usage: &CapacityUsage) -> Result<(), String> {
    if let Some(limit) = config.max_threads_per_tenant {
        if usage.tenant_threads >= limit {
            return Err(format!(
                "tenant thread limit reached ({}/{})",
                usage.tenant_threads, limit
            ));
        }
    }
    if let Some(limit) = config.max_threads_per_user {
        if usage.user_threads >= limit {
            return Err(format!(
                "user thread limit reached ({}/{})",
                usage.user_threads, limit
            ));
        }
    }
    Ok(())
}

fn ensure_run_capacity(config: &AppConfig, usage: &CapacityUsage) -> Result<(), String> {
    if let Some(limit) = config.max_concurrent_runs_global {
        if usage.active_runs_global >= limit {
            return Err(format!(
                "global concurrent run limit reached ({}/{})",
                usage.active_runs_global, limit
            ));
        }
    }
    if let Some(limit) = config.max_concurrent_runs_per_tenant {
        if usage.active_runs_tenant >= limit {
            return Err(format!(
                "tenant concurrent run limit reached ({}/{})",
                usage.active_runs_tenant, limit
            ));
        }
    }
    if let Some(limit) = config.max_concurrent_runs_per_user {
        if usage.active_runs_user >= limit {
            return Err(format!(
                "user concurrent run limit reached ({}/{})",
                usage.active_runs_user, limit
            ));
        }
    }
    Ok(())
}

#[derive(Debug, Clone, Default, PartialEq, Eq)]
struct MutationRateUsage {
    global_requests: usize,
    tenant_requests: usize,
    user_requests: usize,
}

#[derive(Debug, Clone, Default)]
struct MutationRateWindow {
    minute_bucket: u64,
    count: usize,
}

#[derive(Debug, Default)]
struct MutationRateLimiter {
    global: MutationRateWindow,
    tenant: HashMap<String, MutationRateWindow>,
    user: HashMap<String, MutationRateWindow>,
}

impl MutationRateLimiter {
    fn peek_usage(
        &mut self,
        now_ms: u64,
        tenant_id: Option<&str>,
        user_id: &str,
    ) -> MutationRateUsage {
        let bucket = now_ms / 60_000;
        self.prune(bucket);
        MutationRateUsage {
            global_requests: window_usage(&mut self.global, bucket),
            tenant_requests: tenant_id
                .map(|tenant| {
                    let window = self.tenant.entry(tenant.to_string()).or_default();
                    window_usage(window, bucket)
                })
                .unwrap_or_default(),
            user_requests: {
                let key = mutation_user_scope_key(tenant_id, user_id);
                let window = self.user.entry(key).or_default();
                window_usage(window, bucket)
            },
        }
    }

    fn record(&mut self, now_ms: u64, tenant_id: Option<&str>, user_id: &str) -> MutationRateUsage {
        let bucket = now_ms / 60_000;
        self.prune(bucket);
        MutationRateUsage {
            global_requests: window_increment(&mut self.global, bucket),
            tenant_requests: tenant_id
                .map(|tenant| {
                    let window = self.tenant.entry(tenant.to_string()).or_default();
                    window_increment(window, bucket)
                })
                .unwrap_or_default(),
            user_requests: {
                let key = mutation_user_scope_key(tenant_id, user_id);
                let window = self.user.entry(key).or_default();
                window_increment(window, bucket)
            },
        }
    }

    fn prune(&mut self, current_bucket: u64) {
        self.tenant
            .retain(|_, window| window.minute_bucket >= current_bucket.saturating_sub(1));
        self.user
            .retain(|_, window| window.minute_bucket >= current_bucket.saturating_sub(1));
    }
}

fn mutation_user_scope_key(tenant_id: Option<&str>, user_id: &str) -> String {
    match tenant_id {
        Some(tenant) => format!("{tenant}:{user_id}"),
        None => format!("dev:{user_id}"),
    }
}

fn window_usage(window: &mut MutationRateWindow, minute_bucket: u64) -> usize {
    if window.minute_bucket != minute_bucket {
        window.minute_bucket = minute_bucket;
        window.count = 0;
    }
    window.count
}

fn window_increment(window: &mut MutationRateWindow, minute_bucket: u64) -> usize {
    if window.minute_bucket != minute_bucket {
        window.minute_bucket = minute_bucket;
        window.count = 0;
    }
    window.count += 1;
    window.count
}

fn ensure_mutation_rate_limit(config: &AppConfig, usage: &MutationRateUsage) -> Result<(), String> {
    if let Some(limit) = config.max_mutation_requests_per_minute_global {
        if usage.global_requests >= limit {
            return Err(format!(
                "global mutation rate limit reached ({}/{}) in the current minute",
                usage.global_requests, limit
            ));
        }
    }
    if let Some(limit) = config.max_mutation_requests_per_minute_per_tenant {
        if usage.tenant_requests >= limit {
            return Err(format!(
                "tenant mutation rate limit reached ({}/{}) in the current minute",
                usage.tenant_requests, limit
            ));
        }
    }
    if let Some(limit) = config.max_mutation_requests_per_minute_per_user {
        if usage.user_requests >= limit {
            return Err(format!(
                "user mutation rate limit reached ({}/{}) in the current minute",
                usage.user_requests, limit
            ));
        }
    }
    Ok(())
}

fn consume_mutation_rate_limit(
    state: &Arc<AppState>,
    auth: &AuthContext,
) -> Result<MutationRateUsage, AppError> {
    let now_ms = now_millis();
    let mut limiter = state
        .mutation_rate_limiter
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let usage = limiter.peek_usage(now_ms, auth.tenant_id.as_deref(), &auth.user_id);
    ensure_mutation_rate_limit(&state.config, &usage)
        .map_err(|error| AppError::new(StatusCode::TOO_MANY_REQUESTS, error))?;
    Ok(limiter.record(now_ms, auth.tenant_id.as_deref(), &auth.user_id))
}

async fn list_threads(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
) -> Result<Json<Value>, AppError> {
    let auth = resolve_auth_context(&state, &headers, &query)?;
    let threads = state
        .threads
        .read()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .values()
        .filter(|thread| thread_is_visible_to_auth(thread, &auth))
        .map(|thread| {
            let snapshot = thread.snapshot();
            ThreadSummary {
                id: snapshot.id,
                workspace_root: snapshot.workspace_root,
                project_id: snapshot.project_id,
                project_name: snapshot.project_name,
                knowledge_base_id: snapshot.knowledge_base_id,
                knowledge_base_name: snapshot.knowledge_base_name,
                model: snapshot.model,
                topic: snapshot.topic,
                status: snapshot.status,
                updated_at_ms: snapshot.updated_at_ms,
            }
        })
        .collect::<Vec<_>>();
    Ok(Json(json!({ "threads": threads })))
}

async fn create_agent_conversation(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
    Json(request): Json<CreateAgentConversationRequest>,
) -> Result<Json<AgentConversationRecord>, AppError> {
    let auth = resolve_auth_context(&state, &headers, &query)?;
    let now = now_millis();
    let record = AgentConversationRecord {
        id: generate_id("conversation"),
        tenant_id: auth.tenant_id.clone(),
        owner_id: auth.user_id.clone(),
        title: normalize_optional_text(request.title).unwrap_or_else(|| "新对话".to_string()),
        status: AgentConversationStatus::Idle,
        selected_knowledge_base_ids: request
            .selected_knowledge_base_ids
            .map(normalize_string_list)
            .unwrap_or_default(),
        selected_data_source_ids: request
            .selected_data_source_ids
            .map(normalize_string_list)
            .unwrap_or_default(),
        selected_expert_ids: request
            .selected_expert_ids
            .map(normalize_string_list)
            .unwrap_or_default(),
        model_profile_id: normalize_optional_text(request.model_profile_id),
        created_at_ms: now,
        updated_at_ms: now,
    };
    state
        .store
        .upsert_agent_conversation(&record)
        .map_err(|error| AppError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;
    Ok(Json(record))
}

async fn list_agent_conversations(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
) -> Result<Json<Vec<AgentConversationRecord>>, AppError> {
    let auth = resolve_auth_context(&state, &headers, &query)?;
    let conversations = state
        .store
        .list_agent_conversations(auth.tenant_id.as_deref(), &auth.user_id)
        .map_err(|error| AppError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;
    Ok(Json(conversations))
}

async fn list_agent_turns(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<Vec<AgentTurnRecord>>, AppError> {
    let auth = resolve_auth_context(&state, &headers, &query)?;
    let turns = state
        .store
        .list_agent_turns(&id, auth.tenant_id.as_deref(), &auth.user_id)
        .map_err(|error| AppError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;
    Ok(Json(turns))
}

async fn delete_agent_conversation(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
    AxumPath(id): AxumPath<String>,
) -> Result<StatusCode, AppError> {
    let auth = resolve_auth_context(&state, &headers, &query)?;
    let deleted = state
        .store
        .delete_agent_conversation(&id, auth.tenant_id.as_deref(), &auth.user_id)
        .map_err(|error| AppError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;
    if deleted {
        Ok(StatusCode::NO_CONTENT)
    } else {
        Err(AppError::new(
            StatusCode::NOT_FOUND,
            "conversation not found",
        ))
    }
}

fn agent_conversation_for_auth(
    state: &AppState,
    auth: &AuthContext,
    conversation_id: &str,
) -> Result<AgentConversationRecord, AppError> {
    state
        .store
        .list_agent_conversations(auth.tenant_id.as_deref(), &auth.user_id)
        .map_err(|error| AppError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?
        .into_iter()
        .find(|conversation| conversation.id == conversation_id)
        .ok_or_else(|| AppError::new(StatusCode::NOT_FOUND, "conversation not found"))
}

fn create_agent_runtime_thread(
    state: &AppState,
    auth: &AuthContext,
    conversation: &AgentConversationRecord,
) -> Result<Arc<ManagedThread>, AppError> {
    let workspace_root = state
        .config
        .managed_workspace_root(auth.tenant_id.as_deref(), &auth.user_id);
    fs::create_dir_all(&workspace_root).map_err(|error| {
        AppError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("failed to create managed runtime workspace: {error}"),
        )
    })?;
    let workspace_root = workspace_root.canonicalize().map_err(|error| {
        AppError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            format!("failed to prepare managed runtime workspace: {error}"),
        )
    })?;
    let store = SessionStore::from_data_dir(&state.config.data_dir, &workspace_root)
        .map_err(|error| AppError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;
    let mut session = Session::new().with_workspace_root(workspace_root.clone());
    let handle = store.create_handle(&session.session_id);
    session = session.with_persistence_path(handle.path.clone());
    session
        .save_to_path(&handle.path)
        .map_err(|error| AppError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;
    let model_profile = conversation
        .model_profile_id
        .as_deref()
        .map(|project_id| {
            state.store.get_project(project_id).map_err(|error| {
                AppError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
            })
        })
        .transpose()?
        .flatten();

    let record = ThreadRecord {
        id: format!("agent-runtime-{}", conversation.id),
        tenant_id: conversation.tenant_id.clone(),
        owner_id: Some(conversation.owner_id.clone()),
        workspace_root,
        session_path: handle.path,
        project_id: conversation.model_profile_id.clone(),
        project_name: None,
        knowledge_base_id: conversation.selected_knowledge_base_ids.first().cloned(),
        knowledge_base_name: None,
        model: model_profile
            .as_ref()
            .and_then(|project| project.default_model.clone())
            .unwrap_or_else(|| state.config.default_model.clone()),
        model_access: model_profile
            .as_ref()
            .map(|project| project.model_access.clone())
            .unwrap_or_default(),
        permission_mode: PermissionMode::ReadOnly.as_str().to_string(),
        topic: Some(conversation.title.clone()),
        instructions: None,
        preferred_skill_names: conversation.selected_expert_ids.clone(),
        memory_notes: Vec::new(),
        artifacts: Vec::new(),
        created_at_ms: now_millis(),
        updated_at_ms: now_millis(),
        last_status: Some(ThreadStatus::Idle),
        last_error: None,
        next_run_id: 1,
    };
    Ok(Arc::new(ManagedThread::new(ThreadState {
        record,
        visible_memory_notes: Vec::new(),
        audit_records: Vec::new(),
        session,
        status: ThreadStatus::Idle,
        last_error: None,
        draft_assistant_text: String::new(),
        next_run_id: 1,
        current_run: None,
        pending_replan: None,
    })))
}

async fn post_ag_ui_run(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
    Json(request): Json<AgUiRunRequest>,
) -> Result<Response, AppError> {
    let auth = resolve_auth_context(&state, &headers, &query)?;
    let mut conversation = agent_conversation_for_auth(&state, &auth, &request.thread_id)?;
    conversation = apply_ag_ui_forwarded_context(conversation, &request);
    state
        .store
        .upsert_agent_conversation(&conversation)
        .map_err(|error| AppError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;
    if !extract_ag_ui_forwarded_tool_updates(&request).is_empty() {
        return post_forwarded_ag_ui_run(state, auth, request);
    }

    post_runtime_ag_ui_run(state, auth, conversation, request)
}

fn post_forwarded_ag_ui_run(
    state: Arc<AppState>,
    auth: AuthContext,
    request: AgUiRunRequest,
) -> Result<Response, AppError> {
    let now = now_millis();
    let user_message = extract_ag_ui_user_message(&request).unwrap_or_else(|| "新问题".to_string());
    let assistant_text = "执行过程已开始，正在持续返回结果。".to_string();
    let tool_updates = extract_ag_ui_forwarded_tool_updates(&request);
    let turn_id = if request.run_id.trim().is_empty() {
        generate_id("turn")
    } else {
        request.run_id.trim().to_string()
    };
    let message_id = format!("{turn_id}-assistant");
    let record = AgentTurnRecord {
        id: turn_id.clone(),
        conversation_id: request.thread_id.clone(),
        tenant_id: auth.tenant_id.clone(),
        owner_id: auth.user_id.clone(),
        user_message,
        assistant_text: assistant_text.clone(),
        status: AgentTurnStatus::Succeeded,
        started_at_ms: now,
        completed_at_ms: Some(now),
        steps: tool_updates
            .iter()
            .flat_map(|update| update.steps.clone())
            .collect(),
        citations: tool_updates
            .iter()
            .flat_map(|update| update.citations.clone())
            .collect(),
        expert_results: tool_updates
            .iter()
            .flat_map(|update| update.expert_results.clone())
            .collect(),
        artifacts: Vec::new(),
        error: None,
        debug_events: tool_updates
            .iter()
            .map(|update| update.debug_event.clone())
            .collect(),
    };
    state
        .store
        .upsert_agent_turn(&record)
        .map_err(|error| AppError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;

    let mut events = vec![
        AgUiEvent::run_started(&request.thread_id, &turn_id, now),
        AgUiEvent::TextMessageStart {
            message_id: message_id.clone(),
            role: "assistant".to_string(),
            timestamp: now,
        },
        AgUiEvent::TextMessageContent {
            message_id: message_id.clone(),
            delta: assistant_text,
            timestamp: now,
        },
    ];
    for update in &tool_updates {
        let status = update
            .steps
            .first()
            .map(|step| step.status.clone())
            .unwrap_or(AgentTurnStepStatus::Succeeded);
        events.push(AgUiEvent::ActivityDelta {
            delta: json!({
                "kind": "tool",
                "status": status,
                "steps": update.steps,
                "citations": update.citations,
                "expertResults": update.expert_results,
            }),
            timestamp: now,
        });
        events.push(AgUiEvent::StateSnapshot {
            snapshot: json!({ "debugEvent": update.debug_event }),
            timestamp: now,
        });
    }
    events.extend([
        AgUiEvent::TextMessageEnd {
            message_id,
            timestamp: now,
        },
        AgUiEvent::RunFinished {
            thread_id: request.thread_id,
            run_id: turn_id,
            timestamp: now,
            result: json!({
                "turn": record,
                "request_state": request.state,
                "context_count": request.context.len(),
            }),
        },
    ]);
    let stream = stream! {
        for event in events {
            let data = encode_ag_ui_sse_frame(&event)
                .unwrap_or_else(|error| format!("data: {{\"type\":\"RUN_ERROR\",\"message\":\"failed to encode event: {error}\",\"timestamp\":{}}}\n\n", now_millis()));
            yield Ok::<Event, std::convert::Infallible>(
                Event::default().data(data.trim_start_matches("data: ").trim_end()),
            );
        }
    };
    Ok(Sse::new(stream)
        .keep_alive(KeepAlive::default())
        .into_response())
}

fn post_runtime_ag_ui_run(
    state: Arc<AppState>,
    auth: AuthContext,
    conversation: AgentConversationRecord,
    request: AgUiRunRequest,
) -> Result<Response, AppError> {
    let now = now_millis();
    let user_message = extract_ag_ui_user_message(&request).unwrap_or_else(|| "新问题".to_string());
    let turn_id = if request.run_id.trim().is_empty() {
        generate_id("turn")
    } else {
        request.run_id.trim().to_string()
    };
    let message_id = format!("{turn_id}-assistant");
    let record = AgentTurnRecord {
        id: turn_id.clone(),
        conversation_id: conversation.id.clone(),
        tenant_id: auth.tenant_id.clone(),
        owner_id: auth.user_id.clone(),
        user_message: user_message.clone(),
        assistant_text: String::new(),
        status: AgentTurnStatus::Running,
        started_at_ms: now,
        completed_at_ms: None,
        steps: Vec::new(),
        citations: Vec::new(),
        expert_results: Vec::new(),
        artifacts: Vec::new(),
        error: None,
        debug_events: Vec::new(),
    };
    state
        .store
        .upsert_agent_turn(&record)
        .map_err(|error| AppError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;

    let thread = create_agent_runtime_thread(&state, &auth, &conversation)?;
    let (sender, mut receiver) = tokio::sync::mpsc::unbounded_channel::<AgUiEvent>();
    let sink = AgentRunEventSink {
        turn_id: turn_id.clone(),
        message_id: message_id.clone(),
        sender,
        store: state.store.clone(),
        record: Arc::new(Mutex::new(record)),
    };
    let run_request = RunRequest {
        kind: RunKind::UserMessage,
        prompt: user_message,
        expert_panel: None,
        expert_run: None,
        execution_context: Some(RunExecutionContext {
            knowledge_base_id: conversation.selected_knowledge_base_ids.first().cloned(),
            data_source_ids: if conversation.selected_data_source_ids.is_empty() {
                None
            } else {
                Some(conversation.selected_data_source_ids.clone())
            },
            knowledge_base_name: None,
            auto_retrieval: Some(true),
        }),
    };
    {
        let mut guard = thread
            .shared
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        guard.current_run = Some(ActiveRun {
            run_id: 1,
            abort_signal: HookAbortSignal::new(),
            request: run_request,
        });
        guard.status = ThreadStatus::Running;
        guard.record.updated_at_ms = now_millis();
    }

    let sink_for_task = sink.clone();
    let thread_for_task = thread.clone();
    let state_for_task = state.clone();
    let thread_id = conversation.id.clone();
    let run_id = turn_id.clone();
    let message_id_for_task = message_id.clone();
    tokio::spawn(async move {
        sink_for_task.send(AgUiEvent::run_started(&thread_id, &run_id, now_millis()));
        sink_for_task.send(AgUiEvent::TextMessageStart {
            message_id: message_id_for_task.clone(),
            role: "assistant".to_string(),
            timestamp: now_millis(),
        });
        let result = tokio::task::spawn_blocking({
            let thread = thread_for_task.clone();
            let state = state_for_task.clone();
            let sink = sink_for_task.clone();
            move || execute_run_with_agent_sink(thread, state, 1, Some(sink))
        })
        .await;

        match result {
            Ok(Ok(_outcome)) => {
                let final_record = sink_for_task.finish(AgentTurnStatus::Succeeded, None);
                sink_for_task.send(AgUiEvent::TextMessageEnd {
                    message_id: message_id_for_task,
                    timestamp: now_millis(),
                });
                sink_for_task.send(AgUiEvent::RunFinished {
                    thread_id,
                    run_id,
                    timestamp: now_millis(),
                    result: json!({ "turn": final_record }),
                });
            }
            Ok(Err(failure)) => {
                let final_record = sink_for_task.finish(
                    AgentTurnStatus::Failed,
                    Some(AgentTurnError {
                        public_message: "处理失败".to_string(),
                        debug_message: Some(failure.error.clone()),
                        code: None,
                    }),
                );
                sink_for_task.send(AgUiEvent::RunError {
                    message: failure.error.clone(),
                    code: None,
                    timestamp: now_millis(),
                });
                sink_for_task.send(AgUiEvent::RunFinished {
                    thread_id,
                    run_id,
                    timestamp: now_millis(),
                    result: json!({ "turn": final_record }),
                });
            }
            Err(error) => {
                let error_text = format!("runtime task failed: {error}");
                let final_record = sink_for_task.finish(
                    AgentTurnStatus::Failed,
                    Some(AgentTurnError {
                        public_message: "处理失败".to_string(),
                        debug_message: Some(error_text.clone()),
                        code: None,
                    }),
                );
                sink_for_task.send(AgUiEvent::RunError {
                    message: error_text,
                    code: None,
                    timestamp: now_millis(),
                });
                sink_for_task.send(AgUiEvent::RunFinished {
                    thread_id,
                    run_id,
                    timestamp: now_millis(),
                    result: json!({ "turn": final_record }),
                });
            }
        }
    });

    let stream = stream! {
        while let Some(event) = receiver.recv().await {
            let data = encode_ag_ui_sse_frame(&event)
                .unwrap_or_else(|error| format!("data: {{\"type\":\"RUN_ERROR\",\"message\":\"failed to encode event: {error}\",\"timestamp\":{}}}\n\n", now_millis()));
            yield Ok::<Event, std::convert::Infallible>(
                Event::default().data(data.trim_start_matches("data: ").trim_end()),
            );
            if matches!(event, AgUiEvent::RunFinished { .. } | AgUiEvent::RunError { .. }) {
                if matches!(event, AgUiEvent::RunFinished { .. }) {
                    break;
                }
            }
        }
    };
    Ok(Sse::new(stream)
        .keep_alive(KeepAlive::default())
        .into_response())
}

async fn interrupt_agent_conversation(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<Value>, AppError> {
    let auth = resolve_auth_context(&state, &headers, &query)?;
    let mut conversations = state
        .store
        .list_agent_conversations(auth.tenant_id.as_deref(), &auth.user_id)
        .map_err(|error| AppError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;
    let Some(mut conversation) = conversations
        .drain(..)
        .find(|conversation| conversation.id == id)
    else {
        return Err(AppError::new(
            StatusCode::NOT_FOUND,
            "conversation not found",
        ));
    };
    conversation.status = AgentConversationStatus::Interrupted;
    conversation.updated_at_ms = now_millis();
    state
        .store
        .upsert_agent_conversation(&conversation)
        .map_err(|error| AppError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;
    Ok(Json(json!({ "conversation": conversation })))
}

async fn list_projects(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
) -> Result<Json<Value>, AppError> {
    let auth = resolve_auth_context(&state, &headers, &query)?;
    let projects = state
        .store
        .load_projects()
        .map_err(|error| AppError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?
        .into_iter()
        .filter(|record| project_is_visible_to_auth(&state.config, record, &auth))
        .map(project_summary_from_record)
        .collect::<Vec<_>>();
    Ok(Json(json!({ "projects": projects })))
}

async fn get_project(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<ProjectSummary>, AppError> {
    let auth = resolve_auth_context(&state, &headers, &query)?;
    let project = state
        .store
        .get_project(&id)
        .map_err(|error| AppError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?
        .ok_or_else(|| AppError::new(StatusCode::NOT_FOUND, "project not found"))?;
    if !project_is_visible_to_auth(&state.config, &project, &auth) {
        return Err(AppError::new(StatusCode::NOT_FOUND, "project not found"));
    }

    Ok(Json(project_summary_from_record(project)))
}

async fn list_knowledge_bases(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
) -> Result<Json<KnowledgeBaseListResponse>, AppError> {
    let auth = resolve_auth_context(&state, &headers, &query)?;
    let data_sources = state
        .store
        .load_data_sources()
        .map_err(|error| AppError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;
    let visible_sources = data_sources
        .into_iter()
        .filter(|record| data_source_is_visible_to_auth(&state.config, record, &auth))
        .collect::<Vec<_>>();

    let knowledge_bases = state
        .store
        .load_knowledge_bases()
        .map_err(|error| AppError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?
        .into_iter()
        .filter(|record| knowledge_base_is_visible_to_auth(&state.config, record, &auth))
        .map(|record| {
            let count = visible_sources
                .iter()
                .filter(|source| source.knowledge_base_id == record.id)
                .count();
            knowledge_base_summary_from_record(record, count)
        })
        .collect();

    Ok(Json(KnowledgeBaseListResponse { knowledge_bases }))
}

async fn create_knowledge_base(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
    Json(request): Json<CreateKnowledgeBaseRequest>,
) -> Result<Json<KnowledgeBaseSummary>, AppError> {
    let auth = resolve_auth_context(&state, &headers, &query)?;
    let _ = consume_mutation_rate_limit(&state, &auth)?;
    let name = request.name.trim();
    if name.is_empty() {
        return Err(AppError::new(
            StatusCode::BAD_REQUEST,
            "knowledge base name must not be empty",
        ));
    }

    let legacy_workspace_root = request
        .legacy_workspace_root
        .as_deref()
        .map(|value| canonicalize_workspace(value, &state.config))
        .transpose()?;

    let record = KnowledgeBaseRecord {
        id: generate_id("kb"),
        tenant_id: auth.tenant_id.clone(),
        owner_id: if is_platform_admin(&state.config, &auth) {
            None
        } else {
            Some(auth.user_id.clone())
        },
        name: name.to_string(),
        description: normalize_optional_text(request.description),
        default_project_id: normalize_optional_text(request.default_project_id),
        legacy_workspace_root,
        created_at_ms: now_millis(),
        updated_at_ms: now_millis(),
    };
    state
        .store
        .upsert_knowledge_base(&record)
        .map_err(|error| AppError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;

    Ok(Json(knowledge_base_summary_from_record(record, 0)))
}

async fn delete_knowledge_base(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
    AxumPath(id): AxumPath<String>,
) -> Result<StatusCode, AppError> {
    let auth = resolve_auth_context(&state, &headers, &query)?;
    let _ = consume_mutation_rate_limit(&state, &auth)?;
    let knowledge_base = state
        .store
        .get_knowledge_base(&id)
        .map_err(|error| AppError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?
        .ok_or_else(|| AppError::new(StatusCode::NOT_FOUND, "knowledge base not found"))?;
    if !knowledge_base_is_visible_to_auth(&state.config, &knowledge_base, &auth) {
        return Err(AppError::new(
            StatusCode::NOT_FOUND,
            "knowledge base not found",
        ));
    }

    let linked_thread_exists = state
        .store
        .load_records()
        .map_err(|error| AppError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?
        .into_iter()
        .any(|thread| thread.knowledge_base_id.as_deref() == Some(knowledge_base.id.as_str()));
    if linked_thread_exists {
        return Err(AppError::new(
            StatusCode::CONFLICT,
            "knowledge base is still used by existing conversations",
        ));
    }

    let linked_sources = state
        .store
        .load_data_sources()
        .map_err(|error| AppError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?
        .into_iter()
        .filter(|item| item.knowledge_base_id == knowledge_base.id)
        .collect::<Vec<_>>();
    for source in linked_sources {
        if source.kind == DataSourceKind::Upload {
            let files =
                object_array_config_value(&source.config, "files", parse_document_file_record);
            for file in &files {
                remove_uploaded_document_file(&state.config, &source, file);
            }
            let storage_dir = data_source_storage_dir(&state.config, &source);
            if let Err(error) = fs::remove_dir_all(&storage_dir) {
                if error.kind() != std::io::ErrorKind::NotFound {
                    eprintln!(
                        "failed to remove data source storage {}: {}",
                        source.id, error
                    );
                }
            }
        }

        state
            .store
            .delete_data_source(&source.id)
            .map_err(|error| AppError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;
    }

    let deleted = state
        .store
        .delete_knowledge_base(&knowledge_base.id)
        .map_err(|error| AppError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;
    if !deleted {
        return Err(AppError::new(
            StatusCode::NOT_FOUND,
            "knowledge base not found",
        ));
    }

    Ok(StatusCode::NO_CONTENT)
}

async fn list_data_sources(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
) -> Result<Json<DataSourceListResponse>, AppError> {
    let auth = resolve_auth_context(&state, &headers, &query)?;
    let data_sources = state
        .store
        .load_data_sources()
        .map_err(|error| AppError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?
        .into_iter()
        .filter(|record| data_source_is_visible_to_auth(&state.config, record, &auth))
        .map(data_source_summary_from_record)
        .collect();
    Ok(Json(DataSourceListResponse { data_sources }))
}

async fn get_data_source(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<DataSourceDetail>, AppError> {
    let auth = resolve_auth_context(&state, &headers, &query)?;
    let record = state
        .store
        .load_data_sources()
        .map_err(|error| AppError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?
        .into_iter()
        .find(|item| item.id == id)
        .ok_or_else(|| AppError::new(StatusCode::NOT_FOUND, "data source not found"))?;
    if !data_source_is_visible_to_auth(&state.config, &record, &auth) {
        return Err(AppError::new(
            StatusCode::NOT_FOUND,
            "data source not found",
        ));
    }
    Ok(Json(data_source_detail_from_record(record)))
}

async fn create_data_source(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
    Json(request): Json<CreateDataSourceRequest>,
) -> Result<Json<DataSourceSummary>, AppError> {
    let auth = resolve_auth_context(&state, &headers, &query)?;
    let _ = consume_mutation_rate_limit(&state, &auth)?;
    let name = request.name.trim();
    if name.is_empty() {
        return Err(AppError::new(
            StatusCode::BAD_REQUEST,
            "data source name must not be empty",
        ));
    }

    let knowledge_base = state
        .store
        .get_knowledge_base(&request.knowledge_base_id)
        .map_err(|error| AppError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?
        .ok_or_else(|| AppError::new(StatusCode::NOT_FOUND, "knowledge base not found"))?;
    if !knowledge_base_is_visible_to_auth(&state.config, &knowledge_base, &auth) {
        return Err(AppError::new(
            StatusCode::NOT_FOUND,
            "knowledge base not found",
        ));
    }

    let mut config = request.config.unwrap_or_else(|| json!({}));
    normalize_data_source_config(&state.config, request.kind, &mut config)?;

    let record = DataSourceRecord {
        id: generate_id("source"),
        knowledge_base_id: request.knowledge_base_id,
        tenant_id: auth.tenant_id.clone(),
        owner_id: if is_platform_admin(&state.config, &auth) {
            None
        } else {
            Some(auth.user_id.clone())
        },
        name: name.to_string(),
        kind: request.kind,
        description: normalize_optional_text(request.description),
        config,
        status: Some("ready".to_string()),
        last_test: None,
        last_synced_at_ms: None,
        created_at_ms: now_millis(),
        updated_at_ms: now_millis(),
    };
    state
        .store
        .upsert_data_source(&record)
        .map_err(|error| AppError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;

    Ok(Json(data_source_summary_from_record(record)))
}

async fn update_data_source(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
    AxumPath(id): AxumPath<String>,
    Json(request): Json<UpdateDataSourceRequest>,
) -> Result<Json<DataSourceSummary>, AppError> {
    let auth = resolve_auth_context(&state, &headers, &query)?;
    let _ = consume_mutation_rate_limit(&state, &auth)?;
    let mut record = state
        .store
        .load_data_sources()
        .map_err(|error| AppError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?
        .into_iter()
        .find(|item| item.id == id)
        .ok_or_else(|| AppError::new(StatusCode::NOT_FOUND, "data source not found"))?;
    if !data_source_is_visible_to_auth(&state.config, &record, &auth) {
        return Err(AppError::new(
            StatusCode::NOT_FOUND,
            "data source not found",
        ));
    }

    if let Some(name) = request.name {
        let trimmed = name.trim();
        if trimmed.is_empty() {
            return Err(AppError::new(
                StatusCode::BAD_REQUEST,
                "data source name must not be empty",
            ));
        }
        record.name = trimmed.to_string();
    }
    if let Some(description) = request.description {
        record.description = normalize_optional_text(Some(description));
    }
    if let Some(mut config) = request.config {
        if record.kind == DataSourceKind::Upload {
            if config.get("files").is_none() {
                config["files"] = record
                    .config
                    .get("files")
                    .cloned()
                    .unwrap_or_else(|| Value::Array(Vec::new()));
            }
        }
        normalize_data_source_config(&state.config, record.kind, &mut config)?;
        record.config = config;
    }
    record.updated_at_ms = now_millis();
    state
        .store
        .upsert_data_source(&record)
        .map_err(|error| AppError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;

    Ok(Json(data_source_summary_from_record(record)))
}

async fn test_data_source(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
    Json(request): Json<TestDataSourceRequest>,
) -> Result<Json<TestDataSourceResponse>, AppError> {
    let auth = resolve_auth_context(&state, &headers, &query)?;
    let _ = consume_mutation_rate_limit(&state, &auth)?;
    let mut config = request.config.unwrap_or_else(|| json!({}));
    normalize_data_source_config(&state.config, request.kind, &mut config)?;
    let result = build_data_source_test_result(request.kind, &config)?;
    Ok(Json(TestDataSourceResponse {
        ok: true,
        kind: request.kind,
        summary: result.summary.clone(),
        result,
    }))
}

async fn test_saved_data_source(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<TestDataSourceResponse>, AppError> {
    let auth = resolve_auth_context(&state, &headers, &query)?;
    let _ = consume_mutation_rate_limit(&state, &auth)?;
    let mut record = state
        .store
        .load_data_sources()
        .map_err(|error| AppError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?
        .into_iter()
        .find(|item| item.id == id)
        .ok_or_else(|| AppError::new(StatusCode::NOT_FOUND, "data source not found"))?;
    if !data_source_is_visible_to_auth(&state.config, &record, &auth) {
        return Err(AppError::new(
            StatusCode::NOT_FOUND,
            "data source not found",
        ));
    }

    let mut config = record.config.clone();
    normalize_data_source_config(&state.config, record.kind, &mut config)?;
    record.config = config.clone();
    let result = build_data_source_test_result(record.kind, &config)?;
    record.last_test = Some(result.clone());
    record.updated_at_ms = now_millis();
    state
        .store
        .upsert_data_source(&record)
        .map_err(|error| AppError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;

    Ok(Json(TestDataSourceResponse {
        ok: true,
        kind: record.kind,
        summary: result.summary.clone(),
        result,
    }))
}

fn normalize_data_source_config(
    config: &AppConfig,
    kind: DataSourceKind,
    payload: &mut Value,
) -> Result<(), AppError> {
    if !payload.is_object() {
        *payload = json!({});
    }
    match kind {
        DataSourceKind::LocalDir => {
            let path = payload.get("path").and_then(Value::as_str).ok_or_else(|| {
                AppError::new(
                    StatusCode::BAD_REQUEST,
                    "local_dir data source requires config.path",
                )
            })?;
            let canonical = canonicalize_workspace(path, config)?;
            payload["path"] = Value::String(canonical.display().to_string());
        }
        DataSourceKind::Web => {
            let urls = string_array_config_value(payload, "urls");
            if urls.is_empty() {
                return Err(AppError::new(
                    StatusCode::BAD_REQUEST,
                    "web data source requires config.urls",
                ));
            }
            payload["urls"] = json!(urls);
        }
        DataSourceKind::Db => {
            let url = string_config_value(payload, "url")
                .or_else(|| string_config_value(payload, "endpoint"))
                .or_else(|| string_config_value(payload, "base_url"))
                .ok_or_else(|| {
                    AppError::new(
                        StatusCode::BAD_REQUEST,
                        "db data source requires config.url",
                    )
                })?;
            payload["url"] = Value::String(url);
        }
        DataSourceKind::Upload => {
            if payload.get("files").is_none() {
                payload["files"] = Value::Array(Vec::new());
            }
        }
        _ => {}
    }
    Ok(())
}

async fn create_project(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
    Json(request): Json<CreateProjectRequest>,
) -> Result<Json<ProjectSummary>, AppError> {
    let auth = resolve_auth_context(&state, &headers, &query)?;
    let _ = consume_mutation_rate_limit(&state, &auth)?;
    let workspace_root = if let Some(requested_root) = request.workspace_root.as_deref() {
        canonicalize_workspace(requested_root, &state.config)?
    } else {
        let managed_root = state
            .config
            .managed_workspace_root(auth.tenant_id.as_deref(), &auth.user_id)
            .join(generate_id("project"));
        fs::create_dir_all(&managed_root).map_err(|error| {
            AppError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("failed to create managed project workspace: {error}"),
            )
        })?;
        managed_root.canonicalize().map_err(|error| {
            AppError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("failed to prepare managed project workspace: {error}"),
            )
        })?
    };
    let name = request.name.trim();
    if name.is_empty() {
        return Err(AppError::new(
            StatusCode::BAD_REQUEST,
            "project name must not be empty",
        ));
    }
    let default_skill_names = normalize_project_default_skill_names(
        &state.config,
        &workspace_root,
        auth.tenant_id.as_deref(),
        request.default_skill_names,
    )
    .map_err(|error| AppError::new(StatusCode::BAD_REQUEST, error))?;
    let default_permission_mode = request
        .default_permission_mode
        .as_deref()
        .map(parse_permission_mode)
        .transpose()
        .map_err(|error| AppError::new(StatusCode::BAD_REQUEST, error))?
        .map(|mode| mode.as_str().to_string());

    let project = ProjectRecord {
        id: generate_id("project"),
        tenant_id: auth.tenant_id.clone(),
        owner_id: if is_platform_admin(&state.config, &auth) {
            None
        } else {
            Some(auth.user_id.clone())
        },
        name: name.to_string(),
        description: normalize_optional_text(request.description),
        workspace_root,
        default_topic: normalize_optional_text(request.default_topic),
        default_model: normalize_optional_text(request.default_model),
        model_access: normalize_model_access_from_parts(
            request.model_base_url,
            request.model_base_url_env,
            request.model_api_key,
            request.model_api_key_env,
        ),
        default_permission_mode,
        starter_prompt: normalize_optional_text(request.starter_prompt),
        default_instructions: normalize_optional_text(request.default_instructions),
        default_skill_names,
        created_at_ms: now_millis(),
        updated_at_ms: now_millis(),
    };
    state
        .store
        .upsert_project(&project)
        .map_err(|error| AppError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;
    Ok(Json(project_summary_from_record(project)))
}

async fn upload_data_source_file(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
    AxumPath(id): AxumPath<String>,
    mut multipart: Multipart,
) -> Result<Json<UploadedDocumentSummary>, AppError> {
    let auth = resolve_auth_context(&state, &headers, &query)?;
    let _ = consume_mutation_rate_limit(&state, &auth)?;
    let mut data_source = state
        .store
        .load_data_sources()
        .map_err(|error| AppError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?
        .into_iter()
        .find(|item| item.id == id)
        .ok_or_else(|| AppError::new(StatusCode::NOT_FOUND, "data source not found"))?;
    if !data_source_is_visible_to_auth(&state.config, &data_source, &auth) {
        return Err(AppError::new(
            StatusCode::NOT_FOUND,
            "data source not found",
        ));
    }
    if data_source.kind != DataSourceKind::Upload {
        return Err(AppError::new(
            StatusCode::BAD_REQUEST,
            "only upload data sources accept file uploads",
        ));
    }

    let mut uploaded: Option<UploadedDocumentSummary> = None;
    while let Some(field) = multipart.next_field().await.map_err(|error| {
        AppError::new(
            StatusCode::BAD_REQUEST,
            format!("multipart read failed: {error}"),
        )
    })? {
        let file_name = field
            .file_name()
            .map(str::to_string)
            .filter(|value| !value.trim().is_empty())
            .unwrap_or_else(|| "uploaded-document".to_string());
        let mime_type = field.content_type().map(str::to_string);
        let bytes = field.bytes().await.map_err(|error| {
            AppError::new(
                StatusCode::BAD_REQUEST,
                format!("failed to read uploaded file: {error}"),
            )
        })?;
        let record = persist_uploaded_document(
            &state.config,
            &data_source,
            &file_name,
            mime_type.clone(),
            &bytes,
        )?;
        let mut files =
            object_array_config_value(&data_source.config, "files", parse_document_file_record);
        files.push(record.clone());
        data_source.config["files"] = serde_json::to_value(&files)
            .map_err(|error| AppError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;
        data_source.status = Some("ready".to_string());
        data_source.last_synced_at_ms = Some(record.uploaded_at_ms);
        data_source.updated_at_ms = now_millis();
        state
            .store
            .upsert_data_source(&data_source)
            .map_err(|error| AppError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;
        uploaded = Some(UploadedDocumentSummary {
            id: record.id,
            file_name: record.file_name,
            mime_type: record.mime_type,
            size_bytes: record.size_bytes,
            uploaded_at_ms: record.uploaded_at_ms,
        });
        break;
    }

    uploaded
        .ok_or_else(|| AppError::new(StatusCode::BAD_REQUEST, "no file was uploaded"))
        .map(Json)
}

async fn delete_data_source(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
    AxumPath(id): AxumPath<String>,
) -> Result<StatusCode, AppError> {
    let auth = resolve_auth_context(&state, &headers, &query)?;
    let _ = consume_mutation_rate_limit(&state, &auth)?;
    let data_source = state
        .store
        .load_data_sources()
        .map_err(|error| AppError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?
        .into_iter()
        .find(|item| item.id == id)
        .ok_or_else(|| AppError::new(StatusCode::NOT_FOUND, "data source not found"))?;
    if !data_source_is_visible_to_auth(&state.config, &data_source, &auth) {
        return Err(AppError::new(
            StatusCode::NOT_FOUND,
            "data source not found",
        ));
    }

    if data_source.kind == DataSourceKind::Upload {
        let files =
            object_array_config_value(&data_source.config, "files", parse_document_file_record);
        for file in &files {
            remove_uploaded_document_file(&state.config, &data_source, file);
        }
        let storage_dir = data_source_storage_dir(&state.config, &data_source);
        if let Err(error) = fs::remove_dir_all(&storage_dir) {
            if error.kind() != std::io::ErrorKind::NotFound {
                eprintln!(
                    "failed to remove data source storage {}: {}",
                    data_source.id, error
                );
            }
        }
    }

    let deleted = state
        .store
        .delete_data_source(&data_source.id)
        .map_err(|error| AppError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;
    if !deleted {
        return Err(AppError::new(
            StatusCode::NOT_FOUND,
            "data source not found",
        ));
    }
    Ok(StatusCode::NO_CONTENT)
}

async fn delete_data_source_file(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
    AxumPath((id, file_id)): AxumPath<(String, String)>,
) -> Result<StatusCode, AppError> {
    let auth = resolve_auth_context(&state, &headers, &query)?;
    let _ = consume_mutation_rate_limit(&state, &auth)?;
    let mut data_source = state
        .store
        .load_data_sources()
        .map_err(|error| AppError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?
        .into_iter()
        .find(|item| item.id == id)
        .ok_or_else(|| AppError::new(StatusCode::NOT_FOUND, "data source not found"))?;
    if !data_source_is_visible_to_auth(&state.config, &data_source, &auth) {
        return Err(AppError::new(
            StatusCode::NOT_FOUND,
            "data source not found",
        ));
    }
    if data_source.kind != DataSourceKind::Upload {
        return Err(AppError::new(
            StatusCode::BAD_REQUEST,
            "only upload data sources contain managed files",
        ));
    }

    let mut files =
        object_array_config_value(&data_source.config, "files", parse_document_file_record);
    let index = files
        .iter()
        .position(|item| item.id == file_id)
        .ok_or_else(|| AppError::new(StatusCode::NOT_FOUND, "uploaded file not found"))?;
    let removed = files.remove(index);
    remove_uploaded_document_file(&state.config, &data_source, &removed);
    data_source.config["files"] = serde_json::to_value(&files)
        .map_err(|error| AppError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;
    data_source.last_synced_at_ms = files.iter().map(|item| item.uploaded_at_ms).max();
    data_source.status = Some(if files.is_empty() {
        "empty".to_string()
    } else {
        "ready".to_string()
    });
    data_source.updated_at_ms = now_millis();
    state
        .store
        .upsert_data_source(&data_source)
        .map_err(|error| AppError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;
    Ok(StatusCode::NO_CONTENT)
}

async fn update_project(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
    AxumPath(id): AxumPath<String>,
    Json(request): Json<UpdateProjectRequest>,
) -> Result<Json<ProjectSummary>, AppError> {
    let auth = resolve_auth_context(&state, &headers, &query)?;
    let _ = consume_mutation_rate_limit(&state, &auth)?;
    let mut project = state
        .store
        .get_project(&id)
        .map_err(|error| AppError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?
        .ok_or_else(|| AppError::new(StatusCode::NOT_FOUND, "project not found"))?;
    if !project_is_visible_to_auth(&state.config, &project, &auth) {
        return Err(AppError::new(StatusCode::NOT_FOUND, "project not found"));
    }

    apply_project_update(
        &state.config,
        &mut project,
        auth.tenant_id.as_deref(),
        request,
    )
    .map_err(|error| AppError::new(StatusCode::BAD_REQUEST, error))?;

    state
        .store
        .upsert_project(&project)
        .map_err(|error| AppError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;
    Ok(Json(project_summary_from_record(project)))
}

async fn create_thread(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
    Json(request): Json<CreateThreadRequest>,
) -> Result<Json<ThreadSnapshot>, AppError> {
    let auth = resolve_auth_context(&state, &headers, &query)?;
    let linked_project = if let Some(project_id) = request.project_id.as_deref() {
        let project = state
            .store
            .get_project(project_id)
            .map_err(|error| AppError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?
            .ok_or_else(|| AppError::new(StatusCode::NOT_FOUND, "project not found"))?;
        if !project_is_visible_to_auth(&state.config, &project, &auth) {
            return Err(AppError::new(StatusCode::NOT_FOUND, "project not found"));
        }
        Some(project)
    } else {
        None
    };
    let linked_knowledge_base = if let Some(knowledge_base_id) =
        request.knowledge_base_id.as_deref()
    {
        let knowledge_base = state
            .store
            .get_knowledge_base(knowledge_base_id)
            .map_err(|error| AppError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?
            .ok_or_else(|| AppError::new(StatusCode::NOT_FOUND, "knowledge base not found"))?;
        if !knowledge_base_is_visible_to_auth(&state.config, &knowledge_base, &auth) {
            return Err(AppError::new(
                StatusCode::NOT_FOUND,
                "knowledge base not found",
            ));
        }
        Some(knowledge_base)
    } else if let Some(project) = &linked_project {
        state
            .store
            .load_knowledge_bases()
            .map_err(|error| AppError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?
            .into_iter()
            .find(|item| item.default_project_id.as_deref() == Some(project.id.as_str()))
    } else {
        None
    };
    if let (Some(project), Some(knowledge_base)) = (&linked_project, &linked_knowledge_base) {
        if let Some(default_project_id) = knowledge_base.default_project_id.as_deref() {
            if default_project_id != project.id {
                return Err(AppError::new(
                    StatusCode::BAD_REQUEST,
                    "knowledge base does not belong to the selected project",
                ));
            }
        }
    }
    let workspace_root = if let Some(project) = &linked_project {
        project.workspace_root.clone()
    } else if let Some(knowledge_base) = &linked_knowledge_base {
        if let Some(root) = knowledge_base.legacy_workspace_root.clone() {
            root
        } else {
            let managed_root = state
                .config
                .managed_workspace_root(auth.tenant_id.as_deref(), &auth.user_id);
            fs::create_dir_all(&managed_root).map_err(|error| {
                AppError::new(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("failed to create managed workspace: {error}"),
                )
            })?;
            managed_root.canonicalize().map_err(|error| {
                AppError::new(
                    StatusCode::INTERNAL_SERVER_ERROR,
                    format!("failed to prepare managed workspace: {error}"),
                )
            })?
        }
    } else if let Some(requested_root) = request.workspace_root.as_deref() {
        canonicalize_workspace(requested_root, &state.config)?
    } else {
        let managed_root = state
            .config
            .managed_workspace_root(auth.tenant_id.as_deref(), &auth.user_id);
        fs::create_dir_all(&managed_root).map_err(|error| {
            AppError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("failed to create managed workspace: {error}"),
            )
        })?;
        managed_root.canonicalize().map_err(|error| {
            AppError::new(
                StatusCode::INTERNAL_SERVER_ERROR,
                format!("failed to prepare managed workspace: {error}"),
            )
        })?
    };
    let _ = consume_mutation_rate_limit(&state, &auth)?;
    let _admission = state
        .admission
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let usage = {
        let threads = state
            .threads
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        collect_capacity_usage(threads.values(), auth.tenant_id.as_deref(), &auth.user_id)
    };
    ensure_thread_capacity(&state.config, &usage)
        .map_err(|error| AppError::new(StatusCode::TOO_MANY_REQUESTS, error))?;
    let model = request
        .model
        .or_else(|| {
            linked_project
                .as_ref()
                .and_then(|project| project.default_model.clone())
        })
        .unwrap_or_else(|| state.config.default_model.clone());
    let request_model_access = normalize_model_access_from_parts(
        request.model_base_url,
        None,
        request.model_api_key,
        None,
    );
    let has_request_model_access =
        request_model_access.base_url.is_some() || request_model_access.api_key.is_some();
    let permission_mode = request
        .permission_mode
        .as_deref()
        .map(parse_permission_mode)
        .transpose()
        .map_err(|error| AppError::new(StatusCode::BAD_REQUEST, error))?
        .or_else(|| {
            linked_project
                .as_ref()
                .and_then(|project| project.default_permission_mode.as_deref())
                .map(parse_permission_mode)
                .transpose()
                .ok()
                .flatten()
        })
        .unwrap_or(state.config.default_permission_mode);

    let store = SessionStore::from_data_dir(&state.config.data_dir, &workspace_root)
        .map_err(|error| AppError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;
    let mut session = Session::new().with_workspace_root(workspace_root.clone());
    let handle = store.create_handle(&session.session_id);
    session = session.with_persistence_path(handle.path.clone());
    session
        .save_to_path(&handle.path)
        .map_err(|error| AppError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;

    let record = ThreadRecord {
        id: generate_id("thread"),
        tenant_id: auth.tenant_id.clone(),
        owner_id: Some(auth.user_id.clone()),
        workspace_root,
        session_path: handle.path,
        project_id: linked_project.as_ref().map(|project| project.id.clone()),
        project_name: linked_project.as_ref().map(|project| project.name.clone()),
        knowledge_base_id: linked_knowledge_base.as_ref().map(|item| item.id.clone()),
        knowledge_base_name: linked_knowledge_base.as_ref().map(|item| item.name.clone()),
        model,
        model_access: if has_request_model_access {
            request_model_access
        } else {
            linked_project
                .as_ref()
                .map(|project| project.model_access.clone())
                .unwrap_or_default()
        },
        permission_mode: permission_mode.as_str().to_string(),
        topic: request.topic.or_else(|| {
            linked_project
                .as_ref()
                .and_then(|project| project.default_topic.clone())
        }),
        instructions: linked_project
            .as_ref()
            .and_then(|project| project.default_instructions.clone()),
        preferred_skill_names: linked_project
            .as_ref()
            .map(|project| project.default_skill_names.clone())
            .unwrap_or_default(),
        memory_notes: Vec::new(),
        artifacts: Vec::new(),
        created_at_ms: now_millis(),
        updated_at_ms: now_millis(),
        last_status: Some(ThreadStatus::Idle),
        last_error: None,
        next_run_id: 1,
    };
    let managed = Arc::new(ManagedThread::new(ThreadState {
        record,
        visible_memory_notes: Vec::new(),
        audit_records: Vec::new(),
        session,
        status: ThreadStatus::Idle,
        last_error: None,
        draft_assistant_text: String::new(),
        next_run_id: 1,
        current_run: None,
        pending_replan: None,
    }));
    persist_thread_state(&managed, &state.store)
        .map_err(|error| AppError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;
    let record = managed
        .shared
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .record
        .clone();
    let visible_memory_notes = state
        .store
        .load_visible_memory_notes(&record)
        .map_err(|error| AppError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;
    {
        let mut guard = managed
            .shared
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        guard.visible_memory_notes = visible_memory_notes;
    }
    try_append_thread_audit(
        &state.store,
        &managed,
        "thread_created",
        None,
        json!({
            "tenant_id": record.tenant_id,
            "project_id": record.project_id,
            "project_name": record.project_name,
            "workspace_root": record.workspace_root.display().to_string(),
            "model": record.model,
            "permission_mode": record.permission_mode,
            "topic": record.topic,
            "instructions": record.instructions.as_ref().map(|value| truncate_audit_text(value)),
            "preferred_skill_names": record.preferred_skill_names,
            "owner_id": record.owner_id,
        }),
    );
    let snapshot = managed.snapshot();
    state.insert_thread(managed);
    Ok(Json(snapshot))
}

async fn get_thread(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
    AxumPath(id): AxumPath<String>,
) -> Result<Json<ThreadSnapshot>, AppError> {
    let auth = resolve_auth_context(&state, &headers, &query)?;
    let thread = state
        .get_thread(&id)
        .ok_or_else(|| AppError::new(StatusCode::NOT_FOUND, format!("thread not found: {id}")))?;
    ensure_thread_access(&thread, &auth)?;
    Ok(Json(thread.snapshot()))
}

async fn delete_thread(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
    AxumPath(id): AxumPath<String>,
) -> Result<StatusCode, AppError> {
    let auth = resolve_auth_context(&state, &headers, &query)?;
    let _ = consume_mutation_rate_limit(&state, &auth)?;
    let thread = state
        .get_thread(&id)
        .ok_or_else(|| AppError::new(StatusCode::NOT_FOUND, format!("thread not found: {id}")))?;
    ensure_thread_access(&thread, &auth)?;

    {
        let guard = thread
            .shared
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if guard.current_run.is_some() {
            return Err(AppError::new(
                StatusCode::CONFLICT,
                "thread is running; interrupt it before deleting",
            ));
        }
    }

    let snapshot = thread.snapshot();
    let session_path = snapshot.session_path.clone();
    let thread_id = snapshot.id.clone();
    let deleted = state
        .store
        .delete_thread(&thread_id)
        .map_err(|error| AppError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;
    if !deleted {
        return Err(AppError::new(
            StatusCode::NOT_FOUND,
            format!("thread not found: {thread_id}"),
        ));
    }

    {
        let mut threads = state
            .threads
            .write()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        threads.remove(&thread_id);
    }

    if let Err(error) = fs::remove_file(&session_path) {
        if error.kind() != std::io::ErrorKind::NotFound {
            eprintln!(
                "failed to remove session file for thread {}: {}",
                thread_id, error
            );
        }
    }

    Ok(StatusCode::NO_CONTENT)
}

async fn thread_events(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
    AxumPath(id): AxumPath<String>,
) -> Result<impl IntoResponse, AppError> {
    let auth = resolve_auth_context(&state, &headers, &query)?;
    let thread = state
        .get_thread(&id)
        .ok_or_else(|| AppError::new(StatusCode::NOT_FOUND, format!("thread not found: {id}")))?;
    ensure_thread_access(&thread, &auth)?;
    let initial = thread.snapshot();
    let mut receiver = thread.events.subscribe();

    let stream = stream! {
        yield Ok::<Event, std::convert::Infallible>(
            Event::default()
                .event("snapshot")
                .data(serde_json::to_string(&initial).unwrap_or_else(|_| "{}".to_string()))
        );
        loop {
            match receiver.recv().await {
                Ok(envelope) => {
                    let payload = serde_json::to_string(&envelope).unwrap_or_else(|_| "{}".to_string());
                    yield Ok::<Event, std::convert::Infallible>(
                        Event::default().event(envelope.kind).data(payload)
                    );
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    };

    Ok(Sse::new(stream).keep_alive(KeepAlive::default()))
}

async fn post_thread_command(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
    AxumPath(id): AxumPath<String>,
    Json(command): Json<CommandRequest>,
) -> Result<Json<ThreadSnapshot>, AppError> {
    let auth = resolve_auth_context(&state, &headers, &query)?;
    let thread = state
        .get_thread(&id)
        .ok_or_else(|| AppError::new(StatusCode::NOT_FOUND, format!("thread not found: {id}")))?;
    ensure_thread_access(&thread, &auth)?;
    if let Err(error) = consume_mutation_rate_limit(&state, &auth) {
        try_append_thread_audit(
            &state.store,
            &thread,
            "request_rejected",
            None,
            json!({
                "reason": error.message.clone(),
                "request": "thread_command",
            }),
        );
        return Err(error);
    }

    match command {
        CommandRequest::UserMessage {
            content,
            expert_panel,
            knowledge_base_id,
            data_source_ids,
            auto_retrieval,
        } => {
            let expert_panel = expert_panel
                .map(normalize_expert_panel_request)
                .transpose()
                .map_err(|error| AppError::new(StatusCode::BAD_REQUEST, error))?;
            start_run(
                state.clone(),
                thread.clone(),
                RunRequest {
                    kind: RunKind::UserMessage,
                    prompt: content,
                    expert_panel,
                    expert_run: None,
                    execution_context: Some(RunExecutionContext {
                        knowledge_base_id: normalize_optional_text(knowledge_base_id),
                        data_source_ids: data_source_ids
                            .map(|items| {
                                items
                                    .into_iter()
                                    .map(|item| item.trim().to_string())
                                    .filter(|item| !item.is_empty())
                                    .collect::<Vec<_>>()
                            })
                            .filter(|items| !items.is_empty()),
                        knowledge_base_name: None,
                        auto_retrieval,
                    }),
                },
            )?;
        }
        CommandRequest::Interrupt { reason } => {
            let snapshot = request_interrupt(&state.store, &thread, reason);
            return Ok(Json(snapshot));
        }
        CommandRequest::Replan { reason, topic } => {
            let prompt = build_replan_prompt(topic.as_deref(), reason.as_deref());
            if let Some(next_topic) = topic.clone() {
                {
                    let mut guard = thread
                        .shared
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    guard.record.topic = Some(next_topic.clone());
                    guard.record.updated_at_ms = now_millis();
                }
                try_append_thread_audit(
                    &state.store,
                    &thread,
                    "topic_updated",
                    None,
                    json!({
                        "topic": next_topic,
                        "source": "replan",
                    }),
                );
            }
            if is_running(&thread) {
                queue_replan(
                    &thread,
                    RunRequest {
                        kind: RunKind::Replan,
                        prompt,
                        expert_panel: None,
                        expert_run: None,
                        execution_context: None,
                    },
                )?;
                try_append_thread_audit(
                    &state.store,
                    &thread,
                    "replan_queued",
                    None,
                    json!({
                        "reason": reason.clone(),
                        "topic": topic.clone(),
                    }),
                );
                let snapshot = request_interrupt(&state.store, &thread, reason);
                persist_thread_state(&thread, &state.store).map_err(|error| {
                    AppError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
                })?;
                return Ok(Json(snapshot));
            }
            start_run(
                state.clone(),
                thread.clone(),
                RunRequest {
                    kind: RunKind::Replan,
                    prompt,
                    expert_panel: None,
                    expert_run: None,
                    execution_context: None,
                },
            )?;
        }
        CommandRequest::SetTopic { topic } => {
            {
                let mut guard = thread
                    .shared
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner);
                guard.record.topic = Some(topic.clone());
                guard.record.updated_at_ms = now_millis();
            }
            persist_thread_state(&thread, &state.store).map_err(|error| {
                AppError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string())
            })?;
            try_append_thread_audit(
                &state.store,
                &thread,
                "topic_updated",
                None,
                json!({
                    "topic": topic,
                    "source": "set_topic",
                }),
            );
            let snapshot = thread.snapshot();
            thread.publish("status_changed", json!(snapshot.clone()));
            return Ok(Json(snapshot));
        }
    }

    Ok(Json(thread.snapshot()))
}

async fn create_expert_panel_run(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
    AxumPath(thread_id): AxumPath<String>,
    Json(request): Json<ExpertPanelRunRequest>,
) -> Result<Json<ExpertPanelRunResponse>, AppError> {
    let auth = resolve_auth_context(&state, &headers, &query)?;
    let thread = state.get_thread(&thread_id).ok_or_else(|| {
        AppError::new(
            StatusCode::NOT_FOUND,
            format!("thread not found: {thread_id}"),
        )
    })?;
    ensure_thread_access(&thread, &auth)?;
    if let Err(error) = consume_mutation_rate_limit(&state, &auth) {
        try_append_thread_audit(
            &state.store,
            &thread,
            "request_rejected",
            None,
            json!({
                "reason": error.message.clone(),
                "request": "expert_panel_run",
            }),
        );
        return Err(error);
    }

    let request = normalize_expert_panel_run_request(request)
        .map_err(|error| AppError::new(StatusCode::BAD_REQUEST, error))?;
    if is_running(&thread) {
        return Err(AppError::new(
            StatusCode::CONFLICT,
            "thread is already running; interrupt first or wait for completion",
        ));
    }
    let thread_record = thread
        .shared
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .record
        .clone();

    let run_id = generate_id("expert-run");
    let prompt = if let Some(question) = request.question.clone() {
        question
    } else {
        let source_message_id = request.source_message_id.as_deref().unwrap_or_default();
        resolve_source_message_text(&thread, source_message_id).ok_or_else(|| {
            AppError::new(
                StatusCode::BAD_REQUEST,
                format!("source_message_id not found or has no visible text: {source_message_id}"),
            )
        })?
    };
    let execution_context = resolve_run_execution_context(
        &state.store,
        &thread_record,
        &RunRequest {
            kind: RunKind::ExpertPanel,
            prompt: prompt.clone(),
            expert_panel: None,
            expert_run: None,
            execution_context: Some(RunExecutionContext {
                knowledge_base_id: request.knowledge_base_id.clone(),
                data_source_ids: request.data_source_ids.clone(),
                knowledge_base_name: None,
                auto_retrieval: request.auto_retrieval,
            }),
        },
    )?;
    let response = expert_run_initial_response(&thread_id, &run_id, &request);
    start_run(
        state.clone(),
        thread.clone(),
        RunRequest {
            kind: RunKind::ExpertPanel,
            prompt,
            expert_panel: Some(ExpertPanelRequest {
                panel_id: run_id.clone(),
                master_skill: "expert-brainstorm".to_string(),
                experts: request.experts.clone(),
            }),
            expert_run: Some(ExpertPanelRunExecution {
                run_id: run_id.clone(),
                retry_count: request.retry_count.unwrap_or(1),
                concurrency_limit: request.concurrency_limit.unwrap_or(3),
            }),
            execution_context,
        },
    )?;
    persist_expert_run_state(&state, &thread, &response)
        .map_err(|error| AppError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?;

    Ok(Json(response))
}

async fn get_expert_panel_run(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
    AxumPath((thread_id, run_id)): AxumPath<(String, String)>,
) -> Result<Json<ExpertPanelRunResponse>, AppError> {
    let auth = resolve_auth_context(&state, &headers, &query)?;
    let thread = state.get_thread(&thread_id).ok_or_else(|| {
        AppError::new(
            StatusCode::NOT_FOUND,
            format!("thread not found: {thread_id}"),
        )
    })?;
    ensure_thread_access(&thread, &auth)?;
    let response = load_expert_run_response(&state, &thread, &run_id)?.ok_or_else(|| {
        AppError::new(
            StatusCode::NOT_FOUND,
            format!("expert panel run not found: {run_id}"),
        )
    })?;
    Ok(Json(response))
}

fn envelope_matches_expert_run(envelope: &ThreadEventEnvelope, run_id: &str) -> bool {
    envelope.payload.get("run_id").and_then(Value::as_str) == Some(run_id)
}

async fn expert_panel_run_events(
    State(state): State<Arc<AppState>>,
    headers: HeaderMap,
    Query(query): Query<AuthQuery>,
    AxumPath((thread_id, run_id)): AxumPath<(String, String)>,
) -> Result<impl IntoResponse, AppError> {
    let auth = resolve_auth_context(&state, &headers, &query)?;
    let thread = state.get_thread(&thread_id).ok_or_else(|| {
        AppError::new(
            StatusCode::NOT_FOUND,
            format!("thread not found: {thread_id}"),
        )
    })?;
    ensure_thread_access(&thread, &auth)?;
    let initial = load_expert_run_response(&state, &thread, &run_id)?.ok_or_else(|| {
        AppError::new(
            StatusCode::NOT_FOUND,
            format!("expert panel run not found: {run_id}"),
        )
    })?;
    let mut receiver = thread.events.subscribe();

    let stream = stream! {
        yield Ok::<Event, std::convert::Infallible>(
            Event::default()
                .event("snapshot")
                .data(serde_json::to_string(&initial).unwrap_or_else(|_| "{}".to_string()))
        );
        loop {
            match receiver.recv().await {
                Ok(envelope) => {
                    if !envelope_matches_expert_run(&envelope, &run_id) {
                        continue;
                    }
                    let payload = serde_json::to_string(&envelope).unwrap_or_else(|_| "{}".to_string());
                    yield Ok::<Event, std::convert::Infallible>(
                        Event::default().event(envelope.kind).data(payload)
                    );
                }
                Err(tokio::sync::broadcast::error::RecvError::Lagged(_)) => continue,
                Err(tokio::sync::broadcast::error::RecvError::Closed) => break,
            }
        }
    };

    Ok(Sse::new(stream).keep_alive(KeepAlive::default()))
}

fn queue_replan(thread: &Arc<ManagedThread>, request: RunRequest) -> Result<(), AppError> {
    let mut guard = thread
        .shared
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    guard.pending_replan = Some(request);
    guard.record.updated_at_ms = now_millis();
    Ok(())
}

fn request_interrupt(
    store: &ThreadStore,
    thread: &Arc<ManagedThread>,
    reason: Option<String>,
) -> ThreadSnapshot {
    let changed = {
        let mut guard = thread
            .shared
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if let Some(active) = &guard.current_run {
            active.abort_signal.abort();
            guard.status = ThreadStatus::InterruptRequested;
            guard.last_error = reason.clone();
            guard.record.updated_at_ms = now_millis();
            true
        } else {
            false
        }
    };
    if changed {
        try_append_thread_audit(
            store,
            thread,
            "interrupt_requested",
            None,
            json!({
                "reason": reason,
            }),
        );
    }
    let snapshot = thread.snapshot();
    thread.publish("status_changed", json!(snapshot.clone()));
    snapshot
}

fn is_running(thread: &Arc<ManagedThread>) -> bool {
    thread
        .shared
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .current_run
        .is_some()
}

fn thread_is_visible_to_auth(thread: &Arc<ManagedThread>, auth: &AuthContext) -> bool {
    let record = thread
        .shared
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .record
        .clone();
    if record.owner_id.as_deref() != Some(auth.user_id.as_str()) {
        return false;
    }
    match (&record.tenant_id, &auth.tenant_id) {
        (Some(record_tenant), Some(auth_tenant)) => record_tenant == auth_tenant,
        (None, None) => true,
        _ => false,
    }
}

fn ensure_thread_access(thread: &Arc<ManagedThread>, auth: &AuthContext) -> Result<(), AppError> {
    if thread_is_visible_to_auth(thread, auth) {
        Ok(())
    } else {
        Err(AppError::new(StatusCode::NOT_FOUND, "thread not found"))
    }
}

fn start_run(
    state: Arc<AppState>,
    thread: Arc<ManagedThread>,
    request: RunRequest,
) -> Result<(), AppError> {
    let _admission = state
        .admission
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let record = thread
        .shared
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .record
        .clone();
    let execution_context = resolve_run_execution_context(&state.store, &record, &request)?;
    let usage = {
        let threads = state
            .threads
            .read()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        collect_capacity_usage(
            threads.values(),
            record.tenant_id.as_deref(),
            record.owner_id.as_deref().unwrap_or_default(),
        )
    };

    let run_id = {
        let mut guard = thread
            .shared
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        if guard.current_run.is_some() {
            return Err(AppError::new(
                StatusCode::CONFLICT,
                "thread is already running; interrupt first or wait for completion",
            ));
        }
        if let Err(error) = ensure_run_capacity(&state.config, &usage) {
            drop(guard);
            try_append_thread_audit(
                &state.store,
                &thread,
                "run_rejected",
                None,
                json!({
                    "reason": error,
                    "active_runs_global": usage.active_runs_global,
                    "active_runs_tenant": usage.active_runs_tenant,
                    "active_runs_user": usage.active_runs_user,
                }),
            );
            return Err(AppError::new(StatusCode::TOO_MANY_REQUESTS, error));
        }
        let run_id = guard.next_run_id;
        guard.next_run_id += 1;
        guard.current_run = Some(ActiveRun {
            run_id,
            abort_signal: HookAbortSignal::new(),
            request: request.clone(),
        });
        guard.status = ThreadStatus::Running;
        guard.last_error = None;
        guard.draft_assistant_text.clear();
        guard.record.updated_at_ms = now_millis();
        run_id
    };

    if let Err(error) = persist_thread_state(&thread, &state.store) {
        {
            let mut guard = thread
                .shared
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            if guard
                .current_run
                .as_ref()
                .is_some_and(|active| active.run_id == run_id)
            {
                guard.current_run = None;
                guard.status = ThreadStatus::Idle;
                guard.last_error = Some(format!("failed to persist run start: {error}"));
                guard.draft_assistant_text.clear();
                guard.record.updated_at_ms = now_millis();
            }
        }
        return Err(AppError::new(
            StatusCode::INTERNAL_SERVER_ERROR,
            error.to_string(),
        ));
    }
    try_append_thread_audit(
        &state.store,
        &thread,
        "run_started",
        Some(run_id),
        json!({
            "run_kind": request.kind,
            "prompt": truncate_audit_text(&request.prompt),
            "expert_panel": request.expert_panel.as_ref().map(|panel| json!({
                "panel_id": panel.panel_id,
                "master_skill": panel.master_skill,
                "experts": panel.experts.iter().map(|expert| json!({
                    "skill": format!("{}:{}", expert.scope.as_str(), expert.skill),
                    "label": expert.label,
                })).collect::<Vec<_>>(),
            })),
            "execution_context": execution_context,
            "topic": thread
                .shared
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner)
                .record
                .topic
                .clone(),
        }),
    );
    let _ = persist_research_task_state(&state, &thread);
    let snapshot = thread.snapshot();
    thread.publish("run_started", json!(snapshot.clone()));

    let thread_for_task = thread.clone();
    let state_for_task = state.clone();
    tokio::spawn(async move {
        let result = tokio::task::spawn_blocking({
            let thread = thread_for_task.clone();
            let state = state_for_task.clone();
            move || {
                let kind = {
                    let guard = thread
                        .shared
                        .lock()
                        .unwrap_or_else(std::sync::PoisonError::into_inner);
                    guard
                        .current_run
                        .as_ref()
                        .map(|active| active.request.kind.clone())
                };
                if matches!(kind, Some(RunKind::ExpertPanel)) {
                    execute_expert_panel_run(thread, state, run_id)
                } else {
                    execute_run(thread, state, run_id)
                }
            }
        });

        let run_completion = if let Some(timeout_secs) = state_for_task.config.run_timeout_secs {
            match tokio::time::timeout(std::time::Duration::from_secs(timeout_secs), result).await {
                Ok(joined) => classify_run_completion(&thread_for_task, run_id, joined),
                Err(_) => {
                    abort_run_if_active(&thread_for_task, run_id);
                    let outcome = current_run_outcome(&thread_for_task);
                    RunCompletion::TimedOut {
                        error: format!("run timed out after {timeout_secs}s"),
                        outcome,
                    }
                }
            }
        } else {
            let joined = result.await;
            classify_run_completion(&thread_for_task, run_id, joined)
        };
        finalize_run(state_for_task, thread_for_task, run_id, run_completion);
    });

    Ok(())
}

fn finalize_run(
    state: Arc<AppState>,
    thread: Arc<ManagedThread>,
    run_id: u64,
    result: RunCompletion,
) {
    let (publish_kind, audit_kind, audit_payload, follow_up) = {
        let mut guard = thread
            .shared
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let Some(active) = &guard.current_run else {
            return;
        };
        if active.run_id != run_id {
            return;
        }
        let run_kind = active.request.kind.clone();

        match result {
            RunCompletion::Completed(outcome) => {
                guard.session = outcome.session;
                guard.session.model = Some(guard.record.model.clone());
                guard.status = ThreadStatus::Idle;
                guard.last_error = None;
                guard.draft_assistant_text.clear();
                guard.current_run = None;
                guard.record.updated_at_ms = now_millis();
                (
                    "run_completed",
                    "run_completed",
                    json!({ "run_kind": run_kind }),
                    guard.pending_replan.take(),
                )
            }
            RunCompletion::Interrupted(outcome) => {
                guard.session = outcome.session;
                guard.session.model = Some(guard.record.model.clone());
                guard.status = ThreadStatus::Idle;
                guard.last_error = Some("run interrupted".to_string());
                guard.draft_assistant_text.clear();
                guard.current_run = None;
                guard.record.updated_at_ms = now_millis();
                (
                    "run_completed",
                    "run_interrupted",
                    json!({ "run_kind": run_kind }),
                    guard.pending_replan.take(),
                )
            }
            RunCompletion::Failed { error, outcome }
            | RunCompletion::TimedOut { error, outcome } => {
                guard.session = outcome.session;
                guard.session.model = Some(guard.record.model.clone());
                guard.status = ThreadStatus::Failed;
                guard.last_error = Some(error.clone());
                guard.draft_assistant_text.clear();
                guard.current_run = None;
                guard.record.updated_at_ms = now_millis();
                (
                    "run_failed",
                    "run_failed",
                    json!({
                        "run_kind": run_kind,
                        "error": error,
                    }),
                    guard.pending_replan.take(),
                )
            }
        }
    };

    let persist_result = persist_thread_state(&thread, &state.store);
    if let Err(error) = persist_result {
        thread.publish(
            "run_failed",
            json!({ "message": format!("persist failed after run: {error}") }),
        );
        return;
    }

    try_append_thread_audit(
        &state.store,
        &thread,
        audit_kind,
        Some(run_id),
        audit_payload,
    );
    let _ = persist_research_task_state(&state, &thread);
    let publish_payload = thread.snapshot();
    thread.publish(publish_kind, json!(publish_payload.clone()));
    if let Some(request) = follow_up {
        let _ = start_run(state, thread, request);
    }
}

struct RunOutcome {
    session: Session,
}

enum RunCompletion {
    Completed(RunOutcome),
    Interrupted(RunOutcome),
    Failed { error: String, outcome: RunOutcome },
    TimedOut { error: String, outcome: RunOutcome },
}

fn classify_run_completion(
    thread: &Arc<ManagedThread>,
    run_id: u64,
    joined: Result<Result<RunOutcome, RunFailure>, tokio::task::JoinError>,
) -> RunCompletion {
    match joined {
        Ok(Ok(outcome)) => RunCompletion::Completed(outcome),
        Ok(Err(failure)) => {
            let outcome = failure.outcome;
            if is_run_aborted(thread, run_id) {
                RunCompletion::Interrupted(outcome)
            } else {
                RunCompletion::Failed {
                    error: failure.error,
                    outcome,
                }
            }
        }
        Err(error) => RunCompletion::Failed {
            error: format!("run join failed: {error}"),
            outcome: current_run_outcome(thread),
        },
    }
}

fn current_run_outcome(thread: &Arc<ManagedThread>) -> RunOutcome {
    let session = thread
        .shared
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .session
        .clone();
    RunOutcome { session }
}

fn abort_run_if_active(thread: &Arc<ManagedThread>, run_id: u64) {
    let guard = thread
        .shared
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    if let Some(active) = &guard.current_run {
        if active.run_id == run_id {
            active.abort_signal.abort();
        }
    }
}

fn is_run_aborted(thread: &Arc<ManagedThread>, run_id: u64) -> bool {
    let guard = thread
        .shared
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    guard
        .current_run
        .as_ref()
        .map(|active| active.run_id == run_id && active.abort_signal.is_aborted())
        .unwrap_or(false)
}

fn build_single_expert_prompt(question: &str, expert: &ExpertPanelExpert) -> String {
    let description = expert
        .description
        .as_deref()
        .map(|value| format!("\nExpert description: {value}"))
        .unwrap_or_default();
    format!(
        "You are running as one independent expert skill for AI analyst.\n\
Expert: {}\n\
Skill: {}:{}{}\n\
User question:\n\
{}\n\n\
Instructions:\n\
- Load and follow this expert skill before answering.\n\
- Search connected sources when evidence is needed.\n\
- Return one expert opinion only, not the final synthesis.\n\
- Include a short confidence label and stance label in plain text.\n\
- Cite concrete source labels or query phrases when available.",
        expert.label,
        expert.scope.as_str(),
        expert.skill,
        description,
        question
    )
}

fn expert_sub_session_from_base(base: &Session, record: &ThreadRecord) -> Session {
    let mut session = Session::new().with_workspace_root(record.workspace_root.clone());
    session.messages = base.messages.clone();
    session.model = Some(record.model.clone());
    session
}

fn collect_new_assistant_text(session: &Session, start_index: usize) -> String {
    session
        .messages
        .iter()
        .skip(start_index)
        .filter(|message| message.role == MessageRole::Assistant)
        .flat_map(|message| message.blocks.iter())
        .filter_map(|block| match block {
            ContentBlock::Text { text } => Some(text.as_str()),
            _ => None,
        })
        .collect::<Vec<_>>()
        .join("\n\n")
        .trim()
        .to_string()
}

fn append_timeline_assistant_text(
    store: &ThreadStore,
    thread: &Arc<ManagedThread>,
    text: String,
) -> Result<Session, Box<dyn std::error::Error>> {
    {
        let mut guard = thread
            .shared
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        guard
            .session
            .push_message(ConversationMessage::assistant(vec![ContentBlock::Text {
                text,
            }]))?;
        guard.record.updated_at_ms = now_millis();
    }
    persist_thread_state(thread, store)?;
    let snapshot = thread.snapshot();
    thread.publish("message_added", json!(snapshot));
    Ok(thread
        .shared
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .session
        .clone())
}

fn format_expert_success_message(output: &ExpertExecutionOutput) -> String {
    let citations = if output.citations.is_empty() {
        "Citations: not provided".to_string()
    } else {
        format!("Citations: {}", output.citations.join("; "))
    };
    format!(
        "### {}\n\n{}\n\n{}\nConfidence: {}\nStance: {}",
        output.expert.label,
        output.content.trim(),
        citations,
        output.confidence.as_deref().unwrap_or("not marked"),
        output.stance.as_deref().unwrap_or("not marked")
    )
}

fn format_expert_failure_message(failure: &ExpertExecutionFailure) -> String {
    format!(
        "### {}\n\nThis expert failed after {} retry attempt(s).\n\nError: {}",
        failure.expert.label,
        failure.attempts.saturating_sub(1),
        failure.error
    )
}

fn format_expert_synthesis_prompt(
    question: &str,
    successes: &[ExpertExecutionOutput],
    failures: &[ExpertExecutionFailure],
) -> String {
    let success_text = successes
        .iter()
        .map(|output| {
            format!(
                "Expert: {}\nOpinion:\n{}",
                output.expert.label,
                output.content.trim()
            )
        })
        .collect::<Vec<_>>()
        .join("\n\n---\n\n");
    let failure_text = failures
        .iter()
        .map(|failure| format!("{}: {}", failure.expert.label, failure.error))
        .collect::<Vec<_>>()
        .join("\n");
    format!(
        "Create the final synthesis for this multi-expert analyst run.\n\
Question:\n{}\n\n\
Successful expert outputs:\n{}\n\n\
Failed experts:\n{}\n\n\
Write a concise final answer that integrates the successful experts, explicitly records failed experts, and gives next action suggestions.",
        question,
        if success_text.is_empty() { "None" } else { &success_text },
        if failure_text.is_empty() { "None" } else { &failure_text }
    )
}

fn format_fallback_expert_synthesis_message(
    successes: &[ExpertExecutionOutput],
    failures: &[ExpertExecutionFailure],
) -> String {
    let success_names = successes
        .iter()
        .map(|output| output.expert.label.as_str())
        .collect::<Vec<_>>()
        .join(", ");
    let failure_names = failures
        .iter()
        .map(|failure| failure.expert.label.as_str())
        .collect::<Vec<_>>()
        .join(", ");
    format!(
        "### Final synthesis\n\nIntegrated experts: {}.\n\nFailed experts: {}.\n\nContinue by asking for deeper evidence, a revised view, or a writing task.",
        if success_names.is_empty() { "none" } else { &success_names },
        if failure_names.is_empty() { "none" } else { &failure_names }
    )
}

fn expert_failure_from_error(
    expert: ExpertPanelExpert,
    attempts: u8,
    error: impl Into<String>,
) -> ExpertExecutionFailure {
    ExpertExecutionFailure {
        expert,
        attempts,
        error: error.into(),
    }
}

fn execute_single_expert_attempt(
    state: Arc<AppState>,
    thread: Arc<ManagedThread>,
    run_id: u64,
    input: ExpertExecutionInput,
    base_record: ThreadRecord,
    base_session: Session,
    abort_signal: HookAbortSignal,
    execution_context: Option<RunExecutionContext>,
    stream_to_thread: bool,
    expert_stream: Option<ExpertStreamContext>,
) -> Result<ExpertExecutionOutput, ExpertExecutionFailure> {
    let start_index = base_session.messages.len();
    let permission_mode = parse_permission_mode(&base_record.permission_mode)
        .map_err(|error| expert_failure_from_error(input.expert.clone(), input.attempt, error))?;
    let tool_registry = build_tool_registry()
        .map_err(|error| expert_failure_from_error(input.expert.clone(), input.attempt, error))?;
    let data_access =
        resolve_thread_data_access(&state.store, &base_record, execution_context.as_ref())
            .map_err(|error| {
                expert_failure_from_error(input.expert.clone(), input.attempt, error.to_string())
            })?;
    let es_access = resolve_es_access(&state.config.es, &data_access);
    let document_access = resolve_document_access(&data_access);
    let web_access = resolve_web_access(&data_access);
    let db_access = resolve_db_access(&data_access);
    let mut allowed_tools = allowed_tool_names(
        &state.config,
        &tool_registry,
        &base_record,
        &es_access,
        &document_access,
        &web_access,
        &db_access,
    );
    restrict_expert_file_tools_for_es(&mut allowed_tools, &es_access);
    let policy = permission_policy(permission_mode, &tool_registry, &allowed_tools)
        .map_err(|error| expert_failure_from_error(input.expert.clone(), input.attempt, error))?;
    let run_request = RunRequest {
        kind: RunKind::ExpertPanel,
        prompt: input.question.clone(),
        expert_panel: Some(ExpertPanelRequest {
            panel_id: input.run_id.clone(),
            master_skill: "expert-brainstorm".to_string(),
            experts: vec![input.expert.clone()],
        }),
        expert_run: Some(ExpertPanelRunExecution {
            run_id: input.run_id.clone(),
            retry_count: 0,
            concurrency_limit: 1,
        }),
        execution_context,
    };
    let system_prompt = build_system_prompt(
        &state.config,
        &base_record,
        &run_request,
        &es_access,
        &document_access,
        &web_access,
        &db_access,
        PromptSurface::Legacy,
    )
    .map_err(|error| {
        expert_failure_from_error(input.expert.clone(), input.attempt, error.to_string())
    })?;
    let api_client = ServiceApiClient::new(
        &base_record,
        state.store.clone(),
        tool_registry.clone(),
        allowed_tools.clone(),
        thread.clone(),
        run_id,
        abort_signal.clone(),
        expert_stream.or(Some(ExpertStreamContext {
            run_id: input.run_id.clone(),
            expert: input.expert.clone(),
            attempt: input.attempt,
        })),
        stream_to_thread,
        None,
    )
    .map_err(|error| expert_failure_from_error(input.expert.clone(), input.attempt, error))?;
    let tool_executor = ServiceToolExecutor::new(
        tool_registry,
        allowed_tools,
        PromptSurface::Legacy,
        base_record.workspace_root.clone(),
        es_access,
        document_access,
        web_access,
        db_access,
        state,
        thread,
        run_id,
        abort_signal.clone(),
        None,
    );
    let mut runtime = ConversationRuntime::new(
        expert_sub_session_from_base(&base_session, &base_record),
        api_client,
        tool_executor,
        policy,
        system_prompt,
    )
    .with_hook_abort_signal(abort_signal);

    let prompt = build_single_expert_prompt(&input.question, &input.expert);
    runtime.run_turn(prompt, None).map_err(|error| {
        expert_failure_from_error(input.expert.clone(), input.attempt, error.to_string())
    })?;
    let content = collect_new_assistant_text(runtime.session(), start_index);
    if content.is_empty() {
        return Err(expert_failure_from_error(
            input.expert,
            input.attempt,
            "expert produced an empty response",
        ));
    }

    Ok(ExpertExecutionOutput {
        expert: input.expert,
        attempts: input.attempt,
        content,
        citations: Vec::new(),
        confidence: None,
        stance: None,
    })
}

fn execute_expert_with_retries(
    state: Arc<AppState>,
    thread: Arc<ManagedThread>,
    run_id: u64,
    panel_run_id: String,
    question: String,
    expert: ExpertPanelExpert,
    retry_count: u8,
    base_record: ThreadRecord,
    base_session: Session,
    abort_signal: HookAbortSignal,
    execution_context: Option<RunExecutionContext>,
) -> Result<ExpertExecutionOutput, ExpertExecutionFailure> {
    let max_attempts = retry_count.saturating_add(1);
    let mut last_failure: Option<ExpertExecutionFailure> = None;

    for attempt in 1..=max_attempts {
        thread.publish(
            "expert_run_event",
            json!({
                "run_id": panel_run_id,
                "event": if attempt == 1 { "expert_started" } else { "expert_retrying" },
                "expert": expert.label,
                "attempt": attempt,
            }),
        );
        let result = execute_single_expert_attempt(
            state.clone(),
            thread.clone(),
            run_id,
            ExpertExecutionInput {
                run_id: panel_run_id.clone(),
                question: question.clone(),
                expert: expert.clone(),
                attempt,
            },
            base_record.clone(),
            base_session.clone(),
            abort_signal.clone(),
            execution_context.clone(),
            false,
            None,
        );
        match result {
            Ok(output) => return Ok(output),
            Err(failure) => last_failure = Some(failure),
        }
    }

    Err(last_failure.unwrap_or_else(|| {
        expert_failure_from_error(
            expert,
            max_attempts,
            "expert failed without an error payload",
        )
    }))
}

fn execute_experts_bounded(
    state: Arc<AppState>,
    thread: Arc<ManagedThread>,
    run_id: u64,
    panel_run_id: String,
    question: String,
    experts: Vec<ExpertPanelExpert>,
    retry_count: u8,
    concurrency_limit: u8,
    base_record: ThreadRecord,
    base_session: Session,
    abort_signal: HookAbortSignal,
    execution_context: Option<RunExecutionContext>,
) -> (Vec<ExpertExecutionOutput>, Vec<ExpertExecutionFailure>) {
    let (sender, receiver) = std::sync::mpsc::channel();
    let mut pending = std::collections::VecDeque::from(experts);
    let mut active = 0_usize;
    let mut successes = Vec::new();
    let mut failures = Vec::new();
    let limit = usize::from(concurrency_limit.max(1));

    while !pending.is_empty() || active > 0 {
        while active < limit {
            let Some(expert) = pending.pop_front() else {
                break;
            };
            active += 1;
            let sender = sender.clone();
            let state = state.clone();
            let thread = thread.clone();
            let panel_run_id = panel_run_id.clone();
            let question = question.clone();
            let base_record = base_record.clone();
            let base_session = base_session.clone();
            let abort_signal = abort_signal.clone();
            let execution_context = execution_context.clone();
            std::thread::spawn(move || {
                let result = execute_expert_with_retries(
                    state,
                    thread,
                    run_id,
                    panel_run_id,
                    question,
                    expert,
                    retry_count,
                    base_record,
                    base_session,
                    abort_signal,
                    execution_context,
                );
                let _ = sender.send(result);
            });
        }

        match receiver.recv() {
            Ok(Ok(output)) => successes.push(output),
            Ok(Err(failure)) => failures.push(failure),
            Err(_) => break,
        }
        active = active.saturating_sub(1);
    }

    (successes, failures)
}

fn synthesize_expert_outputs(
    state: Arc<AppState>,
    thread: Arc<ManagedThread>,
    run_id: u64,
    panel_run_id: String,
    question: String,
    successes: &[ExpertExecutionOutput],
    failures: &[ExpertExecutionFailure],
    base_record: ThreadRecord,
    base_session: Session,
    abort_signal: HookAbortSignal,
    execution_context: Option<RunExecutionContext>,
) -> Result<String, String> {
    let synthetic_expert = ExpertPanelExpert {
        skill: "expert-brainstorm".to_string(),
        scope: SkillScope::Workspace,
        label: "Final synthesis".to_string(),
        description: Some("Integrate successful expert outputs".to_string()),
    };
    let prompt = format_expert_synthesis_prompt(&question, successes, failures);
    let output = execute_single_expert_attempt(
        state,
        thread,
        run_id,
        ExpertExecutionInput {
            run_id: panel_run_id,
            question: prompt,
            expert: synthetic_expert,
            attempt: 1,
        },
        base_record,
        base_session,
        abort_signal,
        execution_context,
        true,
        None,
    )
    .map_err(|failure| failure.error)?;
    Ok(format!("### Final synthesis\n\n{}", output.content.trim()))
}

fn execute_expert_panel_run(
    thread: Arc<ManagedThread>,
    state: Arc<AppState>,
    run_id: u64,
) -> Result<RunOutcome, RunFailure> {
    let (record, session, request, abort_signal) = {
        let guard = thread
            .shared
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let active = guard.current_run.as_ref().ok_or_else(|| RunFailure {
            error: "expert panel run missing active state".to_string(),
            outcome: current_run_outcome(&thread),
        })?;
        if active.run_id != run_id {
            return Err(RunFailure {
                error: "stale expert panel run".to_string(),
                outcome: current_run_outcome(&thread),
            });
        }
        (
            guard.record.clone(),
            guard.session.clone(),
            active.request.clone(),
            active.abort_signal.clone(),
        )
    };
    let panel = request.expert_panel.clone().ok_or_else(|| RunFailure {
        error: "expert panel run missing expert panel request".to_string(),
        outcome: current_run_outcome(&thread),
    })?;
    let controls = request.expert_run.clone().ok_or_else(|| RunFailure {
        error: "expert panel run missing execution controls".to_string(),
        outcome: current_run_outcome(&thread),
    })?;

    let execution_context = resolve_run_execution_context(&state.store, &record, &request)
        .map_err(|error| RunFailure {
            error: error.message.clone(),
            outcome: current_run_outcome(&thread),
        })?;
    let effective_record = effective_record_for_run(&record, execution_context.as_ref());

    let mut panel_state = load_expert_run_response_or_log(&state, &thread, &controls.run_id)
        .unwrap_or_else(|| {
            expert_run_initial_response(
                &record.id,
                &controls.run_id,
                &ExpertPanelRunRequest {
                    question: Some(request.prompt.clone()),
                    source_message_id: None,
                    knowledge_base_id: execution_context
                        .as_ref()
                        .and_then(|context| context.knowledge_base_id.clone()),
                    data_source_ids: execution_context
                        .as_ref()
                        .and_then(|context| context.data_source_ids.clone()),
                    auto_retrieval: execution_context
                        .as_ref()
                        .and_then(|context| context.auto_retrieval),
                    experts: panel.experts.clone(),
                    retry_count: Some(controls.retry_count),
                    concurrency_limit: Some(controls.concurrency_limit),
                },
            )
        });
    panel_state.status = ExpertPanelRunStatus::Running;
    let _ = persist_expert_run_state(&state, &thread, &panel_state);

    let mut outcome_session = session.clone();
    outcome_session
        .push_user_text(request.prompt.clone())
        .map_err(|error| RunFailure {
            error: error.to_string(),
            outcome: current_run_outcome(&thread),
        })?;
    {
        let mut guard = thread
            .shared
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        guard.session = outcome_session.clone();
        guard.record.updated_at_ms = now_millis();
    }
    persist_thread_state(&thread, &state.store).map_err(|error| RunFailure {
        error: error.to_string(),
        outcome: current_run_outcome(&thread),
    })?;
    thread.publish("message_added", json!(thread.snapshot()));

    let (successes, failures) = execute_experts_bounded(
        state.clone(),
        thread.clone(),
        run_id,
        controls.run_id.clone(),
        request.prompt.clone(),
        panel.experts,
        controls.retry_count,
        controls.concurrency_limit,
        effective_record.clone(),
        outcome_session.clone(),
        abort_signal.clone(),
        execution_context.clone(),
    );

    let mut latest_session = outcome_session;
    for output in &successes {
        latest_session = append_timeline_assistant_text(
            &state.store,
            &thread,
            format_expert_success_message(output),
        )
        .map_err(|error| RunFailure {
            error: error.to_string(),
            outcome: current_run_outcome(&thread),
        })?;
        thread.publish(
            "expert_run_event",
            json!({
                "run_id": controls.run_id,
                "event": "expert_completed",
                "expert": output.expert.label,
                "attempt": output.attempts,
            }),
        );
    }
    for failure in &failures {
        latest_session = append_timeline_assistant_text(
            &state.store,
            &thread,
            format_expert_failure_message(failure),
        )
        .map_err(|error| RunFailure {
            error: error.to_string(),
            outcome: current_run_outcome(&thread),
        })?;
        thread.publish(
            "expert_run_event",
            json!({
                "run_id": controls.run_id,
                "event": "expert_failed",
                "expert": failure.expert.label,
                "attempt": failure.attempts,
                "error": failure.error,
            }),
        );
    }

    thread.publish(
        "expert_run_event",
        json!({
            "run_id": controls.run_id,
            "event": "synthesizing",
        }),
    );
    let synthesis = synthesize_expert_outputs(
        state.clone(),
        thread.clone(),
        run_id,
        controls.run_id.clone(),
        request.prompt.clone(),
        &successes,
        &failures,
        effective_record,
        latest_session.clone(),
        abort_signal,
        execution_context,
    )
    .unwrap_or_else(|_| format_fallback_expert_synthesis_message(&successes, &failures));
    latest_session =
        append_timeline_assistant_text(&state.store, &thread, synthesis).map_err(|error| {
            RunFailure {
                error: error.to_string(),
                outcome: current_run_outcome(&thread),
            }
        })?;

    if let Some(mut final_state) =
        load_expert_run_response_or_log(&state, &thread, &controls.run_id)
    {
        final_state.status = if successes.is_empty() && !failures.is_empty() {
            ExpertPanelRunStatus::Failed
        } else {
            ExpertPanelRunStatus::Succeeded
        };
        for expert_state in &mut final_state.experts {
            if let Some(output) = successes.iter().find(|output| {
                output.expert.skill == expert_state.skill
                    && output.expert.scope == expert_state.scope
            }) {
                expert_state.status = ExpertPanelExpertStatus::Succeeded;
                expert_state.attempts = output.attempts;
                expert_state.content = Some(output.content.clone());
            } else if let Some(failure) = failures.iter().find(|failure| {
                failure.expert.skill == expert_state.skill
                    && failure.expert.scope == expert_state.scope
            }) {
                expert_state.status = ExpertPanelExpertStatus::Failed;
                expert_state.attempts = failure.attempts;
                expert_state.error = Some(failure.error.clone());
            }
        }
        let _ = persist_expert_run_state(&state, &thread, &final_state);
    }
    thread.publish(
        "expert_run_event",
        json!({
            "run_id": controls.run_id,
            "event": "completed",
        }),
    );

    Ok(RunOutcome {
        session: latest_session,
    })
}

fn execute_run(
    thread: Arc<ManagedThread>,
    state: Arc<AppState>,
    run_id: u64,
) -> Result<RunOutcome, RunFailure> {
    execute_run_with_agent_sink(thread, state, run_id, None)
}

fn execute_run_with_agent_sink(
    thread: Arc<ManagedThread>,
    state: Arc<AppState>,
    run_id: u64,
    agent_event_sink: Option<AgentRunEventSink>,
) -> Result<RunOutcome, RunFailure> {
    let (record, session, request, abort_signal) = {
        let guard = thread
            .shared
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        let active = guard.current_run.as_ref().ok_or_else(|| RunFailure {
            error: "run missing active state".to_string(),
            outcome: current_run_outcome(&thread),
        })?;
        if active.run_id != run_id {
            return Err(RunFailure {
                error: "stale run".to_string(),
                outcome: current_run_outcome(&thread),
            });
        }
        (
            guard.record.clone(),
            guard.session.clone(),
            active.request.clone(),
            active.abort_signal.clone(),
        )
    };
    let execution_context = resolve_run_execution_context(&state.store, &record, &request)
        .map_err(|error| RunFailure {
            error: error.message.clone(),
            outcome: current_run_outcome(&thread),
        })?;
    let effective_record = effective_record_for_run(&record, execution_context.as_ref());

    let permission_mode =
        parse_permission_mode(&effective_record.permission_mode).map_err(|error| RunFailure {
            error: error.to_string(),
            outcome: current_run_outcome(&thread),
        })?;
    let tool_registry = build_tool_registry().map_err(|error| RunFailure {
        error: error.to_string(),
        outcome: current_run_outcome(&thread),
    })?;
    let data_access =
        resolve_thread_data_access(&state.store, &effective_record, execution_context.as_ref())
            .map_err(|error| RunFailure {
                error: error.to_string(),
                outcome: current_run_outcome(&thread),
            })?;
    let es_access = resolve_es_access(&state.config.es, &data_access);
    let document_access = resolve_document_access(&data_access);
    let web_access = resolve_web_access(&data_access);
    let db_access = resolve_db_access(&data_access);
    let allowed_tools = if agent_event_sink.is_some() {
        webagent_allowed_tool_names(
            es_access.base_url.is_some(),
            !document_access.files.is_empty(),
            !web_access.urls.is_empty(),
            db_access.url.is_some(),
        )
    } else {
        allowed_tool_names(
            &state.config,
            &tool_registry,
            &effective_record,
            &es_access,
            &document_access,
            &web_access,
            &db_access,
        )
    };
    let prompt_surface = if agent_event_sink.is_some() {
        PromptSurface::WebAgent
    } else {
        PromptSurface::Legacy
    };
    let policy =
        permission_policy(permission_mode, &tool_registry, &allowed_tools).map_err(|error| {
            RunFailure {
                error: error.to_string(),
                outcome: current_run_outcome(&thread),
            }
        })?;
    let system_prompt = build_system_prompt(
        &state.config,
        &effective_record,
        &request,
        &es_access,
        &document_access,
        &web_access,
        &db_access,
        prompt_surface,
    )
    .map_err(|error| RunFailure {
        error: error.to_string(),
        outcome: current_run_outcome(&thread),
    })?;
    let api_client = ServiceApiClient::new(
        &effective_record,
        state.store.clone(),
        tool_registry.clone(),
        allowed_tools.clone(),
        thread.clone(),
        run_id,
        abort_signal.clone(),
        None,
        true,
        agent_event_sink.clone(),
    )
    .map_err(|error| RunFailure {
        error,
        outcome: current_run_outcome(&thread),
    })?;
    let tool_executor = ServiceToolExecutor::new(
        tool_registry,
        allowed_tools,
        prompt_surface,
        record.workspace_root.clone(),
        es_access,
        document_access,
        web_access,
        db_access,
        state,
        thread.clone(),
        run_id,
        abort_signal.clone(),
        agent_event_sink,
    );
    let mut runtime =
        ConversationRuntime::new(session, api_client, tool_executor, policy, system_prompt)
            .with_hook_abort_signal(abort_signal.clone());

    match runtime.run_turn(&request.prompt, None) {
        Ok(_) => Ok(RunOutcome {
            session: runtime.session().clone(),
        }),
        Err(error) => Err(RunFailure {
            error: error.to_string(),
            outcome: RunOutcome {
                session: runtime.session().clone(),
            },
        }),
    }
}

struct RunFailure {
    error: String,
    outcome: RunOutcome,
}

#[derive(Clone)]
struct AgentRunEventSink {
    turn_id: String,
    message_id: String,
    sender: tokio::sync::mpsc::UnboundedSender<AgUiEvent>,
    store: Arc<ThreadStore>,
    record: Arc<Mutex<AgentTurnRecord>>,
}

impl AgentRunEventSink {
    fn send(&self, event: AgUiEvent) {
        let _ = self.sender.send(event);
    }

    fn append_text(&self, text: &str) {
        if text.is_empty() {
            return;
        }
        let mut record = self
            .record
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        record.assistant_text.push_str(text);
        record.status = AgentTurnStatus::Running;
        let _ = self.store.upsert_agent_turn(&record);
    }

    fn apply_tool_updates(&self, updates: AgentToolUpdates) {
        let mut record = self
            .record
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        record.steps.extend(updates.steps.clone());
        let citation_offset = record.citations.len() as u32;
        record
            .citations
            .extend(updates.citations.iter().cloned().map(|mut citation| {
                citation.number += citation_offset;
                citation
            }));
        record.expert_results.extend(updates.expert_results.clone());
        record.debug_events.push(updates.debug_event.clone());
        record.updated_status_running();
        let _ = self.store.upsert_agent_turn(&record);
    }

    fn finish(&self, status: AgentTurnStatus, error: Option<AgentTurnError>) -> AgentTurnRecord {
        let mut record = self
            .record
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        record.status = status;
        record.completed_at_ms = Some(now_millis());
        record.error = error;
        let _ = self.store.upsert_agent_turn(&record);
        record.clone()
    }
}

trait AgentTurnRecordRuntimeExt {
    fn updated_status_running(&mut self);
}

impl AgentTurnRecordRuntimeExt for AgentTurnRecord {
    fn updated_status_running(&mut self) {
        self.status = AgentTurnStatus::Running;
        self.completed_at_ms = None;
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum PromptSurface {
    Legacy,
    WebAgent,
}

fn build_system_prompt(
    config: &AppConfig,
    record: &ThreadRecord,
    request: &RunRequest,
    es_access: &ResolvedEsAccess,
    document_access: &ResolvedDocumentAccess,
    web_access: &ResolvedWebAccess,
    db_access: &ResolvedDbAccess,
    surface: PromptSurface,
) -> Result<Vec<String>, Box<dyn std::error::Error>> {
    let date = current_date_iso();
    let managed_root = config.managed_workspaces_dir();
    let is_managed_chat_workspace =
        record.project_id.is_none() && record.workspace_root.starts_with(&managed_root);
    let mut prompt = if is_managed_chat_workspace {
        runtime::SystemPromptBuilder::new()
            .with_os(std::env::consts::OS, "unknown")
            .with_project_context(runtime::ProjectContext {
                cwd: record.workspace_root.clone(),
                current_date: date.clone(),
                git_status: None,
                git_diff: None,
                git_context: None,
                instruction_files: Vec::new(),
            })
            .build()
    } else {
        runtime::load_system_prompt(
            &record.workspace_root,
            &date,
            std::env::consts::OS,
            "unknown",
            model_family_identity_for(&record.model),
        )?
    };
    let topic = record
        .topic
        .clone()
        .unwrap_or_else(|| "未显式设置主题，请从用户消息中推断".to_string());
    let memory_contract = match surface {
        PromptSurface::WebAgent => {
            "- Use MemorySearch before repeating prior analysis. Search user, tenant, or current session memory when conclusions should survive beyond the current conversation.\n\
- Use MemoryWrite to persist stable findings or scope boundaries. Use user memory for personal reusable conclusions, tenant memory for cross-user conclusions worth sharing, and current session memory for conversation-local notes."
        }
        PromptSurface::Legacy => {
            "- Use MemorySearch before repeating prior analysis. Search `scope: \"workspace\"`, `scope: \"tenant\"`, or `scope: \"all\"` when conclusions should survive beyond the current thread.\n\
- Use MemoryWrite to persist stable findings or scope boundaries. Use `scope: \"workspace\"` for conclusions shared by the same user in the same workspace, `scope: \"tenant\"` for conclusions worth sharing across the tenant, and `scope: \"thread\"` for thread-local notes."
        }
    };
    prompt.push(format!(
        "# Web Agent Contract\n\
Current topic: {topic}\n\
- Focus on the topic unless new evidence clearly requires scope adjustment.\n\
- Search before summarizing when evidence is incomplete.\n\
{memory_contract}\n\
- Use TopicDriftCheck when you suspect your reasoning is drifting away from the topic.\n\
- Use ArtifactEmit when the result should be rendered as markdown, table, chart, or graph.\n\
- During multi-expert workflows, use ExpertPanelEmit to register each expert view and final synthesis as structured panel progress.\n\
- Use Skill when a reusable project workflow or tenant workflow clearly matches the task.\n\
- Keep internal memory writes, drift checks, and hidden control steps out of the user-facing answer unless the user explicitly asks for them.\n\
- When you refer readers to a stored artifact in markdown, prefer links like `[结果标题](artifact:<artifact_id>)` when the artifact id is available from a prior tool result.\n\
- When citing search evidence, mention the concrete query phrase or source label so the UI can relate conclusions back to evidence cards.\n\
- Prefer grounded summaries over speculative prose.\n\
- If interrupted or replanned, reassess the task from the latest user intent."
    ));
    if let Some(instructions) = record.instructions.as_deref() {
        prompt.push(format!(
            "# Project Instructions\n\
Follow these project defaults unless the latest user request explicitly overrides them.\n\
{instructions}"
        ));
    }
    let preferred_skill_names = record
        .preferred_skill_names
        .iter()
        .filter(|name| {
            matches!(surface, PromptSurface::Legacy) || !name.trim().starts_with("workspace:")
        })
        .collect::<Vec<_>>();
    if !preferred_skill_names.is_empty() {
        let preferred_skill_policy = match surface {
            PromptSurface::WebAgent => {
                "When they match the task, load these platform or tenant skills before general analysis."
            }
            PromptSurface::Legacy => {
                "When they match the task, load these before falling back to generic exploration."
            }
        };
        prompt.push(format!(
            "# Preferred Skills\n\
{preferred_skill_policy}\n\
{}",
            preferred_skill_names
                .into_iter()
                .map(|name| format!("- {name}"))
                .collect::<Vec<_>>()
                .join("\n")
        ));
    }
    if let Some(expert_panel) = request.expert_panel.as_ref() {
        let expert_source_policy = match surface {
            PromptSurface::WebAgent => {
                "- When Elasticsearch sources are connected, each expert should call `EsSearch` before summarizing. Local code, prompt files, and local project inspection tools are unavailable in WebAgent runs."
            }
            PromptSurface::Legacy => {
                "- When Elasticsearch sources are connected, each expert should call `EsSearch` before using workspace file tools. Do not treat local code or prompt files as primary evidence for a research question."
            }
        };
        let experts = expert_panel
            .experts
            .iter()
            .enumerate()
            .map(|(index, expert)| {
                let description = expert
                    .description
                    .as_deref()
                    .map(|value| format!("：{value}"))
                    .unwrap_or_default();
                format!(
                    "{}. {}（{}:{}）{}",
                    index + 1,
                    expert.label,
                    expert.scope.as_str(),
                    expert.skill,
                    description
                )
            })
            .collect::<Vec<_>>()
            .join("\n");
        prompt.push(format!(
            "# Expert Panel Context\n\
This run is a structured multi-expert workflow.\n\
- Panel id: {}\n\
- Master skill: {}\n\
- Selected experts:\n\
{}\n\
- Treat the user's message as the shared议题与任务要求. Do not ask the user to restate the expert workflow.\n\
- Load the master skill first, then each selected expert skill.\n\
- Treat each expert as an analysis perspective, not a real quoted participant.\n\
- Each expert must independently retrieve evidence before summarizing.\n\
- Do not merge experts into one paragraph. Produce one visible expert opinion per selected expert before final synthesis.\n\
- For each selected expert, call `Skill` with that expert skill name, follow its retrieval guidance, then emit a dedicated expert result card.\n\
- If the current thread has connected sources, each expert should search those sources independently instead of reusing another expert's conclusion as evidence.\n\
{expert_source_policy}\n\
- The user should see expert opinions and the final synthesis, but should not see hidden orchestration text, internal prompts, or raw skill payloads.\n\
- Reuse the exact panel id in ExpertPanelEmit.panel_id and ArtifactEmit.metadata.panel.\n\
- Group artifacts with metadata.group = expert_view, expert_consensus, or expert_summary.\n\
- Keep all expert outputs under this panel id only.",
            expert_panel.panel_id,
            expert_panel.master_skill,
            experts
        ));
    }
    prompt.push(
        "# ArtifactEmit Output Shapes\n\
- table payload: {\"columns\":[{\"key\":\"name\",\"label\":\"Name\"}],\"rows\":[{\"name\":\"alpha\"}]}\n\
- chart payload: {\"type\":\"bar\"|\"line\"|\"area\"|\"pie\",\"title\":\"...\",\"data\":[...],\"xKey\":\"label\",\"series\":[{\"key\":\"value\",\"label\":\"Value\",\"color\":\"#195f59\"}]}\n\
- pie chart payload: {\"type\":\"pie\",\"title\":\"...\",\"data\":[...],\"labelKey\":\"label\",\"valueKey\":\"value\"}\n\
- graph payload: {\"title\":\"...\",\"nodes\":[{\"id\":\"n1\",\"label\":\"Topic\"}],\"edges\":[{\"source\":\"n1\",\"target\":\"n2\",\"label\":\"depends_on\"}]}\n\
- Optional metadata for grouped results: {\"group\":\"expert_summary\"|\"expert_consensus\"|\"expert_view\",\"expert_name\":\"米尔斯海默\",\"panel\":\"expert_brainstorm\",\"stage\":\"phase_1\"}\n\
- Prefer stable field names and machine-readable values over prose inside JSON."
            .to_string(),
    );
    if es_access.base_url.is_some()
        || !document_access.files.is_empty()
        || !web_access.urls.is_empty()
        || db_access.url.is_some()
    {
        let mut access_notes = Vec::new();
        if es_access.base_url.is_some() {
            let source_label = es_access
                .source_name
                .clone()
                .or_else(|| es_access.source_id.clone())
                .unwrap_or_else(|| "connected Elasticsearch source".to_string());
            let index_label = if !es_access.indices.is_empty() {
                es_access.indices.join(", ")
            } else {
                es_access
                    .default_index
                    .clone()
                    .unwrap_or_else(|| "未设置索引".to_string())
            };
            access_notes.push(format!(
                "- Connected Elasticsearch available via EsSearch: source = {source_label}; preferred index scope = {index_label}"
            ));
        }
        if !document_access.files.is_empty() {
            access_notes.push(format!(
                "- Uploaded documents available via SourceSearch / SourceRead: {}",
                document_access
                    .files
                    .iter()
                    .take(8)
                    .map(|item| item.file_name.clone())
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
        if !web_access.urls.is_empty() {
            access_notes.push(format!(
                "- Connected web sources available via SourceWebFetch: {}",
                web_access
                    .urls
                    .iter()
                    .take(5)
                    .cloned()
                    .collect::<Vec<_>>()
                    .join(", ")
            ));
        }
        if db_access.url.is_some() {
            access_notes.push(format!(
                "- Connected database available via DbQuery{}",
                db_access
                    .schema
                    .as_deref()
                    .map(|value| format!(" (preferred schema/database: {value})"))
                    .unwrap_or_default()
            ));
        }
        let source_policy = match surface {
            PromptSurface::WebAgent => {
                "- Use these connected platform sources as the evidence boundary for this WebAgent run. Local file-system exploration, shell commands, and local project inspection tools are unavailable."
            }
            PromptSurface::Legacy => {
                "- Prefer these connected sources before falling back to generic file-system exploration."
            }
        };
        prompt.push(format!(
            "# Connected Data Sources\n{}\n{}",
            access_notes.join("\n"),
            source_policy
        ));
    }
    if request
        .execution_context
        .as_ref()
        .and_then(|context| context.auto_retrieval)
        .unwrap_or(false)
        && es_access.base_url.is_some()
    {
        let index_label = if !es_access.indices.is_empty() {
            es_access.indices.join(", ")
        } else {
            es_access
                .default_index
                .clone()
                .unwrap_or_else(|| "未设置索引".to_string())
        };
        let retrieval_policy = match surface {
            PromptSurface::WebAgent => {
                "- Local file, shell, grep, glob, read, write, and edit tools are unavailable in WebAgent runs. If platform retrieval is empty, state the evidence gap and continue with bounded analysis instead of using local files."
            }
            PromptSurface::Legacy => {
                "- Do not use workspace file tools (`read_file`, `grep_search`, `glob_search`) as primary evidence unless Elasticsearch retrieval is empty or the user explicitly asked for code/workspace inspection."
            }
        };
        prompt.push(format!(
            "# Retrieval Priority\n\
- Auto retrieval is ON for this run.\n\
- Start with `EsSearch` against the connected Elasticsearch scope ({index_label}) before summarizing.\n\
- Use concrete query phrases derived from the user's question.\n\
{retrieval_policy}"
        ));
    }
    if matches!(request.kind, RunKind::Replan) {
        prompt.push(
            "# Replanning Mode\n\
You are handling a replanning request. Reassess the current topic, identify missing evidence, \
and propose a tighter path before continuing detailed synthesis."
                .to_string(),
        );
    }
    let available_skills = list_service_skills(
        config,
        Some(&record.workspace_root),
        record.tenant_id.as_deref(),
    )
    .map_err(|error| -> Box<dyn std::error::Error> {
        std::io::Error::new(std::io::ErrorKind::Other, error).into()
    })?;
    if !available_skills.is_empty() {
        let inventory = available_skills
            .into_iter()
            .filter(|entry| {
                matches!(surface, PromptSurface::Legacy) || entry.scope != SkillScope::Workspace
            })
            .map(|entry| {
                let description = entry
                    .description
                    .map(|description| format!(" - {description}"))
                    .unwrap_or_default();
                format!("- {}:{}{}", entry.scope.as_str(), entry.name, description)
            })
            .collect::<Vec<_>>()
            .join("\n");
        let skill_selection_policy = match surface {
            PromptSurface::WebAgent => {
                "Use platform or tenant skills when they match. Local project skills are unavailable in WebAgent runs."
            }
            PromptSurface::Legacy => {
                "When a workspace and tenant skill share the same name, prefer the workspace skill unless the tenant one is explicitly requested."
            }
        };
        prompt.push(format!(
            "# Available Skills\n\
Load one with `Skill` before following it when the workflow matches.\n\
{skill_selection_policy}\n\
{inventory}"
        ));
    }
    Ok(prompt)
}

struct ServiceApiClient {
    runtime: tokio::runtime::Runtime,
    provider: ProviderClient,
    model: String,
    store: Arc<ThreadStore>,
    tool_registry: GlobalToolRegistry,
    allowed_tools: BTreeSet<String>,
    thread: Arc<ManagedThread>,
    run_id: u64,
    abort_signal: HookAbortSignal,
    expert_stream: Option<ExpertStreamContext>,
    stream_to_thread: bool,
    agent_event_sink: Option<AgentRunEventSink>,
}

impl ServiceApiClient {
    fn new(
        record: &ThreadRecord,
        store: Arc<ThreadStore>,
        tool_registry: GlobalToolRegistry,
        allowed_tools: BTreeSet<String>,
        thread: Arc<ManagedThread>,
        run_id: u64,
        abort_signal: HookAbortSignal,
        expert_stream: Option<ExpertStreamContext>,
        stream_to_thread: bool,
        agent_event_sink: Option<AgentRunEventSink>,
    ) -> Result<Self, String> {
        let base_url = resolve_model_access_value(
            record.model_access.base_url.as_deref(),
            record.model_access.base_url_env.as_deref(),
        )?;
        let provider_kind = if base_url.is_none()
            && record.model_access.api_key.is_none()
            && record.model_access.api_key_env.is_none()
        {
            api::detect_provider_kind(&api::resolve_model_alias(&record.model))
        } else {
            provider_kind_for_model_access(&record.model, base_url.as_deref())
        };
        let request_model =
            request_model_for_model_access(&record.model, provider_kind, base_url.as_deref());
        let provider = provider_client_from_record(record)?;
        let runtime = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .map_err(|error| error.to_string())?;
        Ok(Self {
            runtime,
            provider,
            model: request_model,
            store,
            tool_registry,
            allowed_tools,
            thread,
            run_id,
            abort_signal,
            expert_stream,
            stream_to_thread,
            agent_event_sink,
        })
    }

    fn publish_stream_text(&self, text: &str) {
        if text.is_empty() {
            return;
        }

        if let Some(sink) = &self.agent_event_sink {
            sink.append_text(text);
            sink.send(AgUiEvent::TextMessageContent {
                message_id: sink.message_id.clone(),
                delta: text.to_string(),
                timestamp: now_millis(),
            });
        }

        if self.stream_to_thread {
            append_draft_text(&self.thread, text);
            self.thread
                .publish("assistant_text_delta", json!({ "text": text }));
            return;
        }

        if let Some(expert_stream) = &self.expert_stream {
            publish_expert_text_delta(
                &self.thread,
                &expert_stream.run_id,
                &expert_stream.expert,
                expert_stream.attempt,
                text,
            );
        }
    }

    async fn consume_stream(
        &self,
        message_request: &MessageRequest,
    ) -> Result<Vec<AssistantEvent>, RuntimeError> {
        let mut stream = self
            .provider
            .stream_message(message_request)
            .await
            .map_err(|error| RuntimeError::new(format!("provider stream failed: {error}")))?;
        let mut events = Vec::new();
        let mut pending_tool: Option<(String, String, String)> = None;
        let mut saw_stop = false;

        loop {
            if self.abort_signal.is_aborted() {
                return Err(RuntimeError::new("run interrupted by user"));
            }

            let Some(event) = stream
                .next_event()
                .await
                .map_err(|error| RuntimeError::new(format!("provider stream failed: {error}")))?
            else {
                break;
            };

            match event {
                ApiStreamEvent::MessageStart(start) => {
                    for block in start.message.content {
                        push_output_block(
                            &self.thread,
                            &mut events,
                            &mut pending_tool,
                            block,
                            true,
                            self.stream_to_thread,
                            self.expert_stream.as_ref(),
                            self.agent_event_sink.as_ref(),
                        );
                    }
                }
                ApiStreamEvent::ContentBlockStart(start) => {
                    push_output_block(
                        &self.thread,
                        &mut events,
                        &mut pending_tool,
                        start.content_block,
                        true,
                        self.stream_to_thread,
                        self.expert_stream.as_ref(),
                        self.agent_event_sink.as_ref(),
                    );
                }
                ApiStreamEvent::ContentBlockDelta(delta) => match delta.delta {
                    ContentBlockDelta::TextDelta { text } => {
                        self.publish_stream_text(&text);
                        if !text.is_empty() {
                            events.push(AssistantEvent::TextDelta(text));
                        }
                    }
                    ContentBlockDelta::InputJsonDelta { partial_json } => {
                        if let Some((_, _, input)) = &mut pending_tool {
                            input.push_str(&partial_json);
                        }
                    }
                    ContentBlockDelta::ThinkingDelta { .. } => {}
                    ContentBlockDelta::SignatureDelta { .. } => {}
                },
                ApiStreamEvent::ContentBlockStop(_) => {
                    if let Some((id, name, input)) = pending_tool.take() {
                        if let Some(sink) = &self.agent_event_sink {
                            sink.send(AgUiEvent::ToolCallEnd {
                                tool_call_id: id.clone(),
                                timestamp: now_millis(),
                            });
                            sink.send(AgUiEvent::ActivityDelta {
                                delta: json!({
                                    "kind": "tool",
                                    "status": "running",
                                    "toolCallId": id.clone(),
                                    "toolName": name.clone(),
                                    "label": "正在调用工具",
                                }),
                                timestamp: now_millis(),
                            });
                        }
                        self.thread.publish(
                            "tool_use",
                            json!({ "id": id, "name": name, "input": input }),
                        );
                        try_append_thread_audit(
                            &self.store,
                            &self.thread,
                            "tool_use",
                            Some(self.run_id),
                            json!({
                                "tool_use_id": id,
                                "tool_name": name,
                                "input": truncate_audit_text(&input),
                            }),
                        );
                        events.push(AssistantEvent::ToolUse { id, name, input });
                    }
                }
                ApiStreamEvent::MessageDelta(delta) => {
                    events.push(AssistantEvent::Usage(delta.usage.token_usage()));
                }
                ApiStreamEvent::MessageStop(_) => {
                    saw_stop = true;
                    events.push(AssistantEvent::MessageStop);
                }
            }
        }

        if saw_stop {
            return Ok(events);
        }

        let response = self
            .provider
            .send_message(&MessageRequest {
                stream: false,
                ..message_request.clone()
            })
            .await
            .map_err(|error| RuntimeError::new(format!("provider response failed: {error}")))?;
        response_to_events(
            &self.thread,
            self.store.as_ref(),
            self.run_id,
            response,
            self.stream_to_thread,
            self.expert_stream.as_ref(),
        )
    }
}

impl runtime::ApiClient for ServiceApiClient {
    fn stream(
        &mut self,
        request: runtime::ApiRequest,
    ) -> Result<Vec<AssistantEvent>, RuntimeError> {
        let message_request = MessageRequest {
            model: self.model.clone(),
            max_tokens: api::max_tokens_for_model(&self.model),
            messages: convert_messages(&request.messages),
            system: (!request.system_prompt.is_empty()).then(|| request.system_prompt.join("\n\n")),
            tools: Some(self.tool_registry.definitions(Some(&self.allowed_tools))),
            tool_choice: Some(ToolChoice::Auto),
            stream: true,
            reasoning_effort: None,
            ..Default::default()
        };
        self.runtime.block_on(self.consume_stream(&message_request))
    }
}

struct ServiceToolExecutor {
    tool_registry: GlobalToolRegistry,
    allowed_tools: BTreeSet<String>,
    surface: PromptSurface,
    workspace_root: PathBuf,
    es_access: ResolvedEsAccess,
    document_access: ResolvedDocumentAccess,
    web_access: ResolvedWebAccess,
    db_access: ResolvedDbAccess,
    state: Arc<AppState>,
    thread: Arc<ManagedThread>,
    run_id: u64,
    abort_signal: HookAbortSignal,
    agent_event_sink: Option<AgentRunEventSink>,
}

impl ServiceToolExecutor {
    fn new(
        tool_registry: GlobalToolRegistry,
        allowed_tools: BTreeSet<String>,
        surface: PromptSurface,
        workspace_root: PathBuf,
        es_access: ResolvedEsAccess,
        document_access: ResolvedDocumentAccess,
        web_access: ResolvedWebAccess,
        db_access: ResolvedDbAccess,
        state: Arc<AppState>,
        thread: Arc<ManagedThread>,
        run_id: u64,
        abort_signal: HookAbortSignal,
        agent_event_sink: Option<AgentRunEventSink>,
    ) -> Self {
        Self {
            tool_registry,
            allowed_tools,
            surface,
            workspace_root,
            es_access,
            document_access,
            web_access,
            db_access,
            state,
            thread,
            run_id,
            abort_signal,
            agent_event_sink,
        }
    }

    fn execute_runtime_tool(&mut self, tool_name: &str, value: Value) -> Result<String, ToolError> {
        match tool_name {
            "EsSearch" => execute_es_search(&self.es_access, value),
            "SourceSearch" => execute_source_search(&self.document_access, value),
            "SourceRead" => execute_source_read(&self.document_access, value),
            "SourceWebFetch" => execute_web_fetch(&self.web_access, value),
            "DbQuery" => execute_db_query(&self.db_access, value),
            "MemoryWrite" => execute_memory_write(&self.state, &self.thread, self.run_id, value),
            "MemorySearch" => execute_memory_search(&self.state, &self.thread, value),
            "TopicDriftCheck" => execute_topic_drift_check(&self.thread, value),
            "ArtifactEmit" => execute_artifact_emit(&self.state, &self.thread, self.run_id, value),
            "ExpertPanelEmit" => {
                execute_expert_panel_emit(&self.state, &self.thread, self.run_id, value)
            }
            _ => Err(ToolError::new(format!("unknown runtime tool: {tool_name}"))),
        }
    }
}

impl ToolExecutor for ServiceToolExecutor {
    fn execute(&mut self, tool_name: &str, input: &str) -> Result<String, ToolError> {
        if self.abort_signal.is_aborted() {
            return Err(ToolError::new("run interrupted by user"));
        }
        if !self.allowed_tools.contains(tool_name) {
            return Err(ToolError::new(format!(
                "tool `{tool_name}` is not enabled in clawd"
            )));
        }
        let value = serde_json::from_str::<Value>(input)
            .map_err(|error| ToolError::new(format!("invalid tool input JSON: {error}")))?;
        let value = rewrite_tool_input(tool_name, value, &self.workspace_root)?;
        let result = if tool_name == "Skill" {
            execute_service_skill(&self.state.config, &self.thread, self.surface, value)
        } else if self.tool_registry.has_runtime_tool(tool_name) {
            self.execute_runtime_tool(tool_name, value)
        } else {
            self.tool_registry
                .execute(tool_name, &value)
                .map_err(ToolError::new)
        };
        match &result {
            Ok(output) => {
                let output_with_artifact = if let Some(artifact) = maybe_emit_tool_result_artifact(
                    &self.state,
                    &self.thread,
                    self.run_id,
                    tool_name,
                    output,
                ) {
                    append_tool_result_artifact_reference(output, &artifact)
                } else {
                    output.clone()
                };
                self.thread.publish(
                    "tool_result",
                    json!({ "tool_name": tool_name, "output": output_with_artifact, "is_error": false }),
                );
                if let Some(sink) = &self.agent_event_sink {
                    let updates = map_tool_result_to_agent_updates(
                        &sink.turn_id,
                        tool_name,
                        input,
                        &output_with_artifact,
                        false,
                    );
                    sink.apply_tool_updates(updates.clone());
                    sink.send(AgUiEvent::ToolCallResult {
                        tool_call_id: sink.turn_id.clone(),
                        message: output_with_artifact.clone(),
                        timestamp: now_millis(),
                    });
                    sink.send(AgUiEvent::ActivityDelta {
                        delta: json!({
                            "kind": "tool",
                            "status": "succeeded",
                            "toolName": tool_name,
                            "label": updates
                                .steps
                                .first()
                                .map(|step| step.label.as_str())
                                .unwrap_or("工具执行完成"),
                            "steps": updates.steps,
                            "citations": updates.citations,
                            "expertResults": updates.expert_results,
                        }),
                        timestamp: now_millis(),
                    });
                    sink.send(AgUiEvent::StateSnapshot {
                        snapshot: json!({ "debugEvent": updates.debug_event }),
                        timestamp: now_millis(),
                    });
                }
                try_append_thread_audit(
                    &self.state.store,
                    &self.thread,
                    "tool_result",
                    Some(self.run_id),
                    json!({
                        "tool_name": tool_name,
                        "is_error": false,
                        "output": truncate_audit_text(&output_with_artifact),
                    }),
                );
            }
            Err(error) => {
                let error_text = error.to_string();
                self.thread.publish(
                    "tool_result",
                    json!({ "tool_name": tool_name, "output": error_text, "is_error": true }),
                );
                if let Some(sink) = &self.agent_event_sink {
                    let updates = map_tool_result_to_agent_updates(
                        &sink.turn_id,
                        tool_name,
                        input,
                        &error_text,
                        true,
                    );
                    sink.apply_tool_updates(updates.clone());
                    sink.send(AgUiEvent::ToolCallResult {
                        tool_call_id: sink.turn_id.clone(),
                        message: error_text.clone(),
                        timestamp: now_millis(),
                    });
                    sink.send(AgUiEvent::ActivityDelta {
                        delta: json!({
                            "kind": "tool",
                            "status": "failed",
                            "toolName": tool_name,
                            "label": updates
                                .steps
                                .first()
                                .map(|step| step.label.as_str())
                                .unwrap_or("工具执行失败"),
                            "steps": updates.steps,
                            "citations": updates.citations,
                            "expertResults": updates.expert_results,
                        }),
                        timestamp: now_millis(),
                    });
                    sink.send(AgUiEvent::StateSnapshot {
                        snapshot: json!({ "debugEvent": updates.debug_event }),
                        timestamp: now_millis(),
                    });
                }
                try_append_thread_audit(
                    &self.state.store,
                    &self.thread,
                    "tool_result",
                    Some(self.run_id),
                    json!({
                        "tool_name": tool_name,
                        "is_error": true,
                        "output": truncate_audit_text(&error_text),
                    }),
                );
            }
        }
        result
    }
}

#[derive(Debug, Deserialize)]
struct ServiceSkillInput {
    skill: String,
    args: Option<String>,
}

fn execute_service_skill(
    config: &AppConfig,
    thread: &Arc<ManagedThread>,
    surface: PromptSurface,
    value: Value,
) -> Result<String, ToolError> {
    let input: ServiceSkillInput = serde_json::from_value(value)
        .map_err(|error| ToolError::new(format!("invalid Skill input: {error}")))?;
    let (requested_scope, _) =
        parse_requested_skill(&input.skill).map_err(|error| ToolError::new(error.to_string()))?;
    if matches!(surface, PromptSurface::WebAgent)
        && matches!(requested_scope, Some(SkillScope::Workspace))
    {
        return Err(ToolError::new(
            "workspace-scoped skills are unavailable in WebAgent runs",
        ));
    }
    let record = thread
        .shared
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .record
        .clone();
    let workspace_root = match surface {
        PromptSurface::Legacy => Some(record.workspace_root.as_path()),
        PromptSurface::WebAgent => None,
    };
    let detail = resolve_service_skill(
        config,
        workspace_root,
        record.tenant_id.as_deref(),
        &input.skill,
    )
    .map_err(ToolError::new)?;
    serde_json::to_string_pretty(&ServiceSkillOutput {
        skill: input.skill,
        args: input.args,
        description: detail.entry.description,
        tags: detail.entry.tags,
        starter_prompt: detail.entry.starter_prompt,
        prompt: detail.prompt,
    })
    .map_err(|error| ToolError::new(error.to_string()))
}

#[derive(Clone, Debug, Deserialize)]
struct EsSearchInput {
    query: String,
    index: Option<String>,
    size: Option<usize>,
    fields: Option<Vec<String>>,
    source_fields: Option<Vec<String>>,
}

fn es_search_error(
    message: impl Into<String>,
    input: &EsSearchInput,
    index: Option<&str>,
    status: Option<reqwest::StatusCode>,
    detail: Option<Value>,
) -> ToolError {
    ToolError::new(
        json!({
            "kind": "es_search_error",
            "message": message.into(),
            "query": &input.query,
            "index": index,
            "fields": input.fields.clone(),
            "source_fields": input.source_fields.clone(),
            "status": status.map(|value| value.as_u16()),
            "detail": detail,
        })
        .to_string(),
    )
}

fn publish_expert_text_delta(
    thread: &Arc<ManagedThread>,
    run_id: &str,
    expert: &ExpertPanelExpert,
    attempt: u8,
    text: &str,
) {
    if text.is_empty() {
        return;
    }
    thread.publish(
        "expert_run_event",
        json!({
            "run_id": run_id,
            "event": "expert_text_delta",
            "expert": expert.label,
            "attempt": attempt,
            "delta": text,
        }),
    );
}

fn execute_es_search(es: &ResolvedEsAccess, value: Value) -> Result<String, ToolError> {
    let input: EsSearchInput = serde_json::from_value(value)
        .map_err(|error| ToolError::new(format!("invalid EsSearch input: {error}")))?;
    let query = input.query.clone();
    let fields = input
        .fields
        .clone()
        .unwrap_or_else(|| vec!["*".to_string()]);
    let source_fields = input.source_fields.clone();
    let base_url = es.base_url.as_deref().ok_or_else(|| {
        es_search_error("Elasticsearch is not configured", &input, None, None, None)
    })?;
    let index = input
        .index
        .clone()
        .or_else(|| {
            if es.indices.is_empty() {
                es.default_index.clone()
            } else {
                Some(es.indices.join(","))
            }
        })
        .ok_or_else(|| es_search_error("missing Elasticsearch index", &input, None, None, None))?;

    let url = format!("{}/{}/_search", base_url.trim_end_matches('/'), index);
    let mut body = json!({
        "size": input.size.unwrap_or(5),
        "query": {
            "simple_query_string": {
                "query": query,
                "fields": fields
            }
        }
    });
    if let Some(source_fields) = source_fields {
        body["_source"] = json!(source_fields);
    }

    let api_key = es.api_key.clone();
    let username = es.username.clone();
    let password = es.password.clone();
    let input_for_request = input.clone();
    let index_for_request = index.clone();
    let body_for_request = body.clone();
    let request_result = std::thread::spawn(move || {
        let client = reqwest::blocking::Client::new();
        let mut request = client.post(url).json(&body_for_request);
        if let Some(api_key) = &api_key {
            request = request.bearer_auth(api_key);
        } else if let (Some(username), Some(password)) = (&username, &password) {
            request = request.basic_auth(username, Some(password));
        }
        let response = request.send().map_err(|error| {
            es_search_error(
                format!("Elasticsearch request failed: {error}"),
                &input_for_request,
                Some(&index_for_request),
                None,
                None,
            )
        })?;
        let status = response.status();
        let payload: Value = response.json().map_err(|error| {
            es_search_error(
                format!("Elasticsearch response decode failed: {error}"),
                &input_for_request,
                Some(&index_for_request),
                Some(status),
                None,
            )
        })?;
        Ok::<_, ToolError>((status, payload))
    })
    .join()
    .map_err(|_| {
        es_search_error(
            "Elasticsearch worker thread panicked",
            &input,
            Some(&index),
            None,
            None,
        )
    })?;
    let (status, payload) = request_result?;
    if !status.is_success() {
        return Err(es_search_error(
            format!("Elasticsearch returned status {status}"),
            &input,
            Some(&index),
            Some(status),
            Some(payload),
        ));
    }

    let hits = payload
        .get("hits")
        .and_then(|value| value.get("hits"))
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default();
    let total = payload
        .get("hits")
        .and_then(|value| value.get("total"))
        .and_then(|value| value.get("value"))
        .and_then(Value::as_u64)
        .unwrap_or(hits.len() as u64);
    Ok(json!({
        "query": body["query"]["simple_query_string"]["query"],
        "index": index,
        "fields": body["query"]["simple_query_string"]["fields"],
        "source_fields": body["_source"],
        "data_source_id": es.source_id,
        "data_source_name": es.source_name,
        "total": total,
        "hits": hits,
    })
    .to_string())
}

#[derive(Debug, Deserialize)]
struct SourceSearchInput {
    query: String,
    limit: Option<usize>,
}

#[derive(Debug, Deserialize)]
struct SourceReadInput {
    file_id: Option<String>,
    file_name: Option<String>,
    max_chars: Option<usize>,
}

#[derive(Debug, Deserialize)]
struct WebFetchInput {
    url: String,
    max_chars: Option<usize>,
}

#[derive(Debug, Deserialize)]
struct DbQueryInput {
    sql: String,
    limit: Option<usize>,
}

fn execute_source_search(
    access: &ResolvedDocumentAccess,
    value: Value,
) -> Result<String, ToolError> {
    let input: SourceSearchInput = serde_json::from_value(value)
        .map_err(|error| ToolError::new(format!("invalid SourceSearch input: {error}")))?;
    if access.files.is_empty() {
        return Err(ToolError::new(
            json!({
                "kind": "source_search_error",
                "message": "No uploaded documents are connected to this conversation.",
                "query": input.query,
            })
            .to_string(),
        ));
    }

    let query = input.query.trim().to_lowercase();
    let limit = input.limit.unwrap_or(5).max(1);
    let mut scored = access
        .files
        .iter()
        .filter_map(|file| {
            let haystack = format!(
                "{}\n{}",
                file.file_name.to_lowercase(),
                file.extracted_text.to_lowercase()
            );
            let score = haystack.match_indices(&query).count();
            if score == 0 && !query.split_whitespace().all(|term| haystack.contains(term)) {
                return None;
            }
            let preview = extract_text_preview(&file.extracted_text, &input.query, 280);
            Some(json!({
                "_id": file.id,
                "_score": score.max(1),
                "_source": {
                    "title": file.file_name,
                    "file": file.file_name,
                    "path": file.relative_path,
                    "summary": preview,
                    "uploaded_at_ms": file.uploaded_at_ms,
                }
            }))
        })
        .collect::<Vec<_>>();
    scored.sort_by(|left, right| {
        let left_score = left.get("_score").and_then(Value::as_u64).unwrap_or(0);
        let right_score = right.get("_score").and_then(Value::as_u64).unwrap_or(0);
        right_score.cmp(&left_score)
    });
    let hits = scored.into_iter().take(limit).collect::<Vec<_>>();
    Ok(json!({
        "query": input.query,
        "index": access.source_name,
        "fields": ["file_name", "text"],
        "source_fields": ["title", "file", "path", "summary"],
        "data_source_id": access.source_id,
        "data_source_name": access.source_name,
        "total": hits.len(),
        "hits": hits,
    })
    .to_string())
}

fn execute_source_read(access: &ResolvedDocumentAccess, value: Value) -> Result<String, ToolError> {
    let input: SourceReadInput = serde_json::from_value(value)
        .map_err(|error| ToolError::new(format!("invalid SourceRead input: {error}")))?;
    let file = access.files.iter().find(|item| {
        input
            .file_id
            .as_deref()
            .map(|value| item.id == value)
            .unwrap_or(false)
            || input
                .file_name
                .as_deref()
                .map(|value| item.file_name.eq_ignore_ascii_case(value))
                .unwrap_or(false)
    });
    let Some(file) = file else {
        return Err(ToolError::new(
            json!({
                "kind": "source_read_error",
                "message": "Uploaded document not found.",
                "file_id": input.file_id,
                "file_name": input.file_name,
            })
            .to_string(),
        ));
    };
    let max_chars = input.max_chars.unwrap_or(8_000).clamp(200, 20_000);
    Ok(json!({
        "file_id": file.id,
        "file_name": file.file_name,
        "data_source_id": access.source_id,
        "data_source_name": access.source_name,
        "mime_type": file.mime_type,
        "size_bytes": file.size_bytes,
        "text": truncate_chars(&file.extracted_text, max_chars),
    })
    .to_string())
}

fn execute_web_fetch(access: &ResolvedWebAccess, value: Value) -> Result<String, ToolError> {
    let input: WebFetchInput = serde_json::from_value(value)
        .map_err(|error| ToolError::new(format!("invalid SourceWebFetch input: {error}")))?;
    if access.urls.is_empty() {
        return Err(ToolError::new(
            json!({
                "kind": "web_fetch_error",
                "message": "No web sources are connected to this conversation.",
                "url": input.url,
            })
            .to_string(),
        ));
    }
    let requested = input.url.trim();
    if !access.urls.iter().any(|value| value == requested) {
        return Err(ToolError::new(
            json!({
                "kind": "web_fetch_error",
                "message": "Requested URL is not in the connected web source list.",
                "url": requested,
                "allowed_urls": access.urls,
            })
            .to_string(),
        ));
    }

    let response = reqwest::blocking::Client::new()
        .get(requested)
        .send()
        .map_err(|error| {
            ToolError::new(
                json!({
                    "kind": "web_fetch_error",
                    "message": format!("Web fetch failed: {error}"),
                    "url": requested,
                })
                .to_string(),
            )
        })?;
    let status = response.status();
    let headers = response.headers().clone();
    let body = response.text().map_err(|error| {
        ToolError::new(
            json!({
                "kind": "web_fetch_error",
                "message": format!("Failed to read web response: {error}"),
                "url": requested,
                "status": status.as_u16(),
            })
            .to_string(),
        )
    })?;
    if !status.is_success() {
        return Err(ToolError::new(
            json!({
                "kind": "web_fetch_error",
                "message": format!("Web source returned status {status}"),
                "url": requested,
                "status": status.as_u16(),
            })
            .to_string(),
        ));
    }

    let content_type = headers
        .get(header::CONTENT_TYPE)
        .and_then(|value| value.to_str().ok())
        .unwrap_or("");
    let text = html_to_text_if_needed(content_type, &body);
    Ok(json!({
        "url": requested,
        "data_source_id": access.source_id,
        "data_source_name": access.source_name,
        "content_type": content_type,
        "text": truncate_chars(&text, input.max_chars.unwrap_or(12_000).clamp(500, 30_000)),
    })
    .to_string())
}

fn execute_db_query(access: &ResolvedDbAccess, value: Value) -> Result<String, ToolError> {
    let input: DbQueryInput = serde_json::from_value(value)
        .map_err(|error| ToolError::new(format!("invalid DbQuery input: {error}")))?;
    let sql = input.sql.trim();
    let lower = sql.to_ascii_lowercase();
    if !lower.starts_with("select") && !lower.starts_with("with") && !lower.starts_with("pragma") {
        return Err(ToolError::new(
            json!({
                "kind": "db_query_error",
                "message": "Only read-only SELECT / WITH / PRAGMA queries are allowed.",
                "sql": input.sql,
            })
            .to_string(),
        ));
    }
    if lower.contains("insert ")
        || lower.contains("update ")
        || lower.contains("delete ")
        || lower.contains("drop ")
        || lower.contains("alter ")
        || lower.contains("truncate ")
    {
        return Err(ToolError::new(
            json!({
                "kind": "db_query_error",
                "message": "Mutation statements are not allowed.",
                "sql": input.sql,
            })
            .to_string(),
        ));
    }

    let url = access.url.as_deref().ok_or_else(|| {
        ToolError::new(
            json!({
                "kind": "db_query_error",
                "message": "Database source is not configured.",
            })
            .to_string(),
        )
    })?;

    if url.starts_with("sqlite://") || url.starts_with("sqlite:") {
        return execute_sqlite_query(url, access, &input);
    }
    if url.starts_with("postgres://") || url.starts_with("postgresql://") {
        return execute_postgres_query(url, access, &input);
    }

    Err(ToolError::new(
        json!({
            "kind": "db_query_error",
            "message": "Unsupported database URL. Only sqlite and postgres are supported.",
            "url": url,
        })
        .to_string(),
    ))
}

#[derive(Debug, Deserialize)]
struct MemoryWriteInput {
    note: String,
    tags: Option<Vec<String>>,
    scope: Option<MemoryScope>,
}

fn execute_memory_write(
    state: &Arc<AppState>,
    thread: &Arc<ManagedThread>,
    run_id: u64,
    value: Value,
) -> Result<String, ToolError> {
    let input: MemoryWriteInput = serde_json::from_value(value)
        .map_err(|error| ToolError::new(format!("invalid MemoryWrite input: {error}")))?;
    let note = MemoryNote {
        id: generate_id("memory"),
        scope: input.scope.unwrap_or_default(),
        note: input.note,
        tags: input.tags.unwrap_or_default(),
        created_at_ms: now_millis(),
    };
    let record = {
        let mut guard = thread
            .shared
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        guard.record.memory_notes.push(note.clone());
        guard.record.updated_at_ms = now_millis();
        guard.record.clone()
    };
    state
        .store
        .upsert_record(&record)
        .map_err(|error| ToolError::new(format!("persist memory failed: {error}")))?;
    refresh_visible_memory_notes_for_workspace(state, &record)
        .map_err(|error| ToolError::new(format!("refresh memory views failed: {error}")))?;
    try_append_thread_audit(
        &state.store,
        thread,
        "memory_written",
        Some(run_id),
        json!({
            "memory_id": note.id.clone(),
            "scope": note.scope,
            "tags": note.tags.clone(),
            "note": truncate_audit_text(&note.note),
        }),
    );
    Ok(json!({
        "stored": true,
        "memory_id": note.id,
        "scope": note.scope,
        "tags": note.tags,
    })
    .to_string())
}

#[derive(Debug, Deserialize)]
struct MemorySearchInput {
    query: String,
    limit: Option<usize>,
    scope: Option<MemorySearchScope>,
}

fn execute_memory_search(
    state: &Arc<AppState>,
    thread: &Arc<ManagedThread>,
    value: Value,
) -> Result<String, ToolError> {
    let input: MemorySearchInput = serde_json::from_value(value)
        .map_err(|error| ToolError::new(format!("invalid MemorySearch input: {error}")))?;
    let scope = input.scope.unwrap_or_default();
    let query = input.query.to_ascii_lowercase();
    let limit = input.limit.unwrap_or(5).max(1);
    let record = thread
        .shared
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .record
        .clone();
    let matches = state
        .store
        .load_memory_notes_for_scope(&record, scope)
        .map_err(|error| ToolError::new(format!("memory search failed: {error}")))?
        .iter()
        .filter(|note| {
            note.note.to_ascii_lowercase().contains(&query)
                || note
                    .tags
                    .iter()
                    .any(|tag| tag.to_ascii_lowercase().contains(&query))
        })
        .take(limit)
        .cloned()
        .collect::<Vec<_>>();
    Ok(json!({
        "query": input.query,
        "scope": scope,
        "matches": matches,
    })
    .to_string())
}

fn refresh_visible_memory_notes_for_workspace(
    state: &Arc<AppState>,
    record: &ThreadRecord,
) -> Result<(), Box<dyn std::error::Error>> {
    let threads = state
        .threads
        .read()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .values()
        .cloned()
        .collect::<Vec<_>>();
    for thread in threads {
        let current_record = thread
            .shared
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .record
            .clone();
        if current_record.tenant_id != record.tenant_id
            || current_record.owner_id != record.owner_id
            || current_record.workspace_root != record.workspace_root
        {
            continue;
        }
        let notes = state.store.load_visible_memory_notes(&current_record)?;
        let snapshot = {
            let mut guard = thread
                .shared
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            guard.visible_memory_notes = notes;
            snapshot_from_state(&guard)
        };
        thread.publish("status_changed", json!(snapshot));
    }
    Ok(())
}

#[derive(Debug, Deserialize)]
struct TopicDriftCheckInput {
    candidate: String,
    topic: Option<String>,
}

fn execute_topic_drift_check(
    thread: &Arc<ManagedThread>,
    value: Value,
) -> Result<String, ToolError> {
    let input: TopicDriftCheckInput = serde_json::from_value(value)
        .map_err(|error| ToolError::new(format!("invalid TopicDriftCheck input: {error}")))?;
    let fallback_topic = thread
        .shared
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .record
        .topic
        .clone()
        .unwrap_or_default();
    let topic = input.topic.unwrap_or(fallback_topic);
    let topic_terms = normalize_terms(&topic);
    let candidate_terms = normalize_terms(&input.candidate);
    let overlap = topic_terms.intersection(&candidate_terms).count();
    let score = if topic_terms.is_empty() {
        1.0
    } else {
        overlap as f64 / topic_terms.len() as f64
    };
    let verdict = if score >= 0.5 {
        "aligned"
    } else if score >= 0.25 {
        "watch"
    } else {
        "off_topic"
    };
    let missing = topic_terms
        .difference(&candidate_terms)
        .cloned()
        .collect::<Vec<_>>();
    Ok(json!({
        "topic": topic,
        "score": score,
        "verdict": verdict,
        "missing_terms": missing,
    })
    .to_string())
}

#[derive(Debug, Deserialize)]
struct ArtifactEmitInput {
    kind: ArtifactKind,
    title: Option<String>,
    payload: Value,
    metadata: Option<Value>,
}

#[derive(Debug, Deserialize)]
struct ExpertPanelEmitInput {
    panel_id: String,
    expert_name: Option<String>,
    stage: Option<String>,
    summary: Option<String>,
    artifact_id: Option<String>,
    query_refs: Option<Vec<String>>,
    status: Option<String>,
}

#[derive(Debug, Clone)]
struct ActiveExpertPanel {
    panel_id: String,
    experts: Vec<ExpertPanelExpert>,
}

fn canonical_expert_panel_stage(value: Option<&str>) -> Option<String> {
    let normalized = value?.trim().to_ascii_lowercase();
    let stage = match normalized.as_str() {
        "" => return None,
        "phase_0" | "topic" | "topic_framing" => "phase_0",
        "phase_1" | "independent" | "independent_review" => "phase_1",
        "phase_2" | "debate" | "cross_debate" => "phase_2",
        "phase_3" | "consensus" | "consensus_map" => "phase_3",
        "phase_4" | "summary" | "final" => "phase_4",
        other => other,
    };
    Some(stage.to_string())
}

fn execute_artifact_emit(
    state: &Arc<AppState>,
    thread: &Arc<ManagedThread>,
    run_id: u64,
    value: Value,
) -> Result<String, ToolError> {
    let mut input: ArtifactEmitInput = serde_json::from_value(value)
        .map_err(|error| ToolError::new(format!("invalid ArtifactEmit input: {error}")))?;
    if let Some(panel) = active_expert_panel_for_run(thread, run_id) {
        input.metadata = normalize_artifact_metadata_for_expert_panel(input.metadata, &panel)?;
    }
    let artifact = store_thread_artifact(
        state,
        thread,
        Some(run_id),
        input.kind,
        input.title,
        input.payload,
        input.metadata,
    )?;
    Ok(json!({
        "stored": true,
        "artifact_id": artifact.id,
        "kind": artifact.kind,
        "metadata": artifact.metadata,
    })
    .to_string())
}

fn execute_expert_panel_emit(
    state: &Arc<AppState>,
    thread: &Arc<ManagedThread>,
    run_id: u64,
    value: Value,
) -> Result<String, ToolError> {
    let input: ExpertPanelEmitInput = serde_json::from_value(value)
        .map_err(|error| ToolError::new(format!("invalid ExpertPanelEmit input: {error}")))?;
    let panel_id = input.panel_id.trim();
    if panel_id.is_empty() {
        return Err(ToolError::new("expert panel id must not be empty"));
    }
    if let Some(panel) = active_expert_panel_for_run(thread, run_id) {
        if panel.panel_id != panel_id {
            return Err(ToolError::new(format!(
                "expert panel id mismatch: expected `{}`, got `{}`",
                panel.panel_id, panel_id
            )));
        }
        if let Some(expert_name) = input.expert_name.as_deref() {
            let known = panel
                .experts
                .iter()
                .any(|expert| expert.label == expert_name.trim());
            if !known {
                return Err(ToolError::new(format!(
                    "unknown expert name for current panel: `{expert_name}`"
                )));
            }
        }
    }
    let stage = canonical_expert_panel_stage(input.stage.as_deref());

    let payload = json!({
        "panel_id": panel_id,
        "expert_name": input.expert_name,
        "stage": stage,
        "summary": input.summary,
        "artifact_id": input.artifact_id,
        "query_refs": input.query_refs.unwrap_or_default(),
        "status": input.status.unwrap_or_else(|| "completed".to_string()),
    });
    append_thread_audit(
        &state.store,
        thread,
        "expert_panel_emit",
        Some(run_id),
        payload.clone(),
    )
    .map_err(|error| ToolError::new(format!("persist expert panel record failed: {error}")))?;
    let _ = persist_research_task_state(state, thread);
    Ok(json!({
        "stored": true,
        "panel_id": panel_id,
        "kind": "expert_panel_emit",
        "payload": payload,
    })
    .to_string())
}

fn active_expert_panel_for_run(
    thread: &Arc<ManagedThread>,
    run_id: u64,
) -> Option<ActiveExpertPanel> {
    let guard = thread
        .shared
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let active = guard.current_run.as_ref()?;
    if active.run_id != run_id {
        return None;
    }
    let panel = active.request.expert_panel.as_ref()?;
    Some(ActiveExpertPanel {
        panel_id: panel.panel_id.clone(),
        experts: panel.experts.clone(),
    })
}

fn normalize_artifact_metadata_for_expert_panel(
    metadata: Option<Value>,
    panel: &ActiveExpertPanel,
) -> Result<Option<Value>, ToolError> {
    let mut metadata = match metadata {
        Some(Value::Object(map)) => map,
        Some(_) => {
            return Err(ToolError::new(
                "ArtifactEmit metadata must be an object when expert panel mode is active",
            ))
        }
        None => serde_json::Map::new(),
    };

    let group = metadata
        .get("group")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| {
            ToolError::new("ArtifactEmit metadata.group is required during expert panel workflows")
        })?
        .to_string();
    if !matches!(
        group.as_str(),
        "expert_view" | "expert_consensus" | "expert_summary"
    ) {
        return Err(ToolError::new(format!(
            "ArtifactEmit metadata.group must be one of expert_view, expert_consensus, expert_summary during expert panel workflows; got `{group}`"
        )));
    }

    if group == "expert_view" {
        let expert_name = metadata
            .get("expert_name")
            .and_then(Value::as_str)
            .map(str::trim)
            .filter(|value| !value.is_empty())
            .ok_or_else(|| {
                ToolError::new(
                    "ArtifactEmit metadata.expert_name is required when metadata.group = expert_view",
                )
            })?;
        let known = panel
            .experts
            .iter()
            .any(|expert| expert.label == expert_name);
        if !known {
            return Err(ToolError::new(format!(
                "ArtifactEmit metadata.expert_name does not match the current expert panel: `{expert_name}`"
            )));
        }
    }

    if let Some(existing_panel) = metadata.get("panel").and_then(Value::as_str) {
        let existing_panel = existing_panel.trim();
        if !existing_panel.is_empty() && existing_panel != panel.panel_id {
            return Err(ToolError::new(format!(
                "ArtifactEmit metadata.panel mismatch: expected `{}`, got `{}`",
                panel.panel_id, existing_panel
            )));
        }
    }

    metadata.insert("panel".to_string(), Value::String(panel.panel_id.clone()));
    let canonical_stage =
        canonical_expert_panel_stage(metadata.get("stage").and_then(Value::as_str));
    if let Some(stage) = canonical_stage {
        metadata.insert("stage".to_string(), Value::String(stage));
    } else if matches!(group.as_str(), "expert_summary" | "expert_consensus") {
        let default_stage = if group == "expert_summary" {
            "phase_4"
        } else {
            "phase_3"
        };
        metadata.insert(
            "stage".to_string(),
            Value::String(default_stage.to_string()),
        );
    } else {
        metadata
            .entry("stage".to_string())
            .or_insert_with(|| Value::String("phase_1".to_string()));
    }
    Ok(Some(Value::Object(metadata)))
}

fn store_thread_artifact(
    state: &Arc<AppState>,
    thread: &Arc<ManagedThread>,
    run_id: Option<u64>,
    kind: ArtifactKind,
    title: Option<String>,
    payload: Value,
    metadata: Option<Value>,
) -> Result<ArtifactRecord, ToolError> {
    let artifact = ArtifactRecord {
        id: generate_id("artifact"),
        kind,
        title,
        payload,
        metadata,
        created_at_ms: now_millis(),
    };
    let snapshot = {
        let mut guard = thread
            .shared
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        guard.record.artifacts.push(artifact.clone());
        guard.record.updated_at_ms = now_millis();
        let record = guard.record.clone();
        state
            .store
            .upsert_record(&record)
            .map_err(|error| ToolError::new(format!("persist artifact failed: {error}")))?;
        snapshot_from_state(&guard)
    };
    try_append_thread_audit(
        &state.store,
        thread,
        "artifact_added",
        run_id,
        json!({
            "artifact_id": artifact.id.clone(),
            "kind": artifact.kind.clone(),
            "title": artifact.title.clone(),
            "metadata": artifact.metadata.clone(),
        }),
    );
    let _ = persist_research_task_state(state, thread);
    thread.publish("artifact_added", json!(artifact.clone()));
    thread.publish("status_changed", json!(snapshot));
    Ok(artifact)
}

fn maybe_emit_tool_result_artifact(
    state: &Arc<AppState>,
    thread: &Arc<ManagedThread>,
    run_id: u64,
    tool_name: &str,
    output: &str,
) -> Option<ArtifactRecord> {
    let parsed = match serde_json::from_str::<Value>(output) {
        Ok(parsed) => parsed,
        Err(_) => return None,
    };
    let Some(object) = parsed.as_object() else {
        return None;
    };

    match tool_name {
        "SourceWebFetch" => {
            let url = object
                .get("url")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty());
            let text = object
                .get("text")
                .and_then(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty());
            let Some(text) = text else {
                return None;
            };
            let title = url
                .map(web_fetch_artifact_title)
                .unwrap_or_else(|| "网页摘录".to_string());
            let markdown = if let Some(url) = url {
                format!("# {}\n\n来源：{}\n\n{}", title, url, text)
            } else {
                format!("# {}\n\n{}", title, text)
            };
            match store_thread_artifact(
                state,
                thread,
                Some(run_id),
                ArtifactKind::Markdown,
                Some(title),
                Value::String(markdown),
                None,
            ) {
                Ok(artifact) => Some(artifact),
                Err(error) => {
                    eprintln!("failed to persist SourceWebFetch artifact: {error}");
                    None
                }
            }
        }
        "DbQuery" => {
            let columns = object
                .get("columns")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            let rows = object
                .get("rows")
                .and_then(Value::as_array)
                .cloned()
                .unwrap_or_default();
            if columns.is_empty() && rows.is_empty() {
                return None;
            }
            let title = object
                .get("data_source_name")
                .and_then(Value::as_str)
                .map(|value| value.trim())
                .filter(|value| !value.is_empty())
                .map(|value| format!("数据库结果 · {}", value))
                .unwrap_or_else(|| "数据库结果".to_string());
            match store_thread_artifact(
                state,
                thread,
                Some(run_id),
                ArtifactKind::Table,
                Some(title),
                json!({
                    "columns": columns,
                    "rows": rows,
                }),
                None,
            ) {
                Ok(artifact) => Some(artifact),
                Err(error) => {
                    eprintln!("failed to persist DbQuery artifact: {error}");
                    None
                }
            }
        }
        _ => None,
    }
}

fn web_fetch_artifact_title(url: &str) -> String {
    let trimmed = url.trim();
    if trimmed.is_empty() {
        return "网页摘录".to_string();
    }
    if let Ok(parsed) = reqwest::Url::parse(trimmed) {
        if let Some(host) = parsed.host_str() {
            return format!("网页摘录 · {}", host);
        }
    }
    "网页摘录".to_string()
}

fn append_tool_result_artifact_reference(output: &str, artifact: &ArtifactRecord) -> String {
    let Ok(mut parsed) = serde_json::from_str::<Value>(output) else {
        return output.to_string();
    };
    let Some(object) = parsed.as_object_mut() else {
        return output.to_string();
    };
    object.insert(
        "artifact_id".to_string(),
        Value::String(artifact.id.clone()),
    );
    if let Some(title) = artifact.title.as_ref() {
        object.insert("artifact_title".to_string(), Value::String(title.clone()));
    }
    object.insert(
        "artifact_kind".to_string(),
        serde_json::to_value(&artifact.kind).unwrap_or(Value::String("text".to_string())),
    );
    parsed.to_string()
}

fn build_tool_registry() -> Result<GlobalToolRegistry, String> {
    GlobalToolRegistry::builtin().with_runtime_tools(vec![
        RuntimeToolDefinition {
            name: "EsSearch".to_string(),
            description: Some("Search an Elasticsearch index for relevant evidence.".to_string()),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string" },
                    "index": { "type": "string" },
                    "size": { "type": "integer", "minimum": 1 },
                    "fields": { "type": "array", "items": { "type": "string" } },
                    "source_fields": { "type": "array", "items": { "type": "string" } }
                },
                "required": ["query"],
                "additionalProperties": false
            }),
            required_permission: PermissionMode::ReadOnly,
        },
        RuntimeToolDefinition {
            name: "SourceSearch".to_string(),
            description: Some("Search uploaded documents for relevant evidence.".to_string()),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string" },
                    "limit": { "type": "integer", "minimum": 1 }
                },
                "required": ["query"],
                "additionalProperties": false
            }),
            required_permission: PermissionMode::ReadOnly,
        },
        RuntimeToolDefinition {
            name: "SourceRead".to_string(),
            description: Some("Read a connected uploaded document by file name or id.".to_string()),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "file_id": { "type": "string" },
                    "file_name": { "type": "string" },
                    "max_chars": { "type": "integer", "minimum": 1 }
                },
                "additionalProperties": false
            }),
            required_permission: PermissionMode::ReadOnly,
        },
        RuntimeToolDefinition {
            name: "SourceWebFetch".to_string(),
            description: Some("Fetch and summarize text from a connected web page.".to_string()),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "url": { "type": "string" },
                    "max_chars": { "type": "integer", "minimum": 1 }
                },
                "required": ["url"],
                "additionalProperties": false
            }),
            required_permission: PermissionMode::ReadOnly,
        },
        RuntimeToolDefinition {
            name: "DbQuery".to_string(),
            description: Some("Run a read-only SQL query against a connected database.".to_string()),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "sql": { "type": "string" },
                    "limit": { "type": "integer", "minimum": 1 }
                },
                "required": ["sql"],
                "additionalProperties": false
            }),
            required_permission: PermissionMode::ReadOnly,
        },
        RuntimeToolDefinition {
            name: "MemoryWrite".to_string(),
            description: Some(
                "Persist a stable finding or scope note into thread, workspace, or tenant memory."
                    .to_string(),
            ),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "note": { "type": "string" },
                    "tags": { "type": "array", "items": { "type": "string" } },
                    "scope": {
                        "type": "string",
                        "enum": ["thread", "workspace", "tenant"]
                    }
                },
                "required": ["note"],
                "additionalProperties": false
            }),
            required_permission: PermissionMode::ReadOnly,
        },
        RuntimeToolDefinition {
            name: "MemorySearch".to_string(),
            description: Some(
                "Search prior thread, workspace, or tenant memory before repeating analysis."
                    .to_string(),
            ),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "query": { "type": "string" },
                    "limit": { "type": "integer", "minimum": 1 },
                    "scope": {
                        "type": "string",
                        "enum": ["thread", "workspace", "tenant", "all"]
                    }
                },
                "required": ["query"],
                "additionalProperties": false
            }),
            required_permission: PermissionMode::ReadOnly,
        },
        RuntimeToolDefinition {
            name: "TopicDriftCheck".to_string(),
            description: Some("Score whether the current reasoning still matches the active topic.".to_string()),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "candidate": { "type": "string" },
                    "topic": { "type": "string" }
                },
                "required": ["candidate"],
                "additionalProperties": false
            }),
            required_permission: PermissionMode::ReadOnly,
        },
        RuntimeToolDefinition {
            name: "ArtifactEmit".to_string(),
            description: Some("Store a structured artifact for frontend rendering.".to_string()),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "kind": { "type": "string", "enum": ["text", "markdown", "table", "chart", "graph"] },
                    "title": { "type": "string" },
                    "payload": {},
                    "metadata": {
                        "type": "object",
                        "properties": {
                            "group": { "type": "string" },
                            "expert_name": { "type": "string" },
                            "panel": { "type": "string" },
                            "stage": { "type": "string" }
                        },
                        "additionalProperties": true
                    }
                },
                "required": ["kind", "payload"],
                "additionalProperties": false
            }),
            required_permission: PermissionMode::ReadOnly,
        },
        RuntimeToolDefinition {
            name: "ExpertPanelEmit".to_string(),
            description: Some("Record a structured expert-panel progress item for multi-expert analysis.".to_string()),
            input_schema: json!({
                "type": "object",
                "properties": {
                    "panel_id": { "type": "string" },
                    "expert_name": { "type": "string" },
                    "stage": { "type": "string" },
                    "summary": { "type": "string" },
                    "artifact_id": { "type": "string" },
                    "query_refs": { "type": "array", "items": { "type": "string" } },
                    "status": { "type": "string" }
                },
                "required": ["panel_id"],
                "additionalProperties": false
            }),
            required_permission: PermissionMode::ReadOnly,
        },
    ])
}

fn permission_policy(
    mode: PermissionMode,
    tool_registry: &GlobalToolRegistry,
    allowed_tools: &BTreeSet<String>,
) -> Result<PermissionPolicy, String> {
    Ok(tool_registry
        .permission_specs(Some(allowed_tools))?
        .into_iter()
        .fold(
            PermissionPolicy::new(mode),
            |policy, (name, required_permission)| {
                policy.with_tool_requirement(name, required_permission)
            },
        ))
}

fn allowed_tool_names(
    config: &AppConfig,
    tool_registry: &GlobalToolRegistry,
    record: &ThreadRecord,
    es_access: &ResolvedEsAccess,
    document_access: &ResolvedDocumentAccess,
    web_access: &ResolvedWebAccess,
    db_access: &ResolvedDbAccess,
) -> BTreeSet<String> {
    let has_explicit_project = record.project_id.is_some();
    let managed_root = config.managed_workspaces_dir();
    let has_explicit_workspace =
        has_explicit_project || !record.workspace_root.starts_with(&managed_root);
    let has_es_access = es_access.base_url.is_some()
        && (has_explicit_project || es_access.source_id.is_some() || !es_access.indices.is_empty());
    let has_document_access = !document_access.files.is_empty()
        && (has_explicit_project || document_access.source_id.is_some());
    let has_web_access =
        !web_access.urls.is_empty() && (has_explicit_project || web_access.source_id.is_some());
    let has_db_access =
        db_access.url.is_some() && (has_explicit_project || db_access.source_id.is_some());

    SAFE_BUILTIN_TOOLS
        .iter()
        .filter(|_| has_explicit_workspace)
        .map(|name| (*name).to_string())
        .chain(
            tool_registry
                .permission_specs(None)
                .into_iter()
                .flatten()
                .map(|(name, _)| name)
                .filter(|name| {
                    matches!(
                        name.as_str(),
                        "Skill"
                            | "MemoryWrite"
                            | "MemorySearch"
                            | "TopicDriftCheck"
                            | "ArtifactEmit"
                            | "ExpertPanelEmit"
                    ) || (name == "EsSearch" && has_es_access)
                        || (name == "SourceSearch" && has_document_access)
                        || (name == "SourceRead" && has_document_access)
                        || (name == "SourceWebFetch" && has_web_access)
                        || (name == "DbQuery" && has_db_access)
                }),
        )
        .collect()
}

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

fn restrict_expert_file_tools_for_es(
    allowed_tools: &mut BTreeSet<String>,
    es_access: &ResolvedEsAccess,
) {
    if es_access.base_url.is_none() {
        return;
    }
    for tool_name in SAFE_BUILTIN_TOOLS {
        allowed_tools.remove(*tool_name);
    }
}

fn rewrite_tool_input(
    tool_name: &str,
    mut value: Value,
    workspace_root: &Path,
) -> Result<Value, ToolError> {
    match tool_name {
        "read_file" | "write_file" | "edit_file" => {
            absolutize_object_path(&mut value, "path", workspace_root)?;
        }
        "glob_search" => {
            ensure_object_path(&mut value, "path", workspace_root)?;
        }
        "grep_search" => {
            ensure_object_path(&mut value, "path", workspace_root)?;
        }
        _ => {}
    }
    Ok(value)
}

fn ensure_object_path(
    value: &mut Value,
    key: &str,
    workspace_root: &Path,
) -> Result<(), ToolError> {
    let object = value
        .as_object_mut()
        .ok_or_else(|| ToolError::new("tool input must be a JSON object"))?;
    match object.get_mut(key) {
        Some(slot) if !slot.is_null() => absolutize_path_value(slot, workspace_root)?,
        _ => {
            object.insert(
                key.to_string(),
                Value::String(workspace_root.display().to_string()),
            );
        }
    }
    Ok(())
}

fn absolutize_object_path(
    value: &mut Value,
    key: &str,
    workspace_root: &Path,
) -> Result<(), ToolError> {
    let object = value
        .as_object_mut()
        .ok_or_else(|| ToolError::new("tool input must be a JSON object"))?;
    let slot = object
        .get_mut(key)
        .ok_or_else(|| ToolError::new(format!("tool input missing `{key}`")))?;
    absolutize_path_value(slot, workspace_root)
}

fn absolutize_path_value(value: &mut Value, workspace_root: &Path) -> Result<(), ToolError> {
    let path = value
        .as_str()
        .ok_or_else(|| ToolError::new("path field must be a string"))?;
    let path = PathBuf::from(path);
    let absolute = if path.is_absolute() {
        path
    } else {
        workspace_root.join(path)
    };
    *value = Value::String(absolute.display().to_string());
    Ok(())
}

fn convert_messages(messages: &[ConversationMessage]) -> Vec<InputMessage> {
    messages
        .iter()
        .filter_map(|message| {
            let role = match message.role {
                MessageRole::System | MessageRole::User | MessageRole::Tool => "user",
                MessageRole::Assistant => "assistant",
            };
            let content = message
                .blocks
                .iter()
                .filter_map(|block| match block {
                    ContentBlock::Text { text } => {
                        Some(InputContentBlock::Text { text: text.clone() })
                    }
                    ContentBlock::Thinking { .. } => None,
                    ContentBlock::ToolUse { id, name, input } => Some(InputContentBlock::ToolUse {
                        id: id.clone(),
                        name: name.clone(),
                        input: serde_json::from_str(input)
                            .unwrap_or_else(|_| json!({ "raw": input })),
                    }),
                    ContentBlock::ToolResult {
                        tool_use_id,
                        output,
                        is_error,
                        ..
                    } => Some(InputContentBlock::ToolResult {
                        tool_use_id: tool_use_id.clone(),
                        content: vec![ToolResultContentBlock::Text {
                            text: output.clone(),
                        }],
                        is_error: *is_error,
                    }),
                })
                .collect::<Vec<_>>();
            (!content.is_empty()).then(|| InputMessage {
                role: role.to_string(),
                content,
            })
        })
        .collect()
}

fn push_output_block(
    thread: &Arc<ManagedThread>,
    events: &mut Vec<AssistantEvent>,
    pending_tool: &mut Option<(String, String, String)>,
    block: OutputContentBlock,
    streaming_tool_input: bool,
    stream_to_thread: bool,
    expert_stream: Option<&ExpertStreamContext>,
    agent_event_sink: Option<&AgentRunEventSink>,
) {
    match block {
        OutputContentBlock::Text { text } => {
            if !text.is_empty() {
                if stream_to_thread {
                    append_draft_text(thread, &text);
                    thread.publish("assistant_text_delta", json!({ "text": text }));
                } else if let Some(expert_stream) = expert_stream {
                    publish_expert_text_delta(
                        thread,
                        &expert_stream.run_id,
                        &expert_stream.expert,
                        expert_stream.attempt,
                        &text,
                    );
                }
                events.push(AssistantEvent::TextDelta(text));
            }
        }
        OutputContentBlock::ToolUse { id, name, input } => {
            let initial_input = if streaming_tool_input
                && input.is_object()
                && input.as_object().is_some_and(serde_json::Map::is_empty)
            {
                String::new()
            } else {
                input.to_string()
            };
            if let Some(sink) = agent_event_sink {
                sink.send(AgUiEvent::ToolCallStart {
                    tool_call_id: id.clone(),
                    tool_call_name: name.clone(),
                    parent_message_id: Some(sink.message_id.clone()),
                    timestamp: now_millis(),
                });
                if !initial_input.is_empty() {
                    sink.send(AgUiEvent::ToolCallArgs {
                        tool_call_id: id.clone(),
                        delta: initial_input.clone(),
                        timestamp: now_millis(),
                    });
                }
            }
            *pending_tool = Some((id, name, initial_input));
        }
        OutputContentBlock::Thinking { .. } => {}
        OutputContentBlock::RedactedThinking { .. } => {}
    }
}

fn response_to_events(
    thread: &Arc<ManagedThread>,
    store: &ThreadStore,
    run_id: u64,
    response: MessageResponse,
    stream_to_thread: bool,
    expert_stream: Option<&ExpertStreamContext>,
) -> Result<Vec<AssistantEvent>, RuntimeError> {
    let mut events = Vec::new();
    let mut pending_tool = None;
    for block in response.content {
        push_output_block(
            thread,
            &mut events,
            &mut pending_tool,
            block,
            false,
            stream_to_thread,
            expert_stream,
            None,
        );
        if let Some((id, name, input)) = pending_tool.take() {
            thread.publish(
                "tool_use",
                json!({ "id": id, "name": name, "input": input }),
            );
            try_append_thread_audit(
                store,
                thread,
                "tool_use",
                Some(run_id),
                json!({
                    "tool_use_id": id,
                    "tool_name": name,
                    "input": truncate_audit_text(&input),
                }),
            );
            events.push(AssistantEvent::ToolUse { id, name, input });
        }
    }
    events.push(AssistantEvent::Usage(response.usage.token_usage()));
    events.push(AssistantEvent::MessageStop);
    Ok(events)
}

fn append_draft_text(thread: &Arc<ManagedThread>, text: &str) {
    let mut guard = thread
        .shared
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    guard.draft_assistant_text.push_str(text);
}

fn discover_allowed_roots(cwd: &Path) -> Vec<PathBuf> {
    let mut roots = Vec::new();
    if let Ok(canonical) = cwd.canonicalize() {
        roots.push(canonical.clone());

        if let Some(repo_root) = canonical
            .ancestors()
            .find(|candidate| candidate.join(".git").exists())
            .map(Path::to_path_buf)
        {
            if repo_root != canonical {
                roots.insert(0, repo_root);
            }
        }
    } else {
        roots.push(cwd.to_path_buf());
    }
    roots
}

fn canonicalize_workspace(root: &str, config: &AppConfig) -> Result<PathBuf, AppError> {
    let path = PathBuf::from(root);
    let canonical = path.canonicalize().map_err(|error| {
        AppError::new(
            StatusCode::BAD_REQUEST,
            format!("invalid workspace_root: {error}"),
        )
    })?;
    let managed_root = config
        .managed_workspaces_dir()
        .canonicalize()
        .unwrap_or_else(|_| config.managed_workspaces_dir());
    let allowed = config.allowed_roots.iter().any(|candidate| {
        candidate
            .canonicalize()
            .map(|base| canonical.starts_with(base))
            .unwrap_or(false)
    }) || canonical.starts_with(&managed_root);
    if !allowed {
        return Err(AppError::new(
            StatusCode::FORBIDDEN,
            "workspace_root is outside CLAWD_ALLOWED_ROOTS",
        ));
    }
    Ok(canonical)
}

fn snapshot_from_state(state: &ThreadState) -> ThreadSnapshot {
    ThreadSnapshot {
        id: state.record.id.clone(),
        workspace_root: state.record.workspace_root.display().to_string(),
        session_path: state.record.session_path.display().to_string(),
        project_id: state.record.project_id.clone(),
        project_name: state.record.project_name.clone(),
        knowledge_base_id: state.record.knowledge_base_id.clone(),
        knowledge_base_name: state.record.knowledge_base_name.clone(),
        model: state.record.model.clone(),
        permission_mode: state.record.permission_mode.clone(),
        topic: state.record.topic.clone(),
        status: state.status,
        last_error: state.last_error.clone(),
        draft_assistant_text: state.draft_assistant_text.clone(),
        created_at_ms: state.record.created_at_ms,
        updated_at_ms: state.record.updated_at_ms,
        messages: state
            .session
            .messages
            .iter()
            .enumerate()
            .map(|(index, message)| message_snapshot(&state.record.id, index, message))
            .collect(),
        memory_notes: state.visible_memory_notes.clone(),
        artifacts: state.record.artifacts.clone(),
        audit_records: state.audit_records.clone(),
    }
}

fn project_summary_from_record(record: ProjectRecord) -> ProjectSummary {
    let model_api_key_configured =
        record.model_access.api_key.is_some() || record.model_access.api_key_env.is_some();
    ProjectSummary {
        id: record.id,
        name: record.name,
        description: record.description,
        workspace_root: record.workspace_root.display().to_string(),
        default_topic: record.default_topic,
        default_model: record.default_model,
        model_base_url: record.model_access.base_url,
        model_base_url_env: record.model_access.base_url_env,
        model_api_key_env: record.model_access.api_key_env,
        model_api_key_configured,
        default_permission_mode: record.default_permission_mode,
        starter_prompt: record.starter_prompt,
        default_instructions: record.default_instructions,
        default_skill_names: record.default_skill_names,
        created_at_ms: record.created_at_ms,
        updated_at_ms: record.updated_at_ms,
    }
}

fn knowledge_base_summary_from_record(
    record: KnowledgeBaseRecord,
    data_source_count: usize,
) -> KnowledgeBaseSummary {
    KnowledgeBaseSummary {
        id: record.id,
        name: record.name,
        description: record.description,
        default_project_id: record.default_project_id,
        data_source_count,
        created_at_ms: record.created_at_ms,
        updated_at_ms: record.updated_at_ms,
    }
}

fn data_source_summary_from_record(record: DataSourceRecord) -> DataSourceSummary {
    let config = sanitize_data_source_config_for_client(record.kind, &record.config);
    let uploaded_files = if record.kind == DataSourceKind::Upload {
        object_array_config_value(&config, "files", parse_document_file_record)
            .into_iter()
            .map(|file| UploadedDocumentSummary {
                id: file.id,
                file_name: file.file_name,
                mime_type: file.mime_type,
                size_bytes: file.size_bytes,
                uploaded_at_ms: file.uploaded_at_ms,
            })
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    data_source_summary_core(record, &config, uploaded_files)
}

fn data_source_detail_from_record(record: DataSourceRecord) -> DataSourceDetail {
    let config = sanitize_data_source_config_for_client(record.kind, &record.config);
    let uploaded_files = if record.kind == DataSourceKind::Upload {
        object_array_config_value(&config, "files", parse_document_file_record)
            .into_iter()
            .map(|file| UploadedDocumentSummary {
                id: file.id,
                file_name: file.file_name,
                mime_type: file.mime_type,
                size_bytes: file.size_bytes,
                uploaded_at_ms: file.uploaded_at_ms,
            })
            .collect::<Vec<_>>()
    } else {
        Vec::new()
    };
    let summary = data_source_summary_core(record.clone(), &config, uploaded_files.clone());
    DataSourceDetail {
        id: summary.id,
        knowledge_base_id: summary.knowledge_base_id,
        name: summary.name,
        kind: summary.kind,
        description: summary.description,
        status: summary.status,
        config,
        endpoint: summary.endpoint,
        index_name: summary.index_name,
        auth_mode: summary.auth_mode,
        source_detail: summary.source_detail,
        uploaded_files: summary.uploaded_files,
        last_test: summary.last_test,
        last_synced_at_ms: summary.last_synced_at_ms,
        created_at_ms: summary.created_at_ms,
        updated_at_ms: summary.updated_at_ms,
    }
}

fn data_source_summary_core(
    record: DataSourceRecord,
    config: &Value,
    uploaded_files: Vec<UploadedDocumentSummary>,
) -> DataSourceSummary {
    let endpoint = match record.kind {
        DataSourceKind::Es | DataSourceKind::Db => string_config_value(config, "endpoint")
            .or_else(|| string_config_value(config, "base_url"))
            .or_else(|| string_config_value(config, "url")),
        _ => None,
    };
    let index_name = match record.kind {
        DataSourceKind::Es => string_config_value(config, "index")
            .or_else(|| string_config_value(config, "default_index")),
        _ => None,
    };
    let auth_mode = match record.kind {
        DataSourceKind::Es => {
            if string_config_value(&record.config, "api_key").is_some() {
                Some("api_key".to_string())
            } else if string_config_value(&record.config, "username").is_some()
                || string_config_value(&record.config, "password").is_some()
            {
                Some("basic".to_string())
            } else {
                Some("none".to_string())
            }
        }
        DataSourceKind::Db => {
            if string_config_value(&record.config, "username").is_some()
                || string_config_value(&record.config, "password").is_some()
            {
                Some("basic".to_string())
            } else {
                Some("none".to_string())
            }
        }
        _ => None,
    };
    let source_detail = match record.kind {
        DataSourceKind::Upload => {
            let count = config
                .get("files")
                .and_then(Value::as_array)
                .map(|items| items.len())
                .unwrap_or(0);
            Some(format!("{} 份文档", count))
        }
        DataSourceKind::Web => {
            let count = config
                .get("urls")
                .and_then(Value::as_array)
                .map(|items| items.len())
                .unwrap_or(0);
            Some(format!("{} 个网页入口", count))
        }
        DataSourceKind::Db => string_config_value(config, "database")
            .or_else(|| string_config_value(config, "schema"))
            .or_else(|| string_config_value(config, "url")),
        DataSourceKind::LocalDir => {
            string_config_value(config, "path").map(|path| present_path_tail(&path))
        }
        _ => None,
    };
    DataSourceSummary {
        id: record.id,
        knowledge_base_id: record.knowledge_base_id,
        name: record.name,
        kind: record.kind,
        description: record.description,
        status: record.status,
        endpoint,
        index_name,
        auth_mode,
        source_detail,
        uploaded_files,
        last_test: record.last_test,
        last_synced_at_ms: record.last_synced_at_ms,
        created_at_ms: record.created_at_ms,
        updated_at_ms: record.updated_at_ms,
    }
}

fn sanitize_data_source_config_for_client(kind: DataSourceKind, config: &Value) -> Value {
    let mut sanitized = config.clone();
    if let Some(object) = sanitized.as_object_mut() {
        if matches!(kind, DataSourceKind::Es | DataSourceKind::Db) {
            object.remove("api_key");
            object.remove("password");
            object.remove("username");
        }
    }
    sanitized
}

fn build_data_source_test_result(
    kind: DataSourceKind,
    config: &Value,
) -> Result<DataSourceTestResult, AppError> {
    match kind {
        DataSourceKind::Es => test_es_data_source(config),
        DataSourceKind::Db => test_db_data_source(config),
        DataSourceKind::Web => test_web_data_source(config),
        DataSourceKind::Upload => Ok(DataSourceTestResult {
            kind,
            status: "ready".to_string(),
            summary: "上传文档数据源无需预连接测试，可直接上传文件。".to_string(),
            checked_at_ms: now_millis(),
            details: vec![DataSourceTestDetail {
                label: "接入方式".to_string(),
                value: "创建后直接上传文档".to_string(),
            }],
        }),
        DataSourceKind::LocalDir => {
            let path = string_config_value(config, "path").unwrap_or_default();
            Ok(DataSourceTestResult {
                kind,
                status: "ready".to_string(),
                summary: format!("本地目录已校验：{}", present_path_tail(&path)),
                checked_at_ms: now_millis(),
                details: vec![DataSourceTestDetail {
                    label: "目录".to_string(),
                    value: present_path_tail(&path),
                }],
            })
        }
        _ => Ok(DataSourceTestResult {
            kind,
            status: "unsupported".to_string(),
            summary: "当前数据源类型暂不提供独立连接测试。".to_string(),
            checked_at_ms: now_millis(),
            details: Vec::new(),
        }),
    }
}

fn test_es_data_source(config: &Value) -> Result<DataSourceTestResult, AppError> {
    let access = ResolvedEsAccess {
        base_url: string_config_value(config, "endpoint")
            .or_else(|| string_config_value(config, "base_url")),
        api_key: string_config_value(config, "api_key"),
        username: string_config_value(config, "username"),
        password: string_config_value(config, "password"),
        default_index: string_config_value(config, "index")
            .or_else(|| string_config_value(config, "default_index")),
        indices: string_config_value(config, "index")
            .or_else(|| string_config_value(config, "default_index"))
            .into_iter()
            .collect::<Vec<_>>(),
        source_id: None,
        source_name: None,
    };
    let output = execute_es_search(
        &access,
        json!({
            "query": "*",
            "size": 1
        }),
    )
    .map_err(|error| AppError::new(StatusCode::BAD_REQUEST, error.to_string()))?;
    let parsed: Value = serde_json::from_str(&output).map_err(|error| {
        AppError::new(
            StatusCode::BAD_REQUEST,
            format!("es test decode failed: {error}"),
        )
    })?;
    let total = parsed.get("total").and_then(Value::as_u64).unwrap_or(0);
    let endpoint = access.base_url.unwrap_or_else(|| "未设置".to_string());
    let index = access.default_index.unwrap_or_else(|| "未设置".to_string());
    let auth_mode = if access.api_key.is_some() {
        "API Key"
    } else if access.username.is_some() || access.password.is_some() {
        "用户名 / 密码"
    } else {
        "无认证"
    };
    Ok(DataSourceTestResult {
        kind: DataSourceKind::Es,
        status: "ready".to_string(),
        summary: format!(
            "Elasticsearch 连接可用，索引可访问，当前测试命中 {} 条。",
            total
        ),
        checked_at_ms: now_millis(),
        details: vec![
            DataSourceTestDetail {
                label: "地址".to_string(),
                value: endpoint,
            },
            DataSourceTestDetail {
                label: "索引".to_string(),
                value: index,
            },
            DataSourceTestDetail {
                label: "认证方式".to_string(),
                value: auth_mode.to_string(),
            },
            DataSourceTestDetail {
                label: "测试命中".to_string(),
                value: total.to_string(),
            },
        ],
    })
}

fn test_db_data_source(config: &Value) -> Result<DataSourceTestResult, AppError> {
    let access = ResolvedDbAccess {
        source_id: None,
        source_name: None,
        url: string_config_value(config, "url")
            .or_else(|| string_config_value(config, "endpoint"))
            .or_else(|| string_config_value(config, "base_url")),
        schema: string_config_value(config, "schema")
            .or_else(|| string_config_value(config, "database")),
    };
    let output = execute_db_query(
        &access,
        json!({
            "sql": "select 1 as ok",
            "limit": 1
        }),
    )
    .map_err(|error| AppError::new(StatusCode::BAD_REQUEST, error.to_string()))?;
    let parsed: Value = serde_json::from_str(&output).map_err(|error| {
        AppError::new(
            StatusCode::BAD_REQUEST,
            format!("db test decode failed: {error}"),
        )
    })?;
    let row_count = parsed.get("row_count").and_then(Value::as_u64).unwrap_or(0);
    let url = access.url.unwrap_or_else(|| "未设置".to_string());
    let engine = if url.starts_with("postgres://") || url.starts_with("postgresql://") {
        "PostgreSQL"
    } else if url.starts_with("sqlite://") || url.starts_with("sqlite:") {
        "SQLite"
    } else {
        "未知"
    };
    let schema = access.schema.unwrap_or_else(|| "未指定".to_string());
    Ok(DataSourceTestResult {
        kind: DataSourceKind::Db,
        status: "ready".to_string(),
        summary: format!(
            "数据库连接可用，只读查询已通过，测试返回 {} 行。",
            row_count
        ),
        checked_at_ms: now_millis(),
        details: vec![
            DataSourceTestDetail {
                label: "引擎".to_string(),
                value: engine.to_string(),
            },
            DataSourceTestDetail {
                label: "连接".to_string(),
                value: redact_connection_string(&url),
            },
            DataSourceTestDetail {
                label: "Schema".to_string(),
                value: schema,
            },
            DataSourceTestDetail {
                label: "测试返回".to_string(),
                value: format!("{} 行", row_count),
            },
        ],
    })
}

fn test_web_data_source(config: &Value) -> Result<DataSourceTestResult, AppError> {
    let urls = string_array_config_value(config, "urls");
    let first = urls.first().cloned().ok_or_else(|| {
        AppError::new(
            StatusCode::BAD_REQUEST,
            "web data source requires at least one url",
        )
    })?;
    let configured_url_count = urls.len();
    let access = ResolvedWebAccess {
        source_id: None,
        source_name: None,
        urls,
    };
    let output = execute_web_fetch(
        &access,
        json!({
            "url": first,
            "max_chars": 200
        }),
    )
    .map_err(|error| AppError::new(StatusCode::BAD_REQUEST, error.to_string()))?;
    let parsed: Value = serde_json::from_str(&output).map_err(|error| {
        AppError::new(
            StatusCode::BAD_REQUEST,
            format!("web test decode failed: {error}"),
        )
    })?;
    let url = parsed.get("url").and_then(Value::as_str).unwrap_or("网页");
    let content_type = parsed
        .get("content_type")
        .and_then(Value::as_str)
        .filter(|value| !value.trim().is_empty())
        .unwrap_or("未知");
    let chars = parsed
        .get("text")
        .and_then(Value::as_str)
        .map(|value| value.chars().count())
        .unwrap_or(0);
    Ok(DataSourceTestResult {
        kind: DataSourceKind::Web,
        status: "ready".to_string(),
        summary: format!("网页来源可访问，已成功读取 {}。", url),
        checked_at_ms: now_millis(),
        details: vec![
            DataSourceTestDetail {
                label: "测试地址".to_string(),
                value: url.to_string(),
            },
            DataSourceTestDetail {
                label: "内容类型".to_string(),
                value: content_type.to_string(),
            },
            DataSourceTestDetail {
                label: "读取字符".to_string(),
                value: chars.to_string(),
            },
            DataSourceTestDetail {
                label: "已配置入口".to_string(),
                value: configured_url_count.to_string(),
            },
        ],
    })
}

fn truncate_chars(value: &str, max_chars: usize) -> String {
    value.chars().take(max_chars).collect::<String>()
}

fn extract_text_preview(text: &str, query: &str, max_chars: usize) -> String {
    let normalized_text = text.trim();
    if normalized_text.is_empty() {
        return "文档中暂未提取到可读文本。".to_string();
    }
    let query_lower = query.to_lowercase();
    let text_lower = normalized_text.to_lowercase();
    if let Some(position) = text_lower.find(&query_lower) {
        let start = normalized_text[..position]
            .chars()
            .count()
            .saturating_sub(max_chars / 3);
        let snippet = normalized_text
            .chars()
            .skip(start)
            .take(max_chars)
            .collect::<String>();
        return snippet;
    }
    truncate_chars(normalized_text, max_chars)
}

fn html_to_text_if_needed(content_type: &str, body: &str) -> String {
    if content_type.to_ascii_lowercase().contains("html") {
        let mut text = String::with_capacity(body.len());
        let mut inside_tag = false;
        for ch in body.chars() {
            match ch {
                '<' => inside_tag = true,
                '>' => {
                    inside_tag = false;
                    text.push(' ');
                }
                _ if !inside_tag => text.push(ch),
                _ => {}
            }
        }
        return text.split_whitespace().collect::<Vec<_>>().join(" ");
    }
    body.to_string()
}

fn sqlite_path_from_url_for_data_source(value: &str) -> Result<PathBuf, ToolError> {
    sqlite_path_from_url(value).map_err(|error| ToolError::new(error.to_string()))
}

fn execute_sqlite_query(
    url: &str,
    access: &ResolvedDbAccess,
    input: &DbQueryInput,
) -> Result<String, ToolError> {
    let path = sqlite_path_from_url_for_data_source(url)?;
    let connection = SqliteConnection::open(path)
        .map_err(|error| ToolError::new(format!("failed to open sqlite database: {error}")))?;
    let mut statement = connection
        .prepare(input.sql.trim())
        .map_err(|error| ToolError::new(format!("failed to prepare sqlite query: {error}")))?;
    let columns = statement
        .column_names()
        .into_iter()
        .map(ToString::to_string)
        .collect::<Vec<_>>();
    let limit = input.limit.unwrap_or(50).clamp(1, 200);
    let mut rows = statement
        .query([])
        .map_err(|error| ToolError::new(format!("sqlite query failed: {error}")))?;
    let mut items = Vec::new();
    while let Some(row) = rows
        .next()
        .map_err(|error| ToolError::new(format!("sqlite query iteration failed: {error}")))?
    {
        let mut item = serde_json::Map::new();
        for (index, column) in columns.iter().enumerate() {
            let value = sqlite_value_to_json(row, index)?;
            item.insert(column.clone(), value);
        }
        items.push(Value::Object(item));
        if items.len() >= limit {
            break;
        }
    }
    Ok(json!({
        "data_source_id": access.source_id,
        "data_source_name": access.source_name,
        "query": input.sql,
        "columns": columns,
        "rows": items,
        "row_count": items.len(),
    })
    .to_string())
}

fn sqlite_value_to_json(row: &rusqlite::Row<'_>, index: usize) -> Result<Value, ToolError> {
    let value = row
        .get_ref(index)
        .map_err(|error| ToolError::new(format!("sqlite cell read failed: {error}")))?;
    let json = match value {
        rusqlite::types::ValueRef::Null => Value::Null,
        rusqlite::types::ValueRef::Integer(value) => json!(value),
        rusqlite::types::ValueRef::Real(value) => json!(value),
        rusqlite::types::ValueRef::Text(bytes) => {
            Value::String(String::from_utf8_lossy(bytes).to_string())
        }
        rusqlite::types::ValueRef::Blob(bytes) => Value::String(format!(
            "base64:{}",
            base64::engine::general_purpose::STANDARD.encode(bytes)
        )),
    };
    Ok(json)
}

fn execute_postgres_query(
    url: &str,
    access: &ResolvedDbAccess,
    input: &DbQueryInput,
) -> Result<String, ToolError> {
    let runtime = tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .map_err(|error| ToolError::new(format!("failed to build runtime: {error}")))?;
    let query = input.sql.trim().to_string();
    let limit = input.limit.unwrap_or(50).clamp(1, 200);
    runtime.block_on(async move {
        let (client, connection) = tokio_postgres::connect(url, NoTls)
            .await
            .map_err(|error| ToolError::new(format!("failed to connect to postgres: {error}")))?;
        let _connection = tokio::spawn(async move {
            let _ = connection.await;
        });
        let rows = client
            .query(query.as_str(), &[])
            .await
            .map_err(|error| ToolError::new(format!("postgres query failed: {error}")))?;
        let limited = rows.into_iter().take(limit).collect::<Vec<_>>();
        let columns = limited
            .first()
            .map(|row| {
                row.columns()
                    .iter()
                    .map(|column| column.name().to_string())
                    .collect::<Vec<_>>()
            })
            .unwrap_or_default();
        let items = limited
            .into_iter()
            .map(postgres_row_to_json)
            .collect::<Result<Vec<_>, _>>()?;
        Ok::<_, ToolError>(
            json!({
                "data_source_id": access.source_id,
                "data_source_name": access.source_name,
                "query": input.sql,
                "columns": columns,
                "rows": items,
                "row_count": items.len(),
            })
            .to_string(),
        )
    })
}

fn postgres_row_to_json(row: tokio_postgres::Row) -> Result<Value, ToolError> {
    let mut item = serde_json::Map::new();
    for (index, column) in row.columns().iter().enumerate() {
        let cell = if let Ok(value) = row.try_get::<usize, Option<String>>(index) {
            value.map(Value::String).unwrap_or(Value::Null)
        } else if let Ok(value) = row.try_get::<usize, Option<i64>>(index) {
            value.map(|number| json!(number)).unwrap_or(Value::Null)
        } else if let Ok(value) = row.try_get::<usize, Option<f64>>(index) {
            value.map(|number| json!(number)).unwrap_or(Value::Null)
        } else if let Ok(value) = row.try_get::<usize, Option<bool>>(index) {
            value.map(|flag| json!(flag)).unwrap_or(Value::Null)
        } else {
            Value::String("<unsupported>".to_string())
        };
        item.insert(column.name().to_string(), cell);
    }
    Ok(Value::Object(item))
}

fn resolve_thread_data_access(
    store: &ThreadStore,
    record: &ThreadRecord,
    execution_context: Option<&RunExecutionContext>,
) -> Result<ResolvedDataAccess, Box<dyn std::error::Error>> {
    if let Some(source_ids) = execution_context
        .and_then(|context| context.data_source_ids.as_ref())
        .filter(|items| !items.is_empty())
    {
        let data_sources = store
            .load_data_sources()?
            .into_iter()
            .filter(|item| source_ids.iter().any(|source_id| source_id == &item.id))
            .collect::<Vec<_>>();
        return Ok(ResolvedDataAccess { data_sources });
    }

    let knowledge_base = if let Some(knowledge_base_id) = record.knowledge_base_id.as_deref() {
        store.get_knowledge_base(knowledge_base_id)?
    } else if let Some(project_id) = record.project_id.as_deref() {
        store
            .load_knowledge_bases()?
            .into_iter()
            .find(|item| item.default_project_id.as_deref() == Some(project_id))
    } else {
        None
    };
    let Some(knowledge_base) = knowledge_base else {
        return Ok(ResolvedDataAccess {
            data_sources: Vec::new(),
        });
    };

    let data_sources = store
        .load_data_sources()?
        .into_iter()
        .filter(|item| item.knowledge_base_id == knowledge_base.id)
        .collect::<Vec<_>>();
    Ok(ResolvedDataAccess { data_sources })
}

fn resolve_override_knowledge_base_for_run(
    store: &ThreadStore,
    record: &ThreadRecord,
    execution_context: Option<&RunExecutionContext>,
) -> Result<Option<KnowledgeBaseRecord>, AppError> {
    let Some(knowledge_base_id) =
        execution_context.and_then(|context| context.knowledge_base_id.as_deref())
    else {
        return Ok(None);
    };

    let knowledge_base = store
        .get_knowledge_base(knowledge_base_id)
        .map_err(|error| AppError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?
        .ok_or_else(|| AppError::new(StatusCode::NOT_FOUND, "knowledge base not found"))?;
    let can_access =
        knowledge_base_matches_platform_scope(&knowledge_base, record.tenant_id.as_deref())
            || record.owner_id.as_deref().is_some_and(|owner_id| {
                knowledge_base_matches_user_scope(
                    &knowledge_base,
                    record.tenant_id.as_deref(),
                    owner_id,
                )
            });
    if !can_access {
        return Err(AppError::new(
            StatusCode::NOT_FOUND,
            "knowledge base not found",
        ));
    }

    Ok(Some(knowledge_base))
}

fn resolve_run_execution_context(
    store: &ThreadStore,
    record: &ThreadRecord,
    request: &RunRequest,
) -> Result<Option<RunExecutionContext>, AppError> {
    let Some(context) = request.execution_context.as_ref() else {
        return Ok(None);
    };

    let knowledge_base_name = if let Some(knowledge_base) =
        resolve_override_knowledge_base_for_run(store, record, Some(context))?
    {
        Some(knowledge_base.name)
    } else {
        record.knowledge_base_name.clone()
    };

    Ok(Some(RunExecutionContext {
        knowledge_base_id: context.knowledge_base_id.clone(),
        data_source_ids: context.data_source_ids.clone(),
        knowledge_base_name,
        auto_retrieval: context.auto_retrieval,
    }))
}

fn effective_record_for_run(
    record: &ThreadRecord,
    execution_context: Option<&RunExecutionContext>,
) -> ThreadRecord {
    let mut effective = record.clone();
    if let Some(context) = execution_context {
        if context.knowledge_base_id.is_some() {
            effective.knowledge_base_id = context.knowledge_base_id.clone();
            effective.knowledge_base_name = context.knowledge_base_name.clone();
        }
    }
    effective
}

fn string_config_value(config: &Value, key: &str) -> Option<String> {
    config
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .map(ToString::to_string)
}

fn string_array_config_value(config: &Value, key: &str) -> Vec<String> {
    config
        .get(key)
        .and_then(Value::as_array)
        .map(|items| {
            items
                .iter()
                .filter_map(Value::as_str)
                .map(str::trim)
                .filter(|value| !value.is_empty())
                .map(ToString::to_string)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default()
}

fn redact_connection_string(value: &str) -> String {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return String::new();
    }

    let Some(scheme_sep) = trimmed.find("://") else {
        return trimmed.to_string();
    };
    let credentials_start = scheme_sep + 3;
    let remainder = &trimmed[credentials_start..];
    let Some(at_offset) = remainder.find('@') else {
        return trimmed.to_string();
    };
    let at_index = credentials_start + at_offset;
    let credentials = &trimmed[credentials_start..at_index];
    if credentials.is_empty() {
        return trimmed.to_string();
    }

    let redacted = if let Some(colon_index) = credentials.find(':') {
        let username = &credentials[..colon_index];
        if username.is_empty() {
            "***".to_string()
        } else {
            format!("{username}:***")
        }
    } else {
        "***".to_string()
    };

    format!(
        "{}{}{}",
        &trimmed[..credentials_start],
        redacted,
        &trimmed[at_index..]
    )
}

fn object_array_config_value<T, F>(config: &Value, key: &str, mapper: F) -> Vec<T>
where
    F: Fn(&Value) -> Option<T>,
{
    config
        .get(key)
        .and_then(Value::as_array)
        .map(|items| items.iter().filter_map(mapper).collect::<Vec<_>>())
        .unwrap_or_default()
}

fn present_path_tail(value: &str) -> String {
    Path::new(value)
        .file_name()
        .and_then(|name| name.to_str())
        .map(ToString::to_string)
        .unwrap_or_else(|| value.to_string())
}

fn resolve_es_access(config: &EsConfig, data_access: &ResolvedDataAccess) -> ResolvedEsAccess {
    let es_sources = data_access
        .data_sources
        .iter()
        .filter(|source| source.kind == DataSourceKind::Es)
        .collect::<Vec<_>>();
    let indices = es_sources
        .iter()
        .filter_map(|source| {
            string_config_value(&source.config, "index")
                .or_else(|| string_config_value(&source.config, "default_index"))
        })
        .collect::<Vec<_>>();

    if let Some(source) = es_sources.first() {
        return ResolvedEsAccess {
            base_url: string_config_value(&source.config, "endpoint")
                .or_else(|| string_config_value(&source.config, "base_url"))
                .or_else(|| config.base_url.clone()),
            api_key: string_config_value(&source.config, "api_key")
                .or_else(|| config.api_key.clone()),
            username: string_config_value(&source.config, "username")
                .or_else(|| config.username.clone()),
            password: string_config_value(&source.config, "password")
                .or_else(|| config.password.clone()),
            default_index: string_config_value(&source.config, "index")
                .or_else(|| string_config_value(&source.config, "default_index"))
                .or_else(|| config.default_index.clone()),
            indices,
            source_id: Some(source.id.clone()),
            source_name: Some(source.name.clone()),
        };
    }

    ResolvedEsAccess {
        base_url: config.base_url.clone(),
        api_key: config.api_key.clone(),
        username: config.username.clone(),
        password: config.password.clone(),
        default_index: config.default_index.clone(),
        indices: config.default_index.clone().into_iter().collect::<Vec<_>>(),
        source_id: None,
        source_name: None,
    }
}

fn resolve_document_access(data_access: &ResolvedDataAccess) -> ResolvedDocumentAccess {
    let source = data_access
        .data_sources
        .iter()
        .find(|item| item.kind == DataSourceKind::Upload);
    let Some(source) = source else {
        return ResolvedDocumentAccess::default();
    };
    let files = object_array_config_value(&source.config, "files", parse_document_file_record);
    ResolvedDocumentAccess {
        source_id: Some(source.id.clone()),
        source_name: Some(source.name.clone()),
        files,
    }
}

fn resolve_web_access(data_access: &ResolvedDataAccess) -> ResolvedWebAccess {
    let source = data_access
        .data_sources
        .iter()
        .find(|item| item.kind == DataSourceKind::Web);
    let Some(source) = source else {
        return ResolvedWebAccess::default();
    };
    ResolvedWebAccess {
        source_id: Some(source.id.clone()),
        source_name: Some(source.name.clone()),
        urls: string_array_config_value(&source.config, "urls"),
    }
}

fn resolve_db_access(data_access: &ResolvedDataAccess) -> ResolvedDbAccess {
    let source = data_access
        .data_sources
        .iter()
        .find(|item| item.kind == DataSourceKind::Db);
    let Some(source) = source else {
        return ResolvedDbAccess::default();
    };
    ResolvedDbAccess {
        source_id: Some(source.id.clone()),
        source_name: Some(source.name.clone()),
        url: string_config_value(&source.config, "url")
            .or_else(|| string_config_value(&source.config, "endpoint"))
            .or_else(|| string_config_value(&source.config, "base_url")),
        schema: string_config_value(&source.config, "schema")
            .or_else(|| string_config_value(&source.config, "database")),
    }
}

fn parse_document_file_record(value: &Value) -> Option<DocumentFileRecord> {
    serde_json::from_value::<DocumentFileRecord>(value.clone()).ok()
}

fn thread_message_id(thread_id: &str, index: usize) -> String {
    format!("{thread_id}-message-{index}")
}

fn resolve_source_message_text(
    thread: &Arc<ManagedThread>,
    source_message_id: &str,
) -> Option<String> {
    let guard = thread
        .shared
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let prefix = format!("{}-message-", guard.record.id);
    let index = source_message_id
        .strip_prefix(&prefix)
        .and_then(|value| value.parse::<usize>().ok())?;
    let message = guard.session.messages.get(index)?;
    let text = message
        .blocks
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text { text } => Some(text.trim()),
            _ => None,
        })
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n");
    (!text.is_empty()).then_some(text)
}

fn message_snapshot(
    thread_id: &str,
    index: usize,
    message: &ConversationMessage,
) -> MessageSnapshot {
    MessageSnapshot {
        id: thread_message_id(thread_id, index),
        role: match message.role {
            MessageRole::System => "system",
            MessageRole::User => "user",
            MessageRole::Assistant => "assistant",
            MessageRole::Tool => "tool",
        }
        .to_string(),
        blocks: message
            .blocks
            .iter()
            .filter_map(|block| match block {
                ContentBlock::Text { text } => {
                    Some(MessageBlockSnapshot::Text { text: text.clone() })
                }
                ContentBlock::Thinking { .. } => None,
                ContentBlock::ToolUse { id, name, input } => Some(MessageBlockSnapshot::ToolUse {
                    id: id.clone(),
                    name: name.clone(),
                    input: input.clone(),
                }),
                ContentBlock::ToolResult {
                    tool_use_id,
                    tool_name,
                    output,
                    is_error,
                } => Some(MessageBlockSnapshot::ToolResult {
                    tool_use_id: tool_use_id.clone(),
                    tool_name: tool_name.clone(),
                    output: output.clone(),
                    is_error: *is_error,
                }),
            })
            .collect(),
    }
}

fn persist_thread_state(
    thread: &Arc<ManagedThread>,
    store: &ThreadStore,
) -> Result<(), Box<dyn std::error::Error>> {
    let mut guard = thread
        .shared
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    guard.record.last_status = Some(guard.status);
    guard.record.last_error = guard.last_error.clone();
    guard.record.next_run_id = guard.next_run_id.max(1);
    guard.session.save_to_path(&guard.record.session_path)?;
    store.upsert_record(&guard.record)?;
    Ok(())
}

fn load_threads(store: &ThreadStore) -> Result<Vec<ManagedThread>, Box<dyn std::error::Error>> {
    let mut threads = Vec::new();
    for mut record in store.load_records()? {
        let mut status = record.last_status.unwrap_or(ThreadStatus::Idle);
        let mut last_error = record.last_error.clone();
        if matches!(
            status,
            ThreadStatus::Running | ThreadStatus::InterruptRequested
        ) {
            let previous_status = status;
            status = ThreadStatus::Failed;
            last_error = Some("service restarted during an active run".to_string());
            record.last_status = Some(status);
            record.last_error = last_error.clone();
            record.updated_at_ms = now_millis();
            store.upsert_record(&record)?;
            store.append_audit_record(
                &record.id,
                &AuditRecord {
                    id: generate_id("audit"),
                    run_id: None,
                    kind: "thread_recovered".to_string(),
                    created_at_ms: now_millis(),
                    payload: json!({
                        "previous_status": previous_status,
                        "restored_status": status,
                        "error": last_error.clone(),
                    }),
                },
            )?;
        }
        let session = Session::load_from_path(&record.session_path)?;
        let visible_memory_notes = store.load_visible_memory_notes(&record)?;
        let audit_records = store.load_audit_records(&record.id, MAX_VISIBLE_AUDIT_RECORDS)?;
        let next_run_id = record.next_run_id.max(1);
        threads.push(ManagedThread::new(ThreadState {
            record,
            visible_memory_notes,
            audit_records,
            session,
            status,
            last_error,
            draft_assistant_text: String::new(),
            next_run_id,
            current_run: None,
            pending_replan: None,
        }));
    }
    Ok(threads)
}

fn import_legacy_thread_records(
    store: &ThreadStore,
    config: &AppConfig,
) -> Result<(), Box<dyn std::error::Error>> {
    let dir = config.thread_records_dir();
    if !dir.exists() {
        return Ok(());
    }

    for entry in fs::read_dir(dir)? {
        let entry = entry?;
        let path = entry.path();
        if path.extension().and_then(|ext| ext.to_str()) != Some("json") {
            continue;
        }

        let raw = fs::read_to_string(path)?;
        let record: ThreadRecord = serde_json::from_str(&raw)?;
        store.upsert_record(&record)?;
    }

    Ok(())
}

fn build_replan_prompt(topic: Option<&str>, reason: Option<&str>) -> String {
    let topic_line = topic.unwrap_or("沿用当前主题");
    let reason_line = reason.unwrap_or("用户要求重新规划");
    format!(
        "The user asked you to interrupt the previous line of reasoning and replan.\n\
Current topic hint: {topic_line}\n\
Reason: {reason_line}\n\
Reassess scope, identify the missing evidence, and continue with a tighter plan."
    )
}

fn normalize_expert_panel_request(input: ExpertPanelRequest) -> Result<ExpertPanelRequest, String> {
    let panel_id = input.panel_id.trim();
    if panel_id.is_empty() {
        return Err("expert panel id must not be empty".to_string());
    }

    let master_skill = input.master_skill.trim();
    if master_skill.is_empty() {
        return Err("expert master skill must not be empty".to_string());
    }

    let mut experts = Vec::new();
    for expert in input.experts {
        let skill = expert.skill.trim();
        let label = expert.label.trim();
        if skill.is_empty() || label.is_empty() {
            return Err("expert panel experts must include non-empty skill and label".to_string());
        }
        experts.push(ExpertPanelExpert {
            skill: skill.to_string(),
            scope: expert.scope,
            label: label.to_string(),
            description: normalize_optional_text(expert.description),
        });
    }
    if experts.is_empty() {
        return Err("expert panel must include at least one expert".to_string());
    }

    Ok(ExpertPanelRequest {
        panel_id: panel_id.to_string(),
        master_skill: master_skill.to_string(),
        experts,
    })
}

fn normalize_expert_panel_run_request(
    input: ExpertPanelRunRequest,
) -> Result<ExpertPanelRunRequest, String> {
    let question = normalize_optional_text(input.question);
    let source_message_id = normalize_optional_text(input.source_message_id);
    let knowledge_base_id = normalize_optional_text(input.knowledge_base_id);
    let data_source_ids = input
        .data_source_ids
        .map(|items| {
            items
                .into_iter()
                .map(|item| item.trim().to_string())
                .filter(|item| !item.is_empty())
                .collect::<Vec<_>>()
        })
        .filter(|items| !items.is_empty());
    let auto_retrieval = input.auto_retrieval;
    if question.is_some() == source_message_id.is_some() {
        return Err(
            "expert panel run requires exactly one of question or source_message_id".to_string(),
        );
    }

    let panel = normalize_expert_panel_request(ExpertPanelRequest {
        panel_id: "validation".to_string(),
        master_skill: "expert-brainstorm".to_string(),
        experts: input.experts,
    })?;

    let retry_count = input.retry_count.unwrap_or(1).min(3);
    let concurrency_limit = input.concurrency_limit.unwrap_or(3).clamp(1, 8);

    Ok(ExpertPanelRunRequest {
        question,
        source_message_id,
        knowledge_base_id,
        data_source_ids,
        auto_retrieval,
        experts: panel.experts,
        retry_count: Some(retry_count),
        concurrency_limit: Some(concurrency_limit),
    })
}

fn expert_run_initial_response(
    thread_id: &str,
    run_id: &str,
    request: &ExpertPanelRunRequest,
) -> ExpertPanelRunResponse {
    ExpertPanelRunResponse {
        run_id: run_id.to_string(),
        thread_id: thread_id.to_string(),
        status: ExpertPanelRunStatus::Running,
        retry_count: request.retry_count.unwrap_or(1),
        concurrency_limit: request.concurrency_limit.unwrap_or(3),
        experts: request
            .experts
            .iter()
            .map(|expert| ExpertPanelRunExpertState {
                skill: expert.skill.clone(),
                scope: expert.scope,
                label: expert.label.clone(),
                description: expert.description.clone(),
                status: ExpertPanelExpertStatus::Queued,
                attempts: 0,
                content: None,
                citations: Vec::new(),
                confidence: None,
                stance: None,
                error: None,
            })
            .collect(),
    }
}

fn expert_run_response_from_audit(
    thread: &Arc<ManagedThread>,
    run_id: &str,
) -> Option<ExpertPanelRunResponse> {
    let guard = thread
        .shared
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    guard
        .audit_records
        .iter()
        .rev()
        .find_map(|record| expert_run_response_from_record(record, run_id))
}

fn expert_run_response_from_record(
    record: &AuditRecord,
    run_id: &str,
) -> Option<ExpertPanelRunResponse> {
    if record.kind != "expert_panel_run_state" {
        return None;
    }
    let response = serde_json::from_value::<ExpertPanelRunResponse>(record.payload.clone()).ok()?;
    if response.run_id == run_id {
        Some(response)
    } else {
        None
    }
}

fn expert_run_status_rank(status: ExpertPanelRunStatus) -> u8 {
    match status {
        ExpertPanelRunStatus::Queued => 0,
        ExpertPanelRunStatus::Running => 1,
        ExpertPanelRunStatus::Succeeded | ExpertPanelRunStatus::Failed => 2,
    }
}

fn expert_run_response_supersedes(
    existing: &ExpertPanelRunResponse,
    candidate: &ExpertPanelRunResponse,
) -> bool {
    let existing_rank = expert_run_status_rank(existing.status);
    let candidate_rank = expert_run_status_rank(candidate.status);
    if candidate_rank != existing_rank {
        return candidate_rank > existing_rank;
    }
    for (existing_expert, candidate_expert) in existing.experts.iter().zip(candidate.experts.iter())
    {
        let existing_expert_rank = expert_run_status_rank(match existing_expert.status {
            ExpertPanelExpertStatus::Queued => ExpertPanelRunStatus::Queued,
            ExpertPanelExpertStatus::Running | ExpertPanelExpertStatus::Retrying => {
                ExpertPanelRunStatus::Running
            }
            ExpertPanelExpertStatus::Succeeded => ExpertPanelRunStatus::Succeeded,
            ExpertPanelExpertStatus::Failed => ExpertPanelRunStatus::Failed,
        });
        let candidate_expert_rank = expert_run_status_rank(match candidate_expert.status {
            ExpertPanelExpertStatus::Queued => ExpertPanelRunStatus::Queued,
            ExpertPanelExpertStatus::Running | ExpertPanelExpertStatus::Retrying => {
                ExpertPanelRunStatus::Running
            }
            ExpertPanelExpertStatus::Succeeded => ExpertPanelRunStatus::Succeeded,
            ExpertPanelExpertStatus::Failed => ExpertPanelRunStatus::Failed,
        });
        if candidate_expert_rank != existing_expert_rank {
            return candidate_expert_rank > existing_expert_rank;
        }
        if candidate_expert.attempts != existing_expert.attempts {
            return candidate_expert.attempts > existing_expert.attempts;
        }
        let existing_has_detail =
            existing_expert.content.is_some() || existing_expert.error.is_some();
        let candidate_has_detail =
            candidate_expert.content.is_some() || candidate_expert.error.is_some();
        if existing_has_detail != candidate_has_detail {
            return candidate_has_detail;
        }
    }
    false
}

fn load_expert_run_response(
    state: &Arc<AppState>,
    thread: &Arc<ManagedThread>,
    run_id: &str,
) -> Result<Option<ExpertPanelRunResponse>, AppError> {
    if let Some(response) = expert_run_response_from_audit(thread, run_id) {
        return Ok(Some(response));
    }
    let thread_id = thread.id().to_string();
    state
        .store
        .load_latest_expert_panel_run_state(&thread_id, run_id)
        .map_err(|error| AppError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))
}

fn load_expert_run_response_or_log(
    state: &Arc<AppState>,
    thread: &Arc<ManagedThread>,
    run_id: &str,
) -> Option<ExpertPanelRunResponse> {
    match load_expert_run_response(state, thread, run_id) {
        Ok(response) => response,
        Err(error) => {
            eprintln!(
                "failed to load expert panel run state for thread {} run {}: {}",
                thread.id(),
                run_id,
                error.message,
            );
            None
        }
    }
}

fn persist_expert_run_state(
    state: &Arc<AppState>,
    thread: &Arc<ManagedThread>,
    response: &ExpertPanelRunResponse,
) -> Result<(), Box<dyn std::error::Error>> {
    if let Some(existing) = load_expert_run_response_or_log(state, thread, &response.run_id) {
        if !expert_run_response_supersedes(&existing, response) {
            return Ok(());
        }
    }
    append_thread_audit(
        &state.store,
        thread,
        "expert_panel_run_state",
        None,
        serde_json::to_value(response)?,
    )?;
    thread.publish(
        "expert_run_event",
        json!({
            "run_id": response.run_id,
            "event": "state_changed",
            "status": response.status,
        }),
    );
    Ok(())
}

fn text_from_message(message: &ConversationMessage) -> String {
    message
        .blocks
        .iter()
        .filter_map(|block| match block {
            ContentBlock::Text { text } => Some(text.trim()),
            _ => None,
        })
        .filter(|text| !text.is_empty())
        .collect::<Vec<_>>()
        .join("\n\n")
}

fn contains_retrieval_tool(message: &ConversationMessage) -> bool {
    message.blocks.iter().any(|block| {
        matches!(
            block,
            ContentBlock::ToolUse { name, .. } if name == "EsSearch" || name == "SourceSearch"
        )
    })
}

fn is_expert_message_text(text: &str) -> bool {
    if !text.starts_with("### ") {
        return false;
    }
    !text.to_ascii_lowercase().contains("### final synthesis")
}

fn is_explicit_write_intent_text(text: &str) -> bool {
    let trimmed = text.trim();
    if trimmed.is_empty() {
        return false;
    }

    [
        "用这些证据重写",
        "基于这些证据重写",
        "用证据重写",
        "根据证据重写",
        "整理为报告",
        "生成正式报告",
        "生成报告",
        "输出报告",
        "撰写报告",
    ]
    .iter()
    .any(|pattern| trimmed.contains(pattern))
}

fn audit_prompt(record: &AuditRecord) -> Option<&str> {
    if record.kind != "run_started" {
        return None;
    }
    record.payload.get("prompt").and_then(Value::as_str)
}

fn infer_research_task_state(thread: &Arc<ManagedThread>) -> Option<ResearchTaskStateRecord> {
    let guard = thread
        .shared
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    let title = guard
        .record
        .topic
        .clone()
        .unwrap_or_else(|| "未命名研究".to_string());

    let mut question_count = 0_usize;
    let mut retrieval_count = 0_usize;
    let mut expert_count = 0_usize;
    let mut synthesis_count = 0_usize;
    let mut write_intent_count = 0_usize;
    let artifact_count = guard.record.artifacts.len();

    for message in &guard.session.messages {
        let text = text_from_message(message);
        match message.role {
            MessageRole::User if !text.is_empty() => {
                question_count += 1;
            }
            MessageRole::Assistant if text.to_ascii_lowercase().contains("### final synthesis") => {
                synthesis_count += 1;
            }
            MessageRole::Assistant if is_expert_message_text(&text) => {
                expert_count += 1;
            }
            _ => {}
        }
        if contains_retrieval_tool(message) {
            retrieval_count += 1;
        }
    }

    for audit in &guard.audit_records {
        if audit_prompt(audit).is_some_and(is_explicit_write_intent_text) {
            write_intent_count += 1;
        }
    }

    if question_count == 0
        && retrieval_count == 0
        && expert_count == 0
        && synthesis_count == 0
        && write_intent_count == 0
        && artifact_count == 0
    {
        return None;
    }

    let status = if write_intent_count > 0 && synthesis_count > 0 {
        ResearchTaskStage::WritingReady
    } else if synthesis_count > 0 {
        ResearchTaskStage::Synthesis
    } else if expert_count > 0 {
        ResearchTaskStage::ExpertReview
    } else if retrieval_count > 0 {
        ResearchTaskStage::Retrieval
    } else {
        ResearchTaskStage::Question
    };

    let mut stage_history = Vec::new();
    stage_history.push(ResearchTaskStageRecord {
        stage: ResearchTaskStage::Question,
        label: ResearchTaskStage::Question.label().to_string(),
        at_ms: guard.record.created_at_ms,
    });
    if retrieval_count > 0 {
        stage_history.push(ResearchTaskStageRecord {
            stage: ResearchTaskStage::Retrieval,
            label: ResearchTaskStage::Retrieval.label().to_string(),
            at_ms: guard.record.updated_at_ms,
        });
    }
    if expert_count > 0 {
        stage_history.push(ResearchTaskStageRecord {
            stage: ResearchTaskStage::ExpertReview,
            label: ResearchTaskStage::ExpertReview.label().to_string(),
            at_ms: guard.record.updated_at_ms,
        });
    }
    if synthesis_count > 0 {
        stage_history.push(ResearchTaskStageRecord {
            stage: ResearchTaskStage::Synthesis,
            label: ResearchTaskStage::Synthesis.label().to_string(),
            at_ms: guard.record.updated_at_ms,
        });
    }
    if write_intent_count > 0 && synthesis_count > 0 {
        stage_history.push(ResearchTaskStageRecord {
            stage: ResearchTaskStage::WritingReady,
            label: ResearchTaskStage::WritingReady.label().to_string(),
            at_ms: guard.record.updated_at_ms,
        });
    }

    let (next_recommended_action, available_actions) = match status {
        ResearchTaskStage::WritingReady => (
            "整理综合结论并生成正式报告".to_string(),
            vec![
                "用这些证据重写".to_string(),
                "整理为报告".to_string(),
                "补充反方观点".to_string(),
            ],
        ),
        ResearchTaskStage::Synthesis => (
            "补充证据或直接整理为报告".to_string(),
            vec![
                "整理为报告".to_string(),
                "补充证据".to_string(),
                "用这些证据重写".to_string(),
            ],
        ),
        ResearchTaskStage::ExpertReview => (
            "要求专家交叉复评或补充证据".to_string(),
            vec![
                "先查资料".to_string(),
                "补充反方观点".to_string(),
                "只讨论不写作".to_string(),
            ],
        ),
        ResearchTaskStage::Retrieval => (
            "基于证据回答或发起专家复评".to_string(),
            vec![
                "发起专家复评".to_string(),
                "继续检索".to_string(),
                "基于证据回答".to_string(),
            ],
        ),
        ResearchTaskStage::Question => (
            "继续澄清问题或指定资料范围".to_string(),
            vec![
                "先查资料".to_string(),
                "发起专家会诊".to_string(),
                "继续提问".to_string(),
            ],
        ),
    };

    Some(ResearchTaskStateRecord {
        id: guard.record.id.clone(),
        title,
        status: status.clone(),
        status_label: status.label().to_string(),
        next_recommended_action,
        available_actions,
        stage_history,
    })
}

fn latest_research_task_state_from_audit(
    thread: &Arc<ManagedThread>,
) -> Option<ResearchTaskStateRecord> {
    let guard = thread
        .shared
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    guard
        .audit_records
        .iter()
        .rev()
        .find(|record| record.kind == "research_task_state")
        .and_then(|record| {
            serde_json::from_value::<ResearchTaskStateRecord>(record.payload.clone()).ok()
        })
}

fn persist_research_task_state(
    state: &Arc<AppState>,
    thread: &Arc<ManagedThread>,
) -> Result<(), Box<dyn std::error::Error>> {
    let Some(next_state) = infer_research_task_state(thread) else {
        return Ok(());
    };
    if latest_research_task_state_from_audit(thread).as_ref() == Some(&next_state) {
        return Ok(());
    }
    append_thread_audit(
        &state.store,
        thread,
        "research_task_state",
        None,
        serde_json::to_value(next_state)?,
    )?;
    Ok(())
}

fn parse_user_id(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err("user id must not be empty".to_string());
    }
    if trimmed.len() > 128 {
        return Err("user id must be at most 128 characters".to_string());
    }
    if trimmed.chars().any(char::is_control) {
        return Err("user id must not contain control characters".to_string());
    }
    Ok(trimmed.to_string())
}

fn parse_tenant_id(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err("tenant id must not be empty".to_string());
    }
    if trimmed.len() > 128 {
        return Err("tenant id must be at most 128 characters".to_string());
    }
    if trimmed.chars().any(char::is_control) {
        return Err("tenant id must not contain control characters".to_string());
    }
    Ok(trimmed.to_string())
}

fn parse_api_key(value: &str) -> Result<String, String> {
    let trimmed = value.trim();
    if trimmed.is_empty() {
        return Err("api key must not be empty".to_string());
    }
    if trimmed.len() > 512 {
        return Err("api key must be at most 512 characters".to_string());
    }
    if trimmed.chars().any(char::is_control) {
        return Err("api key must not contain control characters".to_string());
    }
    Ok(trimmed.to_string())
}

fn normalize_api_key_display_name(value: Option<&str>) -> Result<Option<String>, String> {
    let Some(value) = value.map(str::trim) else {
        return Ok(None);
    };
    if value.is_empty() {
        return Ok(None);
    }
    if value.len() > 128 {
        return Err("api key display name must be at most 128 characters".to_string());
    }
    if value.chars().any(char::is_control) {
        return Err("api key display name must not contain control characters".to_string());
    }
    Ok(Some(value.to_string()))
}

fn parse_bool_env(name: &str, value: &str) -> Result<bool, String> {
    match value.trim().to_ascii_lowercase().as_str() {
        "1" | "true" | "yes" | "on" => Ok(true),
        "0" | "false" | "no" | "off" => Ok(false),
        other => Err(format!("invalid {name} `{other}`: expected true/false")),
    }
}

fn parse_limit_env(name: &str, value: &str) -> Result<Option<usize>, String> {
    let limit = value
        .trim()
        .parse::<usize>()
        .map_err(|error| format!("invalid {name} `{value}`: {error}"))?;
    if limit == 0 {
        return Ok(None);
    }
    Ok(Some(limit))
}

fn parse_bootstrap_api_keys(value: &str) -> Result<Vec<SeedApiKey>, String> {
    value
        .split(';')
        .map(str::trim)
        .filter(|item| !item.is_empty())
        .map(|item| {
            let parts = item.splitn(4, ':').collect::<Vec<_>>();
            if !(parts.len() == 3 || parts.len() == 4) {
                return Err(format!(
                    "invalid bootstrap api key `{item}`; expected tenant:user:key[:display_name]"
                ));
            }
            Ok(SeedApiKey {
                tenant_id: parse_tenant_id(parts[0])?,
                user_id: parse_user_id(parts[1])?,
                raw_key: parse_api_key(parts[2])?,
                display_name: parts
                    .get(3)
                    .map(|value| value.trim())
                    .filter(|value| !value.is_empty())
                    .map(ToString::to_string),
            })
        })
        .collect()
}

fn hash_api_key(raw_key: &str) -> String {
    let digest = Sha256::digest(raw_key.as_bytes());
    encode_hex(&digest)
}

fn api_key_prefix(raw_key: &str) -> String {
    raw_key.chars().take(8).collect()
}

fn seed_bootstrap_api_keys(
    store: &ThreadStore,
    bootstrap_api_keys: &[SeedApiKey],
) -> Result<(), Box<dyn std::error::Error>> {
    for seed in bootstrap_api_keys {
        let now_ms = now_millis();
        store.upsert_api_key(&ApiKeyRecord {
            id: format!("api-key-{}", hash_api_key(&seed.raw_key)[..16].to_string()),
            tenant_id: seed.tenant_id.clone(),
            user_id: seed.user_id.clone(),
            display_name: seed.display_name.clone(),
            key_prefix: api_key_prefix(&seed.raw_key),
            key_hash: hash_api_key(&seed.raw_key),
            created_at_ms: now_ms,
            updated_at_ms: now_ms,
            last_used_at_ms: None,
            disabled_at_ms: None,
        })?;
    }
    Ok(())
}

fn resolve_auth_context(
    state: &Arc<AppState>,
    headers: &HeaderMap,
    query: &AuthQuery,
) -> Result<AuthContext, AppError> {
    if let Some(api_key) = request_api_key(headers, query.api_key.as_deref())? {
        let record = state
            .store
            .authenticate_api_key(&api_key)
            .map_err(|error| AppError::new(StatusCode::INTERNAL_SERVER_ERROR, error.to_string()))?
            .ok_or_else(|| AppError::new(StatusCode::UNAUTHORIZED, "invalid api key"))?;
        return Ok(AuthContext {
            auth_mode: AuthMode::ApiKey,
            tenant_id: Some(record.tenant_id),
            user_id: record.user_id,
            api_key_id: Some(record.id),
            api_key_prefix: Some(record.key_prefix),
            display_name: record.display_name,
        });
    }

    if state.config.dev_user_header_auth_enabled {
        if let Some(user_id) = request_dev_user_id(headers, query.user_id.as_deref())? {
            return Ok(AuthContext {
                auth_mode: AuthMode::DevUserHeader,
                tenant_id: None,
                user_id,
                api_key_id: None,
                api_key_prefix: None,
                display_name: None,
            });
        }
    }

    Err(AppError::new(
        StatusCode::UNAUTHORIZED,
        if state.config.dev_user_header_auth_enabled {
            "missing authentication; pass Authorization: Bearer <api_key>, X-CLAWD-API-KEY, api_key query parameter, or X-CLAWD-USER-ID in dev mode"
        } else {
            "missing authentication; pass Authorization: Bearer <api_key>, X-CLAWD-API-KEY, or api_key query parameter"
        },
    ))
}

fn request_dev_user_id(
    headers: &HeaderMap,
    query_user_id: Option<&str>,
) -> Result<Option<String>, AppError> {
    if let Some(user_id) = query_user_id {
        return parse_user_id(user_id)
            .map(Some)
            .map_err(|error| AppError::new(StatusCode::BAD_REQUEST, error));
    }

    if let Some(value) = headers
        .get("x-clawd-user-id")
        .or_else(|| headers.get("x-user-id"))
    {
        let raw = value
            .to_str()
            .map_err(|_| AppError::new(StatusCode::BAD_REQUEST, "invalid user id header"))?;
        return parse_user_id(raw)
            .map(Some)
            .map_err(|error| AppError::new(StatusCode::BAD_REQUEST, error));
    }

    Ok(None)
}

fn request_api_key(
    headers: &HeaderMap,
    query_api_key: Option<&str>,
) -> Result<Option<String>, AppError> {
    if let Some(value) = headers.get(header::AUTHORIZATION) {
        let raw = value
            .to_str()
            .map_err(|_| AppError::new(StatusCode::BAD_REQUEST, "invalid authorization header"))?;
        let bearer = raw
            .strip_prefix("Bearer ")
            .or_else(|| raw.strip_prefix("bearer "))
            .ok_or_else(|| {
                AppError::new(
                    StatusCode::BAD_REQUEST,
                    "authorization header must use Bearer <api_key>",
                )
            })?;
        return parse_api_key(bearer)
            .map(Some)
            .map_err(|error| AppError::new(StatusCode::BAD_REQUEST, error));
    }

    if let Some(value) = headers.get("x-clawd-api-key") {
        let raw = value
            .to_str()
            .map_err(|_| AppError::new(StatusCode::BAD_REQUEST, "invalid api key header"))?;
        return parse_api_key(raw)
            .map(Some)
            .map_err(|error| AppError::new(StatusCode::BAD_REQUEST, error));
    }

    if let Some(api_key) = query_api_key {
        return parse_api_key(api_key)
            .map(Some)
            .map_err(|error| AppError::new(StatusCode::BAD_REQUEST, error));
    }

    Ok(None)
}

fn parse_permission_mode(value: &str) -> Result<PermissionMode, String> {
    match value.trim() {
        "read-only" => Ok(PermissionMode::ReadOnly),
        "workspace-write" => Ok(PermissionMode::WorkspaceWrite),
        "danger-full-access" => Ok(PermissionMode::DangerFullAccess),
        other => Err(format!(
            "unsupported permission mode `{other}` (expected read-only, workspace-write, or danger-full-access)"
        )),
    }
}

fn parse_run_timeout_secs(value: &str) -> Result<Option<u64>, String> {
    let seconds = value
        .trim()
        .parse::<u64>()
        .map_err(|error| format!("invalid CLAWD_RUN_TIMEOUT_SECS `{value}`: {error}"))?;
    if seconds == 0 {
        return Ok(None);
    }
    Ok(Some(seconds))
}

fn now_millis() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|duration| duration.as_millis() as u64)
        .unwrap_or_default()
}

fn generate_id(prefix: &str) -> String {
    let counter = ID_COUNTER.fetch_add(1, Ordering::Relaxed);
    format!("{prefix}-{}-{}-{counter}", now_millis(), std::process::id())
}

fn generate_api_key_secret() -> String {
    let mut bytes = [0_u8; 24];
    OsRng.fill_bytes(&mut bytes);
    format!("ck_{}", encode_hex(&bytes))
}

fn encode_hex(bytes: &[u8]) -> String {
    let mut encoded = String::with_capacity(bytes.len() * 2);
    for byte in bytes {
        encoded.push_str(&format!("{byte:02x}"));
    }
    encoded
}

fn current_date_iso() -> String {
    let unix_days = now_millis() / 86_400_000;
    let z = i64::try_from(unix_days).unwrap_or(i64::MAX) + 719_468;
    let era = if z >= 0 { z } else { z - 146_096 } / 146_097;
    let doe = z - era * 146_097;
    let yoe = (doe - doe / 1_460 + doe / 36_524 - doe / 146_096) / 365;
    let year = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let day = doy - (153 * mp + 2) / 5 + 1;
    let month = mp + if mp < 10 { 3 } else { -9 };
    let year = year + if month <= 2 { 1 } else { 0 };
    format!("{year:04}-{month:02}-{day:02}")
}

fn truncate_audit_text(text: &str) -> Value {
    let char_count = text.chars().count();
    let preview = text.chars().take(MAX_AUDIT_TEXT_CHARS).collect::<String>();
    json!({
        "preview": preview,
        "truncated": char_count > MAX_AUDIT_TEXT_CHARS,
        "char_count": char_count,
    })
}

fn push_visible_audit_record(records: &mut Vec<AuditRecord>, record: AuditRecord) {
    records.push(record);
    if records.len() > MAX_VISIBLE_AUDIT_RECORDS {
        let overflow = records.len() - MAX_VISIBLE_AUDIT_RECORDS;
        records.drain(0..overflow);
    }
}

fn append_thread_audit(
    store: &ThreadStore,
    thread: &Arc<ManagedThread>,
    kind: impl Into<String>,
    run_id: Option<u64>,
    payload: Value,
) -> Result<AuditRecord, Box<dyn std::error::Error>> {
    let record = AuditRecord {
        id: generate_id("audit"),
        run_id,
        kind: kind.into(),
        created_at_ms: now_millis(),
        payload,
    };
    let thread_id = thread
        .shared
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
        .record
        .id
        .clone();
    store.append_audit_record(&thread_id, &record)?;
    {
        let mut guard = thread
            .shared
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        push_visible_audit_record(&mut guard.audit_records, record.clone());
    }
    thread.publish("audit_added", json!(record.clone()));
    Ok(record)
}

fn try_append_thread_audit(
    store: &ThreadStore,
    thread: &Arc<ManagedThread>,
    kind: impl Into<String>,
    run_id: Option<u64>,
    payload: Value,
) {
    let kind = kind.into();
    if let Err(error) = append_thread_audit(store, thread, kind.clone(), run_id, payload) {
        eprintln!(
            "failed to append audit record for thread {} kind {}: {error}",
            thread.id(),
            kind,
        );
    }
}

fn normalize_terms(text: &str) -> BTreeSet<String> {
    const STOPWORDS: &[&str] = &[
        "the", "a", "an", "and", "or", "to", "of", "in", "for", "on", "with", "is", "are", "be",
        "as", "at", "by", "from", "that", "this", "it", "its", "into", "继续", "分析", "主题",
        "资料", "文档", "总结",
    ];
    text.split(|ch: char| !ch.is_alphanumeric() && ch != '_' && ch != '-')
        .map(|token| token.trim().to_ascii_lowercase())
        .filter(|token| token.len() > 1 && !STOPWORDS.contains(&token.as_str()))
        .collect()
}

#[cfg(test)]
mod tests {
    use std::collections::HashMap;
    use std::ffi::OsString;
    use std::fs;
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::path::{Path, PathBuf};
    use std::sync::Arc;
    use std::sync::{Mutex, Mutex as StdMutex, OnceLock, RwLock};
    use std::thread;

    use axum::extract::{Query, State};
    use axum::http::{HeaderMap, StatusCode};
    use axum::Json;
    use runtime::{MessageRole, PermissionMode, Session};
    use rusqlite::Connection as TestSqliteConnection;
    use serde_json::{json, Value};

    use super::{
        allowed_tool_names, append_thread_audit, apply_project_update, build_system_prompt,
        build_tool_registry, collect_capacity_usage, default_database_url,
        delete_service_skill_file, discover_allowed_roots, ensure_mutation_rate_limit,
        ensure_run_capacity, ensure_thread_capacity, execute_artifact_emit,
        execute_expert_panel_emit, expert_run_response_from_audit, get_expert_panel_run,
        import_legacy_thread_records, list_service_skills, load_threads,
        map_tool_result_to_agent_updates, mutation_user_scope_key,
        normalize_expert_panel_run_request, normalize_project_default_skill_names, normalize_terms,
        parse_bootstrap_api_keys, parse_limit_env, parse_run_timeout_secs,
        parse_skill_starter_prompt_from_contents, parse_skill_tags_from_contents, parse_user_id,
        persist_expert_run_state, persist_research_task_state, persist_thread_state,
        post_thread_command, provider_client_from_record, provider_kind_for_model_access,
        render_skill_prompt, renumber_agent_tool_updates, request_model_for_model_access,
        resolve_es_access, resolve_service_skill, rewrite_tool_input, sqlite_path_from_url,
        thread_is_visible_to_auth, webagent_allowed_tool_names, ActiveRun, AppConfig, AppState,
        ArtifactKind, ArtifactRecord, AuditRecord, AuthContext, AuthMode, CapacityUsage,
        CommandRequest, DataSourceKind, DataSourceRecord, DocumentFileRecord, EsConfig,
        ExpertPanelExpert, ExpertPanelExpertStatus, ExpertPanelRequest, ExpertPanelRunExpertState,
        ExpertPanelRunRequest, ExpertPanelRunResponse, ExpertPanelRunStatus, KnowledgeBaseRecord,
        ManagedThread, MemoryNote, MemoryScope, MemorySearchScope, MessageBlockSnapshot,
        ModelAccessConfig, MutationRateLimiter, MutationRateUsage, ProjectRecord, PromptSurface,
        ProviderKind, ResearchTaskStage, ResearchTaskStateRecord, ResolvedDataAccess,
        ResolvedDbAccess, ResolvedDocumentAccess, ResolvedEsAccess, ResolvedWebAccess,
        RunExecutionContext, RunKind, RunRequest, SkillScope, ThreadRecord, ThreadState,
        ThreadStatus, ThreadStore, UpdateProjectRequest, CURRENT_DATABASE_SCHEMA_VERSION,
        MAX_VISIBLE_AUDIT_RECORDS,
    };
    use crate::agent_turns::{
        AgentConversationRecord, AgentConversationStatus, AgentTurnRecord, AgentTurnStatus,
    };
    use crate::{
        create_agent_conversation, create_expert_panel_run, create_thread, post_ag_ui_run,
        AgUiRunRequest, AuthQuery, CreateAgentConversationRequest, CreateThreadRequest,
    };
    use api::InputContentBlock;

    fn test_thread(owner_id: Option<&str>) -> ManagedThread {
        ManagedThread::new(ThreadState {
            record: ThreadRecord {
                id: "thread-test".to_string(),
                tenant_id: None,
                owner_id: owner_id.map(ToString::to_string),
                workspace_root: PathBuf::from("/tmp/project"),
                session_path: PathBuf::from("/tmp/project/.session.jsonl"),
                project_id: None,
                project_name: None,
                knowledge_base_id: None,
                knowledge_base_name: None,
                model: "claude-sonnet-4-6".to_string(),
                model_access: ModelAccessConfig::default(),
                permission_mode: "read-only".to_string(),
                topic: None,
                instructions: None,
                preferred_skill_names: Vec::new(),
                memory_notes: Vec::<MemoryNote>::new(),
                artifacts: Vec::new(),
                created_at_ms: 0,
                updated_at_ms: 0,
                last_status: Some(ThreadStatus::Idle),
                last_error: None,
                next_run_id: 1,
            },
            visible_memory_notes: Vec::new(),
            audit_records: Vec::new(),
            session: Session::new(),
            status: ThreadStatus::Idle,
            last_error: None,
            draft_assistant_text: String::new(),
            next_run_id: 1,
            current_run: None,
            pending_replan: None,
        })
    }

    fn test_thread_for_capacity(
        id: &str,
        tenant_id: Option<&str>,
        owner_id: Option<&str>,
        running: bool,
    ) -> Arc<ManagedThread> {
        let thread = Arc::new(test_thread(owner_id));
        let mut guard = thread
            .shared
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        guard.record.id = id.to_string();
        guard.record.tenant_id = tenant_id.map(ToString::to_string);
        if running {
            guard.current_run = Some(ActiveRun {
                run_id: 1,
                abort_signal: runtime::HookAbortSignal::new(),
                request: RunRequest {
                    kind: RunKind::UserMessage,
                    prompt: "test".to_string(),
                    expert_panel: None,
                    expert_run: None,
                    execution_context: None,
                },
            });
            guard.status = ThreadStatus::Running;
        }
        drop(guard);
        thread
    }

    fn test_temp_dir(label: &str) -> PathBuf {
        let path = std::env::temp_dir().join(format!(
            "clawd-{label}-{}-{}",
            std::process::id(),
            super::generate_id("test"),
        ));
        fs::create_dir_all(&path).expect("create temp dir");
        path
    }

    fn test_config(data_dir: PathBuf) -> AppConfig {
        AppConfig {
            bind_addr: "127.0.0.1:0".to_string(),
            data_dir: data_dir.clone(),
            web_dist_dir: None,
            service_skills_dir: None,
            database_url: default_database_url(&data_dir),
            default_model: "claude-sonnet-4-6".to_string(),
            default_permission_mode: PermissionMode::ReadOnly,
            run_timeout_secs: Some(120),
            max_threads_per_user: Some(200),
            max_threads_per_tenant: Some(2_000),
            max_concurrent_runs_global: Some(16),
            max_concurrent_runs_per_tenant: Some(8),
            max_concurrent_runs_per_user: Some(2),
            max_mutation_requests_per_minute_global: Some(240),
            max_mutation_requests_per_minute_per_tenant: Some(120),
            max_mutation_requests_per_minute_per_user: Some(30),
            dev_user_header_auth_enabled: true,
            platform_admin_users: std::collections::BTreeSet::new(),
            bootstrap_api_keys: Vec::new(),
            allowed_roots: vec![data_dir],
            es: EsConfig::default(),
        }
    }

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
            Query(AuthQuery {
                user_id: Some("alice".to_string()),
                api_key: None,
            }),
            Json(request),
        )
        .await
        .expect("create conversation")
        .0;

        assert_eq!(response.title, "台海供应链风险");
        assert_eq!(response.selected_expert_ids, vec!["howard-wang"]);
    }

    #[tokio::test]
    async fn ag_ui_run_persists_forwarded_tool_citations_inside_turn() {
        let temp_dir = test_temp_dir("ag-ui-forwarded-tool-citations");
        let state = Arc::new(AppState::new(Arc::new(test_config(temp_dir))).expect("state"));
        let conversation = AgentConversationRecord {
            id: "conv-forwarded-tool".to_string(),
            tenant_id: None,
            owner_id: "alice".to_string(),
            title: "检索测试".to_string(),
            status: AgentConversationStatus::Idle,
            selected_knowledge_base_ids: Vec::new(),
            selected_data_source_ids: Vec::new(),
            selected_expert_ids: Vec::new(),
            model_profile_id: None,
            created_at_ms: 10,
            updated_at_ms: 10,
        };
        state
            .store
            .upsert_agent_conversation(&conversation)
            .expect("persist conversation");

        let _response = post_ag_ui_run(
            State(state.clone()),
            HeaderMap::new(),
            Query(AuthQuery {
                user_id: Some("alice".to_string()),
                api_key: None,
            }),
            Json(AgUiRunRequest {
                thread_id: "conv-forwarded-tool".to_string(),
                run_id: "turn-forwarded-tool".to_string(),
                messages: vec![json!({
                    "role": "user",
                    "content": "检索台海供应链"
                })],
                state: Value::Null,
                context: Vec::new(),
                forwarded_props: json!({
                    "selectedDataSourceIds": ["ds-live"],
                    "toolResults": [{
                        "toolCallId": "tool-1",
                        "toolName": "EsSearch",
                        "input": { "query": "台海供应链" },
                        "output": {
                            "hits": [{
                                "title": "供应链报告",
                                "preview": "港口风险上升",
                                "location": "military-index#1"
                            }]
                        }
                    }]
                }),
            }),
        )
        .await
        .expect("post ag ui run");

        let turns = state
            .store
            .list_agent_turns("conv-forwarded-tool", None, "alice")
            .expect("list turns");
        assert_eq!(turns.len(), 1);
        assert_eq!(turns[0].steps[0].label, "资料检索已返回");
        assert_eq!(turns[0].citations[0].number, 1);
        assert_eq!(turns[0].citations[0].title.as_deref(), Some("供应链报告"));

        let conversations = state
            .store
            .list_agent_conversations(None, "alice")
            .expect("list conversations");
        assert_eq!(
            conversations[0].selected_data_source_ids,
            vec!["ds-live".to_string()]
        );
    }

    fn spawn_openai_error_server(status: &str, body: &'static str) -> String {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind listener");
        let address = listener.local_addr().expect("local addr");
        let status = status.to_string();
        thread::spawn(move || {
            let (mut stream, _) = listener.accept().expect("accept connection");
            let mut buffer = [0_u8; 8192];
            let _ = stream.read(&mut buffer).expect("read request");
            let response = format!(
                "HTTP/1.1 {status}\r\ncontent-type: application/json\r\ncontent-length: {}\r\n\r\n{}",
                body.len(),
                body
            );
            stream
                .write_all(response.as_bytes())
                .expect("write response");
        });
        format!("http://{address}/v1")
    }

    fn spawn_openai_capture_server(
        response_body: &'static str,
    ) -> (String, Arc<StdMutex<Vec<Value>>>) {
        let listener = TcpListener::bind("127.0.0.1:0").expect("bind listener");
        let address = listener.local_addr().expect("local addr");
        let captured = Arc::new(StdMutex::new(Vec::new()));
        let captured_for_thread = captured.clone();
        thread::spawn(move || {
            for _ in 0..4 {
                let (mut stream, _) = listener.accept().expect("accept connection");
                let mut buffer = Vec::new();
                let mut chunk = [0_u8; 8192];
                let header_end = loop {
                    let read = stream.read(&mut chunk).expect("read request");
                    if read == 0 {
                        panic!("unexpected eof");
                    }
                    buffer.extend_from_slice(&chunk[..read]);
                    if let Some(position) =
                        buffer.windows(4).position(|window| window == b"\r\n\r\n")
                    {
                        break position + 4;
                    }
                };
                let headers = String::from_utf8_lossy(&buffer[..header_end]);
                let content_length = headers
                    .lines()
                    .find_map(|line| {
                        let (name, value) = line.split_once(':')?;
                        if name.eq_ignore_ascii_case("content-length") {
                            value.trim().parse::<usize>().ok()
                        } else {
                            None
                        }
                    })
                    .unwrap_or(0);
                let mut body = buffer[header_end..].to_vec();
                while body.len() < content_length {
                    let read = stream.read(&mut chunk).expect("read request body");
                    if read == 0 {
                        break;
                    }
                    body.extend_from_slice(&chunk[..read]);
                }
                let request: Value = serde_json::from_slice(&body[..content_length])
                    .expect("parse captured request body");
                captured_for_thread
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .push(request);

                let response = format!(
                    "HTTP/1.1 200 OK\r\ncontent-type: application/json\r\nconnection: close\r\ncontent-length: {}\r\n\r\n{}",
                    response_body.len(),
                    response_body
                );
                stream
                    .write_all(response.as_bytes())
                    .expect("write response");
            }
        });
        (format!("http://{address}/v1"), captured)
    }

    fn test_record(base_dir: &Path, owner_id: Option<&str>) -> ThreadRecord {
        ThreadRecord {
            id: super::generate_id("thread"),
            tenant_id: None,
            owner_id: owner_id.map(ToString::to_string),
            workspace_root: base_dir.join("workspace"),
            session_path: base_dir.join("workspace").join(".session.jsonl"),
            project_id: None,
            project_name: None,
            knowledge_base_id: None,
            knowledge_base_name: None,
            model: "claude-sonnet-4-6".to_string(),
            model_access: ModelAccessConfig::default(),
            permission_mode: "read-only".to_string(),
            topic: Some("repository analysis".to_string()),
            instructions: Some("优先建立模块边界与证据映射。".to_string()),
            preferred_skill_names: vec!["workspace:repo-map".to_string()],
            memory_notes: vec![MemoryNote {
                id: "memory-1".to_string(),
                scope: MemoryScope::Thread,
                note: "remember the main topic".to_string(),
                tags: vec!["topic".to_string()],
                created_at_ms: 1,
            }],
            artifacts: vec![ArtifactRecord {
                id: "artifact-1".to_string(),
                kind: ArtifactKind::Markdown,
                title: Some("analysis summary".to_string()),
                payload: serde_json::json!({
                    "summary": "runtime and tools remain the primary evidence sources"
                }),
                metadata: None,
                created_at_ms: 2,
            }],
            created_at_ms: 1,
            updated_at_ms: 2,
            last_status: Some(ThreadStatus::Idle),
            last_error: None,
            next_run_id: 1,
        }
    }

    fn test_project(base_dir: &Path, owner_id: Option<&str>) -> ProjectRecord {
        ProjectRecord {
            id: super::generate_id("project"),
            tenant_id: None,
            owner_id: owner_id.map(ToString::to_string),
            name: "Repository Research".to_string(),
            description: Some("Shared context for repository analysis".to_string()),
            workspace_root: base_dir.join("workspace"),
            default_topic: Some("分析仓库结构与关键模块".to_string()),
            default_model: Some("claude-sonnet-4-6".to_string()),
            model_access: ModelAccessConfig::default(),
            default_permission_mode: Some("read-only".to_string()),
            starter_prompt: Some("请先阅读仓库资料，再给出结构化结论。".to_string()),
            default_instructions: Some("优先梳理项目边界，再进入细节结论。".to_string()),
            default_skill_names: vec![
                "workspace:repo-map".to_string(),
                "tenant:report".to_string(),
            ],
            created_at_ms: 1,
            updated_at_ms: 2,
        }
    }

    fn test_knowledge_base(base_dir: &Path, owner_id: Option<&str>) -> KnowledgeBaseRecord {
        KnowledgeBaseRecord {
            id: super::generate_id("kb"),
            tenant_id: None,
            owner_id: owner_id.map(ToString::to_string),
            name: "研发资料库".to_string(),
            description: Some("统一沉淀 Web Agent 可检索资料".to_string()),
            default_project_id: None,
            legacy_workspace_root: Some(base_dir.join("workspace")),
            created_at_ms: 1,
            updated_at_ms: 2,
        }
    }

    fn test_data_source(knowledge_base_id: &str, owner_id: Option<&str>) -> DataSourceRecord {
        DataSourceRecord {
            id: super::generate_id("source"),
            knowledge_base_id: knowledge_base_id.to_string(),
            tenant_id: None,
            owner_id: owner_id.map(ToString::to_string),
            name: "本地资料目录".to_string(),
            kind: DataSourceKind::LocalDir,
            description: Some("兼容当前服务器目录接入".to_string()),
            config: serde_json::json!({ "path": "/tmp/project/workspace" }),
            status: Some("ready".to_string()),
            last_test: None,
            last_synced_at_ms: None,
            created_at_ms: 1,
            updated_at_ms: 2,
        }
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

    #[test]
    fn es_search_tool_result_maps_to_public_retrieval_step_and_citation() {
        let input = serde_json::json!({ "query": "台海供应链", "index": "military-index" });
        let output = serde_json::json!({
            "query": "台海供应链",
            "index": "military-index",
            "hits": [
                {
                    "title": "供应链报告",
                    "preview": "港口风险上升",
                    "location": "military-index#1",
                    "score": 0.91
                }
            ]
        })
        .to_string();

        let mapped = map_tool_result_to_agent_updates(
            "tool-1",
            "EsSearch",
            &input.to_string(),
            &output,
            false,
        );

        assert_eq!(mapped.steps[0].label, "资料检索已返回");
        assert_eq!(mapped.citations[0].number, 1);
        assert_eq!(mapped.citations[0].title.as_deref(), Some("供应链报告"));
        assert_eq!(mapped.debug_event.event_type, "TOOL_CALL_RESULT");
    }

    #[test]
    fn source_search_hit_shape_maps_to_readable_citation_fields() {
        let output = serde_json::json!({
            "data_source_name": "个人上传",
            "hits": [{
                "_id": "file-1",
                "_score": 3,
                "_source": {
                    "title": "供应链报告.pdf",
                    "path": "uploads/supply-chain.pdf",
                    "summary": "港口风险上升"
                }
            }]
        })
        .to_string();

        let mapped =
            map_tool_result_to_agent_updates("tool-source", "SourceSearch", "{}", &output, false);

        assert_eq!(mapped.citations[0].source_label, "个人上传");
        assert_eq!(mapped.citations[0].title.as_deref(), Some("供应链报告.pdf"));
        assert_eq!(
            mapped.citations[0].location.as_deref(),
            Some("uploads/supply-chain.pdf")
        );
        assert_eq!(mapped.citations[0].preview, "港口风险上升");
    }

    #[test]
    fn es_search_updates_include_product_payload_fields() {
        let output = serde_json::json!({
            "data_source_name": "Sina Elasticsearch",
            "index": "sina-news",
            "query": "供应链风险",
            "hits": [
                {
                    "title": "供应链风险跟踪",
                    "preview": "企业供应链受到外部冲击",
                    "location": "sina-news#1"
                },
                {
                    "title": "港口物流观察",
                    "preview": "港口拥堵抬升交付风险",
                    "location": "sina-news#2"
                }
            ]
        })
        .to_string();

        let mapped = map_tool_result_to_agent_updates(
            "tool-es",
            "EsSearch",
            r#"{"query":"供应链风险"}"#,
            &output,
            false,
        );

        let payload = mapped.steps[0]
            .public_payload
            .as_object()
            .expect("public payload object");
        assert_eq!(
            payload.get("source_name").and_then(Value::as_str),
            Some("Sina Elasticsearch")
        );
        assert_eq!(
            payload.get("query").and_then(Value::as_str),
            Some("供应链风险")
        );
        assert_eq!(payload.get("hit_count").and_then(Value::as_u64), Some(2));
        assert_eq!(
            payload.get("citation_numbers").and_then(Value::as_array),
            Some(&vec![json!(1), json!(2)])
        );
        assert_eq!(
            payload.get("empty_result").and_then(Value::as_bool),
            Some(false)
        );
        assert_eq!(
            payload.get("result_summary").and_then(Value::as_str),
            Some("命中 2 篇资料，形成 2 条引用")
        );
    }

    #[test]
    fn generic_tool_updates_include_product_summary_payload() {
        let output = serde_json::json!({
            "rows": [
                { "name": "A", "risk": "high" },
                { "name": "B", "risk": "medium" }
            ]
        })
        .to_string();

        let mapped = map_tool_result_to_agent_updates("tool-db", "DbQuery", "{}", &output, false);

        let payload = mapped.steps[0]
            .public_payload
            .as_object()
            .expect("public payload object");
        assert_eq!(
            payload.get("tool_purpose").and_then(Value::as_str),
            Some("DbQuery")
        );
        assert_eq!(
            payload.get("is_error").and_then(Value::as_bool),
            Some(false)
        );
        assert!(payload
            .get("result_summary")
            .and_then(Value::as_str)
            .is_some_and(|summary| summary.contains("执行完成")));
    }

    #[test]
    fn agent_tool_updates_are_renumbered_across_multiple_tool_results() {
        let first = map_tool_result_to_agent_updates(
            "tool-1",
            "EsSearch",
            "{}",
            &serde_json::json!({ "hits": [{ "title": "A", "preview": "A", "location": "a#1" }] })
                .to_string(),
            false,
        );
        let second = map_tool_result_to_agent_updates(
            "tool-2",
            "EsSearch",
            "{}",
            &serde_json::json!({ "hits": [{ "title": "B", "preview": "B", "location": "b#1" }] })
                .to_string(),
            false,
        );

        let updates = renumber_agent_tool_updates(vec![first, second]);

        assert_eq!(updates[0].citations[0].number, 1);
        assert_eq!(updates[1].citations[0].number, 2);
    }

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
        store
            .upsert_agent_conversation(&conversation)
            .expect("save conversation");

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

        assert!(store
            .delete_agent_conversation("conv-1", Some("tenant-a"), "alice")
            .expect("delete conversation"));
        assert!(store
            .list_agent_conversations(Some("tenant-a"), "alice")
            .expect("list conversations after delete")
            .is_empty());
        assert!(store
            .list_agent_turns("conv-1", Some("tenant-a"), "alice")
            .expect("list turns after delete")
            .is_empty());
    }

    fn env_lock() -> std::sync::MutexGuard<'static, ()> {
        static LOCK: OnceLock<StdMutex<()>> = OnceLock::new();
        LOCK.get_or_init(|| StdMutex::new(()))
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
    }

    struct ScopedEnvVar {
        key: &'static str,
        previous: Option<OsString>,
    }

    impl ScopedEnvVar {
        fn set(key: &'static str, value: Option<&str>) -> Self {
            let previous = std::env::var_os(key);
            match value {
                Some(value) => std::env::set_var(key, value),
                None => std::env::remove_var(key),
            }
            Self { key, previous }
        }
    }

    impl Drop for ScopedEnvVar {
        fn drop(&mut self) {
            match &self.previous {
                Some(value) => std::env::set_var(self.key, value),
                None => std::env::remove_var(self.key),
            }
        }
    }

    #[test]
    fn normalize_terms_filters_stopwords() {
        let terms = normalize_terms("This is a focused topic about search and evidence");
        assert!(terms.contains("focused"));
        assert!(terms.contains("search"));
        assert!(!terms.contains("this"));
        assert!(!terms.contains("is"));
    }

    #[test]
    fn artifact_kind_serializes_snake_case() {
        let value = serde_json::to_value(ArtifactKind::Chart).expect("serialize");
        assert_eq!(value, serde_json::json!("chart"));
    }

    #[test]
    fn model_access_base_url_can_select_openai_compat_transport() {
        assert_eq!(
            provider_kind_for_model_access(
                "claude-sonnet-4-6",
                Some("https://models.example.test/v1")
            ),
            ProviderKind::OpenAi
        );
        assert_eq!(
            provider_kind_for_model_access("claude-sonnet-4-6", Some("https://api.anthropic.com")),
            ProviderKind::Anthropic
        );
        assert_eq!(
            provider_kind_for_model_access(
                "openai/gpt-5.4",
                Some("https://models.example.test/v1")
            ),
            ProviderKind::OpenAi
        );
        assert_eq!(
            provider_kind_for_model_access("claude-sonnet-4-6", Some("https://api.x.ai/v1")),
            ProviderKind::Xai
        );
    }

    #[test]
    fn model_access_rewrites_anthropic_default_for_openai_compat_transport() {
        assert_eq!(
            request_model_for_model_access(
                "claude-sonnet-4-6",
                ProviderKind::OpenAi,
                Some("https://models.example.test/v1"),
            ),
            "openai/gpt-4.1-mini"
        );
        assert_eq!(
            request_model_for_model_access(
                "claude-sonnet-4-6",
                ProviderKind::OpenAi,
                Some("https://dashscope.aliyuncs.com/compatible-mode/v1"),
            ),
            "qwen-plus"
        );
        assert_eq!(
            request_model_for_model_access(
                "claude-sonnet-4-6",
                ProviderKind::Xai,
                Some("https://api.x.ai/v1"),
            ),
            "grok-3"
        );
        assert_eq!(
            request_model_for_model_access(
                "openai/gpt-5.4",
                ProviderKind::OpenAi,
                Some("https://models.example.test/v1"),
            ),
            "openai/gpt-5.4"
        );
    }

    #[test]
    fn allowed_tool_names_hides_es_search_when_es_is_not_configured() {
        let temp_dir = test_temp_dir("allowed-tools-no-es");
        let config = test_config(temp_dir.clone());
        let registry = build_tool_registry().expect("tool registry");

        let record = test_record(&temp_dir, Some("alice"));
        let es_access = resolve_es_access(
            &config.es,
            &ResolvedDataAccess {
                data_sources: Vec::new(),
            },
        );
        let allowed = allowed_tool_names(
            &config,
            &registry,
            &record,
            &es_access,
            &ResolvedDocumentAccess::default(),
            &ResolvedWebAccess::default(),
            &ResolvedDbAccess::default(),
        );

        assert!(!allowed.contains("EsSearch"));

        fs::remove_dir_all(temp_dir).expect("cleanup temp dir");
    }

    #[test]
    fn allowed_tool_names_includes_es_search_when_es_is_configured() {
        let temp_dir = test_temp_dir("allowed-tools-with-es");
        let mut config = test_config(temp_dir.clone());
        config.es.base_url = Some("http://127.0.0.1:9200".to_string());
        config.es.default_index = Some("docs".to_string());
        let registry = build_tool_registry().expect("tool registry");

        let mut record = test_record(&temp_dir, Some("alice"));
        record.project_id = Some("project-1".to_string());
        let es_access = resolve_es_access(
            &config.es,
            &ResolvedDataAccess {
                data_sources: Vec::new(),
            },
        );
        let allowed = allowed_tool_names(
            &config,
            &registry,
            &record,
            &es_access,
            &ResolvedDocumentAccess::default(),
            &ResolvedWebAccess::default(),
            &ResolvedDbAccess::default(),
        );

        assert!(allowed.contains("EsSearch"));

        fs::remove_dir_all(temp_dir).expect("cleanup temp dir");
    }

    #[test]
    fn resolve_es_access_prefers_bound_es_data_source() {
        let temp_dir = test_temp_dir("resolve-es-access-data-source");
        let config = test_config(temp_dir.clone());
        let knowledge_base = test_knowledge_base(&temp_dir, Some("alice"));
        let data_access = ResolvedDataAccess {
            data_sources: vec![DataSourceRecord {
                id: "source-es".to_string(),
                knowledge_base_id: knowledge_base.id,
                tenant_id: None,
                owner_id: Some("alice".to_string()),
                name: "主检索索引".to_string(),
                kind: DataSourceKind::Es,
                description: Some("面向资料库的 ES 接入".to_string()),
                config: serde_json::json!({
                    "endpoint": "http://127.0.0.1:9200",
                    "index": "docs",
                    "api_key": "es-key"
                }),
                status: Some("ready".to_string()),
                last_test: None,
                last_synced_at_ms: None,
                created_at_ms: 1,
                updated_at_ms: 2,
            }],
        };

        let resolved = resolve_es_access(&config.es, &data_access);

        assert_eq!(resolved.base_url.as_deref(), Some("http://127.0.0.1:9200"));
        assert_eq!(resolved.default_index.as_deref(), Some("docs"));
        assert_eq!(resolved.api_key.as_deref(), Some("es-key"));
        assert_eq!(resolved.source_id.as_deref(), Some("source-es"));
        assert_eq!(resolved.source_name.as_deref(), Some("主检索索引"));

        fs::remove_dir_all(temp_dir).expect("cleanup temp dir");
    }

    #[test]
    fn allowed_tool_names_includes_es_search_when_bound_data_source_exists() {
        let temp_dir = test_temp_dir("allowed-tools-es-data-source");
        let config = test_config(temp_dir.clone());
        let registry = build_tool_registry().expect("tool registry");
        let knowledge_base = test_knowledge_base(&temp_dir, Some("alice"));
        let mut record = test_record(&temp_dir, Some("alice"));
        record.project_id = Some("project-1".to_string());
        let es_access = resolve_es_access(
            &config.es,
            &ResolvedDataAccess {
                data_sources: vec![DataSourceRecord {
                    id: "source-es".to_string(),
                    knowledge_base_id: knowledge_base.id,
                    tenant_id: None,
                    owner_id: Some("alice".to_string()),
                    name: "资料库检索".to_string(),
                    kind: DataSourceKind::Es,
                    description: None,
                    config: serde_json::json!({
                        "endpoint": "http://127.0.0.1:9200",
                        "index": "docs"
                    }),
                    status: Some("ready".to_string()),
                    last_test: None,
                    last_synced_at_ms: None,
                    created_at_ms: 1,
                    updated_at_ms: 2,
                }],
            },
        );

        let allowed = allowed_tool_names(
            &config,
            &registry,
            &record,
            &es_access,
            &ResolvedDocumentAccess::default(),
            &ResolvedWebAccess::default(),
            &ResolvedDbAccess::default(),
        );

        assert!(allowed.contains("EsSearch"));

        fs::remove_dir_all(temp_dir).expect("cleanup temp dir");
    }

    #[test]
    fn provider_client_uses_anthropic_named_env_for_openai_compatible_responses_proxy() {
        let _lock = env_lock();
        let _openai_key = ScopedEnvVar::set("OPENAI_API_KEY", None);
        let _openai_base = ScopedEnvVar::set("OPENAI_BASE_URL", None);
        let _anthropic_token = ScopedEnvVar::set("ANTHROPIC_AUTH_TOKEN", Some("test-proxy-key"));
        let _anthropic_base = ScopedEnvVar::set(
            "ANTHROPIC_BASE_URL",
            Some("https://proxy.example.test/v1/responses"),
        );

        let mut record = test_record(Path::new("/tmp/project"), None);
        record.model = "gpt-5.4".to_string();
        record.model_access = ModelAccessConfig::default();

        let provider = provider_client_from_record(&record).expect("provider should build");
        match provider {
            api::ProviderClient::OpenAi(client) => {
                assert_eq!(client.base_url(), "https://proxy.example.test/v1/responses");
            }
            other => panic!("expected OpenAI-compatible provider, got {other:?}"),
        }
    }

    #[test]
    fn rewrite_tool_input_scopes_relative_paths_to_workspace() {
        let workspace = Path::new("/tmp/project");
        let rewritten = rewrite_tool_input(
            "read_file",
            serde_json::json!({ "path": "docs/spec.md", "offset": 0 }),
            workspace,
        )
        .expect("rewrite");
        assert_eq!(rewritten["path"], "/tmp/project/docs/spec.md");

        let glob_rewritten = rewrite_tool_input(
            "glob_search",
            serde_json::json!({ "pattern": "*.md" }),
            workspace,
        )
        .expect("rewrite");
        assert_eq!(glob_rewritten["path"], "/tmp/project");
    }

    #[test]
    fn service_skill_resolution_prefers_workspace_before_tenant() {
        let temp_dir = test_temp_dir("service-skills");
        let config = test_config(temp_dir.clone());
        let workspace = temp_dir.join("workspace");
        let workspace_skill_dir = workspace.join(".claw").join("skills").join("analyze");
        let tenant_skill_dir = config.tenant_skills_dir("tenant-a").join("analyze");

        fs::create_dir_all(&workspace_skill_dir).expect("create workspace skill dir");
        fs::create_dir_all(&tenant_skill_dir).expect("create tenant skill dir");
        fs::write(
            workspace_skill_dir.join("SKILL.md"),
            render_skill_prompt(
                "analyze",
                Some("workspace-specific workflow"),
                &[],
                None,
                "Use the repository-local workflow first.",
            ),
        )
        .expect("write workspace skill");
        fs::write(
            tenant_skill_dir.join("SKILL.md"),
            render_skill_prompt(
                "analyze",
                Some("tenant-shared workflow"),
                &[],
                None,
                "Use the tenant-shared workflow.",
            ),
        )
        .expect("write tenant skill");

        let listed = list_service_skills(&config, Some(&workspace), Some("tenant-a"))
            .expect("list service skills");
        assert!(listed.iter().any(|entry| {
            entry.name == "analyze"
                && entry.scope == SkillScope::Workspace
                && entry.description.as_deref() == Some("workspace-specific workflow")
        }));
        assert!(listed.iter().any(|entry| {
            entry.name == "analyze"
                && entry.scope == SkillScope::Tenant
                && entry.description.as_deref() == Some("tenant-shared workflow")
        }));

        let workspace_detail =
            resolve_service_skill(&config, Some(&workspace), Some("tenant-a"), "analyze")
                .expect("resolve default skill");
        assert_eq!(workspace_detail.entry.scope, SkillScope::Workspace);
        assert!(workspace_detail
            .prompt
            .contains("repository-local workflow"));

        let tenant_detail = resolve_service_skill(
            &config,
            Some(&workspace),
            Some("tenant-a"),
            "tenant:analyze",
        )
        .expect("resolve tenant skill");
        assert_eq!(tenant_detail.entry.scope, SkillScope::Tenant);
        assert!(tenant_detail.prompt.contains("tenant-shared workflow"));

        fs::remove_dir_all(temp_dir).expect("cleanup temp dir");
    }

    #[test]
    fn service_skill_parses_tags_and_starter_prompt() {
        let prompt = render_skill_prompt(
            "summarize",
            Some("Summarize evidence"),
            &["evidence".to_string(), "report".to_string()],
            Some("Use the summarize skill to draft an evidence-backed report."),
            "Produce a concise report.",
        );

        assert_eq!(
            parse_skill_tags_from_contents(&prompt),
            vec!["evidence".to_string(), "report".to_string()]
        );
        assert_eq!(
            parse_skill_starter_prompt_from_contents(&prompt).as_deref(),
            Some("Use the summarize skill to draft an evidence-backed report.")
        );
    }

    #[test]
    fn normalize_project_default_skill_names_prefers_workspace_and_dedupes() {
        let temp_dir = test_temp_dir("project-default-skills");
        let config = test_config(temp_dir.clone());
        let workspace = temp_dir.join("workspace");
        let workspace_skill_dir = workspace.join(".claw").join("skills").join("repo-map");
        let tenant_skill_dir = config.tenant_skills_dir("tenant-a").join("repo-map");
        let tenant_report_dir = config.tenant_skills_dir("tenant-a").join("report");

        fs::create_dir_all(&workspace_skill_dir).expect("create workspace skill dir");
        fs::create_dir_all(&tenant_skill_dir).expect("create tenant skill dir");
        fs::create_dir_all(&tenant_report_dir).expect("create tenant report dir");
        fs::write(
            workspace_skill_dir.join("SKILL.md"),
            render_skill_prompt("repo-map", Some("workspace"), &[], None, "workspace"),
        )
        .expect("write workspace skill");
        fs::write(
            tenant_skill_dir.join("SKILL.md"),
            render_skill_prompt("repo-map", Some("tenant"), &[], None, "tenant"),
        )
        .expect("write tenant skill");
        fs::write(
            tenant_report_dir.join("SKILL.md"),
            render_skill_prompt("report", Some("tenant report"), &[], None, "report"),
        )
        .expect("write tenant report skill");

        let normalized = normalize_project_default_skill_names(
            &config,
            &workspace,
            Some("tenant-a"),
            Some(vec![
                "repo-map".to_string(),
                "tenant:report".to_string(),
                "workspace:repo-map".to_string(),
            ]),
        )
        .expect("normalize project skills");

        assert_eq!(
            normalized,
            vec![
                "workspace:repo-map".to_string(),
                "tenant:report".to_string()
            ]
        );

        let error = normalize_project_default_skill_names(
            &config,
            &workspace,
            Some("tenant-a"),
            Some(vec!["tenant:missing".to_string()]),
        )
        .expect_err("unknown skill should fail");
        assert!(error.contains("unknown project default skill"));

        fs::remove_dir_all(temp_dir).expect("cleanup temp dir");
    }

    #[test]
    fn build_system_prompt_includes_thread_instructions_and_preferred_skills() {
        let temp_dir = test_temp_dir("project-prompt");
        let config = test_config(temp_dir.clone());
        let mut record = test_record(&temp_dir, Some("alice"));
        fs::create_dir_all(&record.workspace_root).expect("create workspace");
        record.instructions = Some("先建立模块边界，再沉淀稳定结论。".to_string());
        record.preferred_skill_names = vec![
            "workspace:repo-map".to_string(),
            "tenant:report".to_string(),
        ];
        let prompt = build_system_prompt(
            &config,
            &record,
            &RunRequest {
                kind: RunKind::UserMessage,
                prompt: "分析仓库".to_string(),
                expert_panel: None,
                expert_run: None,
                execution_context: None,
            },
            &ResolvedEsAccess::default(),
            &ResolvedDocumentAccess::default(),
            &ResolvedWebAccess::default(),
            &ResolvedDbAccess::default(),
            PromptSurface::Legacy,
        )
        .expect("build system prompt")
        .join("\n\n");

        assert!(prompt.contains("# Project Instructions"));
        assert!(prompt.contains("先建立模块边界"));
        assert!(prompt.contains("# Preferred Skills"));
        assert!(prompt.contains("workspace:repo-map"));
        assert!(prompt.contains("tenant:report"));

        fs::remove_dir_all(temp_dir).expect("cleanup temp dir");
    }

    #[test]
    fn build_system_prompt_includes_expert_panel_context() {
        let temp_dir = test_temp_dir("expert-panel-prompt");
        let config = test_config(temp_dir.clone());
        let record = test_record(&temp_dir, Some("alice"));
        fs::create_dir_all(&record.workspace_root).expect("create workspace");

        let prompt = build_system_prompt(
            &config,
            &record,
            &RunRequest {
                kind: RunKind::UserMessage,
                prompt: "围绕黄金投资做专家会诊".to_string(),
                expert_panel: Some(ExpertPanelRequest {
                    panel_id: "expert-panel-abcd1234".to_string(),
                    master_skill: "expert-brainstorm".to_string(),
                    experts: vec![
                        ExpertPanelExpert {
                            skill: "mearsheimer".to_string(),
                            scope: SkillScope::Workspace,
                            label: "米尔斯海默".to_string(),
                            description: Some("评估结构性冲突".to_string()),
                        },
                        ExpertPanelExpert {
                            skill: "kissinger".to_string(),
                            scope: SkillScope::Tenant,
                            label: "基辛格".to_string(),
                            description: None,
                        },
                    ],
                }),
                expert_run: None,
                execution_context: None,
            },
            &ResolvedEsAccess::default(),
            &ResolvedDocumentAccess::default(),
            &ResolvedWebAccess::default(),
            &ResolvedDbAccess::default(),
            PromptSurface::Legacy,
        )
        .expect("build system prompt")
        .join("\n\n");

        assert!(prompt.contains("# Expert Panel Context"));
        assert!(prompt.contains("expert-panel-abcd1234"));
        assert!(prompt.contains("expert-brainstorm"));
        assert!(prompt.contains("米尔斯海默（workspace:mearsheimer）"));
        assert!(prompt.contains("基辛格（tenant:kissinger）"));

        fs::remove_dir_all(temp_dir).expect("cleanup temp dir");
    }

    #[test]
    fn normalize_expert_panel_run_request_requires_one_question_or_source_message() {
        let experts = vec![ExpertPanelExpert {
            skill: "mearsheimer".to_string(),
            scope: SkillScope::Workspace,
            label: "米尔斯海默".to_string(),
            description: None,
        }];

        let missing = normalize_expert_panel_run_request(ExpertPanelRunRequest {
            question: None,
            source_message_id: None,
            knowledge_base_id: None,
            data_source_ids: None,
            auto_retrieval: None,
            experts: experts.clone(),
            retry_count: None,
            concurrency_limit: None,
        })
        .expect_err("missing question/source should fail");
        assert!(missing.contains("exactly one"));

        let both = normalize_expert_panel_run_request(ExpertPanelRunRequest {
            question: Some("问题".to_string()),
            source_message_id: Some("msg-1".to_string()),
            knowledge_base_id: None,
            data_source_ids: None,
            auto_retrieval: None,
            experts,
            retry_count: None,
            concurrency_limit: None,
        })
        .expect_err("both question/source should fail");
        assert!(both.contains("exactly one"));
    }

    #[test]
    fn normalize_expert_panel_run_request_deserializes_legacy_payload() {
        let request: ExpertPanelRunRequest = serde_json::from_value(json!({
            "question": "Summarize the situation",
            "experts": [{
                "skill": "mearsheimer",
                "scope": "workspace",
                "label": "米尔斯海默"
            }],
            "retry_count": 2,
            "concurrency_limit": 4
        }))
        .expect("legacy payload should deserialize");

        assert_eq!(request.question.as_deref(), Some("Summarize the situation"));
        assert_eq!(request.source_message_id, None);
        assert_eq!(request.retry_count, Some(2));
        assert_eq!(request.concurrency_limit, Some(4));
    }

    #[test]
    fn normalize_expert_panel_run_request_deserializes_execution_context_payload() {
        let request: ExpertPanelRunRequest = serde_json::from_value(json!({
            "question": "Summarize the situation",
            "knowledge_base_id": "kb-123",
            "auto_retrieval": false,
            "experts": [{
                "skill": "mearsheimer",
                "scope": "workspace",
                "label": "米尔斯海默"
            }]
        }))
        .expect("execution context payload should deserialize");

        assert_eq!(request.question.as_deref(), Some("Summarize the situation"));
        assert_eq!(request.knowledge_base_id.as_deref(), Some("kb-123"));
        assert_eq!(request.auto_retrieval, Some(false));
    }

    #[test]
    fn normalize_expert_panel_run_request_defaults_and_caps_controls() {
        let request = normalize_expert_panel_run_request(ExpertPanelRunRequest {
            question: Some("问题".to_string()),
            source_message_id: None,
            knowledge_base_id: Some("  kb-strategy  ".to_string()),
            data_source_ids: None,
            auto_retrieval: Some(false),
            experts: vec![ExpertPanelExpert {
                skill: "mearsheimer".to_string(),
                scope: SkillScope::Workspace,
                label: "米尔斯海默".to_string(),
                description: None,
            }],
            retry_count: Some(9),
            concurrency_limit: Some(99),
        })
        .expect("valid request");

        assert_eq!(request.retry_count, Some(3));
        assert_eq!(request.concurrency_limit, Some(8));
        assert_eq!(request.knowledge_base_id.as_deref(), Some("kb-strategy"));
        assert_eq!(request.auto_retrieval, Some(false));
    }

    #[test]
    fn snapshots_and_model_input_skip_thinking_blocks() {
        let message = runtime::ConversationMessage::assistant(vec![
            runtime::ContentBlock::Thinking {
                thinking: "private chain of thought".to_string(),
                signature: Some("sig-1".to_string()),
            },
            runtime::ContentBlock::Text {
                text: "visible answer".to_string(),
            },
        ]);

        let snapshot = super::message_snapshot("thread-1", 0, &message);
        assert_eq!(snapshot.id, "thread-1-message-0");
        assert_eq!(snapshot.blocks.len(), 1);
        assert!(matches!(
            &snapshot.blocks[0],
            MessageBlockSnapshot::Text { text } if text == "visible answer"
        ));

        let input = super::convert_messages(&[message]);
        assert_eq!(input.len(), 1);
        assert_eq!(input[0].content.len(), 1);
        assert!(matches!(
            &input[0].content[0],
            InputContentBlock::Text { text } if text == "visible answer"
        ));
    }

    #[test]
    fn source_message_text_resolves_snapshot_message_id() {
        let thread = Arc::new(test_thread(Some("alice")));
        {
            let mut guard = thread
                .shared
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            guard.record.id = "thread-source".to_string();
            guard
                .session
                .push_message(runtime::ConversationMessage::user_text(
                    "需要专家复盘的原始问题",
                ))
                .expect("append source message");
            guard
                .session
                .push_message(runtime::ConversationMessage::assistant(vec![
                    runtime::ContentBlock::Thinking {
                        thinking: "private".to_string(),
                        signature: None,
                    },
                ]))
                .expect("append hidden-only message");
        }

        let snapshot = thread.snapshot();
        assert_eq!(snapshot.messages[0].id, "thread-source-message-0");
        assert_eq!(
            super::resolve_source_message_text(&thread, "thread-source-message-0").as_deref(),
            Some("需要专家复盘的原始问题")
        );
        assert!(super::resolve_source_message_text(&thread, "thread-source-message-1").is_none());
        assert!(super::resolve_source_message_text(&thread, "other-thread-message-0").is_none());
    }

    #[test]
    fn build_system_prompt_keeps_managed_chat_workspace_lightweight() {
        let temp_dir = test_temp_dir("managed-chat-prompt");
        let repo_root = temp_dir.join("repo");
        let managed_root = repo_root
            .join(".clawd")
            .join("managed-workspaces")
            .join("personal")
            .join("alice")
            .join("chat");
        fs::create_dir_all(&managed_root).expect("create managed workspace");
        fs::write(repo_root.join("CLAUDE.md"), "X".repeat(32_000)).expect("write large CLAUDE.md");

        let mut config = test_config(repo_root.clone());
        config.data_dir = repo_root.join(".clawd");
        let mut record = test_record(&managed_root, Some("alice"));
        record.project_id = None;
        record.workspace_root = managed_root;

        let prompt = build_system_prompt(
            &config,
            &record,
            &RunRequest {
                kind: RunKind::UserMessage,
                prompt: "直接聊天".to_string(),
                expert_panel: None,
                expert_run: None,
                execution_context: None,
            },
            &ResolvedEsAccess::default(),
            &ResolvedDocumentAccess::default(),
            &ResolvedWebAccess::default(),
            &ResolvedDbAccess::default(),
            PromptSurface::Legacy,
        )
        .expect("build prompt")
        .join("\n\n");

        assert!(prompt.contains("# Web Agent Contract"));
        assert!(!prompt.contains(&"X".repeat(128)));
        assert!(prompt.len() < 200_000);

        fs::remove_dir_all(temp_dir).expect("cleanup temp dir");
    }

    #[test]
    fn webagent_system_prompt_excludes_local_file_tool_fallbacks() {
        let temp_dir = test_temp_dir("webagent-prompt-no-local-tools");
        let mut config = test_config(temp_dir.clone());
        config.es.base_url = Some("http://127.0.0.1:9200".to_string());
        let mut record = test_record(&temp_dir, Some("alice"));
        record.project_id = None;
        record.workspace_root = config.managed_workspace_root(None, "alice");
        let workspace_skill_dir = record
            .workspace_root
            .join(".claw")
            .join("skills")
            .join("local-only");
        fs::create_dir_all(&workspace_skill_dir).expect("create workspace skill dir");
        fs::write(
            workspace_skill_dir.join("SKILL.md"),
            render_skill_prompt("local-only", Some("local skill"), &[], None, "local"),
        )
        .expect("write workspace skill");

        let prompt = build_system_prompt(
            &config,
            &record,
            &RunRequest {
                kind: RunKind::UserMessage,
                prompt: "检索平台资料".to_string(),
                expert_panel: Some(ExpertPanelRequest {
                    panel_id: "panel-1".to_string(),
                    master_skill: "expert-brainstorm".to_string(),
                    experts: vec![ExpertPanelExpert {
                        label: "Howard-Wang".to_string(),
                        skill: "howard-wang".to_string(),
                        scope: SkillScope::Tenant,
                        description: None,
                    }],
                }),
                expert_run: None,
                execution_context: Some(RunExecutionContext {
                    knowledge_base_id: None,
                    data_source_ids: Some(vec!["source-es".to_string()]),
                    knowledge_base_name: None,
                    auto_retrieval: Some(true),
                }),
            },
            &ResolvedEsAccess {
                base_url: Some("http://127.0.0.1:9200".to_string()),
                api_key: None,
                username: None,
                password: None,
                default_index: Some("docs".to_string()),
                indices: vec!["docs".to_string()],
                source_id: Some("source-es".to_string()),
                source_name: Some("平台 ES".to_string()),
            },
            &ResolvedDocumentAccess::default(),
            &ResolvedWebAccess::default(),
            &ResolvedDbAccess::default(),
            PromptSurface::WebAgent,
        )
        .expect("build prompt")
        .join("\n\n");

        assert!(prompt.contains("Local file-system exploration"));
        assert!(prompt.contains("user memory"));
        assert!(prompt.contains("tenant memory"));
        assert!(prompt.contains("current session memory"));
        assert!(!prompt.contains("scope: \"workspace\""));
        assert!(!prompt.contains("workspace file tools"));
        assert!(!prompt.contains("workspace-scoped skills"));
        assert!(!prompt.contains("prefer the workspace skill"));
        assert!(!prompt.contains("workspace:local-only"));
        assert!(!prompt.contains("workspace:repo-map"));
        assert!(!prompt.contains("generic file-system exploration"));
        assert!(!prompt.contains("read_file"));
        assert!(!prompt.contains("grep_search"));
        assert!(!prompt.contains("glob_search"));

        fs::remove_dir_all(temp_dir).expect("cleanup temp dir");
    }

    #[test]
    fn webagent_skill_execution_rejects_workspace_scoped_skills() {
        let temp_dir = test_temp_dir("webagent-skill-no-workspace");
        let config = test_config(temp_dir.clone());
        let workspace = temp_dir.join("workspace");
        let workspace_skill_dir = workspace.join(".claw").join("skills").join("repo-map");
        let tenant_skill_dir = config.tenant_skills_dir("tenant-a").join("report");
        fs::create_dir_all(&workspace_skill_dir).expect("create workspace skill dir");
        fs::create_dir_all(&tenant_skill_dir).expect("create tenant skill dir");
        fs::write(
            workspace_skill_dir.join("SKILL.md"),
            render_skill_prompt("repo-map", Some("workspace"), &[], None, "workspace"),
        )
        .expect("write workspace skill");
        fs::write(
            tenant_skill_dir.join("SKILL.md"),
            render_skill_prompt("report", Some("tenant report"), &[], None, "tenant"),
        )
        .expect("write tenant skill");

        let thread = Arc::new(test_thread(Some("alice")));
        {
            let mut guard = thread
                .shared
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            guard.record.tenant_id = Some("tenant-a".to_string());
            guard.record.workspace_root = workspace;
        }

        let workspace_error = super::execute_service_skill(
            &config,
            &thread,
            PromptSurface::WebAgent,
            json!({ "skill": "workspace:repo-map" }),
        )
        .expect_err("workspace skill should be rejected");
        assert!(workspace_error
            .to_string()
            .contains("workspace-scoped skills are unavailable"));

        let tenant_output = super::execute_service_skill(
            &config,
            &thread,
            PromptSurface::WebAgent,
            json!({ "skill": "tenant:report" }),
        )
        .expect("tenant skill should load");
        assert!(tenant_output.contains("tenant report"));
        assert!(tenant_output.contains("tenant"));

        fs::remove_dir_all(temp_dir).expect("cleanup temp dir");
    }

    #[test]
    fn execute_artifact_emit_rejects_wrong_panel_metadata_in_expert_mode() {
        let temp_dir = test_temp_dir("expert-panel-artifact-guard");
        let config = Arc::new(test_config(temp_dir.clone()));
        let state = Arc::new(AppState::new(config).expect("create app state"));
        let thread = Arc::new(test_thread(Some("alice")));
        {
            let mut guard = thread
                .shared
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            guard.current_run = Some(ActiveRun {
                run_id: 7,
                abort_signal: runtime::HookAbortSignal::new(),
                request: RunRequest {
                    kind: RunKind::UserMessage,
                    prompt: "专家会诊".to_string(),
                    expert_panel: Some(ExpertPanelRequest {
                        panel_id: "panel-guard".to_string(),
                        master_skill: "expert-brainstorm".to_string(),
                        experts: vec![ExpertPanelExpert {
                            skill: "mearsheimer".to_string(),
                            scope: SkillScope::Workspace,
                            label: "米尔斯海默".to_string(),
                            description: None,
                        }],
                    }),
                    expert_run: None,
                    execution_context: None,
                },
            });
        }

        let error = execute_artifact_emit(
            &state,
            &thread,
            7,
            json!({
                "kind": "markdown",
                "title": "专家视角 / 米尔斯海默",
                "payload": "# test",
                "metadata": {
                    "group": "expert_view",
                    "expert_name": "米尔斯海默",
                    "panel": "wrong-panel"
                }
            }),
        )
        .expect_err("wrong panel should be rejected");

        assert!(error.to_string().contains("metadata.panel mismatch"));

        fs::remove_dir_all(temp_dir).expect("cleanup temp dir");
    }

    #[test]
    fn execute_artifact_emit_rejects_unknown_expert_name_in_expert_mode() {
        let temp_dir = test_temp_dir("expert-panel-expert-guard");
        let config = Arc::new(test_config(temp_dir.clone()));
        let state = Arc::new(AppState::new(config).expect("create app state"));
        let thread = Arc::new(test_thread(Some("alice")));
        {
            let mut guard = thread
                .shared
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            guard.current_run = Some(ActiveRun {
                run_id: 8,
                abort_signal: runtime::HookAbortSignal::new(),
                request: RunRequest {
                    kind: RunKind::UserMessage,
                    prompt: "专家会诊".to_string(),
                    expert_panel: Some(ExpertPanelRequest {
                        panel_id: "panel-guard-2".to_string(),
                        master_skill: "expert-brainstorm".to_string(),
                        experts: vec![ExpertPanelExpert {
                            skill: "mearsheimer".to_string(),
                            scope: SkillScope::Workspace,
                            label: "米尔斯海默".to_string(),
                            description: None,
                        }],
                    }),
                    expert_run: None,
                    execution_context: None,
                },
            });
        }

        let error = execute_artifact_emit(
            &state,
            &thread,
            8,
            json!({
                "kind": "markdown",
                "title": "专家视角 / 基辛格",
                "payload": "# test",
                "metadata": {
                    "group": "expert_view",
                    "expert_name": "基辛格"
                }
            }),
        )
        .expect_err("unknown expert should be rejected");

        assert!(error
            .to_string()
            .contains("metadata.expert_name does not match the current expert panel"));

        fs::remove_dir_all(temp_dir).expect("cleanup temp dir");
    }

    #[test]
    fn execute_artifact_emit_assigns_canonical_stage_defaults_in_expert_mode() {
        let temp_dir = test_temp_dir("expert-panel-stage-defaults");
        let config = Arc::new(test_config(temp_dir.clone()));
        let state = Arc::new(AppState::new(config).expect("create app state"));
        let thread = Arc::new(test_thread(Some("alice")));
        {
            let mut guard = thread
                .shared
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            guard.current_run = Some(ActiveRun {
                run_id: 9,
                abort_signal: runtime::HookAbortSignal::new(),
                request: RunRequest {
                    kind: RunKind::UserMessage,
                    prompt: "专家会诊".to_string(),
                    expert_panel: Some(ExpertPanelRequest {
                        panel_id: "panel-stage-defaults".to_string(),
                        master_skill: "expert-brainstorm".to_string(),
                        experts: vec![ExpertPanelExpert {
                            skill: "mearsheimer".to_string(),
                            scope: SkillScope::Workspace,
                            label: "米尔斯海默".to_string(),
                            description: None,
                        }],
                    }),
                    expert_run: None,
                    execution_context: None,
                },
            });
        }

        let summary_output = execute_artifact_emit(
            &state,
            &thread,
            9,
            json!({
                "kind": "markdown",
                "title": "综合结论",
                "payload": "# test",
                "metadata": {
                    "group": "expert_summary"
                }
            }),
        )
        .expect("summary artifact should be stored");
        let summary_value: Value =
            serde_json::from_str(&summary_output).expect("parse summary output");
        assert_eq!(summary_value["metadata"]["stage"].as_str(), Some("phase_4"));

        let expert_output = execute_artifact_emit(
            &state,
            &thread,
            9,
            json!({
                "kind": "markdown",
                "title": "专家视角 / 米尔斯海默",
                "payload": "# test",
                "metadata": {
                    "group": "expert_view",
                    "expert_name": "米尔斯海默",
                    "stage": "independent"
                }
            }),
        )
        .expect("expert artifact should be stored");
        let expert_value: Value =
            serde_json::from_str(&expert_output).expect("parse expert output");
        assert_eq!(expert_value["metadata"]["stage"].as_str(), Some("phase_1"));

        fs::remove_dir_all(temp_dir).expect("cleanup temp dir");
    }

    #[test]
    fn execute_expert_panel_emit_canonicalizes_stage_aliases() {
        let temp_dir = test_temp_dir("expert-panel-emit-stage");
        let config = Arc::new(test_config(temp_dir.clone()));
        let state = Arc::new(AppState::new(config).expect("create app state"));
        let thread = Arc::new(test_thread(Some("alice")));
        {
            let mut guard = thread
                .shared
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            guard.current_run = Some(ActiveRun {
                run_id: 10,
                abort_signal: runtime::HookAbortSignal::new(),
                request: RunRequest {
                    kind: RunKind::UserMessage,
                    prompt: "专家会诊".to_string(),
                    expert_panel: Some(ExpertPanelRequest {
                        panel_id: "panel-emit-stage".to_string(),
                        master_skill: "expert-brainstorm".to_string(),
                        experts: vec![ExpertPanelExpert {
                            skill: "mearsheimer".to_string(),
                            scope: SkillScope::Workspace,
                            label: "米尔斯海默".to_string(),
                            description: None,
                        }],
                    }),
                    expert_run: None,
                    execution_context: None,
                },
            });
        }

        let output = execute_expert_panel_emit(
            &state,
            &thread,
            10,
            json!({
                "panel_id": "panel-emit-stage",
                "expert_name": "米尔斯海默",
                "stage": "final",
                "summary": "已完成",
                "status": "completed"
            }),
        )
        .expect("emit should succeed");
        let value: Value = serde_json::from_str(&output).expect("parse emit output");
        assert_eq!(value["payload"]["stage"].as_str(), Some("phase_4"));

        fs::remove_dir_all(temp_dir).expect("cleanup temp dir");
    }

    #[test]
    fn apply_project_update_updates_and_clears_defaults() {
        let temp_dir = test_temp_dir("project-update");
        let config = test_config(temp_dir.clone());
        let workspace = temp_dir.join("workspace");
        let workspace_skill_dir = workspace.join(".claw").join("skills").join("repo-map");
        let tenant_report_dir = config.tenant_skills_dir("tenant-a").join("report");
        let mut project = test_project(&temp_dir, Some("alice"));
        project.tenant_id = Some("tenant-a".to_string());
        project.workspace_root = workspace.clone();

        fs::create_dir_all(&workspace_skill_dir).expect("create workspace skill dir");
        fs::create_dir_all(&tenant_report_dir).expect("create tenant skill dir");
        fs::write(
            workspace_skill_dir.join("SKILL.md"),
            render_skill_prompt("repo-map", Some("workspace"), &[], None, "workspace"),
        )
        .expect("write workspace skill");
        fs::write(
            tenant_report_dir.join("SKILL.md"),
            render_skill_prompt("report", Some("tenant report"), &[], None, "report"),
        )
        .expect("write tenant skill");

        apply_project_update(
            &config,
            &mut project,
            Some("tenant-a"),
            UpdateProjectRequest {
                name: Some("  Research Desk  ".to_string()),
                description: Some("   ".to_string()),
                default_topic: Some("   ".to_string()),
                default_model: Some("  gpt-5.4  ".to_string()),
                model_base_url: Some("  https://models.example.test/v1  ".to_string()),
                model_base_url_env: Some("   ".to_string()),
                model_api_key: Some("  project-secret  ".to_string()),
                model_api_key_env: Some("PROJECT_MODEL_API_KEY".to_string()),
                default_permission_mode: Some("workspace-write".to_string()),
                starter_prompt: Some("\n".to_string()),
                default_instructions: Some("  聚焦证据后再形成结论。  ".to_string()),
                default_skill_names: Some(vec![
                    "repo-map".to_string(),
                    "tenant:report".to_string(),
                    "workspace:repo-map".to_string(),
                ]),
            },
        )
        .expect("apply project update");

        assert_eq!(project.name, "Research Desk");
        assert_eq!(project.description, None);
        assert_eq!(project.default_topic, None);
        assert_eq!(project.default_model.as_deref(), Some("gpt-5.4"));
        assert_eq!(
            project.model_access.base_url.as_deref(),
            Some("https://models.example.test/v1")
        );
        assert_eq!(project.model_access.base_url_env, None);
        assert_eq!(
            project.model_access.api_key.as_deref(),
            Some("project-secret")
        );
        assert_eq!(
            project.model_access.api_key_env.as_deref(),
            Some("PROJECT_MODEL_API_KEY")
        );
        assert_eq!(
            project.default_permission_mode.as_deref(),
            Some("workspace-write")
        );
        assert_eq!(project.starter_prompt, None);
        assert_eq!(
            project.default_instructions.as_deref(),
            Some("聚焦证据后再形成结论。")
        );
        assert_eq!(
            project.default_skill_names,
            vec![
                "workspace:repo-map".to_string(),
                "tenant:report".to_string()
            ]
        );

        fs::remove_dir_all(temp_dir).expect("cleanup temp dir");
    }

    #[test]
    fn apply_project_update_rejects_blank_name() {
        let temp_dir = test_temp_dir("project-update-invalid");
        let config = test_config(temp_dir.clone());
        let mut project = test_project(&temp_dir, Some("alice"));

        let error = apply_project_update(
            &config,
            &mut project,
            None,
            UpdateProjectRequest {
                name: Some("   ".to_string()),
                ..UpdateProjectRequest::default()
            },
        )
        .expect_err("blank names should fail");

        assert!(error.contains("project name must not be empty"));

        fs::remove_dir_all(temp_dir).expect("cleanup temp dir");
    }

    #[test]
    fn delete_service_skill_file_removes_saved_skill_dir() {
        let temp_dir = test_temp_dir("delete-service-skill");
        let skill_path = temp_dir
            .join(".claw")
            .join("skills")
            .join("scan")
            .join("SKILL.md");
        fs::create_dir_all(skill_path.parent().expect("skill parent")).expect("create skill dir");
        fs::write(&skill_path, "body").expect("write skill");

        delete_service_skill_file(&skill_path).expect("delete service skill");

        assert!(!skill_path.exists());
        assert!(!skill_path
            .parent()
            .expect("skill parent after delete")
            .exists());

        fs::remove_dir_all(temp_dir).expect("cleanup temp dir");
    }

    #[test]
    fn discover_allowed_roots_prefers_repo_root_when_inside_nested_dir() {
        let repo_root = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .parent()
            .and_then(Path::parent)
            .and_then(Path::parent)
            .expect("workspace root")
            .to_path_buf();
        let nested = repo_root.join("rust");

        let roots = discover_allowed_roots(&nested);

        assert_eq!(roots.first(), Some(&repo_root));
        assert!(roots.iter().any(|root| root == &nested));
    }

    #[test]
    fn parse_run_timeout_accepts_disable_and_positive_values() {
        assert_eq!(parse_run_timeout_secs("0").expect("parse"), None);
        assert_eq!(parse_run_timeout_secs("45").expect("parse"), Some(45));
    }

    #[test]
    fn parse_limit_env_accepts_zero_as_disabled() {
        assert_eq!(
            parse_limit_env("CLAWD_MAX_CONCURRENT_RUNS_GLOBAL", "0").expect("parse"),
            None
        );
        assert_eq!(
            parse_limit_env("CLAWD_MAX_CONCURRENT_RUNS_GLOBAL", "12").expect("parse"),
            Some(12)
        );
    }

    #[test]
    fn mutation_user_scope_key_includes_tenant_when_present() {
        assert_eq!(
            mutation_user_scope_key(Some("tenant-a"), "alice"),
            "tenant-a:alice"
        );
        assert_eq!(mutation_user_scope_key(None, "alice"), "dev:alice");
    }

    #[test]
    fn parse_user_id_rejects_blank_values() {
        assert!(parse_user_id("   ").is_err());
        assert_eq!(parse_user_id("team-a").expect("parse"), "team-a");
    }

    #[test]
    fn parse_bootstrap_api_keys_accepts_multiple_specs() {
        let keys = parse_bootstrap_api_keys("tenant-a:alice:key-1:Alice;tenant-b:bob:key-2")
            .expect("parse bootstrap keys");
        assert_eq!(keys.len(), 2);
        assert_eq!(keys[0].tenant_id, "tenant-a");
        assert_eq!(keys[0].user_id, "alice");
        assert_eq!(keys[0].display_name.as_deref(), Some("Alice"));
        assert_eq!(keys[1].tenant_id, "tenant-b");
        assert_eq!(keys[1].user_id, "bob");
        assert_eq!(keys[1].display_name, None);
    }

    #[test]
    fn thread_visibility_requires_matching_tenant_and_owner() {
        let owned = std::sync::Arc::new(test_thread(Some("alice")));
        {
            let mut guard = owned
                .shared
                .lock()
                .unwrap_or_else(std::sync::PoisonError::into_inner);
            guard.record.tenant_id = Some("tenant-a".to_string());
        }

        let matching = AuthContext {
            auth_mode: AuthMode::ApiKey,
            tenant_id: Some("tenant-a".to_string()),
            user_id: "alice".to_string(),
            api_key_id: Some("api-key-1".to_string()),
            api_key_prefix: Some("clawd123".to_string()),
            display_name: Some("Alice".to_string()),
        };
        let wrong_tenant = AuthContext {
            tenant_id: Some("tenant-b".to_string()),
            ..matching.clone()
        };
        let wrong_user = AuthContext {
            user_id: "bob".to_string(),
            ..matching.clone()
        };
        let dev_header = AuthContext {
            auth_mode: AuthMode::DevUserHeader,
            tenant_id: None,
            user_id: "alice".to_string(),
            api_key_id: None,
            api_key_prefix: None,
            display_name: None,
        };

        assert!(thread_is_visible_to_auth(&owned, &matching));
        assert!(!thread_is_visible_to_auth(&owned, &wrong_tenant));
        assert!(!thread_is_visible_to_auth(&owned, &wrong_user));
        assert!(!thread_is_visible_to_auth(&owned, &dev_header));
    }

    #[test]
    fn collect_capacity_usage_counts_threads_and_running_scopes() {
        let threads = vec![
            test_thread_for_capacity("thread-a", Some("tenant-a"), Some("alice"), true),
            test_thread_for_capacity("thread-b", Some("tenant-a"), Some("alice"), false),
            test_thread_for_capacity("thread-c", Some("tenant-a"), Some("bob"), true),
            test_thread_for_capacity("thread-d", Some("tenant-b"), Some("alice"), true),
            test_thread_for_capacity("thread-e", None, Some("alice"), true),
        ];

        let usage = collect_capacity_usage(threads.iter(), Some("tenant-a"), "alice");
        assert_eq!(
            usage,
            CapacityUsage {
                tenant_threads: 3,
                user_threads: 2,
                active_runs_global: 4,
                active_runs_tenant: 2,
                active_runs_user: 1,
            }
        );
    }

    #[test]
    fn capacity_checks_reject_when_limits_are_reached() {
        let mut config = test_config(test_temp_dir("capacity-config"));
        config.max_threads_per_tenant = Some(3);
        config.max_threads_per_user = Some(2);
        config.max_concurrent_runs_global = Some(4);
        config.max_concurrent_runs_per_tenant = Some(2);
        config.max_concurrent_runs_per_user = Some(1);

        let usage = CapacityUsage {
            tenant_threads: 3,
            user_threads: 2,
            active_runs_global: 4,
            active_runs_tenant: 2,
            active_runs_user: 1,
        };

        assert_eq!(
            ensure_thread_capacity(&config, &usage).expect_err("tenant thread rejection"),
            "tenant thread limit reached (3/3)"
        );

        config.max_threads_per_tenant = Some(10);
        assert_eq!(
            ensure_thread_capacity(&config, &usage).expect_err("user thread rejection"),
            "user thread limit reached (2/2)"
        );

        assert_eq!(
            ensure_run_capacity(&config, &usage).expect_err("global run rejection"),
            "global concurrent run limit reached (4/4)"
        );

        config.max_concurrent_runs_global = Some(10);
        assert_eq!(
            ensure_run_capacity(&config, &usage).expect_err("tenant run rejection"),
            "tenant concurrent run limit reached (2/2)"
        );

        config.max_concurrent_runs_per_tenant = Some(10);
        assert_eq!(
            ensure_run_capacity(&config, &usage).expect_err("user run rejection"),
            "user concurrent run limit reached (1/1)"
        );

        std::fs::remove_dir_all(config.data_dir).expect("cleanup temp dir");
    }

    #[test]
    fn mutation_rate_limiter_tracks_scopes_per_minute() {
        let mut limiter = MutationRateLimiter::default();

        let usage = limiter.peek_usage(60_000, Some("tenant-a"), "alice");
        assert_eq!(
            usage,
            MutationRateUsage {
                global_requests: 0,
                tenant_requests: 0,
                user_requests: 0,
            }
        );

        let usage = limiter.record(60_000, Some("tenant-a"), "alice");
        assert_eq!(
            usage,
            MutationRateUsage {
                global_requests: 1,
                tenant_requests: 1,
                user_requests: 1,
            }
        );

        let usage = limiter.record(60_500, Some("tenant-a"), "alice");
        assert_eq!(
            usage,
            MutationRateUsage {
                global_requests: 2,
                tenant_requests: 2,
                user_requests: 2,
            }
        );

        let usage = limiter.record(120_000, Some("tenant-a"), "alice");
        assert_eq!(
            usage,
            MutationRateUsage {
                global_requests: 1,
                tenant_requests: 1,
                user_requests: 1,
            }
        );
    }

    #[test]
    fn mutation_rate_limits_reject_when_current_minute_is_full() {
        let mut config = test_config(test_temp_dir("mutation-rate"));
        config.max_mutation_requests_per_minute_global = Some(5);
        config.max_mutation_requests_per_minute_per_tenant = Some(3);
        config.max_mutation_requests_per_minute_per_user = Some(2);

        let usage = MutationRateUsage {
            global_requests: 5,
            tenant_requests: 3,
            user_requests: 2,
        };

        assert_eq!(
            ensure_mutation_rate_limit(&config, &usage).expect_err("global rate rejection"),
            "global mutation rate limit reached (5/5) in the current minute"
        );

        config.max_mutation_requests_per_minute_global = Some(10);
        assert_eq!(
            ensure_mutation_rate_limit(&config, &usage).expect_err("tenant rate rejection"),
            "tenant mutation rate limit reached (3/3) in the current minute"
        );

        config.max_mutation_requests_per_minute_per_tenant = Some(10);
        assert_eq!(
            ensure_mutation_rate_limit(&config, &usage).expect_err("user rate rejection"),
            "user mutation rate limit reached (2/2) in the current minute"
        );

        std::fs::remove_dir_all(config.data_dir).expect("cleanup temp dir");
    }

    #[test]
    fn sqlite_store_authenticates_api_keys() {
        let temp_dir = test_temp_dir("sqlite-auth");
        let config = test_config(temp_dir.clone());
        let store = ThreadStore::open(&config).expect("open sqlite store");

        let raw_key = "clawd-demo-secret";
        store
            .upsert_api_key(&super::ApiKeyRecord {
                id: "api-key-1".to_string(),
                tenant_id: "tenant-a".to_string(),
                user_id: "alice".to_string(),
                display_name: Some("Alice".to_string()),
                key_prefix: "clawd-de".to_string(),
                key_hash: super::hash_api_key(raw_key),
                created_at_ms: 1,
                updated_at_ms: 1,
                last_used_at_ms: None,
                disabled_at_ms: None,
            })
            .expect("seed api key");

        let record = store
            .authenticate_api_key(raw_key)
            .expect("authenticate")
            .expect("matching key");
        assert_eq!(record.tenant_id, "tenant-a");
        assert_eq!(record.user_id, "alice");
        assert_eq!(record.key_prefix, "clawd-de");
        assert!(record.last_used_at_ms.is_some());
        assert!(store
            .authenticate_api_key("clawd-wrong-secret")
            .expect("authenticate missing")
            .is_none());

        fs::remove_dir_all(temp_dir).expect("cleanup temp dir");
    }

    #[test]
    fn sqlite_store_lists_and_disables_api_keys_by_tenant_and_user() {
        let temp_dir = test_temp_dir("sqlite-api-key-lifecycle");
        let config = test_config(temp_dir.clone());
        let store = ThreadStore::open(&config).expect("open sqlite store");

        let records = [
            super::ApiKeyRecord {
                id: "api-key-1".to_string(),
                tenant_id: "tenant-a".to_string(),
                user_id: "alice".to_string(),
                display_name: Some("Laptop".to_string()),
                key_prefix: "key-alic".to_string(),
                key_hash: super::hash_api_key("key-alice-1"),
                created_at_ms: 10,
                updated_at_ms: 10,
                last_used_at_ms: None,
                disabled_at_ms: None,
            },
            super::ApiKeyRecord {
                id: "api-key-2".to_string(),
                tenant_id: "tenant-a".to_string(),
                user_id: "alice".to_string(),
                display_name: Some("Old Laptop".to_string()),
                key_prefix: "key-old-".to_string(),
                key_hash: super::hash_api_key("key-alice-2"),
                created_at_ms: 20,
                updated_at_ms: 20,
                last_used_at_ms: Some(25),
                disabled_at_ms: Some(30),
            },
            super::ApiKeyRecord {
                id: "api-key-3".to_string(),
                tenant_id: "tenant-a".to_string(),
                user_id: "alice".to_string(),
                display_name: Some("Browser".to_string()),
                key_prefix: "key-brow".to_string(),
                key_hash: super::hash_api_key("key-alice-3"),
                created_at_ms: 40,
                updated_at_ms: 40,
                last_used_at_ms: None,
                disabled_at_ms: None,
            },
            super::ApiKeyRecord {
                id: "api-key-4".to_string(),
                tenant_id: "tenant-a".to_string(),
                user_id: "bob".to_string(),
                display_name: Some("Bob".to_string()),
                key_prefix: "key-bob-".to_string(),
                key_hash: super::hash_api_key("key-bob-1"),
                created_at_ms: 50,
                updated_at_ms: 50,
                last_used_at_ms: None,
                disabled_at_ms: None,
            },
            super::ApiKeyRecord {
                id: "api-key-5".to_string(),
                tenant_id: "tenant-b".to_string(),
                user_id: "alice".to_string(),
                display_name: Some("Other Tenant".to_string()),
                key_prefix: "key-oth-".to_string(),
                key_hash: super::hash_api_key("key-tenant-b"),
                created_at_ms: 60,
                updated_at_ms: 60,
                last_used_at_ms: None,
                disabled_at_ms: None,
            },
        ];

        for record in records {
            store.upsert_api_key(&record).expect("seed api key");
        }

        let listed = store
            .list_api_keys("tenant-a", "alice")
            .expect("list api keys");
        let listed_ids = listed
            .iter()
            .map(|record| record.id.as_str())
            .collect::<Vec<_>>();
        assert_eq!(listed_ids, vec!["api-key-3", "api-key-2", "api-key-1"]);
        assert_eq!(listed[1].disabled_at_ms, Some(30));

        assert!(store
            .disable_api_key("api-key-1", "tenant-a", "alice")
            .expect("disable api key"));
        assert!(!store
            .disable_api_key("api-key-1", "tenant-a", "alice")
            .expect("disable already disabled api key"));
        assert!(!store
            .disable_api_key("api-key-4", "tenant-a", "alice")
            .expect("disable other user's api key"));
        assert!(store
            .authenticate_api_key("key-alice-1")
            .expect("authenticate disabled key")
            .is_none());

        let disabled_record = store
            .list_api_keys("tenant-a", "alice")
            .expect("reload api keys")
            .into_iter()
            .find(|record| record.id == "api-key-1")
            .expect("find disabled api key");
        assert!(disabled_record.disabled_at_ms.is_some());

        fs::remove_dir_all(temp_dir).expect("cleanup temp dir");
    }

    #[test]
    fn sqlite_store_round_trips_thread_state() {
        let temp_dir = test_temp_dir("sqlite-store");
        let config = test_config(temp_dir.clone());
        let store = ThreadStore::open(&config).expect("open sqlite store");
        let record = test_record(&temp_dir, Some("alice"));
        fs::create_dir_all(&record.workspace_root).expect("create workspace");

        let session = Session::new()
            .with_workspace_root(record.workspace_root.clone())
            .with_persistence_path(record.session_path.clone());
        let thread = Arc::new(ManagedThread::new(ThreadState {
            record: record.clone(),
            visible_memory_notes: record.memory_notes.clone(),
            audit_records: Vec::new(),
            session,
            status: ThreadStatus::Idle,
            last_error: None,
            draft_assistant_text: String::new(),
            next_run_id: 1,
            current_run: None,
            pending_replan: None,
        }));

        persist_thread_state(&thread, &store).expect("persist thread");

        let loaded_threads = load_threads(&store).expect("load threads");
        assert_eq!(loaded_threads.len(), 1);
        let snapshot = loaded_threads[0].snapshot();
        assert_eq!(snapshot.id, record.id);
        assert_eq!(snapshot.topic.as_deref(), Some("repository analysis"));
        assert_eq!(snapshot.memory_notes.len(), 1);
        assert_eq!(snapshot.artifacts.len(), 1);
        assert_eq!(
            snapshot.session_path,
            record.session_path.display().to_string()
        );
        assert_eq!(store.schema_version(), CURRENT_DATABASE_SCHEMA_VERSION);

        fs::remove_dir_all(temp_dir).expect("cleanup temp dir");
    }

    #[test]
    fn sqlite_store_round_trips_projects() {
        let temp_dir = test_temp_dir("sqlite-projects");
        let config = test_config(temp_dir.clone());
        let store = ThreadStore::open(&config).expect("open sqlite store");
        let project = test_project(&temp_dir, Some("alice"));
        fs::create_dir_all(&project.workspace_root).expect("create project workspace");

        store.upsert_project(&project).expect("persist project");

        let loaded = store.load_projects().expect("load projects");
        assert_eq!(loaded.len(), 1);
        assert_eq!(loaded[0].id, project.id);
        assert_eq!(loaded[0].name, "Repository Research");
        assert_eq!(
            loaded[0].default_topic.as_deref(),
            Some("分析仓库结构与关键模块")
        );
        assert_eq!(
            loaded[0].starter_prompt.as_deref(),
            Some("请先阅读仓库资料，再给出结构化结论。")
        );
        assert_eq!(
            loaded[0].default_instructions.as_deref(),
            Some("优先梳理项目边界，再进入细节结论。")
        );
        assert_eq!(
            loaded[0].default_skill_names,
            vec![
                "workspace:repo-map".to_string(),
                "tenant:report".to_string()
            ]
        );
        assert_eq!(
            store
                .get_project(&project.id)
                .expect("get project")
                .expect("existing project")
                .workspace_root,
            project.workspace_root
        );

        fs::remove_dir_all(temp_dir).expect("cleanup temp dir");
    }

    #[test]
    fn sqlite_store_round_trips_knowledge_bases_and_data_sources() {
        let temp_dir = test_temp_dir("sqlite-knowledge-bases");
        let config = test_config(temp_dir.clone());
        let store = ThreadStore::open(&config).expect("open sqlite store");
        let knowledge_base = test_knowledge_base(&temp_dir, Some("alice"));
        let data_source = test_data_source(&knowledge_base.id, Some("alice"));

        store
            .upsert_knowledge_base(&knowledge_base)
            .expect("persist knowledge base");
        store
            .upsert_data_source(&data_source)
            .expect("persist data source");

        let loaded_knowledge_bases = store.load_knowledge_bases().expect("load knowledge bases");
        assert_eq!(loaded_knowledge_bases.len(), 1);
        assert_eq!(loaded_knowledge_bases[0].id, knowledge_base.id);
        assert_eq!(loaded_knowledge_bases[0].name, "研发资料库");
        assert_eq!(
            loaded_knowledge_bases[0]
                .legacy_workspace_root
                .as_ref()
                .expect("legacy workspace root"),
            &temp_dir.join("workspace")
        );

        let loaded_data_sources = store.load_data_sources().expect("load data sources");
        assert_eq!(loaded_data_sources.len(), 1);
        assert_eq!(loaded_data_sources[0].knowledge_base_id, knowledge_base.id);
        assert_eq!(loaded_data_sources[0].kind, DataSourceKind::LocalDir);
        assert_eq!(loaded_data_sources[0].status.as_deref(), Some("ready"));

        assert_eq!(
            store
                .get_knowledge_base(&knowledge_base.id)
                .expect("get knowledge base")
                .expect("existing knowledge base")
                .name,
            "研发资料库"
        );

        fs::remove_dir_all(temp_dir).expect("cleanup temp dir");
    }

    #[tokio::test]
    async fn create_thread_uses_project_workspace_without_workspace_root_payload() {
        let temp_dir = test_temp_dir("create-thread-project-only");
        let config = Arc::new(test_config(temp_dir.clone()));
        let project = test_project(&temp_dir, Some("alice"));
        fs::create_dir_all(&project.workspace_root).expect("create project workspace");

        let state = Arc::new(AppState::new(config).expect("create app state"));
        state
            .store
            .upsert_project(&project)
            .expect("persist project");

        let mut headers = HeaderMap::new();
        headers.insert("x-clawd-user-id", "alice".parse().expect("user id header"));

        let response = create_thread(
            State(state.clone()),
            headers,
            Query(AuthQuery::default()),
            Json(CreateThreadRequest {
                workspace_root: None,
                project_id: Some(project.id.clone()),
                knowledge_base_id: None,
                model: None,
                model_base_url: None,
                model_api_key: None,
                permission_mode: None,
                topic: Some("project scoped thread".to_string()),
            }),
        )
        .await
        .expect("create thread from project");

        let snapshot = response.0;
        assert_eq!(snapshot.project_id.as_deref(), Some(project.id.as_str()));
        assert_eq!(
            snapshot.project_name.as_deref(),
            Some(project.name.as_str())
        );
        assert_eq!(
            snapshot.workspace_root,
            project.workspace_root.display().to_string()
        );
        assert_eq!(snapshot.topic.as_deref(), Some("project scoped thread"));

        fs::remove_dir_all(temp_dir).expect("cleanup temp dir");
    }

    #[tokio::test]
    async fn create_thread_allows_pure_chat_without_project_or_workspace_root() {
        let temp_dir = test_temp_dir("create-thread-managed-workspace");
        let config = Arc::new(test_config(temp_dir.clone()));
        let state = Arc::new(AppState::new(config.clone()).expect("create app state"));

        let mut headers = HeaderMap::new();
        headers.insert("x-clawd-user-id", "alice".parse().expect("user id header"));

        let response = create_thread(
            State(state.clone()),
            headers,
            Query(AuthQuery::default()),
            Json(CreateThreadRequest {
                workspace_root: None,
                project_id: None,
                knowledge_base_id: None,
                model: None,
                model_base_url: None,
                model_api_key: None,
                permission_mode: None,
                topic: Some("纯聊天模式".to_string()),
            }),
        )
        .await
        .expect("create managed chat thread");

        let snapshot = response.0;
        assert!(snapshot.project_id.is_none());
        assert!(snapshot.workspace_root.contains("managed-workspaces"));
        assert!(Path::new(&snapshot.workspace_root).exists());
        assert_eq!(snapshot.topic.as_deref(), Some("纯聊天模式"));

        fs::remove_dir_all(temp_dir).expect("cleanup temp dir");
    }

    #[test]
    fn allowed_tool_names_hides_file_and_es_tools_for_managed_chat_workspace() {
        let temp_dir = test_temp_dir("allowed-tools-managed-chat");
        let mut config = test_config(temp_dir.clone());
        config.es.base_url = Some("http://127.0.0.1:9200".to_string());
        let registry = build_tool_registry().expect("tool registry");
        let mut record = test_record(&temp_dir, Some("alice"));
        record.workspace_root = config.managed_workspace_root(None, "alice");

        let es_access = resolve_es_access(
            &config.es,
            &ResolvedDataAccess {
                data_sources: Vec::new(),
            },
        );
        let allowed = allowed_tool_names(
            &config,
            &registry,
            &record,
            &es_access,
            &ResolvedDocumentAccess::default(),
            &ResolvedWebAccess::default(),
            &ResolvedDbAccess::default(),
        );

        assert!(!allowed.contains("read_file"));
        assert!(!allowed.contains("glob_search"));
        assert!(!allowed.contains("grep_search"));
        assert!(!allowed.contains("EsSearch"));
        assert!(allowed.contains("MemoryWrite"));
        assert!(allowed.contains("MemorySearch"));
        assert!(allowed.contains("TopicDriftCheck"));
        assert!(allowed.contains("ArtifactEmit"));

        fs::remove_dir_all(temp_dir).expect("cleanup temp dir");
    }

    #[test]
    fn allowed_tool_names_enables_selected_webagent_data_sources_without_workspace_tools() {
        let temp_dir = test_temp_dir("allowed-tools-webagent-selected-sources");
        let mut config = test_config(temp_dir.clone());
        config.es.base_url = Some("http://127.0.0.1:9200".to_string());
        let registry = build_tool_registry().expect("tool registry");
        let mut record = test_record(&temp_dir, Some("alice"));
        record.workspace_root = config.managed_workspace_root(None, "alice");

        let allowed = allowed_tool_names(
            &config,
            &registry,
            &record,
            &ResolvedEsAccess {
                base_url: Some("http://127.0.0.1:9200".to_string()),
                api_key: None,
                username: None,
                password: None,
                default_index: Some("docs".to_string()),
                indices: vec!["docs".to_string()],
                source_id: Some("source-es".to_string()),
                source_name: Some("平台 ES".to_string()),
            },
            &ResolvedDocumentAccess {
                source_id: Some("source-upload".to_string()),
                source_name: Some("个人上传".to_string()),
                files: vec![DocumentFileRecord {
                    id: "file-1".to_string(),
                    file_name: "report.txt".to_string(),
                    stored_name: "report.txt".to_string(),
                    relative_path: "uploads/report.txt".to_string(),
                    mime_type: Some("text/plain".to_string()),
                    size_bytes: 16,
                    extracted_text: "台海供应链".to_string(),
                    uploaded_at_ms: 1,
                }],
            },
            &ResolvedWebAccess::default(),
            &ResolvedDbAccess::default(),
        );

        assert!(allowed.contains("EsSearch"));
        assert!(allowed.contains("SourceSearch"));
        assert!(allowed.contains("SourceRead"));
        assert!(!allowed.contains("read_file"));
        assert!(!allowed.contains("glob_search"));
        assert!(!allowed.contains("grep_search"));

        fs::remove_dir_all(temp_dir).expect("cleanup temp dir");
    }

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

    #[tokio::test]
    async fn user_message_persists_when_run_fails_before_assistant_reply() {
        let temp_dir = test_temp_dir("persist-failed-user-message");
        let config = Arc::new(test_config(temp_dir.clone()));
        let workspace_root = temp_dir.join("workspace");
        fs::create_dir_all(&workspace_root).expect("create workspace");
        let failing_model_base_url = spawn_openai_error_server(
            "400 Bad Request",
            r#"{"error":{"message":"model service current quota is exhausted","type":"insufficient_quota","code":"insufficient_quota"}}"#,
        );

        let state = Arc::new(AppState::new(config).expect("create app state"));

        let mut headers = HeaderMap::new();
        headers.insert("x-clawd-user-id", "alice".parse().expect("user id header"));

        let created = create_thread(
            State(state.clone()),
            headers.clone(),
            Query(AuthQuery::default()),
            Json(CreateThreadRequest {
                workspace_root: Some(workspace_root.display().to_string()),
                project_id: None,
                knowledge_base_id: None,
                model: Some("gpt-4o".to_string()),
                model_base_url: Some(failing_model_base_url),
                model_api_key: Some("test-key".to_string()),
                permission_mode: None,
                topic: Some("验证失败持久化".to_string()),
            }),
        )
        .await
        .expect("create thread")
        .0;

        let thread_id = created.id.clone();
        let response = post_thread_command(
            State(state.clone()),
            headers,
            Query(AuthQuery::default()),
            axum::extract::Path(thread_id.clone()),
            Json(CommandRequest::UserMessage {
                content: "请总结当前资料".to_string(),
                expert_panel: None,
                knowledge_base_id: None,
                data_source_ids: None,
                auto_retrieval: None,
            }),
        )
        .await
        .expect("post user message")
        .0;

        assert_eq!(response.id, thread_id);

        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            loop {
                let snapshot = state
                    .get_thread(&thread_id)
                    .expect("thread exists")
                    .snapshot();
                if snapshot.status == ThreadStatus::Failed {
                    return snapshot;
                }
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
        })
        .await
        .expect("wait for failed run");

        let snapshot = state
            .get_thread(&thread_id)
            .expect("thread exists")
            .snapshot();
        assert_eq!(snapshot.status, ThreadStatus::Failed);
        assert!(!snapshot.messages.is_empty());
        assert_eq!(snapshot.messages[0].role, "user");
        assert_eq!(snapshot.messages[0].blocks.len(), 1);
        match &snapshot.messages[0].blocks[0] {
            MessageBlockSnapshot::Text { text } => assert_eq!(text, "请总结当前资料"),
            other => panic!("expected first message block to be text, got {other:?}"),
        }

        let persisted = Session::load_from_path(&PathBuf::from(&snapshot.session_path))
            .expect("load persisted session");
        assert!(!persisted.messages.is_empty());
        assert_eq!(persisted.messages[0].role, MessageRole::User);

        fs::remove_dir_all(temp_dir).expect("cleanup temp dir");
    }

    #[tokio::test]
    async fn user_message_command_records_structured_expert_panel_context() {
        let temp_dir = test_temp_dir("expert-panel-command");
        let config = Arc::new(test_config(temp_dir.clone()));
        let workspace_root = temp_dir.join("workspace");
        fs::create_dir_all(&workspace_root).expect("create workspace");
        let failing_model_base_url = spawn_openai_error_server(
            "400 Bad Request",
            r#"{"error":{"message":"model service current quota is exhausted","type":"insufficient_quota","code":"insufficient_quota"}}"#,
        );

        let state = Arc::new(AppState::new(config).expect("create app state"));
        let mut knowledge_base = test_knowledge_base(&temp_dir, Some("alice"));
        knowledge_base.id = "kb-panel-alpha".to_string();
        state
            .store
            .upsert_knowledge_base(&knowledge_base)
            .expect("persist knowledge base");

        let mut headers = HeaderMap::new();
        headers.insert("x-clawd-user-id", "alice".parse().expect("user id header"));

        let created = create_thread(
            State(state.clone()),
            headers.clone(),
            Query(AuthQuery::default()),
            Json(CreateThreadRequest {
                workspace_root: Some(workspace_root.display().to_string()),
                project_id: None,
                knowledge_base_id: None,
                model: Some("gpt-4o".to_string()),
                model_base_url: Some(failing_model_base_url),
                model_api_key: Some("test-key".to_string()),
                permission_mode: None,
                topic: Some("专家会诊".to_string()),
            }),
        )
        .await
        .expect("create thread")
        .0;

        let thread_id = created.id.clone();
        let _ = post_thread_command(
            State(state.clone()),
            headers,
            Query(AuthQuery::default()),
            axum::extract::Path(thread_id.clone()),
            Json(CommandRequest::UserMessage {
                content: "请开始专家会诊".to_string(),
                expert_panel: Some(ExpertPanelRequest {
                    panel_id: "expert-panel-xyz12345".to_string(),
                    master_skill: "expert-brainstorm".to_string(),
                    experts: vec![ExpertPanelExpert {
                        skill: "mearsheimer".to_string(),
                        scope: SkillScope::Workspace,
                        label: "米尔斯海默".to_string(),
                        description: Some("评估结构性冲突".to_string()),
                    }],
                }),
                knowledge_base_id: Some("kb-panel-alpha".to_string()),
                data_source_ids: None,
                auto_retrieval: Some(false),
            }),
        )
        .await
        .expect("post expert panel message");

        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            loop {
                let snapshot = state
                    .get_thread(&thread_id)
                    .expect("thread exists")
                    .snapshot();
                if snapshot.status == ThreadStatus::Failed {
                    return snapshot;
                }
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
        })
        .await
        .expect("wait for failed run");

        let snapshot = state
            .get_thread(&thread_id)
            .expect("thread exists")
            .snapshot();
        let run_started = snapshot
            .audit_records
            .iter()
            .find(|record| record.kind == "run_started")
            .expect("run_started audit exists");
        let payload = run_started
            .payload
            .as_object()
            .expect("run_started payload object");
        let expert_panel = payload
            .get("expert_panel")
            .and_then(Value::as_object)
            .expect("expert panel audit payload");
        assert_eq!(
            expert_panel.get("panel_id").and_then(Value::as_str),
            Some("expert-panel-xyz12345")
        );
        let execution_context = payload
            .get("execution_context")
            .and_then(Value::as_object)
            .expect("execution context audit payload");
        assert_eq!(
            execution_context
                .get("knowledge_base_id")
                .and_then(Value::as_str),
            Some("kb-panel-alpha")
        );
        assert_eq!(
            execution_context
                .get("auto_retrieval")
                .and_then(Value::as_bool),
            Some(false)
        );

        fs::remove_dir_all(temp_dir).expect("cleanup temp dir");
    }

    #[tokio::test]
    async fn user_message_command_rejects_nonexistent_override_knowledge_base() {
        let temp_dir = test_temp_dir("user-message-missing-override-kb");
        let config = Arc::new(test_config(temp_dir.clone()));
        let workspace_root = temp_dir.join("workspace");
        fs::create_dir_all(&workspace_root).expect("create workspace");
        let state = Arc::new(AppState::new(config).expect("create app state"));

        let mut headers = HeaderMap::new();
        headers.insert("x-clawd-user-id", "alice".parse().expect("user id header"));

        let created = create_thread(
            State(state.clone()),
            headers.clone(),
            Query(AuthQuery::default()),
            Json(CreateThreadRequest {
                workspace_root: Some(workspace_root.display().to_string()),
                project_id: None,
                knowledge_base_id: None,
                model: None,
                model_base_url: None,
                model_api_key: None,
                permission_mode: None,
                topic: Some("override validation".to_string()),
            }),
        )
        .await
        .expect("create thread")
        .0;

        let error = post_thread_command(
            State(state.clone()),
            headers,
            Query(AuthQuery::default()),
            axum::extract::Path(created.id.clone()),
            Json(CommandRequest::UserMessage {
                content: "请读取资料库".to_string(),
                expert_panel: None,
                knowledge_base_id: Some("kb-missing".to_string()),
                data_source_ids: None,
                auto_retrieval: Some(true),
            }),
        )
        .await
        .expect_err("missing override knowledge base should be rejected");

        assert_eq!(error.status, StatusCode::NOT_FOUND);
        assert_eq!(error.message, "knowledge base not found");
        let snapshot = state
            .get_thread(&created.id)
            .expect("thread exists")
            .snapshot();
        assert_eq!(snapshot.status, ThreadStatus::Idle);
        assert!(snapshot
            .audit_records
            .iter()
            .all(|record| record.kind != "run_started"));

        fs::remove_dir_all(temp_dir).expect("cleanup temp dir");
    }

    #[tokio::test]
    async fn create_expert_panel_run_rejects_inaccessible_override_knowledge_base() {
        let temp_dir = test_temp_dir("expert-panel-inaccessible-override-kb");
        let config = Arc::new(test_config(temp_dir.clone()));
        let workspace_root = temp_dir.join("workspace");
        fs::create_dir_all(&workspace_root).expect("create workspace");
        let state = Arc::new(AppState::new(config).expect("create app state"));

        let inaccessible_kb = test_knowledge_base(&temp_dir, Some("bob"));
        state
            .store
            .upsert_knowledge_base(&inaccessible_kb)
            .expect("persist inaccessible knowledge base");

        let mut headers = HeaderMap::new();
        headers.insert("x-clawd-user-id", "alice".parse().expect("user id header"));

        let created = create_thread(
            State(state.clone()),
            headers.clone(),
            Query(AuthQuery::default()),
            Json(CreateThreadRequest {
                workspace_root: Some(workspace_root.display().to_string()),
                project_id: None,
                knowledge_base_id: None,
                model: None,
                model_base_url: None,
                model_api_key: None,
                permission_mode: None,
                topic: Some("override validation".to_string()),
            }),
        )
        .await
        .expect("create thread")
        .0;

        let error = create_expert_panel_run(
            State(state.clone()),
            headers,
            Query(AuthQuery::default()),
            axum::extract::Path(created.id.clone()),
            Json(ExpertPanelRunRequest {
                question: Some("请组织专家讨论".to_string()),
                source_message_id: None,
                knowledge_base_id: Some(inaccessible_kb.id.clone()),
                data_source_ids: None,
                auto_retrieval: Some(true),
                experts: vec![ExpertPanelExpert {
                    skill: "mearsheimer".to_string(),
                    scope: SkillScope::Workspace,
                    label: "米尔斯海默".to_string(),
                    description: None,
                }],
                retry_count: Some(1),
                concurrency_limit: Some(1),
            }),
        )
        .await
        .expect_err("inaccessible override knowledge base should be rejected");

        assert_eq!(error.status, StatusCode::NOT_FOUND);
        assert_eq!(error.message, "knowledge base not found");
        let snapshot = state
            .get_thread(&created.id)
            .expect("thread exists")
            .snapshot();
        assert_eq!(snapshot.status, ThreadStatus::Idle);
        assert!(snapshot
            .audit_records
            .iter()
            .all(|record| record.kind != "run_started"));

        fs::remove_dir_all(temp_dir).expect("cleanup temp dir");
    }

    #[tokio::test]
    async fn create_expert_panel_run_does_not_persist_state_when_start_run_fails() {
        let temp_dir = test_temp_dir("expert-panel-start-run-failure");
        let mut config = test_config(temp_dir.clone());
        config.max_concurrent_runs_global = Some(0);
        let config = Arc::new(config);
        let workspace_root = temp_dir.join("workspace");
        fs::create_dir_all(&workspace_root).expect("create workspace");
        let state = Arc::new(AppState::new(config).expect("create app state"));

        let mut headers = HeaderMap::new();
        headers.insert("x-clawd-user-id", "alice".parse().expect("user id header"));

        let created = create_thread(
            State(state.clone()),
            headers.clone(),
            Query(AuthQuery::default()),
            Json(CreateThreadRequest {
                workspace_root: Some(workspace_root.display().to_string()),
                project_id: None,
                knowledge_base_id: None,
                model: None,
                model_base_url: None,
                model_api_key: None,
                permission_mode: None,
                topic: Some("expert panel capacity failure".to_string()),
            }),
        )
        .await
        .expect("create thread")
        .0;

        let error = create_expert_panel_run(
            State(state.clone()),
            headers,
            Query(AuthQuery::default()),
            axum::extract::Path(created.id.clone()),
            Json(ExpertPanelRunRequest {
                question: Some("请组织专家讨论".to_string()),
                source_message_id: None,
                knowledge_base_id: None,
                data_source_ids: None,
                auto_retrieval: Some(true),
                experts: vec![ExpertPanelExpert {
                    skill: "mearsheimer".to_string(),
                    scope: SkillScope::Workspace,
                    label: "米尔斯海默".to_string(),
                    description: None,
                }],
                retry_count: Some(1),
                concurrency_limit: Some(1),
            }),
        )
        .await
        .expect_err("start_run capacity failure should bubble up");

        assert_eq!(error.status, StatusCode::TOO_MANY_REQUESTS);
        let snapshot = state
            .get_thread(&created.id)
            .expect("thread exists")
            .snapshot();
        assert!(snapshot
            .audit_records
            .iter()
            .all(|record| record.kind != "expert_panel_run_state"));

        fs::remove_dir_all(temp_dir).expect("cleanup temp dir");
    }

    #[test]
    fn persist_expert_run_state_does_not_overwrite_newer_state() {
        let temp_dir = test_temp_dir("expert-panel-state-ordering");
        let config = Arc::new(test_config(temp_dir.clone()));
        let store = Arc::new(ThreadStore::open(&config).expect("open sqlite store"));
        let record = test_record(&temp_dir, Some("alice"));
        fs::create_dir_all(&record.workspace_root).expect("create workspace");

        let session = Session::new()
            .with_workspace_root(record.workspace_root.clone())
            .with_persistence_path(record.session_path.clone());
        let thread = Arc::new(ManagedThread::new(ThreadState {
            record: record.clone(),
            visible_memory_notes: record.memory_notes.clone(),
            audit_records: Vec::new(),
            session,
            status: ThreadStatus::Idle,
            last_error: None,
            draft_assistant_text: String::new(),
            next_run_id: 1,
            current_run: None,
            pending_replan: None,
        }));
        persist_thread_state(&thread, &store).expect("persist thread");

        let state = Arc::new(AppState {
            config,
            store,
            admission: Mutex::new(()),
            mutation_rate_limiter: Mutex::new(MutationRateLimiter::default()),
            threads: RwLock::new(HashMap::new()),
        });

        let queued = ExpertPanelRunResponse {
            run_id: "expert-run-stale".to_string(),
            thread_id: record.id.clone(),
            status: ExpertPanelRunStatus::Queued,
            retry_count: 1,
            concurrency_limit: 1,
            experts: vec![ExpertPanelRunExpertState {
                skill: "mearsheimer".to_string(),
                scope: SkillScope::Workspace,
                label: "米尔斯海默".to_string(),
                description: None,
                status: ExpertPanelExpertStatus::Queued,
                attempts: 0,
                content: None,
                citations: Vec::new(),
                confidence: None,
                stance: None,
                error: None,
            }],
        };
        let mut running = queued.clone();
        running.status = ExpertPanelRunStatus::Running;
        running.experts[0].status = ExpertPanelExpertStatus::Running;
        running.experts[0].attempts = 1;

        persist_expert_run_state(&state, &thread, &running).expect("persist running state");
        persist_expert_run_state(&state, &thread, &queued).expect("persist stale queued state");

        let resolved = expert_run_response_from_audit(&thread, &queued.run_id)
            .expect("resolve latest expert run state");
        assert_eq!(resolved.status, ExpertPanelRunStatus::Running);
        assert_eq!(resolved.experts[0].status, ExpertPanelExpertStatus::Running);
        assert_eq!(resolved.experts[0].attempts, 1);

        fs::remove_dir_all(temp_dir).expect("cleanup temp dir");
    }

    #[test]
    fn persist_research_task_state_appends_visible_state() {
        let temp_dir = test_temp_dir("research-task-state");
        let config = Arc::new(test_config(temp_dir.clone()));
        let store = Arc::new(ThreadStore::open(&config).expect("open sqlite store"));
        let mut record = test_record(&temp_dir, Some("alice"));
        record.artifacts.clear();
        fs::create_dir_all(&record.workspace_root).expect("create workspace");

        let mut session = Session::new();
        session
            .push_message(runtime::ConversationMessage::user_text("分析中美 AI 竞争"))
            .expect("push user message");
        session
            .push_message(runtime::ConversationMessage::assistant(vec![
                runtime::ContentBlock::Text {
                    text: "### 米尔斯海默\n现实主义判断".to_string(),
                },
            ]))
            .expect("push expert message");
        session
            .push_message(runtime::ConversationMessage::assistant(vec![
                runtime::ContentBlock::Text {
                    text: "### Final synthesis\n综合判断".to_string(),
                },
            ]))
            .expect("push synthesis");

        let thread = Arc::new(ManagedThread::new(ThreadState {
            record: record.clone(),
            visible_memory_notes: record.memory_notes.clone(),
            audit_records: Vec::new(),
            session,
            status: ThreadStatus::Idle,
            last_error: None,
            draft_assistant_text: String::new(),
            next_run_id: 1,
            current_run: None,
            pending_replan: None,
        }));
        persist_thread_state(&thread, &store).expect("persist thread");

        let state = Arc::new(AppState {
            config,
            store,
            admission: Mutex::new(()),
            mutation_rate_limiter: Mutex::new(MutationRateLimiter::default()),
            threads: RwLock::new(HashMap::new()),
        });

        append_thread_audit(
            &state.store,
            &thread,
            "run_started",
            Some(1),
            json!({
                "prompt": "整理为报告",
            }),
        )
        .expect("append write intent audit");
        persist_research_task_state(&state, &thread).expect("persist research task state");

        let snapshot = thread.snapshot();
        let payload = snapshot
            .audit_records
            .iter()
            .find(|record| record.kind == "research_task_state")
            .map(|record| record.payload.clone())
            .expect("research task state audit");
        let parsed: ResearchTaskStateRecord =
            serde_json::from_value(payload).expect("deserialize research task state");

        assert_eq!(parsed.status, ResearchTaskStage::WritingReady);
        assert_eq!(parsed.status_label, "可进入写作整理");
        assert_eq!(parsed.next_recommended_action, "整理综合结论并生成正式报告");

        fs::remove_dir_all(temp_dir).expect("cleanup temp dir");
    }

    #[test]
    fn persist_research_task_state_skips_duplicate_state() {
        let temp_dir = test_temp_dir("research-task-state-dedupe");
        let config = Arc::new(test_config(temp_dir.clone()));
        let store = Arc::new(ThreadStore::open(&config).expect("open sqlite store"));
        let record = test_record(&temp_dir, Some("alice"));
        fs::create_dir_all(&record.workspace_root).expect("create workspace");

        let mut session = Session::new();
        session
            .push_message(runtime::ConversationMessage::user_text("分析中美 AI 竞争"))
            .expect("push user message");

        let thread = Arc::new(ManagedThread::new(ThreadState {
            record: record.clone(),
            visible_memory_notes: record.memory_notes.clone(),
            audit_records: Vec::new(),
            session,
            status: ThreadStatus::Idle,
            last_error: None,
            draft_assistant_text: String::new(),
            next_run_id: 1,
            current_run: None,
            pending_replan: None,
        }));
        persist_thread_state(&thread, &store).expect("persist thread");

        let state = Arc::new(AppState {
            config,
            store,
            admission: Mutex::new(()),
            mutation_rate_limiter: Mutex::new(MutationRateLimiter::default()),
            threads: RwLock::new(HashMap::new()),
        });

        append_thread_audit(
            &state.store,
            &thread,
            "run_started",
            Some(1),
            json!({
                "prompt": "整理为报告",
            }),
        )
        .expect("append write intent audit");
        persist_research_task_state(&state, &thread).expect("persist first state");
        persist_research_task_state(&state, &thread).expect("persist duplicate state");

        let snapshot = thread.snapshot();
        let count = snapshot
            .audit_records
            .iter()
            .filter(|record| record.kind == "research_task_state")
            .count();
        assert_eq!(count, 1);

        fs::remove_dir_all(temp_dir).expect("cleanup temp dir");
    }

    #[tokio::test]
    async fn expert_panel_run_uses_override_execution_context_for_expert_turns() {
        let temp_dir = test_temp_dir("expert-panel-override-context");
        let config = Arc::new(test_config(temp_dir.clone()));
        let workspace_root = temp_dir.join("workspace");
        fs::create_dir_all(&workspace_root).expect("create workspace");
        let success_body = r#"{"id":"msg-1","model":"gpt-4o","choices":[{"message":{"role":"assistant","content":"captured response"}}],"usage":{"prompt_tokens":1,"completion_tokens":1}}"#;
        let (capturing_model_base_url, captured_requests) =
            spawn_openai_capture_server(success_body);

        let state = Arc::new(AppState::new(config).expect("create app state"));
        let mut knowledge_base = test_knowledge_base(&temp_dir, Some("alice"));
        knowledge_base.id = "kb-override-context".to_string();
        knowledge_base.name = "Override KB".to_string();
        state
            .store
            .upsert_knowledge_base(&knowledge_base)
            .expect("persist knowledge base");
        state
            .store
            .upsert_data_source(&DataSourceRecord {
                id: "source-web-1".to_string(),
                knowledge_base_id: knowledge_base.id.clone(),
                tenant_id: None,
                owner_id: Some("alice".to_string()),
                name: "Override Web Source".to_string(),
                kind: DataSourceKind::Web,
                description: Some("web source bound to override kb".to_string()),
                config: json!({
                    "urls": ["https://override.example.test/context"]
                }),
                status: Some("ready".to_string()),
                last_test: None,
                last_synced_at_ms: None,
                created_at_ms: 1,
                updated_at_ms: 1,
            })
            .expect("persist data source");

        let mut headers = HeaderMap::new();
        headers.insert("x-clawd-user-id", "alice".parse().expect("user id header"));

        let created = create_thread(
            State(state.clone()),
            headers.clone(),
            Query(AuthQuery::default()),
            Json(CreateThreadRequest {
                workspace_root: Some(workspace_root.display().to_string()),
                project_id: None,
                knowledge_base_id: None,
                model: Some("gpt-4o".to_string()),
                model_base_url: Some(capturing_model_base_url),
                model_api_key: Some("test-key".to_string()),
                permission_mode: None,
                topic: Some("专家上下文".to_string()),
            }),
        )
        .await
        .expect("create thread")
        .0;

        let _ = create_expert_panel_run(
            State(state.clone()),
            headers,
            Query(AuthQuery::default()),
            axum::extract::Path(created.id.clone()),
            Json(ExpertPanelRunRequest {
                question: Some("请组织专家讨论".to_string()),
                source_message_id: None,
                knowledge_base_id: Some(knowledge_base.id.clone()),
                data_source_ids: None,
                auto_retrieval: Some(false),
                experts: vec![ExpertPanelExpert {
                    skill: "mearsheimer".to_string(),
                    scope: SkillScope::Workspace,
                    label: "米尔斯海默".to_string(),
                    description: None,
                }],
                retry_count: Some(1),
                concurrency_limit: Some(1),
            }),
        )
        .await
        .expect("create expert panel run");

        tokio::time::timeout(std::time::Duration::from_secs(10), async {
            loop {
                let request_count = captured_requests
                    .lock()
                    .unwrap_or_else(std::sync::PoisonError::into_inner)
                    .len();
                if request_count >= 1 {
                    return;
                }
                tokio::time::sleep(std::time::Duration::from_millis(50)).await;
            }
        })
        .await
        .expect("wait for expert request capture");

        let requests = captured_requests
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner)
            .clone();
        assert!(!requests.is_empty());
        let expert_system_prompt = requests[0]
            .get("messages")
            .and_then(Value::as_array)
            .and_then(|messages| messages.first())
            .and_then(Value::as_object)
            .and_then(|message| message.get("content"))
            .and_then(Value::as_str)
            .expect("expert request system prompt");
        assert!(expert_system_prompt.contains("# Connected Data Sources"));
        assert!(expert_system_prompt.contains("https://override.example.test/context"));

        fs::remove_dir_all(temp_dir).expect("cleanup temp dir");
    }

    #[test]
    fn load_threads_recovers_stale_running_threads() {
        let temp_dir = test_temp_dir("sqlite-recover-running");
        let config = test_config(temp_dir.clone());
        let store = ThreadStore::open(&config).expect("open sqlite store");
        let record = test_record(&temp_dir, Some("alice"));
        fs::create_dir_all(&record.workspace_root).expect("create workspace");

        let session = Session::new()
            .with_workspace_root(record.workspace_root.clone())
            .with_persistence_path(record.session_path.clone());
        let thread = Arc::new(ManagedThread::new(ThreadState {
            record: record.clone(),
            visible_memory_notes: record.memory_notes.clone(),
            audit_records: Vec::new(),
            session,
            status: ThreadStatus::Running,
            last_error: None,
            draft_assistant_text: "partial reply".to_string(),
            next_run_id: 4,
            current_run: Some(ActiveRun {
                run_id: 3,
                abort_signal: runtime::HookAbortSignal::new(),
                request: RunRequest {
                    kind: RunKind::UserMessage,
                    prompt: "continue".to_string(),
                    expert_panel: None,
                    expert_run: None,
                    execution_context: None,
                },
            }),
            pending_replan: None,
        }));

        persist_thread_state(&thread, &store).expect("persist running thread");

        let loaded_threads = load_threads(&store).expect("load threads");
        assert_eq!(loaded_threads.len(), 1);
        let snapshot = loaded_threads[0].snapshot();
        assert_eq!(snapshot.status, ThreadStatus::Failed);
        assert_eq!(
            snapshot.last_error.as_deref(),
            Some("service restarted during an active run")
        );
        assert!(snapshot
            .audit_records
            .iter()
            .any(|record| record.kind == "thread_recovered"));

        let guard = loaded_threads[0]
            .shared
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);
        assert_eq!(guard.next_run_id, 4);

        fs::remove_dir_all(temp_dir).expect("cleanup temp dir");
    }

    #[test]
    fn sqlite_store_loads_persisted_audit_records() {
        let temp_dir = test_temp_dir("sqlite-audit");
        let config = test_config(temp_dir.clone());
        let store = ThreadStore::open(&config).expect("open sqlite store");
        let record = test_record(&temp_dir, Some("alice"));
        fs::create_dir_all(&record.workspace_root).expect("create workspace");

        let session = Session::new()
            .with_workspace_root(record.workspace_root.clone())
            .with_persistence_path(record.session_path.clone());
        let thread = Arc::new(ManagedThread::new(ThreadState {
            record: record.clone(),
            visible_memory_notes: record.memory_notes.clone(),
            audit_records: Vec::new(),
            session,
            status: ThreadStatus::Idle,
            last_error: None,
            draft_assistant_text: String::new(),
            next_run_id: 1,
            current_run: None,
            pending_replan: None,
        }));

        persist_thread_state(&thread, &store).expect("persist thread");
        store
            .append_audit_record(
                &record.id,
                &AuditRecord {
                    id: "audit-1".to_string(),
                    run_id: Some(1),
                    kind: "run_started".to_string(),
                    created_at_ms: 10,
                    payload: serde_json::json!({ "run_kind": "user_message" }),
                },
            )
            .expect("append audit 1");
        store
            .append_audit_record(
                &record.id,
                &AuditRecord {
                    id: "audit-2".to_string(),
                    run_id: Some(1),
                    kind: "tool_result".to_string(),
                    created_at_ms: 20,
                    payload: serde_json::json!({ "tool_name": "EsSearch" }),
                },
            )
            .expect("append audit 2");

        let loaded_threads = load_threads(&store).expect("load threads");
        assert_eq!(loaded_threads.len(), 1);
        let snapshot = loaded_threads[0].snapshot();
        let audit_ids = snapshot
            .audit_records
            .iter()
            .map(|record| record.id.as_str())
            .collect::<Vec<_>>();
        assert_eq!(audit_ids, vec!["audit-1", "audit-2"]);
        assert_eq!(snapshot.audit_records[1].kind, "tool_result");

        fs::remove_dir_all(temp_dir).expect("cleanup temp dir");
    }

    #[tokio::test]
    async fn get_expert_panel_run_loads_persisted_state_outside_visible_audit_window() {
        let temp_dir = test_temp_dir("expert-panel-persisted-lookup");
        let config = Arc::new(test_config(temp_dir.clone()));
        let workspace_root = temp_dir.join("workspace");
        fs::create_dir_all(&workspace_root).expect("create workspace");
        let state = Arc::new(AppState::new(config).expect("create app state"));

        let mut headers = HeaderMap::new();
        headers.insert("x-clawd-user-id", "alice".parse().expect("user id header"));

        let created = create_thread(
            State(state.clone()),
            headers.clone(),
            Query(AuthQuery::default()),
            Json(CreateThreadRequest {
                workspace_root: Some(workspace_root.display().to_string()),
                project_id: None,
                knowledge_base_id: None,
                model: None,
                model_base_url: None,
                model_api_key: None,
                permission_mode: None,
                topic: Some("expert panel durability".to_string()),
            }),
        )
        .await
        .expect("create thread")
        .0;

        let thread = state.get_thread(&created.id).expect("thread exists");
        let response = ExpertPanelRunResponse {
            run_id: "expert-run-persisted".to_string(),
            thread_id: created.id.clone(),
            status: ExpertPanelRunStatus::Succeeded,
            retry_count: 2,
            concurrency_limit: 1,
            experts: vec![ExpertPanelRunExpertState {
                skill: "mearsheimer".to_string(),
                scope: SkillScope::Workspace,
                label: "米尔斯海默".to_string(),
                description: None,
                status: ExpertPanelExpertStatus::Succeeded,
                attempts: 2,
                content: Some("captured synthesis".to_string()),
                citations: Vec::new(),
                confidence: None,
                stance: None,
                error: None,
            }],
        };
        persist_expert_run_state(&state, &thread, &response).expect("persist expert run state");

        for index in 0..=MAX_VISIBLE_AUDIT_RECORDS {
            append_thread_audit(
                &state.store,
                &thread,
                "tool_result",
                Some(1),
                json!({ "index": index }),
            )
            .expect("append filler audit");
        }

        let snapshot = thread.snapshot();
        assert!(!snapshot.audit_records.iter().any(|record| {
            record.kind == "expert_panel_run_state"
                && record.payload.get("run_id").and_then(Value::as_str)
                    == Some(response.run_id.as_str())
        }));

        let loaded = get_expert_panel_run(
            State(state.clone()),
            headers.clone(),
            Query(AuthQuery::default()),
            axum::extract::Path((created.id.clone(), response.run_id.clone())),
        )
        .await
        .expect("load persisted expert panel run")
        .0;
        assert_eq!(loaded.status, ExpertPanelRunStatus::Succeeded);
        assert_eq!(
            loaded.experts[0].content.as_deref(),
            Some("captured synthesis")
        );

        fs::remove_dir_all(temp_dir).expect("cleanup temp dir");
    }

    #[test]
    fn sqlite_store_scopes_workspace_memory_by_owner_and_workspace() {
        let temp_dir = test_temp_dir("workspace-memory");
        let config = test_config(temp_dir.clone());
        let store = ThreadStore::open(&config).expect("open sqlite store");
        let workspace_root = temp_dir.join("workspace");
        fs::create_dir_all(&workspace_root).expect("create workspace");

        let mut alice_thread_a = test_record(&temp_dir, Some("alice"));
        alice_thread_a.id = "thread-alice-a".to_string();
        alice_thread_a.session_path = workspace_root.join("alice-a.session.jsonl");
        alice_thread_a.memory_notes = vec![
            MemoryNote {
                id: "note-thread-a".to_string(),
                scope: MemoryScope::Thread,
                note: "alice local note".to_string(),
                tags: vec!["local".to_string()],
                created_at_ms: 10,
            },
            MemoryNote {
                id: "note-workspace-a".to_string(),
                scope: MemoryScope::Workspace,
                note: "alice shared workspace note".to_string(),
                tags: vec!["shared".to_string()],
                created_at_ms: 20,
            },
        ];
        alice_thread_a.artifacts.clear();
        alice_thread_a.updated_at_ms = 20;

        let mut alice_thread_b = test_record(&temp_dir, Some("alice"));
        alice_thread_b.id = "thread-alice-b".to_string();
        alice_thread_b.session_path = workspace_root.join("alice-b.session.jsonl");
        alice_thread_b.memory_notes = vec![MemoryNote {
            id: "note-thread-b".to_string(),
            scope: MemoryScope::Thread,
            note: "alice second thread note".to_string(),
            tags: vec!["local".to_string()],
            created_at_ms: 30,
        }];
        alice_thread_b.artifacts.clear();
        alice_thread_b.updated_at_ms = 30;

        let mut bob_thread = test_record(&temp_dir, Some("bob"));
        bob_thread.id = "thread-bob".to_string();
        bob_thread.session_path = workspace_root.join("bob.session.jsonl");
        bob_thread.memory_notes = vec![MemoryNote {
            id: "note-workspace-bob".to_string(),
            scope: MemoryScope::Workspace,
            note: "bob shared workspace note".to_string(),
            tags: vec!["shared".to_string()],
            created_at_ms: 40,
        }];
        bob_thread.artifacts.clear();
        bob_thread.updated_at_ms = 40;

        for record in [
            alice_thread_a.clone(),
            alice_thread_b.clone(),
            bob_thread.clone(),
        ] {
            let session = Session::new()
                .with_workspace_root(record.workspace_root.clone())
                .with_persistence_path(record.session_path.clone());
            let thread = Arc::new(ManagedThread::new(ThreadState {
                visible_memory_notes: record.memory_notes.clone(),
                audit_records: Vec::new(),
                record,
                session,
                status: ThreadStatus::Idle,
                last_error: None,
                draft_assistant_text: String::new(),
                next_run_id: 1,
                current_run: None,
                pending_replan: None,
            }));
            persist_thread_state(&thread, &store).expect("persist thread");
        }

        let alice_visible = store
            .load_visible_memory_notes(&alice_thread_b)
            .expect("load visible memory");
        let alice_visible_ids = alice_visible
            .iter()
            .map(|note| note.id.as_str())
            .collect::<Vec<_>>();
        assert!(alice_visible_ids.contains(&"note-thread-b"));
        assert!(alice_visible_ids.contains(&"note-workspace-a"));
        assert!(!alice_visible_ids.contains(&"note-thread-a"));
        assert!(!alice_visible_ids.contains(&"note-workspace-bob"));

        let alice_workspace = store
            .load_memory_notes_for_scope(&alice_thread_b, MemorySearchScope::Workspace)
            .expect("load workspace memory");
        let alice_workspace_ids = alice_workspace
            .iter()
            .map(|note| note.id.as_str())
            .collect::<Vec<_>>();
        assert_eq!(alice_workspace_ids, vec!["note-workspace-a"]);

        let alice_thread_only = store
            .load_memory_notes_for_scope(&alice_thread_b, MemorySearchScope::Thread)
            .expect("load thread memory");
        let alice_thread_only_ids = alice_thread_only
            .iter()
            .map(|note| note.id.as_str())
            .collect::<Vec<_>>();
        assert_eq!(alice_thread_only_ids, vec!["note-thread-b"]);

        fs::remove_dir_all(temp_dir).expect("cleanup temp dir");
    }

    #[test]
    fn sqlite_store_shares_tenant_memory_by_tenant_only() {
        let temp_dir = test_temp_dir("tenant-memory");
        let config = test_config(temp_dir.clone());
        let store = ThreadStore::open(&config).expect("open sqlite store");
        let workspace_a = temp_dir.join("workspace-a");
        let workspace_b = temp_dir.join("workspace-b");
        fs::create_dir_all(&workspace_a).expect("create workspace a");
        fs::create_dir_all(&workspace_b).expect("create workspace b");

        let mut tenant_source = test_record(&temp_dir, Some("alice"));
        tenant_source.tenant_id = Some("tenant-a".to_string());
        tenant_source.id = "thread-tenant-source".to_string();
        tenant_source.workspace_root = workspace_a.clone();
        tenant_source.session_path = workspace_a.join("tenant-source.session.jsonl");
        tenant_source.memory_notes = vec![MemoryNote {
            id: "note-tenant-a".to_string(),
            scope: MemoryScope::Tenant,
            note: "shared across the tenant".to_string(),
            tags: vec!["shared".to_string()],
            created_at_ms: 10,
        }];
        tenant_source.artifacts.clear();
        tenant_source.updated_at_ms = 10;

        let mut tenant_peer = test_record(&temp_dir, Some("bob"));
        tenant_peer.tenant_id = Some("tenant-a".to_string());
        tenant_peer.id = "thread-tenant-peer".to_string();
        tenant_peer.workspace_root = workspace_b.clone();
        tenant_peer.session_path = workspace_b.join("tenant-peer.session.jsonl");
        tenant_peer.memory_notes.clear();
        tenant_peer.artifacts.clear();
        tenant_peer.updated_at_ms = 20;

        let mut other_tenant = test_record(&temp_dir, Some("charlie"));
        other_tenant.tenant_id = Some("tenant-b".to_string());
        other_tenant.id = "thread-other-tenant".to_string();
        other_tenant.workspace_root = workspace_b.clone();
        other_tenant.session_path = workspace_b.join("other-tenant.session.jsonl");
        other_tenant.memory_notes.clear();
        other_tenant.artifacts.clear();
        other_tenant.updated_at_ms = 30;

        for record in [
            tenant_source.clone(),
            tenant_peer.clone(),
            other_tenant.clone(),
        ] {
            let session = Session::new()
                .with_workspace_root(record.workspace_root.clone())
                .with_persistence_path(record.session_path.clone());
            let thread = Arc::new(ManagedThread::new(ThreadState {
                visible_memory_notes: record.memory_notes.clone(),
                audit_records: Vec::new(),
                record,
                session,
                status: ThreadStatus::Idle,
                last_error: None,
                draft_assistant_text: String::new(),
                next_run_id: 1,
                current_run: None,
                pending_replan: None,
            }));
            persist_thread_state(&thread, &store).expect("persist thread");
        }

        let peer_visible = store
            .load_visible_memory_notes(&tenant_peer)
            .expect("load tenant memory");
        let peer_ids = peer_visible
            .iter()
            .map(|note| note.id.as_str())
            .collect::<Vec<_>>();
        assert!(peer_ids.contains(&"note-tenant-a"));

        let other_visible = store
            .load_visible_memory_notes(&other_tenant)
            .expect("load other tenant memory");
        let other_ids = other_visible
            .iter()
            .map(|note| note.id.as_str())
            .collect::<Vec<_>>();
        assert!(!other_ids.contains(&"note-tenant-a"));

        let tenant_only = store
            .load_memory_notes_for_scope(&tenant_peer, MemorySearchScope::Tenant)
            .expect("load tenant-only memory");
        assert_eq!(tenant_only.len(), 1);
        assert_eq!(tenant_only[0].id, "note-tenant-a");

        fs::remove_dir_all(temp_dir).expect("cleanup temp dir");
    }

    #[test]
    fn app_state_imports_legacy_thread_records_into_sqlite_store() {
        let temp_dir = test_temp_dir("legacy-import");
        let config = Arc::new(test_config(temp_dir.clone()));
        let record = test_record(&temp_dir, Some("alice"));
        fs::create_dir_all(&record.workspace_root).expect("create workspace");
        fs::create_dir_all(config.thread_records_dir()).expect("create legacy thread dir");

        let session = Session::new()
            .with_workspace_root(record.workspace_root.clone())
            .with_persistence_path(record.session_path.clone());
        session
            .save_to_path(&record.session_path)
            .expect("save session");
        fs::write(
            config.thread_records_dir().join("legacy-thread.json"),
            serde_json::to_vec(&record).expect("serialize legacy record"),
        )
        .expect("write legacy record");

        let state = AppState::new(config.clone()).expect("build app state");
        let snapshot = state
            .get_thread(&record.id)
            .expect("legacy thread loaded")
            .snapshot();
        assert_eq!(snapshot.id, record.id);
        assert_eq!(snapshot.topic.as_deref(), Some("repository analysis"));
        assert_eq!(snapshot.memory_notes.len(), 1);
        assert_eq!(snapshot.artifacts.len(), 1);

        let store = ThreadStore::open(&config).expect("reopen sqlite store");
        let imported_records = store.load_records().expect("load imported records");
        assert_eq!(imported_records.len(), 1);
        assert_eq!(imported_records[0].id, record.id);
        assert_eq!(imported_records[0].artifacts.len(), 1);

        fs::remove_dir_all(temp_dir).expect("cleanup temp dir");
    }

    #[test]
    fn import_legacy_thread_records_is_idempotent() {
        let temp_dir = test_temp_dir("legacy-idempotent");
        let config = test_config(temp_dir.clone());
        let store = ThreadStore::open(&config).expect("open sqlite store");
        let record = test_record(&temp_dir, Some("alice"));

        fs::create_dir_all(config.thread_records_dir()).expect("create legacy thread dir");
        fs::write(
            config.thread_records_dir().join("legacy-thread.json"),
            serde_json::to_vec(&record).expect("serialize legacy record"),
        )
        .expect("write legacy record");

        import_legacy_thread_records(&store, &config).expect("first import");
        import_legacy_thread_records(&store, &config).expect("second import");

        let records = store.load_records().expect("load records");
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].id, record.id);

        fs::remove_dir_all(temp_dir).expect("cleanup temp dir");
    }

    #[test]
    fn sqlite_store_migrates_legacy_unversioned_schema_to_current_version() {
        let temp_dir = test_temp_dir("sqlite-migrate");
        let config = test_config(temp_dir.clone());
        let sqlite_path = sqlite_path_from_url(&config.database_url).expect("sqlite path");
        let record = test_record(&temp_dir, Some("alice"));
        fs::create_dir_all(&record.workspace_root).expect("create workspace");

        let session = Session::new()
            .with_workspace_root(record.workspace_root.clone())
            .with_persistence_path(record.session_path.clone());
        session
            .save_to_path(&record.session_path)
            .expect("save legacy session");

        let legacy = TestSqliteConnection::open(&sqlite_path).expect("open legacy sqlite");
        legacy
            .execute_batch(
                "CREATE TABLE thread_records (
                    id TEXT PRIMARY KEY,
                    owner_id TEXT NULL,
                    updated_at_ms INTEGER NOT NULL,
                    record_json TEXT NOT NULL
                );
                CREATE INDEX idx_thread_records_owner_updated
                    ON thread_records (owner_id, updated_at_ms DESC);",
            )
            .expect("create legacy schema");
        legacy
            .execute(
                "INSERT INTO thread_records (id, owner_id, updated_at_ms, record_json)
                 VALUES (?1, ?2, ?3, ?4)",
                rusqlite::params![
                    &record.id,
                    &record.owner_id,
                    i64::try_from(record.updated_at_ms).expect("updated_at_ms"),
                    serde_json::to_string(&record).expect("serialize record")
                ],
            )
            .expect("insert legacy record");
        drop(legacy);

        let store = ThreadStore::open(&config).expect("open migrated sqlite store");
        assert_eq!(store.schema_version(), CURRENT_DATABASE_SCHEMA_VERSION);
        let records = store.load_records().expect("load migrated records");
        assert_eq!(records.len(), 1);
        assert_eq!(records[0].memory_notes.len(), 1);
        assert_eq!(records[0].artifacts.len(), 1);

        let migrated = TestSqliteConnection::open(&sqlite_path).expect("reopen migrated sqlite");
        let schema_version: String = migrated
            .query_row(
                "SELECT value FROM clawd_meta WHERE key = 'schema_version'",
                [],
                |row| row.get(0),
            )
            .expect("read schema version");
        assert_eq!(schema_version, CURRENT_DATABASE_SCHEMA_VERSION.to_string());
        let memory_count: i64 = migrated
            .query_row("SELECT COUNT(*) FROM memory_notes", [], |row| row.get(0))
            .expect("count memory rows");
        let artifact_count: i64 = migrated
            .query_row("SELECT COUNT(*) FROM artifact_records", [], |row| {
                row.get(0)
            })
            .expect("count artifact rows");
        let project_table_exists: bool = migrated
            .query_row(
                "SELECT EXISTS (
                    SELECT 1 FROM sqlite_master
                    WHERE type = 'table' AND name = 'project_records'
                )",
                [],
                |row| row.get(0),
            )
            .expect("read project table existence");
        let acp_table_exists: bool = migrated
            .query_row(
                "SELECT EXISTS (
                    SELECT 1 FROM sqlite_master
                    WHERE type = 'table' AND name = 'acp_connectors'
                )",
                [],
                |row| row.get(0),
            )
            .expect("read acp table existence");
        let memory_scope: String = migrated
            .query_row("SELECT scope FROM memory_notes LIMIT 1", [], |row| {
                row.get(0)
            })
            .expect("read memory scope");
        let memory_owner: Option<String> = migrated
            .query_row("SELECT owner_id FROM memory_notes LIMIT 1", [], |row| {
                row.get(0)
            })
            .expect("read memory owner");
        let memory_workspace_root: Option<String> = migrated
            .query_row(
                "SELECT workspace_root FROM memory_notes LIMIT 1",
                [],
                |row| row.get(0),
            )
            .expect("read memory workspace");
        assert_eq!(memory_count, 1);
        assert_eq!(artifact_count, 1);
        assert!(project_table_exists);
        assert!(acp_table_exists);
        assert_eq!(memory_scope, "thread");
        assert_eq!(memory_owner, record.owner_id);
        assert_eq!(
            memory_workspace_root.as_deref(),
            Some(record.workspace_root.display().to_string().as_str())
        );

        fs::remove_dir_all(temp_dir).expect("cleanup temp dir");
    }

    #[test]
    fn persist_research_task_state_keeps_synthesis_without_explicit_write_action() {
        let temp_dir = test_temp_dir("research-task-state-synthesis-boundary");
        let config = Arc::new(test_config(temp_dir.clone()));
        let store = Arc::new(ThreadStore::open(&config).expect("open sqlite store"));
        let record = test_record(&temp_dir, Some("alice"));
        fs::create_dir_all(&record.workspace_root).expect("create workspace");

        let mut session = Session::new();
        session
            .push_message(runtime::ConversationMessage::user_text("分析中美 AI 竞争"))
            .expect("push user message");
        session
            .push_message(runtime::ConversationMessage::assistant(vec![
                runtime::ContentBlock::Text {
                    text: "### Final synthesis\n综合判断".to_string(),
                },
            ]))
            .expect("push synthesis");

        let thread = Arc::new(ManagedThread::new(ThreadState {
            record: record.clone(),
            visible_memory_notes: record.memory_notes.clone(),
            audit_records: Vec::new(),
            session,
            status: ThreadStatus::Idle,
            last_error: None,
            draft_assistant_text: String::new(),
            next_run_id: 1,
            current_run: None,
            pending_replan: None,
        }));
        persist_thread_state(&thread, &store).expect("persist thread");

        let state = Arc::new(AppState {
            config,
            store,
            admission: Mutex::new(()),
            mutation_rate_limiter: Mutex::new(MutationRateLimiter::default()),
            threads: RwLock::new(HashMap::new()),
        });

        persist_research_task_state(&state, &thread).expect("persist research task state");

        let snapshot = thread.snapshot();
        let payload = snapshot
            .audit_records
            .iter()
            .find(|record| record.kind == "research_task_state")
            .map(|record| record.payload.clone())
            .expect("research task state audit");
        let parsed: ResearchTaskStateRecord =
            serde_json::from_value(payload).expect("deserialize research task state");

        assert_eq!(parsed.status, ResearchTaskStage::Synthesis);
        assert_eq!(parsed.status_label, "已形成综合判断");
        assert_eq!(parsed.next_recommended_action, "补充证据或直接整理为报告");

        fs::remove_dir_all(temp_dir).expect("cleanup temp dir");
    }
}
