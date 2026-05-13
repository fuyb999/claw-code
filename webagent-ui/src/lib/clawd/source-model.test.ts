import { describe, expect, it } from "vitest";

import {
  buildSourceRailModel,
  presentSourceStatus,
  type SourceRailDataSource,
} from "./source-model";
import type {
  DataSourceSummary,
  KnowledgeBaseSummary,
} from "./types";

function source(
  overrides: Partial<DataSourceSummary> & Pick<DataSourceSummary, "id" | "name" | "kind" | "knowledge_base_id">,
): DataSourceSummary {
  return {
    id: overrides.id,
    knowledge_base_id: overrides.knowledge_base_id,
    name: overrides.name,
    kind: overrides.kind,
    description: overrides.description ?? null,
    status: overrides.status === undefined ? "ready" : overrides.status,
    endpoint: overrides.endpoint ?? null,
    index_name: overrides.index_name ?? null,
    auth_mode: overrides.auth_mode ?? null,
    source_detail: overrides.source_detail ?? null,
    uploaded_files: overrides.uploaded_files ?? [],
    last_test: overrides.last_test ?? null,
    last_synced_at_ms: overrides.last_synced_at_ms ?? null,
    created_at_ms: overrides.created_at_ms ?? 1,
    updated_at_ms: overrides.updated_at_ms ?? 1,
  };
}

function kb(overrides: Partial<KnowledgeBaseSummary> & Pick<KnowledgeBaseSummary, "id" | "name">): KnowledgeBaseSummary {
  return {
    id: overrides.id,
    name: overrides.name,
    description: overrides.description ?? null,
    default_project_id: overrides.default_project_id ?? null,
    data_source_count: overrides.data_source_count ?? 0,
    created_at_ms: overrides.created_at_ms ?? 1,
    updated_at_ms: overrides.updated_at_ms ?? 1,
  };
}

describe("source-model", () => {
  it("groups personal uploads and platform ES sources without exposing internal ES config", () => {
    const model = buildSourceRailModel({
      dataSources: [
        source({
          id: "upload-1",
          knowledge_base_id: "kb-personal",
          name: "我的上传资料",
          kind: "upload",
          uploaded_files: [
            {
              id: "file-1",
              file_name: "market.pdf",
              mime_type: "application/pdf",
              size_bytes: 2048,
              uploaded_at_ms: 1778600000000,
            },
          ],
        }),
        source({
          id: "es-1",
          knowledge_base_id: "kb-platform",
          name: "政策资料库",
          kind: "es",
          endpoint: "https://internal-es.example.local",
          index_name: "policy_private_index",
          auth_mode: "api_key",
          status: "ready",
        }),
      ],
      knowledgeBases: [
        kb({ id: "kb-personal", name: "我的资料", data_source_count: 1 }),
        kb({ id: "kb-platform", name: "平台知识", data_source_count: 1 }),
      ],
      selectedKnowledgeBaseId: "kb-platform",
    });

    expect(model.personalUploads).toHaveLength(1);
    expect(model.platformSources).toHaveLength(1);
    expect(model.currentScope?.label).toBe("平台知识");
    expect(model.platformSources[0]).toMatchObject({
      id: "es-1",
      label: "政策资料库",
      kindLabel: "平台检索",
      searchable: true,
    });
    expect(JSON.stringify(model)).not.toContain("internal-es");
    expect(JSON.stringify(model)).not.toContain("policy_private_index");
    expect(JSON.stringify(model)).not.toContain("api_key");
  });

  it("keeps favorites empty without an explicit favorite signal and retains external sources in platform sources", () => {
    const model = buildSourceRailModel({
      dataSources: [
        source({
          id: "notion-1",
          knowledge_base_id: "kb-platform",
          name: "产品文档",
          kind: "notion",
          status: "ready",
        }),
        source({
          id: "conf-1",
          knowledge_base_id: "kb-platform",
          name: "运行手册",
          kind: "confluence",
          status: "ready",
        }),
      ],
      knowledgeBases: [kb({ id: "kb-platform", name: "平台知识", data_source_count: 2 })],
      selectedKnowledgeBaseId: "kb-platform",
    });

    expect(model.favorites).toEqual([]);
    expect(model.platformSources).toMatchObject([
      { id: "notion-1", kind: "notion", searchable: false },
      { id: "conf-1", kind: "confluence", searchable: false },
    ]);
  });

  it("does not mark otherwise searchable source kinds as searchable during null or intermediate statuses", () => {
    const model = buildSourceRailModel({
      dataSources: [
        source({
          id: "upload-pending",
          knowledge_base_id: "kb-platform",
          name: "待处理上传",
          kind: "upload",
          status: null,
        }),
        source({
          id: "es-syncing",
          knowledge_base_id: "kb-platform",
          name: "同步中的检索库",
          kind: "es",
          status: "syncing",
        }),
        source({
          id: "web-indexing",
          knowledge_base_id: "kb-platform",
          name: "建立索引中的网页",
          kind: "web",
          status: "indexing",
        }),
      ],
      knowledgeBases: [kb({ id: "kb-platform", name: "平台知识", data_source_count: 3 })],
      selectedKnowledgeBaseId: "kb-platform",
    });

    expect(model.personalUploads).toMatchObject([
      { id: "upload-pending", kind: "upload", searchable: false },
    ]);
    expect(model.platformSources).toMatchObject([
      { id: "es-syncing", kind: "es", searchable: false },
      { id: "web-indexing", kind: "web", searchable: false },
    ]);
  });

  it("presents status in user language", () => {
    expect(presentSourceStatus({ status: "ready", searchable: true } as SourceRailDataSource)).toBe("可检索");
    expect(presentSourceStatus({ status: "syncing", searchable: false } as SourceRailDataSource)).toBe("同步中");
    expect(presentSourceStatus({ status: null, searchable: false } as SourceRailDataSource)).toBe("已接入");
  });
});
