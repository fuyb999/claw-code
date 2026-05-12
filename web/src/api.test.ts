import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createApiKey,
  createDataSource,
  createProject,
  createKnowledgeBase,
  createThread,
  deleteDataSource,
  deleteDataSourceFile,
  deleteSkill,
  disableApiKey,
  getProject,
  getDataSource,
  listKnowledgeBases,
  listDataSources,
  listApiKeys,
  listProjects,
  listSkills,
  listThreads,
  sendThreadCommand,
  threadEventsUrl,
  testDataSource,
  testSavedDataSource,
  uploadDataSourceFile,
  updateDataSource,
  updateProject,
} from "./api";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("threadEventsUrl", () => {
  it("appends user scope to the SSE URL in dev mode", () => {
    expect(threadEventsUrl("thread-1", { userId: "alice" })).toBe(
      "http://127.0.0.1:3210/v1/threads/thread-1/events?user_id=alice",
    );
  });

  it("appends api_key to the SSE URL for API key auth", () => {
    expect(threadEventsUrl("thread-1", { apiKey: "clawd-secret" })).toBe(
      "http://127.0.0.1:3210/v1/threads/thread-1/events?api_key=clawd-secret",
    );
  });
});

describe("API requests", () => {
  it("sends bearer auth when listing threads", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        threads: [
          {
            id: "thread-1",
            workspace_root: "/tmp/project",
            project_id: "project-1",
            project_name: "Repository Research",
            model: "claude-sonnet-4-6",
            topic: "topic",
            status: "idle",
            updated_at_ms: 1,
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const threads = await listThreads({ apiKey: "clawd-secret" });

    expect(threads).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:3210/v1/threads",
      expect.objectContaining({
        headers: expect.objectContaining({
          "content-type": "application/json",
          authorization: "Bearer clawd-secret",
        }),
      }),
    );
  });

  it("lists projects with bearer auth", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        projects: [
          {
            id: "project-1",
            name: "Repository Research",
            description: "shared context",
            workspace_root: "/tmp/project",
            default_topic: "分析仓库结构",
            default_model: "claude-sonnet-4-6",
            model_base_url: null,
            model_base_url_env: "ANTHROPIC_BASE_URL",
            model_api_key_env: "ANTHROPIC_API_KEY",
            model_api_key_configured: true,
            default_permission_mode: "read-only",
            starter_prompt: "先检索资料再总结。",
            default_instructions: "优先梳理项目边界。",
            default_skill_names: ["workspace:repo-map", "tenant:report"],
            created_at_ms: 1,
            updated_at_ms: 2,
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const projects = await listProjects({ apiKey: "clawd-secret" });

    expect(projects).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:3210/v1/projects",
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: "Bearer clawd-secret",
        }),
      }),
    );
  });

  it("creates projects with the expected payload", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: "project-1",
        name: "Repository Research",
        description: "shared context",
        workspace_root: "/tmp/project",
        default_topic: "分析仓库结构",
        default_model: "claude-sonnet-4-6",
        model_base_url: "https://api.anthropic.com",
        model_base_url_env: null,
        model_api_key_env: null,
        model_api_key_configured: true,
        default_permission_mode: "read-only",
        starter_prompt: "先检索资料再总结。",
        default_instructions: "优先梳理项目边界。",
        default_skill_names: ["workspace:repo-map", "tenant:report"],
        created_at_ms: 1,
        updated_at_ms: 2,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await createProject(
      {
        name: "Repository Research",
        description: "shared context",
        workspace_root: "/tmp/project",
        default_topic: "分析仓库结构",
        model_base_url: "https://api.anthropic.com",
        model_api_key: "project-secret",
        default_permission_mode: "read-only",
        starter_prompt: "先检索资料再总结。",
        default_instructions: "优先梳理项目边界。",
        default_skill_names: ["workspace:repo-map", "tenant:report"],
      },
      { apiKey: "clawd-secret" },
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:3210/v1/projects",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer clawd-secret",
        }),
        body: JSON.stringify({
          name: "Repository Research",
          description: "shared context",
          workspace_root: "/tmp/project",
          default_topic: "分析仓库结构",
          model_base_url: "https://api.anthropic.com",
          model_api_key: "project-secret",
          default_permission_mode: "read-only",
          starter_prompt: "先检索资料再总结。",
          default_instructions: "优先梳理项目边界。",
          default_skill_names: ["workspace:repo-map", "tenant:report"],
        }),
      }),
    );
  });

  it("gets a single project with the expected auth headers", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: "project-1",
        name: "Repository Research",
        description: "shared context",
        workspace_root: "/tmp/project",
        default_topic: "分析仓库结构",
        default_model: "claude-sonnet-4-6",
        model_base_url: null,
        model_base_url_env: null,
        model_api_key_env: null,
        model_api_key_configured: false,
        default_permission_mode: "read-only",
        starter_prompt: "先检索资料再总结。",
        default_instructions: "优先梳理项目边界。",
        default_skill_names: ["workspace:repo-map"],
        created_at_ms: 1,
        updated_at_ms: 2,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await getProject("project-1", { userId: "alice" });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:3210/v1/projects/project-1",
      expect.objectContaining({
        headers: expect.objectContaining({
          "x-clawd-user-id": "alice",
        }),
      }),
    );
  });

  it("updates projects with the expected payload", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: "project-1",
        name: "Repository Research",
        description: null,
        workspace_root: "/tmp/project",
        default_topic: null,
        default_model: "gpt-5.4",
        model_base_url: "https://models.example.test/v1",
        model_base_url_env: null,
        model_api_key_env: null,
        model_api_key_configured: true,
        default_permission_mode: "workspace-write",
        starter_prompt: null,
        default_instructions: "聚焦证据后再形成结论。",
        default_skill_names: ["workspace:repo-map", "tenant:report"],
        created_at_ms: 1,
        updated_at_ms: 5,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await updateProject(
      "project-1",
      {
        name: "Repository Research",
        description: "",
        default_topic: "",
        model_base_url: "https://models.example.test/v1",
        model_api_key: "new-secret",
        default_permission_mode: "workspace-write",
        starter_prompt: "",
        default_instructions: "聚焦证据后再形成结论。",
        default_skill_names: ["workspace:repo-map", "tenant:report"],
      },
      { apiKey: "clawd-secret" },
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:3210/v1/projects/project-1",
      expect.objectContaining({
        method: "PATCH",
        headers: expect.objectContaining({
          authorization: "Bearer clawd-secret",
        }),
        body: JSON.stringify({
          name: "Repository Research",
          description: "",
          default_topic: "",
          model_base_url: "https://models.example.test/v1",
          model_api_key: "new-secret",
          default_permission_mode: "workspace-write",
          starter_prompt: "",
          default_instructions: "聚焦证据后再形成结论。",
          default_skill_names: ["workspace:repo-map", "tenant:report"],
        }),
      }),
    );
  });

  it("posts thread commands with the expected payload", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: "thread-1",
        workspace_root: "/tmp/project",
        session_path: "/tmp/project/.session.jsonl",
        project_id: "project-1",
        project_name: "Repository Research",
        model: "claude-sonnet-4-6",
        permission_mode: "read-only",
        topic: "topic",
        status: "idle",
        last_error: null,
        draft_assistant_text: "",
        created_at_ms: 1,
        updated_at_ms: 1,
        messages: [],
        memory_notes: [],
        artifacts: [],
        audit_records: [],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await sendThreadCommand(
      "thread-1",
      { type: "replan", reason: "narrow scope", topic: "docs only" },
      { userId: "alice" },
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:3210/v1/threads/thread-1/commands",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "x-clawd-user-id": "alice",
        }),
        body: JSON.stringify({
          type: "replan",
          reason: "narrow scope",
          topic: "docs only",
        }),
      }),
    );
  });

  it("creates threads from a selected project without sending workspace_root", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: "thread-1",
        workspace_root: "/tmp/project",
        session_path: "/tmp/project/.session.jsonl",
        project_id: "project-1",
        project_name: "Repository Research",
        model: "claude-sonnet-4-6",
        permission_mode: "read-only",
        topic: "topic",
        status: "idle",
        last_error: null,
        draft_assistant_text: "",
        created_at_ms: 1,
        updated_at_ms: 1,
        messages: [],
        memory_notes: [],
        artifacts: [],
        audit_records: [],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await createThread(
      {
        project_id: "project-1",
        topic: "topic",
      },
      { userId: "alice" },
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:3210/v1/threads",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "x-clawd-user-id": "alice",
        }),
        body: JSON.stringify({
          project_id: "project-1",
          topic: "topic",
        }),
      }),
    );
  });

  it("lists api keys with bearer auth", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        api_keys: [
          {
            id: "api-key-1",
            display_name: "Browser",
            key_prefix: "ck_ab12",
            created_at_ms: 1,
            updated_at_ms: 1,
            last_used_at_ms: null,
            disabled_at_ms: null,
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const apiKeys = await listApiKeys({ apiKey: "clawd-secret" });

    expect(apiKeys).toHaveLength(1);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:3210/v1/api-keys",
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: "Bearer clawd-secret",
        }),
      }),
    );
  });

  it("creates api keys with the expected payload", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        api_key: {
          id: "api-key-1",
          display_name: "Browser",
          key_prefix: "ck_ab12",
          created_at_ms: 1,
          updated_at_ms: 1,
          last_used_at_ms: null,
          disabled_at_ms: null,
        },
        raw_key: "ck_ab123456",
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const created = await createApiKey("Browser", { apiKey: "clawd-secret" });

    expect(created.raw_key).toBe("ck_ab123456");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:3210/v1/api-keys",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer clawd-secret",
        }),
        body: JSON.stringify({
          display_name: "Browser",
        }),
      }),
    );
  });

  it("disables api keys through the lifecycle endpoint", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 204,
    });
    vi.stubGlobal("fetch", fetchMock);

    await disableApiKey("api-key-1", { apiKey: "clawd-secret" });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:3210/v1/api-keys/api-key-1/disable",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer clawd-secret",
        }),
      }),
    );
  });

  it("deletes skills with scope and workspace context", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 204,
    });
    vi.stubGlobal("fetch", fetchMock);

    await deleteSkill(
      "evidence-scan",
      {
        scope: "workspace",
        workspaceRoot: "/tmp/project",
      },
      { apiKey: "clawd-secret" },
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:3210/v1/skills/evidence-scan?scope=workspace&workspace_root=%2Ftmp%2Fproject",
      expect.objectContaining({
        method: "DELETE",
        headers: expect.objectContaining({
          authorization: "Bearer clawd-secret",
        }),
      }),
    );
  });

  it("lists skills with project context when available", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ skills: [] }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await listSkills({ projectId: "project-1", workspaceRoot: "/tmp/project" }, { apiKey: "clawd-secret" });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:3210/v1/skills?project_id=project-1",
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: "Bearer clawd-secret",
        }),
      }),
    );
  });

  it("lists knowledge bases", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        knowledge_bases: [
          {
            id: "kb-1",
            name: "产品研究资料库",
            description: "聚合研究资料",
            default_project_id: "project-1",
            data_source_count: 2,
            created_at_ms: 1,
            updated_at_ms: 2,
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const items = await listKnowledgeBases({ apiKey: "clawd-secret" });

    expect(items[0]?.name).toBe("产品研究资料库");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:3210/v1/knowledge-bases",
      expect.objectContaining({
        headers: expect.objectContaining({
          authorization: "Bearer clawd-secret",
        }),
      }),
    );
  });

  it("creates a knowledge base with expected payload", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: "kb-1",
        name: "产品研究资料库",
        description: "聚合研究资料",
        default_project_id: "project-1",
        data_source_count: 0,
        created_at_ms: 1,
        updated_at_ms: 2,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await createKnowledgeBase(
      {
        name: "产品研究资料库",
        description: "聚合研究资料",
        default_project_id: "project-1",
      },
      { apiKey: "clawd-secret" },
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:3210/v1/knowledge-bases",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          name: "产品研究资料库",
          description: "聚合研究资料",
          default_project_id: "project-1",
        }),
      }),
    );
  });

  it("lists data sources", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        data_sources: [
          {
            id: "source-1",
            knowledge_base_id: "kb-1",
            name: "ES 主索引",
            kind: "es",
            description: "主检索源",
            status: "ready",
            endpoint: "http://es.example.test:9200",
            index_name: "docs",
            auth_mode: "api_key",
            source_detail: null,
            uploaded_files: [],
            last_test: {
              kind: "es",
              status: "ready",
              summary: "Elasticsearch 连接可用，索引可访问，当前测试命中 1 条。",
              checked_at_ms: 4,
              details: [
                { label: "地址", value: "http://es.example.test:9200" },
              ],
            },
            last_synced_at_ms: null,
            created_at_ms: 1,
            updated_at_ms: 2,
          },
          {
            id: "source-2",
            knowledge_base_id: "kb-1",
            name: "上传资料",
            kind: "upload",
            description: "用户上传文档",
            status: "ready",
            endpoint: null,
            index_name: null,
            auth_mode: null,
            source_detail: "2 份文档",
            uploaded_files: [
              {
                id: "doc-1",
                file_name: "brief.md",
                mime_type: "text/markdown",
                size_bytes: 1024,
                uploaded_at_ms: 3,
              },
            ],
            last_test: null,
            last_synced_at_ms: 3,
            created_at_ms: 1,
            updated_at_ms: 3,
          },
        ],
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const items = await listDataSources({ apiKey: "clawd-secret" });

    expect(items[0]?.endpoint).toBe("http://es.example.test:9200");
    expect(items[1]?.uploaded_files[0]?.file_name).toBe("brief.md");
  });

  it("creates data sources with ES auth fields", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: "source-1",
        knowledge_base_id: "kb-1",
        name: "ES 主索引",
        kind: "es",
        description: "主检索源",
        status: "ready",
        endpoint: "http://es.example.test:9200",
        index_name: "docs",
        auth_mode: "api_key",
        source_detail: null,
        uploaded_files: [],
        last_test: null,
        last_synced_at_ms: null,
        created_at_ms: 1,
        updated_at_ms: 2,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    await createDataSource(
      {
        knowledge_base_id: "kb-1",
        name: "ES 主索引",
        kind: "es",
        description: "主检索源",
        config: {
          endpoint: "http://es.example.test:9200",
          index: "docs",
          api_key: "secret",
        },
      },
      { apiKey: "clawd-secret" },
    );

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:3210/v1/data-sources",
      expect.objectContaining({
        method: "POST",
        body: JSON.stringify({
          knowledge_base_id: "kb-1",
          name: "ES 主索引",
          kind: "es",
          description: "主检索源",
          config: {
            endpoint: "http://es.example.test:9200",
            index: "docs",
            api_key: "secret",
          },
        }),
      }),
    );
  });

  it("updates a data source with patch payload", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: "source-1",
        knowledge_base_id: "kb-1",
        name: "网页资料",
        kind: "web",
        description: "更新后的说明",
        status: "ready",
        endpoint: null,
        index_name: null,
        auth_mode: null,
        source_detail: "2 个网页入口",
        uploaded_files: [],
        last_test: null,
        last_synced_at_ms: null,
        created_at_ms: 1,
        updated_at_ms: 8,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const item = await updateDataSource(
      "source-1",
      {
        name: "网页资料",
        description: "更新后的说明",
        config: {
          urls: ["https://example.com/a", "https://example.com/b"],
        },
      },
      { apiKey: "clawd-secret" },
    );

    expect(item.updated_at_ms).toBe(8);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:3210/v1/data-sources/source-1",
      expect.objectContaining({
        method: "PATCH",
        headers: expect.objectContaining({
          authorization: "Bearer clawd-secret",
        }),
        body: JSON.stringify({
          name: "网页资料",
          description: "更新后的说明",
          config: {
            urls: ["https://example.com/a", "https://example.com/b"],
          },
        }),
      }),
    );
  });

  it("gets a single data source detail", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: "source-1",
        knowledge_base_id: "kb-1",
        name: "网页资料",
        kind: "web",
        description: "更新后的说明",
        status: "ready",
        config: {
          urls: ["https://example.com/a", "https://example.com/b"],
        },
        endpoint: null,
        index_name: null,
        auth_mode: null,
        source_detail: "2 个网页入口",
        uploaded_files: [],
        last_test: {
          kind: "web",
          status: "ready",
          summary: "网页来源可访问，已成功读取 https://example.com/a。",
          checked_at_ms: 9,
          details: [
            { label: "测试地址", value: "https://example.com/a" },
          ],
        },
        last_synced_at_ms: null,
        created_at_ms: 1,
        updated_at_ms: 8,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const item = await getDataSource("source-1", { apiKey: "clawd-secret" });

    expect((item.config as { urls?: string[] }).urls).toEqual([
      "https://example.com/a",
      "https://example.com/b",
    ]);
  });

  it("tests a data source config before saving", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        kind: "db",
        summary: "数据库连接可用，只读查询已通过，测试返回 1 行。",
        result: {
          kind: "db",
          status: "ready",
          summary: "数据库连接可用，只读查询已通过，测试返回 1 行。",
          checked_at_ms: 11,
          details: [
            { label: "引擎", value: "PostgreSQL" },
            { label: "测试返回", value: "1 行" },
          ],
        },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await testDataSource(
      {
        kind: "db",
        config: {
          url: "postgresql://demo:demo@db.example.com:5432/app",
        },
      },
      { userId: "alice" },
    );

    expect(result.ok).toBe(true);
    expect(result.result.details[0]?.label).toBe("引擎");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:3210/v1/data-sources/test",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          "x-clawd-user-id": "alice",
        }),
      }),
    );
  });

  it("tests a saved data source and persists status through the dedicated route", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        ok: true,
        kind: "web",
        summary: "网页来源可访问，已成功读取 https://example.com/a。",
        result: {
          kind: "web",
          status: "ready",
          summary: "网页来源可访问，已成功读取 https://example.com/a。",
          checked_at_ms: 12,
          details: [
            { label: "测试地址", value: "https://example.com/a" },
          ],
        },
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const result = await testSavedDataSource("source-1", { apiKey: "clawd-secret" });

    expect(result.kind).toBe("web");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:3210/v1/data-sources/source-1/test",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer clawd-secret",
        }),
      }),
    );
  });

  it("uploads a file to a data source", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({
        id: "doc-1",
        file_name: "brief.md",
        mime_type: "text/markdown",
        size_bytes: 8,
        uploaded_at_ms: 10,
      }),
    });
    vi.stubGlobal("fetch", fetchMock);

    const file = new File(["# brief"], "brief.md", { type: "text/markdown" });
    const uploaded = await uploadDataSourceFile("source-1", file, { apiKey: "clawd-secret" });

    expect(uploaded.file_name).toBe("brief.md");
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:3210/v1/data-sources/source-1/upload",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({
          authorization: "Bearer clawd-secret",
        }),
        body: expect.any(FormData),
      }),
    );
  });

  it("deletes a data source", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 204,
    });
    vi.stubGlobal("fetch", fetchMock);

    await deleteDataSource("source-1", { apiKey: "clawd-secret" });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:3210/v1/data-sources/source-1",
      expect.objectContaining({
        method: "DELETE",
        headers: expect.objectContaining({
          authorization: "Bearer clawd-secret",
        }),
      }),
    );
  });

  it("deletes an uploaded file from a data source", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      status: 204,
    });
    vi.stubGlobal("fetch", fetchMock);

    await deleteDataSourceFile("source-1", "doc-1", { userId: "alice" });

    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:3210/v1/data-sources/source-1/files/doc-1",
      expect.objectContaining({
        method: "DELETE",
        headers: expect.objectContaining({
          "x-clawd-user-id": "alice",
        }),
      }),
    );
  });
});
